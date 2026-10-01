// lib/garantiasTallyWebhook.js
// Parser do payload de webhook do Tally pro formato de garantias.criar().
//
// O Tally envia POST com Content-Type: application/json e corpo:
// {
//   eventId, eventType: 'FORM_RESPONSE', createdAt, formId, responseId,
//   data: { fields: [ { key, label, type, value, options?, ... } ] }
// }
//
// Como `key` muda a cada formulário, mapeamos por `label` (match por substring,
// case-insensitive, sem acento). Patterns alinhados com o form Tally atual:
//   - Página 1: "Onde você comprou este produto?" (Site PH / Site Fenix / Outro)
//   - Página 2: "O que você deseja solicitar?" (Garantia / Troca / Devolução)
//   - Página 3: dados cliente + pedido
//   - Página 4: upload NF + dados produto
//   - Página 5: descrição + 4 flags de triagem (queda, água, terceiros, manual)

function _norm(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

function _find(fields, patterns) {
  if (!Array.isArray(fields)) return null;
  for (const f of fields) {
    const lbl = _norm(f.label);
    for (const p of patterns) {
      if (Array.isArray(p)) {
        if (p.every(x => lbl.includes(_norm(x)))) return f;
      } else {
        if (lbl.includes(_norm(p))) return f;
      }
    }
  }
  return null;
}

function _val(f) {
  if (!f) return null;
  const v = f.value;
  if (v == null) return null;
  if (f.type === 'MULTIPLE_CHOICE' || f.type === 'DROPDOWN' || f.type === 'CHECKBOXES') {
    const ids = Array.isArray(v) ? v : [v];
    const opts = Array.isArray(f.options) ? f.options : [];
    const txts = ids.map(id => {
      const o = opts.find(x => x.id === id);
      return o && o.text != null ? o.text : id;
    });
    return txts.join(', ');
  }
  if (f.type === 'FILE_UPLOAD') {
    return Array.isArray(v) ? v : [];
  }
  return v;
}

function _valStr(f) {
  const v = _val(f);
  if (v == null) return null;
  if (Array.isArray(v)) return v.length ? v.join(', ') : null;
  return String(v).trim() || null;
}

// "Site da Pro Hunters", "Site da Fenix Store Brasil" → online.
// "Outro local" não deveria chegar aqui (lógica do Tally pula pra agradecimento),
// mas se chegar tratamos como online pra não negar por engano.
function _normalizarFormaCompra(txt) {
  if (!txt) return 'online';
  const n = _norm(txt);
  if (n.includes('presencial') || n.includes('loja fisica')) return 'presencial';
  if (n.includes('site') || n.includes('pro hunters') || n.includes('fenix store')) return 'online';
  if (n.includes('mercado livre') || n.includes('shopee') || n.includes('marketplace')) return 'marketplace';
  if (n.includes('outro')) return 'online'; // fallback
  return 'online';
}

// "Garantia (produto com defeito)" → operador decide (defeito, cliente quer solução)
// "Troca (produto errado ou insatisfação)" → troca
// "Devolução (arrependimento de compra)" → restituição + eh_arrependimento=true
function _normalizarDesejo(txt) {
  if (!txt) return { preferencia_cliente: 'operador_decide', eh_arrependimento: false };
  const n = _norm(txt);
  if (n.includes('arrependimento') || n.includes('desistencia') || n.includes('desistir')) {
    return { preferencia_cliente: 'restituicao', eh_arrependimento: true };
  }
  if (n.includes('devolucao')) {
    // "Devolução (arrependimento de compra)" — texto completo do form
    return { preferencia_cliente: 'restituicao', eh_arrependimento: true };
  }
  if (n.includes('troca')) return { preferencia_cliente: 'troca', eh_arrependimento: false };
  if (n.includes('garantia')) return { preferencia_cliente: 'operador_decide', eh_arrependimento: false };
  return { preferencia_cliente: 'operador_decide', eh_arrependimento: false };
}

// Sim/Não → bool
function _simNao(txt) {
  if (!txt) return null;
  const n = _norm(txt);
  if (n.startsWith('sim') || n === 's') return true;
  if (n.startsWith('nao') || n === 'n') return false;
  return null;
}

// "Chegou com defeito" → aparente (vício visível na entrega)
// "Apareceu após o uso" → oculto (apareceu depois)
// "Funcionamento Normal" → caso especial — não há defeito, improcedente clara
function _momentoDefeito(txt) {
  if (!txt) return { tipo_vicio: 'aparente', funcionamento_normal: false };
  const n = _norm(txt);
  if (n.includes('funcionamento normal') || n.includes('funciona normal')) {
    return { tipo_vicio: 'aparente', funcionamento_normal: true };
  }
  if (n.includes('apos o uso') || n.includes('depois do uso') || n.includes('depois')) {
    return { tipo_vicio: 'oculto', funcionamento_normal: false };
  }
  return { tipo_vicio: 'aparente', funcionamento_normal: false };
}

function _dateISO(txt) {
  if (!txt) return null;
  const s = String(txt).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) return m[3] + '-' + m[2] + '-' + m[1];
  try {
    const d = new Date(s);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  } catch (e) {}
  return null;
}

function _uploads(fFiles, tipoDefault) {
  const v = _val(fFiles);
  if (!Array.isArray(v)) return [];
  return v.map(f => ({
    tipo: tipoDefault || (
      String(f.mimeType || '').startsWith('video') ? 'video' :
      String(f.mimeType || '').startsWith('image') ? 'foto' :
      String(f.mimeType || '').includes('pdf') ? 'nota_fiscal' : 'outro'
    ),
    nome: f.name || null,
    url: f.url || null,
    mimeType: f.mimeType || null,
    size: f.size || null,
  }));
}

function mapearPayloadTally(payload) {
  const data = payload && payload.data;
  const fields = (data && data.fields) || [];

  // ── Cliente (página 3) ──
  const nome = _valStr(_find(fields, ['nome completo', 'nome'])) || 'Cliente Tally sem nome';
  const cpf = _valStr(_find(fields, ['cpf', 'cnpj'])) || '';
  const whatsapp = _valStr(_find(fields, ['whatsapp', 'celular', 'telefone']));
  const email = _valStr(_find(fields, ['e-mail', 'email']));
  const cidade = _valStr(_find(fields, ['cidade']));
  const uf = _valStr(_find(fields, ['estado', 'uf']));
  const cep = _valStr(_find(fields, ['cep']));
  const endereco = _valStr(_find(fields, ['endereco', 'endereço', 'rua, numero', 'rua numero']));

  // ── Pedido (página 3) ──
  const nf = _valStr(_find(fields, ['numero da nota', 'número da nota', 'nota fiscal']));
  const data_compra = _dateISO(_valStr(_find(fields, ['data da compra'])));
  const data_recebimento = _dateISO(_valStr(_find(fields, ['data de recebimento', 'data do recebimento'])));

  // ── Produto (página 4) ──
  // Pattern específico: só 'nome do produto'. Evita confusão com perguntas
  // que contém a palavra "produto" solta (ex: "Onde você comprou este produto").
  const nome_produto = _valStr(_find(fields, ['nome do produto']));
  const marca = _valStr(_find(fields, ['marca']));
  const modelo = _valStr(_find(fields, ['modelo']));
  const numero_serie = _valStr(_find(fields, ['numero de serie', 'número de série', 'nº de serie']));

  // ── Problema (página 5) ──
  const descricao_problema = _valStr(_find(fields, ['descricao detalhada do problema', 'descrição detalhada do problema', 'descrição do problema'])) || 'Sem descrição';
  const data_percebido = _dateISO(_valStr(_find(fields, ['data em que o problema', 'quando o problema'])));
  const momentoRaw = _valStr(_find(fields, ['chegou com defeito ou apareceu', 'defeito ou apareceu']));
  const { tipo_vicio, funcionamento_normal } = _momentoDefeito(momentoRaw);
  const motivo_troca = _valStr(_find(fields, ['motivo da troca', 'motivo da devolucao']));

  // ── Página 1: Onde comprou ──
  const formaCompraRaw = _valStr(_find(fields, ['onde voce comprou', 'onde você comprou', 'onde comprou']));
  const forma_compra = _normalizarFormaCompra(formaCompraRaw);

  // ── Página 2: O que deseja ──
  const desejoRaw = _valStr(_find(fields, ['o que voce deseja solicitar', 'o que você deseja', 'o que deseja solicitar']));
  const { preferencia_cliente, eh_arrependimento } = _normalizarDesejo(desejoRaw);

  // ── 4 flags de triagem de mau uso (página 5) ──
  const quedaRaw = _valStr(_find(fields, ['sofreu queda', 'queda ou impacto', ['queda', 'impacto']]));
  const aguaRaw = _valStr(_find(fields, ['contato com agua', 'agua ou umidade', 'água ou umidade']));
  const terceirosRaw = _valStr(_find(fields, ['aberto ou reparado', 'reparado por terceiros', 'por terceiros']));
  const manualRaw = _valStr(_find(fields, ['conforme o manual', 'conforme manual']));

  const queda = _simNao(quedaRaw);
  const agua = _simNao(aguaRaw);
  const terceiros = _simNao(terceirosRaw);
  const conformeManual = _simNao(manualRaw);

  // Consolidado pro motor de triagem:
  // - teve_queda_impacto_agua: 'sim' se queda OR água foi reportado
  // - teve_modificacao: 'sim' se terceiros abriram OU se não foi usado conforme manual
  const teve_queda_impacto_agua =
    (queda === true || agua === true) ? 'sim' :
    (queda === null && agua === null) ? 'nao_sei' : 'nao';
  const teve_modificacao =
    (terceiros === true || conformeManual === false) ? 'sim' : 'nao';

  // ── Uploads ──
  const nfUploadField = _find(fields, [['upload', 'nota'], 'nota fiscal']);
  const midiaField = _find(fields, [['upload', 'video'], ['upload', 'imagens'], ['upload', 'foto'], 'video ou foto']);
  const uploads = []
    .concat(_uploads(nfUploadField, 'nota_fiscal'))
    .concat(_uploads(midiaField, null));

  const tem_evidencia = uploads.some(u => u.tipo === 'foto' || u.tipo === 'video');

  // Monta no formato de garantias.criar()
  const resultado = {
    fonte: 'tally_webhook',
    cliente: {
      nome, cpf_cnpj: cpf, whatsapp, email, cidade, uf, cep, endereco,
    },
    pedido: {
      nf, data_compra, data_recebimento,
      nome_produto, marca, modelo, numero_serie,
    },
    problema: {
      descricao_cliente: descricao_problema,
      data_percebido_problema: data_percebido,
      chegou_defeito_ou_depois: momentoRaw,
      motivo_troca_devolucao: motivo_troca,
      uploads,
    },
    preferencia_cliente,
    triagemInput: {
      tipo_produto: 'durável', // default — operador reavalia pra munição
      data_recebimento,
      data_percebido_problema: data_percebido,
      tipo_vicio,
      forma_compra,
      eh_arrependimento,
      teve_queda_impacto_agua,
      teve_modificacao,
      tem_evidencia,
      // Flags brutas pra operador consultar na reavaliação
      _flags_brutas: {
        queda_impacto: queda,
        agua_umidade: agua,
        aberto_por_terceiros: terceiros,
        usado_conforme_manual: conformeManual,
        funcionamento_normal: funcionamento_normal,
      },
    },
    criado_por: 'tally-webhook',
    tally_meta: {
      eventId: payload.eventId || null,
      responseId: (payload.data && payload.data.responseId) || payload.responseId || null,
      formId: (payload.data && payload.data.formId) || payload.formId || null,
      createdAt: payload.createdAt || null,
      raw_onde_comprou: formaCompraRaw,
      raw_desejo: desejoRaw,
      raw_momento: momentoRaw,
    },
  };

  // Caso especial: cliente marcou "Funcionamento Normal" na página 5.
  // Não há defeito, então overridamos a sugestão de triagem via campo extra
  // que o lib/garantias.js vai consultar.
  if (funcionamento_normal) {
    resultado.triagemInput._override = {
      sugestao: 'analise_manual',
      justificativa: 'Cliente marcou "Funcionamento Normal" na pergunta de defeito. Sem vício aparente ou oculto reportado — operador deve esclarecer com o cliente qual é a reclamação específica antes de decidir.',
      score_confianca: 'baixa',
    };
  }

  return resultado;
}

module.exports = { mapearPayloadTally };
