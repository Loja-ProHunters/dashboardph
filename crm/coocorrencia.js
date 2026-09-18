// lib/crm/coocorrencia.js
// Camada 2 do "cérebro" do CRM: análise de coocorrência histórica dos pedidos.
//
// A partir de `crm/orders.json` (importado do Bling), aprende:
//   - "compraram_junto" — quem comprou X também levou Y no MESMO pedido
//   - "compraram_depois" — quem comprou X voltou depois pra comprar Y
//                          (mesmo cliente, próximos pedidos, ≤180 dias)
//
// Cruza por SKU do Bling (não pelo código Fenix — funciona pra qualquer marca).
// Roda em ~1s pros 522 pedidos atuais, ~15s pra 10k. Sem checkpoint.
//
// Escreve em `crm/coocorrencia.json`. Cron semanal (domingo) re-analisa.
//
// Ver: claude/crm-inteligencia-compatibilidade.md

const { getFile, saveFile } = require('../githubStore');

const ORDERS_PATH        = 'crm/orders.json';
const COOCORRENCIA_PATH  = 'crm/coocorrencia.json';
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 min

const DIAS_MAX_RECOMPRA = 180; // janela para "compraram_depois"
const TOP_N_POR_SKU = 5;       // top N sugestões guardadas por SKU base
const MIN_VEZES = 2;           // ignora pares que só apareceram 1x (ruído)

let _cache = null;
let _cacheTs = 0;

async function carregar({ forcar = false } = {}) {
  const agora = Date.now();
  if (!forcar && _cache && (agora - _cacheTs) < CACHE_TTL_MS) return _cache;
  let data = { produtos: {} };
  try {
    const raw = await getFile(COOCORRENCIA_PATH);
    data = JSON.parse(raw);
    if (!data.produtos) data.produtos = {};
  } catch (e) {
    // arquivo ainda não existe — trata como vazio
  }
  _cache = data;
  _cacheTs = agora;
  return data;
}

function invalidarCache() { _cache = null; _cacheTs = 0; }

// ── Analisa TODOS os orders e gera o crm/coocorrencia.json ──────
// Retorna estatísticas do que foi processado.
async function analisar() {
  const inicio = Date.now();
  let orders = {};
  try { orders = JSON.parse(await getFile(ORDERS_PATH)); }
  catch (e) { throw new Error('Não consegui ler crm/orders.json: ' + e.message); }

  const idsOrder = Object.keys(orders);

  // ── Passo 1: agrupa pedidos por cliente e conta pares "juntos" ──
  const porAccount = {};    // accountId → [{orderId, data, itens: [{sku, descricao}]}]
  const paresJuntos = {};   // "skuA|skuB" → count (sempre A<B pra evitar duplicar)
  const vezesVendido = {};  // sku → vezes vendido total
  const descricao = {};     // sku → última descrição vista

  for (const oid of idsOrder) {
    const o = orders[oid];
    if (!o || o.status === 'cancelado' || o.status === 'devolvido') continue;

    const itens = (o.itens || []).filter(i => i && i.sku);
    if (!itens.length) continue;

    const skusUnicos = [...new Set(itens.map(i => String(i.sku)))];

    // Guarda descrição pra referência
    for (const it of itens) {
      const sku = String(it.sku);
      if (it.descricao && !descricao[sku]) descricao[sku] = it.descricao;
      vezesVendido[sku] = (vezesVendido[sku] || 0) + (Number(it.quantidade) || 1);
    }

    // Pares no MESMO pedido
    for (let i = 0; i < skusUnicos.length; i++) {
      for (let j = i + 1; j < skusUnicos.length; j++) {
        const [a, b] = [skusUnicos[i], skusUnicos[j]].sort();
        const chave = a + '|' + b;
        paresJuntos[chave] = (paresJuntos[chave] || 0) + 1;
      }
    }

    // Guarda por cliente pra passo 2 (recompra)
    if (o.account_id) {
      if (!porAccount[o.account_id]) porAccount[o.account_id] = [];
      porAccount[o.account_id].push({
        orderId: oid,
        data: o.data_pedido || o.criado_em || null,
        skus: skusUnicos,
      });
    }
  }

  // ── Passo 2: pares "compraram_depois" (mesmo cliente, pedidos futuros) ──
  const paresDepois = {}; // "skuOrigem||skuDepois" → { count, somaDias }
  for (const accId of Object.keys(porAccount)) {
    const peds = porAccount[accId]
      .filter(p => p.data)
      .sort((a, b) => a.data.localeCompare(b.data));
    if (peds.length < 2) continue;

    for (let i = 0; i < peds.length - 1; i++) {
      for (let j = i + 1; j < peds.length; j++) {
        const dias = _diffDias(peds[i].data, peds[j].data);
        if (dias > DIAS_MAX_RECOMPRA) break; // pedidos ordenados: sai do inner
        if (dias <= 0) continue;
        for (const skuOrigem of peds[i].skus) {
          for (const skuDepois of peds[j].skus) {
            if (skuOrigem === skuDepois) continue; // mesma compra = reposição, ok
            const chave = skuOrigem + '||' + skuDepois;
            if (!paresDepois[chave]) paresDepois[chave] = { count: 0, somaDias: 0 };
            paresDepois[chave].count++;
            paresDepois[chave].somaDias += dias;
          }
        }
      }
    }
  }

  // ── Passo 3: constrói `produtos` com top N por SKU ────────────
  const produtos = {};
  const skus = Object.keys(vezesVendido);
  for (const sku of skus) {
    const juntos = [];
    const depois = [];

    // varre pares juntos onde `sku` aparece
    for (const chave of Object.keys(paresJuntos)) {
      const [a, b] = chave.split('|');
      if (a !== sku && b !== sku) continue;
      const outro = a === sku ? b : a;
      const vezes = paresJuntos[chave];
      if (vezes < MIN_VEZES) continue;
      juntos.push({
        sku: outro,
        descricao: descricao[outro] || '',
        vezes,
        confianca: Math.round((vezes / vezesVendido[sku]) * 1000) / 1000,
      });
    }
    juntos.sort((a, b) => b.confianca - a.confianca || b.vezes - a.vezes);

    // varre pares depois onde `sku` é ORIGEM
    for (const chave of Object.keys(paresDepois)) {
      const [origem, depoisSku] = chave.split('||');
      if (origem !== sku) continue;
      const { count, somaDias } = paresDepois[chave];
      if (count < MIN_VEZES) continue;
      depois.push({
        sku: depoisSku,
        descricao: descricao[depoisSku] || '',
        vezes: count,
        dias_medios: Math.round(somaDias / count),
        confianca: Math.round((count / vezesVendido[sku]) * 1000) / 1000,
      });
    }
    depois.sort((a, b) => b.confianca - a.confianca || b.vezes - a.vezes);

    if (!juntos.length && !depois.length) continue; // nada aprendido: pula

    produtos[sku] = {
      sku_bling: sku,
      descricao: descricao[sku] || '',
      vezes_vendido: vezesVendido[sku],
      compraram_junto: juntos.slice(0, TOP_N_POR_SKU),
      compraram_depois: depois.slice(0, TOP_N_POR_SKU),
    };
  }

  const output = {
    gerado_em: new Date().toISOString(),
    total_pedidos_analisados: idsOrder.length,
    total_clientes_analisados: Object.keys(porAccount).length,
    total_skus_analisados: skus.length,
    total_skus_com_padroes: Object.keys(produtos).length,
    total_pares_juntos: Object.keys(paresJuntos).length,
    total_pares_depois: Object.keys(paresDepois).length,
    parametros: { DIAS_MAX_RECOMPRA, TOP_N_POR_SKU, MIN_VEZES },
    duracao_ms: Date.now() - inicio,
    produtos,
  };

  await saveFile(COOCORRENCIA_PATH, JSON.stringify(output, null, 2), 'Coocorrência: ' + Object.keys(produtos).length + ' SKUs com padrões');
  _cache = output;
  _cacheTs = Date.now();

  return {
    ok: true,
    duracao_ms: output.duracao_ms,
    skus_com_padroes: Object.keys(produtos).length,
    total_pedidos: idsOrder.length,
    total_clientes: output.total_clientes_analisados,
  };
}

// ── API de consulta (usada pela Camada 3.2 — motor de sugestão) ─
async function getPara(skuBling) {
  const d = await carregar();
  return d.produtos[skuBling] || null;
}

async function estatisticas() {
  const d = await carregar();
  return {
    gerado_em: d.gerado_em || null,
    total_pedidos_analisados: d.total_pedidos_analisados || 0,
    total_clientes_analisados: d.total_clientes_analisados || 0,
    total_skus_com_padroes: d.total_skus_com_padroes || 0,
    duracao_ms: d.duracao_ms || 0,
  };
}

function _diffDias(dataA, dataB) {
  const a = new Date(dataA + 'T00:00:00Z');
  const b = new Date(dataB + 'T00:00:00Z');
  return Math.round((b - a) / (1000 * 60 * 60 * 24));
}

module.exports = { analisar, carregar, invalidarCache, getPara, estatisticas };
