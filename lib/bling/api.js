// lib/bling/api.js
// Client HTTPS pra chamar endpoints da API v3 do Bling reusando o token OAuth.
// Refresh automático em 401 (tenta 1x).

const https = require('https');
const oauth = require('./oauth');

// IMPORTANTE: chamadas de API vão pra api.bling.com.br (o www.bling.com.br
// é usado APENAS pros endpoints OAuth /authorize e /token, ver lib/bling/oauth.js).
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

// Fachada com refresh automático em 401. Se 401 depois do refresh, desiste.
async function request(method, path, { query, body } = {}) {
  let access = await oauth.ensureValidAccessToken();
  let res = await _requestRaw(method, path, query, body, access);
  if (res.status === 401) {
    // Access invalidou por algum motivo (revogação externa, escopo alterado…)
    // Tenta 1 refresh e refaz. Se falhar de novo, propaga o erro.
    try { await oauth.refreshAccessToken(); } catch (e) {
      throw new Error('Bling retornou 401 e refresh falhou: ' + e.message);
    }
    access = await oauth.ensureValidAccessToken();
    res = await _requestRaw(method, path, query, body, access);
  }
  if (res.status < 200 || res.status >= 300) {
    const msg = (res.body && (res.body.error && (res.body.error.description || res.body.error.type))) ||
                (res.body && res.body.message) ||
                JSON.stringify(res.body).slice(0, 300);
    const err = new Error('Bling API ' + res.status + ' em ' + method + ' ' + path + ': ' + msg);
    err.status = res.status;
    err.bling_body = res.body;
    throw err;
  }
  return res.body;
}

// Atalhos convenientes
const get  = (path, query)      => request('GET',    path, { query });
const post = (path, body, query) => request('POST',   path, { body, query });
const put  = (path, body, query) => request('PUT',    path, { body, query });
const del  = (path, query)      => request('DELETE', path, { query });

// Chamada leve pra testar conexão. /situacoes é um endpoint de metadados
// disponível na maioria dos escopos e retorna rápido.
async function testConnection() {
  try {
    const r = await get('/situacoes/modulos', { limite: 1 });
    return { ok: true, exemplo: r };
  } catch (e) {
    // fallback: se /situacoes/modulos não está no escopo, tenta /contatos
    // com limite 1 (só cabeçalho — resposta bem pequena).
    try {
      const r = await get('/contatos', { limite: 1, pagina: 1 });
      return { ok: true, exemplo: { via: 'contatos', total_amostra: (r && r.data && r.data.length) || 0 } };
    } catch (e2) {
      throw new Error('Nenhum endpoint de teste respondeu. Erro: ' + e2.message);
    }
  }
}

module.exports = { request, get, post, put, del, testConnection };
