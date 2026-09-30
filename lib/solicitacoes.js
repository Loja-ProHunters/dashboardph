// lib/solicitacoes.js
// Hub central de solicitações entre colaboradores. Persistência no GitHub via
// solicitacoes.json. Cada solicitação tem status:
//
//   pendente   → destinatário ainda não marcou como feita
//   executada  → destinatário marcou como feita, aguardando aprovação do criador
//   aprovada   → criador confirmou que ficou ok → finalizada
//   rejeitada  → criador rejeitou execução, volta pra pendente (histórico registra)
//
// Fluxo:
//   Luis cria pra Wesley (status=pendente) → Wesley "executa" (status=executada)
//   → Luis "aprova" (status=aprovada) OU "rejeita" (volta pendente + motivo)
//
// Categorias fixas: Financeiro, Comercial, Direção, Comex, Auxiliar Administrativo
// (definidas pelo Luis; se mudar, edita CATEGORIAS abaixo).

const { getFile, saveFile } = require('./githubStore');
const crypto = require('crypto');

const FILE_PATH = 'solicitacoes.json';
const CATEGORIAS = ['Financeiro', 'Comercial', 'Direção', 'Comex', 'Auxiliar Administrativo'];

let _cache = null;
let _cacheAt = 0;
const CACHE_MS = 10 * 1000;

function uuid() {
  const b = crypto.randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  return b.toString('hex').replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
}

async function _load() {
  const now = Date.now();
  if (_cache && (now - _cacheAt) < CACHE_MS) return _cache;
  let data = {};
  try {
    const raw = await getFile(FILE_PATH);
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') data = parsed;
  } catch (e) { /* arquivo novo */ }
  _cache = data;
  _cacheAt = now;
  return data;
}

async function _save(data) {
  await saveFile(FILE_PATH, JSON.stringify(data, null, 2), 'Atualiza solicitações');
  _cache = data;
  _cacheAt = Date.now();
}

// Cria nova solicitação. `de` e `para` são logins.
async function criar({ de, para, categoria, titulo, descricao, prazo }) {
  if (!de) throw new Error('de obrigatório');
  if (!para) throw new Error('para obrigatório');
  if (de === para) throw new Error('Você não pode solicitar pra si mesmo.');
  if (!categoria || !CATEGORIAS.includes(categoria)) {
    throw new Error('Categoria inválida. Aceitas: ' + CATEGORIAS.join(', '));
  }
  if (!titulo || !String(titulo).trim()) throw new Error('Título obrigatório');
  const fila = await _load();
  const id = uuid();
  const now = new Date().toISOString();
  fila[id] = {
    id,
    de: String(de).toLowerCase(),
    para: String(para).toLowerCase(),
    categoria,
    titulo: String(titulo).trim().slice(0, 200),
    descricao: String(descricao || '').trim().slice(0, 4000),
    prazo: prazo || null, // YYYY-MM-DD
    status: 'pendente',
    criado_em: now,
    executado_em: null, executado_por: null,
    aprovado_em: null, aprovado_por: null,
    rejeitado_em: null, rejeitado_por: null, rejeitado_motivo: null,
    historico: [{ ts: now, acao: 'criada', por: de }],
  };
  await _save(fila);
  return fila[id];
}

// Lista as solicitações do usuário. `tipo` = 'recebidas' | 'enviadas' | 'todas'.
async function listar({ login, tipo = 'recebidas' }) {
  const fila = await _load();
  const arr = Object.values(fila);
  const l = String(login || '').toLowerCase();
  let res;
  if (tipo === 'enviadas') res = arr.filter(s => s.de === l);
  else if (tipo === 'todas') res = arr;
  else res = arr.filter(s => s.para === l);
  // Ordena: pendentes primeiro, depois executadas, depois aprovadas.
  // Dentro de cada grupo: mais recentes primeiro.
  const ordem = { pendente: 0, executada: 1, rejeitada: 2, aprovada: 3 };
  res.sort((a, b) => {
    const oa = ordem[a.status] || 9, ob = ordem[b.status] || 9;
    if (oa !== ob) return oa - ob;
    return String(b.criado_em).localeCompare(String(a.criado_em));
  });
  return res;
}

// Conta quantas solicitações estão PENDENTES pra o usuário executar.
// Usado pelo sino do header + barra vermelha persistente.
async function contarPendentes(login) {
  const fila = await _load();
  const l = String(login || '').toLowerCase();
  return Object.values(fila).filter(s => s.para === l && s.status === 'pendente').length;
}

// Executor marca como feita. So o destinatario original pode executar.
async function executar(id, actor) {
  const fila = await _load();
  const s = fila[id];
  if (!s) throw new Error('Solicitação não encontrada');
  if (s.para !== String(actor).toLowerCase()) throw new Error('Só o destinatário pode marcar como executada.');
  if (s.status !== 'pendente') throw new Error('Solicitação não está pendente (status: ' + s.status + ')');
  const now = new Date().toISOString();
  s.status = 'executada';
  s.executado_em = now;
  s.executado_por = actor;
  s.historico.push({ ts: now, acao: 'executada', por: actor });
  fila[id] = s;
  await _save(fila);
  return s;
}

// Criador aprova a execução → finaliza. So o criador original pode aprovar.
async function aprovar(id, actor) {
  const fila = await _load();
  const s = fila[id];
  if (!s) throw new Error('Solicitação não encontrada');
  if (s.de !== String(actor).toLowerCase()) throw new Error('Só quem criou pode aprovar.');
  if (s.status !== 'executada') throw new Error('Solicitação não está aguardando aprovação (status: ' + s.status + ')');
  const now = new Date().toISOString();
  s.status = 'aprovada';
  s.aprovado_em = now;
  s.aprovado_por = actor;
  s.historico.push({ ts: now, acao: 'aprovada', por: actor });
  fila[id] = s;
  await _save(fila);
  return s;
}

// Criador rejeita a execução → volta pra pendente. So o criador original pode rejeitar.
async function rejeitar(id, actor, motivo) {
  const fila = await _load();
  const s = fila[id];
  if (!s) throw new Error('Solicitação não encontrada');
  if (s.de !== String(actor).toLowerCase()) throw new Error('Só quem criou pode rejeitar.');
  if (s.status !== 'executada') throw new Error('Só pode rejeitar após execução (status: ' + s.status + ')');
  const now = new Date().toISOString();
  s.status = 'pendente';
  s.executado_em = null; s.executado_por = null;
  s.rejeitado_em = now; s.rejeitado_por = actor;
  s.rejeitado_motivo = String(motivo || '').trim().slice(0, 500) || null;
  s.historico.push({ ts: now, acao: 'rejeitada', por: actor, motivo: s.rejeitado_motivo });
  fila[id] = s;
  await _save(fila);
  return s;
}

module.exports = {
  criar, listar, contarPendentes, executar, aprovar, rejeitar,
  CATEGORIAS,
};
