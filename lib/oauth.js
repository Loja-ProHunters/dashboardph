// lib/bling/oauth.js
// Fluxo OAuth 2.0 (authorization_code + refresh_token) do Bling v3.
// Docs: https://developer.bling.com.br/aplicativos#autoriza%C3%A7%C3%A3o

const https = require('https');
const crypto = require('crypto');
const config = require('../../config');
const tokenStore = require('./tokenStore');

// Endpoints oficiais da API v3 do Bling
const AUTH_URL  = 'https://www.bling.com.br/Api/v3/oauth/authorize';
const TOKEN_URL = 'https://www.bling.com.br/Api/v3/oauth/token';

// Margem de segurança pra considerar o token "prestes a expirar" e forçar
// refresh antes que o Bling recuse. Bling access_token vale 6h; renovar
// 5 min antes é confortável.
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

// Gera o state anti-CSRF pra proteger o fluxo authorize→callback.
// Guardamos em cookie assinado, conferimos no callback.
function generateState() {
  return crypto.randomBytes(16).toString('hex');
}

// Monta a URL de autorização que o gerente vai abrir no navegador.
// Escopos são passados como string separada por espaço. O Bling ignora os
// que o app não solicitou no cadastro — não faz mal listar mais aqui.
function buildAuthorizeUrl(state) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.blingClientId || '',
    state,
    // redirect_uri é opcional se o app tem apenas 1 callback cadastrado; passar
    // explícito garante que o Bling não improvise.
    redirect_uri: config.blingRedirectUri || '',
  });
  return AUTH_URL + '?' + params.toString();
}

// Faz POST x-www-form-urlencoded com Basic Auth (client_id:client_secret).
// Retorna { status, body } — body é o JSON parseado se possível.
function _postTokenEndpoint(bodyObj) {
  return new Promise((resolve, reject) => {
    const form = new URLSearchParams(bodyObj).toString();
    const basic = Buffer.from((config.blingClientId || '') + ':' + (config.blingClientSecret || '')).toString('base64');
    const opts = {
      hostname: 'www.bling.com.br',
      path: '/Api/v3/oauth/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + basic,
        'Accept': 'application/json',
        'Content-Length': Buffer.byteLength(form),
      },
    };
    const r = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(d); } catch (e) { parsed = { raw: d }; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    r.on('error', reject);
    r.write(form);
    r.end();
  });
}

// Troca o `code` (recebido no callback) por access_token + refresh_token.
async function exchangeCodeForToken(code, actor_login) {
  if (!config.blingClientId || !config.blingClientSecret) {
    throw new Error('BLING_CLIENT_ID / BLING_CLIENT_SECRET não configurados na Vercel.');
  }
  if (!config.blingRedirectUri) {
    throw new Error('BLING_REDIRECT_URI não configurado.');
  }
  const res = await _postTokenEndpoint({
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.blingRedirectUri,
  });
  if (res.status !== 200 || !res.body.access_token) {
    const msg = (res.body && (res.body.error_description || res.body.error)) || JSON.stringify(res.body).slice(0, 300);
    throw new Error('Bling recusou a troca do code por token (' + res.status + '): ' + msg);
  }
  await tokenStore.saveToken({
    access_token: res.body.access_token,
    refresh_token: res.body.refresh_token,
    expires_in: res.body.expires_in,
    scope: res.body.scope,
    account_login: actor_login || null,
  });
  return { ok: true };
}

// Renova o access_token usando o refresh_token guardado. Se o refresh_token
// também estiver inválido/expirado, retorna erro claro pedindo reconexão.
async function refreshAccessToken() {
  const tks = await tokenStore.loadTokens();
  if (!tks || !tks.refresh_token) {
    throw new Error('Sem refresh_token guardado. Reconecte o Bling.');
  }
  const res = await _postTokenEndpoint({
    grant_type: 'refresh_token',
    refresh_token: tks.refresh_token,
  });
  if (res.status !== 200 || !res.body.access_token) {
    const msg = (res.body && (res.body.error_description || res.body.error)) || JSON.stringify(res.body).slice(0, 300);
    throw new Error('Bling recusou o refresh (' + res.status + '): ' + msg + '. Reconecte o Bling manualmente.');
  }
  await tokenStore.saveToken({
    access_token: res.body.access_token,
    // Bling normalmente devolve refresh_token novo; se não vier, mantém o antigo.
    refresh_token: res.body.refresh_token || tks.refresh_token,
    expires_in: res.body.expires_in,
    scope: res.body.scope || tks.scope,
    account_login: tks.account_login,
  });
  return { ok: true };
}

// Retorna um access_token válido pronto pra uso — refresh automático se
// estiver perto de expirar. Se falhar tudo, lança pra a rota tratar.
async function ensureValidAccessToken() {
  const tks = await tokenStore.loadTokens();
  if (!tks) throw new Error('Bling não conectado. Conecte pelo painel de gerência.');
  const naMargem = tks.expires_at && (tks.expires_at - Date.now()) < REFRESH_MARGIN_MS;
  if (naMargem) {
    await refreshAccessToken();
    const novo = await tokenStore.loadTokens();
    if (!novo) throw new Error('Falha ao carregar token após refresh.');
    return novo.access_token;
  }
  return tks.access_token;
}

module.exports = {
  AUTH_URL, TOKEN_URL,
  generateState,
  buildAuthorizeUrl,
  exchangeCodeForToken,
  refreshAccessToken,
  ensureValidAccessToken,
};
