// lib/crm/catalogoBling.js
// Camada 3.5 do CRM: sincroniza o catálogo COMPLETO de produtos do Bling e
// disponibiliza buscas rápidas (por SKU, marca, categoria). Base pra IA sugerir
// de qualquer marca — não só Fenix.
//
// Uso:
//   const cat = require('./catalogoBling');
//   await cat.sincronizar();                          // rebuild manual (paginação completa)
//   const prod = await cat.getBySku('X-123');          // 1 produto
//   const arr  = await cat.buscarPorMarca('Glock');    // filtra por marca
//   const arr2 = await cat.enriquecer([{sku:'X-1'}]);  // devolve com dados do catálogo
//
// Roda diário via cron (/api/crm/catalogo/rebuild) e cache em memória de 24h.

const blingApi = require('../bling/api');
const { getFile, saveFile } = require('../githubStore');

const CATALOGO_PATH = 'crm/catalogo-bling.json';
const LIMITE_PAGINA = 100;
const MAX_PAGINAS   = 40; // safety: 40*100 = 4000 SKUs (temos ~2037 hoje)

let _cache = null;
let _cacheTs = 0;
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24h

// ── Sincroniza catálogo completo do Bling e salva no GitHub ─────────
async function sincronizar() {
  const inicio = Date.now();
  const produtos = {};
  let pagina = 1;
  let truncado = false;

  while (pagina <= MAX_PAGINAS) {
    let r;
    try {
      r = await blingApi.get('/produtos', { pagina, limite: LIMITE_PAGINA });
    } catch (e) {
      // Rate limit ou outro erro — tenta backoff simples 1x
      if (e.status === 429 || e.status === 503) {
        await _sleep(1500);
        r = await blingApi.get('/produtos', { pagina, limite: LIMITE_PAGINA });
      } else {
        throw e;
      }
    }
    const lote = Array.isArray(r) ? r : (r && Array.isArray(r.data) ? r.data : []);
    if (!lote.length) break;

    for (const p of lote) {
      const sku = String(p.codigo || '').trim();
      if (!sku) continue;
      produtos[sku] = _normalizarProduto(p);
    }

    if (lote.length < LIMITE_PAGINA) break;
    pagina++;
    if (pagina > MAX_PAGINAS) truncado = true;
  }

  const total = Object.keys(produtos).length;
  const catalogo = {
    atualizado_em: new Date().toISOString(),
    total,
    paginas_lidas: pagina,
    truncado,
    duracao_ms: Date.now() - inicio,
    produtos,
  };
  await saveFile(
    CATALOGO_PATH,
    JSON.stringify(catalogo, null, 2),
    'Bling: catálogo sincronizado (' + total + ' SKUs)'
  );
  _cache = catalogo;
  _cacheTs = Date.now();
  return {
    ok: true,
    total,
    truncado,
    paginas_lidas: pagina,
    duracao_ms: catalogo.duracao_ms,
  };
}

function _normalizarProduto(p) {
  // Bling v3 /produtos devolve algo tipo:
  // { id, codigo, nome, tipo, situacao ('A'|'I'|'E'), preco, descricaoComplementar,
  //   categoria: {id, descricao}, marca: 'Nome', estoque: {saldoVirtualTotal, ...}, ... }
  return {
    sku: String(p.codigo || '').trim(),
    id_bling: p.id || null,
    nome: String(p.nome || '').trim(),
    descricao: String(p.descricaoComplementar || p.descricao || '').trim(),
    categoria: p.categoria
      ? String(p.categoria.descricao || p.categoria.nome || p.categoria).trim()
      : null,
    marca: (typeof p.marca === 'string' ? p.marca.trim() : (p.marca && p.marca.nome ? String(p.marca.nome).trim() : null)) || null,
    preco: _toNumber(p.preco || (p.precos && p.precos.preco) || 0),
    ativo: (p.situacao === 'A' || p.situacao === 'Ativo' || p.situacao === true),
    tipo: p.tipo || null,
    estoque_saldo: _toNumber(
      p.estoque && (p.estoque.saldoVirtualTotal || p.estoque.saldoVirtual || p.estoque.saldo)
    ),
    unidade: p.unidade || null,
  };
}

function _toNumber(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Carrega do GitHub, com cache em memória (TTL 24h) ────────────
async function carregar({ forcar = false } = {}) {
  if (!forcar && _cache && (Date.now() - _cacheTs) < CACHE_TTL) return _cache;
  try {
    const raw = await getFile(CATALOGO_PATH);
    _cache = JSON.parse(raw);
    _cacheTs = Date.now();
  } catch (e) {
    _cache = { atualizado_em: null, total: 0, produtos: {} };
    _cacheTs = Date.now();
  }
  return _cache;
}

function invalidarCache() { _cache = null; _cacheTs = 0; }

async function getBySku(sku) {
  if (!sku) return null;
  const cat = await carregar();
  return (cat.produtos || {})[String(sku).trim()] || null;
}

async function buscarPorMarca(marca, { somenteAtivos = true, somenteComEstoque = false } = {}) {
  const cat = await carregar();
  const m = String(marca || '').toLowerCase().trim();
  if (!m) return [];
  return Object.values(cat.produtos || {}).filter(p => {
    if (somenteAtivos && !p.ativo) return false;
    if (somenteComEstoque && !(p.estoque_saldo > 0)) return false;
    return p.marca && p.marca.toLowerCase().includes(m);
  });
}

async function buscarPorCategoria(categoria, { somenteAtivos = true, somenteComEstoque = false } = {}) {
  const cat = await carregar();
  const c = String(categoria || '').toLowerCase().trim();
  if (!c) return [];
  return Object.values(cat.produtos || {}).filter(p => {
    if (somenteAtivos && !p.ativo) return false;
    if (somenteComEstoque && !(p.estoque_saldo > 0)) return false;
    return p.categoria && p.categoria.toLowerCase().includes(c);
  });
}

// ── Enriquece uma lista de itens {sku, ...} com dados do catálogo ──
async function enriquecer(itens) {
  const cat = await carregar();
  const prods = cat.produtos || {};
  return (itens || []).map(it => {
    const sku = String(it.sku || it.sku_bling || '').trim();
    const p = prods[sku] || null;
    return { ...it, catalogo: p };
  });
}

// ── Estatísticas resumidas do catálogo ───────────────────────────
async function estatisticas() {
  const cat = await carregar();
  const prods = Object.values(cat.produtos || {});
  const marcas = {}, categorias = {};
  let ativos = 0, comEstoque = 0;
  for (const p of prods) {
    if (p.ativo) ativos++;
    if (p.estoque_saldo > 0) comEstoque++;
    if (p.marca) marcas[p.marca] = (marcas[p.marca] || 0) + 1;
    if (p.categoria) categorias[p.categoria] = (categorias[p.categoria] || 0) + 1;
  }
  return {
    atualizado_em: cat.atualizado_em,
    total: prods.length,
    ativos,
    com_estoque: comEstoque,
    marcas_distintas: Object.keys(marcas).length,
    top_marcas: Object.entries(marcas).sort((a,b)=>b[1]-a[1]).slice(0,30),
    categorias_distintas: Object.keys(categorias).length,
    top_categorias: Object.entries(categorias).sort((a,b)=>b[1]-a[1]).slice(0,30),
  };
}

module.exports = {
  sincronizar, carregar, invalidarCache,
  getBySku, buscarPorMarca, buscarPorCategoria,
  enriquecer, estatisticas,
  CATALOGO_PATH,
};
