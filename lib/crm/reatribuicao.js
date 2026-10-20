// lib/crm/reatribuicao.js
// Aplica a releitura do vendedor do Bling (Reatribuicao v3) em pedidos,
// clientes e tarefas abertas. Funcao PURA sobre as colecoes (testavel).
//
// Regras (definidas pelo Luis em 20/10/2026):
//   • Pedido com vendedor (Wesley/Enzo/Pedro) → o pedido e o cliente sao DELE.
//     Cliente com varias compras: dono = quem mais vendeu pra ele (empate: a
//     venda mais recente).
//   • Pedido sem vendedor ou "Tray" = e-commerce → as tarefas seguem o rodizio
//     aleatorio e equilibrado do motor diario. O dono do cliente nao e alterado.
//   • Tarefas AUTOMATICAS abertas seguem o dono do cliente. Tarefas criadas
//     pelo proprio vendedor (manual, follow-up, proximo passo da carteira) nao
//     mudam de dono.

const VENDEDORES = ['dickmann', 'boschetto', 'mathias'];
const CANAIS_ECOMMERCE = /\btray\b|e-?commerce|loja virtual|loja integrada|mercado ?livre|shopee|amazon|magalu|magazine luiza|americanas/i;
const FONTES_DO_VENDEDOR = ['carteira', 'manual'];
const TIPOS_DO_VENDEDOR = ['manual', 'follow_up'];

function _norm(v) { return String(v || '').trim().toLowerCase(); }
function _hash(s) { let h = 0; s = String(s || ''); for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }

function aplicar({ orders, accounts, activities, updates, agora }) {
  agora = agora || new Date().toISOString();
  const resumo = { pedidos_atualizados: 0, pedidos_vendedor_mudou: 0, clientes_novo_dono: 0, clientes_ecommerce_distribuidos: 0,
    tarefas_reatribuidas: 0, tarefas_por_vendedor: {}, donos_por_vendedor: {} };

  // 1) Pedidos
  for (const [oid, u] of Object.entries(updates || {})) {
    const o = orders[oid]; if (!o || !u) continue;
    // Canal online (Loja Integrada, Mercado Livre...) lido como "nao mapeado" = e-commerce
    if (u.origem === 'nao_mapeado' && CANAIS_ECOMMERCE.test(String(u.nome || ''))) u.origem = 'ecommerce';
    const antes = _norm(o.vendedor_id);
    let novo;
    if (u.origem === 'vendedor') novo = u.login;
    else if (u.origem === 'ecommerce') novo = VENDEDORES.indexOf(antes) !== -1 ? antes : 'tray'; // ja no rodizio: mantem
    else if (u.origem === 'interno') novo = u.login || 'gerencia';
    else novo = 'gerencia';
    o.vendedor_bling = u;
    if (antes !== novo) { o.vendedor_id = novo; if (u.origem === 'vendedor') resumo.pedidos_vendedor_mudou++; }
    o.atualizado_em = agora; o.atualizado_por = 'reatribuicao-v3';
    resumo.pedidos_atualizados++;
  }

  // 2) Clientes: dono = vendedor com mais vendas (empate: mais recente)
  const porConta = {};
  for (const o of Object.values(orders)) {
    if (!o || !o.account_id || !o.vendedor_bling) continue;
    const pc = porConta[o.account_id] = porConta[o.account_id] || { vend: {}, ultimo: {}, ecommerce: 0 };
    if (o.vendedor_bling.origem === 'vendedor' && VENDEDORES.indexOf(o.vendedor_bling.login) !== -1) {
      const l = o.vendedor_bling.login;
      pc.vend[l] = (pc.vend[l] || 0) + 1;
      if (String(o.data_pedido || '') > String(pc.ultimo[l] || '')) pc.ultimo[l] = o.data_pedido || '';
    } else if (o.vendedor_bling.origem === 'ecommerce') pc.ecommerce++;
  }
  // carga atual de clientes por vendedor (para o rodizio equilibrado)
  const carga = {}; VENDEDORES.forEach(v => { carga[v] = 0; });
  for (const a of Object.values(accounts)) if (a && VENDEDORES.indexOf(_norm(a.owner_id)) !== -1) carga[_norm(a.owner_id)]++;
  for (const [aid, pc] of Object.entries(porConta)) {
    const acc = accounts[aid]; if (!acc) continue;
    const vend = Object.entries(pc.vend);
    const atual = _norm(acc.owner_id);
    if (vend.length) {
      vend.sort((x, y) => (y[1] - x[1]) || String(pc.ultimo[y[0]]).localeCompare(String(pc.ultimo[x[0]])));
      const dono = vend[0][0];
      if (atual !== dono) {
        if (carga[atual] !== undefined) carga[atual]--; carga[dono]++;
        acc.owner_id = dono; resumo.clientes_novo_dono++;
        resumo.donos_por_vendedor[dono] = (resumo.donos_por_vendedor[dono] || 0) + 1;
      }
      acc.owner_definido_por_venda = true; acc.atualizado_em = agora; acc.atualizado_por = 'reatribuicao-v3';
    } else if (pc.ecommerce) {
      // Cliente so de e-commerce: nao mexe no dono — as tarefas dele seguem o
      // rodizio aleatorio e equilibrado do motor diario.
      acc.owner_definido_por_venda = false;
    }
  }

  // 3) Tarefas automaticas abertas seguem o dono do cliente (quando definido por venda)
  for (const t of Object.values(activities)) {
    if (!t || t.status !== 'pendente' || t.fonte === 'contrato_arma') continue;
    if (!t.gerada_automaticamente) continue;
    if (FONTES_DO_VENDEDOR.indexOf(t.fonte) !== -1 || TIPOS_DO_VENDEDOR.indexOf(t.tipo) !== -1) continue;
    const acc = accounts[t.account_id || t.entidade_id];
    if (!acc || !acc.owner_definido_por_venda) continue;
    const dono = _norm(acc.owner_id);
    if (VENDEDORES.indexOf(dono) === -1) continue;
    const atual = _norm(t.owner_id || t.dono);
    if (atual === dono) continue;
    Object.assign(t, { owner_id: dono, dono, reatribuido_de: atual, reatribuido_em: agora, atualizado_em: agora, atualizado_por: 'reatribuicao-v3' });
    resumo.tarefas_reatribuidas++;
    resumo.tarefas_por_vendedor[dono] = (resumo.tarefas_por_vendedor[dono] || 0) + 1;
  }
  return { orders, accounts, activities, resumo };
}

module.exports = { aplicar, VENDEDORES };
