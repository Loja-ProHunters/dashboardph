// ============================================================
//  Pro Hunters Portal — Servidor com autenticação por sessão
//  Para rodar: node server.js
//  Para configurar usuários/chave: edite config.js
// ============================================================

const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const config = require('./config');

const PORT         = config.port || 3000;
const SESSION_MS   = (config.sessionHours || 8) * 60 * 60 * 1000;
const sessions     = {}; // { token: { nome, expiry } }

// ── Gera token seguro ──
function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

// ── Valida token da sessão ──
function getSession(req) {
  const cookie = req.headers.cookie || '';
  const match  = cookie.match(/ph_session=([a-f0-9]+)/);
  if (!match) return null;
  const s = sessions[match[1]];
  if (!s || Date.now() > s.expiry) { delete sessions[match[1]]; return null; }
  return s;
}

// ── Página de login ──
function loginPage(erro) {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pro Hunters — Acesso</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',system-ui,sans-serif;background:#f4f5f4;display:flex;align-items:center;justify-content:center;min-height:100vh}
.card{background:#fff;border:1px solid #e2e4e2;border-radius:12px;padding:40px 36px;width:100%;max-width:380px;box-shadow:0 4px 24px rgba(0,0,0,.07)}
.logo{display:flex;align-items:center;gap:10px;margin-bottom:28px;justify-content:center}
.logo-icon{width:36px;height:36px;background:#5aaa66;border-radius:9px;display:flex;align-items:center;justify-content:center}
.logo-icon svg{width:20px;height:20px;fill:none;stroke:white;stroke-width:2}
.logo-name{font-size:17px;font-weight:800;color:#111412}
h2{font-size:16px;font-weight:700;color:#111412;margin-bottom:6px;text-align:center}
p{font-size:12px;color:#717571;text-align:center;margin-bottom:24px}
label{font-size:12px;font-weight:600;color:#444846;display:block;margin-bottom:5px}
input{width:100%;border:1px solid #e2e4e2;border-radius:8px;padding:10px 12px;font-size:14px;color:#111412;outline:none;margin-bottom:14px;transition:border-color .15s}
input:focus{border-color:#5aaa66}
button{width:100%;background:#5aaa66;color:white;border:none;border-radius:8px;padding:11px;font-size:14px;font-weight:700;cursor:pointer;transition:background .15s;margin-top:4px}
button:hover{background:#3d8a49}
.erro{background:#fdf1f1;border:1px solid #f5c0c0;border-radius:8px;padding:10px 14px;font-size:12px;color:#d94f4f;margin-bottom:16px;text-align:center}
.rodape{font-size:11px;color:#b0b4b0;text-align:center;margin-top:20px}
</style>
</head>
<body>
<div class="card">
  <div class="logo">
    <div class="logo-icon"><svg viewBox="0 0 24 24"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg></div>
    <div class="logo-name">PRO HUNTERS</div>
  </div>
  <h2>Acesso ao Portal</h2>
  <p>Digite suas credenciais para entrar</p>
  ${erro ? `<div class="erro">⚠ Usuário ou senha incorretos.</div>` : ''}
  <form method="POST" action="/login">
    <label>Usuário</label>
    <input type="text" name="usuario" autocomplete="username" autofocus required>
    <label>Senha</label>
    <input type="password" name="senha" autocomplete="current-password" required>
    <button type="submit">Entrar →</button>
  </form>
  <div class="rodape">Portal Interno · Comercial</div>
</div>
</body>
</html>`;
}

// ── Parseia body de formulário ──
function parseForm(body) {
  return Object.fromEntries(
    body.split('&').map(p => p.split('=').map(decodeURIComponent))
  );
}

// ── Tipos MIME ──
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.ico':  'image/x-icon',
};

// ── Servidor ──
const server = http.createServer((req, res) => {

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── POST /login ── autentica e cria sessão
  if (req.method === 'POST' && req.url === '/login') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const { usuario, senha } = parseForm(body);
      const user = (config.users || []).find(
        u => u.usuario === usuario && u.senha === senha
      );
      if (!user) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(loginPage(true));
        return;
      }
      const token = newToken();
      sessions[token] = { nome: user.nome, expiry: Date.now() + SESSION_MS };
      res.writeHead(302, {
        'Set-Cookie': `ph_session=${token}; HttpOnly; Path=/; Max-Age=${SESSION_MS / 1000}`,
        'Location': '/',
      });
      res.end();
    });
    return;
  }

  // ── GET /logout ──
  if (req.url === '/logout') {
    const cookie = req.headers.cookie || '';
    const match  = cookie.match(/ph_session=([a-f0-9]+)/);
    if (match) delete sessions[match[1]];
    res.writeHead(302, {
      'Set-Cookie': 'ph_session=; HttpOnly; Path=/; Max-Age=0',
      'Location': '/login',
    });
    res.end();
    return;
  }

  // ── GET /login ── exibe tela de login
  if (req.url === '/login') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(loginPage(false));
    return;
  }

  // ── Rotas protegidas — verificar sessão ──
  if (req.url !== '/login' && !req.url.startsWith('/api')) {
    if (!getSession(req)) {
      res.writeHead(302, { 'Location': '/login' });
      res.end();
      return;
    }
  }

  // ── POST /api/chat ── proxy seguro para a Anthropic
  if (req.method === 'POST' && req.url === '/api/chat') {
    if (!getSession(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Não autorizado.' } }));
      return;
    }
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { system, messages } = JSON.parse(body);
        const payload = JSON.stringify({
          model:      config.model,
          max_tokens: config.maxTokens,
          system,
          messages,
        });
        const options = {
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
        const apiReq = https.request(options, apiRes => {
          let data = '';
          apiRes.on('data', c => data += c);
          apiRes.on('end', () => {
            res.writeHead(apiRes.statusCode, { 'Content-Type': 'application/json' });
            res.end(data);
          });
        });
        apiReq.on('error', err => {
          console.error('Erro Anthropic:', err.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Erro interno.' } }));
        });
        apiReq.write(payload);
        apiReq.end();
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Requisição inválida.' } }));
      }
    });
    return;
  }

  // ── Arquivos estáticos ──
  let filePath = req.url === '/' ? '/dashboard_prohunters.html' : req.url;
  filePath = path.join(__dirname, filePath.split('?')[0]);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Página não encontrada.');
      return;
    }
    const mime = MIME[path.extname(filePath)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`\n✅  Pro Hunters Portal → http://localhost:${PORT}`);
  console.log(`    Usuários: ${(config.users || []).map(u => u.usuario).join(', ')}`);
  console.log(`    Sessão: ${config.sessionHours}h | Modelo: ${config.model}\n`);
});
