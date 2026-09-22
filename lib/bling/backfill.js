// lib/bling/backfill.js
// v3 DEFINITIVO — proteção total contra perda de dados.
//
// Mudanças críticas em relação à v2:
//   1) MERGE seguro: NUNCA sobrescreve orders/accounts com um conjunto menor
//      que o atual. Isso evita o bug que apagou 1388 pedidos.
//   2) Delay 400ms + retry 429/503 em cada puxarDetalhePedido pra respeitar
//      rate limit do Bling.
//   3) `verificarSaude()`: compara CRM ↔ Bling por mês, retorna diff.
//   4) Reset de checkpoint mesmo se em andamento (pra destravar).
//
// Regra de ouro: se algo der errado no meio, NUNCA salvamos com menos dados
// que tínhamos. Preferimos preservar histórico a fazer sync.

const { puxarTodaListaPedidos, puxarDetalhePedido, processarPedido } = require('./sync');
const crmStore = require('../crm/store');
const { getFile, saveFile } = require('../githubStore');

const CHECKPOINT_PATH_LEGACY = 'crm/bling-backfill.json'; // compat
const LOG_PATH        = 'crm/bling-sync-log.json';
const STATE_PATH      = 'crm/bling-sync-state.json';
const LOTE_TAMANHO    = 20;
const DELAY_MS        = 400;
const RETRY_MAX       = 3;

const _sleep = ms => new Promise(r => setTimeout(r, ms));

// Path do checkpoint POR CONTA (novo). Se contaId omitido, usa 'prohunters'
// e cai no arquivo legado pra manter compat.
function _checkpointPath(contaId) {
  const cid = contaId || 'prohunters';
  if (cid === 'prohunters') return CHECKPOINT_PATH_LEGACY;
  return 'crm/bling-backfill-' + cid + '.json';
}

// ── Checkpoint I/O (por conta) ───────────────────────────────────
async function lerCheckpoint(contaId) {
  try { return JSON.parse(await getFile(_checkpointPath(contaId))); } catch (e) { return null; }
}
async function salvarCheckpoint(cp, contaId) {
  const cid = contaId || (cp && cp.contaId) || 'prohunters';
  await saveFile(_checkpointPath(cid), JSON.stringify(cp, null, 2), 'Bling backfill checkpoint (' + cid + ')');
}
async function apagarCheckpoint(contaId) {
  const cid = contaId || 'prohunters';
  await saveFile(_checkpointPath(cid), JSON.stringify({
    status: 'concluido',
    concluido_em: new Date().toISOString(),
    contaId: cid,
  }, null, 2), 'Bling backfill concluído (' + cid + ')');
}

// ── State file (last known counts) — usado pra proteção anti-perda ─
async function lerState() {
  try { return JSON.parse(await getFile(STATE_PATH)); } catch (e) { return { orders_count: 0, accounts_count: 0 }; }
}
async function salvarState(state) {
  await saveFile(STATE_PATH, JSON.stringify(state, null, 2), 'Bling sync state');
}

// ── Log rolante ──────────────────────────────────────────────────
async function apendarLog(entrada) {
  let log = [];
  try { log = JSON.parse(await getFile(LOG_PATH)); if (!Array.isArray(log)) log = []; } catch (e) {}
  log.unshift({ ts: new Date().toISOString(), ...entrada });
  log = log.slice(0, 200); // últimos 200
  await saveFile(LOG_PATH, JSON.stringify(log, null, 2), 'Bling sync log');
}

// ── Carrega coleção com retry — protege contra falha transitória do GitHub ─
// Se state diz que deveria ter N > 100 mas veio 0, tenta de novo até 3x.
async function _getCollectionSafe(colName, expectedMin = 0) {
  for (let i = 0; i < 3; i++) {
    const c = await crmStore.getCollection(colName);
    const count = Object.keys(c || {}).length;
    if (count > 0 || expectedMin === 0) return c;
    // Vazio mas esperava dados → retry após backoff
    if (i < 2) await _sleep(2000 * (i + 1)); // 2s, 4s
  }
  // Última tentativa
  return await crmStore.getCollection(colName);
}

// ── Puxa detalhe com retry+delay (protege contra rate limit) ─────
async function _puxarDetalheSafe(id, stats, contaId) {
  let tentativas = 0;
  while (tentativas < RETRY_MAX) {
    tentativas++;
    try {
      const d = await puxarDetalhePedido(id, contaId);
      return d;
    } catch (e) {
      const status = e.status || 0;
      if (status === 429 || status === 503) {
        if (tentativas >= RETRY_MAX) { if (stats) stats.rate_limit_perdidos++; throw e; }
        await _sleep(1000 * Math.pow(2, tentativas - 1));
        continue;
      }
      if (stats) stats.erros_outros++;
      throw e;
    }
  }
}

// ── SALVAMENTO DEFENSIVO ─────────────────────────────────────────
// Regra: NUNCA salva se o snapshot tem MENOS itens que o snapshot original
// (que veio do CRM antes do processamento). Isso evita perda de dados por
// bug em getCollection (ex: race, timeout devolvendo {}).
async function _salvarDefensivo(colName, snapshotFinal, countInicial, mensagem, avisos) {
  const countFinal = Object.keys(snapshotFinal || {}).length;
  if (countFinal < countInicial) {
    const msg = 'ABORT: ' + colName + ' iria perder dados (' + countInicial + ' → ' + countFinal + '). Save cancelado.';
    if (avisos) avisos.push(msg);
    await apendarLog({ tipo: 'save_abortado', colecao: colName, count_antes: countInicial, count_depois: countFinal });
    throw new Error(msg);
  }
  await crmStore.saveCollection(colName, snapshotFinal, mensagem);
}

// ── Iniciar backfill: puxa lista completa de IDs do range ──────────
async function iniciar({ meses = 12, iniciado_por = 'gerencia', forcar = false, contaId } = {}) {
  const cid = contaId || 'prohunters';
  const atual = await lerCheckpoint(cid);
  if (!forcar && atual && atual.status === 'em_andamento') {
    return { ok: false, motivo: 'Já existe backfill em andamento pra "' + cid + '". Passe forcar:true pra reiniciar.', checkpoint: atual };
  }

  const ate = new Date();
  const desde = new Date();
  desde.setMonth(desde.getMonth() - meses);
  const desdeStr = desde.toISOString().slice(0, 10);
  const ateStr = ate.toISOString().slice(0, 10);

  const { pedidos, truncado } = await puxarTodaListaPedidos({ desde: desdeStr, ate: ateStr, contaId: cid });
  const ids = pedidos.map(p => String(p.id)).filter(Boolean);

  const checkpoint = {
    contaId: cid,
    status: ids.length ? 'em_andamento' : 'concluido',
    iniciado_em: new Date().toISOString(),
    iniciado_por,
    desde: desdeStr,
    ate: ateStr,
    meses,
    ids_pendentes: ids,
    total_original: ids.length,
    processados: 0,
    accounts_criadas: 0,
    orders_criadas: 0,
    orders_atualizadas: 0,
    ja_existentes: 0,
    rate_limit_perdidos: 0,
    erros_outros: 0,
    avisos: [],
    truncado_paginacao: !!truncado,
  };
  await salvarCheckpoint(checkpoint, cid);
  await apendarLog({ tipo: 'backfill_iniciado', contaId: cid, meses, total_pedidos: ids.length, iniciado_por });
  return { ok: true, checkpoint };
}

// ── Processa próximo lote — DEFENSIVO ────────────────────────────
async function continuar({ usersJson, ownerFallback = 'gerencia', contaId } = {}) {
  const cid = contaId || 'prohunters';
  const cp = await lerCheckpoint(cid);
  if (!cp || cp.status !== 'em_andamento') {
    return { ok: false, motivo: 'Nenhum backfill em andamento pra "' + cid + '". Chame iniciar() primeiro.', checkpoint: cp };
  }
  if (!cp.ids_pendentes || cp.ids_pendentes.length === 0) {
    cp.status = 'concluido';
    cp.concluido_em = new Date().toISOString();
    await salvarCheckpoint(cp, cid);
    return { ok: true, terminou: true, checkpoint: cp, processados_neste_lote: 0 };
  }

  const lote = cp.ids_pendentes.slice(0, LOTE_TAMANHO);
  const resto = cp.ids_pendentes.slice(LOTE_TAMANHO);

  // Carrega snapshot atual das coleções COM RETRY (protege contra falha transitória)
  const state = await lerState();
  const accountsAtual = await _getCollectionSafe('accounts', state.accounts_count || 0);
  const ordersAtual   = await _getCollectionSafe('orders',   state.orders_count   || 0);
  const countAccountsAntes = Object.keys(accountsAtual).length;
  const countOrdersAntes   = Object.keys(ordersAtual).length;

  // GUARDRAIL final: se DEPOIS de 3 retries ainda veio vazio quando deveria ter dados, ABORTA
  if (state.orders_count > 100 && countOrdersAntes === 0) {
    const msg = 'ABORT: getCollection(orders) devolveu 0 mesmo após retry, mas state diz ' + state.orders_count + '. Tenta de novo em alguns segundos.';
    await apendarLog({ tipo: 'guardrail_getcollection', msg });
    return { ok: false, motivo: msg, checkpoint: cp };
  }

  const index_cpf = {};
  for (const [id, a] of Object.entries(accountsAtual)) if (a && a.cpf_cnpj) index_cpf[a.cpf_cnpj] = id;
  // Índice bling composto por conta (multi-Bling): "contaId:blingId" e legado "blingId"
  const index_bling = {};
  for (const [id, o] of Object.entries(ordersAtual)) {
    if (!o || !o.bling_pedido_id) continue;
    const origem = o.bling_conta_origem || 'prohunters';
    index_bling[origem + ':' + o.bling_pedido_id] = id;
    // Legado (compat com queries antigas)
    if (!index_bling[String(o.bling_pedido_id)]) index_bling[String(o.bling_pedido_id)] = id;
  }

  const snapshot = {
    accounts: { ...accountsAtual },
    orders:   { ...ordersAtual },
    activities: {},
    index_cpf,
    index_bling,
  };

  let processados = 0, criouAccounts = 0, criouOrders = 0, jaExistentes = 0;
  const stats = { rate_limit_perdidos: 0, erros_outros: 0 };
  const avisosLote = [];
  const idsFalhados = [];

  for (let i = 0; i < lote.length; i++) {
    const id = lote[i];
    try {
      const detalhe = await _puxarDetalheSafe(id, stats, cid);
      // Se já existe no snapshot pra esta conta, considera "já existente"
      if (snapshot.index_bling[cid + ':' + String(id)]) {
        jaExistentes++;
        processados++;
      } else {
        const r = await processarPedido(detalhe, snapshot, { usersJson, ownerFallback, contaId: cid });
        processados++;
        if (r.criouAccount) criouAccounts++;
        if (r.criouOrder) criouOrders++;
        if (r.avisos && r.avisos.length) avisosLote.push(...r.avisos);
      }
    } catch (e) {
      idsFalhados.push(id);
      avisosLote.push('pedido ' + id + ' [' + cid + ']: ' + (e.message || String(e)).slice(0, 150));
    }
    if (i < lote.length - 1) await _sleep(DELAY_MS);
  }

  // SAVE DEFENSIVO — nunca salva com menos dados que tinha antes
  try {
    await _salvarDefensivo('accounts', snapshot.accounts, countAccountsAntes,
      'Bling backfill [' + cid + ']: +' + criouAccounts + ' accounts (lote de ' + lote.length + ' pedidos)', avisosLote);
    await _salvarDefensivo('orders', snapshot.orders, countOrdersAntes,
      'Bling backfill [' + cid + ']: +' + criouOrders + ' orders (lote de ' + lote.length + ' pedidos)', avisosLote);
  } catch (e) {
    return { ok: false, motivo: e.message, checkpoint: cp };
  }

  // Camada 4 — automação upsell nos orders novos deste lote
  if (snapshot._pendingUpsells && snapshot._pendingUpsells.length) {
    try {
      const { processarOrderNovo } = require('../crm/automacaoUpsell');
      for (const { orderId, vendedor } of snapshot._pendingUpsells) {
        try { await processarOrderNovo(orderId, vendedor); }
        catch (e) { avisosLote.push('upsell ' + orderId + ': ' + (e.message || String(e)).slice(0, 100)); }
      }
    } catch (e) { avisosLote.push('automacaoUpsell falhou: ' + e.message); }
  }

  // Atualiza checkpoint com estatísticas
  cp.ids_pendentes = resto.concat(idsFalhados);
  cp.processados = (cp.processados || 0) + processados;
  cp.accounts_criadas = (cp.accounts_criadas || 0) + criouAccounts;
  cp.orders_criadas = (cp.orders_criadas || 0) + criouOrders;
  cp.ja_existentes = (cp.ja_existentes || 0) + jaExistentes;
  cp.rate_limit_perdidos = (cp.rate_limit_perdidos || 0) + stats.rate_limit_perdidos;
  cp.erros_outros = (cp.erros_outros || 0) + stats.erros_outros;
  cp.avisos = (cp.avisos || []).concat(avisosLote).slice(-200);
  cp.ultimo_lote_em = new Date().toISOString();

  // Atualiza state com contagens novas
  await salvarState({
    orders_count: Object.keys(snapshot.orders).length,
    accounts_count: Object.keys(snapshot.accounts).length,
    ultimo_backfill_tick_em: new Date().toISOString(),
  });

  if (cp.ids_pendentes.length === 0) {
    cp.status = 'concluido';
    cp.concluido_em = new Date().toISOString();
    await apendarLog({
      tipo: 'backfill_concluido',
      contaId: cid,
      pedidos_processados: cp.processados,
      accounts_criadas: cp.accounts_criadas,
      orders_criadas: cp.orders_criadas,
      ja_existentes: cp.ja_existentes,
      rate_limit_perdidos: cp.rate_limit_perdidos,
    });
  }
  await salvarCheckpoint(cp, cid);

  return {
    ok: true,
    terminou: cp.ids_pendentes.length === 0,
    processados_neste_lote: processados,
    novos_orders_neste_lote: criouOrders,
    ja_existentes_neste_lote: jaExistentes,
    avisos_neste_lote: avisosLote.length,
    checkpoint: cp,
  };
}

// ── Sync incremental DEFENSIVO — por conta ───────────────────────
async function syncIncremental({ dias = 1, usersJson, ownerFallback = 'gerencia', contaId } = {}) {
  const cid = contaId || 'prohunters';
  const ate = new Date();
  const desde = new Date();
  desde.setDate(desde.getDate() - dias);
  const desdeStr = desde.toISOString().slice(0, 10);
  const ateStr = ate.toISOString().slice(0, 10);

  const { pedidos } = await puxarTodaListaPedidos({ desde: desdeStr, ate: ateStr, limitePaginas: 30, contaId: cid });

  const state = await lerState();
  const accountsAtual = await _getCollectionSafe('accounts', state.accounts_count || 0);
  const ordersAtual   = await _getCollectionSafe('orders',   state.orders_count   || 0);
  const countAccountsAntes = Object.keys(accountsAtual).length;
  const countOrdersAntes   = Object.keys(ordersAtual).length;

  if (state.orders_count > 100 && countOrdersAntes === 0) {
    const msg = 'syncIncremental ABORT: getCollection(orders) veio 0 após retry mas state=' + state.orders_count;
    await apendarLog({ tipo: 'guardrail_incremental', msg, contaId: cid });
    return { ok: false, motivo: msg };
  }

  const index_cpf = {};
  for (const [id, a] of Object.entries(accountsAtual)) if (a && a.cpf_cnpj) index_cpf[a.cpf_cnpj] = id;
  const index_bling = {};
  for (const [id, o] of Object.entries(ordersAtual)) {
    if (!o || !o.bling_pedido_id) continue;
    const origem = o.bling_conta_origem || 'prohunters';
    index_bling[origem + ':' + o.bling_pedido_id] = id;
    if (!index_bling[String(o.bling_pedido_id)]) index_bling[String(o.bling_pedido_id)] = id;
  }

  const snapshot = { accounts: { ...accountsAtual }, orders: { ...ordersAtual }, activities: {}, index_cpf, index_bling };

  let novos = 0, jaExistentes = 0, criouAccounts = 0;
  const stats = { rate_limit_perdidos: 0, erros_outros: 0 };
  const avisos = [];

  for (let i = 0; i < pedidos.length; i++) {
    const resumo = pedidos[i];
    try {
      if (index_bling[cid + ':' + String(resumo.id)]) { jaExistentes++; continue; }
      const detalhe = await _puxarDetalheSafe(resumo.id, stats, cid);
      const r = await processarPedido(detalhe, snapshot, { usersJson, ownerFallback, contaId: cid });
      if (r.criouOrder) novos++;
      if (r.criouAccount) criouAccounts++;
      if (r.avisos && r.avisos.length) avisos.push(...r.avisos);
    } catch (e) {
      avisos.push('pedido ' + resumo.id + ' [' + cid + ']: ' + (e.message || String(e)).slice(0, 150));
    }
    if (i < pedidos.length - 1) await _sleep(DELAY_MS);
  }

  if (novos > 0 || criouAccounts > 0) {
    try {
      await _salvarDefensivo('accounts', snapshot.accounts, countAccountsAntes,
        'Bling sync incremental [' + cid + ']: +' + criouAccounts + ' accounts', avisos);
      await _salvarDefensivo('orders', snapshot.orders, countOrdersAntes,
        'Bling sync incremental [' + cid + ']: +' + novos + ' orders', avisos);
    } catch (e) {
      await apendarLog({ tipo: 'incremental_save_abortado', msg: e.message, contaId: cid });
      return { ok: false, motivo: e.message };
    }
  }

  if (snapshot._pendingUpsells && snapshot._pendingUpsells.length) {
    try {
      const { processarOrderNovo } = require('../crm/automacaoUpsell');
      for (const { orderId, vendedor } of snapshot._pendingUpsells) {
        try { await processarOrderNovo(orderId, vendedor); }
        catch (e) { avisos.push('upsell ' + orderId + ': ' + (e.message || String(e)).slice(0, 100)); }
      }
    } catch (e) { avisos.push('automacaoUpsell falhou: ' + e.message); }
  }

  await salvarState({
    orders_count: Object.keys(snapshot.orders).length,
    accounts_count: Object.keys(snapshot.accounts).length,
    ultimo_sync_em: new Date().toISOString(),
  });

  await apendarLog({
    tipo: 'sync_incremental',
    contaId: cid,
    dias,
    pedidos_vistos: pedidos.length,
    novos_orders: novos,
    novas_accounts: criouAccounts,
    ja_existentes: jaExistentes,
    rate_limit_perdidos: stats.rate_limit_perdidos,
    avisos: avisos.length,
  });

  return {
    ok: true,
    contaId: cid,
    pedidos_vistos: pedidos.length,
    novos_orders: novos,
    novas_accounts: criouAccounts,
    ja_existentes: jaExistentes,
    rate_limit_perdidos: stats.rate_limit_perdidos,
    avisos_count: avisos.length,
  };
}

// ── Sync incremental pra TODAS as contas ativas ─────────────────
async function syncIncrementalTodas({ dias = 1, usersJson, ownerFallback = 'gerencia' } = {}) {
  const contas = require('../../config').blingContas || {};
  const resultados = [];
  for (const [cid, cfg] of Object.entries(contas)) {
    if (!cfg.ativa) { resultados.push({ contaId: cid, pulou: true, motivo: 'conta não configurada' }); continue; }
    try {
      const r = await syncIncremental({ dias, usersJson, ownerFallback, contaId: cid });
      resultados.push({ contaId: cid, ...r });
    } catch (e) {
      resultados.push({ contaId: cid, ok: false, erro: e.message });
    }
  }
  return { ok: true, resultados };
}

// ── VERIFICAR SAÚDE — compara CRM ↔ Bling por mês, POR CONTA ─────
// Compara só os orders do CRM que vieram DAQUELA conta.
async function verificarSaude({ meses = 12, contaId } = {}) {
  const cid = contaId || 'prohunters';
  const ate = new Date();
  const desde = new Date();
  desde.setMonth(desde.getMonth() - meses);
  const desdeStr = desde.toISOString().slice(0, 10);
  const ateStr = ate.toISOString().slice(0, 10);

  const { pedidos: blingList } = await puxarTodaListaPedidos({ desde: desdeStr, ate: ateStr, contaId: cid });
  const blingPorMes = {};
  for (const p of blingList) {
    const d = String(p.data || p.dataEmissao || '').slice(0, 7);
    if (!d) continue;
    blingPorMes[d] = (blingPorMes[d] || 0) + 1;
  }

  const ordersAtual = await crmStore.getCollection('orders');
  const crmPorMes = {};
  let crmTotal = 0;
  for (const o of Object.values(ordersAtual)) {
    // Filtra por conta origem (orders antigos sem tag caem em 'prohunters')
    const origem = o.bling_conta_origem || 'prohunters';
    if (origem !== cid) continue;
    const d = String(o.data_pedido || '').slice(0, 7);
    if (!d || d < desdeStr.slice(0,7)) continue;
    crmPorMes[d] = (crmPorMes[d] || 0) + 1;
    crmTotal++;
  }

  // Diff
  const buracos = [];
  const todosMeses = new Set([...Object.keys(blingPorMes), ...Object.keys(crmPorMes)]);
  for (const mes of [...todosMeses].sort()) {
    const b = blingPorMes[mes] || 0;
    const c = crmPorMes[mes] || 0;
    const diff = b - c;
    if (b > 0 && (diff > 5 || diff / b > 0.05)) {
      buracos.push({ mes, crm: c, bling: b, faltando: diff });
    }
  }

  return {
    contaId: cid,
    total_bling: blingList.length,
    total_crm: crmTotal,
    diff_total: blingList.length - crmTotal,
    bling_por_mes: blingPorMes,
    crm_por_mes: crmPorMes,
    meses_com_buraco: buracos,
  };
}

// Saúde de TODAS as contas de uma vez
async function verificarSaudeTodas({ meses = 12 } = {}) {
  const contas = require('../../config').blingContas || {};
  const out = [];
  for (const [cid, cfg] of Object.entries(contas)) {
    if (!cfg.ativa) { out.push({ contaId: cid, pulou: true, motivo: 'conta não configurada' }); continue; }
    try {
      const s = await verificarSaude({ meses, contaId: cid });
      out.push({ nome: cfg.nome, ...s });
    } catch (e) {
      out.push({ contaId: cid, nome: cfg.nome, ok: false, erro: e.message });
    }
  }
  return { ok: true, resultados: out };
}

module.exports = {
  iniciar, continuar,
  syncIncremental, syncIncrementalTodas,
  lerCheckpoint, apagarCheckpoint, apendarLog,
  verificarSaude, verificarSaudeTodas,
  LOTE_TAMANHO,
};
 
