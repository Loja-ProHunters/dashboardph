// lib/whatsapp/sync.js
// Sincronização pull de mensagens da Evolution API → Supabase.
// Em vez de depender do webhook (push), puxa mensagens recentes
// direto da API da Evolution e grava no whatsapp_mensagens.
//
// Chamado por cron (a cada 5-10 min) via GET /api/crm/cron/whatsapp-sync.

const https = require('https');
const { getClient } = require('../supabaseClient');
const config = require('../../config');
const crmStore = require('../crm/store');

// ── Config ──────────────────────────────────────────────────────

// Instâncias a sincronizar (mesma lista de inteligencia.js)
const INSTANCIAS = {
  'CRM_prohunters_enzo': { nome: 'Pedro Dickmann', id: 'dickmann' },
};

// Quantas mensagens puxar por página
const MSGS_POR_PAGINA = 50;
// Máximo de páginas por sync (evitar timeout de 10s da Vercel)
const MAX_PAGINAS = 3;

// ── Helpers ─────────────────────────────────────────────────────

function _limparTelefone(jid) {
  if (!jid) return null;
  return jid.replace(/@.*$/, '').replace(/\D/g, '') || null;
}

function _extrairTexto(msg) {
  if (!msg) return null;
  if (msg.conversation) return msg.conversation;
  if (msg.extendedTextMessage && msg.extendedTextMessage.text) return msg.extendedTextMessage.text;
  if (msg.imageMessage && msg.imageMessage.caption) return msg.imageMessage.caption;
  if (msg.videoMessage && msg.videoMessage.caption) return msg.videoMessage.caption;
  if (msg.documentMessage && msg.documentMessage.caption) return msg.documentMessage.caption;
  return null;
}

function _detectarTipo(messageType, msg) {
  if (!messageType) {
    if (!msg) return 'desconhecido';
    if (msg.conversation || msg.extendedTextMessage) return 'texto';
    if (msg.imageMessage) return 'imagem';
    if (msg.audioMessage) return 'audio';
    if (msg.videoMessage) return 'video';
    if (msg.documentMessage) return 'documento';
    if (msg.stickerMessage) return 'sticker';
    if (msg.locationMessage) return 'localizacao';
    if (msg.contactMessage) return 'contato';
    return 'desconhecido';
  }
  const map = {
    conversation: 'texto',
    extendedTextMessage: 'texto',
    imageMessage: 'imagem',
    audioMessage: 'audio',
    videoMessage: 'video',
    documentMessage: 'documento',
    stickerMessage: 'sticker',
    locationMessage: 'localizacao',
    contactMessage: 'contato',
    reactionMessage: 'reacao',
  };
  return map[messageType] || 'outro';
}

// ── Buscar account no CRM por telefone ──────────────────────────

async function _buscarAccountPorTelefone(telefone) {
  if (!telefone) return null;
  try {
    const accounts = await crmStore.getCollection('accounts');
    for (const acc of Object.values(accounts)) {
      const tels = [acc.telefone, acc.whatsapp, acc.celular, acc.phone]
        .filter(Boolean)
        .map(t => String(t).replace(/\D/g, ''));
      if (tels.some(t => t === telefone || telefone.endsWith(t) || t.endsWith(telefone))) {
        return acc.id;
      }
    }
  } catch (e) {
    console.warn('[WA-SYNC] Erro ao buscar account:', e.message);
  }
  return null;
}

// ── Chamada HTTP pra Evolution API ──────────────────────────────

function _chamarEvolution(metodo, caminho, body) {
  return new Promise((resolve, reject) => {
    const apiUrl = config.evolutionApiUrl;
    const apiKey = config.evolutionApiKey;

    if (!apiUrl || !apiKey) {
      return reject(new Error('EVOLUTION_API_URL ou EVOLUTION_API_KEY não configurados'));
    }

    const urlObj = new URL(caminho, apiUrl);
    const bodyStr = body ? JSON.stringify(body) : null;

    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || 443,
      path: urlObj.pathname + urlObj.search,
      method: metodo,
      headers: {
        'apikey': apiKey,
        'Content-Type': 'application/json',
      },
    };
    if (bodyStr) options.headers['Content-Length'] = Buffer.byteLength(bodyStr);

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Evolution API resposta inválida: ${data.substring(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => {
      req.destroy();
      reject(new Error('Evolution API timeout'));
    });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── Buscar última mensagem sincronizada ─────────────────────────

async function _ultimoTimestamp(instancia) {
  const sb = getClient();
  const { data, error } = await sb
    .from('whatsapp_mensagens')
    .select('timestamp')
    .eq('instancia', instancia)
    .order('timestamp', { ascending: false })
    .limit(1)
    .single();

  if (error || !data) {
    // Sem mensagens ainda — pegar últimas 24h
    return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  }
  return data.timestamp;
}

// ── Sincronizar mensagens de uma instância ──────────────────────

async function sincronizarInstancia(instancia) {
  const ultimoTs = await _ultimoTimestamp(instancia);
  console.log(`[WA-SYNC] ${instancia}: último timestamp = ${ultimoTs}`);

  let totalNovas = 0;
  let totalDuplicadas = 0;
  let totalIgnoradas = 0;
  let pagina = 1;

  while (pagina <= MAX_PAGINAS) {
    // Busca mensagens da Evolution API
    const resultado = await _chamarEvolution('POST', `/chat/findMessages/${instancia}`, {
      where: {},
      limit: MSGS_POR_PAGINA,
      page: pagina,
    });

    const records = resultado.messages && resultado.messages.records;
    if (!records || records.length === 0) break;

    const sb = getClient();
    let algumaAntiga = false;

    for (const rec of records) {
      try {
        const key = rec.key || {};
        const remoteJid = key.remoteJidAlt || key.remoteJid || '';

        // Ignora grupos
        if (remoteJid.endsWith('@g.us')) {
          totalIgnoradas++;
          continue;
        }

        // Ignora mensagens sem ID
        const messageId = key.id;
        if (!messageId) {
          totalIgnoradas++;
          continue;
        }

        const telefone = _limparTelefone(remoteJid);
        const fromMe = !!key.fromMe;
        const texto = _extrairTexto(rec.message);
        const tipo = _detectarTipo(rec.messageType, rec.message);

        // Timestamp: pode vir como messageTimestamp (epoch) ou createdAt (ISO)
        let timestamp;
        if (rec.messageTimestamp) {
          const ts = typeof rec.messageTimestamp === 'number'
            ? rec.messageTimestamp
            : parseInt(rec.messageTimestamp, 10);
          timestamp = new Date(ts * 1000).toISOString();
        } else if (rec.createdAt) {
          timestamp = new Date(rec.createdAt).toISOString();
        } else {
          timestamp = new Date().toISOString();
        }

        // Se a mensagem é mais antiga que o último sync, podemos parar
        if (timestamp <= ultimoTs) {
          algumaAntiga = true;
        }

        // Vincular ao CRM
        const accountId = await _buscarAccountPorTelefone(telefone);

        const registro = {
          message_id: messageId,
          instancia: instancia,
          remote_jid: remoteJid,
          telefone,
          push_name: rec.pushName || null,
          from_me: fromMe,
          tipo,
          texto,
          timestamp,
          account_id: accountId,
          payload_raw: rec.message || null,
          source: 'sync',
        };

        const { error } = await sb
          .from('whatsapp_mensagens')
          .upsert(registro, { onConflict: 'message_id', ignoreDuplicates: true });

        if (error) {
          if (error.code === '23505') {
            totalDuplicadas++;
          } else {
            console.warn('[WA-SYNC] Erro upsert:', error.message);
          }
        } else {
          totalNovas++;
        }
      } catch (e) {
        console.warn('[WA-SYNC] Erro processando mensagem:', e.message);
        totalIgnoradas++;
      }
    }

    // Se todas as mensagens desta página já são antigas, parar
    if (algumaAntiga && totalNovas === 0) break;

    // Se não tem mais páginas
    const totalPages = resultado.messages && resultado.messages.pages;
    if (pagina >= (totalPages || 1)) break;

    pagina++;
  }

  return {
    instancia,
    novas: totalNovas,
    duplicadas: totalDuplicadas,
    ignoradas: totalIgnoradas,
    paginas_lidas: pagina,
  };
}

// ── Sincronizar todas as instâncias ─────────────────────────────

async function sincronizarTodas() {
  const resultados = {};

  for (const [instancia, info] of Object.entries(INSTANCIAS)) {
    try {
      resultados[info.nome] = await sincronizarInstancia(instancia);
    } catch (e) {
      console.error(`[WA-SYNC] Erro ${instancia}:`, e.message);
      resultados[info.nome] = { error: e.message };
    }
  }

  return resultados;
}

module.exports = {
  sincronizarTodas,
  sincronizarInstancia,
  INSTANCIAS,
};
