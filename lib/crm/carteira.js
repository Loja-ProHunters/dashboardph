// lib/crm/carteira.js
// "Minha Carteira" — o livro de clientes de cada consultor.
//
// A carteira de um vendedor = contas (accounts) com owner_id == login dele.
// Ja nasce cheia: os clientes do Bling que sao dele + os orfaos que o motor
// de tarefas vai transferindo pra ele + os prospects que ele mesmo cadastra.
//
// Mecanica central: todo cliente tem (ou deveria ter) um PROXIMO PASSO com
// data — e esse proximo passo E uma tarefa na fila dele. Cliente com
// temperatura definida que fica sem contato volta como tarefa sozinho (fonte
// 'carteira_parado' no gerador diario). Preencher a carteira = montar a agenda.
//
// Escrita minima no GitHub: o "ultimo contato" e CALCULADO a partir das
// tarefas (concluidas / contatos registrados), nunca gravado na conta a cada
// clique — a conta so e escrita quando o vendedor edita temperatura/origem/
// notas ou cadastra um cliente novo.

const crmStore = require('./store');
const crmColl  = require('./collections');
const crmUtils = require('./utils');

const TEMPERATURAS = ['quente', 'morno', 'frio'];
const ORIGENS = {
  bling:      'Cliente da loja (Bling)',
  indicacao:  'Indicação',
  instagram:  'Instagram',
  whatsapp:   'WhatsApp',
  evento:     'Evento / feira / clube',
  balcao:     'Loja / balcão',
  site:       'Site',
  outro:      'Outro',
};
// Dias sem contato pra considerar "esfriando" (mesma regra do gerador)
const LIMITE_ESFRIANDO = { quente: 7, morno: 15, frio: 45 };
// Metas mensais (ajuste aqui) — so pra barra de progresso/gamificacao
const META_NOVOS_MES = 15;
const META_COMPRAS_MES = 10;

function _norm(v) { return String(v || '').trim().toLowerCase(); }
function _dataBRT(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (isNaN(t)) return '';
  return new Date(t - 3 * 3600 * 1000).toISOString().slice(0, 10);
}
function _hojeBRT() { return _dataBRT(new Date().toISOString()); }
function _diasEntre(a, b) { return Math.round((Date.parse(b) - Date.parse(a)) / 86400000); }
function _ehProspect(acc) { return Array.isArray(acc.tags) && acc.tags.indexOf('prospect_vendedor') !== -1; }
function _cidade(acc) {
  if (acc.cidade) return acc.cidade + (acc.uf ? '/' + acc.uf : '');
  const e = acc.endereco;
  if (e && typeof e === 'object' && e.cidade) return e.cidade + (e.uf ? '/' + e.uf : '');
  return null;
}
function _soDigitos(s) { return String(s || '').replace(/\D/g, ''); }

// ─── Montagem pura (testavel) ─────────────────────────────────────────
// accounts/orders/activities ja carregados; devolve a carteira do login.
function montar(login, accounts, orders, activities, agora) {
  agora = agora || new Date();
  const lg = _norm(login);
  const hoje = _dataBRT(agora.toISOString());
  const mesAtual = hoje.slice(0, 7);
  const seteDiasAtras = _dataBRT(new Date(agora.getTime() - 7 * 86400000).toISOString());

  const minhas = accounts.filter(a => _norm(a.owner_id) === lg && a.status !== 'inativo' && a.status !== 'bloqueado');
  const ids = new Set(minhas.map(a => a.id));

  // Pedidos por cliente
  const pedsPorAcc = {};
  for (const o of orders) {
    if (!ids.has(o.account_id)) continue;
    if (o.status === 'cancelado' || o.status === 'devolvido') continue;
    (pedsPorAcc[o.account_id] = pedsPorAcc[o.account_id] || []).push(o);
  }
  // Tarefas por cliente
  const actsPorAcc = {};
  let convertidasMes = 0;
  for (const t of activities) {
    const accId = t.account_id || t.entidade_id;
    if (_norm(t.owner_id || t.dono) === lg && t.status === 'concluida' && t.resultado === 'convertida'
        && _dataBRT(t.concluida_em || t.concluido_em).slice(0, 7) === mesAtual) convertidasMes++;
    if (!accId || !ids.has(accId)) continue;
    (actsPorAcc[accId] = actsPorAcc[accId] || []).push(t);
  }

  const clientes = [];
  const placar = { total: 0, quentes: 0, mornos: 0, frios: 0, sem_temperatura: 0, prospects: 0,
    esfriando: 0, sem_proximo_passo: 0, novos_mes: 0, compraram_mes: 0, valor_mes: 0,
    convertidas_mes: convertidasMes, origens: {} };
  const novidades = [];

  for (const acc of minhas) {
    const peds = (pedsPorAcc[acc.id] || []).sort((x, y) => String(y.data_pedido).localeCompare(String(x.data_pedido)));
    const acts = actsPorAcc[acc.id] || [];
    const prospect = _ehProspect(acc) && !peds.length && !(acc.pedidos_count > 0);
    const temperatura = TEMPERATURAS.indexOf(acc.carteira_temperatura) !== -1 ? acc.carteira_temperatura
      : (_ehProspect(acc) ? 'morno' : null);
    const origem = ORIGENS[acc.carteira_origem] ? acc.carteira_origem : (_ehProspect(acc) ? 'outro' : 'bling');

    // Ultimo contato = maior data entre tarefas finalizadas e contatos registrados
    let ultimoContato = '';
    for (const t of acts) {
      for (const d of [t.status === 'concluida' ? (t.concluida_em || t.concluido_em) : null, t.ultimo_contato_em, t.primeiro_contato_em]) {
        const x = _dataBRT(d);
        if (x && x > ultimoContato) ultimoContato = x;
      }
    }
    const refContato = ultimoContato || _dataBRT(acc.carteira_atualizado_em || acc.criado_em);
    const diasSemContato = refContato ? Math.max(0, _diasEntre(refContato, hoje)) : null;

    const abertas = acts.filter(t => t.status === 'pendente')
      .sort((x, y) => String(x.prazo || '9999').localeCompare(String(y.prazo || '9999')));
    const proximo = abertas[0] || null;
    const esfriando = !!(temperatura && diasSemContato != null && diasSemContato >= LIMITE_ESFRIANDO[temperatura]);

    const ultimaCompra = acc.ultima_compra_em || (peds[0] && peds[0].data_pedido) || null;
    const valorTotal = Number(acc.valor_total_compras) || peds.reduce((s, p) => s + (Number(p.valor_total) || 0), 0);
    const pedsMes = peds.filter(p => String(p.data_pedido || '').slice(0, 7) === mesAtual);
    const valorMes = pedsMes.reduce((s, p) => s + (Number(p.valor_total) || 0), 0);
    for (const p of peds) {
      if (String(p.data_pedido || '').slice(0, 10) >= seteDiasAtras) {
        novidades.push({ account_id: acc.id, nome: acc.nome || acc.razao_social, valor: Number(p.valor_total) || 0, data: String(p.data_pedido).slice(0, 10), pedido: p.bling_numero || null });
      }
    }

    // Placar
    placar.total++;
    if (temperatura === 'quente') placar.quentes++;
    else if (temperatura === 'morno') placar.mornos++;
    else if (temperatura === 'frio') placar.frios++;
    else placar.sem_temperatura++;
    if (prospect) placar.prospects++;
    if (esfriando) placar.esfriando++;
    if (!proximo) placar.sem_proximo_passo++;
    if (_dataBRT(acc.carteira_adicionado_em || (_ehProspect(acc) ? acc.criado_em : null)).slice(0, 7) === mesAtual) placar.novos_mes++;
    if (pedsMes.length) { placar.compraram_mes++; placar.valor_mes += valorMes; }
    placar.origens[origem] = (placar.origens[origem] || 0) + 1;

    clientes.push({
      id: acc.id,
      nome: acc.nome || acc.razao_social || '(sem nome)',
      telefone: acc.telefone || null,
      cpf_cnpj: acc.cpf_cnpj || null,
      cidade: _cidade(acc),
      temperatura, origem, prospect,
      notas: acc.carteira_notas || null,
      ultima_compra_em: ultimaCompra,
      pedidos_count: Number(acc.pedidos_count) || peds.length,
      valor_total_compras: Math.round(valorTotal * 100) / 100,
      ultimo_contato_em: ultimoContato || null,
      dias_sem_contato: diasSemContato,
      esfriando,
      tarefas_abertas: abertas.length,
      proximo_passo: proximo ? { tarefa_id: proximo.id, titulo: proximo.titulo, descricao: proximo.descricao || null,
        prazo: proximo.prazo || null, hora: proximo.hora || null, vencido: !!(proximo.prazo && proximo.prazo < hoje) } : null,
      comprou_no_mes: pedsMes.length > 0,
    });
  }
  placar.valor_mes = Math.round(placar.valor_mes * 100) / 100;

  // Ordem padrao: esfriando primeiro (quente > morno > frio), depois sem passo,
  // depois por proximo passo mais proximo, depois maior valor historico.
  const pesoTemp = { quente: 0, morno: 1, frio: 2 };
  clientes.sort((a, b) => {
    if (a.esfriando !== b.esfriando) return a.esfriando ? -1 : 1;
    if (a.esfriando && b.esfriando) return (pesoTemp[a.temperatura] || 3) - (pesoTemp[b.temperatura] || 3);
    const pa = a.proximo_passo ? a.proximo_passo.prazo || '9999' : '9998';
    const pb = b.proximo_passo ? b.proximo_passo.prazo || '9999' : '9998';
    if (pa !== pb) return pa.localeCompare(pb);
    return b.valor_total_compras - a.valor_total_compras;
  });
  novidades.sort((x, y) => y.data.localeCompare(x.data));

  return { login: lg, hoje, placar, metas: { novos_mes: META_NOVOS_MES, compras_mes: META_COMPRAS_MES },
    conquistas: _conquistas(placar), novidades: novidades.slice(0, 10), clientes };
}

// Conquistas — progresso visivel (gamificacao leve, metas pessoais)
function _conquistas(p) {
  const c = (id, icone, titulo, atual, alvo) => ({ id, icone, titulo, atual: Math.min(atual, alvo), alvo, conquistada: atual >= alvo });
  return [
    c('carteira_50', '💼', 'Carteira com 50 clientes', p.total, 50),
    c('carteira_150', '🏆', 'Carteira com 150 clientes', p.total, 150),
    c('quentes_10', '🔥', '10 clientes quentes', p.quentes, 10),
    c('novos_mes', '🌱', META_NOVOS_MES + ' clientes novos no mês', p.novos_mes, META_NOVOS_MES),
    c('compras_mes', '💰', META_COMPRAS_MES + ' clientes compraram no mês', p.compraram_mes, META_COMPRAS_MES),
    c('zero_esfriando', '🧊', 'Nenhum cliente esfriando', p.total > 0 && p.esfriando === 0 ? 1 : 0, 1),
  ];
}

// ─── Leituras com store ──────────────────────────────────────────────
async function listar(login) {
  const [accounts, orders, activities] = await Promise.all([
    crmStore.listDocs('accounts'), crmStore.listDocs('orders'), crmStore.listDocs('activities'),
  ]);
  return montar(login, accounts, orders, activities);
}

// Resumo por vendedor pra visao de gestao
async function resumoEquipe(vendedores) {
  const [accounts, orders, activities] = await Promise.all([
    crmStore.listDocs('accounts'), crmStore.listDocs('orders'), crmStore.listDocs('activities'),
  ]);
  const out = {};
  for (const v of vendedores) {
    const m = montar(v, accounts, orders, activities);
    out[_norm(v)] = m.placar;
  }
  return out;
}

// ─── Escritas ────────────────────────────────────────────────────────
function _assertDono(acc, login) {
  if (!acc) { const e = new Error('Cliente não encontrado'); e.status = 404; throw e; }
  if (_norm(acc.owner_id) !== _norm(login)) { const e = new Error('Este cliente não está na sua carteira.'); e.status = 403; throw e; }
}

function _validaPasso(p) {
  if (!p) return null;
  const descricao = String(p.descricao || '').trim();
  const prazo = String(p.prazo || '').slice(0, 10);
  if (!descricao) { const e = new Error('Descreva o próximo passo (o que você vai fazer).'); e.status = 400; throw e; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(prazo)) { const e = new Error('Escolha a data do próximo passo.'); e.status = 400; throw e; }
  return { descricao: descricao.slice(0, 2000), prazo, hora: p.hora ? String(p.hora).slice(0, 5) : null };
}

async function _criarOuAtualizarPasso(login, acc, passo) {
  // Se ja existe um proximo passo da carteira aberto pra este cliente, atualiza
  // (nao empilha); senao cria a tarefa.
  const abertos = await crmStore.listDocs('activities', t =>
    t.status === 'pendente' && t.fonte === 'carteira' && (t.account_id || t.entidade_id) === acc.id && _norm(t.owner_id) === _norm(login));
  const titulo = '💼 ' + (acc.nome || 'Cliente') + ' — ' + passo.descricao.slice(0, 60);
  if (abertos.length) {
    return crmStore.updateDoc('activities', abertos[0].id, { titulo, descricao: passo.descricao, prazo: passo.prazo, hora: passo.hora }, login);
  }
  const id = crmUtils.uuid();
  return crmStore.createDoc('activities', {
    id, tipo: 'follow_up', status: 'pendente', owner_id: _norm(login),
    entidade_tipo: 'account', entidade_id: acc.id, account_id: acc.id,
    titulo, descricao: passo.descricao, prazo: passo.prazo, hora: passo.hora,
    concluido_em: null, concluido_com_order_id: null,
    pontos_base: 10, pontos_bonus: 0, pontos_ganhos: 0,
    trigger_id: 'carteira_' + id, gerada_automaticamente: false,
    fonte: 'carteira', dono: _norm(login), criada_por_vendedor: login,
  }, login);
}

// Cadastra cliente NOVO na carteira (prospect) + ja cria o proximo passo.
// Se o telefone/CPF ja existe: dele -> avisa; de outro vendedor -> bloqueia;
// orfao (sem dono real) -> assume pra carteira dele.
async function adicionarCliente(login, dados, vendedoresAtivos) {
  const nome = String(dados.nome || '').trim();
  const telefone = String(dados.telefone || '').trim();
  if (!nome) { const e = new Error('Nome do cliente obrigatório.'); e.status = 400; throw e; }
  if (_soDigitos(telefone).length < 10) { const e = new Error('WhatsApp com DDD obrigatório (ex: 47 99999-9999).'); e.status = 400; throw e; }
  const passo = _validaPasso(dados.proximo_passo);
  const temperatura = TEMPERATURAS.indexOf(dados.temperatura) !== -1 ? dados.temperatura : 'morno';
  const origem = ORIGENS[dados.origem] && dados.origem !== 'bling' ? dados.origem : 'outro';
  const cpf = dados.cpf_cnpj ? String(dados.cpf_cnpj).trim() : null;

  // Duplicidade por telefone (ultimos 8 digitos) ou CPF/CNPJ
  const tel8 = _soDigitos(telefone).slice(-8);
  const cpfD = _soDigitos(cpf);
  const existentes = await crmStore.listDocs('accounts', a =>
    (tel8 && _soDigitos(a.telefone).slice(-8) === tel8) || (cpfD.length >= 11 && _soDigitos(a.cpf_cnpj) === cpfD));
  const ativos = (vendedoresAtivos || []).map(_norm);
  const now = new Date().toISOString();
  if (existentes.length) {
    const ex = existentes[0];
    const dono = _norm(ex.owner_id);
    if (dono === _norm(login)) { const e = new Error('Esse cliente já está na sua carteira (' + (ex.nome || '') + ').'); e.status = 409; e.account_id = ex.id; throw e; }
    if (ativos.indexOf(dono) !== -1) { const e = new Error('Esse cliente já pertence à carteira de outro consultor. Fale com a gerência.'); e.status = 409; throw e; }
    // Orfao: assume
    const acc = await crmStore.updateDoc('accounts', ex.id, {
      owner_id: _norm(login), carteira_temperatura: temperatura, carteira_origem: origem,
      carteira_adicionado_em: now, carteira_atualizado_em: now,
      carteira_notas: dados.notas ? String(dados.notas).slice(0, 2000) : (ex.carteira_notas || null),
    }, login);
    const tarefa = passo ? await _criarOuAtualizarPasso(login, acc, passo) : null;
    return { account: acc, tarefa, assumido: true };
  }

  const base = crmColl.REGISTRY.accounts.build({
    tipo: _soDigitos(cpf).length === 14 ? 'pj' : 'pf',
    nome: nome.slice(0, 200), telefone: telefone.slice(0, 60),
    cpf_cnpj: cpf, owner_id: _norm(login),
    tags: ['prospect_vendedor'],
    notas: 'Cadastrado na Minha Carteira por ' + login + ' em ' + now.slice(0, 10),
  });
  base.cidade = dados.cidade ? String(dados.cidade).trim().slice(0, 80) : null;
  base.carteira_temperatura = temperatura;
  base.carteira_origem = origem;
  base.carteira_notas = dados.notas ? String(dados.notas).slice(0, 2000) : null;
  base.carteira_adicionado_em = now;
  base.carteira_atualizado_em = now;
  const acc = await crmStore.createDoc('accounts', base, login);
  const tarefa = passo ? await _criarOuAtualizarPasso(login, acc, passo) : null;
  return { account: acc, tarefa, assumido: false };
}

async function atualizar(login, accountId, patch) {
  const acc = await crmStore.getDoc('accounts', accountId);
  _assertDono(acc, login);
  const upd = { carteira_atualizado_em: new Date().toISOString() };
  if (patch.temperatura !== undefined) {
    if (patch.temperatura !== null && TEMPERATURAS.indexOf(patch.temperatura) === -1) { const e = new Error('Temperatura inválida'); e.status = 400; throw e; }
    upd.carteira_temperatura = patch.temperatura;
  }
  if (patch.origem !== undefined) {
    if (!ORIGENS[patch.origem]) { const e = new Error('Origem inválida'); e.status = 400; throw e; }
    upd.carteira_origem = patch.origem;
  }
  if (patch.notas !== undefined) upd.carteira_notas = patch.notas ? String(patch.notas).slice(0, 2000) : null;
  if (patch.cidade !== undefined) upd.cidade = patch.cidade ? String(patch.cidade).trim().slice(0, 80) : null;
  return crmStore.updateDoc('accounts', accountId, upd, login);
}

async function definirProximoPasso(login, accountId, passoIn) {
  const acc = await crmStore.getDoc('accounts', accountId);
  _assertDono(acc, login);
  const passo = _validaPasso(passoIn);
  return _criarOuAtualizarPasso(login, acc, passo);
}

module.exports = {
  montar, listar, resumoEquipe,
  adicionarCliente, atualizar, definirProximoPasso,
  TEMPERATURAS, ORIGENS, LIMITE_ESFRIANDO,
};
