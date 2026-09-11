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
const { getContatos, saveContatos } = require('../lib/contatosStore');
const { getEditorial, saveEditorial } = require('../lib/editorialStore');
const { getTarifas, saveTarifas } = require('../lib/tarifasStore');
const { getParceiros, saveParceiros } = require('../lib/parceirosStore');
const { verifyPassword, setPassword, upsertUser, deleteUser, getAllUsers, generateTempPassword, getRoleSync } = require('../lib/usersStore');
const accessLog = require('../lib/accessLog');

// Papel do usuário: agora vem da sessão (que traz o role guardado no cadastro).
// Fallback pro esquema antigo (baseado no nome do usuário) fica só como safety-net.
function getRole(usuario, sess) {
  if (sess && sess.role) return sess.role;
  if (usuario === 'gerencia') return 'admin';
  if (usuario === 'auxiliar') return 'auxiliar';
  return 'vendas';
}
function canEditComercial(sess) { return sess && getRole(sess.usuario, sess) === 'admin'; }
function canViewComercial(sess) { return sess && getRole(sess.usuario, sess) !== 'auxiliar'; }
function canUseDocumentos(sess) { return sess && sess.usuario; } // Qualquer usuário logado pode usar Documentos

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
        'x-api-key': config.anthropicApiKey,
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
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Barlow:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{
  font-family:'Barlow','Segoe UI',system-ui,sans-serif;
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
  border-radius:10px;padding:13px 15px;font-size:15px;outline:none;margin-bottom:18px;
  font-family:inherit;color:#f2f5f2;transition:border-color .18s,background .18s,box-shadow .18s;
}
input::placeholder{color:#5c6e63}
input:focus{border-color:#4caf7a;background:rgba(255,255,255,.07);box-shadow:0 0 0 3px rgba(90,170,102,.22)}
button{
  width:100%;background:linear-gradient(135deg,#2d6a4f,#1b4332);color:#fff;border:none;
  border-radius:10px;padding:14px;font-size:15px;font-weight:700;cursor:pointer;font-family:inherit;
  letter-spacing:.4px;transition:filter .18s,transform .1s,box-shadow .18s;
  box-shadow:0 6px 18px rgba(27,67,50,.45);
}
button:focus-visible{outline:none;box-shadow:0 0 0 3px rgba(90,170,102,.45)}
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
    let user = null;
    try { user = await verifyPassword(usuario, senha); }
    catch (e) { console.warn('[login] erro em verifyPassword:', e.message); }
    if (!user) {
      accessLog.log('login_falha', req, { usuario: String(usuario || '').slice(0, 60) });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(loginPage(true));
      return;
    }
    accessLog.log('login_ok', req, { usuario: user.usuario, role: user.role });
    const token = newToken({
      nome: user.nome, usuario: user.usuario, role: user.role,
      mustChange: !!user.mustChange, expiry: Date.now() + SESSION_MS,
    });
    res.writeHead(302, {
      'Set-Cookie': 'ph_session=' + token + '; HttpOnly; Path=/; Max-Age=' + Math.floor(SESSION_MS/1000),
      'Location': '/',
    });
    res.end();
    return;
  }

  // GET /logout
  if (url === '/logout') {
    const sess = getSession(req);
    if (sess) accessLog.log('logout', req, { usuario: sess.usuario });
    res.writeHead(302, { 'Set-Cookie': 'ph_session=; HttpOnly; Path=/; Max-Age=0', 'Location': '/' });
    res.end();
    return;
  }

  // POST /api/change-password — trocar a própria senha (qualquer usuário logado)
  if (req.method === 'POST' && url === '/api/change-password') {
    const sess = getSession(req);
    if (!sess) { res.writeHead(401, {'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Nao autorizado.'})); return; }
    try {
      const { senhaAtual, novaSenha } = JSON.parse(await readBody(req));
      // Confirma senha atual antes de trocar
      const ok = await verifyPassword(sess.usuario, senhaAtual);
      if (!ok) throw new Error('Senha atual incorreta.');
      await setPassword(sess.usuario, novaSenha, { mustChange: false });
      accessLog.log('senha_alterada', req, { usuario: sess.usuario });
      // Renova o cookie removendo o mustChange
      const token = newToken({
        nome: sess.nome, usuario: sess.usuario, role: sess.role,
        mustChange: false, expiry: Date.now() + SESSION_MS,
      });
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': 'ph_session=' + token + '; HttpOnly; Path=/; Max-Age=' + Math.floor(SESSION_MS/1000),
      });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(400, {'Content-Type':'application/json'}); res.end(JSON.stringify({error: e.message}));
    }
    return;
  }

  // ═══ ADMIN DE USUÁRIOS (só gerência) ═══════════════════════════════════════
  // GET /api/users — lista
  if (req.method === 'GET' && url === '/api/users') {
    const sess = getSession(req);
    if (!sess || !canEditComercial(sess)) { res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Sem permissao.'})); return; }
    try {
      const users = await getAllUsers();
      // Nunca devolver os hashes
      const safe = {};
      for (const [k,v] of Object.entries(users)) safe[k] = { nome: v.nome, role: v.role, email: v.email, ativo: v.ativo !== false, mustChange: !!v.mustChange, criadoEm: v.criadoEm, senhaAlteradaEm: v.senhaAlteradaEm };
      res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ users: safe }));
    } catch (e) { res.writeHead(500,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:e.message})); }
    return;
  }

  // POST /api/users — criar/atualizar
  if (req.method === 'POST' && url === '/api/users') {
    const sess = getSession(req);
    if (!sess || !canEditComercial(sess)) { res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Sem permissao.'})); return; }
    try {
      const { usuario, dados } = JSON.parse(await readBody(req));
      if (!usuario || !/^[a-z0-9._-]{2,32}$/i.test(usuario)) throw new Error('Usuário deve ter 2-32 caracteres alfanuméricos.');
      const created = await upsertUser(String(usuario).toLowerCase(), dados || {});
      accessLog.log('usuario_upsert', req, { por: sess.usuario, alvo: usuario });
      const safe = { nome: created.nome, role: created.role, email: created.email, mustChange: !!created.mustChange };
      res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ ok: true, usuario, ...safe }));
    } catch (e) { res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:e.message})); }
    return;
  }

  // POST /api/users/reset — gera nova senha temporária pra outro usuário (só gerência)
  if (req.method === 'POST' && url === '/api/users/reset') {
    const sess = getSession(req);
    if (!sess || !canEditComercial(sess)) { res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Sem permissao.'})); return; }
    try {
      const { usuario } = JSON.parse(await readBody(req));
      if (!usuario) throw new Error('usuario ausente.');
      if (usuario === sess.usuario) throw new Error('Use "trocar minha senha" pra sua própria conta.');
      const temp = generateTempPassword();
      await setPassword(usuario, temp, { mustChange: true });
      accessLog.log('senha_resetada', req, { por: sess.usuario, alvo: usuario });
      res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ ok: true, senhaTemporaria: temp }));
    } catch (e) { res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:e.message})); }
    return;
  }

  // POST /api/users/delete
  if (req.method === 'POST' && url === '/api/users/delete') {
    const sess = getSession(req);
    if (!sess || !canEditComercial(sess)) { res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Sem permissao.'})); return; }
    try {
      const { usuario } = JSON.parse(await readBody(req));
      if (!usuario) throw new Error('usuario ausente.');
      if (usuario === sess.usuario) throw new Error('Não pode se deletar.');
      await deleteUser(usuario);
      accessLog.log('usuario_deletado', req, { por: sess.usuario, alvo: usuario });
      res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ ok: true }));
    } catch (e) { res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:e.message})); }
    return;
  }

  // GET /api/access-log — últimos eventos (só gerência)
  if (req.method === 'GET' && url === '/api/access-log') {
    const sess = getSession(req);
    if (!sess || !canEditComercial(sess)) { res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Sem permissao.'})); return; }
    try {
      const entries = await accessLog.readRecent(200);
      res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ entries }));
    } catch (e) { res.writeHead(500,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:e.message})); }
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

  // GET /api/contatos — lista de contatos úteis (qualquer usuário logado pode ver)
  if (req.method === 'GET' && url === '/api/contatos') {
    const sess = getSession(req);
    if (!sess) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Nao autorizado.' }));
      return;
    }
    try {
      const contatos = await getContatos();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ contatos, canEdit: canEditComercial(sess) }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Erro ao carregar contatos: ' + e.message }));
    }
    return;
  }

  // POST /api/contatos — salva a lista completa (somente admin/gerencia)
  if (req.method === 'POST' && url === '/api/contatos') {
    const sess = getSession(req);
    if (!sess || !canEditComercial(sess)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Sem permissao para editar contatos.' }));
      return;
    }
    const body = await readBody(req);
    try {
      const { contatos } = JSON.parse(body);
      if (!Array.isArray(contatos)) throw new Error('Formato inválido.');
      await saveContatos(contatos);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Erro ao salvar: ' + e.message }));
    }
    return;
  }

  // GET /api/editorial — marcações do calendário da Linha Editorial (somente gerencia)
  if (req.method === 'GET' && url === '/api/editorial') {
    const sess = getSession(req);
    if (!sess || !canEditComercial(sess)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Sem permissao.' }));
      return;
    }
    try {
      const state = await getEditorial();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ state }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Erro ao carregar: ' + e.message }));
    }
    return;
  }

  // POST /api/editorial — salva as marcações (compartilhado; somente gerencia)
  if (req.method === 'POST' && url === '/api/editorial') {
    const sess = getSession(req);
    if (!sess || !canEditComercial(sess)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Sem permissao para editar.' }));
      return;
    }
    const body = await readBody(req);
    try {
      const { state } = JSON.parse(body);
      if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('Formato inválido.');
      await saveEditorial(state);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Erro ao salvar: ' + e.message }));
    }
    return;
  }

  // GET /api/tarifas — taxas das operadoras (qualquer usuário logado usa a calculadora)
  if (req.method === 'GET' && url === '/api/tarifas') {
    const sess = getSession(req);
    if (!sess) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Nao autorizado.' }));
      return;
    }
    try {
      const tarifas = await getTarifas();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ tarifas, canEdit: canEditComercial(sess) }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Erro ao carregar tarifas: ' + e.message }));
    }
    return;
  }

  // POST /api/tarifas — salva as taxas (somente gerencia)
  if (req.method === 'POST' && url === '/api/tarifas') {
    const sess = getSession(req);
    if (!sess || !canEditComercial(sess)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Sem permissao para editar tarifas.' }));
      return;
    }
    const body = await readBody(req);
    try {
      const { tarifas } = JSON.parse(body);
      if (!tarifas || typeof tarifas !== 'object' || Array.isArray(tarifas)) throw new Error('Formato inválido.');
      await saveTarifas(tarifas);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Erro ao salvar: ' + e.message }));
    }
    return;
  }


  // ═══ PARCEIROS / INFLUENCIADORES ═══════════════════════════════════════════
  // Todas as rotas /api/parceiros/*. Persistência via parceirosStore (GitHub).

  // helper local: id curto e único
  const _prcId = () => 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const _round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

  function _resumoInfluenciador(inf, vendas, pagamentos) {
    const dele = vendas.filter(v => v.influenciadorId === inf.id && !v.cancelada);
    const totalVendido = _round2(dele.reduce((a, v) => a + (Number(v.valorLiquido) || 0), 0));
    const totalComissao = _round2(dele.reduce((a, v) => a + (Number(v.comissao) || 0), 0));
    const totalPago = _round2(pagamentos.filter(p => p.influenciadorId === inf.id).reduce((a, p) => a + (Number(p.valor) || 0), 0));
    const saldoAberto = _round2(totalComissao - totalPago);
    const qtdVendas = dele.length;
    const ultimaVenda = dele.length ? dele.map(v => v.data).sort().slice(-1)[0] : null;
    return { totalVendido, totalComissao, totalPago, saldoAberto, qtdVendas, ultimaVenda };
  }

  // GET /api/parceiros — dados completos (só gerência)
  if (req.method === 'GET' && url === '/api/parceiros') {
    const sess = getSession(req);
    if (!sess || !canEditComercial(sess)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Sem permissao.' }));
      return;
    }
    try {
      const d = await getParceiros();
      const resumos = {};
      d.influenciadores.forEach(inf => { resumos[inf.id] = _resumoInfluenciador(inf, d.vendas, d.pagamentos); });
      const totalDevido = _round2(Object.values(resumos).reduce((a, r) => a + r.saldoAberto, 0));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        influenciadores: d.influenciadores,
        vendas: d.vendas,
        pagamentos: d.pagamentos,
        tray: { modoTeste: !!d.tray.modoTeste, ultimaSync: d.tray.ultimaSync, configurado: !!(d.tray.consumer_key && d.tray.code) },
        resumos,
        totalDevido,
      }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Erro ao carregar parceiros: ' + e.message }));
    }
    return;
  }

  // GET /api/parceiros/ranking — só posições e volume relativo (visão vendas)
  if (req.method === 'GET' && url === '/api/parceiros/ranking') {
    const sess = getSession(req);
    if (!sess) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Nao autorizado.' }));
      return;
    }
    try {
      const d = await getParceiros();
      const hoje = new Date();
      const ini = new Date(hoje.getFullYear(), hoje.getMonth(), 1).toISOString().slice(0, 10);
      const rankTodos = d.influenciadores.filter(i => i.ativo !== false).map(inf => {
        const dele = d.vendas.filter(v => v.influenciadorId === inf.id && !v.cancelada);
        const doMes = dele.filter(v => (v.data || '') >= ini);
        return {
          nome: inf.nome, handle: inf.handle || '', cupom: inf.cupom,
          qtdMes: doMes.length, qtdTotal: dele.length,
          volumeMes: _round2(doMes.reduce((a, v) => a + (Number(v.valorLiquido) || 0), 0)),
        };
      }).sort((a, b) => b.volumeMes - a.volumeMes || b.qtdMes - a.qtdMes);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ mes: ini.slice(0, 7), ranking: rankTodos }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Erro: ' + e.message }));
    }
    return;
  }

  // POST /api/parceiros/influenciador — criar/atualizar/desativar (só gerência)
  if (req.method === 'POST' && url === '/api/parceiros/influenciador') {
    const sess = getSession(req);
    if (!sess || !canEditComercial(sess)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Sem permissao.' }));
      return;
    }
    try {
      const body = JSON.parse(await readBody(req));
      const inf = body.influenciador || {};
      if (!inf.nome || !inf.cupom) throw new Error('Nome e cupom sao obrigatorios.');
      inf.cupom = String(inf.cupom).trim().toUpperCase();
      inf.comissaoPct = Number(inf.comissaoPct);
      if (!isFinite(inf.comissaoPct) || inf.comissaoPct < 0 || inf.comissaoPct > 100) inf.comissaoPct = 5;
      inf.ativo = inf.ativo !== false;
      const d = await getParceiros();
      // cupom precisa ser único
      const outroComMesmoCupom = d.influenciadores.find(x => x.cupom === inf.cupom && x.id !== inf.id);
      if (outroComMesmoCupom) throw new Error('Cupom "' + inf.cupom + '" já está em uso por ' + outroComMesmoCupom.nome + '.');
      if (inf.id) {
        const idx = d.influenciadores.findIndex(x => x.id === inf.id);
        if (idx < 0) throw new Error('Influenciador não encontrado.');
        d.influenciadores[idx] = Object.assign({}, d.influenciadores[idx], inf);
      } else {
        inf.id = _prcId();
        inf.cadastradoEm = new Date().toISOString().slice(0, 10);
        d.influenciadores.push(inf);
      }
      await saveParceiros(d);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, id: inf.id }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // POST /api/parceiros/venda — lança 1..N vendas manualmente (só gerência)
  if (req.method === 'POST' && url === '/api/parceiros/venda') {
    const sess = getSession(req);
    if (!sess || !canEditComercial(sess)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Sem permissao.' }));
      return;
    }
    try {
      const body = JSON.parse(await readBody(req));
      const lista = Array.isArray(body.vendas) ? body.vendas : [body.venda].filter(Boolean);
      if (!lista.length) throw new Error('Nenhuma venda enviada.');
      const d = await getParceiros();
      const criadas = [];
      for (const raw of lista) {
        const cupom = String(raw.cupom || '').trim().toUpperCase();
        const inf = d.influenciadores.find(x => x.cupom === cupom);
        if (!inf) { criadas.push({ pedido: raw.pedidoTray, erro: 'Cupom ' + cupom + ' sem influenciador cadastrado.' }); continue; }
        // deduplica por pedidoTray (não lança 2x o mesmo pedido)
        if (raw.pedidoTray && d.vendas.some(v => v.pedidoTray === String(raw.pedidoTray))) {
          criadas.push({ pedido: raw.pedidoTray, erro: 'Pedido já lançado.' }); continue;
        }
        const vBruto = Number(raw.valorBruto) || 0;
        const vFrete = Number(raw.valorFrete) || 0;
        const vLiquido = _round2(vBruto - vFrete);
        const comissao = _round2(vLiquido * (Number(inf.comissaoPct) || 0) / 100);
        const venda = {
          id: _prcId(),
          pedidoTray: raw.pedidoTray ? String(raw.pedidoTray) : '',
          cupom,
          influenciadorId: inf.id,
          data: raw.data || new Date().toISOString().slice(0, 10),
          cliente: raw.cliente || '',
          valorBruto: _round2(vBruto),
          valorFrete: _round2(vFrete),
          valorLiquido: vLiquido,
          comissaoPct: Number(inf.comissaoPct) || 0,
          comissao,
          origem: raw.origem || 'manual',
          statusTray: raw.statusTray || 'Enviado',
          cancelada: false,
          criadaEm: new Date().toISOString(),
        };
        d.vendas.push(venda);
        criadas.push({ pedido: venda.pedidoTray, id: venda.id, comissao });
      }
      await saveParceiros(d);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, criadas }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // POST /api/parceiros/venda-cancelar — cancela uma venda (não conta na comissão)
  if (req.method === 'POST' && url === '/api/parceiros/venda-cancelar') {
    const sess = getSession(req);
    if (!sess || !canEditComercial(sess)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Sem permissao.' }));
      return;
    }
    try {
      const { id } = JSON.parse(await readBody(req));
      const d = await getParceiros();
      const v = d.vendas.find(x => x.id === id);
      if (!v) throw new Error('Venda não encontrada.');
      v.cancelada = true;
      v.canceladaEm = new Date().toISOString();
      await saveParceiros(d);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // POST /api/parceiros/pagar — registra pagamento que zera o saldo em aberto
  if (req.method === 'POST' && url === '/api/parceiros/pagar') {
    const sess = getSession(req);
    if (!sess || !canEditComercial(sess)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Sem permissao.' }));
      return;
    }
    try {
      const body = JSON.parse(await readBody(req));
      const influenciadorId = body.influenciadorId;
      const obs = body.observacao || '';
      const d = await getParceiros();
      const inf = d.influenciadores.find(x => x.id === influenciadorId);
      if (!inf) throw new Error('Influenciador não encontrado.');
      const r = _resumoInfluenciador(inf, d.vendas, d.pagamentos);
      if (r.saldoAberto <= 0) throw new Error('Não há saldo em aberto para este influenciador.');
      const pag = {
        id: _prcId(),
        influenciadorId,
        data: body.data || new Date().toISOString().slice(0, 10),
        valor: r.saldoAberto,
        observacao: obs,
        vendasIds: d.vendas.filter(v => v.influenciadorId === influenciadorId && !v.cancelada).map(v => v.id),
        criadoEm: new Date().toISOString(),
        criadoPor: sess.usuario,
      };
      d.pagamentos.push(pag);
      await saveParceiros(d);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, valor: pag.valor }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // POST /api/parceiros/sync-tray — puxa da Tray (ou simula em modo teste)
  if (req.method === 'POST' && url === '/api/parceiros/sync-tray') {
    const sess = getSession(req);
    if (!sess || !canEditComercial(sess)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Sem permissao.' }));
      return;
    }
    try {
      const d = await getParceiros();
      const modoTeste = !d.tray.consumer_key || !d.tray.code;
      let novas = 0, erros = 0, msg = '';
      if (modoTeste) {
        // gera 2..5 vendas fictícias entre os cupons cadastrados
        const infs = d.influenciadores.filter(i => i.ativo !== false);
        if (!infs.length) throw new Error('Cadastre ao menos um influenciador antes de sincronizar em modo teste.');
        const nClientes = ['João Souza', 'Maria Silva', 'Pedro Oliveira', 'Ana Costa', 'Carlos Lima', 'Julia Alves', 'Rafael Nunes'];
        const qtd = 2 + Math.floor(Math.random() * 4);
        for (let i = 0; i < qtd; i++) {
          const inf = infs[Math.floor(Math.random() * infs.length)];
          const pedidoTray = 'TEST-' + Date.now().toString().slice(-6) + '-' + i;
          if (d.vendas.some(v => v.pedidoTray === pedidoTray)) continue;
          const vBruto = 200 + Math.random() * 1800;
          const vFrete = 30 + Math.random() * 60;
          const vLiquido = _round2(vBruto - vFrete);
          const comissao = _round2(vLiquido * (Number(inf.comissaoPct) || 0) / 100);
          d.vendas.push({
            id: _prcId(),
            pedidoTray,
            cupom: inf.cupom,
            influenciadorId: inf.id,
            data: new Date(Date.now() - Math.floor(Math.random() * 20) * 86400000).toISOString().slice(0, 10),
            cliente: nClientes[Math.floor(Math.random() * nClientes.length)],
            valorBruto: _round2(vBruto), valorFrete: _round2(vFrete), valorLiquido: vLiquido,
            comissaoPct: Number(inf.comissaoPct) || 0, comissao,
            origem: 'tray-teste', statusTray: 'Enviado', cancelada: false,
            criadaEm: new Date().toISOString(),
          });
          novas++;
        }
        msg = 'Modo teste: ' + novas + ' venda(s) simulada(s) criada(s).';
      } else {
        // TODO: integração real com API da Tray (consumer_key/consumer_secret/code).
        // Endpoint a implementar: GET /orders com filtro por status=Enviado (após ultimaSync).
        // Cada pedido com coupon → mapeia pra influenciador pelo campo cupom.
        msg = 'Integração real com a Tray ainda não implementada. Configure e me avise.';
      }
      d.tray.ultimaSync = new Date().toISOString();
      await saveParceiros(d);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, novas, erros, msg, modoTeste }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // POST /api/parceiros/tray-config — salva credenciais da Tray (só gerência)
  if (req.method === 'POST' && url === '/api/parceiros/tray-config') {
    const sess = getSession(req);
    if (!sess || !canEditComercial(sess)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Sem permissao.' }));
      return;
    }
    try {
      const body = JSON.parse(await readBody(req));
      const d = await getParceiros();
      d.tray = Object.assign({}, d.tray, {
        consumer_key: body.consumer_key || null,
        consumer_secret: body.consumer_secret || null,
        code: body.code || null,
        modoTeste: !(body.consumer_key && body.code),
      });
      await saveParceiros(d);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, modoTeste: d.tray.modoTeste }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  // ═══ FIM PARCEIROS ═════════════════════════════════════════════════════════

  // POST /api/generate — Gerador de Conteúdo (usa a MESMA chave Anthropic do portal)
  if (req.method === 'POST' && url === '/api/generate') {
    const sess = getSession(req);
    if (!sess) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Nao autorizado.' }));
      return;
    }
    const apiKey = config.anthropicApiKey;
    if (!apiKey) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'API key não configurada' }));
      return;
    }
    const body = await readBody(req);
    try {
      const { system, userMessage } = JSON.parse(body);
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-opus-4-5',
          max_tokens: 8000,
          system,
          messages: [{ role: 'user', content: userMessage }],
        }),
      });
      if (!r.ok) {
        let err = {};
        try { err = await r.json(); } catch (e) {}
        res.writeHead(r.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: (err.error && err.error.message) || 'Erro na API' }));
        return;
      }
      const data = await r.json();
      const textBlock = (data.content || []).find(b => b.type === 'text');
      if (!textBlock) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Sem resposta de texto' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ text: textBlock.text }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
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
    const usuarioEsc = String(sess.usuario || '').replace(/"/g, '\\"');
    const nomeEsc = String(sess.nome || '').replace(/"/g, '\\"');
    const mustChange = sess.mustChange ? 'true' : 'false';
    html = html.replace('/* %%INJECT%% */',
      'var IS_ADMIN=' + isAdmin + '; var USER_NOME="' + nomeEsc + '"; var USER_USUARIO="' + usuarioEsc + '"; ' +
      'var CAN_VIEW_COMERCIAL=' + canViewCom + '; var CAN_EDIT_COMERCIAL=' + canEditCom + '; ' +
      'var MUST_CHANGE_PASSWORD=' + mustChange + ';'
    );
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  } catch(e) {
    res.writeHead(500);
    res.end('Erro ao carregar portal: ' + e.message);
  }
};

// Permite que a geração de conteúdo (chamada à IA, que pode levar mais que
// os 10s padrão) rode até 60s. Aditivo — não altera roteamento nem o resto do portal.
module.exports.config = { maxDuration: 60 };
