// lib/crm/automacaoUpsell.js
// Motor de oportunidades comerciais — Camada 4 do "cerebro" do CRM.
//
// Duas frentes:
//
//   1) processarOrderNovo(orderId, vendedor) — disparado LOGO APOS um pedido
//      novo entrar no CRM (via sync do Bling). Gera 1 tarefa "upsell pos-venda"
//      pro vendedor original abordar o cliente enquanto ele ainda esta quente.
//
//   2) gerarTarefasDiarias() — cron diaria. Analisa TODA a base de clientes e
//      gera 20 tarefas NOVAS/dia por vendedor (cota diaria pelo lote_dia; as
//      pendentes de dias anteriores NAO somem nem reduzem a cota — acumulam).
//      Fontes (rodizio pra variedade; reserva so completa):
//
//        a) Reativacao com match (60-180 dias sumido + coocorrencia forte)
//        b) Cross-sell (comprou algo ha >=30 dias e nao levou complemento obvio)
//        c) Aniversario (355-380 dias da primeira compra)
//        d) Carteira parada (cliente com temperatura sem contato ha N dias)
//        e) RESERVA: reativacao longa (181-720 dias sem comprar)
//
//      Se sobrar folga, completa com candidatos de menor score (nao deixa dia
//      vazio pro vendedor). Dono da tarefa = vendedor da ultima venda do
//      cliente (fallback: account.owner_id, depois "gerencia").
//
// Anti-duplicata: trigger_id "<fonte>_<accountId>_<semana>" evita gerar a
// mesma tarefa duas vezes na semana.
//
// Ranking e pitch: usa heuristica pura (rapida, sem custo). O pitch com IA
// (via sugerirParaCliente) fica sob demanda no endpoint /api/crm/sugerir,
// disparado quando o vendedor abre a tarefa no dashboard.

const crmStore     = require('./store');
const crmColl      = require('./collections');
const { uuid }     = require('./utils');
const coocorrencia = require('./coocorrencia');
const { sugerirParaCliente } = require('./sugerir');

// ─── Parametros ─────────────────────────────────────────────────
const TAREFAS_POR_VENDEDOR   = 20;
const REATIVACAO_MIN_DIAS    = 60;
const REATIVACAO_MAX_DIAS    = 180;
const CROSSSELL_MIN_DIAS     = 30;   // ultima compra ≥ 30d atras
const CROSSSELL_CONF_MIN     = 0.20; // so cross-sell com coocorrencia razoavel
const REATIVACAO_CONF_MIN    = 0.10; // reativacao aceita coocorrencia mais fraca
const ANIVERSARIO_MIN_DIAS   = 355;
const ANIVERSARIO_MAX_DIAS   = 380;
const PRAZO_TAREFA_DIAS      = 5;
const PRAZO_ANIVERSARIO_DIAS = 14;

// INTERVALO MINIMO POR CLIENTE (cross-fonte, por CPF) ─────────────
// Trava global por cliente: nao importa a fonte (reativacao, cross-sell,
// aniversario, carteira, reserva), o mesmo cliente NAO recebe uma nova tarefa
// automatica se ja tem uma tarefa automatica PENDENTE ou se recebeu qualquer
// tarefa automatica nos ultimos INTERVALO_MIN_CLIENTE_DIAS dias. Agrupa por
// CPF/CNPJ (nao por account_id), entao clientes duplicados — varias fichas com
// o mesmo documento — contam como UM so. Isso evita empilhar 2 tarefas do mesmo
// cliente em janela curta e inflar as metricas negativas (atrasadas) dos
// vendedores. O _estaBloqueado por-fonte continua valendo por cima (ex.: nao
// repetir a MESMA fonte dentro do COOLDOWN pos-conclusao).
const INTERVALO_MIN_CLIENTE_DIAS = 21;

// Fonte de RESERVA: cliente sumido ha muito tempo (6 meses a 2 anos). So
// completa a cota do dia DEPOIS que as fontes principais esgotam — garante que
// o vendedor receba as 20 do dia mesmo quando a base "quente" ja foi trabalhada.
const REATIVACAO_LONGA_MIN_DIAS = 181;
const REATIVACAO_LONGA_MAX_DIAS = 720;
const FONTES_RESERVA = ['reativacao_longa'];

// Minha Carteira: cliente que o vendedor marcou com temperatura e ficou sem
// contato ha N dias volta como tarefa ("esfriando, retoma").
const CARTEIRA_PARADO_DIAS = { quente: 7, morno: 15, frio: 45 };
const PRAZO_CARTEIRA_DIAS  = 2;

// Pos-venda (processarOrderNovo)
const POSVENDA_PRAZO_DIAS    = 5;
const POSVENDA_CONF_MIN      = 0.30;

// Vendedores ativos — pool pra rodizio quando conta nao tem vendedor definido.
// Cada login DEVE bater exatamente com sess.usuario (case-insensitive) do CRM.
// Se sair vendedor / entrar novo, editar aqui.
const VENDEDORES_ATIVOS = ['dickmann', 'boschetto', 'mathias'];

// ═══════════════════════════════════════════════════════════════
// FRENTE 1 — Pos-venda (por pedido)
// ═══════════════════════════════════════════════════════════════

async function processarOrderNovo(orderId, ownerVendedor) {
  try {
    const order = await crmStore.getDoc('orders', orderId);
    if (!order) return { ok: false, motivo: 'order nao encontrado' };

    // Idempotencia: se ja rodou pra este order, nao roda de novo
    const triggerId = 'posvenda_' + orderId;
    const jaFeitas = await crmStore.listDocs('activities', a => a.trigger_id === triggerId);
    if (jaFeitas.length) return { ok: true, motivo: 'ja processado', tarefas: 0 };

    const r = await sugerirParaCliente({ accountId: order.account_id, orderId });
    const sugestoesFortes = (r.sugestoes || []).filter(s => (s.confianca || 0) >= POSVENDA_CONF_MIN);
    if (!sugestoesFortes.length) return { ok: true, motivo: 'sem sugestoes fortes', tarefas: 0 };

    const account = await crmStore.getDoc('accounts', order.account_id);
    // Aplica a mesma logica do motor diario: so aceita como dono quem esta em
    // VENDEDORES_ATIVOS. Caso contrario, cai no rodizio deterministico. Isso
    // impede que tarefas de pos-venda parem em 'gerencia' quando o Bling nao
    // trouxe vendedor mapeado — antes ficavam empilhadas pro admin resolver.
    // Prioridade: owner explicito > vendedor do pedido > owner da conta.
    // _resolverDonoFinal aplica rodizio só pra pseudo-vendedor (tray/gerencia)
    // ou vazio, e aplica mapeamento (jonatas→mathias) quando aplicável.
    const bruto = _normLogin(ownerVendedor || order.vendedor_id || (account && account.owner_id));
    const vendedor = _resolverDonoFinal(bruto, order.account_id);
    const brutoDiferente = bruto !== vendedor;

    // Realoca account + order pro novo dono SÓ se mudamos de vendedor
    // (seja via rodizio por pseudo-vendedor, seja via mapeamento de desligado).
    // Isso resolve "cliente nao lhe pertence" — vendedor precisa ser owner_id
    // do account pra abrir a ficha e evoluir tarefa.
    if (brutoDiferente) {
      await _realocarAccountSeOrfao(order.account_id, vendedor, 'automacao-posvenda');
      await _realocarOrderSeOrfao(orderId, vendedor, 'automacao-posvenda');
    }

    // Cria 1 activity unica agregando as sugestoes (evita spam)
    const doc = _buildAct({
      tipo: 'trigger',
      owner_id: vendedor,
      entidade_id: order.account_id,
      titulo: '💰 Upsell pos-venda — ' + ((account && account.nome) || order.account_id),
      descricao: _descricaoPosVenda(account, order, sugestoesFortes),
      prazo: _hojeMais(POSVENDA_PRAZO_DIAS),
      pontos_base: 20,
      trigger_id: triggerId,
      // Campos extras (nao no schema, mas persistem):
      fonte: 'posvenda',
      account_id: order.account_id,
      order_id: orderId,
      sku_sugerido: sugestoesFortes[0].sku_bling,
      sku_sugerido_descricao: sugestoesFortes[0].nome,
      motivo_curto: sugestoesFortes[0].motivo,
      pitch_pronto: sugestoesFortes[0].pitch || null,
      sugestoes_json: sugestoesFortes,
      dono: vendedor, // retrocompat: o filtro do /tarefas/minhas aceita 'dono' OU 'owner_id'
    });

    await crmStore.createDoc('activities', doc, 'automacao-posvenda');
    return { ok: true, tarefas: 1, activity_id: doc.id, sugestoes: sugestoesFortes.length };
  } catch (e) {
    return { ok: false, motivo: (e.message || String(e)).slice(0, 200) };
  }
}

// ═══════════════════════════════════════════════════════════════
// FRENTE 2 — Motor diario de oportunidades
// ═══════════════════════════════════════════════════════════════

// Chave de "cliente" pro intervalo minimo. Prioriza CPF/CNPJ (so digitos) pra
// tratar fichas duplicadas do mesmo documento como um unico cliente; cai pro
// account_id so quando a ficha nao tem documento valido.
function _clienteKey(acc) {
  const cpf = String((acc && acc.cpf_cnpj) || '').replace(/\D+/g, '');
  if (cpf.length >= 11) return 'cpf:' + cpf;
  return 'acc:' + ((acc && acc.id) || '');
}

async function gerarTarefasDiarias() {
  const inicio = Date.now();
  const hoje = _hojeISO();

  // Carrega dados de uma vez (cache do store agrupa)
  const accounts = await crmStore.listDocs('accounts',
    a => a.status !== 'inativo' && a.status !== 'bloqueado');
  const orders = await crmStore.listDocs('orders',
    o => o.status !== 'cancelado' && o.status !== 'devolvido');
  // Pega TODAS as activities automaticas recentes (pendentes OU concluidas nos
  // ultimos COOLDOWN_DIAS). Monta um mapa (accountId -> Set<fonte>) de
  // bloqueios: se tem tarefa pendente OU recem-concluida pra esse account
  // dessa mesma fonte, nao cria nova. Isso resolve 2 problemas de uma vez:
  //   1) Vendedor nao recebe tarefa duplicada do mesmo cliente/fonte enquanto
  //      ela esta pendente ou foi concluida ha pouco (nao liga 2x na mesma semana).
  //   2) Clientes com tarefa pendente nao bloqueiam a geracao de novas tarefas
  //      pra OUTROS clientes — o cron agora pode rodar diariamente e preencher
  //      a cota com clientes diferentes a cada dia.
  const COOLDOWN_DIAS = 14; // cooldown pos-conclusao (14 dias = nao ligar 2x no mes)
  const cutoffISO = _hojeMenos(COOLDOWN_DIAS);
  const cutoffClienteISO = _hojeMenos(INTERVALO_MIN_CLIENTE_DIAS); // trava cross-fonte por CPF
  const hojeBRT = _hojeBRT();
  const todasActs = await crmStore.listDocs('activities');

  // Mapa accountId -> clienteKey (CPF quando houver). Usado tanto pra montar a
  // trava de intervalo por cliente quanto pra deduplicar candidatos de fichas
  // diferentes que compartilham o mesmo documento.
  const clienteKeyPorAccount = {};
  for (const acc of accounts) clienteKeyPorAccount[acc.id] = _clienteKey(acc);
  // Clientes (por CPF) bloqueados pra NOVAS tarefas automaticas: tem tarefa
  // automatica pendente OU receberam uma tarefa automatica ha menos de
  // INTERVALO_MIN_CLIENTE_DIAS dias. Cross-fonte: vale pra qualquer fonte.
  const clientesBloqueadosIntervalo = new Set();

  // ── COTA DIARIA (regra nova) ─────────────────────────────────────
  // Cada vendedor recebe TAREFAS_POR_VENDEDOR tarefas NOVAS por dia, sempre.
  // A cota NAO olha as pendentes: o que nao foi executado continua na fila e
  // ACUMULA — e isso que mostra pra gestao quem esta (ou nao) trabalhando.
  // Idempotente no dia: se o cron rodar 2x, a segunda rodada so completa o que
  // faltou das 20 de HOJE (conta pelo lote_dia gravado em cada tarefa).
  const criadasHojePorVendedor = {};
  // Ultimo contato por cliente (tarefa finalizada ou WhatsApp registrado) —
  // usado pela fonte "carteira_parado".
  const ultimoContatoPorAccount = {};
  // Clientes que JA tem qualquer tarefa aberta — a carteira nao empilha outra.
  const accountsComTarefaAberta = new Set();
  for (const a of todasActs) {
    const owner = _normLogin(a.owner_id || a.dono);
    const ehDoGerador = a.gerada_automaticamente &&
      (a.lote_dia === hojeBRT || (a.criado_por === 'cron-oportunidades' && _dataBRT(a.criado_em) === hojeBRT));
    if (ehDoGerador && owner) criadasHojePorVendedor[owner] = (criadasHojePorVendedor[owner] || 0) + 1;
    const accId = a.account_id || a.entidade_id;
    if (!accId) continue;
    // Trava de intervalo por cliente (cross-fonte, por CPF). So tarefas
    // automaticas nao-canceladas contam. Bloqueia se: pendente (ja tem tarefa
    // em aberto) OU criada ha menos de INTERVALO_MIN_CLIENTE_DIAS dias.
    if (a.gerada_automaticamente && a.status !== 'cancelada') {
      const criadaEm = String(a.criado_em || a.lote_dia || '').slice(0, 10);
      if (a.status === 'pendente' || (criadaEm && criadaEm >= cutoffClienteISO)) {
        const ck = clienteKeyPorAccount[accId] || ('acc:' + accId);
        clientesBloqueadosIntervalo.add(ck);
      }
    }
    if (a.status === 'pendente') accountsComTarefaAberta.add(accId);
    const toques = [];
    if (a.status === 'concluida') toques.push(a.concluida_em || a.concluido_em || a.atualizado_em);
    if (a.primeiro_contato_em) toques.push(a.primeiro_contato_em);
    for (const t of toques) {
      const d = String(t || '').slice(0, 10);
      if (d && (!ultimoContatoPorAccount[accId] || d > ultimoContatoPorAccount[accId])) ultimoContatoPorAccount[accId] = d;
    }
  }

  const activitiesRelevantes = todasActs.filter(a => {
    if (!a.gerada_automaticamente) return false;
    // Cancelada NAO bloqueia nem conta: se o vendedor julgou a tarefa invalida,
    // o cliente deve poder voltar ao pool numa proxima rodada.
    if (a.status === 'cancelada') return false;
    if (a.status === 'pendente') return true;
    // Concluida/outra: so se foi recente
    const quando = a.concluido_em || a.concluida_em || a.atualizado_em || a.criado_em || '';
    return String(quando).slice(0, 10) >= cutoffISO;
  });
  // Mapa (accountId -> Set<fonte>) dos bloqueios
  const bloqueado = new Map(); // key = accountId, value = Set de fontes bloqueadas
  // Contagem de tarefas PENDENTES automaticas por vendedor — usada pra cota.
  // Objetivo: cada vendedor tem no MAXIMO TAREFAS_POR_VENDEDOR pendentes. O cron
  // so cria o delta que falta pra completar a cota. Isso resolve 2 coisas:
  //   1) Rodar o cron varias vezes no dia NAO infla a fila (completa ate 20 e para).
  //   2) Se o vendedor nao concluiu nada, nao recebe tarefa nova (nao "vem as mesmas"
  //      nem acumula infinito) — so recebe quando abrir espaco concluindo.
  const pendentesPorVendedor = {};
  for (const a of activitiesRelevantes) {
    const accId = a.account_id || a.entidade_id;
    if (accId) {
      const fonte = a.fonte || _fonteDoTipo(a.tipo); // retrocompat
      if (fonte) {
        if (!bloqueado.has(accId)) bloqueado.set(accId, new Set());
        bloqueado.get(accId).add(fonte);
      }
    }
    if (a.status === 'pendente') {
      const owner = _normLogin(a.owner_id || a.dono);
      if (owner) pendentesPorVendedor[owner] = (pendentesPorVendedor[owner] || 0) + 1;
    }
  }
  function _estaBloqueado(accountId, fonte) {
    const s = bloqueado.get(accountId);
    return s && s.has(fonte);
  }

  // Agrupa pedidos por account, ordenados do mais novo pro mais velho
  const ordersPorAccount = {};
  for (const o of orders) {
    if (!o.account_id) continue;
    (ordersPorAccount[o.account_id] = ordersPorAccount[o.account_id] || []).push(o);
  }
  for (const acc of Object.keys(ordersPorAccount)) {
    ordersPorAccount[acc].sort((a, b) =>
      String(b.data_pedido || '').localeCompare(String(a.data_pedido || '')));
  }

  // Coleta candidatos das 3 fontes
  const candidatos = [];
  for (const acc of accounts) {
    // Trava de intervalo por cliente (CPF): se este cliente ja tem tarefa
    // automatica em aberto ou recebeu uma ha menos de INTERVALO_MIN_CLIENTE_DIAS
    // dias, pula TODAS as fontes dele agora. Evita 2 tarefas do mesmo cliente
    // numa janela curta (que so inflaria as metricas de atraso dos vendedores).
    if (clientesBloqueadosIntervalo.has(clienteKeyPorAccount[acc.id] || ('acc:' + acc.id))) continue;

    const meusPeds = ordersPorAccount[acc.id] || [];

    // Fonte 0 — Minha Carteira: cliente com temperatura definida pelo vendedor
    // (ou prospect cadastrado por ele) que ficou sem contato alem do limite.
    // Vem ANTES do "sem compra -> pula" porque prospect ainda nao comprou.
    const temp = acc.carteira_temperatura || (Array.isArray(acc.tags) && acc.tags.indexOf('prospect_vendedor') !== -1 ? 'morno' : null);
    if (temp && CARTEIRA_PARADO_DIAS[temp] && !accountsComTarefaAberta.has(acc.id)
        && !_estaBloqueado(acc.id, 'carteira_parado')) {
      const refContato = ultimoContatoPorAccount[acc.id] || String(acc.carteira_atualizado_em || acc.criado_em || '').slice(0, 10);
      const diasSemContato = refContato ? _diasEntre(refContato, hoje) : 999;
      if (diasSemContato >= CARTEIRA_PARADO_DIAS[temp]) {
        candidatos.push({
          accountId: acc.id, account: acc,
          fonte: 'carteira_parado',
          motivoCurto: 'Cliente ' + temp + ' da sua carteira sem contato ha ' + (diasSemContato >= 999 ? 'muito tempo' : diasSemContato + 'd'),
          sku_sugerido: null, sku_desc: null, sug_confianca: null,
          score: _scoreCarteira(acc, temp, diasSemContato),
          triggerId: 'cart_' + acc.id + '_' + hojeBRT,
          pedRef: meusPeds[0] || null,
          temperatura: temp,
        });
      }
    }

    if (!meusPeds.length && !acc.ultima_compra_em) continue;

    const ultimaData = acc.ultima_compra_em || (meusPeds[0] && meusPeds[0].data_pedido);
    if (!ultimaData) continue;
    const primeiraData = acc.primeira_compra_em || (meusPeds[meusPeds.length - 1] && meusPeds[meusPeds.length - 1].data_pedido);

    const diasUltima = _diasEntre(ultimaData, hoje);
    const diasPrimeira = primeiraData ? _diasEntre(primeiraData, hoje) : null;
    const skusJa = _skusUnicos(meusPeds);
    const pedRef = meusPeds[0]; // pedido de referencia (mais recente)

    // Fonte 1 — Reativacao com match
    // Pula se ja existe tarefa de reativacao pendente OU concluida ha < COOLDOWN_DIAS
    if (diasUltima >= REATIVACAO_MIN_DIAS && diasUltima <= REATIVACAO_MAX_DIAS
        && !_estaBloqueado(acc.id, 'reativacao_match')) {
      const sug = await _melhorSugestaoCooc(pedRef, skusJa, REATIVACAO_CONF_MIN);
      if (sug) {
        candidatos.push({
          accountId: acc.id, account: acc,
          fonte: 'reativacao_match',
          motivoCurto: 'Sumido ha ' + diasUltima + 'd — ideal p/ ' + _corta(sug.descricao, 40),
          sku_sugerido: sug.sku, sku_desc: sug.descricao, sug_confianca: sug.confianca,
          score: _scoreReativacao(acc, diasUltima, sug.confianca),
          // triggerId SEM data — dedupe acontece agora via _estaBloqueado acima.
          // Mantido pra retrocompatibilidade (outras partes do codigo olham ele),
          // mas nao e mais a chave de dedupe.
          triggerId: 'reativ_' + acc.id,
          pedRef,
        });
      }
    }

    // Fonte 2 — Cross-sell (comprou ha >=30d e tem cooc forte)
    if (diasUltima >= CROSSSELL_MIN_DIAS && diasUltima < REATIVACAO_MIN_DIAS
        && !_estaBloqueado(acc.id, 'cross_sell')) {
      const sug = await _melhorSugestaoCooc(pedRef, skusJa, CROSSSELL_CONF_MIN);
      if (sug) {
        const itemBase = pedRef && pedRef.itens && pedRef.itens[0];
        const nomeBase = itemBase ? (itemBase.descricao || itemBase.sku) : 'ultima compra';
        candidatos.push({
          accountId: acc.id, account: acc,
          fonte: 'cross_sell',
          motivoCurto: 'Comprou ' + _corta(nomeBase, 25) + ' — completa c/ ' + _corta(sug.descricao, 30),
          sku_sugerido: sug.sku, sku_desc: sug.descricao, sug_confianca: sug.confianca,
          score: _scoreCrossSell(acc, sug.confianca),
          triggerId: 'xsell_' + acc.id + '_' + sug.sku,
          pedRef,
        });
      }
    }

    // Fonte 3 — Aniversario de 1 ano
    if (diasPrimeira !== null && diasPrimeira >= ANIVERSARIO_MIN_DIAS && diasPrimeira <= ANIVERSARIO_MAX_DIAS
        && !_estaBloqueado(acc.id, 'aniversario')) {
      candidatos.push({
        accountId: acc.id, account: acc,
        fonte: 'aniversario',
        motivoCurto: '1 ano da 1a compra (' + primeiraData + ') — retomar contato',
        sku_sugerido: null, sku_desc: null, sug_confianca: null,
        score: _scoreAniversario(acc),
        triggerId: 'aniv_' + acc.id + '_' + (primeiraData || '').slice(0, 7),
        pedRef,
      });
    }

    // Fonte 4 (RESERVA) — Reativacao longa: sumido de 6 meses a 2 anos. So
    // entra na cota depois das fontes principais. A sugestao de produto e
    // calculada DEPOIS da selecao, so pras escolhidas (evita custo a toa).
    if (diasUltima >= REATIVACAO_LONGA_MIN_DIAS && diasUltima <= REATIVACAO_LONGA_MAX_DIAS
        && !_estaBloqueado(acc.id, 'reativacao_longa')) {
      candidatos.push({
        accountId: acc.id, account: acc,
        fonte: 'reativacao_longa',
        motivoCurto: 'Sem comprar ha ' + Math.round(diasUltima / 30) + ' meses — retomar relacionamento',
        sku_sugerido: null, sku_desc: null, sug_confianca: null,
        score: _scoreReativacaoLonga(acc, diasUltima),
        triggerId: 'reativl_' + acc.id,
        pedRef, skusJa, diasUltima,
      });
    }
  }

  // Nao filtra mais por triggerId — dedupe ja aconteceu no _estaBloqueado acima
  const novos = candidatos;

  // Dedupe por CLIENTE (CPF, com fallback account_id): se o mesmo cliente
  // aparece em 2 fontes — ou em 2 fichas diferentes com o mesmo documento —
  // fica so a de maior score. Garante no maximo 1 tarefa nova por cliente/rodada.
  const melhorPorCliente = {};
  for (const c of novos) {
    const ck = clienteKeyPorAccount[c.accountId] || _clienteKey(c.account);
    const atual = melhorPorCliente[ck];
    if (!atual || atual.score < c.score) melhorPorCliente[ck] = c;
  }
  const dedupados = Object.values(melhorPorCliente);

  // Agrupa por vendedor (dono da tarefa). Realoca account/orders órfãos
  // pro vendedor do rodizio — mas AGORA EM BATCH, nao mais 1 write por doc.
  //
  // ANTES: cada chamada de _realocarAccountSeOrfao fazia read+write no
  // accounts.json via GitHub API. Com 20+ candidatos orfaos, dava 40+ writes
  // em sequencia e varios 409 (SHA stale entre read e write subsequente).
  //
  // AGORA: coletamos todas as realocacoes em 2 Maps (uma pra accounts, outra
  // pra orders) enquanto montamos o porOwner. No final chamamos _flushRealoc*
  // uma unica vez pra cada collection — 1 write ao inves de 20-40, zero 409.
  // Candidato "flexivel" = cliente SEM dono real (orfao: gerencia/tray/vazio).
  // So esses podem ser redistribuidos — carteira de vendedor nunca e tocada.
  const porOwner = {};
  for (const v of VENDEDORES_ATIVOS) porOwner[v] = [];
  for (const c of dedupados) {
    const owner = _resolverVendedor(c.account, ordersPorAccount[c.accountId]);
    const ownerOriginal = _normLogin(c.account && c.account.owner_id);
    const flexivel = !_isVendedorReal(ownerOriginal);
    (porOwner[owner] = porOwner[owner] || []).push({ ...c, owner_id: owner, flexivel });
  }

  // COTA DO DIA = TAREFAS_POR_VENDEDOR - (ja criadas HOJE pra ele).
  // Pendentes de dias anteriores NAO reduzem a cota — elas ficam e acumulam.
  const finais = [];
  const cotaPorVendedor = {};
  const sobras = []; // flexiveis que o "dono do rodizio" nao precisou usar
  for (const owner of Object.keys(porOwner)) {
    porOwner[owner].sort((a, b) => b.score - a.score);
    const jaCriadasHoje = criadasHojePorVendedor[owner] || 0;
    const cota = Math.max(0, TAREFAS_POR_VENDEDOR - jaCriadasHoje);
    cotaPorVendedor[owner] = cota;
    // Rodizio entre fontes (variedade garantida); fontes de RESERVA so completam.
    const escolhidos = cota > 0 ? _selecionarBalanceado(porOwner[owner], cota) : [];
    finais.push(...escolhidos);
    const usados = new Set(escolhidos.map(c => c.accountId));
    for (const c of porOwner[owner]) if (c.flexivel && !usados.has(c.accountId)) sobras.push(c);
  }

  // Redistribuicao: quem nao chegou nas 20 de hoje recebe orfaos que sobraram
  // da lista de outro vendedor. Garante "20 por dia" mesmo com base desigual.
  const deficit = {};
  for (const owner of VENDEDORES_ATIVOS) {
    const recebidas = finais.filter(c => c.owner_id === owner).length;
    const falta = (cotaPorVendedor[owner] || 0) - recebidas;
    if (falta > 0) deficit[owner] = falta;
  }
  let redistribuidas = 0;
  if (Object.keys(deficit).length && sobras.length) {
    const jaUsados = new Set(finais.map(c => c.accountId));
    const pool = sobras.filter(c => !jaUsados.has(c.accountId)).sort((a, b) => b.score - a.score);
    for (const owner of Object.keys(deficit)) {
      if (!pool.length) break;
      const extra = _selecionarBalanceado(pool, deficit[owner]);
      for (const c of extra) {
        finais.push({ ...c, owner_id: owner, redistribuida: true });
        const idx = pool.indexOf(c); if (idx >= 0) pool.splice(idx, 1);
        redistribuidas++;
      }
    }
  }

  // Realoca SO os clientes orfaos que de fato viraram tarefa (antes realocava
  // todo candidato, mesmo sem tarefa). Batch: 1 write por colecao, sem 409.
  const realocAccounts = new Map(); // accountId -> novoDono
  const realocOrders = new Map();   // orderId -> novoDono
  for (const c of finais) {
    if (!c.flexivel) continue;
    realocAccounts.set(c.accountId, c.owner_id);
    for (const p of (ordersPorAccount[c.accountId] || [])) {
      if (!_isVendedorReal(_normLogin(p.vendedor_id))) realocOrders.set(p.id, c.owner_id);
    }
  }
  if (realocAccounts.size > 0) {
    try { await _flushRealocAccountsBatch(realocAccounts, 'automacao-cron-diario'); }
    catch (e) { console.warn('[automacaoUpsell] batch accounts falhou: ' + (e.message || e)); }
  }
  if (realocOrders.size > 0) {
    try { await _flushRealocOrdersBatch(realocOrders, 'automacao-cron-diario'); }
    catch (e) { console.warn('[automacaoUpsell] batch orders falhou: ' + (e.message || e)); }
  }

  // Sugestao de produto pra fonte de reserva — so pras escolhidas.
  for (const c of finais) {
    if (c.fonte !== 'reativacao_longa' || !c.pedRef) continue;
    try {
      const sug = await _melhorSugestaoCooc(c.pedRef, c.skusJa || new Set(), REATIVACAO_CONF_MIN);
      if (sug) {
        c.sku_sugerido = sug.sku; c.sku_desc = sug.descricao; c.sug_confianca = sug.confianca;
        c.motivoCurto = 'Sem comprar ha ' + Math.round((c.diasUltima || 0) / 30) + ' meses — ideal p/ ' + _corta(sug.descricao, 35);
      }
    } catch (_) {}
  }

  // Cria as activities em BULK — carrega a colecao uma vez, adiciona todas
  // em memoria, salva uma vez. Isso reduz drasticamente o tempo (era 25s+
  // com 30 escritas serializadas) e elimina o 409 (race condition entre
  // requests concorrentes na mesma cron ou entre cron+outros writes).
  let criadas = 0, erros = 0;
  const errosDetalhe = [];
  let acts;
  try {
    acts = await crmStore.getCollection('activities');
  } catch (e) {
    return {
      ok: false,
      duracao_ms: Date.now() - inicio,
      erro: 'Falha ao carregar activities: ' + (e.message || String(e)),
      contas_analisadas: accounts.length,
      candidatos_gerados: candidatos.length,
    };
  }

  const nowIso = new Date().toISOString();
  for (const c of finais) {
    try {
      const prazo = c.fonte === 'aniversario'
        ? _hojeMais(PRAZO_ANIVERSARIO_DIAS)
        : (c.fonte === 'carteira_parado' ? _hojeMais(PRAZO_CARTEIRA_DIAS) : _hojeMais(PRAZO_TAREFA_DIAS));
      const tipoAct = (c.fonte === 'reativacao_match' || c.fonte === 'reativacao_longa') ? 'reativacao'
        : (c.fonte === 'carteira_parado' ? 'contato' : 'trigger');
      const doc = _buildAct({
        tipo: tipoAct,
        owner_id: c.owner_id,
        entidade_id: c.accountId,
        titulo: _titulo(c),
        descricao: _descricao(c),
        prazo,
        pontos_base: Math.round(c.score),
        trigger_id: c.triggerId,
        fonte: c.fonte,
        account_id: c.accountId,
        sku_sugerido: c.sku_sugerido,
        sku_sugerido_descricao: c.sku_desc,
        motivo_curto: c.motivoCurto,
        sug_confianca: c.sug_confianca,
        dono: c.owner_id, // retrocompat filtro
      });
      // Lote do dia (data BRT) — base da cota diaria idempotente e das
      // metricas de acumulo ("tarefa de qual dia ainda esta aberta").
      doc.lote_dia = hojeBRT;
      if (c.redistribuida) doc.redistribuida = true;
      // Meta que o createDoc normalmente injeta
      doc.criado_em = nowIso;
      doc.criado_por = 'cron-oportunidades';
      doc.atualizado_em = nowIso;
      doc.atualizado_por = 'cron-oportunidades';
      acts[doc.id] = doc;
      criadas++;
    } catch (e) {
      erros++;
      if (errosDetalhe.length < 5) errosDetalhe.push((e.message || String(e)).slice(0, 150));
    }
  }

  // Uma unica escrita no GitHub (com retry em caso de 409, comum quando outra
  // request tocou o mesmo arquivo entre nosso read e write).
  if (criadas > 0) {
    let tentativas = 0, salvo = false, ultErr = null;
    while (tentativas < 3 && !salvo) {
      tentativas++;
      try {
        await crmStore.saveCollection('activities', acts,
          'Cron oportunidades: +' + criadas + ' tarefas');
        salvo = true;
      } catch (e) {
        ultErr = e;
        // Se der 409, recarrega e faz merge (nossas tarefas novas + o que
        // apareceu entre o read anterior e agora).
        if (String(e.message || '').includes('409')) {
          try {
            crmStore.invalidate('activities');
            const fresh = await crmStore.getCollection('activities');
            for (const id of Object.keys(acts)) {
              if (!fresh[id]) fresh[id] = acts[id]; // so adiciona o que nao existe
            }
            acts = fresh;
          } catch (e2) { /* segue pra proxima tentativa */ }
        } else {
          break; // outros erros nao valem retry
        }
      }
    }
    if (!salvo) {
      errosDetalhe.push('Save falhou apos ' + tentativas + ' tentativas: ' + (ultErr && ultErr.message));
      erros = criadas; // se nao salvou, contar tudo como erro
      criadas = 0;
    }
  }

  // Contagem do que FOI criado por vendedor nesta rodada (respeitando a cota)
  const porVendedorContagem = {};
  for (const owner of Object.keys(porOwner)) porVendedorContagem[owner] = 0;
  if (criadas > 0) for (const c of finais) porVendedorContagem[c.owner_id] = (porVendedorContagem[c.owner_id] || 0) + 1;

  return {
    ok: true,
    duracao_ms: Date.now() - inicio,
    contas_analisadas: accounts.length,
    candidatos_gerados: candidatos.length,
    apos_dedup: dedupados.length,
    tarefas_criadas: criadas,
    erros,
    erros_detalhe: errosDetalhe,
    vendedores_atingidos: Object.keys(porOwner).length,
    lote_dia: hojeBRT,
    // Pendentes ACUMULADAS antes desta rodada (nao reduzem mais a cota — so informativo)
    pendentes_antes: pendentesPorVendedor,
    criadas_hoje_antes: criadasHojePorVendedor,
    cota_por_vendedor: cotaPorVendedor,
    por_vendedor: porVendedorContagem,
    redistribuidas,
    por_fonte: _contaPorFonte(finais),
  };
}

// Alias pra compatibilidade com a cron /api/crm/cron/reativacao existente,
// que ja esta agendada no vercel.json. Ela agora dispara o motor completo.
const disparaReativacao = gerarTarefasDiarias;

// ═══════════════════════════════════════════════════════════════
// HELPERS DE SCORE
// ═══════════════════════════════════════════════════════════════

// Reativacao: valor historico ancora, dias sumido em curva (pico ~90-120d),
// confianca da sugestao pesa.
function _scoreReativacao(acc, diasSumido, conf) {
  const valorPeso = Math.min(30, (Number(acc.valor_total_compras) || 0) / 1000);
  const diasIdeal = 100;
  const distIdeal = Math.abs(diasSumido - diasIdeal);
  const diasPeso = Math.max(0, 20 - distIdeal * 0.15);
  const confPeso = (conf || 0) * 25;
  const freqPeso = Math.min(10, (Number(acc.pedidos_count) || 0) * 2);
  return valorPeso + diasPeso + confPeso + freqPeso;
}

// Cross-sell: confianca da cooc pesa mais, valor historico secundario.
function _scoreCrossSell(acc, conf) {
  const confPeso = (conf || 0) * 40;
  const valorPeso = Math.min(20, (Number(acc.valor_total_compras) || 0) / 2000);
  const freqPeso = Math.min(10, (Number(acc.pedidos_count) || 0) * 2);
  return confPeso + valorPeso + freqPeso;
}

// Aniversario: valor historico + bonus fixo (volume baixo, boa desculpa).
// Carteira: o vendedor marcou a temperatura — cliente quente esfriando e o
// mais urgente. Score alto pra entrar sempre na rodada (e lead DELE).
function _scoreCarteira(acc, temp, diasSemContato) {
  const base = temp === 'quente' ? 60 : (temp === 'morno' ? 45 : 30);
  const valorPeso = Math.min(20, (Number(acc.valor_total_compras) || 0) / 1000);
  const atrasoPeso = Math.min(15, Math.max(0, (diasSemContato || 0) - (CARTEIRA_PARADO_DIAS[temp] || 0)) * 0.5);
  return base + valorPeso + atrasoPeso;
}

// Reserva: quanto mais valioso e frequente o cliente era, maior a prioridade.
function _scoreReativacaoLonga(acc, diasSumido) {
  const valorPeso = Math.min(25, (Number(acc.valor_total_compras) || 0) / 1000);
  const freqPeso = Math.min(10, (Number(acc.pedidos_count) || 0) * 2);
  const recencia = Math.max(0, 10 - (diasSumido - REATIVACAO_LONGA_MIN_DIAS) / 60);
  return valorPeso + freqPeso + recencia;
}

function _scoreAniversario(acc) {
  const valorPeso = Math.min(35, (Number(acc.valor_total_compras) || 0) / 500);
  return valorPeso + 15;
}

// ═══════════════════════════════════════════════════════════════
// HELPERS DIVERSOS
// ═══════════════════════════════════════════════════════════════

// Escolhe a MELHOR sugestao de coocorrencia pro pedido de referencia.
// Ignora SKUs que o cliente ja comprou. Retorna null se nao houver.
async function _melhorSugestaoCooc(pedRef, skusJa, minConf) {
  if (!pedRef || !pedRef.itens || !pedRef.itens.length) return null;
  let melhor = null;
  for (const it of pedRef.itens) {
    const sku = String(it.sku || '');
    if (!sku) continue;
    let cooc;
    try { cooc = await coocorrencia.getPara(sku); } catch (e) { continue; }
    if (!cooc) continue;
    const todos = [...(cooc.compraram_junto || []), ...(cooc.compraram_depois || [])];
    for (const s of todos) {
      if (skusJa.has(String(s.sku))) continue;
      if ((s.confianca || 0) < minConf) continue;
      if (!melhor || (s.confianca || 0) > (melhor.confianca || 0)) melhor = s;
    }
  }
  return melhor;
}

function _skusUnicos(peds) {
  const s = new Set();
  for (const p of peds) for (const it of (p.itens || [])) if (it.sku) s.add(String(it.sku));
  return s;
}

// Dono da tarefa — delega pra _resolverDonoFinal que:
// 1. Vendedor da última venda (se for real/mapeado) OU
// 2. Account.owner_id (se for real/mapeado) OU
// 3. Rodizio
//
// Diferença chave: NÃO aleatoriza vendedores desligados que estão no
// MAPEAMENTO_VENDEDORES_DESLIGADOS — esses vão pro sucessor definido.
function _resolverVendedor(account, meusPeds) {
  const accountId = account && account.id;
  // Tenta vendedor da última venda primeiro
  if (meusPeds && meusPeds.length && meusPeds[0].vendedor_id) {
    const v = _normLogin(meusPeds[0].vendedor_id);
    const r = _resolverDonoFinal(v, accountId);
    // Se não foi pro rodizio (ou se o rodizio deu num mapeamento manual),
    // retorna. Senão continua tentando outras fontes.
    if (PSEUDOVENDEDORES.indexOf(v) === -1 && v) return r;
  }
  // Depois: owner do account
  if (account && account.owner_id) {
    return _resolverDonoFinal(account.owner_id, accountId);
  }
  // Nada → rodizio puro
  return _rodizio(accountId);
}

// MAPEAMENTO MANUAL de vendedores DESLIGADOS pra vendedores atuais.
// Quando um vendedor sai da empresa, a carteira dele passa pra um sucessor
// definido pelo gestor. Esses clientes NÃO vão pro rodizio aleatório — vão
// direto pro sucessor mapeado aqui. Adicione linhas quando outro vendedor sair.
// Formato: 'nome_antigo_lowercase': 'login_do_sucessor'
const MAPEAMENTO_VENDEDORES_DESLIGADOS = {
  'jonatas': 'mathias', // Clientes do Jonatas (desligado) agora são do Wesley (mathias)
};

// Pseudo-vendedores que o Bling usa quando o pedido não tem vendedor humano
// atribuído. Esses SIM vão pro rodizio aleatório.
const PSEUDOVENDEDORES = ['gerencia', 'admin', 'auxiliar', 'diretor', 'tray'];

// So considera vendedor "real" (dono legítimo) quem está na lista ativa OU
// no mapeamento de desligados (que redireciona). Pseudo-vendedores (tray,
// gerencia, etc) e nomes desconhecidos caem no rodizio.
function _isVendedorReal(login) {
  if (!login) return false;
  if (PSEUDOVENDEDORES.indexOf(login) !== -1) return false;
  if (MAPEAMENTO_VENDEDORES_DESLIGADOS[login]) return true; // mapeado = tem dono legítimo
  return VENDEDORES_ATIVOS.indexOf(login) !== -1;
}

// Resolve o DONO FINAL de uma tarefa/conta/pedido. Aplica mapeamento de
// desligados quando necessário.
//   - Em branco → rodizio
//   - Pseudo-vendedor (tray/gerencia/etc) → rodizio
//   - Mapeado (ex: jonatas) → sucessor (ex: mathias)
//   - Vendedor ativo → ele mesmo
//   - Vendedor desconhecido (não ativo, não mapeado) → rodizio como fallback
function _resolverDonoFinal(loginBruto, accountId) {
  const v = _normLogin(loginBruto);
  if (!v) return _rodizio(accountId);
  if (PSEUDOVENDEDORES.indexOf(v) !== -1) return _rodizio(accountId);
  if (MAPEAMENTO_VENDEDORES_DESLIGADOS[v]) return MAPEAMENTO_VENDEDORES_DESLIGADOS[v];
  if (VENDEDORES_ATIVOS.indexOf(v) !== -1) return v;
  // Desconhecido — não tem como adivinhar, joga no rodizio
  return _rodizio(accountId);
}

// Transfere o account pro vendedor que vai receber a tarefa, mas SOMENTE se
// o owner atual é "orfão" (gerencia / tray / vazio / vendedor fora da lista).
// Isso resolve o bug "cliente não lhe pertence" — quando o rodizio da uma
// tarefa pra Pedro de um cliente cujo owner é 'gerencia', Pedro nao conseguia
// abrir a ficha porque canReadDoc valida owner_id. Agora transferimos a conta
// pra ele no mesmo movimento. Nunca rouba conta de outro vendedor ativo.
async function _realocarAccountSeOrfao(accountId, novoDono, actor) {
  if (!accountId || !novoDono) return;
  try {
    const account = await crmStore.getDoc('accounts', accountId);
    if (!account) return;
    const atual = _normLogin(account.owner_id);
    // Se já é vendedor ativo (e NÃO é o novoDono tentando se auto-transferir),
    // não mexe — respeita a atribuição manual existente.
    if (atual && _isVendedorReal(atual) && atual !== novoDono) return;
    if (atual === novoDono) return; // já é dele, não precisa salvar
    // Atualiza owner_id com actor rastreável — fica no histórico do doc
    await crmStore.updateDoc('accounts', accountId, {
      ...account,
      owner_id: novoDono,
      // Carimba a transferência pra auditoria
      _realocado_por_automacao: {
        de: atual || null,
        para: novoDono,
        em: new Date().toISOString(),
        motivo: 'rodizio automatico (vendedor anterior era orfao: ' + (atual || 'vazio') + ')',
      },
    }, actor || 'automacao-rodizio');
  } catch (e) {
    // Falha silenciosa — não bloquear a criação da tarefa
    console.warn('[automacaoUpsell] Falha ao realocar account ' + accountId + ' pra ' + novoDono + ': ' + e.message);
  }
}

// Mesma lógica pra orders — quando o pedido veio sem vendedor ou com 'tray',
// atualiza vendedor_id pro vendedor do rodizio. Nunca sobrescreve vendedor real.
async function _realocarOrderSeOrfao(orderId, novoDono, actor) {
  if (!orderId || !novoDono) return;
  try {
    const order = await crmStore.getDoc('orders', orderId);
    if (!order) return;
    const atual = _normLogin(order.vendedor_id);
    if (atual && _isVendedorReal(atual) && atual !== novoDono) return;
    if (atual === novoDono) return;
    await crmStore.updateDoc('orders', orderId, {
      ...order,
      vendedor_id: novoDono,
    }, actor || 'automacao-rodizio');
  } catch (e) {
    console.warn('[automacaoUpsell] Falha ao realocar order ' + orderId + ' pra ' + novoDono + ': ' + e.message);
  }
}

// ── Versoes em BATCH das realocacoes (uma write por collection) ──────
// Usadas pelo cron diario pra evitar 409 do GitHub API quando precisa
// realocar dezenas de accounts/orders de uma vez. A singular acima e mantida
// pra chamadas isoladas (ex: processarOrderNovo que roda 1 vez por pedido).
async function _flushRealocAccountsBatch(mapa, actor) {
  if (!mapa || mapa.size === 0) return;
  let coll = await crmStore.getCollection('accounts');
  const now = new Date().toISOString();
  let changed = 0;
  function _aplicar(target) {
    let n = 0;
    for (const [id, novoDono] of mapa.entries()) {
      const a = target[id];
      if (!a) continue;
      const atual = _normLogin(a.owner_id);
      // Mesmas protecoes da versao singular: nao sobrescreve vendedor real existente
      if (atual && _isVendedorReal(atual) && atual !== novoDono) continue;
      if (atual === novoDono) continue;
      target[id] = {
        ...a,
        owner_id: novoDono,
        atualizado_em: now,
        atualizado_por: actor || 'automacao-rodizio',
        _realocado_por_automacao: {
          de: atual || null,
          para: novoDono,
          em: now,
          motivo: 'rodizio automatico (vendedor anterior era orfao: ' + (atual || 'vazio') + ')',
        },
      };
      n++;
    }
    return n;
  }
  changed = _aplicar(coll);
  if (!changed) return;
  // Retry 409: se o SHA mudou entre nosso read e write, recarrega e re-aplica
  let tentativas = 0, salvo = false, ultErr = null;
  while (tentativas < 3 && !salvo) {
    tentativas++;
    try {
      await crmStore.saveCollection('accounts', coll, 'Rodizio: realoca ' + changed + ' accounts');
      salvo = true;
    } catch (e) {
      ultErr = e;
      if (String(e.message || '').includes('409')) {
        crmStore.invalidate('accounts');
        coll = await crmStore.getCollection('accounts');
        changed = _aplicar(coll);
        if (!changed) { salvo = true; break; } // nada mais pra fazer
      } else break;
    }
  }
  if (!salvo) {
    console.warn('[automacaoUpsell] _flushRealocAccountsBatch falhou apos ' + tentativas + ' tentativas: ' + (ultErr && ultErr.message));
  }
}

async function _flushRealocOrdersBatch(mapa, actor) {
  if (!mapa || mapa.size === 0) return;
  let coll = await crmStore.getCollection('orders');
  const now = new Date().toISOString();
  let changed = 0;
  function _aplicar(target) {
    let n = 0;
    for (const [id, novoDono] of mapa.entries()) {
      const o = target[id];
      if (!o) continue;
      const atual = _normLogin(o.vendedor_id);
      if (atual && _isVendedorReal(atual) && atual !== novoDono) continue;
      if (atual === novoDono) continue;
      target[id] = {
        ...o,
        vendedor_id: novoDono,
        atualizado_em: now,
        atualizado_por: actor || 'automacao-rodizio',
      };
      n++;
    }
    return n;
  }
  changed = _aplicar(coll);
  if (!changed) return;
  let tentativas = 0, salvo = false, ultErr = null;
  while (tentativas < 3 && !salvo) {
    tentativas++;
    try {
      await crmStore.saveCollection('orders', coll, 'Rodizio: realoca ' + changed + ' orders');
      salvo = true;
    } catch (e) {
      ultErr = e;
      if (String(e.message || '').includes('409')) {
        crmStore.invalidate('orders');
        coll = await crmStore.getCollection('orders');
        changed = _aplicar(coll);
        if (!changed) { salvo = true; break; }
      } else break;
    }
  }
  if (!salvo) {
    console.warn('[automacaoUpsell] _flushRealocOrdersBatch falhou apos ' + tentativas + ' tentativas: ' + (ultErr && ultErr.message));
  }
}

// Rodizio deterministico entre vendedores ativos. Baseado em soma dos char
// codes do accountId — mesmo cliente sempre cai no mesmo vendedor, ate a
// lista mudar.
function _rodizio(accountId) {
  if (!VENDEDORES_ATIVOS.length) return 'gerencia';
  const id = String(accountId || 'x');
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash + id.charCodeAt(i)) | 0;
  return VENDEDORES_ATIVOS[Math.abs(hash) % VENDEDORES_ATIVOS.length];
}

function _normLogin(v) {
  return String(v || '').trim().toLowerCase();
}

function _titulo(c) {
  const nome = (c.account && c.account.nome) || c.accountId;
  if (c.fonte === 'reativacao_match') return '🔥 Reativar — ' + nome;
  if (c.fonte === 'cross_sell')       return '➕ Cross-sell — ' + nome;
  if (c.fonte === 'aniversario')      return '🎉 1 ano de cliente — ' + nome;
  if (c.fonte === 'reativacao_longa') return '♻️ Retomar contato — ' + nome;
  if (c.fonte === 'carteira_parado')  return (c.temperatura === 'quente' ? '🔥' : '💼') + ' Carteira esfriando — ' + nome;
  return 'Oportunidade — ' + nome;
}

function _descricao(c) {
  const acc = c.account || {};
  const linhas = [];
  linhas.push(c.motivoCurto);
  linhas.push('');
  linhas.push('Cliente: ' + (acc.nome || c.accountId));
  if (acc.telefone) linhas.push('Telefone: ' + acc.telefone);
  if (acc.ultima_compra_em) linhas.push('Ultima compra: ' + acc.ultima_compra_em);
  if (acc.pedidos_count) linhas.push('Pedidos: ' + acc.pedidos_count);
  if (acc.valor_total_compras) linhas.push('Valor historico: R$ ' + Number(acc.valor_total_compras).toFixed(2));
  if (c.sku_desc) {
    linhas.push('');
    linhas.push('Produto sugerido: ' + c.sku_desc + (c.sku_sugerido ? ' (SKU ' + c.sku_sugerido + ')' : ''));
    if (c.sug_confianca) linhas.push('Confianca: ' + Math.round(c.sug_confianca * 100) + '%');
  }
  linhas.push('');
  linhas.push('💡 Clique em "Gerar pitch com IA" na tarefa pra receber mensagem pronta pra WhatsApp com base no historico completo do cliente.');
  return linhas.join('\n');
}

function _descricaoPosVenda(account, order, sugestoes) {
  const nome = (account && account.nome) || order.account_id;
  const itensCompra = (order.itens || []).map(i => i.descricao || i.sku).slice(0, 3).join(', ');
  const linhas = sugestoes.map((s, i) => (i + 1) + '. ' + (s.nome || s.sku_bling) + ' — ' + s.motivo);
  let saida = 'Cliente ' + nome + ' comprou em ' + order.data_pedido + ': ' + itensCompra + '.\n\n';
  saida += 'Sugestoes (abordar em ate ' + POSVENDA_PRAZO_DIAS + ' dias, cliente ainda quente):\n' + linhas.join('\n');
  if (sugestoes[0] && sugestoes[0].pitch) {
    saida += '\n\n📱 Pitch pronto pra WhatsApp:\n' + sugestoes[0].pitch;
  }
  return saida;
}

// Constroi activity via build() do collections (valida enum, campos obrigatorios)
// e depois anexa os campos extras que o schema nao inclui mas o dashboard usa.
function _buildAct(dados) {
  const extras = {
    fonte: dados.fonte,
    account_id: dados.account_id,
    order_id: dados.order_id,
    sku_sugerido: dados.sku_sugerido,
    sku_sugerido_descricao: dados.sku_sugerido_descricao,
    motivo_curto: dados.motivo_curto,
    sug_confianca: dados.sug_confianca,
    pitch_pronto: dados.pitch_pronto,
    sugestoes_json: dados.sugestoes_json,
    dono: dados.dono,
  };
  // build() so aceita os campos do schema; passamos so o que ele quer
  const base = crmColl.REGISTRY.activities.build({
    id: uuid(),
    tipo: dados.tipo,
    status: 'pendente',
    owner_id: dados.owner_id,
    entidade_tipo: 'account',
    entidade_id: dados.entidade_id,
    titulo: dados.titulo,
    descricao: dados.descricao,
    prazo: dados.prazo,
    pontos_base: dados.pontos_base || 0,
    trigger_id: dados.trigger_id,
    gerada_automaticamente: true,
  });
  // Anexa extras (nao validados, mas persistidos)
  for (const k of Object.keys(extras)) if (extras[k] !== undefined && extras[k] !== null) base[k] = extras[k];
  return base;
}

function _contaPorFonte(tarefas) {
  const c = {};
  for (const t of tarefas) c[t.fonte] = (c[t.fonte] || 0) + 1;
  return c;
}

// Seleciona ate `cota` candidatos GARANTINDO variedade de fontes. Faz rodizio
// entre as fontes (reativacao_match / cross_sell / aniversario), pegando o de
// maior score de cada fonte por vez. Assim nenhuma fonte inunda a fila (ex: so
// aniversario), mas dentro de cada fonte o score ainda decide a ordem. Se uma
// fonte acaba, as outras preenchem o restante da cota.
// Fontes de RESERVA (FONTES_RESERVA) nao entram no rodizio: so completam a
// cota depois que todas as principais esgotaram. 'carteira_parado' abre o
// rodizio (e lead do proprio vendedor esfriando — prioridade maxima).
function _selecionarBalanceado(cands, cota) {
  const porFonte = {};
  for (const c of cands) (porFonte[c.fonte] = porFonte[c.fonte] || []).push(c);
  for (const f of Object.keys(porFonte)) porFonte[f].sort((a, b) => b.score - a.score);
  const principais = Object.keys(porFonte)
    .filter(f => FONTES_RESERVA.indexOf(f) === -1)
    .sort((a, b) => (a === 'carteira_parado' ? -1 : 0) - (b === 'carteira_parado' ? -1 : 0));
  const out = [];
  while (out.length < cota) {
    let adicionou = false;
    for (const f of principais) {
      if (porFonte[f].length) {
        out.push(porFonte[f].shift());
        adicionou = true;
        if (out.length >= cota) break;
      }
    }
    if (!adicionou) break; // principais esgotaram
  }
  // Completa com a reserva (maior score primeiro)
  if (out.length < cota) {
    const reserva = [];
    for (const f of FONTES_RESERVA) if (porFonte[f]) reserva.push(...porFonte[f]);
    reserva.sort((a, b) => b.score - a.score);
    while (out.length < cota && reserva.length) out.push(reserva.shift());
  }
  return out;
}

function _corta(s, n) {
  s = String(s || '');
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

function _hojeISO() { return new Date().toISOString().slice(0, 10); }

// Data no fuso de Brasilia (UTC-3, sem horario de verao desde 2019). A cota
// diaria usa o "dia" do vendedor, nao o dia UTC (que vira as 21h de Brasilia).
function _dataBRT(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (isNaN(t)) return '';
  return new Date(t - 3 * 3600 * 1000).toISOString().slice(0, 10);
}
function _hojeBRT() { return _dataBRT(new Date().toISOString()); }
// Data de hoje menos N dias, em ISO YYYY-MM-DD (UTC). Usado pra cooldown.
function _hojeMenos(dias) {
  const d = new Date(); d.setUTCDate(d.getUTCDate() - Number(dias || 0));
  return d.toISOString().slice(0, 10);
}
// Retrocompat: converte um tipo antigo de activity na fonte equivalente.
// Antes algumas tarefas eram salvas so com 'tipo', sem 'fonte'. Usado pra
// bloquear corretamente mesmo em tarefas de versoes antigas.
function _fonteDoTipo(tipo) {
  if (!tipo) return null;
  if (tipo === 'reativacao') return 'reativacao_match';
  if (tipo === 'trigger') return 'cross_sell'; // melhor palpite
  if (tipo === 'contato') return 'carteira_parado';
  return tipo;
}

function _hojeMais(d) {
  const dt = new Date();
  dt.setDate(dt.getDate() + d);
  return dt.toISOString().slice(0, 10);
}

function _diasEntre(dataInicio, dataFim) {
  const a = new Date(dataInicio + 'T00:00:00Z');
  const b = new Date(dataFim + 'T00:00:00Z');
  return Math.round((b - a) / (1000 * 60 * 60 * 24));
}

// Tag de semana ISO (ex: 2026-09-w39) pra dedupe semanal
function _semanaTag(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  const dayNum = (d.getUTCDay() + 6) % 7; // segunda=0
  d.setUTCDate(d.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const diff = (d - firstThursday) / (7 * 24 * 60 * 60 * 1000);
  const semana = 1 + Math.round(diff);
  return d.getUTCFullYear() + '-w' + String(semana).padStart(2, '0');
}

// Varredura RETROATIVA pra consertar bagunça:
// 1. Pra cada account/order com owner MAPEADO (ex: jonatas) → transfere pro
//    sucessor (ex: mathias).
// 2. Pra cada activity PENDENTE cujo owner é vendedor ativo mas account é
//    órfão (pseudo-vendedor) → transfere o account pro mesmo vendedor da activity.
// Chamar via endpoint quando mudar o MAPEAMENTO_VENDEDORES_DESLIGADOS ou pra
// corrigir bugs antigos.
async function repararAccountsOrfaosDeTarefas() {
  const activities = await crmStore.listDocs('activities');
  const pendentesComDonoReal = activities.filter(a =>
    a.status === 'pendente' && _isVendedorReal(_normLogin(a.owner_id || a.dono))
  );
  const resultado = {
    total_activities_pendentes: pendentesComDonoReal.length,
    accounts_transferidos: 0,
    orders_transferidos: 0,
    mapeamento_aplicado: 0, // ex: jonatas→mathias
    transferencias: [],
    erros: [],
  };

  // ── PASSO 1: aplica o MAPEAMENTO_VENDEDORES_DESLIGADOS em TODOS os
  // accounts e orders, independente de ter tarefa aberta. Isso move toda a
  // carteira do Jonatas pra Wesley de uma vez só.
  try {
    const todosAccounts = await crmStore.listDocs('accounts');
    for (const acc of todosAccounts) {
      const owner = _normLogin(acc.owner_id);
      const sucessor = MAPEAMENTO_VENDEDORES_DESLIGADOS[owner];
      if (sucessor) {
        try {
          await crmStore.updateDoc('accounts', acc.id, {
            ...acc, owner_id: sucessor,
            _realocado_por_automacao: {
              de: owner, para: sucessor,
              em: new Date().toISOString(),
              motivo: 'mapeamento manual vendedor desligado',
            },
          }, 'reparo-mapeamento');
          resultado.mapeamento_aplicado++;
          resultado.transferencias.push({ account_id: acc.id, de: owner, para: sucessor, motivo: 'mapeamento' });
        } catch (e) {
          resultado.erros.push({ account_id: acc.id, erro: e.message });
        }
      }
    }
    const todosOrders = await crmStore.listDocs('orders');
    for (const o of todosOrders) {
      const vend = _normLogin(o.vendedor_id);
      const sucessor = MAPEAMENTO_VENDEDORES_DESLIGADOS[vend];
      if (sucessor) {
        try {
          await crmStore.updateDoc('orders', o.id, { ...o, vendedor_id: sucessor }, 'reparo-mapeamento');
          resultado.orders_transferidos++;
        } catch (e) {
          resultado.erros.push({ order_id: o.id, erro: e.message });
        }
      }
    }
  } catch (e) {
    resultado.erros.push({ passo: 'mapeamento_global', erro: e.message });
  }
  // ── PASSO 2: transfere accounts órfãos (pseudo-vendedor) pros vendedores
  // que já receberam tarefas via rodizio. Dedupe por account.
  const paresFeitos = new Set();
  for (const a of pendentesComDonoReal) {
    const accId = a.entidade_id || a.account_id;
    const dono = _normLogin(a.owner_id || a.dono);
    if (!accId) continue;
    const chave = accId + '→' + dono;
    if (paresFeitos.has(chave)) continue;
    paresFeitos.add(chave);
    try {
      const acc = await crmStore.getDoc('accounts', accId);
      if (!acc) continue;
      const ownerAtual = _normLogin(acc.owner_id);
      // Só transfere se órfão (nunca rouba de outro vendedor ativo)
      if (_isVendedorReal(ownerAtual) && ownerAtual !== dono) continue;
      if (ownerAtual === dono) continue;
      await _realocarAccountSeOrfao(accId, dono, 'reparo-retroativo');
      resultado.accounts_transferidos++;
      resultado.transferencias.push({ account_id: accId, de: ownerAtual || '(vazio)', para: dono });
      // Também realoca orders dessa conta que estavam órfãos
      const orders = await crmStore.listDocs('orders', o => o.account_id === accId);
      for (const o of orders) {
        if (!_isVendedorReal(_normLogin(o.vendedor_id))) {
          await _realocarOrderSeOrfao(o.id, dono, 'reparo-retroativo');
          resultado.orders_transferidos++;
        }
      }
    } catch (e) {
      resultado.erros.push({ account_id: accId, erro: e.message });
    }
  }
  return resultado;
}

module.exports = {
  processarOrderNovo,
  gerarTarefasDiarias,
  disparaReativacao, // alias — mantido pra cron atual
  repararAccountsOrfaosDeTarefas,
  // helpers reaproveitados por disciplina/carteira
  _dataBRT, _hojeBRT, VENDEDORES_ATIVOS, TAREFAS_POR_VENDEDOR, CARTEIRA_PARADO_DIAS,
};
