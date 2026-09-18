// lib/crm/catalogoBling.js
// Camada 3.5 do CRM: sincroniza o catálogo COMPLETO de produtos do Bling e
// disponibiliza buscas rápidas (por SKU, marca, categoria). Base pra IA sugerir
// de qualquer marca — não só Fenix.
//
// v2 — Detecção de marca/categoria pela DESCRIÇÃO do produto quando o Bling
//      não devolve esses campos na listagem (problema conhecido da API v3
//      /produtos: só devolve dados básicos, campos ricos vêm em /produtos/{id}).
//      Pra não fazer 2000+ chamadas extras, extraímos via heurística no nome.
//
// Uso:
//   const cat = require('./catalogoBling');
//   await cat.sincronizar();                          // rebuild manual
//   const prod = await cat.getBySku('X-123');          // 1 produto
//   const arr  = await cat.buscarPorMarca('Glock');    // filtra por marca
//   const arr2 = await cat.enriquecer([{sku:'X-1'}]);  // devolve com dados do catálogo

const blingApi = require('../bling/api');
const { getFile, saveFile } = require('../githubStore');
const marcas = require('./marcas');

const CATALOGO_PATH = 'crm/catalogo-bling.json';
const LIMITE_PAGINA = 100;
const MAX_PAGINAS   = 40; // safety: 40*100 = 4000 SKUs

let _cache = null;
let _cacheTs = 0;
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24h

// ── Keywords → categoria (usadas quando o Bling não devolve categoria) ───
// ORDEM IMPORTA: primeiro match ganha. Regras mais específicas ANTES das genéricas.
// Armas ANTES de munição — porque um "revólver .38" tem "revólver" e ".38" e é ARMA.
const CATEGORIA_KEYWORDS = [
  // Categorias específicas primeiro
  { cat: 'iluminacao',           kws: ['lanterna', 'headlamp', 'flashlight', 'iluminador', 'fenix ', 'fenix-'] },
  { cat: 'optica',               kws: ['luneta', 'red dot', 'reddot', 'mira holograf', 'mira reflex', ' scope ', 'binóculo', 'binoculo', 'monóculo', 'monoculo', 'telescópio', 'telescopio', 'ocular'] },
  { cat: 'faca',                 kws: ['faca', 'canivete', 'multitool', 'ferramenta multi', 'knife', 'machado', 'facão', 'facao'] },
  // Armas ANTES de munição (calibres estão no nome de ambos)
  { cat: 'arma_ar_comprimido',   kws: ['pcp', 'ar comprimido', 'airgun', 'air rifle', ' co2', 'gás propelente', 'pressão'] },
  { cat: 'arma_curta',           kws: ['pistola', 'revólver', 'revolver', 'sub-compacta', 'garrucha'] },
  { cat: 'arma_longa',           kws: ['carabina', 'rifle', 'espingarda', 'fuzil', 'shotgun', 'bolt action'] },
  // Munição depois das armas
  { cat: 'municao',              kws: ['munição', 'municao', 'cartucho', 'espoleta', 'projétil', 'projetil', 'chumbinho', 'esfera aço', 'esfera aco', ' ogiva', 'pólvora', 'polvora', '.22 lr', '.38 spl', '.357', '.380', ' .40', '9mm', '.45 acp', '5.56', '7.62', '.308', '.223', '12ga', 'calibre 12', 'calibre 20', 'calibre 28', 'calibre 32'] },
  { cat: 'recarga',              kws: ['recarga', 'prensa', 'die set', 'balança de recarga', 'balanca de recarga', 'dosador', 'tumbler', 'insumo recarga'] },
  { cat: 'acessorio',            kws: ['coldre', 'holster', 'carregador', 'porta-carregador', 'magazine', 'trilho picatinny', 'bipé', 'bipe', 'supressor', 'cabo tático', 'cabo tatico', 'punho', 'grip', 'protetor auricular', 'óculos', 'oculos', 'colete', 'mochila tática', 'mochila tatica', 'porta-arma', 'estojo', 'suporte'] },
];

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
      // Rate limit ou outro erro — backoff simples 1x
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
  // Stats rápidas pra log
  let comMarca = 0, comCategoria = 0;
  for (const p of Object.values(produtos)) {
    if (p.marca) comMarca++;
    if (p.categoria) comCategoria++;
  }

  const catalogo = {
    atualizado_em: new Date().toISOString(),
    total,
    paginas_lidas: pagina,
    truncado,
    com_marca_detectada: comMarca,
    com_categoria_detectada: comCategoria,
    duracao_ms: Date.now() - inicio,
    produtos,
  };
  await saveFile(
    CATALOGO_PATH,
    JSON.stringify(catalogo, null, 2),
    'Bling: catálogo sincronizado (' + total + ' SKUs, ' + comMarca + ' com marca, ' + comCategoria + ' com categoria)'
  );
  _cache = catalogo;
  _cacheTs = Date.now();
  return {
    ok: true,
    total,
    truncado,
    paginas_lidas: pagina,
    com_marca_detectada: comMarca,
    com_categoria_detectada: comCategoria,
    duracao_ms: catalogo.duracao_ms,
  };
}

function _normalizarProduto(p) {
  const nome = String(p.nome || '').trim();
  const descricao = String(p.descricaoComplementar || p.descricao || '').trim();
  const textoBusca = (nome + ' ' + descricao).toLowerCase();

  // Marca vinda da API (raro na listagem) ou detectada pelo nome
  let marca = null;
  if (typeof p.marca === 'string' && p.marca.trim()) marca = p.marca.trim();
  else if (p.marca && p.marca.nome) marca = String(p.marca.nome).trim();
  if (!marca) marca = _detectarMarca(textoBusca);

  // Categoria vinda da API (raro) ou detectada por keyword
  let categoria = null;
  if (p.categoria) {
    categoria = String(p.categoria.descricao || p.categoria.nome || p.categoria).trim() || null;
  }
  if (!categoria) categoria = _detectarCategoria(textoBusca, marca);

  return {
    sku: String(p.codigo || '').trim(),
    id_bling: p.id || null,
    nome,
    descricao,
    categoria,
    marca,
    preco: _toNumber(p.preco || (p.precos && p.precos.preco) || 0),
    ativo: (p.situacao === 'A' || p.situacao === 'Ativo' || p.situacao === true),
    tipo: p.tipo || null,
    estoque_saldo: _toNumber(
      p.estoque && (p.estoque.saldoVirtualTotal || p.estoque.saldoVirtual || p.estoque.saldo)
    ),
    unidade: p.unidade || null,
  };
}

// ── Detecção heurística de marca (fallback quando API não devolve) ──
function _detectarMarca(texto) {
  // 1) Tenta marcas fortes cadastradas em marcas.js
  const forte = marcas.detectarMarca(texto);
  if (forte) return forte;
  // 2) Não achou marca forte — retorna null (a IA vai lidar sem)
  return null;
}

// ── Detecção heurística de categoria por keyword ────────────────
function _detectarCategoria(texto, marcaDetectada) {
  if (!texto) return null;
  // 1) Tenta pelas keywords específicas (ordem importa)
  for (const { cat, kws } of CATEGORIA_KEYWORDS) {
    for (const k of kws) {
      if (texto.includes(k)) return cat;
    }
  }
  // 2) Se não deu match, usa a categoria da marca detectada (Glock → arma_curta, etc.)
  if (marcaDetectada) {
    const meta = marcas.getMeta(marcaDetectada);
    if (meta && meta.categorias && meta.categorias.length) return meta.categorias[0];
  }
  return null;
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
  const marcasCount = {}, categoriasCount = {};
  let ativos = 0, comEstoque = 0;
  for (const p of prods) {
    if (p.ativo) ativos++;
    if (p.estoque_saldo > 0) comEstoque++;
    if (p.marca) marcasCount[p.marca] = (marcasCount[p.marca] || 0) + 1;
    if (p.categoria) categoriasCount[p.categoria] = (categoriasCount[p.categoria] || 0) + 1;
  }
  return {
    atualizado_em: cat.atualizado_em,
    total: prods.length,
    ativos,
    com_estoque: comEstoque,
    marcas_distintas: Object.keys(marcasCount).length,
    top_marcas: Object.entries(marcasCount).sort((a,b)=>b[1]-a[1]).slice(0,30),
    categorias_distintas: Object.keys(categoriasCount).length,
    top_categorias: Object.entries(categoriasCount).sort((a,b)=>b[1]-a[1]).slice(0,30),
  };
}

module.exports = {
  sincronizar, carregar, invalidarCache,
  getBySku, buscarPorMarca, buscarPorCategoria,
  enriquecer, estatisticas,
  CATALOGO_PATH,
};
