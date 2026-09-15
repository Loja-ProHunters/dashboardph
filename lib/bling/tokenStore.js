// lib/bling/tokenStore.js
// Persistência criptografada do token OAuth do Bling em crm/bling-token.json.
// AES-256-GCM. Chave derivada via scrypt do SESSION_SECRET (reusa o segredo
// que já existe, evita adicionar mais uma env var pro Luis configurar).

const crypto = require('crypto');
const config = require('../../config');
const { getFile, saveFile } = require('../githubStore');

const FILE_PATH = 'crm/bling-token.json';
const CACHE_MS = 5 * 60 * 1000; // 5 min

let _cache = { data: null, ts: 0 };

// Deriva chave AES-256 a partir do SESSION_SECRET. scryptSync é síncrono +
// determinístico → mesmo secret sempre gera a mesma chave, o que é o que a
// gente quer pra encrypt/decrypt.
function _deriveKey() {
  if (!config.sessionSecret) throw new Error('SESSION_SECRET não configurado.');
  const salt = Buffer.from('bling-token-v1'); // fixo, só pra separar de outros usos
  return crypto.scryptSync(config.sessionSecret, salt, 32);
}

function encrypt(plaintext) {
  const key = _deriveKey();
  const iv = crypto.randomBytes(12); // GCM padrão 12 bytes
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // formato: iv || tag || ciphertext, tudo base64
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function decrypt(payloadB64) {
  const key = _deriveKey();
  const buf = Buffer.from(payloadB64, 'base64');
  if (buf.length < 12 + 16) throw new Error('payload criptografado inválido');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return dec.toString('utf8');
}

// Formato salvo em crm/bling-token.json:
//   {
//     access_token_enc: "<base64>",   // criptografado
//     refresh_token_enc: "<base64>",  // criptografado
//     expires_at: 1234567890,         // timestamp em ms
//     scope: "contatos pedidos-vendas...",
//     saved_at: "iso",
//     account_login: "quem_conectou"  // usuário do portal que autorizou
//   }
// Nem os tokens em claro nem o SESSION_SECRET saem nunca do processo serverless.

async function saveToken({ access_token, refresh_token, expires_in, scope, account_login }) {
  const record = {
    access_token_enc: encrypt(access_token),
    refresh_token_enc: refresh_token ? encrypt(refresh_token) : null,
    expires_at: Date.now() + (Number(expires_in) || 21600) * 1000,
    scope: scope || null,
    saved_at: new Date().toISOString(),
    account_login: account_login || null,
  };
  await saveFile(FILE_PATH, JSON.stringify(record, null, 2), 'Atualiza token OAuth do Bling');
  _cache = { data: record, ts: Date.now() };
  return record;
}

async function loadTokenRaw() {
  const now = Date.now();
  if (_cache.data && (now - _cache.ts) < CACHE_MS) return _cache.data;
  try {
    const raw = await getFile(FILE_PATH);
    const parsed = JSON.parse(raw);
    _cache = { data: parsed, ts: now };
    return parsed;
  } catch (e) {
    _cache = { data: null, ts: now };
    return null;
  }
}

// Retorna tokens em CLARO — só usar em runtime pra chamar o Bling. Nunca
// serializar / enviar pra frontend.
async function loadTokens() {
  const rec = await loadTokenRaw();
  if (!rec || !rec.access_token_enc) return null;
  return {
    access_token: decrypt(rec.access_token_enc),
    refresh_token: rec.refresh_token_enc ? decrypt(rec.refresh_token_enc) : null,
    expires_at: rec.expires_at,
    scope: rec.scope,
    saved_at: rec.saved_at,
    account_login: rec.account_login,
  };
}

// Info não-sensível pra UI: só metadados, sem os tokens
async function loadTokenInfo() {
  const rec = await loadTokenRaw();
  if (!rec) return { conectado: false };
  return {
    conectado: true,
    expires_at: rec.expires_at,
    expira_em_min: Math.max(0, Math.floor((rec.expires_at - Date.now()) / 60000)),
    scope: rec.scope,
    saved_at: rec.saved_at,
    account_login: rec.account_login,
    tem_refresh: !!rec.refresh_token_enc,
  };
}

async function deleteToken() {
  // Ao invés de deletar o arquivo (que ficaria ausente), sobrescreve vazio.
  // Assim o repo sempre tem o histórico do que existiu.
  const empty = {
    revoked_at: new Date().toISOString(),
    note: 'Token revogado / desconectado.',
  };
  await saveFile(FILE_PATH, JSON.stringify(empty, null, 2), 'Desconecta Bling (revoga token)');
  _cache = { data: null, ts: Date.now() };
}

module.exports = {
  encrypt, decrypt,
  saveToken, loadTokens, loadTokenInfo, deleteToken,
};
