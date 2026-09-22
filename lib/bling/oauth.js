// lib/bling/oauth.js
// MULTI-BLING v2 — OAuth 2.0 do Bling v3 com suporte a múltiplas contas.
// Cada função aceita contaId ('prohunters' | 'calibre') e usa as credenciais
// da conta correspondente (client_id/secret/redirect_uri).
// O state do OAuth carrega a contaId pra o callback saber onde salvar o token.

const https = require('https');
const crypto = require('crypto');
const config = require('../../config');
const tokenStore = require('./tokenStore');

const AUTH_URL  = 'https://www.bling.com.br/Api/v3/oauth/authorize';
const TOKEN_URL = 'https://www.bling.com.br/Api/v3/oauth/token';
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

function _contaCfg(contaId) {
  const cid = contaId || config.blingContaPadrao || 'prohunters';
  const cfg = (config.blingContas || {})[cid];
  if (!cfg) throw new Error('Conta Bling desconhecida: ' + cid);
  if (!cfg.ativa) throw new Error('Conta Bling "' + cid + '" não configurada. Faltam variáveis de ambiente.');
  return cfg;
}

function generateState() {
  return crypto.randomBytes(16).toString('hex');
}

// State agora carrega a contaId embutida: "<random>.<contaId>"
// Assim o callback consegue extrair de volta.
function buildStateComConta(contaId) {
  return generateState() + '.' + (contaId || config.blingContaPadrao || 'prohunters');
}

function extrairContaDoState(state) {
  if (!state || !state.includes('.')) return config.blingContaPadrao || 'prohunters';
  return String(state.split('.').pop()).toLowerCase().trim();
}

function buildAuthorizeUrl(contaId, state) {
  const cfg = _contaCfg(contaId);
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.clientId,
    state,
    redirect_uri: cfg.redirectUri,
  });
  return AUTH_URL + '?' + params.toString();
}

function _postTokenEndpoint(contaId, bodyObj) {
  const cfg = _contaCfg(contaId);
  return new Promise((resolve, reject) => {
    const form = new URLSearchParams(bodyObj).toString();
    const basic = Buffer.from(cfg.clientId + ':' + cfg.clientSecret).toString('base64');
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

async function exchangeCodeForToken(contaId, code, actor_login) {
  const cfg = _contaCfg(contaId);
  const res = await _postTokenEndpoint(contaId, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: cfg.redirectUri,
  });
  if (res.status !== 200 || !res.body.access_token) {
    const msg = (res.body && (res.body.error_description || res.body.error)) || JSON.stringify(res.body).slice(0, 300);
    throw new Error('Bling recusou a troca do code por token (' + res.status + '): ' + msg);
  }
  await tokenStore.saveToken(contaId, {
    access_token: res.body.access_token,
    refresh_token: res.body.refresh_token,
    expires_in: res.body.expires_in,
    scope: res.body.scope,
    account_login: actor_login || null,
  });
  return { ok: true, contaId: cfg.contaId };
}

async function refreshAccessToken(contaId) {
  const tks = await tokenStore.loadTokens(contaId);
  if (!tks || !tks.refresh_token) {
    throw new Error('Sem refresh_token guardado pra conta "' + contaId + '". Reconecte.');
  }
  const res = await _postTokenEndpoint(contaId, {
    grant_type: 'refresh_token',
    refresh_token: tks.refresh_token,
  });
  if (res.status !== 200 || !res.body.access_token) {
    const msg = (res.body && (res.body.error_description || res.body.error)) || JSON.stringify(res.body).slice(0, 300);
    throw new Error('Bling recusou o refresh (' + res.status + '): ' + msg + '. Reconecte a conta "' + contaId + '".');
  }
  await tokenStore.saveToken(contaId, {
    access_token: res.body.access_token,
    refresh_token: res.body.refresh_token || tks.refresh_token,
    expires_in: res.body.expires_in,
    scope: res.body.scope || tks.scope,
    account_login: tks.account_login,
  });
  return { ok: true };
}

async function ensureValidAccessToken(contaId) {
  const tks = await tokenStore.loadTokens(contaId);
  if (!tks) throw new Error('Bling "' + (contaId || 'padrão') + '" não conectado. Conecte pelo painel.');
  const naMargem = tks.expires_at && (tks.expires_at - Date.now()) < REFRESH_MARGIN_MS;
  if (naMargem) {
    await refreshAccessToken(contaId);
    const novo = await tokenStore.loadTokens(contaId);
    if (!novo) throw new Error('Falha ao carregar token após refresh.');
    return novo.access_token;
  }
  return tks.access_token;
}

module.exports = {
  AUTH_URL, TOKEN_URL,
  generateState,
  buildStateComConta,
  extrairContaDoState,
  buildAuthorizeUrl,
  exchangeCodeForToken,
  refreshAccessToken,
  ensureValidAccessToken,
};
