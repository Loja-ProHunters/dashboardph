// lib/crm/contratosArma.js
// CONTRATO OBRIGATORIO EM TODA VENDA DE ARMA DE FOGO.
//
// Regra da empresa: toda venda de arma de fogo (a vista ou parcelada, qualquer
// meio de pagamento) precisa de contrato de venda feito pelo vendedor, enviado
// ao cliente e devolvido ASSINADO. Sem contrato assinado a venda e cancelada
// e o dinheiro devolvido.
//
// Fluxo automatico (sem ninguem precisar lembrar):
//   1) Pedido do Bling com item que e ARMA DE FOGO  ->  tarefa
//      "📝 Gerar e enviar contrato" pro vendedor do pedido (prazo: hoje).
//   2) Na mesma hora nasce a tarefa "✍️ Contrato assinado — salvar na pasta",
//      que so APARECE na fila 48h depois (campo disponivel_em).
//   3) Se o contrato JA FOI ENVIADO ha 48h+ e, 24h depois de a tarefa aparecer,
//      ainda nao foi salvo assinado (ou o vendedor marcar "cliente ainda nao
//      devolveu"), nasce a tarefa
//      "📞 Avisar cliente: sem contrato assinado a venda sera cancelada".
//   4) "Salvo na pasta" e uma DECLARACAO do vendedor (fica registrado quem e
//      quando). A gestao pode conferir depois e marcar "conferido" ou
//      "nao encontrado na pasta" — esse ultimo vira alerta grave.
//
// Idempotente: rodar varias vezes nao duplica (chave = pedido + etapa).

const crmStore = require('./store');
const { uuid } = require('./utils');

// ─── Ajustes ────────────────────────────────────────────────────────
const RETROATIVO_DIAS      = 90;   // pedidos de arma dos ultimos 90 dias entram
const HORAS_ASSINATURA     = 48;   // tarefa "salvar assinado" aparece 48h depois
const HORAS_COBRANCA       = 24;   // apos aparecer, mais 24h sem assinatura -> aviso de cancelamento
const VENDEDORES_ATIVOS    = ['dickmann', 'boschetto', 'mathias'];
const DESLIGADOS           = { jonatas: 'mathias' };

// ─── Deteccao de arma de fogo pela descricao do item ───────────────
// A descricao precisa COMECAR com o tipo da arma (evita "Coldre para pistola",
// "Carregador de pistola", "Capa para rifle", "Espoleta large rifle"...).
// Armas de pressao (PCP/CO2/mola) e airsoft NAO sao arma de fogo.
const RE_TIPO_ARMA = /^\s*(pistola|rev[oó]lver|carabina|rifle|espingarda|fuzil|garrucha|submetralhadora|metralhadora)\b/i;
const RE_NAO_FOGO  = /\b(airsoft|pcp|co2|c02|ar comprimido|spring|mola|gbb|chumbinho|brinquedo|gel)\b|press[aã]o|r[eé]plica|\b4[.,]5\s*mm|\b5[.,]5\s*mm|\b6[.,]3\s*mm/i;

function ehArmaDeFogo(descricao) {
  const d = String(descricao || '');
  if (!RE_TIPO_ARMA.test(d)) return false;
  if (RE_NAO_FOGO.test(d)) return false;
  return true;
}
function itensArma(order) {
  return (Array.isArray(order && order.itens) ? order.itens : []).filter(it => ehArmaDeFogo(it && it.descricao));
}

// ─── Datas (Brasilia) ───────────────────────────────────────────────
function _dataBRT(iso) {
  const t = Date.parse(iso || ''); if (isNaN(t)) return '';
  return new Date(t - 3 * 3600e3).toISOString().slice(0, 10);
}
function _norm(v) { return String(v || '').trim().toLowerCase(); }
function _fmtBR(dia) { const p = String(dia || '').split('-'); return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : (dia || ''); }
function _fmtMoeda(v) { return 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

// Vendedor responsavel: o do pedido (Bling). Se o pedido nao tem vendedor
// real (loja/site/gerencia), usa o dono da conta; se nem isso, devolve null e
// o processar() distribui de forma balanceada entre os vendedores ativos.
function responsavel(order, account) {
  const v = _norm(order && order.vendedor_id);
  if (DESLIGADOS[v]) return DESLIGADOS[v];
  if (VENDEDORES_ATIVOS.indexOf(v) !== -1) return v;
  const o = _norm(account && account.owner_id);
  if (DESLIGADOS[o]) return DESLIGADOS[o];
  if (VENDEDORES_ATIVOS.indexOf(o) !== -1) return o;
  return null; // sem vendedor real -> distribuicao balanceada (ver _escolherBalanceado)
}

// Venda sem vendedor no Bling: vai pro vendedor com MENOS contratos em aberto
// (empate: rodizio deterministico pelo id do pedido). Nada cai na gerencia.
function _hash(s) { let h = 0; s = String(s || ''); for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }
function _escolherBalanceado(carga, orderId) {
  let min = Infinity; for (const v of VENDEDORES_ATIVOS) min = Math.min(min, carga[v] || 0);
  const empatados = VENDEDORES_ATIVOS.filter(v => (carga[v] || 0) === min);
  return empatados[_hash(orderId) % empatados.length];
}
const MOTIVOS_ANULACAO = {
  nao_exige_contrato: 'Venda não exige contrato',
  arma_ja_enviada:    'Arma já enviada / entregue com contrato resolvido',
  venda_cancelada:    'Venda cancelada ou devolvida',
  outro:              'Outro motivo',
};

function _resumoContrato(order, account, itens) {
  return {
    order_id: order.id,
    bling_numero: order.bling_numero || null,
    bling_conta: order.bling_conta_origem || null,
    data_pedido: order.data_pedido || null,
    valor_total: Number(order.valor_total || 0),
    cliente_nome: (account && (account.nome || account.razao_social)) || null,
    cliente_doc: (account && account.cpf_cnpj) || null,
    cliente_telefone: (account && account.telefone) || null,
    armas: itens.map(it => ({ sku: it.sku || null, descricao: it.descricao, quantidade: it.quantidade || 1, valor: it.valor_total_item || it.valor_unitario || null })),
    vendedor_pedido: order.vendedor_id || null,
  };
}

function _tarefa(base, extra) {
  const agora = new Date().toISOString();
  return Object.assign({
    id: uuid(),
    status: 'pendente',
    entidade_tipo: 'account',
    gerada_automaticamente: true,
    fonte: 'contrato_arma',
    obrigatoria: true,
    criado_em: agora, criado_por: 'contratos-arma',
    atualizado_em: agora, atualizado_por: 'contratos-arma',
  }, base, extra || {});
}

function _descArmas(c) {
  return c.armas.map(a => '• ' + (a.quantidade > 1 ? a.quantidade + 'x ' : '') + a.descricao).join('\n');
}

function _novaEnvio(c, dono, agoraISO) {
  const hoje = _dataBRT(agoraISO);
  return _tarefa({
    tipo: 'contrato_envio',
    owner_id: dono, dono,
    entidade_id: c.account_id, account_id: c.account_id, order_id: c.order_id,
    contrato_ref: c.order_id + ':envio',
    titulo: '📝 Gerar e enviar contrato — Pedido ' + (c.bling_numero || '') + ' · ' + (c.cliente_nome || 'cliente'),
    descricao: 'Venda de arma de fogo em ' + _fmtBR(c.data_pedido) + ' (' + _fmtMoeda(c.valor_total) + '):\n' + _descArmas(c) +
      '\n\nGere o contrato de venda, envie ao cliente e marque "Contrato enviado". Sem contrato assinado a venda é cancelada.',
    prazo: hoje,
    contrato: c,
  });
}

function _novaAssinatura(c, dono, agoraISO) {
  const disp = new Date(Date.parse(agoraISO) + HORAS_ASSINATURA * 3600e3).toISOString();
  return _tarefa({
    tipo: 'contrato_assinatura',
    owner_id: dono, dono,
    entidade_id: c.account_id, account_id: c.account_id, order_id: c.order_id,
    contrato_ref: c.order_id + ':assinatura',
    titulo: '✍️ Contrato assinado — salvar na pasta · Pedido ' + (c.bling_numero || '') + ' · ' + (c.cliente_nome || 'cliente'),
    descricao: 'O cliente precisa devolver o contrato ASSINADO. Salve o contrato assinado na pasta de contratos e marque "Salvo na pasta (assinado)".\n' +
      'Se o cliente ainda não devolveu, marque "Cliente ainda não devolveu" — o sistema gera a ligação de aviso de cancelamento.\n\n' + _descArmas(c),
    disponivel_em: disp,
    prazo: _dataBRT(disp),
    contrato: c,
  });
}

function _novaCobranca(c, dono, agoraISO, tentativa) {
  const hoje = _dataBRT(agoraISO);
  const pitch = 'Olá' + (c.cliente_nome ? ' ' + String(c.cliente_nome).split(' ')[0] : '') + ', tudo bem? Aqui é da Pro Hunters. ' +
    'Ainda não recebemos o contrato de compra da sua arma (pedido ' + (c.bling_numero || '') + ') assinado. ' +
    'Por exigência legal, sem o contrato assinado a venda precisa ser cancelada e o valor devolvido. ' +
    'Consegue assinar e nos devolver hoje? Se precisar, reenvio o arquivo agora.';
  return _tarefa({
    tipo: 'contrato_cobranca',
    owner_id: dono, dono,
    entidade_id: c.account_id, account_id: c.account_id, order_id: c.order_id,
    contrato_ref: c.order_id + ':cobranca:' + (tentativa || 1),
    titulo: '📞 Avisar cliente: sem contrato assinado a venda será cancelada · Pedido ' + (c.bling_numero || ''),
    descricao: 'O contrato da venda de arma ainda não voltou assinado. LIGUE para o cliente e informe que, se o contrato não for devolvido assinado, a venda será cancelada e o dinheiro devolvido.\n\n' + _descArmas(c),
    pitch_pronto: pitch,
    prazo: hoje,
    contrato: c,
  });
}

// ─── Processamento (idempotente) ────────────────────────────────────
// Cria as tarefas que faltam. opts.agora (Date) e opts.retroativoDias pra teste.
async function processar(opts) {
  opts = opts || {};
  const agora = opts.agora || new Date();
  const agoraISO = agora.toISOString();
  const retro = opts.retroativoDias != null ? opts.retroativoDias : RETROATIVO_DIAS;
  const desde = _dataBRT(new Date(agora.getTime() - retro * 86400e3).toISOString());

  let [orders, accounts, actsCol] = await Promise.all([
    crmStore.listDocs('orders'),
    crmStore.listDocs('accounts'),
    crmStore.getCollection('activities'),
  ]);
  const accMap = {}; for (const a of accounts) accMap[a.id] = a;
  const acts = Object.values(actsCol || {});

  // Indice do que ja existe (por pedido)
  const porPedido = {};
  for (const a of acts) {
    if (!a || a.fonte !== 'contrato_arma' || !a.order_id) continue;
    (porPedido[a.order_id] = porPedido[a.order_id] || []).push(a);
  }

  const novas = [];
  let pedidosArma = 0, redistribuidos = 0;
  // Carga atual (contratos em aberto por vendedor) pra distribuir as vendas sem vendedor
  const carga = {}; VENDEDORES_ATIVOS.forEach(v => { carga[v] = 0; });
  const orfaos = [];
  for (const [oid, arr] of Object.entries(porPedido)) {
    const abertas = arr.filter(a => a.status === 'pendente');
    if (!abertas.length) continue;
    const dono = _norm(abertas[0].owner_id || abertas[0].dono);
    if (VENDEDORES_ATIVOS.indexOf(dono) !== -1) carga[dono]++;
    else orfaos.push({ oid, abertas, dono });
  }
  // Migra contratos que estavam com a gerencia/sem vendedor (venda mais antiga primeiro)
  orfaos.sort((a, b) => String((a.abertas[0].contrato || {}).data_pedido || '').localeCompare(String((b.abertas[0].contrato || {}).data_pedido || '')));
  const migradas = [];
  for (const of of orfaos) {
    const novo = _escolherBalanceado(carga, of.oid); carga[novo]++;
    for (const t of of.abertas) {
      Object.assign(t, { owner_id: novo, dono: novo, distribuido_automaticamente: true, distribuido_de: of.dono || null, sem_vendedor_bling: true,
        atualizado_em: agoraISO, atualizado_por: 'contratos-arma' });
      migradas.push(t.id);
    }
    redistribuidos++;
  }
  // pedidos novos entram em ordem cronologica (distribuicao justa)
  orders = orders.slice().sort((a, b) => String(a && a.data_pedido || '').localeCompare(String(b && b.data_pedido || '')));
  for (const o of orders) {
    if (!o || !o.data_pedido || o.data_pedido < desde) continue;
    if (o.status === 'cancelado' || o.status === 'devolvido') continue;
    const itens = itensArma(o);
    if (!itens.length) continue;
    pedidosArma++;
    const existentes = porPedido[o.id] || [];
    const acc = accMap[o.account_id] || null;
    const c = Object.assign(_resumoContrato(o, acc, itens), { account_id: o.account_id || null });

    let envio = existentes.find(a => a.tipo === 'contrato_envio');
    let assin = existentes.find(a => a.tipo === 'contrato_assinatura');
    if (!envio && !assin) {
      let dono = responsavel(o, acc), semVend = false;
      if (!dono) { dono = _escolherBalanceado(carga, o.id); semVend = true; }
      carga[dono] = (carga[dono] || 0) + 1;
      envio = _novaEnvio(c, dono, agoraISO);
      assin = _novaAssinatura(c, dono, agoraISO);
      if (semVend) { envio.sem_vendedor_bling = assin.sem_vendedor_bling = true; envio.distribuido_automaticamente = assin.distribuido_automaticamente = true; }
      novas.push(envio, assin);
      continue;
    }
    // Cobranca automatica: assinatura disponivel ha mais de 24h e ainda pendente,
    // sem cobranca aberta.
    // So cobra o cliente se o contrato JA FOI ENVIADO (se nem foi enviado, o
    // atraso e do vendedor — aparece como contrato atrasado pra gestao).
    const enviadoEm = envio && envio.status === 'concluida' ? Date.parse(envio.concluida_em || '') : NaN;
    if (assin && assin.status === 'pendente' && !isNaN(enviadoEm) &&
        agora.getTime() - enviadoEm >= HORAS_ASSINATURA * 3600e3) {
      const cobrancas = existentes.filter(a => a.tipo === 'contrato_cobranca');
      const aberta = cobrancas.some(a => a.status === 'pendente');
      // no maximo 1 cobranca automatica a cada 3 dias
      const ultima = cobrancas.map(a => a.criado_em || '').sort().pop();
      const recente = ultima && agora.getTime() - Date.parse(ultima) < 3 * 86400e3;
      if (!aberta && !recente) {
        novas.push(_novaCobranca(Object.assign({}, assin.contrato || c), assin.owner_id || assin.dono, agoraISO, cobrancas.length + 1));
      }
    }
  }

  if ((novas.length || migradas.length) && !opts.simular) {
    for (const t of novas) actsCol[t.id] = t;
    await crmStore.saveCollection('activities', actsCol, 'Contratos de arma: +' + novas.length + ' tarefas' + (redistribuidos ? ', ' + redistribuidos + ' redistribuidos' : ''));
  }
  return {
    ok: true,
    pedidos_arma_no_periodo: pedidosArma,
    tarefas_criadas: novas.length,
    redistribuidos_sem_vendedor: redistribuidos,
    carga_por_vendedor: carga,
    por_tipo: novas.reduce((m, t) => { m[t.tipo] = (m[t.tipo] || 0) + 1; return m; }, {}),
    desde,
  };
}

// ─── Acoes do vendedor numa tarefa de contrato ──────────────────────
// acao: 'enviado' (envio) | 'salvo_assinado' (assinatura) |
//       'nao_devolveu' (assinatura) | 'cliente_avisado' (cobranca)
async function registrarAcao(taskId, acao, sess, payload) {
  payload = payload || {};
  const login = _norm(sess && sess.usuario);
  const col = await crmStore.getCollection('activities');
  const t = col[taskId];
  if (!t || t.fonte !== 'contrato_arma') { const e = new Error('Tarefa de contrato não encontrada.'); e.status = 404; throw e; }
  const dono = _norm(t.owner_id || t.dono);
  const gestao = sess && (sess.role === 'admin' || sess.role === 'diretor');
  if (dono !== login && !gestao) { const e = new Error('Esta tarefa não está atribuída a você.'); e.status = 403; throw e; }
  if (t.status !== 'pendente') { const e = new Error('Esta tarefa já foi finalizada.'); e.status = 409; throw e; }
  const agoraISO = new Date().toISOString();
  const canal = ['whatsapp', 'email', 'presencial', 'ligacao'].indexOf(payload.canal) !== -1 ? payload.canal : null;
  const obs = payload.observacao ? String(payload.observacao).trim().slice(0, 500) : null;
  const fechar = (resultado, extra) => Object.assign(t, {
    status: 'concluida', resultado, concluida_em: agoraISO, concluida_por: login,
    atualizado_em: agoraISO, atualizado_por: login,
  }, extra || {});
  const criadas = [];

  if (acao === 'anular') {
    // Vendedor "apaga" o contrato da operacao: some das filas (fica so na auditoria da gestao)
    const motivo = MOTIVOS_ANULACAO[payload.motivo] ? payload.motivo : null;
    const desc = payload.descricao ? String(payload.descricao).trim().slice(0, 600) : '';
    if (!motivo) throw Object.assign(new Error('Escolha o motivo da anulação.'), { status: 400 });
    if (desc.length < 15) throw Object.assign(new Error('Descreva a situação (mínimo 15 caracteres).'), { status: 400 });
    const anulacao = { motivo, motivo_label: MOTIVOS_ANULACAO[motivo], descricao: desc, por: login, em: agoraISO };
    for (const a of Object.values(col)) {
      if (a && a.fonte === 'contrato_arma' && a.order_id === t.order_id && a.status === 'pendente') {
        Object.assign(a, { status: 'cancelada', resultado: 'anulada', cancelada_em: agoraISO, cancelada_por: login,
          cancelamento_motivo: 'Contrato anulado: ' + MOTIVOS_ANULACAO[motivo], anulacao, atualizado_em: agoraISO, atualizado_por: login });
      }
    }
    await crmStore.saveCollection('activities', col, 'Contrato de arma anulado (' + (t.contrato && t.contrato.bling_numero || t.order_id) + '): ' + motivo);
    return { ok: true, anulado: true };
  } else if (acao === 'gerado') {
    // Etapa 1: contrato gerado (pelo gerador do dashboard ou fora dele). A tarefa continua aberta.
    if (t.tipo !== 'contrato_envio') throw Object.assign(new Error('Ação inválida para esta tarefa.'), { status: 400 });
    Object.assign(t, { contrato_gerado_em: agoraISO, contrato_gerado_por: login, contrato_gerado_fora: !!payload.fora_do_sistema, atualizado_em: agoraISO, atualizado_por: login });
  } else if (acao === 'enviado') {
    if (t.tipo !== 'contrato_envio') throw Object.assign(new Error('Ação inválida para esta tarefa.'), { status: 400 });
    if (!canal) throw Object.assign(new Error('Informe por onde o contrato foi enviado.'), { status: 400 });
    fechar('contrato_enviado', { canal_envio: canal, observacao_conclusao: obs });
  } else if (acao === 'salvo_assinado') {
    if (t.tipo !== 'contrato_assinatura') throw Object.assign(new Error('Ação inválida para esta tarefa.'), { status: 400 });
    if (!payload.confirmo) throw Object.assign(new Error('Confirme que o contrato ASSINADO está salvo na pasta.'), { status: 400 });
    fechar('contrato_assinado', {
      declaracao: { texto: 'Declaro que o contrato assinado pelo cliente está salvo na pasta de contratos.', por: login, em: agoraISO },
      verificacao: { status: 'pendente' },
      observacao_conclusao: obs,
    });
    // Se o cliente assinou direto (ex: na loja) sem o "enviado" ter sido marcado,
    // fecha a etapa de envio junto — a operacao andou, o registro acompanha.
    for (const a of Object.values(col)) {
      if (a && a.fonte === 'contrato_arma' && a.order_id === t.order_id && a.tipo === 'contrato_envio' && a.status === 'pendente') {
        Object.assign(a, { status: 'concluida', resultado: 'contrato_enviado', canal_envio: canal || 'presencial', concluida_em: agoraISO, concluida_por: login,
          contrato_gerado_em: a.contrato_gerado_em || agoraISO, observacao_conclusao: 'Fechado junto com o contrato assinado', atualizado_em: agoraISO, atualizado_por: login });
      }
    }
    // Fecha cobrancas abertas do mesmo pedido
    for (const a of Object.values(col)) {
      if (a && a.fonte === 'contrato_arma' && a.order_id === t.order_id && a.tipo === 'contrato_cobranca' && a.status === 'pendente') {
        Object.assign(a, { status: 'concluida', resultado: 'resolvida_assinatura', concluida_em: agoraISO, concluida_por: 'contratos-arma', atualizado_em: agoraISO, atualizado_por: 'contratos-arma' });
      }
    }
  } else if (acao === 'nao_devolveu') {
    if (t.tipo !== 'contrato_assinatura') throw Object.assign(new Error('Ação inválida para esta tarefa.'), { status: 400 });
    // A tarefa de assinatura CONTINUA aberta; cria a ligacao de aviso (se nao houver aberta)
    const aberta = Object.values(col).some(a => a && a.fonte === 'contrato_arma' && a.order_id === t.order_id && a.tipo === 'contrato_cobranca' && a.status === 'pendente');
    t.nao_devolveu_registros = (t.nao_devolveu_registros || []).concat([{ por: login, em: agoraISO }]);
    t.atualizado_em = agoraISO; t.atualizado_por = login;
    if (!aberta) {
      const n = Object.values(col).filter(a => a && a.order_id === t.order_id && a.tipo === 'contrato_cobranca').length;
      const cob = _novaCobranca(t.contrato || {}, t.owner_id || t.dono, agoraISO, n + 1);
      col[cob.id] = cob; criadas.push(cob.id);
    }
  } else if (acao === 'cliente_avisado') {
    if (t.tipo !== 'contrato_cobranca') throw Object.assign(new Error('Ação inválida para esta tarefa.'), { status: 400 });
    if (!canal) throw Object.assign(new Error('Informe como o cliente foi avisado.'), { status: 400 });
    fechar('cliente_avisado', { canal_contato: canal, observacao_conclusao: obs });
  } else {
    throw Object.assign(new Error('Ação desconhecida.'), { status: 400 });
  }
  col[taskId] = t;
  await crmStore.saveCollection('activities', col, 'Contrato de arma: ' + acao + ' (' + (t.contrato && t.contrato.bling_numero || t.order_id) + ')');
  return { ok: true, tarefa: t, criadas };
}

// Gestao confere se o contrato declarado como salvo esta mesmo na pasta.
async function verificar(taskId, sess, ok, obs) {
  const col = await crmStore.getCollection('activities');
  const t = col[taskId];
  if (!t || t.tipo !== 'contrato_assinatura' || t.resultado !== 'contrato_assinado') {
    throw Object.assign(new Error('Contrato declarado não encontrado.'), { status: 404 });
  }
  t.verificacao = { status: ok ? 'conferido' : 'nao_encontrado', por: _norm(sess.usuario), em: new Date().toISOString(), obs: obs ? String(obs).slice(0, 300) : null };
  col[taskId] = t;
  await crmStore.saveCollection('activities', col, 'Contrato de arma: verificação ' + t.verificacao.status);
  return { ok: true, verificacao: t.verificacao };
}

// ─── Cards operacionais (1 por venda) ───────────────────────────────
// Etapas: 1 Gerar contrato · 2 Enviar ao cliente · 3 Assinado e salvo na pasta
//         · 4 Conferido pela gestao. Devolve so as vendas com etapa do vendedor
// em aberto (ou todas, se opts.todas).
function cards(activities, login, agora, opts) {
  agora = agora || new Date(); opts = opts || {};
  const lg = login ? _norm(login) : null;
  const porPedido = {};
  for (const a of activities || []) {
    if (!a || a.fonte !== 'contrato_arma' || !a.order_id) continue;
    (porPedido[a.order_id] = porPedido[a.order_id] || []).push(a);
  }
  const out = [];
  for (const [orderId, arr] of Object.entries(porPedido)) {
    const envio = arr.find(a => a.tipo === 'contrato_envio');
    const assin = arr.find(a => a.tipo === 'contrato_assinatura');
    const cobr = arr.filter(a => a.tipo === 'contrato_cobranca');
    const ref = envio || assin; if (!ref) continue;
    const dono = _norm(ref.owner_id || ref.dono);
    if (lg && dono !== lg) continue;
    if ((envio && envio.status === 'cancelada') || (assin && assin.status === 'cancelada')) continue;
    const c = ref.contrato || {};
    const enviado = envio && envio.status === 'concluida';
    const salvo = assin && assin.resultado === 'contrato_assinado';
    const verif = salvo && assin.verificacao ? assin.verificacao.status : null;
    if (!opts.todas && salvo && verif !== 'nao_encontrado') continue; // nada mais a fazer pelo vendedor
    const etapa = !enviado ? (envio && envio.contrato_gerado_em ? 2 : 1) : (!salvo ? 3 : 4);
    const enviadoEm = enviado ? envio.concluida_em : null;
    const limiteAssin = enviadoEm ? new Date(Date.parse(enviadoEm) + HORAS_ASSINATURA * 3600e3).toISOString() : null;
    const hojeBRT = _dataBRT(agora.toISOString());
    const prazoEnvio = envio && envio.prazo;
    const atrasado = etapa <= 2 ? !!(prazoEnvio && prazoEnvio < hojeBRT) : (etapa === 3 ? !!(limiteAssin && limiteAssin < agora.toISOString()) : false);
    const cobAberta = cobr.find(a => a.status === 'pendente');
    out.push({
      order_id: orderId, dono,
      bling_numero: c.bling_numero || null, data_pedido: c.data_pedido || null,
      dias_venda: c.data_pedido ? Math.max(0, Math.floor((agora.getTime() - Date.parse(c.data_pedido + 'T15:00:00Z')) / 86400e3)) : null,
      valor_total: c.valor_total || 0, bling_conta: c.bling_conta || null,
      cliente_nome: c.cliente_nome || null, cliente_doc: c.cliente_doc || null, cliente_telefone: c.cliente_telefone || null,
      account_id: c.account_id || ref.account_id || null,
      armas: c.armas || [],
      etapa, atrasado,
      etapas: {
        gerado_em: (envio && envio.contrato_gerado_em) || null,
        enviado_em: enviadoEm, canal_envio: enviado ? (envio.canal_envio || null) : null,
        devolucao_ate: limiteAssin,
        salvo_em: salvo ? assin.concluida_em : null,
        verificacao: verif, verificado_em: salvo && assin.verificacao ? assin.verificacao.em || null : null,
      },
      prazo_envio: prazoEnvio || null,
      avisos_cancelamento: cobr.filter(a => a.resultado === 'cliente_avisado').length,
      nao_devolveu_registros: assin && Array.isArray(assin.nao_devolveu_registros) ? assin.nao_devolveu_registros.length : 0,
      cobranca: cobAberta ? { id: cobAberta.id, pitch: cobAberta.pitch_pronto || null } : null,
      ids: { envio: envio ? envio.id : null, assinatura: assin ? assin.id : null },
      distribuido: !!ref.distribuido_automaticamente,
    });
  }
  // atrasado e cobranca primeiro; depois o que ja esta em andamento (etapa maior); depois a venda mais antiga
  out.sort((a, b) => (b.atrasado - a.atrasado) || (b.cobranca ? 1 : 0) - (a.cobranca ? 1 : 0) || (b.etapa - a.etapa) || ((b.dias_venda || 0) - (a.dias_venda || 0)));
  return out;
}

// ─── Painel da gestao (puro) ────────────────────────────────────────
// Agrupa por pedido e devolve a situacao de cada contrato.
function painel(activities, agora) {
  agora = agora || new Date();
  const porPedido = {};
  for (const a of activities || []) {
    if (!a || a.fonte !== 'contrato_arma' || !a.order_id) continue;
    (porPedido[a.order_id] = porPedido[a.order_id] || []).push(a);
  }
  const linhas = [];
  const tot = { total: 0, aguardando_envio: 0, aguardando_assinatura: 0, sem_assinatura_atrasado: 0, assinados: 0, a_conferir: 0, nao_encontrado: 0 };
  const porVendedor = {};
  for (const [orderId, arr] of Object.entries(porPedido)) {
    const envio = arr.find(a => a.tipo === 'contrato_envio');
    const assin = arr.find(a => a.tipo === 'contrato_assinatura');
    const c = (envio && envio.contrato) || (assin && assin.contrato) || {};
    const dono = _norm((assin || envio || {}).owner_id || (assin || envio || {}).dono);
    let situacao, dias = 0;
    const base = Date.parse((envio && envio.criado_em) || (assin && assin.criado_em) || agora.toISOString());
    dias = Math.max(0, Math.floor((agora.getTime() - base) / 86400e3));
    const anul = arr.find(a => a.anulacao);
    if (anul) situacao = 'anulado';
    else if (envio && envio.status === 'cancelada' && (!assin || assin.status === 'cancelada')) situacao = 'cancelado';
    else if (assin && assin.resultado === 'contrato_assinado') {
      const v = assin.verificacao && assin.verificacao.status;
      situacao = v === 'nao_encontrado' ? 'nao_encontrado' : (v === 'conferido' ? 'conferido' : 'assinado_a_conferir');
    } else if (envio && envio.status === 'pendente') situacao = 'aguardando_envio';
    else {
      const env = Date.parse((envio && envio.concluida_em) || '') || base;
      situacao = (agora.getTime() - env) >= HORAS_ASSINATURA * 3600e3 ? 'sem_assinatura_atrasado' : 'aguardando_assinatura';
    }
    if (situacao === 'cancelado') continue;
    if (situacao === 'anulado') {
      tot.anulados = (tot.anulados || 0) + 1;
      linhas.push({ order_id: orderId, bling_numero: c.bling_numero || null, data_pedido: c.data_pedido || null, cliente_nome: c.cliente_nome || null,
        valor_total: c.valor_total || 0, armas: (c.armas || []).map(x => x.descricao), vendedor: dono, situacao, dias,
        dias_venda: c.data_pedido ? Math.max(0, Math.floor((agora.getTime() - Date.parse(c.data_pedido + 'T15:00:00Z')) / 86400e3)) : null,
        anulacao: anul.anulacao });
      continue;
    }
    tot.total++;
    if (situacao === 'aguardando_envio') tot.aguardando_envio++;
    if (situacao === 'aguardando_assinatura') tot.aguardando_assinatura++;
    if (situacao === 'sem_assinatura_atrasado') tot.sem_assinatura_atrasado++;
    if (situacao === 'conferido' || situacao === 'assinado_a_conferir') tot.assinados++;
    if (situacao === 'assinado_a_conferir') tot.a_conferir++;
    if (situacao === 'nao_encontrado') tot.nao_encontrado++;
    const pv = porVendedor[dono] = porVendedor[dono] || { login: dono, total: 0, pendentes: 0, atrasados: 0, assinados: 0, nao_encontrado: 0 };
    pv.total++;
    if (situacao === 'aguardando_envio' || situacao === 'aguardando_assinatura' || situacao === 'sem_assinatura_atrasado') pv.pendentes++;
    if (situacao === 'sem_assinatura_atrasado' || (situacao === 'aguardando_envio' && dias >= 1)) pv.atrasados++;
    if (situacao === 'conferido' || situacao === 'assinado_a_conferir') pv.assinados++;
    if (situacao === 'nao_encontrado') pv.nao_encontrado++;
    linhas.push({
      order_id: orderId, bling_numero: c.bling_numero || null, data_pedido: c.data_pedido || null,
      cliente_nome: c.cliente_nome || null, valor_total: c.valor_total || 0,
      armas: (c.armas || []).map(x => x.descricao), vendedor: dono, situacao, dias,
      dias_venda: c.data_pedido ? Math.max(0, Math.floor((agora.getTime() - Date.parse(c.data_pedido + 'T15:00:00Z')) / 86400e3)) : null,
      envio_em: envio && envio.concluida_em || null, canal_envio: envio && envio.canal_envio || null,
      assinado_declarado_em: assin && assin.resultado === 'contrato_assinado' ? assin.concluida_em : null,
      tarefa_assinatura_id: assin ? assin.id : null,
      avisos_cancelamento: arr.filter(a => a.tipo === 'contrato_cobranca' && a.resultado === 'cliente_avisado').length,
    });
  }
  const ordem = { nao_encontrado: 0, sem_assinatura_atrasado: 1, aguardando_envio: 2, aguardando_assinatura: 3, assinado_a_conferir: 4, conferido: 5, anulado: 6 };
  linhas.sort((a, b) => (ordem[a.situacao] - ordem[b.situacao]) || ((b.dias_venda || 0) - (a.dias_venda || 0)));
  return { totais: tot, por_vendedor: Object.values(porVendedor), linhas };
}

module.exports = {
  ehArmaDeFogo, itensArma, responsavel, processar, registrarAcao, verificar, painel, cards, MOTIVOS_ANULACAO,
  RETROATIVO_DIAS, HORAS_ASSINATURA, HORAS_COBRANCA,
};
