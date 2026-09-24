// lib/crm/envios.js
// Coleção "envios" — 1 doc por pedido em processamento na Operação Controlado.
// Identifica o pedido por (empresa, numero) — chave composta, porque o mesmo
// número pode existir nas duas empresas (Pro Hunters + Calibre Restrito).
//
// Estado do envio:
//   - status: 'aberto' | 'pronto_coleta' | 'cancelado'
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
  'status', 'cancelado_motivo',
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
      if (_isAereo(c) && (!c.comprovante_pix_link || !c.peso_kg || !c.dimensoes_cm || !c.minuta_numero)) return 'travado';
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
    if (!env.comprovante_pix_link) p.push('comprovante_pix_link');
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
  // Se marcaram liberacao_ok e checklist está completo, muda status
  if (patch && patch.liberacao_ok) {
    const est = estadoChecklist(out);
    if (est.pronto_coleta) out.status = 'pronto_coleta';
  }
  out.historico = ((envAtual.historico || []).concat(eventos)).slice(-200);
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
};
