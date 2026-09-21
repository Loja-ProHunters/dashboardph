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

const CHECKPOINT_PATH = 'crm/bling-backfill.json';
const LOG_PATH        = 'crm/bling-sync-log.json';
const STATE_PATH      = 'crm/bling-sync-state.json';
const LOTE_TAMANHO    = 20;
const DELAY_MS        = 400;   // 2.5 req/s — dentro do limite do Bling
const RETRY_MAX       = 3;

const _sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Checkpoint I/O ───────────────────────────────────────────────
async function lerCheckpoint() {
  try { return JSON.parse(await getFile(CHECKPOINT_PATH)); } catch (e) { return null; }
}
async function salvarCheckpoint(cp) {
  await saveFile(CHECKPOINT_PATH, JSON.stringify(cp, null, 2), 'Bling backfill checkpoint');
}
async function apagarCheckpoint() {
  await saveFile(CHECKPOINT_PATH, JSON.stringify({
    status: 'concluido',
    concluido_em: new Date().toISOString(),
  }, null, 2), 'Bling backfill concluído');
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

// ── Puxa detalhe com retry+delay (protege contra rate limit) ─────
async function _puxarDetalheSafe(id, stats) {
  let tentativas = 0;
  while (tentativas < RETRY_MAX) {
    tentativas++;
    try {
      const d = await puxarDetalhePedido(id);
      return d;
    } catch (e) {
      const status = e.status || 0;
      if (status === 429 || status === 503) {
        if (tentativas >= RETRY_MAX) { if (stats) stats.rate_limit_perdidos++; throw e; }
        await _sleep(1000 * Math.pow(2, tentativas - 1)); // 1s, 2s, 4s
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
async function iniciar({ meses = 12, iniciado_por = 'gerencia', forcar = false } = {}) {
  const atual = await lerCheckpoint();
  if (!forcar && atual && atual.status === 'em_andamento') {
    return { ok: false, motivo: 'Já existe backfill em andamento. Passe forcar:true pra reiniciar.', checkpoint: atual };
  }

  const ate = new Date();
  const desde = new Date();
  desde.setMonth(desde.getMonth() - meses);
  const desdeStr = desde.toISOString().slice(0, 10);
  const ateStr = ate.toISOString().slice(0, 10);

  const { pedidos, truncado } = await puxarTodaListaPedidos({ desde: desdeStr, ate: ateStr });
  const ids = pedidos.map(p => String(p.id)).filter(Boolean);

  const checkpoint = {
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
  await salvarCheckpoint(checkpoint);
  await apendarLog({ tipo: 'backfill_iniciado', meses, total_pedidos: ids.length, iniciado_por });
  return { ok: true, checkpoint };
}

// ── Processa próximo lote — DEFENSIVO ────────────────────────────
async function continuar({ usersJson, ownerFallback = 'gerencia' } = {}) {
  const cp = await lerCheckpoint();
  if (!cp || cp.status !== 'em_andamento') {
    return { ok: false, motivo: 'Nenhum backfill em andamento. Chame iniciar() primeiro.', checkpoint: cp };
  }
  if (!cp.ids_pendentes || cp.ids_pendentes.length === 0) {
    cp.status = 'concluido';
    cp.concluido_em = new Date().toISOString();
    await salvarCheckpoint(cp);
    return { ok: true, terminou: true, checkpoint: cp, processados_neste_lote: 0 };
  }

  const lote = cp.ids_pendentes.slice(0, LOTE_TAMANHO);
  const resto = cp.ids_pendentes.slice(LOTE_TAMANHO);

  // Carrega snapshot atual das coleções (fonte de verdade pré-processamento)
  const accountsAtual = await crmStore.getCollection('accounts');
  const ordersAtual   = await crmStore.getCollection('orders');
  const countAccountsAntes = Object.keys(accountsAtual).length;
  const countOrdersAntes   = Object.keys(ordersAtual).length;

  // GUARDRAIL: se getCollection devolveu vazio mas state diz que deveria ter dados, ABORTA
  const state = await lerState();
  if (state.orders_count > 100 && countOrdersAntes === 0) {
    const msg = 'ABORT: getCollection(orders) devolveu 0 mas state diz ' + state.orders_count + '. Nada foi processado.';
    await apendarLog({ tipo: 'guardrail_getcollection', msg });
    return { ok: false, motivo: msg, checkpoint: cp };
  }

  const index_cpf = {};
  for (const [id, a] of Object.entries(accountsAtual)) if (a && a.cpf_cnpj) index_cpf[a.cpf_cnpj] = id;
  const index_bling = {};
  for (const [id, o] of Object.entries(ordersAtual)) if (o && o.bling_pedido_id) index_bling[String(o.bling_pedido_id)] = id;

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
      const detalhe = await _puxarDetalheSafe(id, stats);
      // Se já existe no snapshot pelo bling_id, considera "já existente" (não reprocessa)
      if (snapshot.index_bling[String(id)]) {
        jaExistentes++;
        processados++;
      } else {
        const r = await processarPedido(detalhe, snapshot, { usersJson, ownerFallback });
        processados++;
        if (r.criouAccount) criouAccounts++;
        if (r.criouOrder) criouOrders++;
        if (r.avisos && r.avisos.length) avisosLote.push(...r.avisos);
      }
    } catch (e) {
      idsFalhados.push(id);
      avisosLote.push('pedido ' + id + ': ' + (e.message || String(e)).slice(0, 150));
    }
    if (i < lote.length - 1) await _sleep(DELAY_MS);
  }

  // SAVE DEFENSIVO — nunca salva com menos dados que tinha antes
  try {
    await _salvarDefensivo('accounts', snapshot.accounts, countAccountsAntes,
      'Bling backfill: +' + criouAccounts + ' accounts (lote de ' + lote.length + ' pedidos)', avisosLote);
    await _salvarDefensivo('orders', snapshot.orders, countOrdersAntes,
      'Bling backfill: +' + criouOrders + ' orders (lote de ' + lote.length + ' pedidos)', avisosLote);
  } catch (e) {
    // Não altera checkpoint, tenta de novo no próximo tick
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
      pedidos_processados: cp.processados,
      accounts_criadas: cp.accounts_criadas,
      orders_criadas: cp.orders_criadas,
      ja_existentes: cp.ja_existentes,
      rate_limit_perdidos: cp.rate_limit_perdidos,
    });
  }
  await salvarCheckpoint(cp);

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

// ── Sync incremental DEFENSIVO ────────────────────────────────────
// Roda a cada X horas. Puxa últimos N dias, faz MERGE (nunca replace).
async function syncIncremental({ dias = 1, usersJson, ownerFallback = 'gerencia' } = {}) {
  const ate = new Date();
  const desde = new Date();
  desde.setDate(desde.getDate() - dias);
  const desdeStr = desde.toISOString().slice(0, 10);
  const ateStr = ate.toISOString().slice(0, 10);

  const { pedidos } = await puxarTodaListaPedidos({ desde: desdeStr, ate: ateStr, limitePaginas: 30 });

  const accountsAtual = await crmStore.getCollection('accounts');
  const ordersAtual   = await crmStore.getCollection('orders');
  const countAccountsAntes = Object.keys(accountsAtual).length;
  const countOrdersAntes   = Object.keys(ordersAtual).length;

  // GUARDRAIL: se veio vazio mas state diz que deveria ter dados, ABORTA
  const state = await lerState();
  if (state.orders_count > 100 && countOrdersAntes === 0) {
    const msg = 'syncIncremental ABORT: getCollection(orders) veio 0 mas state=' + state.orders_count;
    await apendarLog({ tipo: 'guardrail_incremental', msg });
    return { ok: false, motivo: msg };
  }

  const index_cpf = {};
  for (const [id, a] of Object.entries(accountsAtual)) if (a && a.cpf_cnpj) index_cpf[a.cpf_cnpj] = id;
  const index_bling = {};
  for (const [id, o] of Object.entries(ordersAtual)) if (o && o.bling_pedido_id) index_bling[String(o.bling_pedido_id)] = id;

  const snapshot = { accounts: { ...accountsAtual }, orders: { ...ordersAtual }, activities: {}, index_cpf, index_bling };

  let novos = 0, jaExistentes = 0, criouAccounts = 0;
  const stats = { rate_limit_perdidos: 0, erros_outros: 0 };
  const avisos = [];

  for (let i = 0; i < pedidos.length; i++) {
    const resumo = pedidos[i];
    try {
      if (index_bling[String(resumo.id)]) { jaExistentes++; continue; }
      const detalhe = await _puxarDetalheSafe(resumo.id, stats);
      const r = await processarPedido(detalhe, snapshot, { usersJson, ownerFallback });
      if (r.criouOrder) novos++;
      if (r.criouAccount) criouAccounts++;
      if (r.avisos && r.avisos.length) avisos.push(...r.avisos);
    } catch (e) {
      avisos.push('pedido ' + resumo.id + ': ' + (e.message || String(e)).slice(0, 150));
    }
    if (i < pedidos.length - 1) await _sleep(DELAY_MS);
  }

  // SAVE DEFENSIVO
  if (novos > 0 || criouAccounts > 0) {
    try {
      await _salvarDefensivo('accounts', snapshot.accounts, countAccountsAntes,
        'Bling sync incremental: +' + criouAccounts + ' accounts', avisos);
      await _salvarDefensivo('orders', snapshot.orders, countOrdersAntes,
        'Bling sync incremental: +' + novos + ' orders', avisos);
    } catch (e) {
      await apendarLog({ tipo: 'incremental_save_abortado', msg: e.message });
      return { ok: false, motivo: e.message };
    }
  }

  // Roda upsells pendentes
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
    pedidos_vistos: pedidos.length,
    novos_orders: novos,
    novas_accounts: criouAccounts,
    ja_existentes: jaExistentes,
    rate_limit_perdidos: stats.rate_limit_perdidos,
    avisos_count: avisos.length,
  };
}

// ── VERIFICAR SAÚDE — compara CRM ↔ Bling por mês ────────────────
// Retorna { crm_por_mes, bling_por_mes, meses_com_buraco: [{mes, crm, bling, diff}] }
async function verificarSaude({ meses = 12 } = {}) {
  const ate = new Date();
  const desde = new Date();
  desde.setMonth(desde.getMonth() - meses);
  const desdeStr = desde.toISOString().slice(0, 10);
  const ateStr = ate.toISOString().slice(0, 10);

  // Bling — lista completa do período
  const { pedidos: blingList } = await puxarTodaListaPedidos({ desde: desdeStr, ate: ateStr });
  const blingPorMes = {};
  for (const p of blingList) {
    const d = String(p.data || p.dataEmissao || '').slice(0, 7);
    if (!d) continue;
    blingPorMes[d] = (blingPorMes[d] || 0) + 1;
  }

  // CRM — orders atuais
  const ordersAtual = await crmStore.getCollection('orders');
  const crmPorMes = {};
  for (const o of Object.values(ordersAtual)) {
    const d = String(o.data_pedido || '').slice(0, 7);
    if (!d || d < desdeStr.slice(0,7)) continue;
    crmPorMes[d] = (crmPorMes[d] || 0) + 1;
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
    total_bling: blingList.length,
    total_crm: Object.values(ordersAtual).length,
    diff_total: blingList.length - Object.values(ordersAtual).length,
    bling_por_mes: blingPorMes,
    crm_por_mes: crmPorMes,
    meses_com_buraco: buracos,
  };
}

module.exports = {
  iniciar, continuar, syncIncremental,
  lerCheckpoint, apagarCheckpoint, apendarLog,
  verificarSaude,
  LOTE_TAMANHO,
};
