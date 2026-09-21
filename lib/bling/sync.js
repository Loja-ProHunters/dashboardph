// lib/bling/sync.js
// Puxa pedidos do Bling e traduz pro modelo do CRM (Accounts, Orders).
//
// Estratégia:
//   1) puxarListaPedidos(desde, ate) — pagina através de /pedidos/vendas,
//      retorna só resumo (id, número, data, situação, valor total). Rápido.
//   2) puxarDetalhePedido(id) — busca /pedidos/vendas/{id} pra pegar itens
//      completos + dados do contato. Um por pedido.
//   3) processarPedido(detalhe, snapshot) — muta o snapshot com a Account
//      criada/atualizada e a Order nova. Não salva no GitHub — deixa o
//      chamador agrupar tudo num único write por coleção (bem mais barato).
//
// TUDO defensivo: se o Bling devolver um pedido com campo faltando ou tipo
// inesperado, o sync loga na lista de avisos e SEGUE. Nunca crasha o batch
// inteiro por 1 pedido malformado.

const blingApi = require('./api');
const crmUtils = require('../crm/utils');
const blingVendedores = require('./vendedores');

// ── Aliases explícitos: quando o nome do vendedor no Bling não bate direto ──
// com o login do CRM, mapeamos manualmente aqui. Chave = fragmento de nome
// (lowercase, sem acento), valor = login CRM. Cobre variações comuns.
const ALIAS_VENDEDOR_NOME = {
  // Enzo dos Santos Boschetto → boschetto
  'boschetto': 'boschetto',
  'boscheto':  'boschetto',
  'enzo boschetto': 'boschetto',
  'enzo dos santos': 'boschetto',
  // Pedro Henrique Dickmann → dickmann
  'dickmann':  'dickmann',
  'pedro dickmann': 'dickmann',
  'pedro henrique': 'dickmann',
  // Wesley Mathias Ciesielsky → mathias
  'mathias':      'mathias',
  'ciesielsky':   'mathias',
  'ciesielski':   'mathias',
  'wesley mathias': 'mathias',
};

function _norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ').trim();
}

// ── Mapeamento de status do Bling → enum interno de Order ────────
// Bling situação.id costuma ser numérico. Sem acesso à tabela oficial no
// momento, mapeamos pelo nome/descrição do status quando disponível.
const MAPA_STATUS_BLING = {
  'em aberto':          'rascunho',
  'aguardando pagamento':'pendente_pagamento',
  'atendido':           'pago',
  'em andamento':       'pendente_pagamento',
  'em digitação':       'rascunho',
  'venda agenciada':    'rascunho',
  'em separação':       'pago',
  'verificado':         'pago',
  'faturado':           'pago',
  'em transporte':      'enviado',
  'enviado':            'enviado',
  'entregue':           'entregue',
  'cancelado':          'cancelado',
  'devolvido':          'devolvido',
};

function normalizarStatus(situacao) {
  if (!situacao) return 'rascunho';
  const nome = String(situacao.valor || situacao.nome || situacao.descricao || '').toLowerCase().trim();
  return MAPA_STATUS_BLING[nome] || 'rascunho';
}

function toISODate(v) {
  if (!v) return null;
  // Bling pode devolver 'YYYY-MM-DD' ou 'DD/MM/YYYY' ou timestamp. Normalizamos.
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const brMatch = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (brMatch) return brMatch[3] + '-' + brMatch[2] + '-' + brMatch[1];
  try { return new Date(s).toISOString().slice(0, 10); } catch (e) { return null; }
}

function toNumber(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// ── Puxa lista paginada de pedidos ───────────────────────────────
// Bling API v3: GET /pedidos/vendas?pagina=1&limite=100&dataInicial=...&dataFinal=...
// Retorna: { data: [ {id, numero, ...}, ... ] }
async function puxarListaPedidos({ desde, ate, pagina = 1, limite = 100 } = {}) {
  const query = { pagina, limite };
  if (desde) query.dataInicial = desde; // AAAA-MM-DD
  if (ate)   query.dataFinal   = ate;
  const r = await blingApi.get('/pedidos/vendas', query);
  // r.data é a lista; alguns endpoints podem estar em r direto
  const lista = Array.isArray(r) ? r : (r && Array.isArray(r.data) ? r.data : []);
  return lista;
}

// Puxa TODAS as páginas de pedidos num range e devolve lista completa de resumos.
// Se atingir limite de páginas (segurança), retorna o que tem + flag `truncado`.
async function puxarTodaListaPedidos({ desde, ate, limitePaginas = 200 }) {
  const todos = [];
  let pagina = 1;
  let truncado = false;
  while (pagina <= limitePaginas) {
    const lote = await puxarListaPedidos({ desde, ate, pagina, limite: 100 });
    if (!lote.length) break;
    todos.push(...lote);
    if (lote.length < 100) break; // última página
    pagina++;
    if (pagina > limitePaginas) truncado = true;
  }
  return { pedidos: todos, truncado };
}

// ── Puxa detalhe de 1 pedido ─────────────────────────────────────
async function puxarDetalhePedido(id) {
  const r = await blingApi.get('/pedidos/vendas/' + id);
  // Bling normalmente devolve { data: {...} } ou {...} direto
  return r && r.data ? r.data : r;
}

// ── Mapeia vendedor Bling → login do CRM (owner) ────────────────
// Estratégia em várias camadas (a primeira que casar vence):
//   1) Bling devolveu email → casa com email do users.json
//   2) Bling devolveu nome → tenta ALIAS_VENDEDOR_NOME (fragmentos conhecidos)
//   3) Bling devolveu nome → login/sobrenome/primeiro-nome contido no nome
//   4) Bling devolveu SÓ o id → resolve nome/email via cache de vendedores.js
//      e retenta as camadas 1-3 com os dados enriquecidos
// Retorna: login do CRM (string) OU null (cai pra "gerencia" no chamador).
//
// ctx opcional: { vendedorMapaBling: {id → {nome, email}} } — pra bulk ops
async function mapearVendedor(pedidoDetalhe, usersJson, ctx = {}) {
  if (!pedidoDetalhe || !pedidoDetalhe.vendedor) return null;
  const v = pedidoDetalhe.vendedor;
  if (!usersJson) return null;

  // Extrai email/nome/id do payload do Bling
  let emailBling = String(v.email || (v.contato && v.contato.email) || '').toLowerCase().trim();
  let nomeBling  = String(v.nome  || (v.contato && v.contato.nome)  || '').trim();
  const idBling  = v.id || (v.contato && v.contato.id) || null;

  // Se veio só o ID (caso comum na v3), enriquece via mapa/cache
  if (idBling && (!emailBling && !nomeBling)) {
    let info = null;
    if (ctx.vendedorMapaBling && ctx.vendedorMapaBling[String(idBling)]) {
      info = ctx.vendedorMapaBling[String(idBling)];
    } else {
      try { info = await blingVendedores.getById(idBling); } catch(e) {}
    }
    if (info) {
      if (info.email) emailBling = info.email;
      if (info.nome)  nomeBling  = info.nome;
    }
  }

  // Camada 1 — Email exato
  if (emailBling) {
    for (const [login, u] of Object.entries(usersJson)) {
      if (u && u.email && String(u.email).toLowerCase() === emailBling) return login;
    }
  }

  const nomeN = _norm(nomeBling);
  if (!nomeN) return null;

  // Camada 2 — Aliases explícitos (fragmentos de nome → login)
  for (const [frag, login] of Object.entries(ALIAS_VENDEDOR_NOME)) {
    if (nomeN.includes(frag)) return login;
  }

  // Camada 3 — Login/nome/sobrenome contido no nome Bling
  for (const [login, u] of Object.entries(usersJson)) {
    const loginN = _norm(login);
    if (loginN && nomeN.includes(loginN)) return login;
    const nomeUser = _norm(u && u.nome);
    if (nomeUser) {
      // Casa sobrenome (última palavra)
      const partes = nomeUser.split(' ').filter(Boolean);
      if (partes.length) {
        const sobrenome = partes[partes.length - 1];
        if (sobrenome.length >= 4 && nomeN.includes(sobrenome)) return login;
        const primeiro = partes[0];
        if (primeiro.length >= 4 && nomeN.includes(primeiro)) return login;
      }
    }
  }

  return null;
}

// ── Processa 1 pedido → cria/atualiza Account e cria Order ───────
// snapshot = { accounts: {id→doc}, orders: {id→doc}, activities: {id→doc},
//              index_cpf: {cpf → account_id}, index_bling: {bling_pedido_id → order_id} }
// ctx pode conter: { usersJson, ownerFallback, vendedorMapaBling }
// Muta o snapshot in-place e retorna { account_id, order_id, criouAccount, criouOrder, avisos:[] }
async function processarPedido(detalhe, snapshot, ctx = {}) {
  const avisos = [];
  const usersJson = ctx.usersJson || {};
  const nowIso = new Date().toISOString();

  if (!detalhe) { avisos.push('detalhe vazio'); return { avisos }; }

  const blingPedidoId = String(detalhe.id || '');
  if (!blingPedidoId) { avisos.push('sem id do Bling'); return { avisos }; }

  // Se já processamos esse Bling ID nessa mesma execução, pula
  if (snapshot.index_bling[blingPedidoId]) {
    return { order_id: snapshot.index_bling[blingPedidoId], jaProcessado: true, avisos };
  }

  // ── Contato / Account ────────────────────────────────────────
  const contato = detalhe.contato || detalhe.cliente || {};
  const cpfCnpjRaw = contato.numeroDocumento || contato.cpfCnpj || contato.cnpj || contato.cpf;
  const cpfCnpj = crmUtils.normalizaCpfCnpj(cpfCnpjRaw);
  if (!cpfCnpj) {
    avisos.push('pedido ' + blingPedidoId + ': sem CPF/CNPJ do contato — pulando');
    return { avisos };
  }
  if (!crmUtils.validaCpfCnpj(cpfCnpj)) {
    avisos.push('pedido ' + blingPedidoId + ': CPF/CNPJ inválido (' + cpfCnpj + ')');
    // segue mesmo assim — pode ser CPF estrangeiro ou dado sujo
  }

  const tipoDoc = cpfCnpj.length === 11 ? 'pf' : (cpfCnpj.length === 14 ? 'pj' : 'pf');
  const nome = String(contato.nome || contato.razao || contato.nomeFantasia || 'Cliente sem nome');

  let accountId = snapshot.index_cpf[cpfCnpj];
  let criouAccount = false;
  if (!accountId) {
    accountId = 'acc_' + require('crypto').randomBytes(8).toString('hex');
    snapshot.accounts[accountId] = {
      id: accountId,
      tipo: tipoDoc,
      cpf_cnpj: cpfCnpj,
      nome,
      razao_social: tipoDoc === 'pj' ? nome : null,
      nome_fantasia: contato.nomeFantasia || null,
      email: contato.email || null,
      telefone: contato.telefone || contato.celular || null,
      endereco: contato.endereco || null,
      status: 'ativo',
      owner_id: ctx.ownerFallback || 'gerencia',
      onboarding_id: null,
      primeira_compra_em: null, // vamos atualizar abaixo
      ultima_compra_em: null,
      pedidos_count: 0,
      valor_total_compras: 0,
      categorias_compradas: [],
      bling_contato_id: contato.id ? String(contato.id) : null,
      tags: [],
      notas: null,
      criado_em: nowIso,
      criado_por: 'bling-sync',
      atualizado_em: nowIso,
      atualizado_por: 'bling-sync',
    };
    snapshot.index_cpf[cpfCnpj] = accountId;
    criouAccount = true;
  }
  const account = snapshot.accounts[accountId];

  // ── Itens do pedido ──────────────────────────────────────────
  const itensRaw = Array.isArray(detalhe.itens) ? detalhe.itens : [];
  const itens = itensRaw.map(it => {
    const prod = it.produto || {};
    return {
      sku: String(prod.codigo || it.codigo || ''),
      descricao: String(prod.descricao || it.descricao || ''),
      categoria: prod.categoria ? String(prod.categoria.nome || prod.categoria) : null,
      quantidade: toNumber(it.quantidade),
      valor_unitario: toNumber(it.valor),
      valor_total_item: toNumber((toNumber(it.valor) * toNumber(it.quantidade))),
    };
  });

  const valorTotal = toNumber(detalhe.total || detalhe.totalvenda || detalhe.totalProdutos || itens.reduce((s, i) => s + i.valor_total_item, 0));
  const dataPedido = toISODate(detalhe.data || detalhe.dataEmissao);
  const status = normalizarStatus(detalhe.situacao);

  const vendedorLogin = await mapearVendedor(detalhe, usersJson, ctx);

  // ── Order ────────────────────────────────────────────────────
  const orderId = 'ord_' + require('crypto').randomBytes(8).toString('hex');
  snapshot.orders[orderId] = {
    id: orderId,
    bling_pedido_id: blingPedidoId,
    bling_numero: detalhe.numero ? String(detalhe.numero) : null,
    account_id: accountId,
    opportunity_id: null,
    referral_id: null,
    vendedor_id: vendedorLogin || account.owner_id,
    status,
    valor_total: valorTotal,
    itens,
    data_pedido: dataPedido || nowIso.slice(0, 10),
    data_pagamento: toISODate(detalhe.dataAtendimento || detalhe.dataFaturamento),
    data_envio: toISODate(detalhe.dataSaida),
    data_entrega: toISODate(detalhe.dataEntrega),
    notas: detalhe.observacoes || detalhe.observacoesInternas || null,
    sincronizado_bling_em: nowIso,
    criado_em: nowIso,
    criado_por: 'bling-sync',
    atualizado_em: nowIso,
    atualizado_por: 'bling-sync',
  };
  snapshot.index_bling[blingPedidoId] = orderId;

  // ── Atualiza campos derivados da Account ─────────────────────
  account.pedidos_count = (account.pedidos_count || 0) + 1;
  account.valor_total_compras = (account.valor_total_compras || 0) + valorTotal;
  if (!account.primeira_compra_em || (dataPedido && dataPedido < account.primeira_compra_em)) {
    account.primeira_compra_em = dataPedido;
  }
  if (!account.ultima_compra_em || (dataPedido && dataPedido > account.ultima_compra_em)) {
    account.ultima_compra_em = dataPedido;
  }
  // Se vendedor Bling mapeou pra um login e a Account ainda tá com owner default, atualiza
  if (vendedorLogin && account.owner_id === 'gerencia') {
    account.owner_id = vendedorLogin;
  }
  // Categorias distintas compradas
  const catsSet = new Set(account.categorias_compradas || []);
  itens.forEach(i => { if (i.categoria) catsSet.add(i.categoria); });
  account.categorias_compradas = [...catsSet];
  account.atualizado_em = nowIso;

  // ── Hook Camada 4: marca este Order pra rodar automação de upsell ──
  // O chamador (backfill/sync incremental) executa após salvar as coleções.
  // Não bloqueia o import — se falhar lá, apenas loga.
  try {
    if (!snapshot._pendingUpsells) snapshot._pendingUpsells = [];
    snapshot._pendingUpsells.push({ orderId, vendedor: vendedorLogin || account.owner_id });
  } catch (e) { avisos.push('hook upsell falhou: ' + e.message); }

  return { account_id: accountId, order_id: orderId, criouAccount, criouOrder: true, avisos };
}

module.exports = {
  MAPA_STATUS_BLING,
  normalizarStatus, toISODate, toNumber,
  puxarListaPedidos, puxarTodaListaPedidos, puxarDetalhePedido,
  mapearVendedor,
  processarPedido,
};
