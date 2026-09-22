// lib/bling/contasReceber.js
// Puxa contas a receber do Bling v3 pra um cliente específico, em uma ou
// mais contas Bling (Pro Hunters + Calibre). Não guarda nada no CRM — busca
// ao vivo, porque contas a receber mudam o tempo todo (pagamentos entrando)
// e cache aqui daria informação errada.
//
// Uso típico:
//   const out = await buscarEmAbertoDoCliente({ cpf, idsPorConta });
//   // out = { total_em_aberto, total_atrasado, contas: [ ... ] }

const blingApi = require('./api');
const config = require('../../config');

// Situações do Bling v3 pra contas a receber:
//   1 = Em aberto
//   2 = Recebido
//   3 = Parcialmente recebido
//   4 = Devolvido
//   5 = Cancelado
// Consideramos "em aberto" = 1 e 3.
const SIT_EM_ABERTO = 1;
const SIT_PARCIAL   = 3;
const SIT_LABEL = { 1: 'em_aberto', 2: 'recebido', 3: 'parcial', 4: 'devolvido', 5: 'cancelado' };

// ── Descobre o idContato dessa conta Bling a partir do CPF/CNPJ ──
// Se você já tem o id na conta (bling_contato_id_por_conta[cid]), passa direto
// e evita esta chamada extra.
async function _acharIdContatoPorCpf(cpf, contaId) {
  if (!cpf) return null;
  // A API v3 aceita "criterio" que casa por documento também.
  // Tenta primeiro o filtro estruturado, se falhar cai pra criterio.
  try {
    const r = await blingApi.get('/contatos', { numeroDocumento: cpf, limite: 5 }, contaId);
    if (r && r.data && r.data.length) return String(r.data[0].id);
  } catch (e) { /* tenta próximo */ }
  try {
    const r = await blingApi.get('/contatos', { criterio: cpf, limite: 5 }, contaId);
    if (r && r.data && r.data.length) {
      // Filtra por CPF exato (caso o criterio retorne matches parciais)
      const match = r.data.find(c => {
        const d = String(c.numeroDocumento || '').replace(/\D/g, '');
        return d === String(cpf).replace(/\D/g, '');
      }) || r.data[0];
      return String(match.id);
    }
  } catch (e) { /* nada */ }
  return null;
}

// ── Puxa contas a receber (em aberto + parciais) DE UM contato NA conta ──
async function _buscarNaConta({ idContato, cpf, contaId }) {
  // Descobre id do contato se não veio pronto
  let cid = idContato;
  if (!cid && cpf) {
    cid = await _acharIdContatoPorCpf(cpf, contaId);
  }
  if (!cid) return { contaId, idContato: null, contas: [], motivo: 'contato não encontrado nesta conta' };

  // Busca contas a receber em aberto + parciais
  // Bling v3: /contas/receber aceita idContato + situacoes[]=X (múltiplos)
  const query = {
    'idContato': cid,
    'situacoes[]': [SIT_EM_ABERTO, SIT_PARCIAL],
    limite: 100,
    pagina: 1,
  };
  let todas = [];
  let pagina = 1;
  const MAX_PAG = 5; // safety — no máximo 500 contas por cliente
  while (pagina <= MAX_PAG) {
    query.pagina = pagina;
    let r;
    try {
      r = await blingApi.get('/contas/receber', query, contaId);
    } catch (e) {
      // Se o endpoint retornar erro (ex: escopo faltando), devolve o que já temos
      return { contaId, idContato: cid, contas: todas, erro: e.message };
    }
    const lote = (r && r.data) || [];
    if (!lote.length) break;
    todas = todas.concat(lote);
    if (lote.length < 100) break;
    pagina++;
  }

  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  const contas = todas.map(c => {
    const vencimento = c.vencimento || c.dataVencimento || null;
    let diasAtraso = null;
    if (vencimento) {
      const d = new Date(vencimento);
      diasAtraso = Math.floor((hoje - d) / 86400000);
    }
    return {
      bling_conta_origem: contaId,
      id: c.id,
      historico: c.historico || c.descricao || null,
      valor: Number(c.valor || 0),
      saldo: Number(c.saldo != null ? c.saldo : c.valor || 0),
      vencimento,
      data_emissao: c.dataEmissao || null,
      situacao: SIT_LABEL[c.situacao] || String(c.situacao),
      situacao_codigo: c.situacao,
      dias_atraso: diasAtraso,
      em_atraso: (diasAtraso != null && diasAtraso > 0),
      forma_pagamento: c.formaPagamento ? (c.formaPagamento.descricao || null) : null,
      link_boleto: c.linkBoleto || null,
      // Se o Bling devolver dados do vínculo com o pedido, expõe
      pedido: c.vinculo && c.vinculo.tipoOrigem === 'PedidoVenda'
        ? { id: c.vinculo.id, numero: c.vinculo.numero || null }
        : null,
    };
  });

  return { contaId, idContato: cid, contas };
}

// ── API pública: busca em TODAS as contas Bling ativas ──────────
// Params:
//   cpf: string — CPF/CNPJ só dígitos (opcional se idsPorConta cobrir tudo)
//   idsPorConta: { prohunters?: '123', calibre?: '456' } — ids já conhecidos
//   contasAtivas: opcional array de contaIds pra filtrar (default: todas ativas)
async function buscarEmAbertoDoCliente({ cpf, idsPorConta = {}, contasAtivas } = {}) {
  const todasContas = contasAtivas || Object.keys(config.blingContas || {}).filter(
    cid => config.blingContas[cid].ativa
  );
  const porConta = [];
  let totalEmAberto = 0;
  let totalAtrasado = 0;
  let totalContasEmAberto = 0;
  let totalContasAtrasadas = 0;

  for (const cid of todasContas) {
    try {
      const r = await _buscarNaConta({ idContato: idsPorConta[cid] || null, cpf, contaId: cid });
      porConta.push({ contaId: cid, ...r });
      for (const c of r.contas || []) {
        totalEmAberto += c.saldo;
        totalContasEmAberto++;
        if (c.em_atraso) {
          totalAtrasado += c.saldo;
          totalContasAtrasadas++;
        }
      }
    } catch (e) {
      porConta.push({ contaId: cid, erro: e.message, contas: [] });
    }
  }

  // Lista unificada ordenada por vencimento (mais atrasado primeiro)
  const contasFlat = porConta.flatMap(p => p.contas || [])
    .sort((a, b) => {
      // Atrasadas primeiro, mais atrasada no topo
      const da = a.dias_atraso == null ? -99999 : a.dias_atraso;
      const db = b.dias_atraso == null ? -99999 : b.dias_atraso;
      return db - da;
    });

  return {
    total_em_aberto: totalEmAberto,
    total_atrasado: totalAtrasado,
    qtd_contas_em_aberto: totalContasEmAberto,
    qtd_contas_atrasadas: totalContasAtrasadas,
    contas: contasFlat,
    detalhe_por_bling: porConta,
  };
}

module.exports = {
  buscarEmAbertoDoCliente,
  _buscarNaConta,          // exposto pra testes
  _acharIdContatoPorCpf,   // exposto pra testes
};
