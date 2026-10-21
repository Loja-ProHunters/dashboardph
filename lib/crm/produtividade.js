// lib/crm/produtividade.js  (v3 — painel gerencial)
// Uma unica fonte de verdade: TODOS os numeros vem de disciplina.calcular()
// (mesmas regras pro vendedor e pra gestao — nada de numero contraditorio).
//
// Devolve o que a gestao precisa pra AGIR:
//   • equipe ........ 4 indicadores-chave do dia
//   • acoes ......... lista curta "o que exige acao" (critico primeiro)
//   • vendedores .... status (ok / atencao / acao), series diarias p/ graficos
//   • contratos ..... situacao dos contratos de venda de arma
//   • motivos ....... por que nao converteu (so dado registrado pelo vendedor)

const store = require('./store');
const disciplina = require('./disciplina');
const carteira = require('./carteira');
const contratosArma = require('./contratosArma');

const VENDEDORES_PADRAO = [
  { login: 'dickmann', nome: 'Pedro Henrique Dickmann' },
  { login: 'boschetto', nome: 'Enzo dos Santos Boschetto' },
  { login: 'mathias', nome: 'Wesley Mathias Ciesielsky' },
];

async function _listarVendedores() {
  try {
    const usersStore = require('../usersStore');
    const todos = await usersStore.getAllUsers();
    const vendedores = [];
    for (const [login, u] of Object.entries(todos)) {
      if (u.ativo === false) continue;
      if (String(u.role || '').toLowerCase() !== 'vendas') continue;
      vendedores.push({ login: String(login).toLowerCase(), nome: u.nome || login });
    }
    return vendedores.length ? vendedores : VENDEDORES_PADRAO;
  } catch (e) { return VENDEDORES_PADRAO; }
}

// Funcao pura (testavel): recebe os dados e devolve o painel
function montar(activities, accounts, orders, vendedores, agora) {
  agora = agora || new Date();
  const accountsMap = {}; for (const a of accounts || []) accountsMap[a.id] = a;
  const disc = disciplina.paraEquipeSync(activities, vendedores.map(v => v.login), agora);
  const hoje = disciplina.hojeBRT(agora);
  const painelContratos = contratosArma.painel(activities, agora);
  const contratosPorVend = {}; for (const p of painelContratos.por_vendedor) contratosPorVend[p.login] = p;

  const equipe = {
    finalizadas_hoje: 0, meta_hoje: disciplina.COTA_DIA * vendedores.length,
    abertas: 0, acumuladas: 0, vencidas: 0,
    convertidas_14d: 0, nao_convertidas_14d: 0, follow_ups_14d: 0, conversao_14d: null,
    status: { ok: 0, atencao: 0, acao: 0 },
    contratos: painelContratos.totais,
  };
  const motivosEquipe = {};
  const acoes = [];
  const lista = [];

  for (const v of vendedores) {
    const d = disc[v.login];
    if (!d) continue;
    const primeiroNome = String(v.nome || v.login).split(' ')[0];
    equipe.finalizadas_hoje += d.execucao.executadas_hoje;
    equipe.abertas += d.fila.abertas;
    equipe.acumuladas += d.fila.acumuladas;
    equipe.vencidas += d.fila.vencidas;
    equipe.convertidas_14d += d.execucao.finalizacoes.convertida;
    equipe.nao_convertidas_14d += d.execucao.finalizacoes.nao_convertida;
    equipe.follow_ups_14d += d.execucao.finalizacoes.follow_up_agendado || 0;
    equipe.status[d.status]++;
    for (const [m, n] of Object.entries(d.execucao.motivos_nao_conversao || {})) motivosEquipe[m] = (motivosEquipe[m] || 0) + n;

    const alertasGestao = d.alertas.filter(a => !a.so_vendedor);
    for (const a of alertasGestao) {
      acoes.push({ vendedor: v.login, nome: primeiroNome, nivel: a.nivel, codigo: a.codigo, titulo: a.titulo, detalhe: a.mensagem_gestao, acao: a.acao });
    }

    // Drill-down: tarefas comerciais abertas mais antigas (top 30)
    const abertas = (activities || []).filter(a => a && a.status === 'pendente' && !disciplina.ehContrato(a) &&
      String(a.owner_id || a.dono || '').toLowerCase() === v.login);
    abertas.sort((x, y) => String(x.lote_dia || x.criado_em || '').localeCompare(String(y.lote_dia || y.criado_em || '')));
    const maisAntigas = abertas.slice(0, 30).map(t => {
      const acc = accountsMap[t.account_id || t.entidade_id];
      const origem = t.lote_dia || disciplina.dataBRT(t.criado_em);
      return { id: t.id, titulo: t.titulo, cliente_nome: acc ? (acc.nome || acc.razao_social) : null, origem,
        dias: origem ? Math.max(0, Math.round((Date.parse(hoje) - Date.parse(origem)) / 86400000)) : 0, prazo: t.prazo || null };
    });

    let placar = null;
    try { placar = carteira.montar(v.login, accounts, orders, activities, agora).placar; } catch (_) {}

    lista.push({
      login: v.login, nome: v.nome, primeiro_nome: primeiroNome,
      status: d.status,
      motivo_status: alertasGestao.length ? alertasGestao.slice().sort((a, b) => (a.nivel === 'critico' ? 0 : 1) - (b.nivel === 'critico' ? 0 : 1))[0].titulo : 'Em dia',
      fila: d.fila, execucao: d.execucao, serie: d.serie,
      alertas: alertasGestao,
      contratos: Object.assign({}, d.contratos, contratosPorVend[v.login] || {}),
      carteira: placar,
      mais_antigas: maisAntigas,
      abertas_total: abertas.length,
    });
  }
  const conv = equipe.convertidas_14d + equipe.nao_convertidas_14d;
  equipe.conversao_14d = conv ? Math.round(equipe.convertidas_14d / conv * 100) : null;

  // Contratos de arma cujo vendedor o Bling nao trouxe: a gestao escolhe (raro)
  const aAtribuir = painelContratos.linhas.filter(l => l.atribuir_vendedor).length;
  if (aAtribuir) {
    acoes.push({ vendedor: 'gerencia', nome: 'Contratos', nivel: 'critico', codigo: 'contrato_sem_vendedor',
      titulo: aAtribuir + ' contrato(s) de arma sem vendedor no Bling', detalhe: 'O pedido não trouxe um dos vendedores no campo "Vendedor".', acao: 'Escolher o vendedor na tabela de contratos.' });
  }
  if (painelContratos.totais.nao_encontrado) {
    acoes.push({ vendedor: '', nome: 'Contratos', nivel: 'critico', codigo: 'contrato_nao_encontrado',
      titulo: painelContratos.totais.nao_encontrado + ' contrato(s) "salvo" que não estava na pasta', detalhe: 'O vendedor declarou salvo e a conferência não encontrou.', acao: 'Tratar com o vendedor responsável.' });
  }

  // Anulacoes de contrato da ultima semana: a gestao confere a justificativa
  const semana = new Date(agora.getTime() - 7 * 86400e3).toISOString();
  const anulRec = painelContratos.linhas.filter(l => l.situacao === 'anulado' && l.anulacao && l.anulacao.em >= semana);
  if (anulRec.length) {
    acoes.push({ vendedor: '', nome: 'Contratos', nivel: 'atencao', codigo: 'contrato_anulado',
      titulo: anulRec.length + ' contrato(s) anulado(s) na semana', detalhe: 'Vendedores anularam com justificativa (ver filtro "Anulados").', acao: 'Conferir se a justificativa procede.' });
  }
  const peso = { critico: 0, atencao: 1 };
  acoes.sort((a, b) => peso[a.nivel] - peso[b.nivel]);
  lista.sort((a, b) => ({ acao: 0, atencao: 1, ok: 2 }[a.status] - { acao: 0, atencao: 1, ok: 2 }[b.status]) || a.nome.localeCompare(b.nome));

  return {
    gerado_em: agora.toISOString(),
    hoje,
    janela_dias: disciplina.JANELA_DIAS,
    cota_dia: disciplina.COTA_DIA,
    rastreio_desde: disciplina.RASTREIO_DESDE,
    equipe,
    acoes,
    vendedores: lista,
    motivos_equipe: motivosEquipe,
    motivos_labels: disciplina.MOTIVOS_NAO_CONVERSAO,
    contratos: { totais: painelContratos.totais, linhas: painelContratos.linhas.filter(l => l.situacao !== 'anulado').slice(0, 80).concat(painelContratos.linhas.filter(l => l.situacao === 'anulado').slice(0, 40)) },
  };
}

async function calcularProdutividade() {
  const [activities, accounts, orders, vendedores] = await Promise.all([
    store.listDocs('activities'),
    store.listDocs('accounts'),
    store.listDocs('orders'),
    _listarVendedores(),
  ]);
  return montar(activities, accounts, orders, vendedores);
}

module.exports = { calcularProdutividade, montar };
