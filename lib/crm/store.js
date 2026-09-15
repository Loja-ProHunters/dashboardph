// lib/crm/store.js
// Wrapper de storage por coleção sobre lib/githubStore.
// Cada coleção CRM é um arquivo JSON `crm/<name>.json` no GitHub, formato:
//   { "<uuid>": { ...doc }, ... }
//
// Cache curto em memória por invocação serverless — evita hitar o GitHub em
// cada request de listagem. Writes invalidam o cache dessa coleção.

const { getFile, saveFile } = require('../githubStore');

const CACHE_MS = 20 * 1000; // 20s por coleção
const _cache = {}; // { name: { data, ts } }

function _path(name) { return 'crm/' + name + '.json'; }

async function getCollection(name) {
  const now = Date.now();
  const c = _cache[name];
  if (c && (now - c.ts) < CACHE_MS) return c.data;
  let raw;
  try {
    raw = await getFile(_path(name));
  } catch (e) {
    // Arquivo ainda não existe — trata como coleção vazia
    raw = '{}';
  }
  let data;
  try {
    data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) data = {};
  } catch (e) {
    data = {};
  }
  _cache[name] = { data, ts: now };
  return data;
}

async function saveCollection(name, data, message) {
  const text = JSON.stringify(data, null, 2);
  await saveFile(_path(name), text, message || ('Atualiza CRM ' + name));
  _cache[name] = { data, ts: Date.now() };
}

function invalidate(name) {
  if (name) delete _cache[name];
  else Object.keys(_cache).forEach(k => delete _cache[k]);
}

// ── Operações CRUD por documento ─────────────────────────────────

async function listDocs(name, filter) {
  const col = await getCollection(name);
  const arr = Object.values(col);
  if (typeof filter === 'function') return arr.filter(filter);
  return arr;
}

async function getDoc(name, id) {
  const col = await getCollection(name);
  return col[id] || null;
}

async function createDoc(name, doc, actor) {
  if (!doc || !doc.id) throw new Error('createDoc: doc.id obrigatório');
  const col = await getCollection(name);
  if (col[doc.id]) throw new Error('createDoc: id duplicado');
  const now = new Date().toISOString();
  const withMeta = {
    ...doc,
    criado_em: doc.criado_em || now,
    criado_por: doc.criado_por || (actor || null),
    atualizado_em: now,
    atualizado_por: actor || null,
  };
  col[doc.id] = withMeta;
  await saveCollection(name, col, 'CRM: cria ' + name + '/' + doc.id);
  return withMeta;
}

async function updateDoc(name, id, patch, actor) {
  const col = await getCollection(name);
  const cur = col[id];
  if (!cur) throw new Error('updateDoc: doc não existe');
  const now = new Date().toISOString();
  const next = {
    ...cur,
    ...patch,
    id, // id imutável
    criado_em: cur.criado_em, // imutável
    criado_por: cur.criado_por, // imutável
    atualizado_em: now,
    atualizado_por: actor || null,
  };
  col[id] = next;
  await saveCollection(name, col, 'CRM: atualiza ' + name + '/' + id);
  return next;
}

async function deleteDoc(name, id) {
  const col = await getCollection(name);
  if (!col[id]) return false;
  delete col[id];
  await saveCollection(name, col, 'CRM: deleta ' + name + '/' + id);
  return true;
}

module.exports = {
  getCollection,
  saveCollection,
  invalidate,
  listDocs,
  getDoc,
  createDoc,
  updateDoc,
  deleteDoc,
};
