// lib/crm/collections.js
// Definição das coleções do CRM: enums permitidos, defaults, e função build()
// que valida dados de entrada e retorna o documento pronto pra persistir.
//
// Nesta Fatia 1, as validações são as mínimas: campos obrigatórios, enum válido,
// e o motivo_perda/next_action condicionais das regras críticas do PRD §7.
//
// Regras de conversão (lead → oportunidade, primeira order → onboarding etc)
// ficam pra Fatia 2 (services.js). Aqui é só armazenamento estruturado.

const { uuid, validaCpfCnpj, normalizaCpfCnpj, isEnum } = require('./utils');
const { TIPOS: DOC_TIPOS, calcularStatusValidade } = require('./docsSchemas');

// ── Enums ────────────────────────────────────────────────────────
const E = {
  motion:            ['pf_loja', 'pf_online', 'pj_revenda', 'pj_corporativo'],
  account_tipo:      ['pf', 'pj'],
  account_status:    ['ativo', 'inativo', 'bloqueado'],
  lead_origem:       ['inbound', 'walk_in', 'bling_import', 'referral', 'evento', 'outbound'],
  lead_status:       ['novo', 'contatado', 'qualificado', 'convertido', 'descartado', 'perdido'],
  opp_stage:         ['novo', 'qualificando', 'proposta', 'negociacao', 'fechado_ganho', 'fechado_perdido'],
  referral_tipo:     ['cliente', 'influenciador', 'parceiro_comercial'],
  referral_status:   ['ativo', 'contatado', 'convertido', 'descartado', 'perdido'],
  reward_status:     ['nao_aplica', 'pendente', 'pago'],
  activity_tipo:     ['contato', 'follow_up', 'trigger', 'reativacao', 'onboarding_step', 'manual'],
  activity_status:   ['pendente', 'concluida', 'overdue', 'cancelada'],
  activity_ent:      ['account', 'lead', 'opportunity', 'referral'],
  order_status:      ['rascunho', 'pendente_pagamento', 'pago', 'enviado', 'entregue', 'cancelado', 'devolvido'],
  onboarding_status: ['pendente', 'em_andamento', 'concluido', 'abandonado'],
  onboarding_risco:  ['baixo', 'medio', 'alto'],
  doc_tipo:          ['cr', 'craf', 'cnh'],
  doc_status:        ['em_dia', 'vence_em_90', 'vence_em_60', 'critico', 'vencido', 'sem_validade'],
  arma_acionamento:  ['bolt', 'alavanca', 'pump', 'dois_canos', 'semiautomatico', 'automatico', 'outro', 'pendente'],
  arma_class:        ['permitido', 'restrito', 'proibido', 'pendente'],
  arma_acervo:       ['tiro_desportivo', 'caca', 'colecao', 'pendente'],
};

// Erro de validação semântico — o api handler converte pra 422
class ValidationError extends Error {
  constructor(msg) { super(msg); this.name = 'ValidationError'; this.http = 422; }
}
const need = (val, campo) => { if (val === undefined || val === null || val === '') throw new ValidationError('Campo obrigatório: ' + campo); };
const inEnum = (val, campo, allowed) => { if (!isEnum(val, allowed)) throw new ValidationError('Valor inválido em ' + campo + ': "' + val + '". Aceito: ' + allowed.join(', ')); };

// Utilitário: number seguro (retorna 0 se inválido)
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const str = (v) => (v === undefined || v === null) ? '' : String(v);

// ── ACCOUNTS ─────────────────────────────────────────────────────
function buildAccount(dados) {
  need(dados.tipo, 'tipo');
  inEnum(dados.tipo, 'tipo', E.account_tipo);
  need(dados.nome, 'nome');
  need(dados.owner_id, 'owner_id');
  const cpfcnpj = normalizaCpfCnpj(dados.cpf_cnpj);
  if (cpfcnpj && !validaCpfCnpj(cpfcnpj)) {
    throw new ValidationError('CPF/CNPJ inválido');
  }
  const status = dados.status || 'ativo';
  inEnum(status, 'status', E.account_status);
  return {
    id: dados.id || uuid(),
    tipo: dados.tipo,
    cpf_cnpj: cpfcnpj || null,
    razao_social: str(dados.razao_social) || null,
    nome_fantasia: str(dados.nome_fantasia) || null,
    nome: str(dados.nome),
    email: str(dados.email) || null,
    telefone: str(dados.telefone) || null,
    endereco: dados.endereco || null,
    status,
    owner_id: str(dados.owner_id),
    onboarding_id: dados.onboarding_id || null,
    primeira_compra_em: dados.primeira_compra_em || null,
    ultima_compra_em: dados.ultima_compra_em || null,
    pedidos_count: num(dados.pedidos_count),
    valor_total_compras: num(dados.valor_total_compras),
    categorias_compradas: Array.isArray(dados.categorias_compradas) ? dados.categorias_compradas : [],
    bling_contato_id: dados.bling_contato_id || null,
    tags: Array.isArray(dados.tags) ? dados.tags : [],
    notas: str(dados.notas) || null,
  };
}

// ── CONTACTS ─────────────────────────────────────────────────────
function buildContact(dados) {
  need(dados.account_id, 'account_id');
  need(dados.nome, 'nome');
  return {
    id: dados.id || uuid(),
    account_id: str(dados.account_id),
    nome: str(dados.nome),
    email: str(dados.email) || null,
    telefone: str(dados.telefone) || null,
    cargo: str(dados.cargo) || null,
    is_primary: !!dados.is_primary,
    notas: str(dados.notas) || null,
  };
}

// ── LEADS ────────────────────────────────────────────────────────
function buildLead(dados) {
  need(dados.nome, 'nome');
  need(dados.origem, 'origem');
  inEnum(dados.origem, 'origem', E.lead_origem);
  need(dados.motion, 'motion');
  inEnum(dados.motion, 'motion', E.motion);
  need(dados.owner_id, 'owner_id');
  const status = dados.status || 'novo';
  inEnum(status, 'status', E.lead_status);

  // Regra crítica PRD §7.2: origem=referral exige referral_id
  if (dados.origem === 'referral' && !dados.referral_id) {
    throw new ValidationError('Lead com origem "referral" exige referral_id.');
  }
  // Regra crítica PRD §7.3: perdido/descartado exige motivo
  if ((status === 'perdido' || status === 'descartado') && !str(dados.motivo_perda)) {
    throw new ValidationError('Lead ' + status + ' exige motivo_perda.');
  }
  const cpfcnpj = normalizaCpfCnpj(dados.cpf_cnpj);
  if (cpfcnpj && !validaCpfCnpj(cpfcnpj)) throw new ValidationError('CPF/CNPJ inválido');
  return {
    id: dados.id || uuid(),
    nome: str(dados.nome),
    email: str(dados.email) || null,
    telefone: str(dados.telefone) || null,
    cpf_cnpj: cpfcnpj || null,
    origem: dados.origem,
    motion: dados.motion,
    status,
    owner_id: str(dados.owner_id),
    referral_id: dados.referral_id || null,
    account_id: dados.account_id || null,
    opportunity_id: dados.opportunity_id || null,
    motivo_perda: str(dados.motivo_perda) || null,
    sla_ate: dados.sla_ate || null,
    notas: str(dados.notas) || null,
    convertido_em: dados.convertido_em || null,
  };
}

// ── REFERRALS ────────────────────────────────────────────────────
function buildReferral(dados) {
  need(dados.indicante_nome, 'indicante_nome');
  need(dados.tipo, 'tipo');
  inEnum(dados.tipo, 'tipo', E.referral_tipo);
  need(dados.owner_id, 'owner_id');
  const status = dados.status || 'ativo';
  inEnum(status, 'status', E.referral_status);
  const reward = dados.reward_status || 'nao_aplica';
  inEnum(reward, 'reward_status', E.reward_status);
  // Regra crítica PRD §7.3
  if ((status === 'perdido' || status === 'descartado') && !str(dados.outcome)) {
    throw new ValidationError('Referral ' + status + ' exige outcome.');
  }
  return {
    id: dados.id || uuid(),
    indicante_account_id: dados.indicante_account_id || null,
    indicante_contact_id: dados.indicante_contact_id || null,
    indicante_nome: str(dados.indicante_nome),
    indicante_telefone: str(dados.indicante_telefone) || null,
    indicante_email: str(dados.indicante_email) || null,
    tipo: dados.tipo,
    status,
    owner_id: str(dados.owner_id),
    lead_id: dados.lead_id || null,
    order_id: dados.order_id || null,
    outcome: str(dados.outcome) || null,
    revenue_atribuida: num(dados.revenue_atribuida),
    reward_status: reward,
    reward_valor: num(dados.reward_valor),
    reward_pago_em: dados.reward_pago_em || null,
    sla_ate: dados.sla_ate || null,
    notas: str(dados.notas) || null,
  };
}

// ── OPPORTUNITIES ────────────────────────────────────────────────
function buildOpportunity(dados) {
  need(dados.account_id, 'account_id');
  need(dados.motion, 'motion');
  inEnum(dados.motion, 'motion', E.motion);
  need(dados.owner_id, 'owner_id');
  const stage = dados.stage || 'novo';
  inEnum(stage, 'stage', E.opp_stage);
  // Regra crítica PRD §7.1: next_action obrigatória, EXCETO em fechado_perdido
  if (stage !== 'fechado_perdido') {
    if (!str(dados.next_action)) throw new ValidationError('Oportunidade exige next_action (exceto se stage=fechado_perdido).');
    if (!dados.next_action_date) throw new ValidationError('Oportunidade exige next_action_date.');
  }
  if (stage === 'fechado_perdido' && !str(dados.motivo_perda)) {
    throw new ValidationError('Oportunidade fechada_perdida exige motivo_perda.');
  }
  return {
    id: dados.id || uuid(),
    lead_id: dados.lead_id || null,
    account_id: str(dados.account_id),
    referral_id: dados.referral_id || null,
    motion: dados.motion,
    stage,
    owner_id: str(dados.owner_id),
    valor_esperado: num(dados.valor_esperado),
    produtos_esperados: Array.isArray(dados.produtos_esperados) ? dados.produtos_esperados : [],
    next_action: str(dados.next_action) || null,
    next_action_date: dados.next_action_date || null,
    motivo_perda: str(dados.motivo_perda) || null,
    order_id: dados.order_id || null,
    notas: str(dados.notas) || null,
    fechado_em: dados.fechado_em || null,
  };
}

// ── ACTIVITIES ───────────────────────────────────────────────────
function buildActivity(dados) {
  need(dados.tipo, 'tipo');
  inEnum(dados.tipo, 'tipo', E.activity_tipo);
  need(dados.owner_id, 'owner_id');
  need(dados.entidade_tipo, 'entidade_tipo');
  inEnum(dados.entidade_tipo, 'entidade_tipo', E.activity_ent);
  need(dados.entidade_id, 'entidade_id');
  need(dados.titulo, 'titulo');
  need(dados.prazo, 'prazo');
  const status = dados.status || 'pendente';
  inEnum(status, 'status', E.activity_status);
  return {
    id: dados.id || uuid(),
    tipo: dados.tipo,
    status,
    owner_id: str(dados.owner_id),
    entidade_tipo: dados.entidade_tipo,
    entidade_id: str(dados.entidade_id),
    titulo: str(dados.titulo),
    descricao: str(dados.descricao) || null,
    prazo: dados.prazo,
    concluido_em: dados.concluido_em || null,
    concluido_com_order_id: dados.concluido_com_order_id || null,
    pontos_base: num(dados.pontos_base),
    pontos_bonus: num(dados.pontos_bonus),
    pontos_ganhos: num(dados.pontos_ganhos),
    trigger_id: dados.trigger_id || null,
    gerada_automaticamente: !!dados.gerada_automaticamente,
  };
}

// ── ORDERS ───────────────────────────────────────────────────────
function buildOrder(dados) {
  need(dados.account_id, 'account_id');
  need(dados.vendedor_id, 'vendedor_id');
  need(dados.data_pedido, 'data_pedido');
  const status = dados.status || 'rascunho';
  inEnum(status, 'status', E.order_status);
  const itens = Array.isArray(dados.itens) ? dados.itens.map(it => ({
    sku: str(it.sku),
    descricao: str(it.descricao),
    categoria: str(it.categoria) || null,
    quantidade: num(it.quantidade),
    valor_unitario: num(it.valor_unitario),
    valor_total_item: num(it.valor_total_item || (num(it.quantidade) * num(it.valor_unitario))),
  })) : [];
  const valorTotalCalc = itens.reduce((s, it) => s + it.valor_total_item, 0);
  return {
    id: dados.id || uuid(),
    bling_pedido_id: dados.bling_pedido_id || null,
    bling_numero: dados.bling_numero || null,
    account_id: str(dados.account_id),
    opportunity_id: dados.opportunity_id || null,
    referral_id: dados.referral_id || null,
    vendedor_id: str(dados.vendedor_id),
    status,
    valor_total: num(dados.valor_total) || valorTotalCalc,
    itens,
    data_pedido: dados.data_pedido,
    data_pagamento: dados.data_pagamento || null,
    data_envio: dados.data_envio || null,
    data_entrega: dados.data_entrega || null,
    notas: str(dados.notas) || null,
    sincronizado_bling_em: dados.sincronizado_bling_em || null,
  };
}

// ── ONBOARDINGS ──────────────────────────────────────────────────
const CHECKLIST_PADRAO = [
  { item: 'Confirmar recebimento do produto', concluido: false, concluido_em: null },
  { item: 'Contato de satisfação inicial (7 dias)', concluido: false, concluido_em: null },
  { item: 'Explicar garantia e suporte', concluido: false, concluido_em: null },
  { item: 'Cadastrar em canal de comunicação (grupo WhatsApp)', concluido: false, concluido_em: null },
  { item: 'Agendar follow-up de 30 dias', concluido: false, concluido_em: null },
];

function buildOnboarding(dados) {
  need(dados.account_id, 'account_id');
  need(dados.order_id, 'order_id');
  need(dados.owner_id, 'owner_id');
  const status = dados.status || 'pendente';
  inEnum(status, 'status', E.onboarding_status);
  const risco = dados.risco || 'baixo';
  inEnum(risco, 'risco', E.onboarding_risco);
  const checklist = Array.isArray(dados.checklist) && dados.checklist.length
    ? dados.checklist
    : CHECKLIST_PADRAO.map(x => ({ ...x }));
  return {
    id: dados.id || uuid(),
    account_id: str(dados.account_id),
    order_id: str(dados.order_id),
    owner_id: str(dados.owner_id),
    status,
    risco,
    checklist,
    concluido_em: dados.concluido_em || null,
  };
}

// ── DOCUMENTOS ───────────────────────────────────────────────────
// Documento regulatório (CR, CRAF, CNH...) atrelado a uma Account via CPF.
// Os campos específicos por tipo (ex: arma_calibre no CRAF) vivem dentro de
// `dados` — um sub-objeto livre. Isso deixa a estrutura estável mesmo se novos
// tipos forem adicionados no futuro.
function buildDocumento(dados) {
  need(dados.tipo, 'tipo');
  inEnum(dados.tipo, 'tipo', E.doc_tipo);
  need(dados.account_id, 'account_id');
  need(dados.cpf, 'cpf');
  const cpf = normalizaCpfCnpj(dados.cpf);
  if (!validaCpfCnpj(cpf)) throw new ValidationError('CPF do documento inválido.');
  // hash é obrigatório — vem do OCR endpoint
  if (!dados.hash_arquivo) throw new ValidationError('hash_arquivo obrigatório (evita duplicata).');
  const validade = dados.validade || null;
  const st = calcularStatusValidade(validade);
  return {
    id: dados.id || uuid(),
    tipo: dados.tipo,
    account_id: str(dados.account_id),
    owner_id: str(dados.owner_id) || null,       // quem cadastrou (auditoria)
    cpf,
    titular_nome: str(dados.titular_nome) || null,
    numero: str(dados.numero) || null,           // numero_cr, numero_registro etc
    validade,                                    // AAAA-MM-DD
    status_validade: st.status,                  // derivado, guarda pra query rápida
    orgao_emissor: str(dados.orgao_emissor) || null,
    data_emissao: dados.data_emissao || null,
    dados_extraidos: dados.dados_extraidos || {},// TUDO que o OCR extraiu (dict livre)
    hash_arquivo: str(dados.hash_arquivo),
    ocr_extraido_em: dados.ocr_extraido_em || new Date().toISOString(),
    revisado_por: str(dados.revisado_por) || null,
    revisado_em: dados.revisado_em || null,
    arma_id: dados.arma_id || null,              // preenchido se CRAF virou/atualizou Arma
    notas: str(dados.notas) || null,
    avisos_ocr: Array.isArray(dados.avisos_ocr) ? dados.avisos_ocr : [],
  };
}

// ── ARMAS ────────────────────────────────────────────────────────
// Uma arma por número de série, na cartela de uma Account. Nasce via CRAF.
// Se o CRAF renovar, a Arma continua a mesma; só o CRAF vigente muda.
function buildArma(dados) {
  need(dados.account_id, 'account_id');
  need(dados.numero_serie, 'numero_serie');
  const acionamento = dados.acionamento || 'pendente';
  inEnum(acionamento, 'acionamento', E.arma_acionamento);
  const classificacao = dados.classificacao || 'pendente';
  inEnum(classificacao, 'classificacao', E.arma_class);
  const acervo = dados.acervo || 'pendente';
  inEnum(acervo, 'acervo', E.arma_acervo);
  return {
    id: dados.id || uuid(),
    account_id: str(dados.account_id),
    owner_id: str(dados.owner_id) || null,       // quem cadastrou
    numero_serie: str(dados.numero_serie),
    numero_sigma: str(dados.numero_sigma) || null,
    tipo: str(dados.tipo) || null,               // 'carabina', 'pistola', 'espingarda' etc
    marca: str(dados.marca) || null,
    modelo: str(dados.modelo) || null,
    calibre: str(dados.calibre) || null,
    acionamento,                                  // 'pendente' até vendedor classificar
    classificacao,                                // 'pendente' até acionamento definido
    acervo,                                       // qual acervo do CAC essa arma pertence
    // Campos extras pra colecionismo (opcional, preenchido só se acervo='colecao'):
    variante: str(dados.variante) || null,
    procedencia_pais: str(dados.procedencia_pais) || null,
    modelo_ano_primeiro_lote: dados.modelo_ano_primeiro_lote || null,
    craf_atual_id: dados.craf_atual_id || null,   // ref pro documento CRAF vigente
    crafs_historico: Array.isArray(dados.crafs_historico) ? dados.crafs_historico : [],
    notas: str(dados.notas) || null,
    // Log de quem preencheu acionamento e quando (auditoria):
    acionamento_definido_por: str(dados.acionamento_definido_por) || null,
    acionamento_definido_em: dados.acionamento_definido_em || null,
  };
}

// ── Registry das coleções ────────────────────────────────────────
// Cada entrada mapeia o nome da coleção pra:
//   - build(dados) → doc validado pronto pra persistir
//   - allowedPatchKeys? → whitelist opcional de campos que updateDoc aceita
//     (protege campos calculados/derivados). Se undefined = qualquer key.
const REGISTRY = {
  accounts:      { build: buildAccount },
  contacts:      { build: buildContact },
  leads:         { build: buildLead },
  referrals:     { build: buildReferral },
  opportunities: { build: buildOpportunity },
  activities:    { build: buildActivity },
  orders:        { build: buildOrder },
  onboardings:   { build: buildOnboarding },
  documentos:    { build: buildDocumento },
  armas:         { build: buildArma },
};

module.exports = {
  E,
  REGISTRY,
  ValidationError,
  CHECKLIST_PADRAO,
};
