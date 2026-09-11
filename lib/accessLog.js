// accessLog.js — Log de acessos (login, mudanças de senha, ações administrativas).
// Persistido no GitHub como access-YYYY-MM.log.json (rotação mensal). NÃO loga cada
// request de rota — só eventos "importantes" (auditoria/LGPD). Batch em memória de 30s
// pra reduzir chamadas ao GitHub em picos.

const { getFile, saveFile } = require('./githubStore');

const RETAIN_MONTHS = 3; // manter mês corrente + 2 anteriores; mais que isso, apagar
let _pending = [];
let _flushTimer = null;
const FLUSH_MS = 30 * 1000; // agrupa até 30s de eventos antes de gravar

function _fileFor(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `access-${y}-${m}.log.json`;
}

async function _appendToFile(file, entries) {
  let list = [];
  try {
    const raw = await getFile(file);
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) list = parsed;
  } catch (e) { /* arquivo pode não existir ainda — segue */ }
  list.push(...entries);
  // Trim se ficar absurdo (segurança): 10k eventos por mês é limite razoável
  if (list.length > 10000) list = list.slice(-10000);
  await saveFile(file, JSON.stringify(list), 'Log de acesso ' + file);
}

async function _flush() {
  _flushTimer = null;
  if (!_pending.length) return;
  const batch = _pending; _pending = [];
  // Agrupa por mês (raro cruzar meses num batch, mas cobre)
  const byFile = {};
  for (const ev of batch) {
    const f = _fileFor(new Date(ev.at));
    (byFile[f] = byFile[f] || []).push(ev);
  }
  for (const [file, entries] of Object.entries(byFile)) {
    try { await _appendToFile(file, entries); }
    catch (e) { console.warn('[accessLog] falha ao gravar ' + file + ':', e.message); }
  }
}

function _scheduleFlush() {
  if (_flushTimer) return;
  _flushTimer = setTimeout(() => { _flush().catch(()=>{}); }, FLUSH_MS);
  if (_flushTimer.unref) _flushTimer.unref();
}

function _ipFrom(req) {
  const h = req && req.headers || {};
  return (h['x-forwarded-for'] || h['x-real-ip'] || (req && req.socket && req.socket.remoteAddress) || '')
    .toString().split(',')[0].trim().slice(0, 64);
}

function log(evento, req, extra) {
  try {
    const entry = Object.assign({
      at: new Date().toISOString(),
      evento: String(evento || 'unknown'),
      ip: _ipFrom(req),
      ua: (req && req.headers && String(req.headers['user-agent'] || '').slice(0, 200)) || '',
    }, extra || {});
    _pending.push(entry);
    _scheduleFlush();
  } catch (e) { /* silencioso — log nunca pode quebrar request */ }
}

// Flush imediato (usado no logout ou eventos críticos)
async function flushNow() {
  if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
  await _flush();
}

// Lê os últimos N eventos do mês corrente (pra tela de admin)
async function readRecent(limit) {
  limit = Math.max(1, Math.min(500, parseInt(limit) || 100));
  const file = _fileFor(new Date());
  try {
    const raw = await getFile(file);
    const list = JSON.parse(raw);
    if (Array.isArray(list)) return list.slice(-limit).reverse();
  } catch (e) { /* sem arquivo ainda */ }
  return [];
}

module.exports = { log, flushNow, readRecent };
