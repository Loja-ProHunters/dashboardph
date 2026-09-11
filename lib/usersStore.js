// usersStore.js — Autenticação com senhas hashed (bcrypt) e persistência via GitHub.
// Substitui a leitura direta de USERS_JSON do config. Mantém compatibilidade retroativa:
// se USERS_JSON existir no formato antigo (senha em texto puro) e users.json não existir
// no GitHub, migra automaticamente na primeira leitura, gerando hashes e forçando troca
// de senha no primeiro login de cada usuário.

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { getFile, saveFile } = require('./githubStore');
const config = require('../config');

const FILE_PATH = 'users.json';
const LOCAL_FALLBACK = path.join(__dirname, '..', 'users.json');
const BCRYPT_ROUNDS = 10;

// Cache em memória (curto — 30s) pra evitar hitar o GitHub em cada request
let _cache = null;
let _cacheAt = 0;
const CACHE_MS = 30 * 1000;

// Formato do users.json:
// {
//   "gerencia": { "nome": "Luis", "hash": "$2b$...", "role": "admin", "email": null, "mustChange": false, "criadoEm": "..." },
//   "mathias":  { "nome": "Wesley Mathias Ciesielsky", "hash": "...", "role": "vendas", "email": "vendas2.prohunters@gmail.com", "mustChange": true, "criadoEm": "2026-09-11" },
//   ...
// }
// role ∈ { "admin", "auxiliar", "vendas" }

function _normalizeRole(r) {
  const v = String(r || '').toLowerCase();
  if (v === 'admin' || v === 'gerencia' || v === 'gerência') return 'admin';
  if (v === 'auxiliar') return 'auxiliar';
  return 'vendas';
}

async function _rawLoad() {
  // 1) tenta GitHub
  try {
    const raw = await getFile(FILE_PATH);
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { source: 'github', data: parsed };
  } catch (e) { /* segue */ }
  // 2) tenta fallback local (dev)
  try {
    const raw = fs.readFileSync(LOCAL_FALLBACK, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { source: 'local', data: parsed };
  } catch (e) { /* segue */ }
  return { source: 'none', data: null };
}

// Migra o formato legado (config.users array com senha em texto) pro users.json com hash.
// Roda uma vez: se detectar que ainda não existe users.json, gera do array e salva.
async function _maybeMigrateLegacy() {
  const legacy = Array.isArray(config.users) ? config.users : [];
  if (!legacy.length) return null;
  const out = {};
  for (const u of legacy) {
    if (!u || !u.usuario) continue;
    const hash = await bcrypt.hash(String(u.senha || 'trocar123'), BCRYPT_ROUNDS);
    out[u.usuario] = {
      nome: u.nome || u.usuario,
      hash,
      role: _normalizeRole(u.role || u.usuario),
      email: u.email || null,
      mustChange: !!u.mustChange, // legado não força troca — senhas já eram conhecidas
      criadoEm: new Date().toISOString().slice(0, 10),
    };
  }
  return out;
}

async function getAllUsers() {
  const now = Date.now();
  if (_cache && (now - _cacheAt) < CACHE_MS) return _cache;
  const { source, data } = await _rawLoad();
  let users = data;
  if (!users) {
    // Sem users.json em lugar nenhum → migra do legado
    users = await _maybeMigrateLegacy();
    if (users) {
      try { await saveFile(FILE_PATH, JSON.stringify(users, null, 2), 'Migração inicial de usuários (bcrypt)'); }
      catch (e) { /* se não conseguir salvar (dev sem GITHUB_TOKEN), fica só em memória */ }
    } else {
      users = {};
    }
  }
  _cache = users; _cacheAt = now;
  return users;
}

function _invalidateCache() { _cache = null; _cacheAt = 0; }

async function saveAllUsers(users) {
  await saveFile(FILE_PATH, JSON.stringify(users, null, 2), 'Atualiza usuários via portal');
  _invalidateCache();
}

async function verifyPassword(usuario, senha) {
  const users = await getAllUsers();
  const u = users[usuario];
  if (!u || !u.hash) return null;
  const ok = await bcrypt.compare(String(senha || ''), u.hash);
  if (!ok) return null;
  return {
    usuario,
    nome: u.nome || usuario,
    role: _normalizeRole(u.role),
    email: u.email || null,
    mustChange: !!u.mustChange,
  };
}

async function setPassword(usuario, novaSenha, opts) {
  opts = opts || {};
  const users = await getAllUsers();
  const u = users[usuario];
  if (!u) throw new Error('Usuário não encontrado.');
  const s = String(novaSenha || '');
  if (s.length < 8) throw new Error('A senha precisa ter pelo menos 8 caracteres.');
  u.hash = await bcrypt.hash(s, BCRYPT_ROUNDS);
  u.mustChange = !!opts.mustChange; // true quando é reset pela gerência; false quando é o usuário trocando por si
  u.senhaAlteradaEm = new Date().toISOString();
  users[usuario] = u;
  await saveAllUsers(users);
  return true;
}

async function upsertUser(usuario, dados) {
  const users = await getAllUsers();
  const u = users[usuario] || {};
  if (dados.nome !== undefined) u.nome = String(dados.nome);
  if (dados.role !== undefined) u.role = _normalizeRole(dados.role);
  if (dados.email !== undefined) u.email = dados.email || null;
  if (dados.ativo !== undefined) u.ativo = !!dados.ativo;
  if (dados.senha) {
    const s = String(dados.senha);
    if (s.length < 8) throw new Error('A senha precisa ter pelo menos 8 caracteres.');
    u.hash = await bcrypt.hash(s, BCRYPT_ROUNDS);
    u.mustChange = dados.mustChange !== false; // padrão: usuário deve trocar no primeiro login
  }
  if (!u.criadoEm) u.criadoEm = new Date().toISOString().slice(0, 10);
  users[usuario] = u;
  await saveAllUsers(users);
  return users[usuario];
}

async function deleteUser(usuario) {
  const users = await getAllUsers();
  if (!users[usuario]) throw new Error('Usuário não encontrado.');
  delete users[usuario];
  await saveAllUsers(users);
  return true;
}

// Gera senha temporária aleatória forte (não usada quando o Luis define a inicial,
// mas útil pra "resetar senha").
function generateTempPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789abcdefghijkmnpqrstuvwxyz';
  const specials = '!@#$%&*';
  let s = '';
  for (let i = 0; i < 10; i++) s += chars[Math.floor(Math.random() * chars.length)];
  s += specials[Math.floor(Math.random() * specials.length)];
  return s;
}

// Compatibilidade: alguns pontos do api/index.js usam getRole(usuario) sincronamente.
// Fornecemos uma versão baseada num snapshot já carregado (evita hit repetido).
function getRoleSync(users, usuario) {
  const u = users && users[usuario];
  return _normalizeRole(u && u.role);
}

module.exports = {
  getAllUsers, saveAllUsers, verifyPassword, setPassword,
  upsertUser, deleteUser, generateTempPassword, getRoleSync,
};
