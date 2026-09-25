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
//      gera ate 10 tarefas/dia por vendedor, distribuidas por 3 fontes:
//
//        a) Reativacao com match (60-180 dias sumido + coocorrencia forte)
//        b) Cross-sell (comprou algo ha >=30 dias e nao levou complemento obvio)
//        c) Aniversario (355-380 dias da primeira compra)
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
const TAREFAS_POR_VENDEDOR   = 10;
const REATIVACAO_MIN_DIAS    = 60;
const REATIVACAO_MAX_DIAS    = 180;
const CROSSSELL_MIN_DIAS     = 30;   // ultima compra ≥ 30d atras
const CROSSSELL_CONF_MIN     = 0.20; // so cross-sell com coocorrencia razoavel
const REATIVACAO_CONF_MIN    = 0.10; // reativacao aceita coocorrencia mais fraca
const ANIVERSARIO_MIN_DIAS   = 355;
const ANIVERSARIO_MAX_DIAS   = 380;
const PRAZO_TAREFA_DIAS      = 5;
const PRAZO_ANIVERSARIO_DIAS = 14;

// Pos-venda (processarOrderNovo)
const POSVENDA_PRAZO_DIAS    = 5;
const POSVENDA_CONF_MIN      = 0.30;

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
    const vendedor = _normLogin(ownerVendedor || order.vendedor_id || (account && account.owner_id) || 'gerencia');

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

async function gerarTarefasDiarias() {
  const inicio = Date.now();
  const hoje = _hojeISO();
  const semanaTag = _semanaTag(hoje);

  // Carrega dados de uma vez (cache do store agrupa)
  const accounts = await crmStore.listDocs('accounts',
    a => a.status !== 'inativo' && a.status !== 'bloqueado');
  const orders = await crmStore.listDocs('orders',
    o => o.status !== 'cancelado' && o.status !== 'devolvido');
  const activitiesPendentes = await crmStore.listDocs('activities',
    a => a.status === 'pendente' && a.gerada_automaticamente);

  // Triggers ja em uso na semana (anti-dupe)
  const triggersUsados = new Set(activitiesPendentes.map(a => a.trigger_id).filter(Boolean));

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
    const meusPeds = ordersPorAccount[acc.id] || [];
    if (!meusPeds.length && !acc.ultima_compra_em) continue;

    const ultimaData = acc.ultima_compra_em || (meusPeds[0] && meusPeds[0].data_pedido);
    if (!ultimaData) continue;
    const primeiraData = acc.primeira_compra_em || (meusPeds[meusPeds.length - 1] && meusPeds[meusPeds.length - 1].data_pedido);

    const diasUltima = _diasEntre(ultimaData, hoje);
    const diasPrimeira = primeiraData ? _diasEntre(primeiraData, hoje) : null;
    const skusJa = _skusUnicos(meusPeds);
    const pedRef = meusPeds[0]; // pedido de referencia (mais recente)

    // Fonte 1 — Reativacao com match
    if (diasUltima >= REATIVACAO_MIN_DIAS && diasUltima <= REATIVACAO_MAX_DIAS) {
      const sug = await _melhorSugestaoCooc(pedRef, skusJa, REATIVACAO_CONF_MIN);
      if (sug) {
        candidatos.push({
          accountId: acc.id, account: acc,
          fonte: 'reativacao_match',
          motivoCurto: 'Sumido ha ' + diasUltima + 'd — ideal p/ ' + _corta(sug.descricao, 40),
          sku_sugerido: sug.sku, sku_desc: sug.descricao, sug_confianca: sug.confianca,
          score: _scoreReativacao(acc, diasUltima, sug.confianca),
          triggerId: 'reativ_' + acc.id + '_' + semanaTag,
          pedRef,
        });
      }
    }

    // Fonte 2 — Cross-sell (comprou ha >=30d e tem cooc forte)
    if (diasUltima >= CROSSSELL_MIN_DIAS && diasUltima < REATIVACAO_MIN_DIAS) {
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
          triggerId: 'xsell_' + acc.id + '_' + sug.sku + '_' + semanaTag,
          pedRef,
        });
      }
    }

    // Fonte 3 — Aniversario de 1 ano
    if (diasPrimeira !== null && diasPrimeira >= ANIVERSARIO_MIN_DIAS && diasPrimeira <= ANIVERSARIO_MAX_DIAS) {
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
  }

  // Filtra triggers ja usados
  const novos = candidatos.filter(c => !triggersUsados.has(c.triggerId));

  // Dedupe por account: se um cliente aparece em 2 fontes, fica com a de maior score
  const melhorPorAccount = {};
  for (const c of novos) {
    const atual = melhorPorAccount[c.accountId];
    if (!atual || atual.score < c.score) melhorPorAccount[c.accountId] = c;
  }
  const dedupados = Object.values(melhorPorAccount);

  // Agrupa por vendedor (dono da tarefa)
  const porOwner = {};
  for (const c of dedupados) {
    const owner = _resolverVendedor(c.account, ordersPorAccount[c.accountId]);
    (porOwner[owner] = porOwner[owner] || []).push({ ...c, owner_id: owner });
  }

  // Pega top TAREFAS_POR_VENDEDOR por vendedor (menor score completa a cota)
  const finais = [];
  for (const owner of Object.keys(porOwner)) {
    porOwner[owner].sort((a, b) => b.score - a.score);
    finais.push(...porOwner[owner].slice(0, TAREFAS_POR_VENDEDOR));
  }

  // Cria as activities
  let criadas = 0, erros = 0;
  const errosDetalhe = [];
  for (const c of finais) {
    try {
      const prazo = c.fonte === 'aniversario'
        ? _hojeMais(PRAZO_ANIVERSARIO_DIAS)
        : _hojeMais(PRAZO_TAREFA_DIAS);
      const doc = _buildAct({
        tipo: c.fonte === 'reativacao_match' ? 'reativacao' : 'trigger',
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
      await crmStore.createDoc('activities', doc, 'cron-oportunidades');
      criadas++;
    } catch (e) {
      erros++;
      if (errosDetalhe.length < 5) errosDetalhe.push((e.message || String(e)).slice(0, 150));
    }
  }

  const porVendedorContagem = {};
  for (const owner of Object.keys(porOwner)) {
    porVendedorContagem[owner] = Math.min(porOwner[owner].length, TAREFAS_POR_VENDEDOR);
  }

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
    por_vendedor: porVendedorContagem,
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

// Dono da tarefa = vendedor da ULTIMA venda; senao, account.owner_id;
// senao "gerencia" (aparece pra admin).
function _resolverVendedor(account, meusPeds) {
  if (meusPeds && meusPeds.length && meusPeds[0].vendedor_id) return _normLogin(meusPeds[0].vendedor_id);
  if (account && account.owner_id) return _normLogin(account.owner_id);
  return 'gerencia';
}

function _normLogin(v) {
  return String(v || '').trim().toLowerCase();
}

function _titulo(c) {
  const nome = (c.account && c.account.nome) || c.accountId;
  if (c.fonte === 'reativacao_match') return '🔥 Reativar — ' + nome;
  if (c.fonte === 'cross_sell')       return '➕ Cross-sell — ' + nome;
  if (c.fonte === 'aniversario')      return '🎉 1 ano de cliente — ' + nome;
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

function _corta(s, n) {
  s = String(s || '');
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

function _hojeISO() { return new Date().toISOString().slice(0, 10); }

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

module.exports = {
  processarOrderNovo,
  gerarTarefasDiarias,
  disparaReativacao, // alias — mantido pra cron atual
};
