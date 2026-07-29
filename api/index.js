const https  = require('https');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const config = require('../config');
const { gerarContrato } = require('../lib/contracts');
const { gerarGT } = require('../lib/gt');
const { extrairNF } = require('../lib/nfExtract');
const { extrairPedido } = require('../lib/pedidoExtract');
const { getComercialData, saveComercialData, resetMonth, registrarVenda } = require('../lib/comercialStore');

function getRole(usuario) {
  if (usuario === 'gerencia') return 'admin';    // acesso total
  if (usuario === 'auxiliar') return 'auxiliar'; // acesso total à aba Documentos, sem KB, sem dashboard comercial
  return 'vendas';                                // padrão: ve tudo, exceto KB; ve comercial mas nao edita
}
function canEditComercial(sess) { return sess && getRole(sess.usuario) === 'admin'; }
function canViewComercial(sess) { return sess && getRole(sess.usuario) !== 'auxiliar'; }
function canUseDocumentos(sess) { return sess && sess.usuario; } // Qualquer usuário logado pode usar Documentos (gerencia, vendas, auxiliar)

const SESSION_MS = (config.sessionHours || 8) * 60 * 60 * 1000;
const ROOT       = path.join(__dirname, '..');
const KB_FILE    = path.join(ROOT, 'knowledge.txt');

// ── Sessão (stateless — assinada no próprio cookie, sem depender de ──
// ── memória do servidor, que não é compartilhada entre instâncias   ──
// ── serverless da Vercel) ─────────────────────────────────────────
function sign(payloadB64) {
  return crypto.createHmac('sha256', config.sessionSecret).update(payloadB64).digest('hex');
}

function newToken(sessionData) {
  const payloadB64 = Buffer.from(JSON.stringify(sessionData)).toString('base64url');
  const sig = sign(payloadB64);
  return payloadB64 + '.' + sig;
}

function getSession(req) {
  const m = (req.headers.cookie || '').match(/ph_session=([^;]+)/);
  if (!m) return null;
  const token = decodeURIComponent(m[1]);
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts;
  let expectedSig;
  try { expectedSig = sign(payloadB64); } catch (e) { return null; }
  if (expectedSig.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(expectedSig), Buffer.from(sig))) return null;
  let data;
  try { data = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf-8')); } catch (e) { return null; }
  if (!data || Date.now() > data.expiry) return null;
  return data;
}

function parseForm(body) {
  try {
    return Object.fromEntries(
      body.split('&').map(p => p.split('=').map(v => decodeURIComponent(v.replace(/\+/g,' '))))
    );
  } catch(e) { return {}; }
}

function readBody(req) {
  return new Promise(resolve => {
    let b = '';
    req.on('data', c => b += c);
    req.on('end',  () => resolve(b));
  });
}

// ── Knowledge base (persistida no GitHub, pois o filesystem da ──
// ── Vercel é somente-leitura em produção — fs.writeFileSync nunca ──
// ── vai persistir de verdade rodando lá) ─────────────────────────
function githubRequest(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    if (!config.githubToken || !config.githubRepo) {
      reject(new Error('GITHUB_TOKEN ou GITHUB_REPO não configurados nas variáveis de ambiente da Vercel.'));
      return;
    }
    const payload = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: 'api.github.com',
      path: apiPath,
      method,
      headers: {
        'User-Agent': 'prohunters-portal',
        'Accept': 'application/vnd.github+json',
        'Authorization': 'Bearer ' + config.githubToken,
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };
    const r = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(d); } catch (e) {}
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(parsed);
        else reject(new Error('GitHub API ' + res.statusCode + ': ' + (parsed && parsed.message ? parsed.message : d)));
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

// Cache em memória por invocação fria (evita ficar batendo no GitHub a cada request de chat)
let kbCache = { text: null, ts: 0 };
const KB_CACHE_MS = 60 * 1000; // 1 minuto

async function getKnowledge() {
  const now = Date.now();
  if (kbCache.text !== null && (now - kbCache.ts) < KB_CACHE_MS) {
    return kbCache.text;
  }
  try {
    const filePath = 'knowledge.txt';
    const apiPath = '/repos/' + config.githubRepo + '/contents/' + filePath + '?ref=' + config.githubBranch;
    const data = await githubRequest('GET', apiPath);
    const text = Buffer.from(data.content, 'base64').toString('utf-8');
    kbCache = { text, ts: now };
    return text;
  } catch (e) {
    // Fallback: arquivo local empacotado no deploy (só leitura, pode estar desatualizado)
    try { return fs.readFileSync(KB_FILE, 'utf-8'); }
    catch (e2) { return require('../system_prompt'); }
  }
}

async function saveKnowledge(text) {
  const filePath = 'knowledge.txt';
  const apiPath = '/repos/' + config.githubRepo + '/contents/' + filePath;
  // Precisa do sha do arquivo atual para o GitHub aceitar o update
  let sha = null;
  try {
    const current = await githubRequest('GET', apiPath + '?ref=' + config.githubBranch);
    sha = current.sha;
  } catch (e) {
    // arquivo pode não existir ainda — segue sem sha (cria novo)
  }
  await githubRequest('PUT', apiPath, {
    message: 'Atualiza base de conhecimento via painel admin',
    content: Buffer.from(text, 'utf-8').toString('base64'),
    branch: config.githubBranch,
    ...(sha ? { sha } : {}),
  });
  kbCache = { text, ts: Date.now() }; // invalida cache local imediatamente
}

// ── Anthropic proxy ──────────────────────────────────────────
function callAnthropic(messages, system) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model:      config.model || 'claude-sonnet-4-6',
      max_tokens: config.maxTokens || 1000,
      system,
      messages,
    });
    const opts = {
      hostname: 'api.anthropic.com',
      path:     '/v1/messages',
      method:   'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         config.anthropicKey,
        'anthropic-version': '2023-06-01',
        'Content-Length':    Buffer.byteLength(payload),
      },
    };
    const r = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    r.on('error', reject);
    r.write(payload);
    r.end();
  });
}

// ── Login page ───────────────────────────────────────────────
function loginPage(erro) {
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pro Hunters</title><link rel="icon" href="/assets/favicon.ico">
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{
  font-family:'Segoe UI',system-ui,sans-serif;
  background:radial-gradient(circle at 50% 20%, #12241c 0%, #0a1410 45%, #060a08 100%);
  display:flex;align-items:center;justify-content:center;min-height:100vh;
  overflow:hidden;position:relative;
}
/* textura de ruido sutil */
body::before{
  content:'';position:fixed;inset:0;pointer-events:none;z-index:1;opacity:.35;
  background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.045'/%3E%3C/svg%3E");
}
/* trilhas de projeteis passando em alta velocidade */
.tracer{
  position:fixed;left:-20%;width:46%;height:2px;z-index:2;pointer-events:none;
  background:linear-gradient(90deg, transparent, rgba(120,220,150,.85) 60%, #eaffef 100%);
  box-shadow:0 0 10px 1px rgba(120,220,150,.65);
  border-radius:2px;
  animation-name:tracerFly;
  animation-timing-function:cubic-bezier(.3,0,.15,1);
  animation-iteration-count:infinite;
}
.tracer::after{
  content:'';position:absolute;right:-3px;top:50%;transform:translateY(-50%);
  width:6px;height:6px;border-radius:50%;background:#eaffef;box-shadow:0 0 8px 3px rgba(160,255,190,.9);
}
@keyframes tracerFly{ from{ transform:translateX(0); opacity:0 } 4%{opacity:1} 92%{opacity:1} to{ transform:translateX(260vw); opacity:0 } }
.tracer.t1{ top:14%; animation-duration:1.9s; animation-delay:.2s }
.tracer.t2{ top:34%; animation-duration:2.6s; animation-delay:1.4s; opacity:.7 }
.tracer.t3{ top:58%; animation-duration:1.6s; animation-delay:2.5s }
.tracer.t4{ top:76%; animation-duration:2.2s; animation-delay:.9s; opacity:.6 }
.tracer.t5{ top:90%; animation-duration:2.9s; animation-delay:3.4s; opacity:.5 }

.vignette{position:fixed;inset:0;z-index:1;pointer-events:none;box-shadow:inset 0 0 220px 40px rgba(0,0,0,.75)}

.wrap{position:relative;z-index:5;width:100%;max-width:400px;padding:20px}
.card{
  background:rgba(15,26,20,.72);
  border:1px solid rgba(120,200,150,.22);
  border-radius:16px;padding:38px 34px;width:100%;
  backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);
  box-shadow:0 20px 60px rgba(0,0,0,.55), 0 0 0 1px rgba(255,255,255,.03) inset;
}
.logo-wrap{display:flex;align-items:center;justify-content:center;margin-bottom:22px}
.logo-wrap img{height:46px;width:auto}
h2{font-size:16px;font-weight:700;text-align:center;margin-bottom:4px;color:#f2f5f2;letter-spacing:.3px}
.sub{font-size:12px;color:#9db3a4;text-align:center;margin-bottom:26px}
label{font-size:11px;font-weight:700;color:#bcd4c4;display:block;margin-bottom:6px;text-transform:uppercase;letter-spacing:.6px}
input{
  width:100%;background:rgba(255,255,255,.04);border:1px solid rgba(120,200,150,.25);
  border-radius:8px;padding:11px 13px;font-size:14px;outline:none;margin-bottom:16px;
  font-family:inherit;color:#f2f5f2;transition:border-color .15s,background .15s;
}
input::placeholder{color:#5c6e63}
input:focus{border-color:#4caf7a;background:rgba(255,255,255,.07)}
button{
  width:100%;background:linear-gradient(135deg,#2d6a4f,#1b4332);color:#fff;border:none;
  border-radius:8px;padding:12px;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit;
  letter-spacing:.3px;transition:filter .15s,transform .1s;
}
button:hover{filter:brightness(1.15)}
button:active{transform:scale(.98)}
.err{background:rgba(224,48,48,.15);border:1px solid rgba(224,48,48,.4);border-radius:8px;padding:10px 14px;font-size:12px;color:#ff9d9d;margin-bottom:16px;text-align:center}
.foot{font-size:11px;color:#5c6e63;text-align:center;margin-top:22px;letter-spacing:.4px}
</style></head>
<body>
<div class="vignette"></div>
<div class="tracer t1"></div>
<div class="tracer t2"></div>
<div class="tracer t3"></div>
<div class="tracer t4"></div>
<div class="tracer t5"></div>
<div class="wrap">
  <div class="card">
    <div class="logo-wrap"><img src="/assets/ph_logo_header.png" alt="Pro Hunters"></div>
    <h2>Acesso ao Portal</h2>
    <p class="sub">Digite suas credenciais para entrar</p>
    ${erro ? '<div class="err">Usuário ou senha incorretos.</div>' : ''}
    <form method="POST" action="/login">
      <label>Usuário</label>
      <input type="text" name="usuario" autocomplete="username" autofocus required>
      <label>Senha</label>
      <input type="password" name="senha" autocomplete="current-password" required>
      <button type="submit">Entrar</button>
    </form>
    <div class="foot">PORTAL INTERNO · COMERCIAL</div>
  </div>
</div>
</body></html>`;
}

// ── Handler principal ────────────────────────────────────────

  // POST /api/contrato-influenciador — gera contrato Parceria Influenciador
  if (req.method === 'POST' && url === '/api/contrato-influenciador') {
    const sess = getSession(req);
    if (!canUseDocumentos(sess)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Nao autorizado.' }));
      return;
    }
    const body = await readBody(req);
    try {
      const data = JSON.parse(body);
      const { pdfBase64, nomeParceiro, cpfCnpj, endereco, cidade, uf } = data;
      
      let dadosExtraidos = { nomeParceiro, cpfCnpj, endereco, cidade, uf };
      
      // Se veio PDF, tentar extrair dados
      if (pdfBase64) {
        try {
          dadosExtraidos = await extrairPedido(pdfBase64);
        } catch (e) {
          console.warn('Aviso: extração PDF falhou, usando dados do formulário:', e.message);
        }
      }
      
      // Ler template do repositório
      const templateResp = await fetch('https://raw.githubusercontent.com/Loja-ProHunters/dashboardph/main/templates/Contrato_Parceria.docx');
      if (!templateResp.ok) throw new Error('Template não encontrado');
      const templateBuf = await templateResp.arrayBuffer();
      
      // Processar contrato com dados extraídos
      const contratoBuf = await gerarContratoInfluenciador(Buffer.from(templateBuf), dadosExtraidos);
      
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': 'attachment; filename="Contrato_Parceria_' + (dadosExtraidos.nomeParceiro || 'ProHunters').replace(/[^a-z0-9]/gi, '_') + '.docx"'
      });
      res.end(contratoBuf);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Erro ao gerar contrato: ' + e.message }));
    }
    return;
  }

module.exports = async (req, res) => {
  const url = (req.url || '/').split('?')[0];

  // GET /favicon.ico — navegadores pedem isso direto na raiz por padrao
  if (req.method === 'GET' && url === '/favicon.ico') {
    try {
      const buf = fs.readFileSync(path.join(ROOT, 'assets', 'favicon.ico'));
      res.writeHead(200, { 'Content-Type': 'image/x-icon', 'Cache-Control': 'public, max-age=86400' });
      res.end(buf);
    } catch (e) {
      res.writeHead(404); res.end();
    }
    return;
  }

  // GET /assets/* — arquivos estaticos publicos (logos, imagens)
  if (req.method === 'GET' && url.startsWith('/assets/')) {
    const fileName = url.replace('/assets/', '');
    if (fileName.includes('..') || fileName.includes('/')) {
      res.writeHead(400); res.end('Nome de arquivo invalido.'); return;
    }
    const filePath = path.join(ROOT, 'assets', fileName);
    try {
      const buf = fs.readFileSync(filePath);
      const ext = path.extname(fileName).toLowerCase();
      const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp' }[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=86400' });
      res.end(buf);
    } catch (e) {
      res.writeHead(404); res.end('Arquivo nao encontrado.');
    }
    return;
  }

  // POST /login
  if (req.method === 'POST' && url === '/login') {
    const body = await readBody(req);
    const { usuario, senha } = parseForm(body);
    const user = (config.users || []).find(u => u.usuario === usuario && u.senha === senha);
    if (!user) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(loginPage(true));
      return;
    }
    const token = newToken({ nome: user.nome, usuario: user.usuario, expiry: Date.now() + SESSION_MS });
    res.writeHead(302, {
      'Set-Cookie': 'ph_session=' + token + '; HttpOnly; Path=/; Max-Age=' + Math.floor(SESSION_MS/1000),
      'Location': '/',
    });
    res.end();
    return;
  }

  // GET /logout
  if (url === '/logout') {
    res.writeHead(302, { 'Set-Cookie': 'ph_session=; HttpOnly; Path=/; Max-Age=0', 'Location': '/' });
    res.end();
    return;
  }

  // POST /api/chat
  if (req.method === 'POST' && url === '/api/chat') {
    const sess = getSession(req);
    if (!sess) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Nao autorizado.' } }));
      return;
    }
    const body = await readBody(req);
    try {
      const { messages } = JSON.parse(body);
      const knowledge = await getKnowledge();
      const result = await callAnthropic(messages, knowledge);
      res.writeHead(result.status, { 'Content-Type': 'application/json' });
      res.end(result.body);
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Erro interno: ' + e.message } }));
    }
    return;
  }

  // GET /api/knowledge — retorna o conteúdo atual (só admin)
  if (req.method === 'GET' && url === '/api/knowledge') {
    const sess = getSession(req);
    if (!sess || sess.usuario !== 'gerencia') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Acesso negado.' }));
      return;
    }
    try {
      const knowledge = await getKnowledge();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ knowledge }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Erro ao carregar: ' + e.message }));
    }
    return;
  }

  // POST /api/knowledge — salva novo conteúdo (só admin)
  if (req.method === 'POST' && url === '/api/knowledge') {
    const sess = getSession(req);
    if (!sess || sess.usuario !== 'gerencia') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Acesso negado.' }));
      return;
    }
    const body = await readBody(req);
    try {
      const { knowledge } = JSON.parse(body);
      await saveKnowledge(knowledge);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Erro ao salvar: ' + e.message }));
    }
    return;
  }

  // POST /api/contract — gera o PDF do contrato (qualquer usuário logado: gerencia, vendas, auxiliar)
  if (req.method === 'POST' && url === '/api/contract') {
    const sess = getSession(req);
    if (!canUseDocumentos(sess)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Nao autorizado.' }));
      return;
    }
    const body = await readBody(req);
    try {
      const data = JSON.parse(body);
      if (!data || !data.cliente || !data.cliente.nome || !data.cliente.doc || !data.cliente.endereco || !data.produto) {
        throw new Error('Preencha nome, documento, endereço do cliente e o produto.');
      }
      const { bytes, filename } = await gerarContrato(data);
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'attachment; filename="' + filename.replace(/"/g, '') + '"',
      });
      res.end(Buffer.from(bytes));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Erro ao gerar contrato: ' + e.message }));
    }
    return;
  }

  // POST /api/pedido-extract — extrai dados do Pedido de Venda via IA (qualquer usuário logado: gerencia, vendas, auxiliar)
  if (req.method === 'POST' && url === '/api/pedido-extract') {
    const sess = getSession(req);
    if (!canUseDocumentos(sess)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Nao autorizado.' }));
      return;
    }
    const body = await readBody(req);
    try {
      const { pdfBase64 } = JSON.parse(body);
      if (!pdfBase64) throw new Error('Nenhum arquivo recebido.');
      const data = await extrairPedido(pdfBase64);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Erro ao extrair dados do pedido: ' + e.message }));
    }
    return;
  }

  // POST /api/nf-extract — extrai dados da NF via IA (qualquer usuário logado: gerencia, vendas, auxiliar)
  if (req.method === 'POST' && url === '/api/nf-extract') {
    const sess = getSession(req);
    if (!canUseDocumentos(sess)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Nao autorizado.' }));
      return;
    }
    const body = await readBody(req);
    try {
      const { pdfBase64 } = JSON.parse(body);
      if (!pdfBase64) throw new Error('Nenhum arquivo recebido.');
      const data = await extrairNF(pdfBase64);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Erro ao extrair dados da NF: ' + e.message }));
    }
    return;
  }

  // POST /api/gt — gera o PDF da Guia de Transito (qualquer usuário logado: gerencia, vendas, auxiliar)
  if (req.method === 'POST' && url === '/api/gt') {
    const sess = getSession(req);
    if (!canUseDocumentos(sess)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Nao autorizado.' }));
      return;
    }
    const body = await readBody(req);
    try {
      const data = JSON.parse(body);
      if (!data || !data.destinatarios || !data.destinatarios[0] || !data.destinatarios[0].nome) {
        throw new Error('Preencha ao menos os dados do destinatário.');
      }
      if (!data.produtos || !data.produtos.length) {
        throw new Error('Adicione ao menos um produto.');
      }
      const { bytes, filename } = await gerarGT(data);
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'attachment; filename="' + filename.replace(/"/g, '') + '"',
      });
      res.end(Buffer.from(bytes));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Erro ao gerar GT: ' + e.message }));
    }
    return;
  }

  // GET /api/comercial — le os dados (luis e vendas podem ver; auxiliar nao)
  if (req.method === 'GET' && url === '/api/comercial') {
    const sess = getSession(req);
    if (!sess || !canViewComercial(sess)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Sem permissao para ver o Dashboard Comercial.' }));
      return;
    }
    try {
      const data = await getComercialData();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...data, canEdit: canEditComercial(sess) }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Erro ao carregar dados: ' + e.message }));
    }
    return;
  }

  // POST /api/comercial — salva os dados (somente luis/admin)
  if (req.method === 'POST' && url === '/api/comercial') {
    const sess = getSession(req);
    if (!sess || !canEditComercial(sess)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Sem permissao para editar o Dashboard Comercial.' }));
      return;
    }
    const body = await readBody(req);
    try {
      const incoming = JSON.parse(body);
      await saveComercialData(incoming);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Erro ao salvar: ' + e.message }));
    }
    return;
  }

  // POST /api/comercial/reset-month — fecha o mes, arquiva no historico e zera (somente luis/admin)
  if (req.method === 'POST' && url === '/api/comercial/reset-month') {
    const sess = getSession(req);
    if (!sess || !canEditComercial(sess)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Sem permissao para fechar o mes.' }));
      return;
    }
    const body = await readBody(req);
    try {
      const { vencedor } = JSON.parse(body || '{}');
      const data = await resetMonth(vencedor);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Erro ao fechar o mes: ' + e.message }));
    }
    return;
  }

  // POST /api/comercial/registrar-venda — autolancamento do proprio vendedor
  // (qualquer um que pode VER o comercial pode registrar, nao precisa ser admin)
  if (req.method === 'POST' && url === '/api/comercial/registrar-venda') {
    const sess = getSession(req);
    if (!sess || !canViewComercial(sess)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Sem permissao.' }));
      return;
    }
    const body = await readBody(req);
    try {
      const { sellerId, valor } = JSON.parse(body || '{}');
      const valorNum = Number(valor);
      if (!sellerId || !valorNum || valorNum <= 0) {
        throw new Error('Informe o vendedor e um valor de venda maior que zero.');
      }
      const data = await registrarVenda(Number(sellerId), valorNum);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, sellers: data.sellers }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Erro ao registrar venda: ' + e.message }));
    }
    return;
  }

  // GET /comercial — dashboard comercial (luis e vendas podem ver; auxiliar nao)
  if (req.method === 'GET' && url === '/comercial') {
    const sess = getSession(req);
    if (!sess) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(loginPage(false));
      return;
    }
    if (!canViewComercial(sess)) {
      res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px;text-align:center;color:#444"><h2>Acesso restrito</h2><p>Seu usuario nao tem permissao para ver o Dashboard Comercial.</p><a href="/">Voltar</a></body></html>');
      return;
    }
    try {
      let html = fs.readFileSync(path.join(ROOT, 'comercial-dashboard.html'), 'utf-8');
      const canEditCom = canEditComercial(sess) ? 'true' : 'false';
      html = html.replace('/* %%INJECT_COMERCIAL%% */',
        'window.CAN_EDIT_COMERCIAL=' + canEditCom + '; window.USER_NOME="' + sess.nome + '";'
      );
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (e) {
      res.writeHead(500);
      res.end('Erro ao carregar dashboard comercial: ' + e.message);
    }
    return;
  }

  // Proteger tudo
  const sess = getSession(req);
  if (!sess) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(loginPage(false));
    return;
  }

  // Servir dashboard com flags de permissao injetadas
  try {
    let html = fs.readFileSync(path.join(ROOT, 'dashboard.html'), 'utf-8');
    const isAdmin = canEditComercial(sess) ? 'true' : 'false';
    const canViewCom = canViewComercial(sess) ? 'true' : 'false';
    const canEditCom = canEditComercial(sess) ? 'true' : 'false';
    html = html.replace('/* %%INJECT%% */',
      'var IS_ADMIN=' + isAdmin + '; var USER_NOME="' + sess.nome + '"; ' +
      'var CAN_VIEW_COMERCIAL=' + canViewCom + '; var CAN_EDIT_COMERCIAL=' + canEditCom + ';'
    );
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  } catch(e) {
    res.writeHead(500);
    res.end('Erro ao carregar portal: ' + e.message);
  }
};
