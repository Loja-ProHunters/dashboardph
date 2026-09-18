// lib/crm/automacaoUpsell.js
// Camada 4 do "cérebro" do CRM: automação proativa de upsell.
//
// Toda vez que um Order novo entra em `crm/orders.json` (via sync do Bling),
// esse módulo chama a Camada 3.2 (motor de sugestão) e, para cada sugestão
// com confiança ≥ threshold, cria automaticamente:
//   - 1 Opportunity vinculada à Account (valor estimado, produtos, motivo)
//   - 1 Activity (tarefa) atribuída ao vendedor que fez a venda original,
//     tipo="sugestao_upsell", prazo D+5 (cliente ainda "quente")
//
// Idempotência: cada Order gera no MÁXIMO 1 rodada (trigger_id).
// Rate-limit: fire-and-forget do sync — não bloqueia o import.
//
// Também exporta função `disparaReativacao()` pra cron semanal que roda
// sugestões para clientes parados >90 dias.

const crmStore = require('./store');
const crmUtils = require('./utils');
const { sugerirParaCliente } = require('./sugerir');

const THRESHOLD_CONFIANCA = 0.6;   // só cria tarefa se IA passar disso
const PRAZO_DIAS_UPSELL = 5;       // D+5 (cliente ainda "quente")
const DIAS_REATIVACAO   = 90;      // cliente parado há X dias → reativa

// ── Roda a automação para 1 Order (chamada logo após criar o pedido) ─
// Não lança — se falhar, loga e segue (não pode quebrar o sync do Bling).
async function processarOrderNovo(orderId, ownerVendedor) {
  try {
    const order = await crmStore.getDoc('orders', orderId);
    if (!order) return { ok: false, motivo: 'order não achado' };

    // Idempotência: se já rodou pra este order, não roda de novo
    const triggerId = 'auto_upsell_' + orderId;
    const jaFeitas = await crmStore.listDocs('activities', a => a.trigger_id === triggerId);
    if (jaFeitas.length) return { ok: true, motivo: 'já processado', tarefas: 0 };

    const r = await sugerirParaCliente({ accountId: order.account_id, orderId });
    const sugestoesFortes = (r.sugestoes || []).filter(s => (s.confianca || 0) >= THRESHOLD_CONFIANCA);
    if (!sugestoesFortes.length) return { ok: true, motivo: 'sem sugestões fortes', tarefas: 0 };

    const account = await crmStore.getDoc('accounts', order.account_id);
    const vendedor = ownerVendedor || order.vendedor_id || (account && account.owner_id) || 'gerencia';

    // Cria 1 Opportunity agregando as sugestões
    const opId = await crmStore.createDoc('opportunities', {
      account_id: order.account_id,
      origem_id: orderId,
      origem_tipo: 'automacao_pos_venda',
      status: 'aberta',
      estagio: 'sugerida',
      valor_estimado: null,
      produtos_sugeridos: sugestoesFortes.map(s => ({ sku: s.sku_bling, nome: s.nome, motivo: s.motivo })),
      dono: vendedor,
      criado_em: new Date().toISOString(),
      criado_por: 'automacao',
    }, 'automacao');

    // Cria 1 Activity única com checklist das sugestões (evita spam de N tarefas)
    const prazo = _hojeMais(PRAZO_DIAS_UPSELL);
    const descricao = _montarDescricaoUpsell(account, order, sugestoesFortes);
    const actId = await crmStore.createDoc('activities', {
      account_id: order.account_id,
      opportunity_id: opId,
      order_id: orderId,
      tipo: 'sugestao_upsell',
      status: 'pendente',
      titulo: 'Upsell pós-venda — ' + (account ? account.nome : order.account_id),
      descricao,
      dono: vendedor,
      prazo,
      trigger_id: triggerId,
      gerada_automaticamente: true,
      pitch_pronto: sugestoesFortes[0] ? sugestoesFortes[0].pitch : null,
      criado_em: new Date().toISOString(),
      criado_por: 'automacao',
    }, 'automacao');

    return { ok: true, tarefas: 1, opportunity_id: opId, activity_id: actId, sugestoes: sugestoesFortes.length };
  } catch (e) {
    return { ok: false, motivo: (e.message || String(e)).slice(0, 200) };
  }
}

// ── Cron semanal de REATIVAÇÃO ────────────────────────────────
// Para cada conta que não compra há >90 dias, gera 1 tarefa de reativação
// (com sugestões baseadas em coocorrência do histórico).
async function disparaReativacao({ diasParado = DIAS_REATIVACAO, limite = 50 } = {}) {
  const hoje = new Date().toISOString().slice(0, 10);
  const cutoff = _hojeMenos(diasParado);

  const accounts = await crmStore.listDocs('accounts', a => a.status === 'ativo' && a.ultima_compra_em && a.ultima_compra_em < cutoff);
  // Ordena: quem gastou mais primeiro (mais valor a recuperar)
  accounts.sort((a, b) => (b.valor_total_compras || 0) - (a.valor_total_compras || 0));

  const alvos = accounts.slice(0, limite);
  let criadas = 0, puladas = 0, erros = 0;

  for (const acc of alvos) {
    try {
      const triggerId = 'reativacao_' + acc.id + '_' + hoje.slice(0, 7); // 1 por mês por cliente
      const ja = await crmStore.listDocs('activities', a => a.trigger_id === triggerId);
      if (ja.length) { puladas++; continue; }

      const r = await sugerirParaCliente({ accountId: acc.id });
      const sugestoes = (r.sugestoes || []).filter(s => (s.confianca || 0) >= 0.5);
      if (!sugestoes.length) { puladas++; continue; }

      const descricao = 'Cliente parado há ' + _diffDias(acc.ultima_compra_em, hoje) + ' dias. Última compra: ' + acc.ultima_compra_em + '. Sugestões pra reativação:\n' +
        sugestoes.map((s, i) => (i + 1) + '. ' + (s.nome || s.sku_bling) + ' — ' + s.motivo).join('\n');

      await crmStore.createDoc('activities', {
        account_id: acc.id,
        tipo: 'reativacao',
        status: 'pendente',
        titulo: 'Reativar cliente — ' + acc.nome,
        descricao,
        dono: acc.owner_id || 'gerencia',
        prazo: _hojeMais(7),
        trigger_id: triggerId,
        gerada_automaticamente: true,
        pitch_pronto: sugestoes[0] ? sugestoes[0].pitch : null,
        criado_em: new Date().toISOString(),
        criado_por: 'cron-reativacao',
      }, 'cron-reativacao');
      criadas++;
    } catch (e) {
      erros++;
    }
  }

  return { ok: true, contas_analisadas: alvos.length, criadas, puladas, erros };
}

// ── Helpers ─────────────────────────────────────────────────
function _hojeMais(d) {
  const dt = new Date();
  dt.setDate(dt.getDate() + d);
  return dt.toISOString().slice(0, 10);
}
function _hojeMenos(d) {
  const dt = new Date();
  dt.setDate(dt.getDate() - d);
  return dt.toISOString().slice(0, 10);
}
function _diffDias(a, b) {
  const da = new Date(a + 'T00:00:00Z');
  const db = new Date(b + 'T00:00:00Z');
  return Math.round((db - da) / (1000 * 60 * 60 * 24));
}
function _montarDescricaoUpsell(account, order, sugestoes) {
  const nome = account ? account.nome : order.account_id;
  const itensCompra = (order.itens || []).map(i => i.descricao || i.sku).slice(0, 3).join(', ');
  const linhas = sugestoes.map((s, i) => (i + 1) + '. ' + (s.nome || s.sku_bling) + ' — ' + s.motivo);
  return 'Cliente ' + nome + ' comprou em ' + order.data_pedido + ': ' + itensCompra + '.\n\nSugestões (contatar em até ' + PRAZO_DIAS_UPSELL + ' dias):\n' + linhas.join('\n') +
    (sugestoes[0] && sugestoes[0].pitch ? '\n\n📱 Pitch pronto pra WhatsApp:\n' + sugestoes[0].pitch : '');
}

module.exports = { processarOrderNovo, disparaReativacao };
