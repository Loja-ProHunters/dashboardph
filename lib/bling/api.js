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

// ── THROTTLE + BACKOFF ──────────────────────────────────────────────────────
// O Bling limita ~3 requisições por segundo POR CONTA. Sem controle, sob o
// processo único da Hostinger (vários acessos ao mesmo tempo) as chamadas
// estouram o limite e voltam 429 → as telas do Bling falham/ficam lentas.
// Aqui a gente: (1) serializa as chamadas DE CADA CONTA com um intervalo mínimo
// entre elas, e (2) dá retry com backoff no 429/503.
const _MIN_INTERVALO_MS = 350;   // ~2.8 req/s por conta (abaixo do teto de 3/s)
const _RETRY_MAX = 4;
const _ultimoTs = {};            // cid -> timestamp da última chamada
const _cadeia = {};              // cid -> promise (fila serial por conta)
function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Executa fn respeitando o intervalo mínimo entre chamadas DA MESMA conta.
function _agendar(cid, fn) {
  const anterior = _cadeia[cid] || Promise.resolve();
  const proxima = anterior.catch(() => {}).then(async () => {
    const espera = Math.max(0, (_ultimoTs[cid] || 0) + _MIN_INTERVALO_MS - Date.now());
    if (espera) await _sleep(espera);
    _ultimoTs[cid] = Date.now();
    return fn();
  });
  _cadeia[cid] = proxima.catch(() => {});
  return proxima;
}

// Fachada com throttle por conta, refresh automático em 401 e retry no 429/503.
// A contaId pode vir no options: request('GET', '/x', {contaId: 'calibre'})
async function request(method, path, opts = {}) {
  const { query, body, contaId } = opts;
  const cid = contaId || config.blingContaPadrao || 'prohunters';
  let refreshTentado = false;
  let res;
  for (let tentativa = 1; tentativa <= _RETRY_MAX + 1; tentativa++) {
    const access = await oauth.ensureValidAccessToken(cid);
    res = await _agendar(cid, () => _requestRaw(method, path, query, body, access));
    // 401 → refresh do token (uma vez só) e tenta de novo
    if (res.status === 401 && !refreshTentado) {
      refreshTentado = true;
      try { await oauth.refreshAccessToken(cid); } catch (e) {
        throw new Error('Bling retornou 401 pra "' + cid + '" e refresh falhou: ' + e.message);
      }
      continue;
    }
    // 429 (limite) ou 503 → espera e tenta de novo (backoff)
    if ((res.status === 429 || res.status === 503) && tentativa <= _RETRY_MAX) {
      await _sleep(500 * tentativa + Math.floor(Math.random() * 300));
      continue;
    }
    break;
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
