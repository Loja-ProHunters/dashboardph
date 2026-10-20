// lib/crm/store.js
// Wrapper de storage por coleção sobre lib/githubStore.
// Cada coleção CRM é um arquivo JSON `crm/<name>.json` no GitHub, formato:
//   { "<uuid>": { ...doc }, ... }
//
// Cache curto em memória por invocação serverless — evita hitar o GitHub em
// cada request de listagem.
//
// CONCORRENCIA (fix do erro "GitHub API 409: crm/activities.json does not
// match <sha>"): varios vendedores + crons gravam o MESMO arquivo. Agora:
//   • mutate(nome, fn) ....... le a versao mais nova, aplica a alteracao e
//     grava com o sha lido. Se alguem gravou no meio (409), rele e REAPLICA a
//     mesma alteracao — nada se perde e o usuario nao ve erro.
//   • saveCollection(...) .... grava com o sha da leitura; em conflito, mescla
//     com a versao nova documento a documento (vence o atualizado_em mais
//     recente) e tenta de novo.
//   • createDoc / updateDoc / deleteDoc usam mutate.

const gh = require('../githubStore');

const CACHE_MS = 20 * 1000; // 20s por coleção
const MAX_TENTATIVAS = 5;
const _cache = {}; // { name: { data, sha, ts } }

function _path(name) { return 'crm/' + name + '.json'; }
const _sleep = ms => new Promise(r => setTimeout(r, ms));
const _espera = t => _sleep(250 * t + Math.floor(Math.random() * 300));

function _conflito(e) {
  if (gh.ehConflito) return gh.ehConflito(e);
  return !!e && (e.statusCode === 409 || (e.statusCode === 422 && /sha/i.test(e.message || '')));
}

function _parse(raw) {
  let data;
  try {
    data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) data = {};
  } catch (e) {
    data = {};
  }
  return data;
}

// Leitura direta do GitHub (sem cache). sha undefined = versao desconhecida.
async function _lerFresco(name) {
  try {
    if (typeof gh.getFileWithSha === 'function') {
      const r = await gh.getFileWithSha(_path(name));
      return { data: _parse(r.text), sha: r.sha || null };
    }
    return { data: _parse(await gh.getFile(_path(name))), sha: undefined };
  } catch (e) {
    // Arquivo ainda não existe — coleção vazia (a 1a gravação cria)
    if (e && e.statusCode === 404) return { data: {}, sha: null };
    throw e; // erro de rede/GitHub: NUNCA tratar como vazia (gravaria por cima de tudo)
  }
}

async function _gravar(name, data, message, sha) {
  const text = JSON.stringify(data, null, 2);
  const r = await gh.saveFile(_path(name), text, message, sha !== undefined ? { sha } : undefined);
  const novoSha = typeof r === 'string' ? r : undefined;
  _cache[name] = { data, sha: novoSha, ts: Date.now() };
}

async function getCollection(name) {
  const now = Date.now();
  const c = _cache[name];
  if (c && (now - c.ts) < CACHE_MS) return c.data;
  const f = await _lerFresco(name);
  _cache[name] = { data: f.data, sha: f.sha, ts: now };
  return f.data;
}

// Mescla "nosso" (alterado a partir de uma leitura antiga) com a versao nova
// do GitHub: documentos novos dos dois lados ficam; no mesmo documento vence
// o atualizado_em mais recente (empate: o nosso).
function _mesclar(fresco, nosso) {
  const out = Object.assign({}, fresco);
  for (const [id, d] of Object.entries(nosso || {})) {
    const f = fresco[id];
    if (f === undefined) { out[id] = d; continue; }
    const tf = String((f && f.atualizado_em) || '');
    const tn = String((d && d.atualizado_em) || '');
    out[id] = tf > tn ? f : d;
  }
  return out;
}

async function saveCollection(name, data, message) {
  message = message || ('Atualiza CRM ' + name);
  const c = _cache[name];
  // sha da leitura que originou estes dados (mesmo objeto do cache)
  let sha = (c && c.data === data) ? c.sha : undefined;
  let atual = data;
  if (sha === undefined && typeof gh.getFileWithSha === 'function') {
    // Dados nao vieram do cache atual: mescla com a versao mais nova antes
    const f = await _lerFresco(name);
    atual = _mesclar(f.data, data); sha = f.sha;
  }
  for (let t = 1; ; t++) {
    try {
      await _gravar(name, atual, message, sha);
      if (atual !== data) { // mantem a referencia de quem chamou atualizada
        for (const k of Object.keys(atual)) data[k] = atual[k];
        _cache[name].data = data;
      }
      return;
    } catch (e) {
      if (!_conflito(e) || t >= MAX_TENTATIVAS) throw e;
      await _espera(t);
      const f = await _lerFresco(name);
      atual = _mesclar(f.data, data);
      sha = f.sha;
    }
  }
}

// Alteracao segura: fn(colecao) altera a colecao (pode lançar erro de
// validacao). Em conflito, rele e roda fn de novo sobre a versao nova.
// fn pode devolver store.SEM_GRAVAR (ou { [SEM_GRAVAR]: true, ... }) pra não gravar.
const SEM_GRAVAR = Symbol('sem_gravar');
async function mutate(name, fn, message) {
  for (let t = 1; ; t++) {
    const f = await _lerFresco(name);
    const r = await fn(f.data);
    if (r === SEM_GRAVAR) { _cache[name] = { data: f.data, sha: f.sha, ts: Date.now() }; return undefined; }
    const msg = typeof message === 'function' ? message(r, f.data) : (message || ('Atualiza CRM ' + name));
    try {
      await _gravar(name, f.data, msg, f.sha);
      return r;
    } catch (e) {
      if (!_conflito(e) || t >= MAX_TENTATIVAS) throw e;
      await _espera(t);
    }
  }
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
  return mutate(name, col => {
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
    return withMeta;
  }, 'CRM: cria ' + name + '/' + doc.id);
}

async function updateDoc(name, id, patch, actor) {
  return mutate(name, col => {
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
    return next;
  }, 'CRM: atualiza ' + name + '/' + id);
}

async function deleteDoc(name, id) {
  let apagou = false;
  await mutate(name, col => {
    if (!col[id]) return SEM_GRAVAR;
    delete col[id]; apagou = true;
  }, 'CRM: deleta ' + name + '/' + id);
  return apagou;
}

module.exports = {
  getCollection,
  saveCollection,
  mutate,
  SEM_GRAVAR,
  invalidate,
  listDocs,
  getDoc,
  createDoc,
  updateDoc,
  deleteDoc,
};
