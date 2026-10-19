// lib/crm/disciplina.js
// Metricas de EXECUCAO das tarefas + alertas de comportamento.
//
// Objetivo: mostrar (pro vendedor e pra gestao) se a fila esta sendo
// TRABALHADA de verdade ou so "tirada da frente". Sinais usados:
//
//   • Acumulo ........ tarefas de dias anteriores ainda abertas (nada some).
//   • Nao convertido . % alto de "nao convertido" nas finalizacoes.
//   • Sem contato .... "nao convertido" sem nenhum contato registrado
//                      (sem clique no WhatsApp e sem canal declarado).
//   • Rajada ......... muitas finalizacoes em poucos minutos (clicando em serie).
//   • Cancelamento ... % alto de tarefas canceladas.
//   • Parado hoje .... passou das 14h e nada foi finalizado com fila aberta.
//
// Tudo aqui e funcao PURA sobre arrays (testavel sem banco). As funcoes
// async no fim so carregam os dados do store e chamam as puras.

// ─── Limites (ajuste aqui) ──────────────────────────────────────────
const JANELA_DIAS            = 14;   // janela das taxas de finalizacao
const COTA_DIA               = 20;   // tarefas novas por dia por vendedor
const MIN_AMOSTRA_TAXA       = 15;   // minimo de finalizacoes pra julgar taxa
const NAO_CONV_ATENCAO       = 0.75; // >= 75% nao convertido -> atencao
const NAO_CONV_CRITICO       = 0.90; // >= 90% -> critico
const MIN_NAO_CONV_CONTATO   = 8;    // minimo de "nao convertido" pra julgar contato
const SEM_CONTATO_CRITICO    = 0.50; // >= 50% dos nao convertidos sem contato
const RAJADA_JANELA_MIN      = 10;   // janela da rajada (minutos)
const RAJADA_ATENCAO         = 8;    // >= 8 finalizacoes em 10 min
const RAJADA_CRITICO         = 15;
const RAJADA_DIAS            = 7;    // olha rajadas dos ultimos 7 dias
const ACUMULO_ATENCAO        = 40;   // 2 dias de cota parados
const ACUMULO_CRITICO        = 100;  // 5 dias de cota parados
const MAIS_ANTIGA_ATENCAO    = 5;    // tarefa aberta ha 5+ dias
const CANCEL_MIN             = 10;
const CANCEL_ATENCAO         = 0.40;
const HORA_PARADO_HOJE       = 14;   // apos 14h BRT sem finalizar nada

const MOTIVOS_NAO_CONVERSAO = {
  sem_interesse:   'Sem interesse no momento',
  preco:           'Achou caro / preço',
  comprou_outro:   'Já comprou em outro lugar',
  sem_produto:     'Não temos o produto / estoque',
  documentacao:    'Pendência de documentação (CR/CRAF)',
  sem_resposta:    'Não respondeu / não atendeu',
  numero_errado:   'Número errado / sem contato',
  outro:           'Outro motivo',
};
const CANAIS = { whatsapp: 'WhatsApp', ligacao: 'Ligação', presencial: 'Presencial' };

// ─── Datas no fuso de Brasilia ─────────────────────────────────────
function dataBRT(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (isNaN(t)) return '';
  return new Date(t - 3 * 3600 * 1000).toISOString().slice(0, 10);
}
function hojeBRT(agora) { return dataBRT((agora || new Date()).toISOString()); }
function horaBRT(agora) { return new Date((agora || new Date()).getTime() - 3 * 3600 * 1000).getUTCHours(); }
function _diasEntre(a, b) { return Math.round((Date.parse(b) - Date.parse(a)) / 86400000); }
function _norm(v) { return String(v || '').trim().toLowerCase(); }
function _dono(a) { return _norm(a.owner_id || a.dono); }

// Quando a tarefa foi finalizada (concluida ou cancelada)
function _finalizadaEm(a) {
  if (a.status === 'concluida') return a.concluida_em || a.concluido_em || a.atualizado_em || null;
  if (a.status === 'cancelada') return a.cancelada_em || a.atualizado_em || null;
  return null;
}
function _temEvidenciaContato(a) {
  if (a.primeiro_contato_em) return true;
  if (Array.isArray(a.contatos) && a.contatos.length) return true;
  return !!(a.canal_contato && CANAIS[a.canal_contato]);
}

// ─── Calculo puro pra UM vendedor ───────────────────────────────────
function calcular(activities, login, agora) {
  agora = agora || new Date();
  const hoje = hojeBRT(agora);
  const lg = _norm(login);
  const minhas = (activities || []).filter(a => _dono(a) === lg);
  const limiteJanela = new Date(agora.getTime() - JANELA_DIAS * 86400000).toISOString();
  const limiteRajada = new Date(agora.getTime() - RAJADA_DIAS * 86400000).toISOString();

  // Fila aberta
  let abertas = 0, deHoje = 0, acumuladas = 0, vencidas = 0, maisAntiga = 0;
  const porDiaOrigem = {};
  for (const a of minhas) {
    if (a.status !== 'pendente') continue;
    abertas++;
    const origem = a.lote_dia || dataBRT(a.criado_em) || hoje;
    const dias = Math.max(0, _diasEntre(origem, hoje));
    if (dias > 0) acumuladas++; else deHoje++;
    if (dias > maisAntiga) maisAntiga = dias;
    if (a.prazo && a.prazo < hoje) vencidas++;
    porDiaOrigem[origem] = (porDiaOrigem[origem] || 0) + 1;
  }

  // Finalizacoes na janela
  const fin = { convertida: 0, nao_convertida: 0, follow_up_agendado: 0, cancelada: 0, outras: 0 };
  const motivos = {};
  const canais = {};
  let naoConvSemContato = 0, executadasHoje = 0, cliquesWhats = 0;
  const tsRajada = [];
  for (const a of minhas) {
    const em = _finalizadaEm(a);
    if (!em) continue;
    if (dataBRT(em) === hoje) executadasHoje++;
    if (em >= limiteRajada && (a.status === 'cancelada' || a.resultado === 'nao_convertida' || a.resultado === 'concluida' || !a.resultado)) {
      tsRajada.push(Date.parse(em));
    }
    if (em < limiteJanela) continue;
    if (a.status === 'cancelada') { fin.cancelada++; continue; }
    const r = a.resultado || 'outras';
    if (fin[r] !== undefined) fin[r]++; else fin.outras++;
    if (a.primeiro_contato_em || (Array.isArray(a.contatos) && a.contatos.some(c => c.canal === 'whatsapp'))) cliquesWhats++;
    if (a.canal_contato) canais[a.canal_contato] = (canais[a.canal_contato] || 0) + 1;
    if (r === 'nao_convertida') {
      const m = a.motivo_nao_conversao || 'nao_informado';
      motivos[m] = (motivos[m] || 0) + 1;
      if (!_temEvidenciaContato(a)) naoConvSemContato++;
    }
  }
  const comResultado = fin.convertida + fin.nao_convertida + fin.follow_up_agendado;
  const totalFinalizadas = comResultado + fin.cancelada + fin.outras;
  const pctNaoConv = comResultado ? fin.nao_convertida / comResultado : 0;
  const taxaConversao = (fin.convertida + fin.nao_convertida) ? fin.convertida / (fin.convertida + fin.nao_convertida) : null;
  const pctSemContato = fin.nao_convertida ? naoConvSemContato / fin.nao_convertida : 0;
  const pctCancel = totalFinalizadas ? fin.cancelada / totalFinalizadas : 0;

  // Rajada: maior numero de finalizacoes "negativas" dentro de 10 minutos
  tsRajada.sort((x, y) => x - y);
  let picoRajada = 0, picoEm = null;
  for (let i = 0, j = 0; j < tsRajada.length; j++) {
    while (tsRajada[j] - tsRajada[i] > RAJADA_JANELA_MIN * 60000) i++;
    if (j - i + 1 > picoRajada) { picoRajada = j - i + 1; picoEm = new Date(tsRajada[i]).toISOString(); }
  }

  // ─── Alertas ──────────────────────────────────────────────────────
  const alertas = [];
  const add = (codigo, nivel, titulo, msgVendedor, msgGestao, valor) =>
    alertas.push({ codigo, nivel, titulo, mensagem_vendedor: msgVendedor, mensagem_gestao: msgGestao, valor });

  if (comResultado >= MIN_AMOSTRA_TAXA && pctNaoConv >= NAO_CONV_ATENCAO) {
    const p = Math.round(pctNaoConv * 100);
    add('nao_convertido_alto', pctNaoConv >= NAO_CONV_CRITICO ? 'critico' : 'atencao',
      p + '% das tarefas como "não convertido"',
      p + '% das suas finalizações nos últimos ' + JANELA_DIAS + ' dias foram "não convertido" (' + fin.nao_convertida + ' de ' + comResultado + '). Antes de finalizar, fale de verdade com o cliente — use o botão WhatsApp ou agende um follow-up se ele pediu pra retornar.',
      p + '% de não convertido em ' + comResultado + ' finalizações (' + JANELA_DIAS + 'd) — possível "tirando da frente".', p);
  }
  if (fin.nao_convertida >= MIN_NAO_CONV_CONTATO && pctSemContato >= SEM_CONTATO_CRITICO) {
    const p = Math.round(pctSemContato * 100);
    add('sem_contato', 'critico',
      naoConvSemContato + ' "não convertido" sem contato registrado',
      naoConvSemContato + ' tarefas foram marcadas como "não convertido" sem nenhum contato registrado com o cliente. Toda tarefa precisa de contato antes de ser finalizada.',
      p + '% dos não convertidos sem clique no WhatsApp nem canal declarado (' + naoConvSemContato + '/' + fin.nao_convertida + ').', p);
  }
  if (picoRajada >= RAJADA_ATENCAO) {
    add('rajada', picoRajada >= RAJADA_CRITICO ? 'critico' : 'atencao',
      picoRajada + ' tarefas finalizadas em ' + RAJADA_JANELA_MIN + ' minutos',
      'Você finalizou ' + picoRajada + ' tarefas em menos de ' + RAJADA_JANELA_MIN + ' minutos. Não dá tempo de conversar com tantos clientes assim — trabalhe uma tarefa por vez.',
      picoRajada + ' finalizações negativas/canceladas em ' + RAJADA_JANELA_MIN + ' min (pico em ' + (picoEm ? dataBRT(picoEm) : '?') + ').', picoRajada);
  }
  if (acumuladas >= ACUMULO_ATENCAO || maisAntiga >= MAIS_ANTIGA_ATENCAO) {
    add('fila_acumulando', acumuladas >= ACUMULO_CRITICO ? 'critico' : 'atencao',
      acumuladas + ' tarefas acumuladas de dias anteriores',
      'Você tem ' + acumuladas + ' tarefas de dias anteriores ainda abertas (a mais antiga há ' + maisAntiga + ' dias). Elas não somem: todo dia chegam mais ' + COTA_DIA + '. Comece pelas mais antigas.',
      acumuladas + ' acumuladas, mais antiga há ' + maisAntiga + ' dias, ' + vencidas + ' vencidas.', acumuladas);
  }
  if (fin.cancelada >= CANCEL_MIN && pctCancel >= CANCEL_ATENCAO) {
    const p = Math.round(pctCancel * 100);
    add('cancelamento_alto', 'atencao',
      p + '% das tarefas canceladas',
      p + '% das suas tarefas foram canceladas nos últimos ' + JANELA_DIAS + ' dias. Cancele só tarefas inválidas (cliente duplicado, já comprou, número errado).',
      fin.cancelada + ' canceladas (' + p + '% das finalizações).', p);
  }
  if (horaBRT(agora) >= HORA_PARADO_HOJE && abertas > 0 && executadasHoje === 0) {
    add('parado_hoje', 'atencao',
      'Nenhuma tarefa finalizada hoje',
      'Já passou das ' + HORA_PARADO_HOJE + 'h e nenhuma tarefa foi finalizada hoje — você tem ' + abertas + ' esperando.',
      'Nenhuma finalização hoje com ' + abertas + ' abertas.', abertas);
  }

  // Saude da fila: 100 menos penalidades (transparente, sem caixa-preta)
  let saude = 100;
  for (const al of alertas) saude -= al.nivel === 'critico' ? 30 : 15;
  saude = Math.max(0, saude);

  return {
    login: lg,
    hoje,
    fila: { abertas, de_hoje: deHoje, acumuladas, vencidas, mais_antiga_dias: maisAntiga, por_dia_origem: porDiaOrigem },
    execucao: {
      janela_dias: JANELA_DIAS,
      executadas_hoje: executadasHoje,
      finalizacoes: fin,
      total_finalizadas: totalFinalizadas,
      taxa_conversao: taxaConversao == null ? null : Math.round(taxaConversao * 100),
      pct_nao_convertido: Math.round(pctNaoConv * 100),
      nao_convertidas_sem_contato: naoConvSemContato,
      pct_sem_contato: Math.round(pctSemContato * 100),
      cliques_whatsapp: cliquesWhats,
      canais_declarados: canais,
      pct_cancelada: Math.round(pctCancel * 100),
      pico_rajada_10min: picoRajada,
      motivos_nao_conversao: motivos,
    },
    alertas,
    saude,
  };
}

// ─── Wrappers com store ─────────────────────────────────────────────
async function paraVendedor(login) {
  const store = require('./store');
  const acts = await store.listDocs('activities');
  return calcular(acts, login);
}

function paraEquipeSync(activities, vendedores, agora) {
  const out = {};
  for (const v of vendedores) out[_norm(v)] = calcular(activities, v, agora);
  return out;
}

async function paraEquipe(vendedores) {
  const store = require('./store');
  const acts = await store.listDocs('activities');
  const out = {};
  for (const v of vendedores) out[_norm(v)] = calcular(acts, v);
  return out;
}

module.exports = {
  calcular, paraVendedor, paraEquipe, paraEquipeSync,
  dataBRT, hojeBRT, horaBRT,
  MOTIVOS_NAO_CONVERSAO, CANAIS, COTA_DIA, JANELA_DIAS,
};
