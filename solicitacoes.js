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
async function criar({ de, para, categoria, titulo, descricao, prazo, auto_fechar }) {
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
    // Flag pra solicitacoes criadas pelo sistema (ex: notificacao de retirada
    // em loja). Quando true, "executar" ja finaliza direto sem precisar passar
    // por aprovacao do criador — porque "o criador" eh o sistema, nao da pra
    // esperar aprovacao dele. Economiza clique e evita que a solicitacao fique
    // encalhada em "executada aguardando aprovacao" pra sempre.
    auto_fechar: !!auto_fechar,
    criado_em: now,
    executado_em: null, executado_por: null,
    aprovado_em: null, aprovado_por: null,
    rejeitado_em: null, rejeitado_por: null, rejeitado_motivo: null,
    // Chat entre criador e destinatario. Cada msg = {de, ts, texto}.
    // So os dois envolvidos podem ler/escrever (checado no enviarMensagem).
    mensagens: [],
    // Marcador de "ultima vez que fulano abriu o chat". Usado pra contar
    // mensagens nao lidas. Chave = login (de/para), valor = ISO timestamp.
    // Quando usuario abre o chat (via marcarLido), seu timestamp vira now.
    // Nao lidas = count de mensagens com ts > ultimaLeitura[login] e de !== login.
    ultimaLeitura: { [de]: now }, // criador ja "leu" ao criar (nao conta propria msg)
    historico: [{ ts: now, acao: 'criada', por: de, auto_fechar: !!auto_fechar }],
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
// Se a solicitacao tem auto_fechar=true (ex: notificacao de retirada criada
// pelo sistema), ao executar ja finaliza direto (status='aprovada'), sem
// ciclo de aprovacao — porque nao faz sentido o sistema "aprovar" sua propria
// notificacao, isso deixaria a solicitacao presa pra sempre.
async function executar(id, actor) {
  const fila = await _load();
  const s = fila[id];
  if (!s) throw new Error('Solicitação não encontrada');
  if (s.para !== String(actor).toLowerCase()) throw new Error('Só o destinatário pode marcar como executada.');
  if (s.status !== 'pendente') throw new Error('Solicitação não está pendente (status: ' + s.status + ')');
  const now = new Date().toISOString();
  s.executado_em = now;
  s.executado_por = actor;
  if (s.auto_fechar) {
    // Pula o ciclo de aprovacao — fecha direto
    s.status = 'aprovada';
    s.aprovado_em = now;
    s.aprovado_por = 'sistema (auto-fechar)';
    s.historico.push({ ts: now, acao: 'executada_e_fechada', por: actor });
  } else {
    s.status = 'executada';
    s.historico.push({ ts: now, acao: 'executada', por: actor });
  }
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

// Envia mensagem no chat da solicitacao. So o criador (de) OU o destinatario
// (para) podem escrever. Nao apaga historico, so adiciona.
async function enviarMensagem(id, actor, texto) {
  const fila = await _load();
  const s = fila[id];
  if (!s) throw new Error('Solicitação não encontrada');
  const login = String(actor).toLowerCase();
  if (s.de !== login && s.para !== login) {
    throw new Error('Só quem criou ou recebeu pode conversar aqui.');
  }
  const t = String(texto || '').trim();
  if (!t) throw new Error('Mensagem vazia');
  if (t.length > 2000) throw new Error('Máximo 2000 caracteres por mensagem');
  const now = new Date().toISOString();
  if (!Array.isArray(s.mensagens)) s.mensagens = [];
  s.mensagens.push({ de: login, ts: now, texto: t.slice(0, 2000) });
  fila[id] = s;
  await _save(fila);
  return s;
}

// Busca so as mensagens de uma solicitacao (pra polling leve — nao precisa
// baixar a solicitacao inteira em cada refresh).
async function getMensagens(id, actor) {
  const fila = await _load();
  const s = fila[id];
  if (!s) throw new Error('Solicitação não encontrada');
  const login = String(actor).toLowerCase();
  if (s.de !== login && s.para !== login) {
    throw new Error('Sem acesso a esse chat.');
  }
  return s.mensagens || [];
}

// Marca o chat de uma solicitacao como lido pelo usuario atual.
// Atualiza o timestamp em ultimaLeitura[login]. Chamado quando o chat flutuante
// abre uma conversa — zera o contador de nao lidas daquele chat.
async function marcarLido(id, login) {
  const fila = await _load();
  const s = fila[id];
  if (!s) throw new Error('Solicitação não encontrada');
  const l = String(login || '').toLowerCase();
  if (s.de !== l && s.para !== l) {
    throw new Error('So quem participa do chat pode marcar como lido.');
  }
  if (!s.ultimaLeitura) s.ultimaLeitura = {};
  s.ultimaLeitura[l] = new Date().toISOString();
  fila[id] = s;
  await _save(fila);
  return s;
}

// Conta mensagens nao lidas em uma solicitacao especifica.
// Nao lidas = msgs do OUTRO participante com ts > ultimaLeitura[login].
function _contarNaoLidas(solicitacao, login) {
  const l = String(login || '').toLowerCase();
  if (!solicitacao || !Array.isArray(solicitacao.mensagens)) return 0;
  const lastRead = (solicitacao.ultimaLeitura && solicitacao.ultimaLeitura[l]) || '1970-01-01T00:00:00.000Z';
  return solicitacao.mensagens.filter(m => m.de !== l && m.ts > lastRead).length;
}

// Lista todas as solicitacoes em que o usuario participa (criador OU
// destinatario) E que tem pelo menos 1 mensagem nao lida.
// Shape: [{id, titulo, outro_participante, outro_nome, qtd_naolidas,
//          ultima_mensagem: {de, texto, ts}}]
async function listarChatsComNaoLidas(login, usuariosNome) {
  const fila = await _load();
  const l = String(login || '').toLowerCase();
  const arr = Object.values(fila);
  const res = [];
  for (const s of arr) {
    if (s.de !== l && s.para !== l) continue;
    if (s.status === 'aprovada' || s.status === 'rejeitada') continue; // chat so em abertas/execucoes
    const qtd = _contarNaoLidas(s, l);
    if (qtd === 0) continue;
    const outro = s.de === l ? s.para : s.de;
    const msgs = s.mensagens || [];
    const ultima = msgs.length ? msgs[msgs.length - 1] : null;
    res.push({
      id: s.id,
      titulo: s.titulo,
      categoria: s.categoria,
      status: s.status,
      outro_participante: outro,
      outro_nome: (usuariosNome && usuariosNome[outro]) || outro,
      qtd_naolidas: qtd,
      ultima_mensagem: ultima,
    });
  }
  // Ordena por data da ultima mensagem (mais recente primeiro)
  res.sort((a, b) => {
    const ta = (a.ultima_mensagem && a.ultima_mensagem.ts) || '';
    const tb = (b.ultima_mensagem && b.ultima_mensagem.ts) || '';
    return tb.localeCompare(ta);
  });
  return res;
}

// Conta total de mensagens nao lidas (soma de todos os chats do usuario) —
// usado pelo badge do widget flutuante.
async function contarTotalNaoLidas(login) {
  const fila = await _load();
  const l = String(login || '').toLowerCase();
  let total = 0;
  for (const s of Object.values(fila)) {
    if (s.de !== l && s.para !== l) continue;
    total += _contarNaoLidas(s, l);
  }
  return total;
}

module.exports = {
  criar, listar, contarPendentes, executar, aprovar, rejeitar,
  enviarMensagem, getMensagens,
  marcarLido, listarChatsComNaoLidas, contarTotalNaoLidas,
  CATEGORIAS,
};
