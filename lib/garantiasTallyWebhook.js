// lib/garantiasTallyWebhook.js
// Parser do payload de webhook do Tally pro formato de garantias.criar().
//
// O Tally envia POST com Content-Type: application/json e corpo:
// {
//   eventId, eventType: 'FORM_RESPONSE', createdAt, formId, responseId,
//   data: {
//     fields: [
//       { key, label, type, value, options?, ... }
//     ]
//   }
// }
//
// Como `key` muda a cada formulário, mapeamos por `label` (match por substring,
// case-insensitive). Isso deixa o form Tally resiliente a renomes dos campos —
// desde que a palavra-chave principal continue no label.

function _norm(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

// Acha o PRIMEIRO campo cujo label contém qualquer um dos patterns.
// patterns = array de strings (sem acento) OU array de arrays (todos têm que casar).
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

// Resolve o valor do campo pra string legível.
// Lida com MULTIPLE_CHOICE (array de IDs → textos), FILE_UPLOAD (array de arquivos),
// DATE (string ISO), e tipos simples.
function _val(f) {
  if (!f) return null;
  const v = f.value;
  if (v == null) return null;
  // MULTIPLE_CHOICE, DROPDOWN, CHECKBOXES: value é array de IDs
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
    // Array de { id, name, url, mimeType, size }
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

function _valBool(f, truthyTokens = ['sim', 'true', 'yes']) {
  const v = _valStr(f);
  if (!v) return false;
  const n = _norm(v);
  return truthyTokens.some(t => n.includes(_norm(t)));
}

// "Presencial", "Site Pro Hunters" → mapeia pros valores do CDC
function _normalizarFormaCompra(txt) {
  if (!txt) return 'presencial'; // default seguro
  const n = _norm(txt);
  if (n.includes('presencial') || n.includes('loja')) return 'presencial';
  if (n.includes('site') || n.includes('online')) return 'online';
  if (n.includes('mercado') || n.includes('shopee') || n.includes('marketplace')) return 'marketplace';
  return 'presencial';
}

// "Troca", "Devolução", "Arrependimento", "Deixar Pro Hunters decidir"
// retorna { preferencia_cliente, eh_arrependimento }
function _normalizarDesejo(txt) {
  if (!txt) return { preferencia_cliente: 'operador_decide', eh_arrependimento: false };
  const n = _norm(txt);
  if (n.includes('arrependimento') || n.includes('desistencia') || n.includes('desistir')) {
    return { preferencia_cliente: 'restituicao', eh_arrependimento: true };
  }
  if (n.includes('troca')) return { preferencia_cliente: 'troca', eh_arrependimento: false };
  if (n.includes('devolucao') || n.includes('restituicao') || n.includes('dinheiro')) {
    return { preferencia_cliente: 'restituicao', eh_arrependimento: false };
  }
  return { preferencia_cliente: 'operador_decide', eh_arrependimento: false };
}

// Sim/Não/Não sei → 'sim' | 'nao' | 'nao_sei'
function _normalizarSimNaoSei(txt) {
  if (!txt) return 'nao_sei';
  const n = _norm(txt);
  if (n.includes('sim')) return 'sim';
  if (n.startsWith('nao sei') || n.includes('nao sei')) return 'nao_sei';
  if (n.startsWith('nao') || n === 'n') return 'nao';
  return 'nao_sei';
}

// Chegou com defeito OU após uso → 'aparente' | 'oculto'
function _tipoVicio(txt) {
  if (!txt) return 'aparente';
  const n = _norm(txt);
  if (n.includes('apos o uso') || n.includes('depois') || n.includes('oculto')) return 'oculto';
  return 'aparente';
}

// Converte string "02/10/2026" ou "2026-10-02" pra ISO date YYYY-MM-DD
function _dateISO(txt) {
  if (!txt) return null;
  const s = String(txt).trim();
  // Já ISO
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  // BR dd/mm/yyyy
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) return m[3] + '-' + m[2] + '-' + m[1];
  // Tenta parse livre
  try {
    const d = new Date(s);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  } catch (e) {}
  return null;
}

// Converte array de uploads do Tally pra formato interno.
function _uploads(fFiles, tipo) {
  const v = _val(fFiles);
  if (!Array.isArray(v)) return [];
  return v.map(f => ({
    tipo: tipo || (String(f.mimeType || '').startsWith('video') ? 'video' :
                   String(f.mimeType || '').startsWith('image') ? 'foto' :
                   String(f.mimeType || '').includes('pdf') ? 'nota_fiscal' : 'outro'),
    nome: f.name || null,
    url: f.url || null,
    mimeType: f.mimeType || null,
    size: f.size || null,
  }));
}

// Mapeia o payload inteiro do Tally pra formato de garantias.criar().
function mapearPayloadTally(payload) {
  const data = payload && payload.data;
  const fields = (data && data.fields) || [];

  // Cliente
  const nome = _valStr(_find(fields, ['nome completo', 'nome'])) || 'Cliente Tally sem nome';
  const cpf = _valStr(_find(fields, ['cpf', 'cnpj'])) || '';
  const whatsapp = _valStr(_find(fields, ['whatsapp', 'celular', 'telefone']));
  const email = _valStr(_find(fields, ['e-mail', 'email']));
  const cidade = _valStr(_find(fields, ['cidade']));
  const uf = _valStr(_find(fields, ['estado', 'uf']));
  const cep = _valStr(_find(fields, ['cep']));
  const endereco = _valStr(_find(fields, ['endereco', 'endereço', 'rua, numero', 'rua numero']));

  // Pedido
  const nf = _valStr(_find(fields, ['numero da nota', 'número da nota', 'nota fiscal']));
  const data_compra = _dateISO(_valStr(_find(fields, ['data da compra'])));
  const data_recebimento = _dateISO(_valStr(_find(fields, ['data de recebimento', 'data do recebimento'])));
  const nome_produto = _valStr(_find(fields, ['nome do produto', 'produto']));
  const marca = _valStr(_find(fields, ['marca']));
  const modelo = _valStr(_find(fields, ['modelo']));
  const numero_serie = _valStr(_find(fields, ['numero de serie', 'número de série', 'nº de serie']));

  // Problema
  const descricao_problema = _valStr(_find(fields, ['descricao detalhada do problema', 'descrição do problema', 'descricao do problema'])) || 'Sem descrição';
  const data_percebido = _dateISO(_valStr(_find(fields, ['data em que o problema', 'quando o problema'])));
  const chegou_defeito = _valStr(_find(fields, ['chegou com defeito', 'defeito ou apareceu']));
  const motivo_troca = _valStr(_find(fields, ['motivo da troca', 'motivo da devolucao']));

  // Novos campos de triagem
  const formaCompraRaw = _valStr(_find(fields, ['como foi feita a compra', 'como foi a compra', 'onde comprou']));
  const forma_compra = _normalizarFormaCompra(formaCompraRaw);

  const desejoRaw = _valStr(_find(fields, ['o que voce deseja', 'o que você deseja', 'preferencia de resolucao', 'preferência de resolução']));
  const { preferencia_cliente, eh_arrependimento } = _normalizarDesejo(desejoRaw);

  const quedaRaw = _valStr(_find(fields, ['queda', 'impacto', 'agua', 'água']));
  const teve_queda_impacto_agua = _normalizarSimNaoSei(quedaRaw);

  const modRaw = _valStr(_find(fields, ['modificacao', 'modificação', 'customizacao', 'customização']));
  const teve_modificacao = _normalizarSimNaoSei(modRaw) === 'sim' ? 'sim' : 'nao';

  const tipo_vicio = _tipoVicio(chegou_defeito);

  // Uploads
  const nfUploadField = _find(fields, [['upload', 'nota'], 'nota fiscal pdf']);
  const midiaField = _find(fields, [['upload', 'video'], ['upload', 'imagens'], 'foto', 'video']);
  const uploads = []
    .concat(_uploads(nfUploadField, 'nota_fiscal'))
    .concat(_uploads(midiaField, null));

  const tem_evidencia = uploads.some(u => u.tipo === 'foto' || u.tipo === 'video');

  // Monta no formato de garantias.criar()
  return {
    fonte: 'tally_webhook',
    cliente: {
      nome,
      cpf_cnpj: cpf,
      whatsapp,
      email,
      cidade,
      uf,
      cep,
      endereco,
    },
    pedido: {
      nf,
      data_compra,
      data_recebimento,
      nome_produto,
      marca,
      modelo,
      numero_serie,
    },
    problema: {
      descricao_cliente: descricao_problema,
      data_percebido_problema: data_percebido,
      chegou_defeito_ou_depois: chegou_defeito,
      motivo_troca_devolucao: motivo_troca,
      uploads,
    },
    preferencia_cliente,
    triagemInput: {
      // tipo_produto: default 'durável' — operador reavalia se necessário.
      // Munição e descartáveis (não-durável) são minoria no fluxo.
      tipo_produto: 'durável',
      data_recebimento,
      data_percebido_problema: data_percebido,
      tipo_vicio,
      forma_compra,
      eh_arrependimento,
      teve_queda_impacto_agua,
      teve_modificacao,
      tem_evidencia,
    },
    // Operador criador: identifica o webhook pra auditoria
    criado_por: 'tally-webhook',
    // Metadados do Tally pra debug / idempotência futura
    tally_meta: {
      eventId: payload.eventId || null,
      responseId: (payload.data && payload.data.responseId) || payload.responseId || null,
      formId: (payload.data && payload.data.formId) || payload.formId || null,
      createdAt: payload.createdAt || null,
      raw_desejo: desejoRaw,
      raw_forma_compra: formaCompraRaw,
    },
  };
}

module.exports = { mapearPayloadTally };
