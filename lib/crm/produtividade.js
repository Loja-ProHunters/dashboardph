// lib/crm/produtividade.js
// Agrega métricas de produtividade dos vendedores com base nas activities do CRM.
//
// Métricas por vendedor:
//   - pendentes_em_dia: activities status=pendente com prazo >= hoje
//   - atrasadas:        activities status=pendente com prazo < hoje
//   - concluidas_hoje:  activities status=concluida com concluido_em = hoje
//   - concluidas_7d:    activities concluídas nos últimos 7 dias
//   - concluidas_mes:   activities concluídas desde o 1º dia do mês atual
//   - taxa_conclusao:   concluidas_mes / (concluidas_mes + atrasadas) * 100
//
// Também retorna lista_atrasadas detalhada por vendedor (pra expandir no front).
// Resolvemos cliente_nome via accounts quando a entidade é 'account' ou 'order'.

const store = require('./store');
const disciplina = require('./disciplina');
const carteira = require('./carteira');

function _hojeISO() {
  return new Date().toISOString().slice(0, 10);
}

function _diffDiasInt(fim, inicio) {
  try {
    const a = new Date(fim).getTime();
    const b = new Date(inicio).getTime();
    return Math.floor((a - b) / (1000 * 60 * 60 * 24));
  } catch (e) { return 0; }
}

function _diaDoMes(iso) {
  return String(iso || '').slice(0, 10);
}

function _diasAtras(dias) {
  const d = new Date();
  d.setDate(d.getDate() - dias);
  return d.toISOString().slice(0, 10);
}

function _primeiroDiaMes() {
  const d = new Date();
  return d.toISOString().slice(0, 7) + '-01';
}

// Resolve o nome do cliente/entidade pra mostrar no card da tarefa.
// Pra 'account' pega direto; pra 'order' pega account_id do pedido e resolve.
async function _resolverNomeEntidade(activity, accountsMap, ordersMap) {
  if (activity.entidade_tipo === 'account') {
    const a = accountsMap[activity.entidade_id];
    return a ? (a.nome || a.razao_social || activity.entidade_id) : null;
  }
  if (activity.entidade_tipo === 'order') {
    const o = ordersMap[activity.entidade_id];
    if (!o) return null;
    const a = accountsMap[o.account_id];
    return a ? (a.nome || a.razao_social || o.account_id) : null;
  }
  return null;
}

// Pega todos os vendedores (login + nome). Filtra pelo role 'vendas' na
// chamada principal (ou aceita lista explícita). Dependência: lib/usersStore.
async function _listarVendedores() {
  try {
    const usersStore = require('../usersStore');
    const todos = await usersStore.getAllUsers();
    const vendedores = [];
    for (const [login, u] of Object.entries(todos)) {
      if (u.ativo === false) continue;
      const role = String(u.role || '').toLowerCase();
      if (role !== 'vendas') continue;
      vendedores.push({
        login: String(login).toLowerCase(),
        nome: u.nome || login,
      });
    }
    return vendedores;
  } catch (e) {
    // Fallback: 3 vendedores conhecidos
    return [
      { login: 'dickmann', nome: 'Pedro' },
      { login: 'boschetto', nome: 'Enzo' },
      { login: 'mathias', nome: 'Wesley Mathias' },
    ];
  }
}

// Função principal — admin/diretor chama pra ver visão completa da equipe.
async function calcularProdutividade() {
  const hoje = _hojeISO();
  const limite7d = _diasAtras(7);
  const primeiroDiaMes = _primeiroDiaMes();

  // Carrega tudo em paralelo
  const [activities, accounts, orders, vendedores] = await Promise.all([
    store.listDocs('activities'),
    store.listDocs('accounts'),
    store.listDocs('orders'),
    _listarVendedores(),
  ]);

  // Monta mapas pra lookup O(1)
  const accountsMap = {};
  for (const a of accounts) accountsMap[a.id] = a;
  const ordersMap = {};
  for (const o of orders) ordersMap[o.id] = o;

  // Inicializa buckets por vendedor
  const buckets = {};
  for (const v of vendedores) {
    buckets[v.login] = {
      login: v.login,
      nome: v.nome,
      pendentes_em_dia: 0,
      atrasadas: 0,
      concluidas_hoje: 0,
      concluidas_7d: 0,
      concluidas_mes: 0,
      lista_atrasadas: [], // [{id, titulo, prazo, dias_atraso, cliente_nome, tipo}]
    };
  }

  // Totais da equipe
  const totais = {
    pendentes_em_dia: 0,
    atrasadas: 0,
    concluidas_hoje: 0,
    concluidas_7d: 0,
    concluidas_mes: 0,
    total_vendedores: vendedores.length,
  };

  // Processa cada activity
  for (const act of activities) {
    const owner = String(act.owner_id || '').toLowerCase();
    const b = buckets[owner];
    if (!b) continue; // owner não é vendedor ativo (admin, auxiliar, etc)

    const status = act.status;
    const prazo = _diaDoMes(act.prazo);
    // BUGFIX: a conclusao grava 'concluida_em' (feminino); antes so lia
    // 'concluido_em' e as contagens de concluidas saiam sempre zeradas.
    const concluido = _diaDoMes(act.concluida_em || act.concluido_em);

    if (status === 'pendente' || status === 'overdue') {
      // Tarefa aberta — classifica em dia ou atrasada pela data
      if (prazo && prazo < hoje) {
        b.atrasadas++;
        totais.atrasadas++;
        // Resolve nome do cliente pra lista detalhada
        const nome = await _resolverNomeEntidade(act, accountsMap, ordersMap);
        b.lista_atrasadas.push({
          id: act.id,
          titulo: act.titulo,
          prazo: act.prazo,
          dias_atraso: _diffDiasInt(hoje, prazo),
          cliente_nome: nome,
          tipo: act.tipo,
          entidade_tipo: act.entidade_tipo,
          entidade_id: act.entidade_id,
        });
      } else {
        b.pendentes_em_dia++;
        totais.pendentes_em_dia++;
      }
    } else if (status === 'concluida') {
      if (concluido >= primeiroDiaMes) {
        b.concluidas_mes++;
        totais.concluidas_mes++;
      }
      if (concluido >= limite7d) {
        b.concluidas_7d++;
        totais.concluidas_7d++;
      }
      if (concluido === hoje) {
        b.concluidas_hoje++;
        totais.concluidas_hoje++;
      }
    }
    // 'cancelada' não entra em métricas
  }

  // Ordena lista_atrasadas por maior atraso primeiro (prioridade)
  for (const b of Object.values(buckets)) {
    b.lista_atrasadas.sort((x, y) => y.dias_atraso - x.dias_atraso);
    // Com o acumulo, a lista pode ficar enorme: manda so as 30 piores pro front
    b.lista_atrasadas_total = b.lista_atrasadas.length;
    if (b.lista_atrasadas.length > 30) b.lista_atrasadas = b.lista_atrasadas.slice(0, 30);
    // Taxa de conclusão do mês: concluidas / (concluidas + atrasadas abertas)
    const denominador = b.concluidas_mes + b.atrasadas;
    b.taxa_conclusao = denominador > 0
      ? Math.round((b.concluidas_mes / denominador) * 100)
      : null;
  }

  // Ordena vendedores: mais atrasadas primeiro (quem precisa de atenção)
  const listaVendedores = Object.values(buckets).sort((a, b) => {
    if (b.atrasadas !== a.atrasadas) return b.atrasadas - a.atrasadas;
    return a.nome.localeCompare(b.nome);
  });

  // Disciplina (execucao/alertas) + carteira por vendedor
  const logins = vendedores.map(v => v.login);
  const disc = disciplina.paraEquipeSync(activities, logins);
  totais.acumuladas = 0; totais.alertas_criticos = 0; totais.vendedores_com_alerta = 0;
  for (const b of listaVendedores) {
    const d = disc[b.login];
    b.disciplina = d ? { fila: d.fila, execucao: d.execucao, alertas: d.alertas, saude: d.saude } : null;
    try { b.carteira = carteira.montar(b.login, accounts, orders, activities).placar; } catch (_) { b.carteira = null; }
    if (d) {
      totais.acumuladas += d.fila.acumuladas;
      totais.alertas_criticos += d.alertas.filter(a => a.nivel === 'critico').length;
      if (d.alertas.length) totais.vendedores_com_alerta++;
    }
  }
  // Quem tem alerta critico sobe pro topo
  listaVendedores.sort((a, b) => {
    const ca = a.disciplina ? a.disciplina.alertas.filter(x => x.nivel === 'critico').length : 0;
    const cb = b.disciplina ? b.disciplina.alertas.filter(x => x.nivel === 'critico').length : 0;
    if (cb !== ca) return cb - ca;
    if (b.atrasadas !== a.atrasadas) return b.atrasadas - a.atrasadas;
    return a.nome.localeCompare(b.nome);
  });

  return {
    gerado_em: new Date().toISOString(),
    equipe: totais,
    vendedores: listaVendedores,
    motivos_labels: disciplina.MOTIVOS_NAO_CONVERSAO,
    origens_labels: carteira.ORIGENS,
  };
}

module.exports = { calcularProdutividade };
