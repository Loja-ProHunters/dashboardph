// lib/garantiasTallySync.js
// Sincroniza garantias da API do Tally (polling via cron Vercel).
//
// Como o Tally free não tem webhook, usamos a API pública:
//   GET https://api.tally.so/forms/{formId}/submissions
//   Header: Authorization: Bearer <TALLY_API_KEY>
//
// Fluxo:
//   1. Lista submissões recentes do form (paginadas, até achar uma já processada)
//   2. Pra cada nova submissão (dedupe por responseId salvo em tally_meta),
//      transforma no shape do webhook e chama parser + garantias.criar()
//   3. Retorna { processadas, puladas, erros }

const https = require('https');
const parser = require('./garantiasTallyWebhook');
const gar = require('./garantias');

const TALLY_API_BASE = 'api.tally.so';
const FORM_ID = 'rjY7Wl'; // form de garantias Pro Hunters
const PAGE_SIZE = 50;
const MAX_PAGES = 10; // segurança — não busca mais que 500 submissões por sync

function _fetchTallyApi(path, apiKey) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: TALLY_API_BASE,
      path,
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Accept': 'application/json',
      },
      timeout: 15000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error('Tally API ' + res.statusCode + ': ' + data.slice(0, 300)));
        }
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('Tally API resposta não-JSON: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Tally API timeout')); });
    req.end();
  });
}

// Lista uma página de submissões do form.
// Retorna { submissions, questions, hasMore, page }.
async function _listarPagina(apiKey, page) {
  const path = '/forms/' + encodeURIComponent(FORM_ID) + '/submissions?page=' + page + '&limit=' + PAGE_SIZE;
  const resp = await _fetchTallyApi(path, apiKey);
  // Formato esperado (Tally API v1):
  // { page, limit, hasMore, questions: [{id,label,type,options}], submissions: [{id, formId, submittedAt, responses:[{questionId,value}]}] }
  return {
    submissions: resp.submissions || resp.data || [],
    questions: resp.questions || [],
    hasMore: !!resp.hasMore,
    page: resp.page || page,
  };
}

// Converte uma submission da API Tally em um payload no FORMATO DO WEBHOOK,
// pra reaproveitar o parser já existente (parser.mapearPayloadTally).
// A API retorna responses:[{questionId, value}] e questions separado — a gente
// cruza pra montar fields:[{key,label,type,value,options}] como o webhook manda.
function _submissionParaWebhookPayload(sub, questions) {
  const qMap = {};
  for (const q of questions) {
    qMap[q.id] = q;
  }
  const responses = sub.responses || sub.answers || [];
  const fields = responses.map(r => {
    const q = qMap[r.questionId] || qMap[r.id] || {};
    return {
      key: r.questionId || r.id || q.id,
      label: q.label || q.title || '',
      type: q.type || r.type || 'INPUT_TEXT',
      value: r.value,
      options: q.options || [],
    };
  });
  return {
    eventId: 'sync_' + (sub.id || sub.responseId || Date.now()),
    eventType: 'FORM_RESPONSE',
    createdAt: sub.submittedAt || sub.createdAt || new Date().toISOString(),
    data: {
      responseId: sub.id || sub.responseId,
      formId: sub.formId || FORM_ID,
      fields,
    },
  };
}

// Coleta todos os responseIds de garantias já criadas via Tally.
// Lê diretamente do lib/garantias.js (que já tem tally_meta.responseId).
async function _responseIdsJaProcessados() {
  const todas = await gar.listar({ limite: 500 });
  const ids = new Set();
  for (const g of todas) {
    if (g.fonte === 'tally_webhook' && g.tally_meta && g.tally_meta.responseId) {
      ids.add(String(g.tally_meta.responseId));
    }
  }
  return ids;
}

// Função principal — invocada pelo cron.
// `maxPages` opcional pra limitar busca em runs normais; sync completo usa MAX_PAGES.
async function sincronizar({ apiKey, maxPages } = {}) {
  const key = apiKey || process.env.TALLY_API_KEY;
  if (!key) throw new Error('TALLY_API_KEY nao configurada');

  const jaProcessados = await _responseIdsJaProcessados();
  const resultado = {
    processadas: 0,
    puladas_duplicada: 0,
    erros: [],
    paginas_lidas: 0,
    primeira_nova: null,
    ultima_nova: null,
  };

  const limite = maxPages || MAX_PAGES;
  let page = 1;
  let continuarPaginando = true;

  while (continuarPaginando && page <= limite) {
    const { submissions, questions, hasMore } = await _listarPagina(key, page);
    resultado.paginas_lidas = page;
    if (!submissions.length) break;

    // Processa cada submissão. Se bater numa já processada, PARA (otimização:
    // as submissões vêm ordenadas da mais nova pra mais antiga, então quando
    // encontra uma velha, todas as subsequentes também são velhas).
    let encontrouProcessada = false;
    for (const sub of submissions) {
      const rid = String(sub.id || sub.responseId || '');
      if (!rid) continue;

      if (jaProcessados.has(rid)) {
        resultado.puladas_duplicada++;
        encontrouProcessada = true;
        continue;
      }

      // Só processa submissões COMPLETAS (cliente clicou Submit no último passo)
      if (sub.isCompleted === false) continue;

      try {
        const payload = _submissionParaWebhookPayload(sub, questions);
        const mapeado = parser.mapearPayloadTally(payload);
        const nova = await gar.criar(mapeado);
        resultado.processadas++;
        if (!resultado.primeira_nova) resultado.primeira_nova = nova.id;
        resultado.ultima_nova = nova.id;
        jaProcessados.add(rid);
      } catch (e) {
        resultado.erros.push({ responseId: rid, erro: e.message });
      }
    }

    // Se bateu numa processada OU API disse que não tem mais, para.
    if (encontrouProcessada || !hasMore) continuarPaginando = false;
    page++;
  }

  return resultado;
}

module.exports = { sincronizar };
