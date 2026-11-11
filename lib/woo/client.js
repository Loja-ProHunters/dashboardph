// lib/woo/client.js — Conector da API REST do WooCommerce (sites WordPress).
//
// Suporta VÁRIAS lojas (config.lojasWoo, vindas das envs WOO_LOJA1_*, etc).
// Autenticação por query string (consumer_key/consumer_secret) — é o método
// oficial do WooCommerce e funciona em qualquer host sobre HTTPS, inclusive
// nos que removem o header Authorization antes de chegar no PHP.
//
// NENHUM segredo mora aqui — ck/cs vêm da env da Vercel via config.js.

const https = require('https');
const { URL } = require('url');
const config = require('../../config');

// Lojas ativas (URL + ck + cs preenchidos).
function lojasAtivas() {
  return (config.lojasWoo || []).filter(l => l && l.ativa);
}

function lojaPorSlug(slug) {
  return (config.lojasWoo || []).find(l => l && l.slug === slug) || null;
}

// Request cru à API wc/v3 de uma loja. Resolve { data, headers, status }.
function _request(loja, method, caminho, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    if (!loja || !loja.ativa) {
      reject(new Error('Loja WooCommerce não configurada/ativa (falta URL, consumer_key ou consumer_secret).'));
      return;
    }
    let u;
    try {
      const base = String(loja.url).replace(/\/+$/, '');
      u = new URL(base + '/wp-json/wc/v3/' + String(caminho || '').replace(/^\/+/, ''));
    } catch (e) {
      reject(new Error('URL inválida pra loja ' + (loja.slug || '?') + ': ' + e.message));
      return;
    }
    if (u.protocol !== 'https:') {
      reject(new Error('A API WooCommerce precisa ser HTTPS (loja ' + loja.slug + ' está como ' + u.protocol + ').'));
      return;
    }
    u.searchParams.set('consumer_key', loja.consumerKey);
    u.searchParams.set('consumer_secret', loja.consumerSecret);
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
      }
    }
    const payload = opts.body ? JSON.stringify(opts.body) : null;
    const reqOpts = {
      method: method,
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      headers: {
        'User-Agent': 'prohunters-portal',
        'Accept': 'application/json',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };
    const r = https.request(reqOpts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(d); } catch (e) {}
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ data: parsed, headers: res.headers, status: res.statusCode });
        } else {
          const msg = (parsed && (parsed.message || parsed.code)) || String(d).slice(0, 200);
          const err = new Error('WooCommerce ' + res.statusCode + ' (' + loja.slug + '): ' + msg);
          err.statusCode = res.statusCode;
          err.body = parsed;
          reject(err);
        }
      });
    });
    r.on('error', reject);
    r.setTimeout(25000, () => { r.destroy(new Error('timeout WooCommerce (' + loja.slug + ')')); });
    if (payload) r.write(payload);
    r.end();
  });
}

// GET simples (um lote). Ex.: wooGet(loja, 'orders', { per_page: 10, after: '2026-11-01T00:00:00' })
async function wooGet(loja, caminho, query) {
  const r = await _request(loja, 'GET', caminho, { query });
  return r.data;
}

// GET PAGINADO — segue o header X-WP-TotalPages e junta tudo. Tem teto de
// páginas pra não estourar o rate limit nem a memória. Pausa entre páginas.
async function wooGetAll(loja, caminho, query, opts) {
  query = query || {};
  opts = opts || {};
  const perPage = opts.perPage || 100;
  const maxPaginas = opts.maxPaginas || 50;
  const delayMs = opts.delayMs === undefined ? 150 : opts.delayMs;
  let page = 1;
  const todos = [];
  for (;;) {
    const r = await _request(loja, 'GET', caminho, { query: Object.assign({}, query, { per_page: perPage, page }) });
    const lote = Array.isArray(r.data) ? r.data : [];
    for (const x of lote) todos.push(x);
    const totalPages = parseInt(r.headers['x-wp-totalpages'] || '1', 10) || 1;
    if (page >= totalPages || page >= maxPaginas || lote.length === 0) break;
    page++;
    if (delayMs) await new Promise(res => setTimeout(res, delayMs));
  }
  return todos;
}

// Teste de conexão de UMA loja: faz um GET barato em /orders (per_page=1).
// Devolve { ok, loja, nome, status, totalPedidos } ou lança com a causa.
async function pingLoja(loja) {
  const r = await _request(loja, 'GET', 'orders', { query: { per_page: 1 } });
  return {
    ok: true,
    loja: loja.slug,
    nome: loja.nome,
    status: r.status,
    totalPedidos: parseInt(r.headers['x-wp-total'] || '0', 10),
  };
}

// Testa TODAS as lojas ativas. Nunca lança — devolve o diagnóstico de cada uma.
async function pingTodas() {
  const out = [];
  for (const loja of lojasAtivas()) {
    try {
      const p = await pingLoja(loja);
      out.push(p);
    } catch (e) {
      out.push({ ok: false, loja: loja.slug, nome: loja.nome, erro: e.message, status: e.statusCode || null });
    }
  }
  return out;
}

module.exports = { lojasAtivas, lojaPorSlug, wooGet, wooGetAll, pingLoja, pingTodas, _request };
