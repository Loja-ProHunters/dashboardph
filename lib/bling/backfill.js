// lib/bling/backfill.js
// Backfill de histórico do Bling com CHECKPOINT.
//
// Por que checkpoint: Vercel serverless tem timeout (60-300s). Pra backfill
// de milhares de pedidos, cada detalhe é uma request HTTP — não cabe numa
// invocação só. Solução:
//   1) iniciar(meses) → puxa a LISTA COMPLETA de IDs no range (rápido, 30-40
//      requests p/ 3000 pedidos), salva o checkpoint. NÃO baixa detalhes.
//   2) continuar() → processa próximo LOTE (ex: 20-30 pedidos), busca
//      detalhes de cada, popula snapshot em memória, salva coleções UMA vez
//      no fim do lote e atualiza checkpoint.
//   3) UI chama continuar() em loop até checkpoint.pendentes == 0. Se um
//      lote der timeout, o próximo continuar() retoma do último salvo.
//
// Regra crítica: cada continuar() faz NO MÁXIMO 3 commits no GitHub (accounts,
// orders, checkpoint). Muito melhor que 1 commit por pedido.

const { puxarTodaListaPedidos, puxarDetalhePedido, processarPedido } = require('./sync');
const crmStore = require('../crm/store');
const { getFile, saveFile } = require('../githubStore');

const CHECKPOINT_PATH = 'crm/bling-backfill.json';
const LOG_PATH = 'crm/bling-sync-log.json';
const LOTE_TAMANHO = 25; // pedidos por invocação de continuar()

// ── Checkpoint I/O ───────────────────────────────────────────────
async function lerCheckpoint() {
  try {
    const raw = await getFile(CHECKPOINT_PATH);
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
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

// ── Log rolante ──────────────────────────────────────────────────
async function apendarLog(entrada) {
  let log = [];
  try { log = JSON.parse(await getFile(LOG_PATH)); if (!Array.isArray(log)) log = []; } catch (e) {}
  log.unshift({ ts: new Date().toISOString(), ...entrada });
  log = log.slice(0, 100); // últimos 100
  await saveFile(LOG_PATH, JSON.stringify(log, null, 2), 'Bling sync log');
}

// ── Iniciar backfill: puxa lista completa de IDs do range e salva ──
async function iniciar({ meses = 12, iniciado_por = 'gerencia' } = {}) {
  // Se já existe backfill em andamento, avisa (não sobrescreve sem confirmação)
  const atual = await lerCheckpoint();
  if (atual && atual.status === 'em_andamento') {
    return { ok: false, motivo: 'Já existe backfill em andamento. Continue ou cancele antes de iniciar outro.', checkpoint: atual };
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
    avisos: [],
    truncado_paginacao: !!truncado,
  };
  await salvarCheckpoint(checkpoint);
  await apendarLog({ tipo: 'backfill_iniciado', meses, total_pedidos: ids.length, iniciado_por });

  return { ok: true, checkpoint };
}

// ── Processa próximo lote ────────────────────────────────────────
// Retorna: { checkpoint, processados_neste_lote, terminou }
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

  // Carrega snapshot atual das coleções (pra fazer append, não sobrescrever)
  const accountsAtual = await crmStore.getCollection('accounts');
  const ordersAtual   = await crmStore.getCollection('orders');

  // Constrói índices auxiliares
  const index_cpf = {};
  for (const [id, a] of Object.entries(accountsAtual)) {
    if (a && a.cpf_cnpj) index_cpf[a.cpf_cnpj] = id;
  }
  const index_bling = {};
  for (const [id, o] of Object.entries(ordersAtual)) {
    if (o && o.bling_pedido_id) index_bling[o.bling_pedido_id] = id;
  }

  const snapshot = {
    accounts: { ...accountsAtual },
    orders:   { ...ordersAtual },
    activities: {}, // triggers ficam pra Fatia 4
    index_cpf,
    index_bling,
  };

  let processados = 0, criouAccounts = 0, criouOrders = 0;
  const avisosLote = [];
  const idsFalhados = [];

  for (const id of lote) {
    try {
      const detalhe = await puxarDetalhePedido(id);
      const r = await processarPedido(detalhe, snapshot, { usersJson, ownerFallback });
      processados++;
      if (r.criouAccount) criouAccounts++;
      if (r.criouOrder) criouOrders++;
      if (r.avisos && r.avisos.length) avisosLote.push(...r.avisos);
    } catch (e) {
      idsFalhados.push(id);
      avisosLote.push('pedido ' + id + ': ' + (e.message || String(e)).slice(0, 150));
    }
  }

  // Salva as coleções mutadas (UMA vez cada)
  await crmStore.saveCollection('accounts', snapshot.accounts, 'Bling backfill: +' + criouAccounts + ' accounts (lote de ' + lote.length + ' pedidos)');
  await crmStore.saveCollection('orders',   snapshot.orders,   'Bling backfill: +' + criouOrders + ' orders (lote de ' + lote.length + ' pedidos)');

  // ── Camada 4: roda automação de upsell nos orders novos deste lote ──
  // Fire-and-forget: falhas individuais não travam o backfill.
  if (snapshot._pendingUpsells && snapshot._pendingUpsells.length) {
    try {
      const { processarOrderNovo } = require('../crm/automacaoUpsell');
      for (const { orderId, vendedor } of snapshot._pendingUpsells) {
        try { await processarOrderNovo(orderId, vendedor); }
        catch (e) { avisosLote.push('upsell ' + orderId + ': ' + (e.message || String(e)).slice(0, 100)); }
      }
    } catch (e) { avisosLote.push('automacaoUpsell falhou: ' + e.message); }
  }

  // Atualiza checkpoint
  cp.ids_pendentes = resto.concat(idsFalhados); // falhados tentam de novo no próximo lote
  cp.processados += processados;
  cp.accounts_criadas += criouAccounts;
  cp.orders_criadas += criouOrders;
  cp.avisos = (cp.avisos || []).concat(avisosLote).slice(-200); // últimos 200 avisos
  cp.ultimo_lote_em = new Date().toISOString();

  if (cp.ids_pendentes.length === 0) {
    cp.status = 'concluido';
    cp.concluido_em = new Date().toISOString();
    await apendarLog({
      tipo: 'backfill_concluido',
      pedidos_processados: cp.processados,
      accounts_criadas: cp.accounts_criadas,
      orders_criadas: cp.orders_criadas,
    });
  }
  await salvarCheckpoint(cp);

  return {
    ok: true,
    terminou: cp.ids_pendentes.length === 0,
    processados_neste_lote: processados,
    avisos_neste_lote: avisosLote.length,
    checkpoint: cp,
  };
}

// ── Sync incremental (últimos N dias) ────────────────────────────
// Simpler que backfill — não usa checkpoint, faz tudo numa invocação.
// Bom pra rodar via cron a cada 15 min ou manual pela UI.
async function syncIncremental({ dias = 1, usersJson, ownerFallback = 'gerencia' } = {}) {
  const ate = new Date();
  const desde = new Date();
  desde.setDate(desde.getDate() - dias);
  const desdeStr = desde.toISOString().slice(0, 10);
  const ateStr = ate.toISOString().slice(0, 10);

  const { pedidos } = await puxarTodaListaPedidos({ desde: desdeStr, ate: ateStr, limitePaginas: 30 });

  const accountsAtual = await crmStore.getCollection('accounts');
  const ordersAtual   = await crmStore.getCollection('orders');

  const index_cpf = {};
  for (const [id, a] of Object.entries(accountsAtual)) if (a && a.cpf_cnpj) index_cpf[a.cpf_cnpj] = id;
  const index_bling = {};
  for (const [id, o] of Object.entries(ordersAtual)) if (o && o.bling_pedido_id) index_bling[o.bling_pedido_id] = id;

  const snapshot = { accounts: { ...accountsAtual }, orders: { ...ordersAtual }, activities: {}, index_cpf, index_bling };

  let novos = 0, atualizados = 0, criouAccounts = 0;
  const avisos = [];
  for (const resumo of pedidos) {
    try {
      // Se já existe order com esse bling_id, pula (incremental é só pra novos)
      if (index_bling[String(resumo.id)]) { atualizados++; continue; }
      const detalhe = await puxarDetalhePedido(resumo.id);
      const r = await processarPedido(detalhe, snapshot, { usersJson, ownerFallback });
      if (r.criouOrder) novos++;
      if (r.criouAccount) criouAccounts++;
      if (r.avisos && r.avisos.length) avisos.push(...r.avisos);
    } catch (e) {
      avisos.push('pedido ' + resumo.id + ': ' + (e.message || String(e)).slice(0, 150));
    }
  }

  if (novos > 0 || criouAccounts > 0) {
    await crmStore.saveCollection('accounts', snapshot.accounts, 'Bling sync incremental: +' + criouAccounts + ' accounts');
    await crmStore.saveCollection('orders',   snapshot.orders,   'Bling sync incremental: +' + novos + ' orders');
  }

  // ── Camada 4: roda automação de upsell nos orders novos deste sync ──
  if (snapshot._pendingUpsells && snapshot._pendingUpsells.length) {
    try {
      const { processarOrderNovo } = require('../crm/automacaoUpsell');
      for (const { orderId, vendedor } of snapshot._pendingUpsells) {
        try { await processarOrderNovo(orderId, vendedor); }
        catch (e) { avisos.push('upsell ' + orderId + ': ' + (e.message || String(e)).slice(0, 100)); }
      }
    } catch (e) { avisos.push('automacaoUpsell falhou: ' + e.message); }
  }

  await apendarLog({
    tipo: 'sync_incremental',
    dias,
    pedidos_vistos: pedidos.length,
    novos_orders: novos,
    novas_accounts: criouAccounts,
    ja_existentes: atualizados,
    avisos: avisos.length,
  });

  return { ok: true, pedidos_vistos: pedidos.length, novos_orders: novos, novas_accounts: criouAccounts, avisos_count: avisos.length };
}

module.exports = {
  iniciar, continuar, syncIncremental,
  lerCheckpoint, apagarCheckpoint, apendarLog,
  LOTE_TAMANHO,
};
