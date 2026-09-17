// lib/crm/blingFenixMap.js
// Mapa Bling ⇄ Fenix — cola cada SKU/descrição do Bling ao(s) código(s)
// oficial(is) da tabela Fenix.
//
// Estrutura no GitHub: crm/bling-fenix-map.json
//
// {
//   "gerado_em": "2026-09-17T...",
//   "gerado_por": "gerencia",
//   "mapeamentos": {
//     "6942870307749-ID": {
//       "sku_bling": "6942870307749-ID",
//       "descricao_bling": "Lanterna Fenix TK16 V2.0 - 3100 Lumens preta (ID)",
//       "fenix_codes": ["TK16 V2.0"],
//       "categoria": "lanterna",
//       "marca": "fenix",
//       "eh_kit": false,
//       "confianca": 0.98,
//       "motivo": "Nome contém código exato 'TK16 V2.0'",
//       "revisado_por_humano": false,
//       "revisado_por": null,
//       "revisado_em": null,
//       "primeira_venda_em": "2025-11-03",
//       "vezes_vendido": 19
//     },
//     "MAG557T": {
//       "sku_bling": "MAG557T",
//       "descricao_bling": "Carregador Magpul Ar/M4, Pmag, 30 Municoes...",
//       "fenix_codes": [],
//       "categoria": "outro",
//       "marca": "magpul",
//       "eh_kit": false,
//       "confianca": 1.0,
//       "motivo": "Marca diferente (Magpul), não se aplica à compat Fenix",
//       "revisado_por_humano": false
//     }
//   }
// }
//
// Regras:
//   - Um SKU Bling pode mapear para MÚLTIPLOS códigos Fenix (kits combo).
//   - fenix_codes = [] significa "não é Fenix" (produto de outra marca).
//   - `revisado_por_humano: true` é intocável pela IA em re-gerações.

const { getFile, saveFile } = require('../githubStore');

const ARQUIVO = 'crm/bling-fenix-map.json';
const CACHE_TTL_MS = 5 * 60 * 1000;

let _cache = null;
let _cacheTs = 0;

async function carregar({ forcar = false } = {}) {
  const agora = Date.now();
  if (!forcar && _cache && (agora - _cacheTs) < CACHE_TTL_MS) return _cache;
  let data = { mapeamentos: {} };
  try {
    const raw = await getFile(ARQUIVO);
    data = JSON.parse(raw);
    if (!data.mapeamentos) data.mapeamentos = {};
  } catch (e) {
    // arquivo ainda não existe — trata como mapa vazio
  }
  _cache = data;
  _cacheTs = agora;
  return data;
}

async function salvar(data, mensagemCommit = 'Atualiza bling-fenix-map') {
  data.atualizado_em = new Date().toISOString();
  await saveFile(ARQUIVO, JSON.stringify(data, null, 2), mensagemCommit);
  _cache = data;
  _cacheTs = Date.now();
}

function invalidarCache() { _cache = null; _cacheTs = 0; }

// ── Resolve SKU do Bling → [códigos Fenix] ─────────────────────────
// Usado pela Camada 4 (automação): quando um pedido tem item com
// sku_bling=X, isto devolve os códigos Fenix pra consultar compat.
async function resolverSku(skuBling) {
  const d = await carregar();
  const m = d.mapeamentos[skuBling];
  if (!m) return { codes: [], marca: null, encontrado: false, revisado: false };
  return {
    codes: Array.isArray(m.fenix_codes) ? m.fenix_codes : [],
    marca: m.marca || null,
    categoria: m.categoria || null,
    eh_kit: !!m.eh_kit,
    encontrado: true,
    revisado: !!m.revisado_por_humano,
    confianca: m.confianca || 0,
  };
}

// ── Merge de um lote gerado pela IA no mapa existente ──────────────
// Não sobrescreve entradas com `revisado_por_humano: true`.
// Retorna { adicionados, atualizados_ia, ignorados_humanos }.
async function mergeLoteDaIa(propostas) {
  const d = await carregar({ forcar: true });
  let adicionados = 0, atualizadosIa = 0, ignoradosHumanos = 0;
  for (const p of propostas) {
    if (!p || !p.sku_bling) continue;
    const existente = d.mapeamentos[p.sku_bling];
    if (existente && existente.revisado_por_humano) {
      ignoradosHumanos++;
      continue;
    }
    if (existente) atualizadosIa++;
    else adicionados++;
    d.mapeamentos[p.sku_bling] = {
      ...(existente || {}),
      sku_bling: p.sku_bling,
      descricao_bling: p.descricao_bling || (existente && existente.descricao_bling) || '',
      fenix_codes: Array.isArray(p.fenix_codes) ? p.fenix_codes : [],
      categoria: p.categoria || 'outro',
      marca: p.marca || 'desconhecida',
      eh_kit: !!p.eh_kit,
      confianca: typeof p.confianca === 'number' ? p.confianca : 0.5,
      motivo: p.motivo || '',
      revisado_por_humano: false,
      revisado_por: null,
      revisado_em: null,
      gerado_em: new Date().toISOString(),
      // preserva estatísticas de venda se já existiam
      primeira_venda_em: (existente && existente.primeira_venda_em) || p.primeira_venda_em || null,
      vezes_vendido: (existente && existente.vezes_vendido) || p.vezes_vendido || 0,
      valor_total_vendido: (existente && existente.valor_total_vendido) || p.valor_total_vendido || 0,
    };
  }
  await salvar(d, 'Bling-Fenix map: IA propôs ' + propostas.length + ' (novos=' + adicionados + ', atualizados=' + atualizadosIa + ')');
  return { adicionados, atualizados_ia: atualizadosIa, ignorados_humanos: ignoradosHumanos };
}

// ── Aprovação humana ─────────────────────────────────────────────
async function aprovar(skuBling, { por, patch = {} } = {}) {
  const d = await carregar({ forcar: true });
  const m = d.mapeamentos[skuBling];
  if (!m) throw new Error('SKU não existe no mapa: ' + skuBling);
  d.mapeamentos[skuBling] = {
    ...m,
    ...patch, // permite editar fenix_codes, categoria, marca, etc antes de aprovar
    revisado_por_humano: true,
    revisado_por: por || 'gerencia',
    revisado_em: new Date().toISOString(),
  };
  await salvar(d, 'Bling-Fenix map: aprovado ' + skuBling + ' por ' + (por || 'gerencia'));
  return d.mapeamentos[skuBling];
}

async function rejeitar(skuBling, { por, motivo } = {}) {
  const d = await carregar({ forcar: true });
  const m = d.mapeamentos[skuBling];
  if (!m) throw new Error('SKU não existe no mapa: ' + skuBling);
  d.mapeamentos[skuBling] = {
    ...m,
    fenix_codes: [],
    marca: 'nao_fenix',
    revisado_por_humano: true,
    revisado_por: por || 'gerencia',
    revisado_em: new Date().toISOString(),
    motivo: motivo || 'Rejeitado como não-Fenix',
  };
  await salvar(d, 'Bling-Fenix map: rejeitado ' + skuBling);
  return d.mapeamentos[skuBling];
}

// ── Listagem pra UI de revisão ───────────────────────────────────
async function listar({ filtro = 'todos', limite = 500 } = {}) {
  const d = await carregar();
  let items = Object.values(d.mapeamentos);
  if (filtro === 'pendentes') items = items.filter(m => !m.revisado_por_humano);
  else if (filtro === 'revisados') items = items.filter(m => m.revisado_por_humano);
  else if (filtro === 'fenix') items = items.filter(m => (m.marca === 'fenix') && (m.fenix_codes || []).length > 0);
  else if (filtro === 'nao_fenix') items = items.filter(m => m.marca !== 'fenix' || (m.fenix_codes || []).length === 0);
  else if (filtro === 'baixa_confianca') items = items.filter(m => (m.confianca || 0) < 0.7 && !m.revisado_por_humano);
  // ordem: pendentes primeiro, dentro de cada grupo por vezes_vendido desc
  items.sort((a, b) => {
    const ra = a.revisado_por_humano ? 1 : 0;
    const rb = b.revisado_por_humano ? 1 : 0;
    if (ra !== rb) return ra - rb;
    return (b.vezes_vendido || 0) - (a.vezes_vendido || 0);
  });
  return items.slice(0, limite);
}

async function estatisticas() {
  const d = await carregar();
  const items = Object.values(d.mapeamentos);
  const revisados = items.filter(m => m.revisado_por_humano).length;
  const fenix = items.filter(m => (m.fenix_codes || []).length > 0).length;
  const kits = items.filter(m => m.eh_kit).length;
  const baixa = items.filter(m => (m.confianca || 0) < 0.7 && !m.revisado_por_humano).length;
  return {
    total: items.length,
    revisados,
    pendentes: items.length - revisados,
    fenix,
    kits,
    baixa_confianca_pendentes: baixa,
    atualizado_em: d.atualizado_em || null,
    gerado_em: d.gerado_em || null,
  };
}

module.exports = {
  carregar, salvar, invalidarCache,
  resolverSku,
  mergeLoteDaIa,
  aprovar, rejeitar,
  listar, estatisticas,
};
