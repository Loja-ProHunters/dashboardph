// lib/whatsapp/mensagens.js
// Armazena e consulta mensagens de WhatsApp recebidas via Evolution API.
// Grava no Supabase (tabela whatsapp_mensagens).
//
// Modelo:
//   - Cada mensagem Ã© 1 linha (idempotente pelo message_id da Evolution)
//   - remoteJid identifica o contato (5511999999999@s.whatsapp.net)
//   - telefone Ã© o nÃºmero limpo (5511999999999)
//   - VinculaÃ§Ã£o com CRM: account_id preenchido por lookup de telefone

const { getClient } = require('../supabaseClient');
const crmStore = require('../crm/store');

// ââ Helpers ââââââââââââââââââââââââââââââââââââââââââââââââââââââ

function _limparTelefone(jid) {
  if (!jid) return null;
  // remove @s.whatsapp.net, @g.us (grupo), etc.
  return jid.replace(/@.*$/, '').replace(/\D/g, '') || null;
}

function _extrairTexto(msg) {
  if (!msg) return null;
  // texto simples
  if (msg.conversation) return msg.conversation;
  // texto com preview de link
  if (msg.extendedTextMessage && msg.extendedTextMessage.text) return msg.extendedTextMessage.text;
  // legenda de mÃ­dia
  if (msg.imageMessage && msg.imageMessage.caption) return msg.imageMessage.caption;
  if (msg.videoMessage && msg.videoMessage.caption) return msg.videoMessage.caption;
  if (msg.documentMessage && msg.documentMessage.caption) return msg.documentMessage.caption;
  // audio / sticker / location â sem texto
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

// ââ Vincular ao CRM por telefone âââââââââââââââââââââââââââââââââ

async function _buscarAccountPorTelefone(telefone) {
  if (!telefone) return null;
  try {
    const accounts = await crmStore.getCollection('accounts');
    // Procura pelo telefone (pode estar em vÃ¡rios campos)
    for (const acc of Object.values(accounts)) {
      const tels = [acc.telefone, acc.whatsapp, acc.celular, acc.phone]
        .filter(Boolean)
        .map(t => String(t).replace(/\D/g, ''));
      if (tels.some(t => t === telefone || telefone.endsWith(t) || t.endsWith(telefone))) {
        return acc.id;
      }
    }
  } catch (e) {
    console.warn('[WA] Erro ao buscar account por telefone:', e.message);
  }
  return null;
}

// ââ Processar evento da Evolution API ââââââââââââââââââââââââââââ

async function processarMensagem(payload) {
  const { event, instance, data } = payload || {};
  if (!data || !data.key) throw new Error('Payload invÃ¡lido: sem data.key');

  const key = data.key;
  const remoteJid = key.remoteJid || '';
  const telefone = _limparTelefone(remoteJid);
  const fromMe = !!key.fromMe;
  const messageId = key.id;

  // Ignora mensagens de grupo por enquanto
  if (remoteJid.endsWith('@g.us')) {
    return { ignorado: true, motivo: 'grupo' };
  }

  const texto = _extrairTexto(data.message);
  const tipo = _detectarTipo(data.messageType, data.message);
  const timestamp = data.messageTimestamp
    ? new Date(data.messageTimestamp * 1000).toISOString()
    : new Date().toISOString();

  // Tenta vincular ao CRM
  const accountId = await _buscarAccountPorTelefone(telefone);

  const registro = {
    message_id: messageId,
    instancia: instance || null,
    remote_jid: remoteJid,
    telefone,
    push_name: data.pushName || null,
    from_me: fromMe,
    tipo,
    texto,
    timestamp,
    account_id: accountId,
    payload_raw: data.message || null,
    source: data.source || null,
  };

  const sb = getClient();
  const { data: inserted, error } = await sb
    .from('whatsapp_mensagens')
    .upsert(registro, { onConflict: 'message_id', ignoreDuplicates: true })
    .select()
    .single();

  if (error) {
    // duplicate key = mensagem jÃ¡ processada, ok
    if (error.code === '23505') return { duplicado: true, message_id: messageId };
    throw error;
  }

  return { ok: true, id: inserted?.id, message_id: messageId, account_id: accountId };
}

// ââ Consultas ââââââââââââââââââââââââââââââââââââââââââââââââââââ

// Lista conversas agrupadas por telefone (Ãºltimas N)
async function listarConversas(opts = {}) {
  const sb = getClient();
  const { instancia, limite = 50, offset = 0 } = opts;

  // Pega a Ãºltima mensagem de cada telefone
  let query = sb.rpc('whatsapp_conversas', {
    p_instancia: instancia || null,
    p_limite: limite,
    p_offset: offset,
  });

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

// Mensagens de uma conversa especÃ­fica (por telefone)
async function mensagensPorTelefone(telefone, opts = {}) {
  const sb = getClient();
  const { limite = 100, antes_de = null } = opts;

  let query = sb
    .from('whatsapp_mensagens')
    .select('*')
    .eq('telefone', telefone)
    .order('timestamp', { ascending: false })
    .limit(limite);

  if (antes_de) query = query.lt('timestamp', antes_de);

  const { data, error } = await query;
  if (error) throw error;
  return (data || []).reverse(); // ordem cronolÃ³gica
}

// ââ MÃ©tricas âââââââââââââââââââââââââââââââââââââââââââââââââââââ

async function metricas(opts = {}) {
  const sb = getClient();
  const { instancia, de, ate } = opts;

  let query = sb
    .from('whatsapp_mensagens')
    .select('from_me, tipo, telefone, timestamp', { count: 'exact' });

  if (instancia) query = query.eq('instancia', instancia);
  if (de) query = query.gte('timestamp', de);
  if (ate) query = query.lte('timestamp', ate);

  const { data, error, count } = await query;
  if (error) throw error;

  const msgs = data || [];
  const recebidas = msgs.filter(m => !m.from_me);
  const enviadas = msgs.filter(m => m.from_me);
  const contatos = new Set(msgs.map(m => m.telefone)).size;
  const textos = msgs.filter(m => m.tipo === 'texto');

  // Conversas iniciadas = contatos que tiveram a 1a mensagem do vendedor (from_me=true)
  // dentro do perÃ­odo. Agrupamos por telefone e verificamos se a 1a msg Ã© from_me.
  const porContato = {};
  for (const m of msgs) {
    if (!porContato[m.telefone]) porContato[m.telefone] = [];
    porContato[m.telefone].push(m);
  }
  let conversasIniciadas = 0;
  for (const tel of Object.keys(porContato)) {
    const ordered = porContato[tel].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    if (ordered[0] && ordered[0].from_me) conversasIniciadas++;
  }

  return {
    total: count || msgs.length,
    recebidas: recebidas.length,
    enviadas: enviadas.length,
    contatos_unicos: contatos,
    conversas_iniciadas: conversasIniciadas,
    por_tipo: {
      texto: textos.length,
      audio: msgs.filter(m => m.tipo === 'audio').length,
      imagem: msgs.filter(m => m.tipo === 'imagem').length,
      video: msgs.filter(m => m.tipo === 'video').length,
      outro: msgs.filter(m => !['texto','audio','imagem','video'].includes(m.tipo)).length,
    },
  };
}

module.exports = {
  processarMensagem,
  listarConversas,
  mensagensPorTelefone,
  metricas,
  // Helpers exportados pra testes
  _limparTelefone,
  _extrairTexto,
  _detectarTipo,
};
