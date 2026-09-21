const https  = require('https');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const config = require('../config');
const { gerarContrato } = require('../lib/contracts');
const { gerarGT } = require('../lib/gt');
const { extrairNF } = require('../lib/nfExtract');
const { extrairPedido } = require('../lib/pedidoExtract');
const { getComercialData, saveComercialData, resetMonth, registrarVenda, registrarVendaSite } = require('../lib/comercialStore');
const { getContatos, saveContatos } = require('../lib/contatosStore');
const { getEditorial, saveEditorial } = require('../lib/editorialStore');
const { getTarifas, saveTarifas } = require('../lib/tarifasStore');
const { getParceiros, saveParceiros } = require('../lib/parceirosStore');
const { verifyPassword, setPassword, upsertUser, deleteUser, getAllUsers, generateTempPassword, getRoleSync } = require('../lib/usersStore');
const accessLog = require('../lib/accessLog');
const { calcularProgressoMeta, getFeriadosCustom, saveFeriadosCustom } = require('../lib/metaDiaria');

// ═══════════════════════════════════════════════════════════════
// CRM Pro Hunters — Fatia 1 (Fundação)
// ═══════════════════════════════════════════════════════════════
const crmStore    = require('../lib/crm/store');
const crmUtils    = require('../lib/crm/utils');
const crmColl     = require('../lib/crm/collections');
const crmOcr      = require('../lib/crm/docsOcr');
const crmSchemas  = require('../lib/crm/docsSchemas');
const fenixCompat = require('../lib/crm/fenixCompat');
const blingFenixMap     = require('../lib/crm/blingFenixMap');
const blingFenixGerador = require('../lib/crm/blingFenixGerador');
const coocorrencia      = require('../lib/crm/coocorrencia');
const { sugerirParaCliente } = require('../lib/crm/sugerir');
const automacaoUpsell   = require('../lib/crm/automacaoUpsell');
const catalogoBling     = require('../lib/crm/catalogoBling');

// Bling API v3
const blingOauth      = require('../lib/bling/oauth');
const blingTokenStore = require('../lib/bling/tokenStore');
const blingApi        = require('../lib/bling/api');
const blingBackfill   = require('../lib/bling/backfill');
const blingVendedores = require('../lib/bling/vendedores');
const blingSync       = require('../lib/bling/sync');
const { getFile: _ghGet, saveFile: _ghSave } = require('../lib/githubStore');

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

  // GET /api/meta-diaria — progresso da meta acumulada por vendedor (todos logados)
  if (req.method === 'GET' && url === '/api/meta-diaria') {
    const sess = getSession(req);
    if (!sess) { res.writeHead(401,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Nao autorizado.'})); return; }
    try {
      const d = await getComercialData();
      const progresso = await calcularProgressoMeta(d.sellers || []);
      res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify(progresso));
    } catch (e) { res.writeHead(500,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:e.message})); }
    return;
  }

  // GET /api/feriados — lista de feriados customizados (todos logados podem ler)
  if (req.method === 'GET' && url === '/api/feriados') {
    const sess = getSession(req);
    if (!sess) { res.writeHead(401,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Nao autorizado.'})); return; }
    try {
      const feriados = await getFeriadosCustom();
      res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ feriados, canEdit: canEditComercial(sess) }));
    } catch (e) { res.writeHead(500,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:e.message})); }
    return;
  }

  // POST /api/feriados — atualiza lista (só gerência)
  if (req.method === 'POST' && url === '/api/feriados') {
    const sess = getSession(req);
    if (!sess || !canEditComercial(sess)) { res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Sem permissao.'})); return; }
    try {
      const { feriados } = JSON.parse(await readBody(req));
      if (!Array.isArray(feriados)) throw new Error('Formato inválido.');
      // Valida: strings AAAA-MM-DD
      const validos = feriados.filter(f => typeof f === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(f)).sort();
      await saveFeriadosCustom(validos);
      res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ ok: true, feriados: validos }));
    } catch (e) { res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:e.message})); }
    return;
  }

  // ═════════════════════════════════════════════════════════════
  // CRM Pro Hunters — rotas /api/crm/*
  // Fatia 1: CRUD REST genérico por coleção + session-info + migração parceiros.
  // ═════════════════════════════════════════════════════════════

  // GET /api/crm/session-info — quem sou eu + posso acessar o CRM?
  if (req.method === 'GET' && url === '/api/crm/session-info') {
    const sess = getSession(req);
    if (!sess) { res.writeHead(401,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Nao autorizado.'})); return; }
    const r = crmUtils.role(sess);
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({
      usuario: sess.usuario,
      nome: sess.nome || sess.usuario,
      role: r,
      canAccess: crmUtils.canAccessCRM(sess),
      canSeeAll: crmUtils.canSeeAll(sess),
      isAdmin: r === 'admin',
    }));
    return;
  }

  // Roteador genérico das coleções CRM
  // Formato: /api/crm/<colecao>[/<id>]
  const crmMatch = url.match(/^\/api\/crm\/([a-z_]+)(?:\/([A-Za-z0-9\-_.]+))?$/);
  if (crmMatch && crmMatch[1] !== 'session-info' && crmMatch[1] !== 'migrate-parceiros' && crmMatch[1] !== 'docs' && crmMatch[1] !== 'cron' && crmMatch[1] !== 'fenix'
      && crmMatch[1] !== 'coocorrencia' && crmMatch[1] !== 'sugerir' && crmMatch[1] !== 'tarefas' && crmMatch[1] !== 'ficha'
      && crmMatch[1] !== 'catalogo' && crmMatch[1] !== 'prospeccao' && crmMatch[1] !== 'vendedores') {
    const colName = crmMatch[1];
    const docId = crmMatch[2] || null;
    const reg = crmColl.REGISTRY[colName];
    if (!reg) {
      res.writeHead(404,{'Content-Type':'application/json'});
      res.end(JSON.stringify({error:'Coleção CRM desconhecida: ' + colName}));
      return;
    }
    const sess = getSession(req);
    if (!sess) { res.writeHead(401,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Nao autorizado.'})); return; }
    if (!crmUtils.canAccessCRM(sess)) {
      res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Sem acesso ao CRM.'})); return;
    }

    try {
      // LIST — GET /api/crm/<col>
      if (req.method === 'GET' && !docId) {
        const filter = crmUtils.scopeFilter(sess);
        const docs = await crmStore.listDocs(colName, filter);
        // ordena mais novos primeiro
        docs.sort((a,b) => String(b.criado_em||'').localeCompare(String(a.criado_em||'')));
        res.writeHead(200,{'Content-Type':'application/json'});
        res.end(JSON.stringify({ docs, count: docs.length }));
        return;
      }
      // DETAIL — GET /api/crm/<col>/<id>
      if (req.method === 'GET' && docId) {
        const doc = await crmStore.getDoc(colName, docId);
        if (!doc) { res.writeHead(404,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Não encontrado.'})); return; }
        if (!crmUtils.canReadDoc(sess, doc)) { res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Sem permissao.'})); return; }
        res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ doc }));
        return;
      }
      // CREATE — POST /api/crm/<col>
      if (req.method === 'POST' && !docId) {
        const body = await readBody(req);
        let dados;
        try { dados = JSON.parse(body || '{}'); } catch (e) { throw new crmColl.ValidationError('JSON inválido no body.'); }
        // Força owner se vendedor; admin pode escolher
        dados = crmUtils.enforceOwner(sess, dados);
        const doc = reg.build(dados);
        const saved = await crmStore.createDoc(colName, doc, sess.usuario);
        res.writeHead(201,{'Content-Type':'application/json'}); res.end(JSON.stringify({ doc: saved }));
        return;
      }
      // UPDATE — PUT /api/crm/<col>/<id>
      if (req.method === 'PUT' && docId) {
        const cur = await crmStore.getDoc(colName, docId);
        if (!cur) { res.writeHead(404,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Não encontrado.'})); return; }
        if (!crmUtils.canWriteDoc(sess, cur)) { res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Sem permissao pra editar este documento.'})); return; }
        const body = await readBody(req);
        let patch;
        try { patch = JSON.parse(body || '{}'); } catch (e) { throw new crmColl.ValidationError('JSON inválido no body.'); }
        // Vendedor não muda owner_id pra outro (impede transferir doc pra fora do próprio escopo)
        if (!crmUtils.canSeeAll(sess) && patch.owner_id && patch.owner_id !== sess.usuario) {
          throw new crmColl.ValidationError('Vendedor não pode transferir owner de documento.');
        }
        // Roda o build passando o merge — pega validações
        const merged = { ...cur, ...patch, id: docId };
        const rebuilt = reg.build(merged);
        // updateDoc mantém criado_em/por e escreve
        const saved = await crmStore.updateDoc(colName, docId, rebuilt, sess.usuario);
        res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ doc: saved }));
        return;
      }
      // DELETE — DELETE /api/crm/<col>/<id> (só admin)
      if (req.method === 'DELETE' && docId) {
        if (!crmUtils.canSeeAll(sess)) { res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Só gerência pode deletar.'})); return; }
        const ok = await crmStore.deleteDoc(colName, docId);
        if (!ok) { res.writeHead(404,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Não encontrado.'})); return; }
        res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(405,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Método não suportado.'}));
    } catch (e) {
      const status = e && e.http ? e.http : 500;
      res.writeHead(status,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ error: e.message || String(e) }));
    }
    return;
  }

  // POST /api/crm/migrate-parceiros — importa parceiros.json → crm/referrals.json (só admin, idempotente)
  if (req.method === 'POST' && url === '/api/crm/migrate-parceiros') {
    const sess = getSession(req);
    if (!sess || !crmUtils.canSeeAll(sess)) { res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Só gerência.'})); return; }
    try {
      const parceiros = await getParceiros();
      const lista = Array.isArray(parceiros) ? parceiros : (parceiros && parceiros.parceiros ? parceiros.parceiros : []);
      const existentes = await crmStore.getCollection('referrals');
      // Marca por indicante_nome + telefone pra idempotência
      const chaveExistente = (r) => (String(r.indicante_nome||'').trim().toLowerCase() + '|' + String(r.indicante_telefone||'').replace(/\D/g,''));
      const jaImportadas = new Set(Object.values(existentes).map(chaveExistente));
      let criados = 0, ignorados = 0;
      for (const p of lista) {
        const dados = {
          indicante_nome: p.nome || p.name || p.indicante || 'Sem nome',
          indicante_telefone: p.telefone || p.whatsapp || p.phone || null,
          indicante_email: p.email || null,
          tipo: 'influenciador',
          status: 'ativo',
          owner_id: sess.usuario,
          reward_status: 'nao_aplica',
          notas: 'Migrado de parceiros.json em ' + new Date().toISOString().slice(0,10),
        };
        const chave = chaveExistente(dados);
        if (jaImportadas.has(chave)) { ignorados++; continue; }
        const doc = crmColl.REGISTRY.referrals.build(dados);
        await crmStore.createDoc('referrals', doc, sess.usuario);
        jaImportadas.add(chave);
        criados++;
      }
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok: true, criados, ignorados, total_parceiros: lista.length }));
    } catch (e) {
      res.writeHead(500,{'Content-Type':'application/json'}); res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ═════════════════════════════════════════════════════════════
  // CRM Módulo Documentos — OCR + confirmação + cron de vencimentos
  // ═════════════════════════════════════════════════════════════

  // POST /api/crm/docs/ocr — recebe { file_base64, media_type, tipo_hint? }
  // Retorna { hash, tipo, motivo_classificacao, dados, duplicado? }.
  if (req.method === 'POST' && url === '/api/crm/docs/ocr') {
    const sess = getSession(req);
    if (!sess || !crmUtils.canAccessCRM(sess)) {
      res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Sem acesso ao CRM.'})); return;
    }
    try {
      const body = await readBody(req);
      const { file_base64, media_type, tipo_hint } = JSON.parse(body || '{}');
      if (!file_base64) throw new Error('file_base64 obrigatório.');
      if (!media_type) throw new Error('media_type obrigatório (ex: image/jpeg, application/pdf).');
      const resultado = await crmOcr.processarDocumento(file_base64, media_type, tipo_hint);
      // Checa duplicata: já tem documento com esse hash?
      const existentes = await crmStore.listDocs('documentos', d => d.hash_arquivo === resultado.hash);
      if (existentes.length) {
        resultado.duplicado = true;
        resultado.documento_existente_id = existentes[0].id;
      }
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify(resultado));
    } catch (e) {
      const status = e && e.http ? e.http : 500;
      res.writeHead(status,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ error: e.message || String(e) }));
    }
    return;
  }

  // POST /api/crm/docs/confirm — recebe dados revisados e persiste.
  // Body: { tipo, hash, dados_revisados, forcar_duplicado? }
  //   dados_revisados = objeto com todos os campos que o vendedor confirmou/editou.
  // Efeitos:
  //   1) encontra ou cria Account pelo CPF
  //   2) cria o Documento
  //   3) se tipo=craf, encontra ou cria Arma pelo numero_serie
  //   4) retorna { account_id, documento_id, arma_id?, criou_account, criou_arma }
  if (req.method === 'POST' && url === '/api/crm/docs/confirm') {
    const sess = getSession(req);
    if (!sess || !crmUtils.canAccessCRM(sess)) {
      res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Sem acesso ao CRM.'})); return;
    }
    try {
      const body = await readBody(req);
      const { tipo, hash, dados_revisados, forcar_duplicado } = JSON.parse(body || '{}');
      if (!tipo || !crmSchemas.TIPOS[tipo]) throw new Error('tipo inválido: ' + tipo);
      if (!hash) throw new Error('hash obrigatório.');
      if (!dados_revisados) throw new Error('dados_revisados obrigatório.');

      // Duplicata
      if (!forcar_duplicado) {
        const existentes = await crmStore.listDocs('documentos', d => d.hash_arquivo === hash);
        if (existentes.length) {
          throw Object.assign(new Error('Documento já cadastrado (mesmo hash). Use forcar_duplicado=true pra ignorar.'), { http: 409 });
        }
      }

      const cpf = crmUtils.normalizaCpfCnpj(dados_revisados.cpf);
      if (!crmUtils.validaCpfCnpj(cpf)) throw new Error('CPF inválido no doc revisado.');

      // 1) Encontra ou cria Account
      const accountsIndex = await crmStore.listDocs('accounts', a => crmUtils.normalizaCpfCnpj(a.cpf_cnpj) === cpf);
      let account, criou_account = false;
      if (accountsIndex.length) {
        account = accountsIndex[0];
      } else {
        // Cria automaticamente com dados básicos extraídos
        const dadosAcc = crmUtils.enforceOwner(sess, {
          tipo: 'pf',
          nome: dados_revisados.titular_nome || 'Sem nome',
          cpf_cnpj: cpf,
          status: 'ativo',
        });
        const buildAcc = crmColl.REGISTRY.accounts.build(dadosAcc);
        account = await crmStore.createDoc('accounts', buildAcc, sess.usuario);
        criou_account = true;
      }

      // 2) Se for CRAF, cuida da Arma antes do Documento (pra ter arma_id)
      let arma = null, criou_arma = false;
      if (tipo === 'craf') {
        const serie = String(dados_revisados.arma_numero_serie || '').trim();
        if (!serie) throw new Error('CRAF sem número de série extraído. Não dá pra criar a arma.');
        const armasCliente = await crmStore.listDocs('armas', a => a.account_id === account.id && String(a.numero_serie).trim() === serie);
        if (armasCliente.length) {
          arma = armasCliente[0]; // mantém a arma, só vai atualizar CRAF vigente
        } else {
          const dadosArma = crmUtils.enforceOwner(sess, {
            account_id: account.id,
            numero_serie: serie,
            numero_sigma: dados_revisados.arma_numero_sigma || null,
            tipo: dados_revisados.arma_tipo || null,
            marca: dados_revisados.arma_marca || null,
            modelo: dados_revisados.arma_modelo || null,
            calibre: dados_revisados.arma_calibre || null,
            acionamento: 'pendente',
            classificacao: 'pendente',
            acervo: 'pendente',
          });
          const buildArm = crmColl.REGISTRY.armas.build(dadosArma);
          arma = await crmStore.createDoc('armas', buildArm, sess.usuario);
          criou_arma = true;
        }
      }

      // 3) Cria o Documento
      const validade = dados_revisados.validade || null;
      const numero = dados_revisados.numero_registro || dados_revisados.numero_cr || dados_revisados.numero || null;
      const dadosDoc = crmUtils.enforceOwner(sess, {
        tipo,
        account_id: account.id,
        cpf,
        titular_nome: dados_revisados.titular_nome || null,
        numero,
        validade,
        orgao_emissor: dados_revisados.orgao_emissor || null,
        data_emissao: dados_revisados.data_emissao || dados_revisados.data_expedicao || null,
        dados_extraidos: dados_revisados,
        hash_arquivo: hash,
        arma_id: arma ? arma.id : null,
        revisado_por: sess.usuario,
        revisado_em: new Date().toISOString(),
        avisos_ocr: Array.isArray(dados_revisados.avisos) ? dados_revisados.avisos : [],
      });
      const buildDoc = crmColl.REGISTRY.documentos.build(dadosDoc);
      const documento = await crmStore.createDoc('documentos', buildDoc, sess.usuario);

      // 4) Se criou arma via CRAF, atualiza craf_atual_id
      if (arma && tipo === 'craf') {
        const patchArma = { craf_atual_id: documento.id };
        if (arma.craf_atual_id && arma.craf_atual_id !== documento.id) {
          patchArma.crafs_historico = [...(arma.crafs_historico || []), arma.craf_atual_id];
        }
        await crmStore.updateDoc('armas', arma.id, { ...arma, ...patchArma }, sess.usuario);
      }

      // 5) Se doc vencido ou perto de vencer, cria Activity de renovação
      const st = crmSchemas.calcularStatusValidade(validade);
      if (st.status === 'vencido' || st.status === 'critico' || st.status === 'vence_em_60' || st.status === 'vence_em_90') {
        try {
          const dadosAct = crmUtils.enforceOwner(sess, {
            tipo: 'manual',
            status: 'pendente',
            entidade_tipo: 'account',
            entidade_id: account.id,
            titulo: (st.status === 'vencido' ? '🔴 ' : '⚠ ') + crmSchemas.TIPOS[tipo].label + ' de ' + (dadosDoc.titular_nome || '?') + (st.status === 'vencido' ? ' VENCIDO' : ' vence em ' + st.dias_pra_vencer + ' dias'),
            descricao: 'Documento ' + numero + '. Validade: ' + validade + '.',
            prazo: (validade || new Date().toISOString().slice(0,10)),
            pontos_base: st.status === 'vencido' ? 30 : 15,
            gerada_automaticamente: true,
            trigger_id: 'renovacao_doc_' + documento.id + '_' + st.status,
          });
          const buildAct = crmColl.REGISTRY.activities.build(dadosAct);
          await crmStore.createDoc('activities', buildAct, sess.usuario);
        } catch (e) { /* activity é bonus — não bloqueia o salvamento se falhar */ }
      }

      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({
        ok: true,
        account_id: account.id,
        criou_account,
        documento_id: documento.id,
        arma_id: arma ? arma.id : null,
        criou_arma,
        status_validade: st.status,
      }));
    } catch (e) {
      const status = e && e.http ? e.http : 500;
      res.writeHead(status,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ error: e.message || String(e) }));
    }
    return;
  }

  // ═════════════════════════════════════════════════════════════
  // Fenix — Camada 1 do "cérebro" do CRM: consulta pura à tabela oficial
  // de compatibilidade (crm/compatibility-fenix.json).
  // Ver: claude/crm-inteligencia-compatibilidade.md
  // ═════════════════════════════════════════════════════════════

  // GET /api/crm/fenix/lista — modelos, acessórios, séries, grupos, notas,
  // estatísticas. Popular UI (autocomplete, filtros).
  if (req.method === 'GET' && url === '/api/crm/fenix/lista') {
    const sess = getSession(req);
    if (!sess) { res.writeHead(401,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'sem_sessao'})); return; }
    try {
      const dados = await fenixCompat.listar();
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify(dados));
    } catch (e) {
      res.writeHead(500,{'Content-Type':'application/json'});
      res.end(JSON.stringify({error:'fenix_lista_falhou', detalhe:(e.message||String(e)).slice(0,200)}));
    }
    return;
  }

  // GET /api/crm/fenix/consultar?modelo=PD36R+PRO — detalhe do modelo
  // com acessórios e baterias, notas de rodapé já expandidas em PT.
  if (req.method === 'GET' && url.startsWith('/api/crm/fenix/consultar')) {
    const sess = getSession(req);
    if (!sess) { res.writeHead(401,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'sem_sessao'})); return; }
    try {
      // req.url preserva a query string (a variável `url` já foi split-ada em '?')
      const u = new URL('http://x' + (req.url || ''));
      const modelo = u.searchParams.get('modelo');
      if (!modelo) { res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'modelo_obrigatorio'})); return; }
      const r = await fenixCompat.consultarModelo(modelo);
      if (!r) { res.writeHead(404,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'modelo_nao_encontrado', modelo})); return; }
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify(r));
    } catch (e) {
      res.writeHead(500,{'Content-Type':'application/json'});
      res.end(JSON.stringify({error:'fenix_consulta_falhou', detalhe:(e.message||String(e)).slice(0,200)}));
    }
    return;
  }

  // GET /api/crm/fenix/acessorio?sku=ALG-15 — índice reverso: em quais
  // modelos esse acessório serve.
  if (req.method === 'GET' && url.startsWith('/api/crm/fenix/acessorio')) {
    const sess = getSession(req);
    if (!sess) { res.writeHead(401,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'sem_sessao'})); return; }
    try {
      const u = new URL('http://x' + (req.url || ''));
      const sku = u.searchParams.get('sku');
      if (!sku) { res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'sku_obrigatorio'})); return; }
      const r = await fenixCompat.consultarAcessorio(sku);
      if (!r) { res.writeHead(404,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'acessorio_nao_encontrado', sku})); return; }
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify(r));
    } catch (e) {
      res.writeHead(500,{'Content-Type':'application/json'});
      res.end(JSON.stringify({error:'fenix_acessorio_falhou', detalhe:(e.message||String(e)).slice(0,200)}));
    }
    return;
  }

  // POST /api/crm/fenix/invalidar-cache — força releitura do JSON do
  // GitHub sem esperar o TTL de 5 min. Só gerência.
  if (req.method === 'POST' && url === '/api/crm/fenix/invalidar-cache') {
    const sess = getSession(req);
    if (!sess || !crmUtils.canSeeAll(sess)) { res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Só gerência.'})); return; }
    fenixCompat.invalidarCache();
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ═════════════════════════════════════════════════════════════
  // Mapa Bling ⇄ Fenix — dicionário que traduz produtos do Bling
  // nos códigos oficiais da tabela Fenix. Alimenta a Camada 4
  // (automação de upsell). Ver claude/crm-inteligencia-compatibilidade.md
  // ═════════════════════════════════════════════════════════════

  // POST /api/crm/fenix/mapa/gerar-iniciar — extrai SKUs Fenix únicos dos
  // pedidos e cria o checkpoint. Não chama Claude ainda — só prepara.
  if (req.method === 'POST' && url === '/api/crm/fenix/mapa/gerar-iniciar') {
    const sess = getSession(req);
    if (!sess || !crmUtils.canSeeAll(sess)) { res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Só gerência.'})); return; }
    try {
      const body = await readBody(req);
      const { forcarRegerarRevisados = false } = JSON.parse(body || '{}');
      const r = await blingFenixGerador.iniciar({ iniciado_por: sess.usuario, forcarRegerarRevisados });
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify(r));
    } catch (e) {
      res.writeHead(500,{'Content-Type':'application/json'});
      res.end(JSON.stringify({error:e.message||String(e)}));
    }
    return;
  }

  // POST /api/crm/fenix/mapa/gerar-tick — roda 1 lote (~10 SKUs pra Claude).
  // A UI chama em loop até checkpoint.pendentes == 0.
  if (req.method === 'POST' && url === '/api/crm/fenix/mapa/gerar-tick') {
    const sess = getSession(req);
    if (!sess || !crmUtils.canSeeAll(sess)) { res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Só gerência.'})); return; }
    try {
      const r = await blingFenixGerador.tick();
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify(r));
    } catch (e) {
      res.writeHead(500,{'Content-Type':'application/json'});
      res.end(JSON.stringify({error:e.message||String(e)}));
    }
    return;
  }

  // GET /api/crm/fenix/mapa/gerar-status — situação do checkpoint + stats do mapa
  if (req.method === 'GET' && url === '/api/crm/fenix/mapa/gerar-status') {
    const sess = getSession(req);
    if (!sess || !crmUtils.canSeeAll(sess)) { res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Só gerência.'})); return; }
    try {
      const cp = await blingFenixGerador.lerCheckpoint();
      const stats = await blingFenixMap.estatisticas();
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ checkpoint: cp, estatisticas: stats }));
    } catch (e) {
      res.writeHead(500,{'Content-Type':'application/json'});
      res.end(JSON.stringify({error:e.message||String(e)}));
    }
    return;
  }

  // GET /api/crm/fenix/mapa/lista?filtro=pendentes|revisados|fenix|nao_fenix|baixa_confianca|todos&limite=200
  if (req.method === 'GET' && url.startsWith('/api/crm/fenix/mapa/lista')) {
    const sess = getSession(req);
    if (!sess || !crmUtils.canSeeAll(sess)) { res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Só gerência.'})); return; }
    try {
      const u = new URL('http://x' + (req.url || ''));
      const filtro = u.searchParams.get('filtro') || 'pendentes';
      const limite = Math.min(500, Number(u.searchParams.get('limite') || 200));
      const items = await blingFenixMap.listar({ filtro, limite });
      const stats = await blingFenixMap.estatisticas();
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ items, estatisticas: stats, filtro, limite }));
    } catch (e) {
      res.writeHead(500,{'Content-Type':'application/json'});
      res.end(JSON.stringify({error:e.message||String(e)}));
    }
    return;
  }

  // POST /api/crm/fenix/mapa/aprovar — body: {sku_bling, fenix_codes?, categoria?, marca?, eh_kit?}
  if (req.method === 'POST' && url === '/api/crm/fenix/mapa/aprovar') {
    const sess = getSession(req);
    if (!sess || !crmUtils.canSeeAll(sess)) { res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Só gerência.'})); return; }
    try {
      const body = await readBody(req);
      const { sku_bling, ...patch } = JSON.parse(body || '{}');
      if (!sku_bling) { res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'sku_bling obrigatório'})); return; }
      const m = await blingFenixMap.aprovar(sku_bling, { por: sess.usuario, patch });
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok: true, mapeamento: m }));
    } catch (e) {
      res.writeHead(500,{'Content-Type':'application/json'});
      res.end(JSON.stringify({error:e.message||String(e)}));
    }
    return;
  }

  // POST /api/crm/fenix/mapa/rejeitar — body: {sku_bling, motivo?}
  if (req.method === 'POST' && url === '/api/crm/fenix/mapa/rejeitar') {
    const sess = getSession(req);
    if (!sess || !crmUtils.canSeeAll(sess)) { res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Só gerência.'})); return; }
    try {
      const body = await readBody(req);
      const { sku_bling, motivo } = JSON.parse(body || '{}');
      if (!sku_bling) { res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'sku_bling obrigatório'})); return; }
      const m = await blingFenixMap.rejeitar(sku_bling, { por: sess.usuario, motivo });
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok: true, mapeamento: m }));
    } catch (e) {
      res.writeHead(500,{'Content-Type':'application/json'});
      res.end(JSON.stringify({error:e.message||String(e)}));
    }
    return;
  }

  // GET /api/crm/cron/vencimentos — varre docs e cria Activities pendentes.
  // Idempotente: usa `trigger_id: 'renovacao_doc_<id>_<marco>'` como chave anti-duplicata.
  // Protegido por token: header `x-cron-secret: <config.cronSecret>` ou sessão admin.
  if (req.method === 'GET' && url === '/api/crm/cron/vencimentos') {
    const sess = getSession(req);
    const cronToken = req.headers['x-cron-secret'];
    const vercelCron = req.headers['x-vercel-cron'] === '1';
    const autorizado = vercelCron || (sess && crmUtils.canSeeAll(sess)) || (config.cronSecret && cronToken === config.cronSecret);
    if (!autorizado) {
      res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Sem autorização.'})); return;
    }
    try {
      const docs = await crmStore.listDocs('documentos');
      const activitiesExistentes = await crmStore.listDocs('activities', a => a.gerada_automaticamente && a.trigger_id && a.trigger_id.startsWith('renovacao_doc_'));
      const triggersUsados = new Set(activitiesExistentes.map(a => a.trigger_id));
      let criadas = 0, atualizadas_status = 0;
      for (const d of docs) {
        const st = crmSchemas.calcularStatusValidade(d.validade);
        // Atualiza status_validade no doc se mudou (evita ficar defasado)
        if (d.status_validade !== st.status) {
          try { await crmStore.updateDoc('documentos', d.id, { ...d, status_validade: st.status }, 'cron'); atualizadas_status++; } catch(e){}
        }
        // Marco atual
        const marco = st.status;
        if (marco === 'em_dia' || marco === 'sem_validade') continue;
        const trigger = 'renovacao_doc_' + d.id + '_' + marco;
        if (triggersUsados.has(trigger)) continue;
        try {
          const label = crmSchemas.TIPOS[d.tipo] ? crmSchemas.TIPOS[d.tipo].label : d.tipo;
          const dadosAct = {
            tipo: 'manual',
            status: 'pendente',
            owner_id: d.owner_id || 'gerencia',
            entidade_tipo: 'account',
            entidade_id: d.account_id,
            titulo: (marco === 'vencido' ? '🔴 ' : '⚠ ') + label + ' de ' + (d.titular_nome || '?') + (marco === 'vencido' ? ' VENCIDO' : ' vence em ' + st.dias_pra_vencer + ' dias'),
            descricao: 'Documento ' + (d.numero||'') + '. Validade: ' + (d.validade||'?') + '.',
            prazo: d.validade || new Date().toISOString().slice(0,10),
            pontos_base: marco === 'vencido' ? 30 : 15,
            gerada_automaticamente: true,
            trigger_id: trigger,
          };
          const buildAct = crmColl.REGISTRY.activities.build(dadosAct);
          await crmStore.createDoc('activities', buildAct, 'cron');
          triggersUsados.add(trigger);
          criadas++;
        } catch(e) { /* silencia — segue pra próxima */ }
      }
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok: true, docs_varridos: docs.length, activities_criadas: criadas, docs_atualizados: atualizadas_status }));
    } catch (e) {
      res.writeHead(500,{'Content-Type':'application/json'}); res.end(JSON.stringify({error: e.message}));
    }
    return;
  }

  // ═════════════════════════════════════════════════════════════
  // CRM Camada 2/3.2/4 — Coocorrência, Sugestões, Automação, Vendedor
  // ═════════════════════════════════════════════════════════════

  // ── GET /api/crm/coocorrencia/rebuild — analisa orders.json e gera JSON.
  //    Aceita via x-vercel-cron (cron semanal) OU sessão gerência.
  if (req.method === 'GET' && url === '/api/crm/coocorrencia/rebuild') {
    const sess = getSession(req);
    const vercelCron = req.headers['x-vercel-cron'] === '1';
    const cronToken = req.headers['x-cron-secret'];
    const autorizado = vercelCron || (sess && crmUtils.canSeeAll(sess)) || (config.cronSecret && cronToken === config.cronSecret);
    if (!autorizado) { res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Sem autorização.'})); return; }
    try {
      const r = await coocorrencia.analisar();
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify(r));
    } catch (e) {
      res.writeHead(500,{'Content-Type':'application/json'});
      res.end(JSON.stringify({error:e.message||String(e)}));
    }
    return;
  }

  // ── GET /api/crm/coocorrencia/stats
  if (req.method === 'GET' && url === '/api/crm/coocorrencia/stats') {
    const sess = getSession(req);
    if (!sess || !crmUtils.canAccessCRM(sess)) { res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Sem acesso'})); return; }
    try {
      const s = await coocorrencia.estatisticas();
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify(s));
    } catch (e) { res.writeHead(500,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:e.message})); }
    return;
  }

  // ── GET /api/crm/sugerir?account_id=X&order_id=Y (Y opcional)
  if (req.method === 'GET' && url.startsWith('/api/crm/sugerir')) {
    const sess = getSession(req);
    if (!sess || !crmUtils.canAccessCRM(sess)) { res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Sem acesso'})); return; }
    try {
      const u = new URL('http://x' + (req.url || ''));
      const accountId = u.searchParams.get('account_id');
      const orderId = u.searchParams.get('order_id') || null;
      if (!accountId) { res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'account_id obrigatório'})); return; }
      const r = await sugerirParaCliente({ accountId, orderId });
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify(r));
    } catch (e) { res.writeHead(500,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:e.message})); }
    return;
  }

  // ── GET /api/crm/cron/reativacao — cron semanal (protegida por Vercel Cron)
  if (req.method === 'GET' && url === '/api/crm/cron/reativacao') {
    const sess = getSession(req);
    const vercelCron = req.headers['x-vercel-cron'] === '1';
    const cronToken = req.headers['x-cron-secret'];
    const autorizado = vercelCron || (sess && crmUtils.canSeeAll(sess)) || (config.cronSecret && cronToken === config.cronSecret);
    if (!autorizado) { res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Sem autorização.'})); return; }
    try {
      const r = await automacaoUpsell.disparaReativacao();
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify(r));
    } catch (e) { res.writeHead(500,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:e.message})); }
    return;
  }

  // ── GET /api/crm/tarefas/minhas — fila do vendedor (ou de todos, pra admin)
  if (req.method === 'GET' && url.startsWith('/api/crm/tarefas/minhas')) {
    const sess = getSession(req);
    if (!sess || !crmUtils.canAccessCRM(sess)) { res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Sem acesso'})); return; }
    try {
      const login = String(sess.usuario || '').toLowerCase();
      const scopeAll = crmUtils.canSeeAll(sess);
      const tarefas = await crmStore.listDocs('activities', a =>
        a.status === 'pendente' && (scopeAll || String(a.owner_id || a.dono || '').toLowerCase() === login));
      // Ordena: overdue primeiro, depois por prazo
      const hoje = new Date().toISOString().slice(0, 10);
      tarefas.sort((a, b) => {
        const aOver = (a.prazo && a.prazo < hoje) ? 0 : 1;
        const bOver = (b.prazo && b.prazo < hoje) ? 0 : 1;
        if (aOver !== bOver) return aOver - bOver;
        return String(a.prazo || '').localeCompare(String(b.prazo || ''));
      });
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ tarefas, total: tarefas.length }));
    } catch (e) { res.writeHead(500,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:e.message})); }
    return;
  }

  // ── POST /api/crm/tarefas/:id/concluir  body: { resultado: 'convertida'|'nao_convertida' }
  if (req.method === 'POST' && url.match(/^\/api\/crm\/tarefas\/[a-zA-Z0-9_\-]+\/concluir$/)) {
    const sess = getSession(req);
    if (!sess || !crmUtils.canAccessCRM(sess)) { res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Sem acesso'})); return; }
    try {
      const id = url.split('/')[4];
      const body = await readBody(req);
      let payload = {};
      try { payload = JSON.parse(body || '{}'); } catch(e){}
      const resultado = payload.resultado;
      const t = await crmStore.getDoc('activities', id);
      if (!t) { res.writeHead(404,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Tarefa não encontrada'})); return; }
      await crmStore.updateDoc('activities', id, {
        ...t, status: 'concluida', resultado: resultado || 'concluida',
        concluida_em: new Date().toISOString(), concluida_por: sess.usuario,
      }, sess.usuario);
      res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ ok: true }));
    } catch (e) { res.writeHead(500,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:e.message})); }
    return;
  }

  // ── GET /api/crm/ficha/buscar?q=X — busca cliente por nome ou CPF/CNPJ
  if (req.method === 'GET' && url.startsWith('/api/crm/ficha/buscar')) {
    const sess = getSession(req);
    if (!sess || !crmUtils.canAccessCRM(sess)) { res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Sem acesso'})); return; }
    try {
      const u = new URL('http://x' + (req.url || ''));
      const q = String(u.searchParams.get('q') || '').toLowerCase().trim();
      if (!q || q.length < 2) { res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ resultados: [] })); return; }
      const qDigits = q.replace(/\D/g, '');
      const accounts = await crmStore.listDocs('accounts', a => {
        const nome = String(a.nome || '').toLowerCase();
        const doc = String(a.cpf_cnpj || '').replace(/\D/g, '');
        if (nome.includes(q)) return true;
        if (qDigits && doc.includes(qDigits)) return true;
        return false;
      });
      const resultados = accounts.slice(0, 20).map(a => ({
        id: a.id, nome: a.nome, cpf_cnpj: a.cpf_cnpj, cidade: a.cidade,
        pedidos_count: a.pedidos_count || 0, valor_total: a.valor_total_compras || 0,
        ultima_compra: a.ultima_compra_em, owner: a.owner_id,
      }));
      res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ resultados, total: resultados.length }));
    } catch (e) { res.writeHead(500,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:e.message})); }
    return;
  }

  // ── GET /api/crm/catalogo/rebuild — puxa /produtos do Bling e salva no GitHub
  //    Aceita via x-vercel-cron (cron diário) OU sessão gerência.
  if (req.method === 'GET' && url === '/api/crm/catalogo/rebuild') {
    const sess = getSession(req);
    const vercelCron = req.headers['x-vercel-cron'] === '1';
    const cronToken = req.headers['x-cron-secret'];
    const autorizado = vercelCron || (sess && crmUtils.canSeeAll(sess)) || (config.cronSecret && cronToken === config.cronSecret);
    if (!autorizado) { res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Sem autorização.'})); return; }
    try {
      const r = await catalogoBling.sincronizar();
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify(r));
    } catch (e) {
      res.writeHead(500,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ error: e.message || String(e) }));
    }
    return;
  }

  // ── POST /api/crm/prospeccao — filtra clientes por categoria/marca comprada + período + valor
  //    body: { categoria?, marca?, dias?, valor_minimo?, status?, owner?, limite? }
  //    Retorna: { clientes: [...], total, filtros_aplicados }
  if (req.method === 'POST' && url === '/api/crm/prospeccao') {
    const sess = getSession(req);
    if (!sess || !crmUtils.canAccessCRM(sess)) { res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Sem acesso'})); return; }
    try {
      const body = await readBody(req);
      let f = {};
      try { f = JSON.parse(body || '{}'); } catch(e) {}
      const dias = Number(f.dias || 0);
      const categoria = String(f.categoria || '').toLowerCase().trim();
      const marca = String(f.marca || '').toLowerCase().trim();
      const valorMinimo = Number(f.valor_minimo || 0);
      const status = String(f.status || '').toLowerCase().trim(); // '' | 'ativo' | 'parado' | 'novo'
      const ownerFiltro = String(f.owner || '').toLowerCase().trim();
      const limite = Math.min(500, Number(f.limite || 200));

      // Data de corte pelo período
      const hoje = new Date();
      const corteData = dias > 0 ? new Date(hoje.getTime() - dias * 86400000).toISOString().slice(0,10) : null;

      // Carrega catálogo pra saber categoria/marca de cada SKU
      const catalogo = await catalogoBling.carregar();
      const prodMap = catalogo.produtos || {};

      // Escopo de owner: vendedor só vê os dele; admin vê todos (a não ser que filtre)
      const scopeAll = crmUtils.canSeeAll(sess);
      const login = String(sess.usuario || '').toLowerCase();

      // 1) Filtra Orders por período + itens que casam com categoria/marca
      const orders = await crmStore.listDocs('orders', o => {
        if (o.status === 'cancelado') return false;
        if (corteData && o.data_pedido && o.data_pedido < corteData) return false;
        return true;
      });

      // 2) Agrega por account_id: soma valor, conta pedidos, guarda match
      const agregado = {}; // accId → { pedidos_periodo, valor_periodo, matches:[{sku,nome,data,marca,cat}] }
      for (const o of orders) {
        const accId = o.account_id;
        if (!accId) continue;
        const itensMatch = [];
        for (const it of (o.itens || [])) {
          const sku = String(it.sku || '');
          if (!sku) continue;
          const prod = prodMap[sku];
          const catProd = (prod && prod.categoria) ? String(prod.categoria).toLowerCase() : '';
          const marcaProd = (prod && prod.marca) ? String(prod.marca).toLowerCase() : '';
          // Fallback: se produto não está no catálogo, tenta detectar pelo descricao do item
          const descItem = String(it.descricao || '').toLowerCase();
          const catCasa = !categoria || catProd.includes(categoria) || (
            categoria === 'arma' && (catProd.startsWith('arma_') || descItem.match(/pistola|revolver|revólver|carabina|rifle|espingarda|pcp/))
          ) || descItem.includes(categoria);
          const marcaCasa = !marca || marcaProd.includes(marca) || descItem.includes(marca);
          if (catCasa && marcaCasa) {
            itensMatch.push({
              sku, nome: it.descricao || (prod && prod.nome) || sku,
              data: o.data_pedido, valor: it.valor_total_item || 0,
              marca: marcaProd || null, categoria: catProd || null,
            });
          }
        }
        if (!itensMatch.length && (categoria || marca)) continue; // pediu filtro e nada bateu

        if (!agregado[accId]) agregado[accId] = { pedidos_periodo: 0, valor_periodo: 0, matches: [] };
        agregado[accId].pedidos_periodo++;
        agregado[accId].valor_periodo += Number(o.valor_total || 0);
        for (const m of itensMatch) agregado[accId].matches.push(m);
      }

      // 3) Junta com accounts, aplica filtros restantes (valor, owner, status)
      const accIds = Object.keys(agregado);
      const accounts = await crmStore.listDocs('accounts', a => accIds.includes(a.id));
      const accMap = {}; accounts.forEach(a => accMap[a.id] = a);

      let resultado = [];
      for (const accId of accIds) {
        const a = accMap[accId];
        if (!a) continue;
        if (!scopeAll && String(a.owner_id || '').toLowerCase() !== login) continue;
        if (ownerFiltro && String(a.owner_id || '').toLowerCase() !== ownerFiltro) continue;
        const ag = agregado[accId];
        // Status derivado
        let stCliente = 'ativo';
        const ultima = a.ultima_compra_em;
        if (ultima) {
          const diasDesdeUltima = Math.round((hoje - new Date(ultima)) / 86400000);
          if (diasDesdeUltima > 90) stCliente = 'parado';
        }
        if ((a.pedidos_count || 0) === 1) stCliente = 'novo';
        if (status && stCliente !== status) continue;
        if (valorMinimo > 0 && (a.valor_total_compras || 0) < valorMinimo) continue;

        resultado.push({
          account_id: a.id,
          nome: a.nome,
          cpf_cnpj: a.cpf_cnpj,
          telefone: a.telefone || null,
          email: a.email || null,
          cidade: a.cidade || null,
          owner: a.owner_id,
          status_cliente: stCliente,
          pedidos_total: a.pedidos_count || 0,
          valor_total: a.valor_total_compras || 0,
          ultima_compra: a.ultima_compra_em,
          pedidos_periodo: ag.pedidos_periodo,
          valor_periodo: ag.valor_periodo,
          matches: ag.matches.slice(0, 5), // amostra dos primeiros 5 itens que bateram
          matches_total: ag.matches.length,
        });
      }

      // 4) Ordena por valor_total desc, corta pelo limite
      resultado.sort((a, b) => (b.valor_total || 0) - (a.valor_total || 0));
      const total = resultado.length;
      resultado = resultado.slice(0, limite);

      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({
        clientes: resultado,
        total,
        limitado: total > limite,
        filtros_aplicados: { categoria: categoria || null, marca: marca || null, dias: dias || null, valor_minimo: valorMinimo || null, status: status || null, owner: ownerFiltro || null },
      }));
    } catch (e) {
      res.writeHead(500,{'Content-Type':'application/json'});
      res.end(JSON.stringify({error: e.message || String(e)}));
    }
    return;
  }

  // ═════════════════════════════════════════════════════════════
  // Reatribuição de VENDEDORES nos pedidos existentes
  // Usada 1 vez (ou sempre que a lógica de mapping mudar) pra corrigir
  // orders/accounts cujo vendedor caiu em "gerencia" por bug.
  // ═════════════════════════════════════════════════════════════

  const REATRIB_PATH = 'crm/reatribuicao-vendedores.json';
  async function _reatribLer() {
    try { return JSON.parse(await _ghGet(REATRIB_PATH)); } catch(e) { return null; }
  }
  async function _reatribSalvar(cp) {
    await _ghSave(REATRIB_PATH, JSON.stringify(cp, null, 2), 'Reatribuição vendedores: checkpoint');
  }

  // ── GET /api/crm/vendedores/diagnostico — mostra amostra do formato do Bling
  //     Útil pra confirmar que o campo vendedor está vindo (com nome/email/só id).
  if (req.method === 'GET' && url === '/api/crm/vendedores/diagnostico') {
    const sess = getSession(req);
    if (!sess || !crmUtils.canSeeAll(sess)) { res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Só gerência.'})); return; }
    try {
      // Puxa 5 pedidos amostra do Bling (últimos 30 dias)
      const ate = new Date().toISOString().slice(0,10);
      const desde = new Date(Date.now() - 30*86400000).toISOString().slice(0,10);
      const { pedidos } = await blingSync.puxarTodaListaPedidos({ desde, ate, limitePaginas: 1 });
      const amostra = pedidos.slice(0, 5);
      const detalhes = [];
      for (const p of amostra) {
        try {
          const det = await blingSync.puxarDetalhePedido(p.id);
          detalhes.push({
            bling_id: p.id,
            numero: det.numero,
            data: det.data,
            vendedor: det.vendedor || null, // ← o que interessa
          });
        } catch (e) {
          detalhes.push({ bling_id: p.id, erro: e.message });
        }
      }
      // Puxa mapa de vendedores do Bling
      let mapaVendedores = null;
      try { mapaVendedores = await blingVendedores.puxarMapa(); } catch(e) { mapaVendedores = { erro: e.message }; }
      // Carrega users.json
      const usersJson = await _loadUsersMap();
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({
        ok: true,
        pedidos_amostra: detalhes,
        vendedores_bling: mapaVendedores,
        users_crm: Object.keys(usersJson || {}),
      }));
    } catch (e) {
      res.writeHead(500,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:e.message}));
    }
    return;
  }

  // ── GET /api/crm/vendedores/investigar — puxa amostra maior e mostra vendedor cru + mapeamento
  //     Ideal pra descobrir se o problema é no Bling (dado errado) ou no CRM (mapeamento).
  //     Query: ?dias=30&limite=30  (padrão)
  if (req.method === 'GET' && url.startsWith('/api/crm/vendedores/investigar')) {
    const sess = getSession(req);
    if (!sess || !crmUtils.canSeeAll(sess)) { res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Só gerência.'})); return; }
    try {
      const u = new URL('http://x' + (req.url || ''));
      const dias = Math.min(365, Number(u.searchParams.get('dias') || 30));
      const limite = Math.min(50, Number(u.searchParams.get('limite') || 30));
      const idFiltro = u.searchParams.get('id') || null; // ex: 15596916104 (Wesley)

      const ate = new Date().toISOString().slice(0,10);
      const desde = new Date(Date.now() - dias * 86400000).toISOString().slice(0,10);
      const { pedidos } = await blingSync.puxarTodaListaPedidos({ desde, ate, limitePaginas: 5 });

      const mapaBling = await blingVendedores.puxarMapa();
      const usersJson = await _loadUsersMap();

      const amostra = pedidos.slice(0, limite);
      const linhas = [];
      const porVendedorBling = {};
      const porLoginMapeado  = {};

      for (const p of amostra) {
        try {
          const det = await blingSync.puxarDetalhePedido(p.id);
          const vend = det.vendedor || null;
          const vendId = vend && (vend.id || (vend.contato && vend.contato.id)) || null;
          const vendNomeCache = vendId ? (mapaBling[String(vendId)] && mapaBling[String(vendId)].nome) || null : null;
          const login = await blingSync.mapearVendedor(det, usersJson, { vendedorMapaBling: mapaBling });
          if (idFiltro && String(vendId) !== String(idFiltro)) continue;

          const linha = {
            bling_id: p.id,
            numero: det.numero,
            data: det.data,
            situacao: det.situacao ? (det.situacao.valor || det.situacao.nome || det.situacao.descricao || det.situacao) : null,
            vendedor_id_bling: vendId,
            vendedor_nome_cache: vendNomeCache,
            vendedor_raw_no_pedido: vend,
            mapeado_para: login || 'gerencia',
          };
          linhas.push(linha);
          const kBling = vendNomeCache || String(vendId) || 'sem_vendedor';
          porVendedorBling[kBling] = (porVendedorBling[kBling] || 0) + 1;
          porLoginMapeado[login || 'gerencia'] = (porLoginMapeado[login || 'gerencia'] || 0) + 1;
        } catch (e) {
          linhas.push({ bling_id: p.id, erro: e.message });
        }
      }

      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({
        ok: true,
        parametros: { dias, limite, idFiltro },
        total_pedidos_periodo: pedidos.length,
        analisados: linhas.length,
        resumo_por_vendedor_bling: porVendedorBling,
        resumo_por_login_mapeado:  porLoginMapeado,
        detalhe: linhas,
      }, null, 2));
    } catch (e) {
      res.writeHead(500,{'Content-Type':'application/json'}); res.end(JSON.stringify({error: e.message || String(e)}));
    }
    return;
  }

  // ── POST /api/crm/vendedores/reatribuir-iniciar — lista IDs pra processar
  //     Body opcional: { forcar: true } → ignora checkpoint anterior e recomeça
  if (req.method === 'POST' && url === '/api/crm/vendedores/reatribuir-iniciar') {
    const sess = getSession(req);
    if (!sess || !crmUtils.canSeeAll(sess)) { res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Só gerência.'})); return; }
    try {
      const orders = await crmStore.listDocs('orders', o => o.status !== 'cancelado');
      const ids = orders.map(o => o.bling_pedido_id).filter(Boolean);
      let vendedorMapaBling = {};
      try { vendedorMapaBling = await blingVendedores.puxarMapa({ forcar: true }); } catch(e) {}
      const cp = {
        status: 'em_andamento',
        iniciado_em: new Date().toISOString(),
        iniciado_por: sess.usuario,
        total: ids.length,
        processados: 0,
        atualizados: 0,
        ids_pendentes: ids,
        vendedores_bling: vendedorMapaBling,
        mudancas_por_login: {},
        contadores: {
          atualizados: 0, sem_vendedor_no_bling: 0, vendedor_nao_mapeado: 0,
          ja_mapeado_correto: 0, order_nao_achado: 0, erro_rate_limit: 0, erro_outro: 0,
        },
      };
      await _reatribSalvar(cp);
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok: true, checkpoint: cp }));
    } catch (e) {
      res.writeHead(500,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:e.message}));
    }
    return;
  }

  // ── POST /api/crm/vendedores/reatribuir-tick — processa lote com delay+retry
  //     v2: 400ms entre requests, retry em 429/503, contadores detalhados por motivo.
  if (req.method === 'POST' && url === '/api/crm/vendedores/reatribuir-tick') {
    const sess = getSession(req);
    if (!sess || !crmUtils.canSeeAll(sess)) { res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Só gerência.'})); return; }
    try {
      const cp = await _reatribLer();
      if (!cp || cp.status !== 'em_andamento') { res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Nenhuma reatribuição em andamento.'})); return; }
      if (!cp.ids_pendentes || !cp.ids_pendentes.length) {
        await _finalizarReatribuicao(cp);
        res.writeHead(200,{'Content-Type':'application/json'});
        res.end(JSON.stringify({ ok: true, terminou: true, checkpoint: cp }));
        return;
      }
      const LOTE = 15;              // menor lote pra caber no timeout com delay
      const DELAY_MS = 400;         // 2.5 req/s → respeita rate limit do Bling
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const lote = cp.ids_pendentes.slice(0, LOTE);
      const resto = cp.ids_pendentes.slice(LOTE);

      const usersJson = await _loadUsersMap();
      const ordersAtual = await crmStore.getCollection('orders');
      const idxBling = {};
      for (const [oid, o] of Object.entries(ordersAtual)) {
        if (o && o.bling_pedido_id) idxBling[String(o.bling_pedido_id)] = oid;
      }

      // Contadores detalhados (persistidos no checkpoint)
      const contadores = cp.contadores || {
        atualizados: 0,
        sem_vendedor_no_bling: 0,   // vendedor.id = 0 ou null → gerencia
        vendedor_nao_mapeado: 0,    // vendedor cadastrado no Bling mas não é do CRM (Luis, Redin, Tray)
        ja_mapeado_correto: 0,      // order já estava com vendedor certo
        order_nao_achado: 0,        // bling_id não bateu com nenhum order local
        erro_rate_limit: 0,         // 429/503 mesmo após retry
        erro_outro: 0,              // outra exceção
      };
      const mudancas = cp.mudancas_por_login || {};

      // Processa 1 pedido com retry em 429/503
      async function processar(blingId) {
        let detalhe = null;
        let tentativas = 0;
        while (tentativas < 3) {
          tentativas++;
          try {
            detalhe = await blingSync.puxarDetalhePedido(blingId);
            break;
          } catch (e) {
            const status = e.status || 0;
            if (status === 429 || status === 503) {
              // Backoff progressivo: 1s, 2s, 4s
              await sleep(1000 * Math.pow(2, tentativas - 1));
              if (tentativas >= 3) { contadores.erro_rate_limit++; return; }
              continue;
            }
            contadores.erro_outro++;
            return;
          }
        }
        if (!detalhe) { contadores.erro_outro++; return; }

        // Extrai vendedor cru pra saber se foi realmente null ou só não mapeou
        const v = detalhe.vendedor || null;
        const vendIdBling = v && (v.id || (v.contato && v.contato.id)) || null;
        const semVendBling = !vendIdBling || String(vendIdBling) === '0';

        const vendLogin = await blingSync.mapearVendedor(detalhe, usersJson, {
          vendedorMapaBling: cp.vendedores_bling || {},
        });

        if (!vendLogin) {
          if (semVendBling) contadores.sem_vendedor_no_bling++;
          else contadores.vendedor_nao_mapeado++;
          return;
        }
        const orderId = idxBling[String(blingId)];
        if (!orderId) { contadores.order_nao_achado++; return; }
        const order = ordersAtual[orderId];
        if (!order) { contadores.order_nao_achado++; return; }
        if (order.vendedor_id === vendLogin) { contadores.ja_mapeado_correto++; return; }
        order.vendedor_id = vendLogin;
        order.atualizado_em = new Date().toISOString();
        order.atualizado_por = 'reatribuicao';
        contadores.atualizados++;
        mudancas[vendLogin] = (mudancas[vendLogin] || 0) + 1;
      }

      // Loop com delay entre chamadas
      for (let i = 0; i < lote.length; i++) {
        await processar(lote[i]);
        if (i < lote.length - 1) await sleep(DELAY_MS);
      }

      // Salva orders (1 write) se algo mudou
      if (contadores.atualizados > 0) {
        await crmStore.saveCollection('orders', ordersAtual, 'Reatribuição v2: +' + contadores.atualizados + ' orders acumulado');
      }

      cp.ids_pendentes = resto;
      cp.processados = (cp.processados || 0) + lote.length;
      cp.contadores = contadores;
      cp.atualizados = contadores.atualizados; // mantém compat com UI anterior
      cp.mudancas_por_login = mudancas;
      cp.ultimo_tick_em = new Date().toISOString();

      if (cp.ids_pendentes.length === 0) {
        await _finalizarReatribuicao(cp);
        res.writeHead(200,{'Content-Type':'application/json'});
        res.end(JSON.stringify({ ok: true, terminou: true, atualizados_neste_lote: 'ver contadores', contadores, checkpoint: cp }));
        return;
      }
      await _reatribSalvar(cp);
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok: true, terminou: false, contadores, checkpoint: cp }));
    } catch (e) {
      res.writeHead(500,{'Content-Type':'application/json'}); res.end(JSON.stringify({error: e.message || String(e)}));
    }
    return;
  }

  // ── GET /api/crm/vendedores/reatribuir-status — mostra checkpoint atual
  if (req.method === 'GET' && url === '/api/crm/vendedores/reatribuir-status') {
    const sess = getSession(req);
    if (!sess || !crmUtils.canSeeAll(sess)) { res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Só gerência.'})); return; }
    try {
      const cp = await _reatribLer();
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ checkpoint: cp }));
    } catch (e) { res.writeHead(500,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:e.message})); }
    return;
  }

  // Helper interno: depois de terminar, recalcula owner_id de cada account = vendedor mais frequente
  async function _finalizarReatribuicao(cp) {
    const ordersAtual = await crmStore.getCollection('orders');
    const accountsAtual = await crmStore.getCollection('accounts');
    // Agrega: accountId → { login → count }
    const contPorAcc = {};
    for (const o of Object.values(ordersAtual)) {
      if (!o || !o.account_id) continue;
      if (!o.vendedor_id || o.vendedor_id === 'gerencia') continue;
      const aid = o.account_id;
      if (!contPorAcc[aid]) contPorAcc[aid] = {};
      contPorAcc[aid][o.vendedor_id] = (contPorAcc[aid][o.vendedor_id] || 0) + 1;
    }
    let accsAtualizadas = 0;
    for (const [aid, counts] of Object.entries(contPorAcc)) {
      const acc = accountsAtual[aid];
      if (!acc) continue;
      // Vendedor mais frequente
      const [top] = Object.entries(counts).sort((a,b) => b[1] - a[1]);
      if (!top) continue;
      const [novoOwner] = top;
      if (acc.owner_id === novoOwner) continue;
      acc.owner_id = novoOwner;
      acc.atualizado_em = new Date().toISOString();
      acc.atualizado_por = 'reatribuicao';
      accsAtualizadas++;
    }
    if (accsAtualizadas > 0) {
      await crmStore.saveCollection('accounts', accountsAtual, 'Reatribuição: owner_id de ' + accsAtualizadas + ' accounts');
    }
    cp.status = 'concluido';
    cp.concluido_em = new Date().toISOString();
    cp.accounts_atualizadas = accsAtualizadas;
    // Limpa mapa Bling pra não pesar no checkpoint
    delete cp.vendedores_bling;
    await _reatribSalvar(cp);
  }

  // ── GET /api/crm/catalogo/stats — estatísticas do catálogo (marcas, categorias, etc.)
  if (req.method === 'GET' && url === '/api/crm/catalogo/stats') {
    const sess = getSession(req);
    if (!sess || !crmUtils.canAccessCRM(sess)) { res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Sem acesso'})); return; }
    try {
      const s = await catalogoBling.estatisticas();
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify(s));
    } catch (e) { res.writeHead(500,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:e.message})); }
    return;
  }

  // ── GET /api/crm/ficha/:accountId — ficha completa com histórico
  if (req.method === 'GET' && url.match(/^\/api\/crm\/ficha\/[a-zA-Z0-9_\-]+$/)) {
    const sess = getSession(req);
    if (!sess || !crmUtils.canAccessCRM(sess)) { res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Sem acesso'})); return; }
    try {
      const accId = url.split('/')[4];
      const account = await crmStore.getDoc('accounts', accId);
      if (!account) { res.writeHead(404,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Cliente não encontrado'})); return; }
      const orders = await crmStore.listDocs('orders', o => o.account_id === accId);
      orders.sort((a, b) => String(b.data_pedido || '').localeCompare(String(a.data_pedido || '')));
      const activities = await crmStore.listDocs('activities', a => a.account_id === accId || (a.entidade_tipo === 'account' && a.entidade_id === accId));
      activities.sort((a, b) => String(b.criado_em || '').localeCompare(String(a.criado_em || '')));
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ account, orders, activities }));
    } catch (e) { res.writeHead(500,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:e.message})); }
    return;
  }

  // ═════════════════════════════════════════════════════════════
  // Bling — OAuth 2.0 (integração com API v3)
  // ═════════════════════════════════════════════════════════════

  // GET /api/bling/authorize — só gerência. Gera state, guarda em cookie,
  // redireciona pro Bling. O gerente autoriza no painel do Bling e o Bling
  // redireciona de volta pra /api/bling/callback.
  if (req.method === 'GET' && url === '/api/bling/authorize') {
    const sess = getSession(req);
    if (!sess || !crmUtils.canSeeAll(sess)) {
      res.writeHead(403,{'Content-Type':'text/html; charset=utf-8'});
      res.end('<h2>Só gerência.</h2>');
      return;
    }
    if (!config.blingClientId || !config.blingRedirectUri) {
      res.writeHead(500,{'Content-Type':'text/html; charset=utf-8'});
      res.end('<h2>Bling não configurado.</h2><p>Faltam env vars: BLING_CLIENT_ID e BLING_REDIRECT_URI na Vercel.</p>');
      return;
    }
    const state = blingOauth.generateState();
    const authUrl = blingOauth.buildAuthorizeUrl(state);
    // Cookie efêmero, apenas pra conferir no callback (10 min de vida).
    // HttpOnly + SameSite=Lax pra sobreviver ao redirect do Bling.
    const cookieVal = state + '|' + Buffer.from(sess.usuario).toString('base64url');
    const cookie = 'bling_oauth_state=' + cookieVal + '; Max-Age=600; Path=/; HttpOnly; Secure; SameSite=Lax';
    res.writeHead(302, { 'Location': authUrl, 'Set-Cookie': cookie });
    res.end();
    return;
  }

  // GET /api/bling/callback?code=...&state=...
  // Recebe o code, confere o state, troca por token, redireciona pra
  // uma página de sucesso simples (que fecha se abriu em popup, senão
  // volta pro dashboard).
  if (req.method === 'GET' && url.startsWith('/api/bling/callback')) {
    try {
      // Vercel/Node podem expor query string em lugares diferentes.
      // Tentamos múltiplas fontes pra ser robusto.
      let code = null, stateRecebido = null, errParam = null, errDesc = null;
      // (1) via req.url + URL parser
      try {
        const u = new URL('http://x' + url);
        code = u.searchParams.get('code');
        stateRecebido = u.searchParams.get('state');
        errParam = u.searchParams.get('error');
        errDesc = u.searchParams.get('error_description');
      } catch (e) { /* segue */ }
      // (2) fallback via req.query (Vercel serverless expõe assim quando parseia)
      if (!code && req.query) {
        code = code || req.query.code || null;
        stateRecebido = stateRecebido || req.query.state || null;
        errParam = errParam || req.query.error || null;
        errDesc = errDesc || req.query.error_description || null;
      }
      // Log de debug (aparece nos Runtime Logs da Vercel)
      console.log('[bling/callback] url=', url, 'code=', code ? '<presente>' : '<ausente>', 'state=', stateRecebido ? '<presente>' : '<ausente>', 'err=', errParam || '-');
      if (errParam) throw new Error('Bling recusou: ' + errParam + ' — ' + (errDesc || ''));
      if (!code) throw new Error('code ausente no callback. URL recebida: ' + url);
      const cookieMatch = (req.headers.cookie || '').match(/bling_oauth_state=([^;]+)/);
      if (!cookieMatch) throw new Error('Cookie de state ausente. Recomece a autorização.');
      const [stateSalvo, actorB64] = decodeURIComponent(cookieMatch[1]).split('|');
      if (!stateSalvo || stateSalvo !== stateRecebido) throw new Error('State não confere (possível CSRF).');
      const actorLogin = actorB64 ? Buffer.from(actorB64, 'base64url').toString('utf8') : null;
      await blingOauth.exchangeCodeForToken(code, actorLogin);
      // Limpa cookie state
      const clear = 'bling_oauth_state=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': clear });
      res.end(
        '<!doctype html><html><head><meta charset="utf-8"><title>Bling conectado</title>' +
        '<style>body{font-family:system-ui;background:#f5f5f5;padding:40px;text-align:center;color:#222}' +
        '.card{max-width:480px;margin:0 auto;background:#fff;padding:32px;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,.08)}' +
        '.ok{color:#0a6e2e;font-size:48px;margin-bottom:12px}' +
        'h1{font-size:20px;margin:0 0 8px}p{color:#666;font-size:14px}' +
        '.btn{display:inline-block;background:#0a6e2e;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;margin-top:16px}' +
        '</style></head><body><div class="card"><div class="ok">✓</div>' +
        '<h1>Bling conectado com sucesso</h1>' +
        '<p>Você já pode fechar esta aba ou voltar pro Painel.</p>' +
        '<a class="btn" href="/">← Voltar ao Portal</a>' +
        '</div></body></html>'
      );
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        '<!doctype html><html><head><meta charset="utf-8"><title>Erro Bling</title>' +
        '<style>body{font-family:system-ui;background:#f5f5f5;padding:40px;text-align:center;color:#222}' +
        '.card{max-width:520px;margin:0 auto;background:#fff;padding:32px;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,.08)}' +
        '.err{color:#a01818;font-size:48px;margin-bottom:12px}' +
        '</style></head><body><div class="card"><div class="err">✗</div>' +
        '<h1>Não deu pra conectar o Bling</h1>' +
        '<p style="color:#a01818;background:#fbe6e6;padding:10px;border-radius:6px;font-size:13px">' + String(e.message).replace(/</g,'&lt;') + '</p>' +
        '<a href="/api/bling/authorize" style="color:#0a6e2e">← Tentar de novo</a>' +
        '</div></body></html>'
      );
    }
    return;
  }

  // GET /api/bling/status — JSON pra UI mostrar estado da conexão.
  // Não retorna tokens em claro; só metadados.
  if (req.method === 'GET' && url === '/api/bling/status') {
    const sess = getSession(req);
    if (!sess || !crmUtils.canSeeAll(sess)) {
      res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Só gerência.'})); return;
    }
    try {
      const info = await blingTokenStore.loadTokenInfo();
      const configOk = !!(config.blingClientId && config.blingClientSecret && config.blingRedirectUri);
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ ...info, configurado: configOk }));
    } catch (e) {
      res.writeHead(500,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:e.message}));
    }
    return;
  }

  // POST /api/bling/refresh — força refresh manual (debug/manutenção).
  if (req.method === 'POST' && url === '/api/bling/refresh') {
    const sess = getSession(req);
    if (!sess || !crmUtils.canSeeAll(sess)) { res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Só gerência.'})); return; }
    try {
      await blingOauth.refreshAccessToken();
      const info = await blingTokenStore.loadTokenInfo();
      res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ ok: true, ...info }));
    } catch (e) {
      res.writeHead(500,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:e.message}));
    }
    return;
  }

  // POST /api/bling/disconnect — revoga o token local (não invalida no Bling,
  // só apaga do lado nosso).
  if (req.method === 'POST' && url === '/api/bling/disconnect') {
    const sess = getSession(req);
    if (!sess || !crmUtils.canSeeAll(sess)) { res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Só gerência.'})); return; }
    try {
      await blingTokenStore.deleteToken();
      res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(500,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:e.message}));
    }
    return;
  }

  // GET /api/bling/test — chama um endpoint leve do Bling pra provar que o
  // token está válido e a integração responde.
  if (req.method === 'GET' && url === '/api/bling/test') {
    const sess = getSession(req);
    if (!sess || !crmUtils.canSeeAll(sess)) { res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Só gerência.'})); return; }
    try {
      const r = await blingApi.testConnection();
      res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ ok: true, resposta: r }));
    } catch (e) {
      res.writeHead(500,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:e.message, status:e.status||500}));
    }
    return;
  }

  // ═════════════════════════════════════════════════════════════
  // Bling sync — backfill (com checkpoint) + incremental (manual/cron)
  // ═════════════════════════════════════════════════════════════

  // Helper: carrega users.json pra mapear vendedor Bling → login CRM
  async function _loadUsersMap() {
    try { return await require('../lib/usersStore').getAllUsers(); }
    catch (e) { return {}; }
  }

  // GET /api/bling/backfill/status — situação atual do backfill
  if (req.method === 'GET' && url === '/api/bling/backfill/status') {
    const sess = getSession(req);
    if (!sess || !crmUtils.canSeeAll(sess)) { res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Só gerência.'})); return; }
    try {
      const cp = await blingBackfill.lerCheckpoint();
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ checkpoint: cp }));
    } catch (e) {
      res.writeHead(500,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:e.message}));
    }
    return;
  }

  // POST /api/bling/backfill/iniciar — puxa lista de IDs do range
  //     Body: { meses?: 12, forcar?: true }
  if (req.method === 'POST' && url === '/api/bling/backfill/iniciar') {
    const sess = getSession(req);
    if (!sess || !crmUtils.canSeeAll(sess)) { res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Só gerência.'})); return; }
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body || '{}');
      const meses = payload.meses || 12;
      const forcar = !!payload.forcar;
      const mesesNum = Math.max(1, Math.min(60, Number(meses) || 12));
      const r = await blingBackfill.iniciar({ meses: mesesNum, iniciado_por: sess.usuario, forcar });
      res.writeHead(r.ok ? 200 : 409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r));
    } catch (e) {
      res.writeHead(500,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:e.message}));
    }
    return;
  }

  // GET /api/crm/bling/saude — verifica CRM ↔ Bling e retorna diff por mês
  if (req.method === 'GET' && url.startsWith('/api/crm/bling/saude')) {
    const sess = getSession(req);
    if (!sess || !crmUtils.canSeeAll(sess)) { res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Só gerência.'})); return; }
    try {
      const u = new URL('http://x' + (req.url || ''));
      const meses = Math.max(1, Math.min(24, Number(u.searchParams.get('meses') || 12)));
      const r = await blingBackfill.verificarSaude({ meses });
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify(r));
    } catch (e) {
      res.writeHead(500,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:e.message || String(e)}));
    }
    return;
  }

  // GET /api/crm/bling/auto-recuperar — cron diário 5h UTC:
  //   1) Verifica saúde. 2) Se tem buraco, dispara backfill 12 meses (forcar) pra recuperar.
  //   3) Idempotente: se backfill já rodou hoje, pula.
  if (req.method === 'GET' && url === '/api/crm/bling/auto-recuperar') {
    const sess = getSession(req);
    const vercelCron = req.headers['x-vercel-cron'] === '1';
    const cronToken  = req.headers['x-cron-secret'];
    const autorizado = vercelCron || (sess && crmUtils.canSeeAll(sess)) || (config.cronSecret && cronToken === config.cronSecret);
    if (!autorizado) { res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Sem autorização.'})); return; }
    try {
      const saude = await blingBackfill.verificarSaude({ meses: 12 });
      if (!saude.meses_com_buraco || !saude.meses_com_buraco.length) {
        res.writeHead(200,{'Content-Type':'application/json'});
        res.end(JSON.stringify({ ok: true, motivo: 'sem_buracos', saude }));
        return;
      }
      // Tem buraco → dispara backfill forçado se checkpoint não está em andamento OU é antigo (>6h)
      const cp = await blingBackfill.lerCheckpoint();
      if (cp && cp.status === 'em_andamento') {
        const ultimo = cp.ultimo_lote_em ? new Date(cp.ultimo_lote_em) : new Date(cp.iniciado_em || 0);
        const idadeH = (Date.now() - ultimo.getTime()) / 3600000;
        if (idadeH < 6) {
          res.writeHead(200,{'Content-Type':'application/json'});
          res.end(JSON.stringify({ ok: true, motivo: 'backfill_recente_em_andamento', checkpoint: cp, saude }));
          return;
        }
      }
      const r = await blingBackfill.iniciar({ meses: 12, iniciado_por: 'auto-recuperar', forcar: true });
      await blingBackfill.apendarLog({ tipo: 'auto_recuperar_disparado', saude, backfill: r });
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok: true, motivo: 'buracos_detectados_backfill_iniciado', saude, backfill: r }));
    } catch (e) {
      res.writeHead(500,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:e.message || String(e)}));
    }
    return;
  }

  // POST /api/bling/backfill/continuar — processa próximo lote
  if (req.method === 'POST' && url === '/api/bling/backfill/continuar') {
    const sess = getSession(req);
    if (!sess || !crmUtils.canSeeAll(sess)) { res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Só gerência.'})); return; }
    try {
      const usersJson = await _loadUsersMap();
      const r = await blingBackfill.continuar({ usersJson, ownerFallback: 'gerencia' });
      res.writeHead(r.ok ? 200 : 409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r));
    } catch (e) {
      res.writeHead(500,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:e.message}));
    }
    return;
  }

  // POST /api/bling/backfill/cancelar — apaga checkpoint (sem apagar dados)
  if (req.method === 'POST' && url === '/api/bling/backfill/cancelar') {
    const sess = getSession(req);
    if (!sess || !crmUtils.canSeeAll(sess)) { res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Só gerência.'})); return; }
    try {
      await blingBackfill.apagarCheckpoint();
      res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true}));
    } catch (e) {
      res.writeHead(500,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:e.message}));
    }
    return;
  }

  // POST /api/bling/sync-agora — sync incremental manual (últimos N dias)
  if (req.method === 'POST' && url === '/api/bling/sync-agora') {
    const sess = getSession(req);
    if (!sess || !crmUtils.canSeeAll(sess)) { res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Só gerência.'})); return; }
    try {
      const body = await readBody(req);
      const { dias = 1 } = JSON.parse(body || '{}');
      const usersJson = await _loadUsersMap();
      const r = await blingBackfill.syncIncremental({ dias: Math.max(1, Math.min(30, Number(dias) || 1)), usersJson });
      res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify(r));
    } catch (e) {
      res.writeHead(500,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:e.message}));
    }
    return;
  }

  // GET /api/bling/cron/sync — pra Vercel Cron ou disparo externo
  // Protegido por x-cron-secret OU sessão admin OU header do Vercel Cron.
  // (Vercel Cron chama com header `x-vercel-cron: 1` — aceitamos.)
  if (req.method === 'GET' && url === '/api/bling/cron/sync') {
    const sess = getSession(req);
    const cronToken = req.headers['x-cron-secret'];
    const vercelCron = req.headers['x-vercel-cron'] === '1';
    const autorizado = vercelCron || (sess && crmUtils.canSeeAll(sess)) || (config.cronSecret && cronToken === config.cronSecret);
    if (!autorizado) { res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Sem autorização.'})); return; }
    try {
      const usersJson = await _loadUsersMap();
      const r = await blingBackfill.syncIncremental({ dias: 1, usersJson });
      res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify(r));
    } catch (e) {
      res.writeHead(500,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:e.message}));
    }
    return;
  }

  // GET /api/bling/cron/backfill-tick — processa 1 lote do backfill em andamento
  // e AUTO-ENCADEIA a próxima chamada em background (fire-and-forget), fazendo
  // o backfill inteiro terminar sozinho sem UI aberta.
  // Guarda anti-loop: se checkpoint não tá em_andamento ou tem 0 pendentes,
  // apenas retorna. Salvaguarda extra: contador ticks_hoje pra parar em 500
  // ticks/dia caso algo dê muito errado.
  if (req.method === 'GET' && url === '/api/bling/cron/backfill-tick') {
    const sess = getSession(req);
    const cronToken = req.headers['x-cron-secret'];
    const vercelCron = req.headers['x-vercel-cron'] === '1';
    const chainToken = req.headers['x-bling-chain'] === config.sessionSecret; // self-invocation
    const autorizado = vercelCron || chainToken || (sess && crmUtils.canSeeAll(sess)) || (config.cronSecret && cronToken === config.cronSecret);
    if (!autorizado) { res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Sem autorização.'})); return; }
    try {
      const cpAntes = await blingBackfill.lerCheckpoint();
      if (!cpAntes || cpAntes.status !== 'em_andamento' || !cpAntes.ids_pendentes || cpAntes.ids_pendentes.length === 0) {
        res.writeHead(200,{'Content-Type':'application/json'});
        res.end(JSON.stringify({ ok: true, sem_backfill: true }));
        return;
      }
      // Guarda anti-loop-runaway
      const ticksHoje = (cpAntes.ticks_hoje_data === new Date().toISOString().slice(0,10))
        ? (cpAntes.ticks_hoje_count || 0) : 0;
      if (ticksHoje >= 500) {
        res.writeHead(200,{'Content-Type':'application/json'});
        res.end(JSON.stringify({ ok: true, limite_ticks_diario: true, ticks_hoje: ticksHoje }));
        return;
      }
      const usersJson = await _loadUsersMap();
      const r = await blingBackfill.continuar({ usersJson, ownerFallback: 'gerencia' });
      // Atualiza contador de ticks (best-effort)
      try {
        const cpDepois = await blingBackfill.lerCheckpoint();
        if (cpDepois && cpDepois.status === 'em_andamento') {
          cpDepois.ticks_hoje_data = new Date().toISOString().slice(0,10);
          cpDepois.ticks_hoje_count = ticksHoje + 1;
          const { saveFile } = require('../lib/githubStore');
          await saveFile('crm/bling-backfill.json', JSON.stringify(cpDepois, null, 2), 'Bling backfill: tick ' + (ticksHoje+1));
        }
      } catch (e) { /* silencia */ }
      // AUTO-CHAIN: se ainda tem trabalho e não bateu limite, dispara próximo tick em background
      if (!r.terminou && (ticksHoje + 1) < 500) {
        const host = req.headers['x-forwarded-host'] || req.headers.host || 'dashboardph.vercel.app';
        const url = 'https://' + host + '/api/bling/cron/backfill-tick';
        // Fire-and-forget: dispara sem esperar resposta
        try {
          const https = require('https');
          const u = new URL(url);
          const chainReq = https.request({
            hostname: u.hostname, path: u.pathname, method: 'GET',
            headers: { 'x-bling-chain': config.sessionSecret, 'User-Agent': 'bling-chain' },
            timeout: 3000,
          }, () => {});
          chainReq.on('error', () => {});
          chainReq.on('timeout', () => chainReq.destroy());
          chainReq.end();
        } catch (e) { /* silencia */ }
      }
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok: true, ...r, chained: !r.terminou }));
    } catch (e) {
      res.writeHead(500,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:e.message}));
    }
    return;
  }

  // Adiciona autorização por header Vercel Cron ao /api/crm/cron/vencimentos também
  // (esse endpoint já existe acima; o header x-vercel-cron passa pela verificação de sess se
  //  estiver logada, então o Vercel Cron precisa ser aceito explicitamente. Isso está tratado
  //  no próprio handler dele — mas por segurança podemos ampliar depois se necessário.)

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

  // GET /api/gollog/aeroporto-por-cep?cep=XXXXXXXX — devolve os 3 aeroportos
  // da rede Gol mais próximos do CEP + o melhor. Consulta BrasilAPI + Haversine.
  if (req.method === 'GET' && url.startsWith('/api/gollog/aeroporto-por-cep')) {
    const sess = getSession(req);
    if (!canUseDocumentos(sess)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Nao autorizado.' }));
      return;
    }
    try {
      const u = new URL('http://x' + (req.url || ''));
      const cep = u.searchParams.get('cep');
      if (!cep) { res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'cep obrigatório'})); return; }
      const { sugerirPorCEP } = require('../lib/gollog/aeroportos');
      const r = await sugerirPorCEP(cep);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message || String(e) }));
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
      let targetId = Number(sellerId);
      // Se quem lança é vendedor, força o sellerId pro próprio (impede lançar
      // pro colega mesmo via devtools ou POST direto). Gerência/auxiliar podem
      // escolher qualquer vendedor.
      if (sess.role === 'vendas') {
        const dataAtual = await getComercialData();
        const login = String(sess.usuario || '').toLowerCase();
        const meu = (dataAtual.sellers || []).find(s => String(s.name || '').toLowerCase().includes(login));
        if (!meu) {
          throw new Error('Seu login não está vinculado a nenhum vendedor cadastrado.');
        }
        if (targetId !== meu.id) {
          // silenciosamente redireciona pro próprio; o front já trava, então só
          // chegaria aqui via tentativa manual.
          targetId = meu.id;
        }
      }
      const data = await registrarVenda(targetId, valorNum);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, sellers: data.sellers }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Erro ao registrar venda: ' + e.message }));
    }
    return;
  }

  // POST /api/comercial/registrar-venda-site — lançamento do bucket SITE.
  // Só quem pode editar o comercial (gerência/luis) — vendedor comum nem vê a
  // opção na UI. Site não é vendedor: soma pro Total Geral do mês, mas fica
  // fora do rank/score/comissão/consultor-do-mês.
  if (req.method === 'POST' && url === '/api/comercial/registrar-venda-site') {
    const sess = getSession(req);
    if (!sess || !canEditComercial(sess)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Sem permissao para lançar venda do site.' }));
      return;
    }
    const body = await readBody(req);
    try {
      const { valor } = JSON.parse(body || '{}');
      const valorNum = Number(valor);
      // Aceita negativo (correção). Rejeita só zero, NaN ou vazio.
      if (!Number.isFinite(valorNum) || valorNum === 0) {
        throw new Error('Informe um valor diferente de zero (use negativo pra corrigir).');
      }
      const data = await registrarVendaSite(valorNum);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, siteFat: data.siteFat, ajuste: valorNum }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Erro ao registrar venda do site: ' + e.message }));
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
      const escJs = s => String(s || '').replace(/["\\]/g, '\\$&').replace(/[\r\n]/g,' ');
      html = html.replace('/* %%INJECT_COMERCIAL%% */',
        'window.CAN_EDIT_COMERCIAL=' + canEditCom
        + '; window.USER_NOME="' + escJs(sess.nome) + '"'
        + '; window.USER_USUARIO="' + escJs(sess.usuario) + '"'
        + '; window.USER_ROLE="' + escJs(sess.role || '') + '";'
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
