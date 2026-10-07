// lib/crm/envios.js
// Coleção "envios" — 1 doc por pedido em processamento na Operação Controlado.
// Identifica o pedido por (empresa, numero) — chave composta, porque o mesmo
// número pode existir nas duas empresas (Pro Hunters + Calibre Restrito).
//
// Estado do envio:
//   - status: 'aberto' | 'pronto_coleta' | 'enviado' | 'cancelado'
//     ('enviado' = motorista coletou via romaneio; sai da Fila, vai pra "Enviados")
//   - checklist: 8 passos com auto-verde por campo-gatilho
//   - campos condicionais: cnpj (Anexo P + GRU), aereo (Pix + peso/medidas + Minuta)
//
// Regras de trava:
//   - Passo 5 (faturamento) só destrava se passo 4 (transporte) verde.
//   - Rota aérea: passo 5 só destrava se comprovante_pix estiver marcado.
//   - CNPJ: passo 8 (liberação) só destrava se anexo_p e gru estiverem preenchidos.
//   - Liberação só destrava se tudo obrigatório verde.

const { uuid } = require('./utils');

const PASSOS = [
  { id: 'abertura',        num: 1, titulo: 'Abertura',                 dono: 'auxiliar',   auto_campo: 'confirmado_bling' },
  { id: 'volumes',         num: 2, titulo: 'Volumes embalados',        dono: 'expedicao',  auto_campo: 'volumes_qtd' },
  { id: 'conferencia',     num: 3, titulo: 'Conferência do vendedor',  dono: 'vendas',     auto_campo: 'conferencia_ok' },
  { id: 'transporte',      num: 4, titulo: 'Transporte',               dono: 'auxiliar',   auto_campo: 'transportadora' },
  { id: 'faturamento',     num: 5, titulo: 'Faturamento',              dono: 'financeiro', auto_campo: 'nf_numero' },
  { id: 'gt',              num: 6, titulo: 'Guia de Trânsito (GT)',    dono: 'auxiliar',   auto_campo: 'gt_numero' },
  { id: 'assinatura',      num: 7, titulo: 'Assinatura',               dono: 'gerencia',   auto_campo: 'assinatura_ok' },
  { id: 'liberacao',       num: 8, titulo: 'Liberação final',          dono: 'expedicao',  auto_campo: 'liberacao_ok' },
];

const CAMPOS_CONDICIONAIS = {
  cnpj:  ['anexo_p_ok', 'gru_ok'],
  aereo: ['pix_baixado', 'peso_kg', 'dimensoes_cm', 'minuta_numero', 'aeroporto_iata'],
};

// Whitelist de campos que PATCH aceita — protege o resto (chave, ids, criado_por…)
const ALLOWED_PATCH_KEYS = [
  // dados do pedido — só a Abertura escreve (após confirmar Bling)
  'confirmado_bling', 'cliente_nome', 'cliente_cpf_cnpj', 'cliente_cpf_cnpj_tipo',
  'cliente_endereco', 'cliente_cidade', 'cliente_uf', 'cliente_cep',
  'produtos', 'total_pedido', 'observacoes',
  // por passo
  'volumes_qtd', 'volumes_por', 'volumes_em',
  'conferencia_ok', 'conferencia_por', 'conferencia_em', 'conferencia_notas',
  'transportadora', 'transporte_valor', 'transporte_por', 'transporte_em',
  'nf_numero', 'nf_por', 'nf_em',
  'gt_numero', 'gt_por', 'gt_em',
  'assinatura_ok', 'assinatura_por', 'assinatura_em',
  'liberacao_ok', 'liberacao_por', 'liberacao_em',
  // condicionais CNPJ (checkboxes com auditoria de login+IP)
  'anexo_p_ok', 'anexo_p_por', 'anexo_p_em', 'anexo_p_ip',
  'gru_ok', 'gru_por', 'gru_em', 'gru_ip',
  // legado — mantidos pra compat com envios antigos que gravaram link
  'anexo_p_link', 'gru_link',
  // condicionais AÉREO
  'comprovante_pix_link', 'pix_baixado', 'pix_por', 'pix_em', 'pix_ip',
  'peso_kg', 'dimensoes_cm', 'minuta_numero', 'aeroporto_iata',
  // meta
  'status', 'cancelado_motivo', 'cancelado_por', 'cancelado_em',
  // retirada em loja (cliente retira presencialmente)
  'retirado_em', 'retirado_por', 'retirado_cliente_nome', 'retirado_cliente_doc', 'retirado_nota',
  // romaneio — quando o motorista pega, o envio recebe estas marcações
  'romaneio_id', 'romaneio_numero', 'coletado_em', 'coletado_motorista', 'coletado_motorista_cpf', 'coletado_placa',
];

// Cria doc novo. Chamado por POST /api/envios/abrir com dados vindos do Bling.
function buildEnvio(dados) {
  if (!dados.empresa) throw new Error('empresa obrigatória');
  if (!dados.numero) throw new Error('número obrigatório');
  const empresa = String(dados.empresa).toLowerCase().trim();
  const numero = String(dados.numero).trim();
  const id = 'env_' + empresa + '_' + numero;
  return {
    id,
    empresa,                          // 'prohunters' | 'calibre'
    numero,                           // "4132"
    bling_pedido_id: dados.bling_pedido_id || null,
    // Dados vindos do Bling (imutáveis após criação, pra proteger contra bug)
    cliente_nome: dados.cliente_nome || null,
    cliente_cpf_cnpj: dados.cliente_cpf_cnpj || null,
    cliente_cpf_cnpj_tipo: dados.cliente_cpf_cnpj_tipo || null, // 'pf' | 'pj'
    cliente_endereco: dados.cliente_endereco || null,
    cliente_cidade: dados.cliente_cidade || null,
    cliente_uf: dados.cliente_uf || null,
    cliente_cep: dados.cliente_cep || null,
    produtos: dados.produtos || [], // [{sku, descricao, quantidade}]
    total_pedido: Number(dados.total_pedido) || 0,
    observacoes: dados.observacoes || null,
    // Vendedor responsavel — puxado do Bling na abertura do envio. Ajuda a
    // localizar rapido quem fechou a venda pra tirar duvida (ex: o cliente
    // ligou reclamando de um produto do pedido, quem falou com ele?).
    vendedor_bling: dados.vendedor_bling || null, // {id, nome} ou null se pedido sem vendedor
    // Estado do checklist
    status: 'aberto',
    confirmado_bling: true, // criação sempre confirma; passo 1 acende
    // Campos por passo (preenchimento auto acende passo)
    volumes_qtd: null,
    volumes_por: null, volumes_em: null,
    conferencia_ok: false,
    conferencia_por: null, conferencia_em: null, conferencia_notas: null,
    transportadora: null,     // 'ezequiel'|'lt'|'rpa'|'aereo'
    transporte_valor: null,
    transporte_por: null, transporte_em: null,
    nf_numero: null,
    nf_por: null, nf_em: null,
    gt_numero: null,
    gt_por: null, gt_em: null,
    assinatura_ok: false,
    assinatura_por: null, assinatura_em: null,
    liberacao_ok: false,
    liberacao_por: null, liberacao_em: null,
    // Campos condicionais
    // Condicionais CNPJ — checkboxes com auditoria (login + IP + hora)
    anexo_p_ok: false, anexo_p_por: null, anexo_p_em: null, anexo_p_ip: null,
    gru_ok: false,     gru_por: null,     gru_em: null,     gru_ip: null,
    // Legado (só se algum envio antigo tiver gravado o link)
    anexo_p_link: null,
    gru_link: null,
    comprovante_pix_link: null,
    pix_baixado: false,
    peso_kg: null,
    dimensoes_cm: null,
    minuta_numero: null,
    aeroporto_iata: null,
    // Romaneio (preenchido quando o motorista coleta)
    romaneio_id: null,
    romaneio_numero: null,
    coletado_em: null,
    coletado_motorista: null,
    coletado_motorista_cpf: null,
    coletado_placa: null,
    // Retirada em loja (cliente ou representante retira presencialmente,
    // sem transportadora). Quando preenchido, o envio sai da fila (status='retirado')
    // e dispara notificacao pro financeiro+gerencia.
    retirado_em: null,
    retirado_por: null,              // login do operador que registrou
    retirado_cliente_nome: null,     // quem retirou (cliente ou representante)
    retirado_cliente_doc: null,      // CPF/RG de quem retirou
    retirado_nota: null,
    // Cancelamento (quando alguem sobe errado e precisa remover da fila).
    cancelado_motivo: null,
    cancelado_por: null,
    cancelado_em: null,
    // Histórico de mudanças (append-only, últimos 200 eventos)
    historico: [
      { ts: new Date().toISOString(), por: dados.criado_por || 'sistema',
        acao: 'envio_criado', detalhe: 'empresa=' + empresa + ' numero=' + numero },
    ],
  };
}

// ─────────────────────────────────────────────────────────────
// Avaliação de estado do checklist e travas
// ─────────────────────────────────────────────────────────────

function _isCNPJ(env) {
  return env && env.cliente_cpf_cnpj_tipo === 'pj';
}
function _isAereo(env) {
  return env && env.transportadora === 'aereo';
}

// Retorna estado de cada passo: 'done' | 'wait' | 'travado'
function estadoPasso(env, passo) {
  const c = env || {};
  switch (passo.id) {
    case 'abertura':
      return c.confirmado_bling ? 'done' : 'wait';
    case 'volumes':
      return (c.volumes_qtd && Number(c.volumes_qtd) > 0) ? 'done' : 'wait';
    case 'conferencia':
      return c.conferencia_ok ? 'done' : 'wait';
    case 'transporte':
      return c.transportadora ? 'done' : 'wait';
    case 'faturamento': {
      // Trava se transporte não escolhido
      if (!c.transportadora) return 'travado';
      // Rota aérea: trava até Pix ser baixado
      if (_isAereo(c) && !c.pix_baixado) return 'travado';
      return c.nf_numero ? 'done' : 'wait';
    }
    case 'gt':
      if (!c.nf_numero) return 'travado';
      return c.gt_numero ? 'done' : 'wait';
    case 'assinatura':
      if (!c.gt_numero) return 'travado';
      return c.assinatura_ok ? 'done' : 'wait';
    case 'liberacao': {
      // Trava até tudo obrigatório verde
      if (!c.assinatura_ok) return 'travado';
      if (_isCNPJ(c) && (!c.anexo_p_ok || !c.gru_ok)) return 'travado';
      if (_isAereo(c) && (!c.pix_baixado || !c.peso_kg || !c.dimensoes_cm || !c.minuta_numero)) return 'travado';
      return c.liberacao_ok ? 'done' : 'wait';
    }
    default:
      return 'wait';
  }
}

// Snapshot completo pra UI
function estadoChecklist(env) {
  const passos = PASSOS.map(p => ({
    ...p,
    estado: estadoPasso(env, p),
    ator: env[p.auto_campo.replace('_qtd','') + '_por'] || env[p.dono + '_por'] || null,
    em: env[p.auto_campo.replace('_qtd','') + '_em'] || null,
    valor: env[p.auto_campo],
  }));
  const feitos = passos.filter(p => p.estado === 'done').length;
  const total = passos.length;
  const pronto = passos.every(p => p.estado === 'done');
  const proximo = passos.find(p => p.estado === 'wait') || null;
  return {
    feitos, total,
    passos,
    pronto_coleta: pronto,
    proximo_passo: proximo ? { id: proximo.id, titulo: proximo.titulo, dono: proximo.dono } : null,
    cnpj: _isCNPJ(env),
    aereo: _isAereo(env),
    condicionais_pendentes: _condicionaisPendentes(env),
  };
}

function _condicionaisPendentes(env) {
  const p = [];
  if (_isCNPJ(env)) {
    if (!env.anexo_p_ok) p.push('anexo_p_ok');
    if (!env.gru_ok) p.push('gru_ok');
  }
  if (_isAereo(env)) {
    if (!env.pix_baixado) p.push('pix_baixado');
    if (!env.peso_kg) p.push('peso_kg');
    if (!env.dimensoes_cm) p.push('dimensoes_cm');
    if (!env.minuta_numero) p.push('minuta_numero');
    if (!env.aeroporto_iata) p.push('aeroporto_iata');
  }
  return p;
}

// Aplica patch: só campos da whitelist, carimba autor/hora/IP quando aplicável.
// Os campos anexo_p_ok, gru_ok, pix_baixado carregam também IP de auditoria.
function aplicarPatch(envAtual, patch, actor, ip) {
  const now = new Date().toISOString();
  const out = { ...envAtual };
  const eventos = [];
  for (const [k, v] of Object.entries(patch || {})) {
    if (!ALLOWED_PATCH_KEYS.includes(k)) continue;
    if (out[k] === v) continue;
    // Não sobrescreve dados imutáveis do Bling
    if (['cliente_nome','cliente_cpf_cnpj','cliente_cpf_cnpj_tipo','produtos','total_pedido','bling_pedido_id'].includes(k)) continue;
    out[k] = v;
    eventos.push({ ts: now, por: actor || null, ip: ip || null, acao: 'campo_alterado', campo: k, novo: v });

    // Carimba autor/hora do passo correspondente
    const stampMap = {
      volumes_qtd: ['volumes_por', 'volumes_em'],
      conferencia_ok: ['conferencia_por', 'conferencia_em'],
      transportadora: ['transporte_por', 'transporte_em'],
      transporte_valor: ['transporte_por', 'transporte_em'],
      nf_numero: ['nf_por', 'nf_em'],
      gt_numero: ['gt_por', 'gt_em'],
      assinatura_ok: ['assinatura_por', 'assinatura_em'],
      liberacao_ok: ['liberacao_por', 'liberacao_em'],
    };
    if (stampMap[k] && v) {
      const [porK, emK] = stampMap[k];
      if (!out[porK]) out[porK] = actor || null;
      if (!out[emK]) out[emK] = now;
    }

    // Campos com AUDITORIA DE IP (checkboxes CNPJ/Aéreo)
    // Ao marcar como true → registra login + IP + hora. Ao desmarcar → limpa auditoria.
    const auditMap = {
      anexo_p_ok:  ['anexo_p_por',  'anexo_p_em',  'anexo_p_ip'],
      gru_ok:      ['gru_por',      'gru_em',      'gru_ip'],
      pix_baixado: ['pix_por',      'pix_em',      'pix_ip'],
    };
    if (auditMap[k]) {
      const [porK, emK, ipK] = auditMap[k];
      if (v) {
        out[porK] = actor || null;
        out[emK] = now;
        out[ipK] = ip || null;
      } else {
        out[porK] = null; out[emK] = null; out[ipK] = null;
      }
    }
  }
  // Se o checklist ficou completo em CONSEQUÊNCIA deste patch, promove pra 'pronto_coleta'
  // (não só quando patch.liberacao_ok — o vendedor pode marcar o último condicional
  // DEPOIS da liberação, por exemplo Anexo P/GRU ou peso/medidas, e isso também deve
  // liberar o status).
  if (out.status !== 'enviado' && out.status !== 'cancelado') {
    const est = estadoChecklist(out);
    if (est.pronto_coleta) out.status = 'pronto_coleta';
    else if (out.status === 'pronto_coleta') out.status = 'aberto'; // reverteu (ex: desmarcou algo)
  }
  out.historico = ((envAtual.historico || []).concat(eventos)).slice(-200);
  return out;
}

// Reverte um passo especifico — zera os campos-gatilho + auditoria daquele
// passo, deixando os outros intocados. Passos POSTERIORES que dependiam deste
// automaticamente voltam pra 'travado' via estadoPasso, sem apagar seus valores
// (se o usuario refizer este passo com o mesmo valor, os posteriores destravam
// preservando o que ja havia sido feito). Escolha consciente pra evitar perder
// dados em cascata por engano.
//
// Nao permite reverter o passo 'abertura' — se quiser desfazer, cancela o envio.
function reverterPasso(env, passoId, actor, ip) {
  if (passoId === 'abertura') {
    throw new Error('A abertura nao pode ser revertida. Cancele o envio se necessario.');
  }
  const passo = PASSOS.find(p => p.id === passoId);
  if (!passo) throw new Error('Passo desconhecido: ' + passoId);
  const CAMPOS_POR_PASSO = {
    volumes:     ['volumes_qtd', 'volumes_por', 'volumes_em'],
    conferencia: ['conferencia_ok', 'conferencia_por', 'conferencia_em', 'conferencia_notas'],
    transporte:  ['transportadora', 'transporte_valor', 'transporte_por', 'transporte_em'],
    faturamento: ['nf_numero', 'nf_por', 'nf_em'],
    gt:          ['gt_numero', 'gt_por', 'gt_em'],
    assinatura:  ['assinatura_ok', 'assinatura_por', 'assinatura_em'],
    liberacao:   ['liberacao_ok', 'liberacao_por', 'liberacao_em'],
  };
  const campos = CAMPOS_POR_PASSO[passoId] || [];
  const out = { ...env };
  const now = new Date().toISOString();
  for (const k of campos) {
    // Booleans viram false; o resto vira null
    out[k] = (typeof env[k] === 'boolean') ? false : null;
  }
  // Se o envio estava 'pronto_coleta', volta pra 'aberto'
  if (out.status === 'pronto_coleta') out.status = 'aberto';
  // Historico
  const evento = { ts: now, por: actor || null, ip: ip || null,
    acao: 'passo_revertido', passo: passoId, titulo: passo.titulo };
  out.historico = ((env.historico || []).concat([evento])).slice(-200);
  return out;
}

// ─────────────────────────────────────────────────────────────
// CANCELAMENTO — remover da fila quando alguem subiu errado
// ─────────────────────────────────────────────────────────────
// Soft delete: marca status='cancelado' e grava motivo. Nao apaga o doc,
// mantem no historico. Nao reverte os passos ja preenchidos (podem ser uteis
// pra auditoria do que foi feito ate ali).
function cancelarEnvio(envAtual, { motivo, actor, ip }) {
  if (envAtual.status === 'enviado') {
    throw new Error('Envio ja foi coletado (nao pode cancelar).');
  }
  if (envAtual.status === 'cancelado') {
    throw new Error('Envio ja estava cancelado.');
  }
  if (envAtual.status === 'retirado') {
    throw new Error('Envio ja foi retirado pelo cliente (nao pode cancelar).');
  }
  if (envAtual.romaneio_id) {
    throw new Error('Envio esta em um romaneio aberto. Cancele o romaneio antes.');
  }
  const now = new Date().toISOString();
  const out = { ...envAtual };
  out.status = 'cancelado';
  out.cancelado_motivo = motivo ? String(motivo).trim().slice(0, 500) : null;
  out.cancelado_por = actor || null;
  out.cancelado_em = now;
  const evento = { ts: now, por: actor || null, ip: ip || null,
    acao: 'envio_cancelado', motivo: out.cancelado_motivo };
  out.historico = ((envAtual.historico || []).concat([evento])).slice(-200);
  return out;
}

// ─────────────────────────────────────────────────────────────
// RETIRADA EM LOJA — cliente retira presencialmente, sem transportadora
// ─────────────────────────────────────────────────────────────
// Alternativa ao romaneio. Marca o envio como RETIRADO (sai da fila) e
// dispara notificacao pro financeiro+gerencia (feito no api/index.js).
// Exige que a NF ja tenha sido emitida — cliente nao pode retirar sem nota.
function marcarRetirado(envAtual, { retirado_cliente_nome, retirado_cliente_doc, nota, actor, ip }) {
  if (envAtual.status === 'enviado') {
    throw new Error('Envio ja foi coletado por transportadora.');
  }
  if (envAtual.status === 'cancelado') {
    throw new Error('Envio esta cancelado.');
  }
  if (envAtual.status === 'retirado') {
    throw new Error('Envio ja foi marcado como retirado.');
  }
  if (envAtual.romaneio_id) {
    throw new Error('Envio esta em romaneio aberto. Nao pode marcar como retirado.');
  }
  if (!envAtual.nf_numero) {
    throw new Error('Precisa emitir a Nota Fiscal antes de liberar a retirada.');
  }
  if (!retirado_cliente_nome || !String(retirado_cliente_nome).trim()) {
    throw new Error('Nome de quem retirou é obrigatório.');
  }
  const now = new Date().toISOString();
  const out = { ...envAtual };
  out.status = 'retirado';
  out.retirado_em = now;
  out.retirado_por = actor || null;
  out.retirado_cliente_nome = String(retirado_cliente_nome).trim().slice(0, 200);
  out.retirado_cliente_doc = retirado_cliente_doc ? String(retirado_cliente_doc).trim().slice(0, 60) : null;
  out.retirado_nota = nota ? String(nota).trim().slice(0, 500) : null;
  const evento = { ts: now, por: actor || null, ip: ip || null,
    acao: 'envio_retirado',
    cliente: out.retirado_cliente_nome,
    doc: out.retirado_cliente_doc };
  out.historico = ((envAtual.historico || []).concat([evento])).slice(-200);
  return out;
}

module.exports = {
  PASSOS,
  CAMPOS_CONDICIONAIS,
  ALLOWED_PATCH_KEYS,
  buildEnvio,
  estadoChecklist,
  estadoPasso,
  aplicarPatch,
  reverterPasso,
  cancelarEnvio,
  marcarRetirado,
};
 
