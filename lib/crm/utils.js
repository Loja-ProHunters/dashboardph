// lib/crm/utils.js
// Utilitários compartilhados por todas as coleções do CRM.

const crypto = require('crypto');

// ── UUID v4 (RFC 4122) usando crypto.randomBytes ─────────────────
function uuid() {
  const b = crypto.randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40; // versão 4
  b[8] = (b[8] & 0x3f) | 0x80; // variante RFC 4122
  const hex = b.toString('hex');
  return (
    hex.substring(0, 8) + '-' +
    hex.substring(8, 12) + '-' +
    hex.substring(12, 16) + '-' +
    hex.substring(16, 20) + '-' +
    hex.substring(20, 32)
  );
}

// ── Normalização de CPF/CNPJ ─────────────────────────────────────
function normalizaCpfCnpj(v) {
  return String(v || '').replace(/\D+/g, '');
}

function validaCpf(v) {
  const s = normalizaCpfCnpj(v);
  if (s.length !== 11) return false;
  if (/^(\d)\1+$/.test(s)) return false; // 111.111.111-11 etc
  let soma = 0;
  for (let i = 0; i < 9; i++) soma += parseInt(s.charAt(i), 10) * (10 - i);
  let dig = 11 - (soma % 11);
  if (dig >= 10) dig = 0;
  if (dig !== parseInt(s.charAt(9), 10)) return false;
  soma = 0;
  for (let i = 0; i < 10; i++) soma += parseInt(s.charAt(i), 10) * (11 - i);
  dig = 11 - (soma % 11);
  if (dig >= 10) dig = 0;
  return dig === parseInt(s.charAt(10), 10);
}

function validaCnpj(v) {
  const s = normalizaCpfCnpj(v);
  if (s.length !== 14) return false;
  if (/^(\d)\1+$/.test(s)) return false;
  const calc = (base, pesos) => {
    let soma = 0;
    for (let i = 0; i < pesos.length; i++) soma += parseInt(base.charAt(i), 10) * pesos[i];
    const r = soma % 11;
    return r < 2 ? 0 : 11 - r;
  };
  const p1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const p2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const d1 = calc(s.substring(0, 12), p1);
  const d2 = calc(s.substring(0, 12) + d1, p2);
  return d1 === parseInt(s.charAt(12), 10) && d2 === parseInt(s.charAt(13), 10);
}

function validaCpfCnpj(v) {
  const s = normalizaCpfCnpj(v);
  if (s.length === 11) return validaCpf(s);
  if (s.length === 14) return validaCnpj(s);
  return false;
}

// ── Formatadores ─────────────────────────────────────────────────
function fmtCpfCnpj(v) {
  const s = normalizaCpfCnpj(v);
  if (s.length === 11) return s.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
  if (s.length === 14) return s.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  return s;
}

// ── Permissões ───────────────────────────────────────────────────
// Convenção:
//   admin    → vê tudo, edita tudo
//   vendas   → vê e edita SÓ o que é dele (owner_id === usuario)
//   auxiliar → vê tudo (readonly), NÃO edita, NÃO acessa CRM em v1
function role(sess) {
  if (!sess) return 'anon';
  if (sess.role) return sess.role;
  if (sess.usuario === 'gerencia') return 'admin';
  if (sess.usuario === 'auxiliar') return 'auxiliar';
  return 'vendas';
}

function canAccessCRM(sess) {
  // Em v1: gerência e vendas. Auxiliar fica fora do CRM até termos telas de leitura dedicadas.
  const r = role(sess);
  return r === 'admin' || r === 'vendas';
}

function canSeeAll(sess) { return role(sess) === 'admin'; }

// Testa se sess pode LER doc. Admin sim, vendas só se owner é ele.
function canReadDoc(sess, doc) {
  if (!sess) return false;
  if (canSeeAll(sess)) return true;
  return doc && doc.owner_id === sess.usuario;
}

// Testa se sess pode ESCREVER (create/update/delete) doc.
// Regra: admin tudo. Vendas: só se owner é ele (na hora do create ele pode setar
// owner = ele mesmo). Auxiliar não escreve.
function canWriteDoc(sess, doc) {
  if (!sess) return false;
  const r = role(sess);
  if (r === 'admin') return true;
  if (r === 'auxiliar') return false;
  return doc && doc.owner_id === sess.usuario;
}

// Filtro pra aplicar em listagens. Retorna uma função (doc)=>bool ou null se
// admin (que vê tudo, dispensa filtro).
function scopeFilter(sess) {
  if (canSeeAll(sess)) return null;
  const me = sess ? sess.usuario : null;
  return (doc) => doc && doc.owner_id === me;
}

// Força owner no create quando o usuário é vendas — não deixa vendedor criar
// documento em nome de outro. Admin pode setar qualquer owner.
function enforceOwner(sess, dadosIn) {
  const dados = { ...(dadosIn || {}) };
  if (canSeeAll(sess)) {
    // Admin pode escolher; se não escolheu, atribui a si mesmo.
    if (!dados.owner_id) dados.owner_id = sess.usuario;
  } else {
    dados.owner_id = sess ? sess.usuario : null;
  }
  return dados;
}

// ── Validação genérica de enum ───────────────────────────────────
function isEnum(val, allowed) { return allowed.indexOf(val) !== -1; }

module.exports = {
  uuid,
  normalizaCpfCnpj, validaCpf, validaCnpj, validaCpfCnpj, fmtCpfCnpj,
  role, canAccessCRM, canSeeAll, canReadDoc, canWriteDoc, scopeFilter, enforceOwner,
  isEnum,
};
