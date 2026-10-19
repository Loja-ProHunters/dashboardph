// lib/crm/disciplina.js  (v3 — só dado confiável)
// Metricas de EXECUCAO das tarefas + alertas acionaveis pra gestao.
//
// Regras de confiabilidade (o que mudou na v3):
//   • So conta o que o PROPRIO vendedor fez. Cancelamento feito pela gestao,
//     pelo sistema ou pelo antigo "resetar e regerar" NAO entra nas taxas,
//     nem na rajada, nem no % de cancelamento.
//   • "Sem contato" e "motivos" so existem a partir de RASTREIO_DESDE (data em
//     que o registro de canal/motivo entrou no ar). Antes disso o dado nao
//     existia — nao da pra cobrar o vendedor por ele.
//   • Tarefas de CONTRATO de arma sao obrigacao, nao venda: ficam fora das
//     taxas comerciais e tem indicador proprio.
//   • Alerta so com amostra minima. "Parado hoje" e lembrete do vendedor —
//     nao entra no status que a gestao ve.
//
// Tudo aqui e funcao PURA sobre arrays (testavel sem banco).

// ─── Limites (ajuste aqui) ──────────────────────────────────────────
const RASTREIO_DESDE         = '2026-10-19T13:40:00.000Z'; // canal/motivo passaram a ser registrados
const JANELA_DIAS            = 14;   // janela das taxas e dos graficos
const COTA_DIA               = 20;   // tarefas novas por dia por vendedor
const MIN_AMOSTRA_TAXA       = 15;   // minimo de finalizacoes pra julgar a taxa
const NAO_CONV_ATENCAO       = 0.80; // >= 80% nao convertido -> atencao
const MIN_SEM_CONTATO        = 5;    // minimo de "nao convertido" (pos-rastreio) pra julgar contato
const SEM_CONTATO_CRITICO    = 0.50; // >= 50% sem nenhum contato registrado -> critico
const RAJADA_JANELA_MIN      = 10;
const RAJADA_ATENCAO         = 10;   // >= 10 finalizacoes negativas em 10 min
const RAJADA_CRITICO         = 15;
const RAJADA_DIAS            = 7;
const ACUMULO_ATENCAO        = 40;   // 2 dias de cota parados
const ACUMULO_CRITICO        = 100;  // 5 dias de cota parados
const MAIS_ANTIGA_ATENCAO    = 5;
const MAIS_ANTIGA_CRITICO    = 10;
const DIAS_UTEIS_PARADO      = 2;    // 2 dias uteis sem finalizar nada com fila aberta
const CANCEL_MIN             = 10;
const CANCEL_ATENCAO         = 0.40;
const HORA_PARADO_HOJE       = 14;

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
function _somaDias(dia, n) { return new Date(Date.parse(dia + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10); }
function _diaUtil(dia) { const d = new Date(dia + 'T12:00:00Z').getUTCDay(); return d >= 1 && d <= 5; }
// Fim do dia BRT (23:59:59.999 BRT) em ISO UTC
function _fimDoDiaISO(dia) { return new Date(Date.parse(dia + 'T23:59:59.999Z') + 3 * 3600 * 1000).toISOString(); }

function ehContrato(a) {
  return !!a && (String(a.tipo || '').indexOf('contrato') === 0 || a.fonte === 'contrato_arma');
}
// Disponivel = ja pode aparecer na fila (tarefa de contrato "assinado" so aparece 48h depois)
function disponivel(a, agora) {
  if (!a || !a.disponivel_em) return true;
  return Date.parse(a.disponivel_em) <= (agora || new Date()).getTime();
}

// Quando a tarefa foi finalizada (concluida ou cancelada)
function _finalizadaEm(a) {
  if (a.status === 'concluida') return a.concluida_em || a.concluido_em || a.atualizado_em || null;
  if (a.status === 'cancelada') return a.cancelada_em || a.atualizado_em || null;
  return null;
}
// A finalizacao foi feita pelo PROPRIO vendedor? (gestao/sistema/reset nao contam)
function _feitaPeloDono(a) {
  if (a.status === 'cancelada') {
    if (/reset|regerar|sistema|rebalance|cron/i.test(String(a.cancelamento_motivo || a.motivo_cancelamento || ''))) return false;
    const quem = _norm(a.cancelada_por);
    if (!quem) return true;
    return quem === _dono(a);
  }
  const quem = _norm(a.concluida_por);
  if (!quem) return true; // registros antigos nao tinham o campo
  return quem === _dono(a);
}
function _temEvidenciaContato(a) {
  if (a.primeiro_contato_em) return true;
  if (Array.isArray(a.contatos) && a.contatos.length) return true;
  return !!(a.canal_contato && CANAIS[a.canal_contato]);
}

// ─── Calculo puro pra UM vendedor ───────────────────────────────────
function calcular(activities, login, agora) {
  agora = agora || new Date();
  const agoraISO = agora.toISOString();
  const hoje = hojeBRT(agora);
  const lg = _norm(login);
  const todas = (activities || []).filter(a => a && _dono(a) === lg && disponivel(a, agora));
  const minhas = todas.filter(a => !ehContrato(a));
  const contratosTarefas = todas.filter(ehContrato);
  const limiteJanela = new Date(agora.getTime() - JANELA_DIAS * 86400000).toISOString();
  const limiteRajada = new Date(agora.getTime() - RAJADA_DIAS * 86400000).toISOString();

  // ── Fila aberta (comercial)
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

  // ── Serie diaria (graficos): recebidas, finalizadas pelo vendedor, fila no fim do dia
  const dias = [];
  for (let i = JANELA_DIAS - 1; i >= 0; i--) dias.push(_somaDias(hoje, -i));
  const serie = dias.map(d => ({ dia: d, recebidas: 0, finalizadas: 0, convertida: 0, nao_convertida: 0, follow_up: 0, cancelada: 0, fila_fim_dia: 0 }));
  const idx = {}; dias.forEach((d, i) => { idx[d] = i; });
  const fins = dias.map(_fimDoDiaISO);
  for (const a of minhas) {
    const criadoDia = a.lote_dia || dataBRT(a.criado_em);
    if (idx[criadoDia] !== undefined) serie[idx[criadoDia]].recebidas++;
    const criadoISO = a.criado_em || (criadoDia ? criadoDia + 'T11:00:00.000Z' : null);
    const finEm = _finalizadaEm(a);
    for (let i = 0; i < dias.length; i++) {
      if (!criadoISO || criadoISO > fins[i]) continue;
      if (!finEm || finEm > fins[i]) serie[i].fila_fim_dia++;
    }
    if (!finEm || !_feitaPeloDono(a)) continue;
    const fd = dataBRT(finEm);
    if (idx[fd] === undefined) continue;
    const s = serie[idx[fd]];
    s.finalizadas++;
    if (a.status === 'cancelada') s.cancelada++;
    else if (a.resultado === 'convertida') s.convertida++;
    else if (a.resultado === 'nao_convertida') s.nao_convertida++;
    else if (a.resultado === 'follow_up_agendado') s.follow_up++;
  }
  // hoje: fila atual (o "fim do dia" de hoje ainda nao chegou)
  serie[serie.length - 1].fila_fim_dia = abertas;

  // ── Finalizacoes na janela (so as do proprio vendedor)
  const fin = { convertida: 0, nao_convertida: 0, follow_up_agendado: 0, cancelada: 0, outras: 0 };
  const motivos = {};
  let canceladasGestao = 0, executadasHoje = 0, ultimaFinalizacao = null;
  let naoConvRastreio = 0, naoConvRastreioSemContato = 0;
  const tsRajada = [];
  for (const a of minhas) {
    const em = _finalizadaEm(a);
    if (!em) continue;
    if (!_feitaPeloDono(a)) { if (em >= limiteJanela && a.status === 'cancelada') canceladasGestao++; continue; }
    if (!ultimaFinalizacao || em > ultimaFinalizacao) ultimaFinalizacao = em;
    if (dataBRT(em) === hoje) executadasHoje++;
    const negativa = a.status === 'cancelada' || a.resultado === 'nao_convertida';
    if (negativa && em >= limiteRajada) tsRajada.push(Date.parse(em));
    if (em < limiteJanela) continue;
    if (a.status === 'cancelada') { fin.cancelada++; continue; }
    const r = a.resultado || 'outras';
    if (fin[r] !== undefined) fin[r]++; else fin.outras++;
    if (r === 'nao_convertida' && em >= RASTREIO_DESDE) {
      naoConvRastreio++;
      if (!_temEvidenciaContato(a)) naoConvRastreioSemContato++;
      if (a.motivo_nao_conversao) motivos[a.motivo_nao_conversao] = (motivos[a.motivo_nao_conversao] || 0) + 1;
    }
  }
  const comResultado = fin.convertida + fin.nao_convertida;
  const totalFinalizadas = comResultado + fin.follow_up_agendado + fin.cancelada + fin.outras;
  const pctNaoConv = comResultado ? fin.nao_convertida / comResultado : 0;
  const taxaConversao = comResultado ? fin.convertida / comResultado : null;
  const pctSemContato = naoConvRastreio ? naoConvRastreioSemContato / naoConvRastreio : null;
  const pctCancel = totalFinalizadas ? fin.cancelada / totalFinalizadas : 0;

  // Dias uteis seguidos sem finalizar nada (contando de ontem pra tras), com fila aberta
  let diasUteisParado = 0;
  if (abertas > 0) {
    const ultimaDia = ultimaFinalizacao ? dataBRT(ultimaFinalizacao) : null;
    for (let i = 1; i <= 30; i++) {
      const d = _somaDias(hoje, -i);
      if (ultimaDia && d <= ultimaDia) break;
      if (_diaUtil(d)) diasUteisParado++;
    }
    // so conta dias em que ele JA tinha tarefa na fila
    const primeiraOrigem = Object.keys(porDiaOrigem).sort()[0];
    if (primeiraOrigem) {
      let max = 0; for (let i = 1; i <= 30; i++) { const d = _somaDias(hoje, -i); if (d < primeiraOrigem) break; if (_diaUtil(d)) max++; }
      diasUteisParado = Math.min(diasUteisParado, max);
    }
  }

  // Rajada: maior numero de finalizacoes negativas DO VENDEDOR em 10 minutos
  tsRajada.sort((x, y) => x - y);
  let picoRajada = 0, picoEm = null;
  for (let i = 0, j = 0; j < tsRajada.length; j++) {
    while (tsRajada[j] - tsRajada[i] > RAJADA_JANELA_MIN * 60000) i++;
    if (j - i + 1 > picoRajada) { picoRajada = j - i + 1; picoEm = new Date(tsRajada[i]).toISOString(); }
  }

  // ── Contratos de arma (obrigacao)
  const contratos = { pendentes: 0, vencidos: 0, enviar: 0, assinatura: 0, mais_antigo_dias: 0 };
  for (const a of contratosTarefas) {
    if (a.status !== 'pendente') continue;
    contratos.pendentes++;
    if (a.tipo === 'contrato_assinatura') contratos.assinatura++; else contratos.enviar++;
    const limite = a.prazo ? a.prazo + 'T' + (a.hora || '23:59') : null;
    if (limite && limite < new Date(agora.getTime() - 3 * 3600e3).toISOString().slice(0, 16)) contratos.vencidos++;
    const d = Math.max(0, _diasEntre(dataBRT(a.criado_em) || hoje, hoje));
    if (d > contratos.mais_antigo_dias) contratos.mais_antigo_dias = d;
  }

  // ─── Alertas (acionaveis) ─────────────────────────────────────────
  // titulo curto (cabe numa linha) · acao = o que a gestao deve fazer
  const alertas = [];
  const add = (codigo, nivel, titulo, msgVendedor, msgGestao, acao, valor, soVendedor) =>
    alertas.push({ codigo, nivel, titulo, mensagem_vendedor: msgVendedor, mensagem_gestao: msgGestao, acao, valor, so_vendedor: !!soVendedor });

  if (contratos.vencidos > 0) {
    add('contrato_atrasado', 'critico',
      contratos.vencidos + ' contrato(s) de arma atrasado(s)',
      'Você tem ' + contratos.vencidos + ' contrato(s) de venda de arma com prazo vencido. Sem contrato assinado a venda é cancelada.',
      contratos.vencidos + ' contrato(s) de arma com prazo vencido.',
      'Cobrar hoje: sem contrato assinado a venda deve ser cancelada.', contratos.vencidos);
  }
  if (naoConvRastreio >= MIN_SEM_CONTATO && pctSemContato >= SEM_CONTATO_CRITICO) {
    const p = Math.round(pctSemContato * 100);
    add('sem_contato', 'critico',
      'Finaliza sem falar com o cliente',
      naoConvRastreioSemContato + ' tarefas foram marcadas como "não convertido" sem nenhum contato registrado. Toda tarefa precisa de contato antes de ser finalizada.',
      naoConvRastreioSemContato + ' de ' + naoConvRastreio + ' "não convertido" sem contato registrado (' + p + '%).',
      'Conferir 3 clientes por amostragem e conversar com o vendedor.', p);
  }
  if (picoRajada >= RAJADA_ATENCAO) {
    add('rajada', picoRajada >= RAJADA_CRITICO ? 'critico' : 'atencao',
      picoRajada + ' finalizações em ' + RAJADA_JANELA_MIN + ' min',
      'Você finalizou ' + picoRajada + ' tarefas em menos de ' + RAJADA_JANELA_MIN + ' minutos. Não dá tempo de conversar com tantos clientes assim — trabalhe uma tarefa por vez.',
      picoRajada + ' "não convertido"/cancelamentos em ' + RAJADA_JANELA_MIN + ' min (' + (picoEm ? dataBRT(picoEm).split('-').reverse().slice(0, 2).join('/') : '') + ').',
      'Indício de "tirar da frente": revisar as tarefas desse horário.', picoRajada);
  }
  if (diasUteisParado >= DIAS_UTEIS_PARADO) {
    add('parado', diasUteisParado >= 3 ? 'critico' : 'atencao',
      'Sem finalizar há ' + diasUteisParado + ' dias úteis',
      'Você está há ' + diasUteisParado + ' dias úteis sem finalizar nenhuma tarefa, com ' + abertas + ' na fila.',
      'Nenhuma tarefa finalizada há ' + diasUteisParado + ' dias úteis, com ' + abertas + ' na fila.',
      'Perguntar o que está travando.', diasUteisParado);
  }
  if (acumuladas >= ACUMULO_ATENCAO || maisAntiga >= MAIS_ANTIGA_ATENCAO) {
    const crit = acumuladas >= ACUMULO_CRITICO || maisAntiga >= MAIS_ANTIGA_CRITICO;
    add('fila_acumulando', crit ? 'critico' : 'atencao',
      'Fila acumulando (' + acumuladas + ')',
      'Você tem ' + acumuladas + ' tarefas de dias anteriores ainda abertas (a mais antiga há ' + maisAntiga + ' dias). Elas não somem: todo dia chegam mais ' + COTA_DIA + '. Comece pelas mais antigas.',
      acumuladas + ' tarefas de dias anteriores; a mais antiga há ' + maisAntiga + ' dias.',
      'Combinar meta diária para zerar as acumuladas.', acumuladas);
  }
  if (comResultado >= MIN_AMOSTRA_TAXA && pctNaoConv >= NAO_CONV_ATENCAO) {
    const p = Math.round(pctNaoConv * 100);
    add('nao_convertido_alto', 'atencao',
      p + '% de "não convertido"',
      p + '% das suas finalizações nos últimos ' + JANELA_DIAS + ' dias foram "não convertido". Antes de finalizar, fale de verdade com o cliente — ou agende um follow-up se ele pediu retorno.',
      fin.nao_convertida + ' de ' + comResultado + ' finalizações sem venda nos últimos ' + JANELA_DIAS + ' dias.',
      'Ver os motivos declarados e ouvir 2 abordagens.', p);
  }
  if (fin.cancelada >= CANCEL_MIN && pctCancel >= CANCEL_ATENCAO) {
    const p = Math.round(pctCancel * 100);
    add('cancelamento_alto', 'atencao',
      p + '% das tarefas canceladas',
      p + '% das suas tarefas foram canceladas nos últimos ' + JANELA_DIAS + ' dias. Cancele só tarefas inválidas (duplicada, já comprou, número errado).',
      fin.cancelada + ' tarefas canceladas pelo próprio vendedor (' + p + '%).',
      'Conferir os motivos de cancelamento.', p);
  }
  if (horaBRT(agora) >= HORA_PARADO_HOJE && abertas > 0 && executadasHoje === 0) {
    add('parado_hoje', 'atencao',
      'Nenhuma tarefa finalizada hoje',
      'Já passou das ' + HORA_PARADO_HOJE + 'h e nenhuma tarefa foi finalizada hoje — você tem ' + abertas + ' esperando.',
      'Nenhuma finalização hoje.', '', abertas, true);
  }

  const alertasGestao = alertas.filter(a => !a.so_vendedor);
  const status = alertasGestao.some(a => a.nivel === 'critico') ? 'acao' : (alertasGestao.length ? 'atencao' : 'ok');
  let saude = 100;
  for (const al of alertasGestao) saude -= al.nivel === 'critico' ? 30 : 15;
  saude = Math.max(0, saude);

  return {
    login: lg,
    hoje,
    status,
    fila: { abertas, de_hoje: deHoje, acumuladas, vencidas, mais_antiga_dias: maisAntiga, por_dia_origem: porDiaOrigem },
    execucao: {
      janela_dias: JANELA_DIAS,
      executadas_hoje: executadasHoje,
      ultima_finalizacao_em: ultimaFinalizacao,
      dias_uteis_parado: diasUteisParado,
      finalizacoes: fin,
      total_finalizadas: totalFinalizadas,
      canceladas_pela_gestao: canceladasGestao,
      taxa_conversao: taxaConversao == null ? null : Math.round(taxaConversao * 100),
      pct_nao_convertido: Math.round(pctNaoConv * 100),
      rastreio_desde: RASTREIO_DESDE,
      nao_convertidas_rastreadas: naoConvRastreio,
      nao_convertidas_sem_contato: naoConvRastreioSemContato,
      pct_sem_contato: pctSemContato == null ? null : Math.round(pctSemContato * 100),
      pct_cancelada: Math.round(pctCancel * 100),
      pico_rajada_10min: picoRajada,
      motivos_nao_conversao: motivos,
    },
    serie,
    contratos,
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
  return paraEquipeSync(acts, vendedores);
}

module.exports = {
  calcular, paraVendedor, paraEquipe, paraEquipeSync,
  dataBRT, hojeBRT, horaBRT, ehContrato, disponivel,
  MOTIVOS_NAO_CONVERSAO, CANAIS, COTA_DIA, JANELA_DIAS, RASTREIO_DESDE,
};
