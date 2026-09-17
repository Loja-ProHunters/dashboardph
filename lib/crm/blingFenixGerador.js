// lib/crm/blingFenixGerador.js
// Gerador AUTOMÁTICO do mapa Bling ⇄ Fenix via Claude API.
//
// Estratégia serverless-friendly:
//   1) `iniciar()` — extrai SKUs Fenix únicos do orders.json, salva checkpoint.
//   2) `tick()` — pega próximo lote (~10 SKUs), monta prompt com a tabela Fenix
//      completa como contexto, chama Claude, faz merge no mapa. Atualiza cp.
//   3) UI chama tick() em loop até checkpoint.pendentes == 0.
//
// Cada tick faz apenas 1 chamada Claude + 1 write no mapa + 1 write no cp.
// Cabe folgado no timeout do Vercel (~60s).

const https = require('https');
const config = require('../../config');
const { getFile, saveFile } = require('../githubStore');
const fenixCompat = require('./fenixCompat');
const blingFenixMap = require('./blingFenixMap');

const CHECKPOINT_PATH = 'crm/bling-fenix-map-checkpoint.json';
const LOTE_TAMANHO = 10; // SKUs por chamada Claude

// ── Checkpoint I/O ──────────────────────────────────────────────
async function lerCheckpoint() {
  try { return JSON.parse(await getFile(CHECKPOINT_PATH)); } catch (e) { return null; }
}
async function salvarCheckpoint(cp) {
  await saveFile(CHECKPOINT_PATH, JSON.stringify(cp, null, 2), 'Bling-Fenix map checkpoint');
}

// ── Extrai SKUs Fenix únicos de orders.json ─────────────────────
// Estratégia: agrupa por sku_bling, junta descrições vistas (Bling pode variar
// grafia entre pedidos), soma vezes vendidas e valor total. Filtra pra deixar
// só os que TÊM chance de ser Fenix (nome menciona fenix/farolete/lanterna/etc)
// mais os que já estão no mapa como fenix.
async function extrairSkusUnicos({ ordersJson = null, apenasFenix = true } = {}) {
  let orders = ordersJson;
  if (!orders) {
    try { orders = JSON.parse(await getFile('crm/orders.json')); }
    catch (e) { orders = {}; }
  }
  const porSku = {};
  for (const [oid, o] of Object.entries(orders)) {
    const dt = o.data_pedido || null;
    for (const it of (o.itens || [])) {
      const sku = String(it.sku || '').trim();
      if (!sku) continue;
      if (!porSku[sku]) porSku[sku] = {
        sku_bling: sku,
        descricoes: new Set(),
        vezes_vendido: 0,
        valor_total_vendido: 0,
        primeira_venda_em: dt,
        ultima_venda_em: dt,
      };
      porSku[sku].descricoes.add(String(it.descricao || '').trim());
      porSku[sku].vezes_vendido += Number(it.quantidade || 0);
      porSku[sku].valor_total_vendido += Number(it.valor_total_item || 0);
      if (dt && (!porSku[sku].primeira_venda_em || dt < porSku[sku].primeira_venda_em)) {
        porSku[sku].primeira_venda_em = dt;
      }
      if (dt && (!porSku[sku].ultima_venda_em || dt > porSku[sku].ultima_venda_em)) {
        porSku[sku].ultima_venda_em = dt;
      }
    }
  }
  const arr = Object.values(porSku).map(x => ({
    ...x,
    descricoes: [...x.descricoes].filter(Boolean),
    descricao_principal: [...x.descricoes].filter(Boolean).sort((a, b) => b.length - a.length)[0] || '',
  }));
  if (!apenasFenix) return arr;
  // Heurística: mantém tudo que MENCIONA Fenix OU um código conhecido da tabela
  const fx = await fenixCompat.listar();
  const modelosSet = new Set(fx.modelos.map(m => m.toUpperCase()));
  const acessSet = new Set(fx.acessorios.map(a => a.toUpperCase()));
  const rxFenix = /(fenix|arb-|alg-|aer-|alp-|aod-|aof|aot-|alr-|alb-|alw-|ald-|afh-|apb-|ab02)/i;
  const rxCodigos = new RegExp('\\b(' + [...modelosSet, ...acessSet].map(c => c.replace(/[.+*?^$()\[\]{}|\\/]/g, '\\$&')).join('|') + ')\\b', 'i');
  return arr.filter(x => {
    const s = (x.descricao_principal + ' ' + x.descricoes.join(' ')).toLowerCase();
    if (rxFenix.test(s)) return true;
    if (rxCodigos.test(s)) return true;
    return false;
  });
}

// ── Inicia geração ──────────────────────────────────────────────
async function iniciar({ iniciado_por = 'gerencia', forcarRegerarRevisados = false } = {}) {
  const skus = await extrairSkusUnicos({ apenasFenix: true });
  const mapaAtual = (await blingFenixMap.carregar({ forcar: true })).mapeamentos;
  // Pendentes = SKUs que ainda não estão no mapa OU estão sem revisão humana
  const pendentes = skus.filter(s => {
    const m = mapaAtual[s.sku_bling];
    if (!m) return true;
    if (m.revisado_por_humano && !forcarRegerarRevisados) return false;
    return true;
  }).map(s => s.sku_bling);

  const cp = {
    status: pendentes.length ? 'em_andamento' : 'concluido',
    iniciado_em: new Date().toISOString(),
    iniciado_por,
    total_skus_candidatos: skus.length,
    pendentes,
    total_original: pendentes.length,
    processados: 0,
    lotes_rodados: 0,
    ultimo_lote_em: null,
    avisos: [],
  };
  await salvarCheckpoint(cp);
  return { ok: true, checkpoint: cp, skus_candidatos: skus.length, pendentes: pendentes.length };
}

// ── Roda 1 lote (1 chamada Claude, ~10 SKUs) ────────────────────
async function tick() {
  const cp = await lerCheckpoint();
  if (!cp || cp.status !== 'em_andamento') {
    return { ok: false, motivo: 'Nenhuma geração em andamento.', checkpoint: cp };
  }
  if (!cp.pendentes || cp.pendentes.length === 0) {
    cp.status = 'concluido';
    cp.concluido_em = new Date().toISOString();
    await salvarCheckpoint(cp);
    return { ok: true, terminou: true, checkpoint: cp };
  }

  const lote = cp.pendentes.slice(0, LOTE_TAMANHO);
  const resto = cp.pendentes.slice(LOTE_TAMANHO);

  // Coleta dados dos SKUs do lote (descrição + estatísticas)
  const todosSkus = await extrairSkusUnicos({ apenasFenix: false });
  const porSku = {};
  for (const s of todosSkus) porSku[s.sku_bling] = s;
  const skusDoLote = lote.map(sku => porSku[sku]).filter(Boolean);

  // Contexto: tabela Fenix (só códigos + tipo, sem detalhes)
  const fx = await fenixCompat.listar();
  const modelosStr = Object.entries(fx.modelos_por_serie)
    .map(([serie, ms]) => `  ${serie}: ${ms.join(', ')}`).join('\n');
  const acessStr = Object.entries(fx.acessorios_por_grupo)
    .map(([g, as]) => `  ${g}: ${as.join(', ')}`).join('\n');

  const prompt = `Você é um assistente que mapeia produtos vendidos no Bling (ERP) para os códigos oficiais da tabela de compatibilidade Fenix.

# TABELA FENIX OFICIAL

## Modelos de lanternas/faroletes (por série):
${modelosStr}

## Acessórios/baterias (por grupo):
${acessStr}

# TAREFA

Para cada produto do Bling abaixo, devolva:
- \`fenix_codes\`: array com os códigos EXATOS da tabela acima (0, 1 ou mais).
  - VAZIO [] se não é Fenix (produto de outra marca — Magpul, Redding, Ruger, Vector, Foxeer, Sig Sauer, Fiocchi, etc — ou item genérico não listado).
  - MÚLTIPLOS códigos se é um KIT combo (ex: "Lanterna HT18R + ALG-18 + AER-05" → ["HT18R V2.0", "ALG-18", "AER-05"])
  - Para VARIANTES de bateria (ARB-L18-2600U, ARB-L18-3400U, ARB-L18-4000, etc), sempre mapeie para a linha canônica da tabela: "ARB-L18 18650". Idem para ARB-L14/L16/L21.
- \`categoria\`: uma de: lanterna, farolete, bateria, difusor, filtro, cone_sinalizacao, trilho, coldre, clip_cinto, anel_tatico, suporte_bike, suporte_pulso, suporte_capacete, faixa_cabeca, clip_capacete, suporte_gopro, bolsa, acionador_remoto, suporte_bateria, kit_lanterna, outro
- \`marca\`: fenix, magpul, redding, ruger, vector, foxeer, sig_sauer, fiocchi, outra, desconhecida
- \`eh_kit\`: true se vende múltiplos itens juntos
- \`confianca\`: 0.0 a 1.0 (quanto seguro está do mapeamento)
- \`motivo\`: 1 frase curta em PT explicando

Use o NOME COMPLETO do produto pra identificar (não só o código do fabricante).
Se a descrição menciona "Fenix + código X" e o código X NÃO está exatamente na tabela, use o MAIS PRÓXIMO (ex: "PD35 V2.0" mapeia para "PD35 V3.0" se não existir V2.0 na tabela — anote no motivo).

# PRODUTOS DO BLING PARA MAPEAR

${JSON.stringify(skusDoLote.map(s => ({
    sku_bling: s.sku_bling,
    descricao: s.descricao_principal,
    variantes_descricao: s.descricoes.length > 1 ? s.descricoes : undefined,
    vezes_vendido: s.vezes_vendido,
  })), null, 2)}

# FORMATO DE RESPOSTA

Responda APENAS um JSON válido (nada antes ou depois), com este formato:

{
  "propostas": [
    {
      "sku_bling": "...",
      "descricao_bling": "...",
      "fenix_codes": ["..."],
      "categoria": "...",
      "marca": "...",
      "eh_kit": false,
      "confianca": 0.95,
      "motivo": "..."
    }
  ]
}
`;

  const resposta = await chamarClaude(prompt);
  const propostas = parseRespostaClaude(resposta);

  // Enriquece com estatísticas de venda antes do merge
  for (const p of propostas) {
    const s = porSku[p.sku_bling];
    if (s) {
      p.primeira_venda_em = s.primeira_venda_em;
      p.vezes_vendido = s.vezes_vendido;
      p.valor_total_vendido = s.valor_total_vendido;
    }
  }

  const merge = await blingFenixMap.mergeLoteDaIa(propostas);

  cp.pendentes = resto;
  cp.processados += propostas.length;
  cp.lotes_rodados += 1;
  cp.ultimo_lote_em = new Date().toISOString();
  if (cp.pendentes.length === 0) {
    cp.status = 'concluido';
    cp.concluido_em = new Date().toISOString();
  }
  await salvarCheckpoint(cp);

  return {
    ok: true,
    terminou: cp.pendentes.length === 0,
    processados_neste_lote: propostas.length,
    merge,
    checkpoint: cp,
  };
}

// ── Cliente Claude API ─────────────────────────────────────────
function chamarClaude(prompt) {
  return new Promise((resolve, reject) => {
    if (!config.anthropicApiKey) return reject(new Error('ANTHROPIC_API_KEY não configurada'));
    const body = JSON.stringify({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    });
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'x-api-key': config.anthropicApiKey,
        'anthropic-version': '2023-06-01',
      },
      timeout: 55000,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (res.statusCode >= 400) return reject(new Error('Claude API ' + res.statusCode + ': ' + (j.error && j.error.message || data.slice(0, 200))));
          const texto = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
          resolve(texto);
        } catch (e) { reject(new Error('Erro parseando resposta Claude: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout chamando Claude')); });
    req.write(body);
    req.end();
  });
}

function parseRespostaClaude(texto) {
  // Claude às vezes envelopa em ```json ... ``` — remove
  let s = texto.trim();
  const m = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (m) s = m[1].trim();
  try {
    const j = JSON.parse(s);
    return Array.isArray(j.propostas) ? j.propostas : [];
  } catch (e) {
    // fallback: tenta achar o primeiro { ... } bruto
    const first = s.indexOf('{');
    const last = s.lastIndexOf('}');
    if (first >= 0 && last > first) {
      try { return JSON.parse(s.slice(first, last + 1)).propostas || []; }
      catch (e2) { return []; }
    }
    return [];
  }
}

module.exports = { iniciar, tick, lerCheckpoint, extrairSkusUnicos, LOTE_TAMANHO };
