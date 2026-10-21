// lib/crm/store.js
// Wrapper de storage por coleção sobre Supabase (tabela crm_docs).
// Cada coleção CRM é um conjunto de linhas na tabela crm_docs, formato:
//   colecao='accounts', id='<uuid>', data={ ...doc completo }
//
// SUBSTITUI o backend GitHub JSON, mantendo a MESMA API pública:
//   getCollection, saveCollection, mutate, SEM_GRAVAR, invalidate,
//   listDocs, getDoc, createDoc, updateDoc, deleteDoc
//
// Cache curto em memória por invocação serverless — evita hitar o
// Supabase em cada request de listagem.
//
// SEM conflitos de sha: Supabase opera por linha, não por arquivo.
// mutate e saveCollection não precisam de retry loop.

const { getClient } = require('../supabaseClient');

const CACHE_MS = 20 * 1000; // 20s por coleção
const _cache = {}; // { name: { data, ts } }

// ── Helpers ──────────────────────────────────────────────────────

function _extrairMeta(doc) {
  return {
    owner_id:       doc.vendedor_id || doc.owner_id || null,
    criado_em:      doc.criado_em      || new Date().toISOString(),
    atualizado_em:  doc.atualizado_em  || new Date().toISOString(),
    criado_por:     doc.criado_por     || null,
    atualizado_por: doc.atualizado_por || null,
  };
}

// Upsert em batches de 500 (limite seguro do Supabase)
async function _upsertBatch(sb, rows) {
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    const { error } = await sb
      .from('crm_docs')
      .upsert(batch, { onConflict: 'colecao,id' });
    if (error) throw error;
  }
}

// Delete por IDs em batches
async function _deleteBatch(sb, colecao, ids) {
  for (let i = 0; i < ids.length; i += 500) {
    const batch = ids.slice(i, i + 500);
    const { error } = await sb
      .from('crm_docs')
      .delete()
      .eq('colecao', colecao)
      .in('id', batch);
    if (error) throw error;
  }
}

// ── Leitura ──────────────────────────────────────────────────────

async function getCollection(name) {
  const now = Date.now();
  const c = _cache[name];
  if (c && (now - c.ts) < CACHE_MS) return c.data;

  const sb = getClient();
  const { data: rows, error } = await sb
    .from('crm_docs')
    .select('id, data')
    .eq('colecao', name);

  if (error) throw error;

  const map = {};
  for (const row of (rows || [])) {
    map[row.id] = row.data;
  }
  _cache[name] = { data: map, ts: now };
  return map;
}

// ── saveCollection (grava coleção inteira) ───────────────────────
// Padrão de uso: getCollection → modifica o objeto → saveCollection.
// Compara com o estado atual no Supabase e aplica as diferenças.

async function saveCollection(name, data, message) {
  const sb = getClient();

  // 1. IDs atuais no Supabase
  const { data: currentRows, error: errList } = await sb
    .from('crm_docs')
    .select('id')
    .eq('colecao', name);
  if (errList) throw errList;

  const idsAtuais = new Set((currentRows || []).map(r => r.id));
  const idsNovos  = new Set(Object.keys(data));

  // 2. Upsert todos os docs do mapa (novos + possivelmente alterados)
  const upserts = [];
  for (const [id, doc] of Object.entries(data)) {
    const meta = _extrairMeta(doc);
    upserts.push({
      colecao: name,
      id,
      data: doc,
      ...meta,
    });
  }
  if (upserts.length > 0) {
    await _upsertBatch(sb, upserts);
  }

  // 3. Docs removidos (existiam no Supabase, mas não estão no mapa)
  const removidos = [...idsAtuais].filter(id => !idsNovos.has(id));
  if (removidos.length > 0) {
    await _deleteBatch(sb, name, removidos);
  }

  // 4. Atualiza cache
  _cache[name] = { data, ts: Date.now() };
}

// ── mutate (alteração segura) ────────────────────────────────────
// fn(colecao) altera a coleção (pode lançar erro de validação).
// Diferente do GitHub, não precisa de retry loop — Supabase opera
// por linha, sem conflitos de SHA.
// fn pode devolver store.SEM_GRAVAR pra não gravar.

const SEM_GRAVAR = Symbol('sem_gravar');

async function mutate(name, fn, message) {
  const sb = getClient();

  // 1. Lê fresco do Supabase (sem cache)
  const { data: rows, error } = await sb
    .from('crm_docs')
    .select('id, data')
    .eq('colecao', name);
  if (error) throw error;

  const col = {};
  for (const row of (rows || [])) {
    col[row.id] = row.data;
  }

  // Snapshot pra comparar depois do fn
  const idsBefore = new Set(Object.keys(col));
  const snapshots = {};
  for (const [id, doc] of Object.entries(col)) {
    snapshots[id] = JSON.stringify(doc);
  }

  // 2. Aplica fn
  const r = await fn(col);

  // 3. Se SEM_GRAVAR, só cacheia e retorna
  if (r === SEM_GRAVAR) {
    _cache[name] = { data: col, ts: Date.now() };
    return undefined;
  }

  // 4. Diff: quais docs mudaram / foram criados / foram removidos
  const upserts = [];
  for (const [id, doc] of Object.entries(col)) {
    const antes = snapshots[id];
    if (!antes || antes !== JSON.stringify(doc)) {
      const meta = _extrairMeta(doc);
      upserts.push({ colecao: name, id, data: doc, ...meta });
    }
  }

  const idsAfter = new Set(Object.keys(col));
  const removidos = [...idsBefore].filter(id => !idsAfter.has(id));

  // 5. Aplica no Supabase
  if (upserts.length > 0) {
    await _upsertBatch(sb, upserts);
  }
  if (removidos.length > 0) {
    await _deleteBatch(sb, name, removidos);
  }

  // 6. Atualiza cache
  _cache[name] = { data: col, ts: Date.now() };
  return r;
}

// ── Invalidação de cache ────────────────────────────────────────

function invalidate(name) {
  if (name) delete _cache[name];
  else Object.keys(_cache).forEach(k => delete _cache[k]);
}

// ── Operações CRUD por documento ────────────────────────────────
// Mais eficientes que mutate pra operações em 1 doc (não lêem a
// coleção inteira).

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

  const sb = getClient();
  const now = new Date().toISOString();
  const withMeta = {
    ...doc,
    criado_em:      doc.criado_em || now,
    criado_por:     doc.criado_por || (actor || null),
    atualizado_em:  now,
    atualizado_por: actor || null,
  };

  const meta = _extrairMeta(withMeta);
  const { error } = await sb
    .from('crm_docs')
    .insert({
      colecao: name,
      id: doc.id,
      data: withMeta,
      ...meta,
    });

  if (error) {
    // Duplicate key = id já existe
    if (error.code === '23505') throw new Error('createDoc: id duplicado');
    throw error;
  }

  // Atualiza cache
  if (_cache[name]) {
    _cache[name].data[doc.id] = withMeta;
  }

  return withMeta;
}

async function updateDoc(name, id, patch, actor) {
  const sb = getClient();

  // Lê o doc atual direto do Supabase (fresco, sem cache)
  const { data: row, error: errRead } = await sb
    .from('crm_docs')
    .select('data')
    .eq('colecao', name)
    .eq('id', id)
    .maybeSingle();
  if (errRead) throw errRead;
  if (!row) throw new Error('updateDoc: doc não existe');

  const cur = row.data;
  const now = new Date().toISOString();
  const next = {
    ...cur,
    ...patch,
    id,                           // id imutável
    criado_em:  cur.criado_em,    // imutável
    criado_por: cur.criado_por,   // imutável
    atualizado_em:  now,
    atualizado_por: actor || null,
  };

  const meta = _extrairMeta(next);
  const { error: errUpdate } = await sb
    .from('crm_docs')
    .update({ data: next, ...meta })
    .eq('colecao', name)
    .eq('id', id);
  if (errUpdate) throw errUpdate;

  // Atualiza cache
  if (_cache[name]) {
    _cache[name].data[id] = next;
  }

  return next;
}

async function deleteDoc(name, id) {
  const sb = getClient();

  const { error, count } = await sb
    .from('crm_docs')
    .delete({ count: 'exact' })
    .eq('colecao', name)
    .eq('id', id);
  if (error) throw error;

  const apagou = (count || 0) > 0;

  // Remove do cache
  if (apagou && _cache[name]) {
    delete _cache[name].data[id];
  }

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
