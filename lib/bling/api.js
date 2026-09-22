// lib/bling/api.js
// MULTI-BLING v2 — HTTPS client pra API v3 do Bling, com contaId opcional.
// Se contaId não é passado, usa a conta padrão (prohunters) — mantém compat
// com código antigo. Refresh automático em 401 (tenta 1x) pela conta certa.

const https = require('https');
const oauth = require('./oauth');
const config = require('../../config');

const HOST = 'api.bling.com.br';
const BASE_PATH = '/Api/v3';

function _requestRaw(method, path, query, body, accessToken) {
  return new Promise((resolve, reject) => {
    let fullPath = BASE_PATH + (path.startsWith('/') ? path : '/' + path);
    if (query && Object.keys(query).length) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null || v === '') continue;
        if (Array.isArray(v)) v.forEach(x => qs.append(k, String(x)));
        else qs.append(k, String(v));
      }
      const s = qs.toString();
      if (s) fullPath += '?' + s;
    }
    const payload = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: HOST,
      path: fullPath,
      method,
      headers: {
        'Authorization': 'Bearer ' + accessToken,
        'Accept': 'application/json',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };
    const r = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        let parsed = null;
        try { parsed = d ? JSON.parse(d) : null; } catch (e) { parsed = { raw: d }; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

// Fachada com refresh automático em 401 — POR CONTA.
// A contaId pode vir no options: request('GET', '/x', {contaId: 'calibre'})
async function request(method, path, opts = {}) {
  const { query, body, contaId } = opts;
  const cid = contaId || config.blingContaPadrao || 'prohunters';
  let access = await oauth.ensureValidAccessToken(cid);
  let res = await _requestRaw(method, path, query, body, access);
  if (res.status === 401) {
    try { await oauth.refreshAccessToken(cid); } catch (e) {
      throw new Error('Bling retornou 401 pra "' + cid + '" e refresh falhou: ' + e.message);
    }
    access = await oauth.ensureValidAccessToken(cid);
    res = await _requestRaw(method, path, query, body, access);
  }
  if (res.status < 200 || res.status >= 300) {
    const msg = (res.body && (res.body.error && (res.body.error.description || res.body.error.type))) ||
                (res.body && res.body.message) ||
                JSON.stringify(res.body).slice(0, 300);
    const err = new Error('Bling API "' + cid + '" ' + res.status + ' em ' + method + ' ' + path + ': ' + msg);
    err.status = res.status;
    err.bling_body = res.body;
    err.contaId = cid;
    throw err;
  }
  return res.body;
}

// Atalhos convenientes — aceitam contaId opcional como último parâmetro
const get  = (path, query,        contaId) => request('GET',    path, { query, contaId });
const post = (path, body, query,  contaId) => request('POST',   path, { body, query, contaId });
const put  = (path, body, query,  contaId) => request('PUT',    path, { body, query, contaId });
const del  = (path, query,        contaId) => request('DELETE', path, { query, contaId });

// Testa conexão de uma conta específica
async function testConnection(contaId) {
  try {
    const r = await get('/situacoes/modulos', { limite: 1 }, contaId);
    return { ok: true, contaId: contaId || config.blingContaPadrao, exemplo: r };
  } catch (e) {
    try {
      const r = await get('/contatos', { limite: 1, pagina: 1 }, contaId);
      return { ok: true, contaId: contaId || config.blingContaPadrao, via: 'contatos', total_amostra: (r && r.data && r.data.length) || 0 };
    } catch (e2) {
      throw new Error('Nenhum endpoint respondeu pra "' + (contaId || 'padrão') + '". Erro: ' + e2.message);
    }
  }
}

module.exports = { request, get, post, put, del, testConnection };
