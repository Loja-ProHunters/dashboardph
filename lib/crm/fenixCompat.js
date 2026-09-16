// lib/crm/fenixCompat.js
// Helper para consultar a tabela de compatibilidade Fenix.
//
// Lê crm/compatibility-fenix.json do GitHub (via githubStore) e mantém
// cache em memória com TTL de 5 min pra não bater no GitHub a cada request.
//
// A tabela tem visão dupla espelhada (modelos + acessorios), o que
// permite lookup O(1) em qualquer direção sem precisar de loops.
//
// Ver: claude/crm-inteligencia-compatibilidade.md pro formato completo.

const { getFile } = require('../githubStore');

const ARQUIVO = 'crm/compatibility-fenix.json';
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min

let _cache = null;
let _cacheTs = 0;

async function carregar({ forcar = false } = {}) {
  const agora = Date.now();
  if (!forcar && _cache && (agora - _cacheTs) < CACHE_TTL_MS) {
    return _cache;
  }
  const raw = await getFile(ARQUIVO);
  const data = JSON.parse(raw);
  _cache = data;
  _cacheTs = agora;
  return data;
}

// Expande a nota (símbolo) na descrição completa em português
function expandirNota(entry, notasRodape) {
  if (!entry.nota) return entry;
  return {
    ...entry,
    nota_simbolo: entry.nota,
    nota_descricao: notasRodape[entry.nota] || entry.nota,
  };
}

// ── Consulta um modelo específico ──────────────────────────────
// Retorna: { modelo, serie, serie_nome, tipo, compativel[], baterias[],
//            compativel_agrupado{}, baterias_agrupado{} }
async function consultarModelo(nomeModelo) {
  const d = await carregar();
  const m = d.modelos[nomeModelo];
  if (!m) return null;

  const seriesInfo = d.series[m.serie] || {};
  const gruposInfo = d.grupos || {};
  const notas = d.notas_rodape || {};

  const compat = (m.compativel || []).map(e => ({
    ...expandirNota(e, notas),
    grupo_nome: (gruposInfo[e.grupo] || {}).nome || e.grupo,
    grupo_tipo: (gruposInfo[e.grupo] || {}).tipo || 'acessorio',
  }));
  const bats = (m.baterias || []).map(e => ({
    ...expandirNota(e, notas),
    grupo_nome: (gruposInfo[e.grupo] || {}).nome || e.grupo,
    grupo_tipo: (gruposInfo[e.grupo] || {}).tipo || 'consumivel',
  }));

  // Agrupa por grupo pra UI renderizar em seções
  const agrupar = arr => {
    const map = {};
    for (const e of arr) {
      const g = e.grupo;
      if (!map[g]) map[g] = { grupo: g, grupo_nome: e.grupo_nome, itens: [] };
      map[g].itens.push(e);
    }
    return Object.values(map);
  };

  return {
    modelo: nomeModelo,
    serie: m.serie,
    serie_nome: seriesInfo.nome || m.serie,
    tipo: m.tipo,
    compativel: compat,
    baterias: bats,
    compativel_agrupado: agrupar(compat),
    baterias_agrupado: agrupar(bats),
    total_compativel: compat.length,
    total_baterias: bats.length,
  };
}

// ── Consulta um acessório pelo código Fenix ────────────────────
// Retorna: { sku, grupo, grupo_nome, nome, serve_em[] }
async function consultarAcessorio(sku) {
  const d = await carregar();
  const a = d.acessorios[sku];
  if (!a) return null;
  const gruposInfo = d.grupos || {};
  const notas = d.notas_rodape || {};
  const serve = (a.serve_em || []).map(e => ({
    ...expandirNota(e, notas),
    // agrega a série do modelo pra UI agrupar
    serie: (d.modelos[e.modelo] || {}).serie || null,
  }));
  return {
    sku,
    grupo: a.grupo,
    grupo_nome: (gruposInfo[a.grupo] || {}).nome || a.grupo,
    nome: a.nome,
    serve_em: serve,
    total: serve.length,
  };
}

// ── Lista tudo pra popular UI (autocomplete, filtros) ──────────
async function listar() {
  const d = await carregar();
  return {
    versao_tabela: d.versao_tabela,
    fonte: d.fonte,
    gerado_em: d.gerado_em,
    modelos: Object.keys(d.modelos).sort(),
    modelos_por_serie: Object.entries(d.modelos).reduce((acc, [nome, info]) => {
      const s = info.serie || 'OUTROS';
      if (!acc[s]) acc[s] = [];
      acc[s].push(nome);
      return acc;
    }, {}),
    acessorios: Object.keys(d.acessorios).sort(),
    acessorios_por_grupo: Object.entries(d.acessorios).reduce((acc, [sku, info]) => {
      const g = info.grupo || 'outros';
      if (!acc[g]) acc[g] = [];
      acc[g].push(sku);
      return acc;
    }, {}),
    series: d.series || {},
    grupos: d.grupos || {},
    notas_rodape: d.notas_rodape || {},
    estatisticas: d.estatisticas || {},
  };
}

// ── Invalida cache (útil se acabou de subir versão nova) ───────
function invalidarCache() {
  _cache = null;
  _cacheTs = 0;
}

module.exports = {
  carregar,
  consultarModelo,
  consultarAcessorio,
  listar,
  invalidarCache,
};
