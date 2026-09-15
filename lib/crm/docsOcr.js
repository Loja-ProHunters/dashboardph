// lib/crm/docsOcr.js
// Chama Claude pra classificar o tipo do doc E extrair os campos estruturados.
// Aceita imagem (JPG/PNG) ou PDF. Retorna { tipo, dados, hash, media_type }.

const https  = require('https');
const crypto = require('crypto');
const config = require('../../config');
const { TIPOS, CLASSIFIER_PROMPT, normalizarExtraido } = require('./docsSchemas');

// SHA-256 do arquivo em base64 — vira `hash_arquivo` no documento salvo, previne
// duplicata: mesmo arquivo, mesmo hash → não cadastra de novo.
function calcularHash(base64) {
  const buf = Buffer.from(base64, 'base64');
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function buildContentBlock(base64, mediaType) {
  // Se PDF: usar type=document. Se imagem: type=image.
  if (mediaType === 'application/pdf') {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } };
  }
  // Aceita image/jpeg, image/png, image/webp, image/gif
  return { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } };
}

function callAnthropic(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const opts = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.anthropicApiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const r = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    r.on('error', reject);
    r.write(body);
    r.end();
  });
}

function parseJsonResposta(anthropicBodyRaw) {
  const parsed = JSON.parse(anthropicBodyRaw);
  const text = (parsed.content || []).map(b => b.text || '').join('');
  const clean = text.trim()
    .replace(/^```json/i, '')
    .replace(/^```/, '')
    .replace(/```$/, '')
    .trim();
  return JSON.parse(clean);
}

// Classifica o tipo do doc (cr/craf/cnh/desconhecido) numa chamada única
async function classificarTipo(base64, mediaType) {
  const payload = {
    model: config.model || 'claude-sonnet-4-6',
    max_tokens: 200,
    system: CLASSIFIER_PROMPT,
    messages: [{
      role: 'user',
      content: [
        buildContentBlock(base64, mediaType),
        { type: 'text', text: 'Classifique este documento. Responda só com o JSON.' },
      ],
    }],
  };
  const res = await callAnthropic(payload);
  if (res.status !== 200) {
    throw new Error('Erro na classificação: ' + res.body.slice(0, 300));
  }
  try {
    const out = parseJsonResposta(res.body);
    return { tipo: (out.tipo || 'desconhecido').toLowerCase(), motivo: out.motivo || '' };
  } catch (e) {
    return { tipo: 'desconhecido', motivo: 'Falha ao interpretar resposta da IA.' };
  }
}

// Extrai os campos estruturados de um tipo já conhecido
async function extrairCampos(base64, mediaType, tipo) {
  const t = TIPOS[tipo];
  if (!t) throw new Error('Tipo desconhecido: ' + tipo);
  const payload = {
    model: config.model || 'claude-sonnet-4-6',
    max_tokens: 2500,
    system: t.prompt,
    messages: [{
      role: 'user',
      content: [
        buildContentBlock(base64, mediaType),
        { type: 'text', text: 'Extraia os campos deste documento. Responda só com o JSON.' },
      ],
    }],
  };
  const res = await callAnthropic(payload);
  if (res.status !== 200) {
    throw new Error('Erro na extração: ' + res.body.slice(0, 300));
  }
  const bruto = parseJsonResposta(res.body);
  return normalizarExtraido(tipo, bruto);
}

// Fluxo completo: classifica → extrai. tipoHint opcional pula a classificação.
async function processarDocumento(base64, mediaType, tipoHint) {
  if (!config.anthropicApiKey) {
    throw new Error('ANTHROPIC_API_KEY não configurada nas variáveis de ambiente.');
  }
  const hash = calcularHash(base64);
  let tipo = tipoHint;
  let motivo_classificacao = null;
  if (!tipo || !TIPOS[tipo]) {
    const c = await classificarTipo(base64, mediaType);
    tipo = c.tipo;
    motivo_classificacao = c.motivo;
    if (tipo === 'desconhecido' || !TIPOS[tipo]) {
      return { hash, tipo: 'desconhecido', motivo_classificacao, dados: null };
    }
  }
  const dados = await extrairCampos(base64, mediaType, tipo);
  return { hash, tipo, motivo_classificacao, dados };
}

module.exports = { processarDocumento, calcularHash };
