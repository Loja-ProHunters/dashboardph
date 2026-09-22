// lib/bling/tokenStore.js
// MULTI-BLING v2 — persistência criptografada de tokens OAuth por CONTA.
// Formato novo: crm/bling-tokens.json = { [contaId]: {access_token_enc, ...} }
// Migração automática: se existir crm/bling-token.json (formato antigo),
// importa como conta "prohunters" na primeira leitura e mantém compat.

const crypto = require('crypto');
const config = require('../../config');
const { getFile, saveFile } = require('../githubStore');

const FILE_PATH_MULTI  = 'crm/bling-tokens.json';       // novo (multi-conta)
const FILE_PATH_LEGACY = 'crm/bling-token.json';        // antigo (mono)
const CACHE_MS = 5 * 60 * 1000;

let _cache = { data: null, ts: 0 };

function _deriveKey() {
  if (!config.sessionSecret) throw new Error('SESSION_SECRET não configurado.');
  const salt = Buffer.from('bling-token-v1');
  return crypto.scryptSync(config.sessionSecret, salt, 32);
}

function encrypt(plaintext) {
  const key = _deriveKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
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

// ── Normaliza contaId com fallback pra conta padrão ───────────────
function _normContaId(contaId) {
  if (!contaId) return config.blingContaPadrao || 'prohunters';
  return String(contaId).toLowerCase().trim();
}

// ── Carrega arquivo multi-conta, migrando o legado se preciso ─────
async function _loadAll() {
  const now = Date.now();
  if (_cache.data && (now - _cache.ts) < CACHE_MS) return _cache.data;

  // 1) Tenta carregar formato novo
  let data = {};
  try {
    const raw = await getFile(FILE_PATH_MULTI);
    data = JSON.parse(raw) || {};
  } catch (e) {
    data = {};
  }

  // 2) Migração one-shot: se novo tá vazio E legado existe → importa como 'prohunters'
  if (Object.keys(data).length === 0) {
    try {
      const raw = await getFile(FILE_PATH_LEGACY);
      const legado = JSON.parse(raw);
      if (legado && legado.access_token_enc) {
        data.prohunters = legado;
        // Salva no novo formato (não deleta o legado, deixa como backup)
        await saveFile(FILE_PATH_MULTI, JSON.stringify(data, null, 2),
          'Migração: token Bling legado → multi-conta (prohunters)');
      }
    } catch (e) { /* legado não existe, ignora */ }
  }

  _cache = { data, ts: now };
  return data;
}

async function _saveAll(data) {
  await saveFile(FILE_PATH_MULTI, JSON.stringify(data, null, 2),
    'Atualiza tokens Bling multi-conta');
  _cache = { data, ts: Date.now() };
}

// ── API pública ──────────────────────────────────────────────────

async function saveToken(contaId, { access_token, refresh_token, expires_in, scope, account_login }) {
  const cid = _normContaId(contaId);
  const all = await _loadAll();
  all[cid] = {
    contaId: cid,
    access_token_enc: encrypt(access_token),
    refresh_token_enc: refresh_token ? encrypt(refresh_token) : null,
    expires_at: Date.now() + (Number(expires_in) || 21600) * 1000,
    scope: scope || null,
    saved_at: new Date().toISOString(),
    account_login: account_login || null,
  };
  await _saveAll(all);
  return all[cid];
}

async function loadTokens(contaId) {
  const cid = _normContaId(contaId);
  const all = await _loadAll();
  const rec = all[cid];
  if (!rec || !rec.access_token_enc) return null;
  return {
    contaId: cid,
    access_token: decrypt(rec.access_token_enc),
    refresh_token: rec.refresh_token_enc ? decrypt(rec.refresh_token_enc) : null,
    expires_at: rec.expires_at,
    scope: rec.scope,
    saved_at: rec.saved_at,
    account_login: rec.account_login,
  };
}

async function loadTokenInfo(contaId) {
  const cid = _normContaId(contaId);
  const contaCfg = (config.blingContas || {})[cid] || { nome: cid };
  const all = await _loadAll();
  const rec = all[cid];
  const base = { contaId: cid, nome: contaCfg.nome, ativa: !!contaCfg.ativa };
  if (!rec || !rec.access_token_enc) return { ...base, conectado: false };
  return {
    ...base,
    conectado: true,
    expires_at: rec.expires_at,
    expira_em_min: Math.max(0, Math.floor((rec.expires_at - Date.now()) / 60000)),
    scope: rec.scope,
    saved_at: rec.saved_at,
    account_login: rec.account_login,
    tem_refresh: !!rec.refresh_token_enc,
  };
}

// Lista TODAS as contas configuradas com status resumido pra UI
async function listContasInfo() {
  const contas = config.blingContas || {};
  const out = [];
  for (const cid of Object.keys(contas)) {
    out.push(await loadTokenInfo(cid));
  }
  return out;
}

async function deleteToken(contaId) {
  const cid = _normContaId(contaId);
  const all = await _loadAll();
  if (all[cid]) {
    delete all[cid];
    await _saveAll(all);
  }
}

module.exports = {
  encrypt, decrypt,
  saveToken, loadTokens, loadTokenInfo, listContasInfo, deleteToken,
};
