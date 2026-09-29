// lib/pedidosBlingComercial.js
// Fila de pedidos do Bling detectados automaticamente pra confirmacao no
// Dashboard Comercial. Cada pedido faturado no Bling vira uma "pendencia"
// que aparece pro vendedor confirmar ("Foi eu que vendi") ou rejeitar
// ("Nao e meu") — pra evitar contar venda por engano no ranking.
//
// Fluxo:
//   1. Vendedor clica "Verificar meus pedidos" no dashboard
//   2. Sistema busca pedidos faturados do Bling nos ultimos 30d
//   3. Faz match do vendedor Bling com o login (via nome contem sobrenome)
//   4. Pedidos que batem ficam pendentes pro vendedor confirmar/rejeitar
//   5. Pedidos que nao batem ficam pendentes pra gerencia atribuir
//   6. Ao confirmar → chama registrarVenda no comercialStore (soma no fat)
//   7. Ao rejeitar → volta pra fila de atribuicao da gerencia
//
// Anti-duplicata: bling_pedido_id vira a chave — mesmo pedido nunca aparece 2x.

const { getFile, saveFile } = require('./githubStore');

const FILE_PATH = 'pedidos-comercial.json';

// Vendedores ativos — precisa bater com VENDEDORES_ATIVOS de automacaoUpsell.
// Cada login "casa" quando o nome do vendedor no Bling contem essa string.
const VENDEDORES_ATIVOS = ['dickmann', 'boschetto', 'mathias'];

let _cache = null;
let _cacheAt = 0;
const CACHE_MS = 15 * 1000;

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

// Data de corte — pedidos com data_faturamento ANTERIOR sao ignorados. Isso
// impede que o sistema "descubra" pedidos antigos e comece a lancar retroativos
// no comercial. A data e setada na PRIMEIRA execucao como hoje e fica salva
// no proprio arquivo, campo especial "_meta.data_corte".
async function getDataCorte() {
  const fila = await _load();
  if (fila._meta && fila._meta.data_corte) return fila._meta.data_corte;
  const hoje = new Date().toISOString().slice(0, 10);
  fila._meta = { data_corte: hoje, criado_em: new Date().toISOString() };
  await _save(fila);
  return hoje;
}

// Reseta data de corte (admin manual). Nao usado hoje pela UI mas fica pronto.
async function setDataCorte(novaData) {
  const fila = await _load();
  fila._meta = fila._meta || {};
  fila._meta.data_corte = novaData;
  fila._meta.atualizado_em = new Date().toISOString();
  await _save(fila);
  return novaData;
}

async function _save(data) {
  await saveFile(FILE_PATH, JSON.stringify(data, null, 2), 'Atualiza fila de pedidos comercial');
  _cache = data;
  _cacheAt = Date.now();
}

function _invalidate() { _cache = null; _cacheAt = 0; }

// Tenta descobrir o login do vendedor a partir do nome do vendedor no Bling.
// Match case-insensitive por substring. Ex: "Pedro Dickmann" → "dickmann".
// Retorna null se nao bater com nenhum vendedor ativo.
function matchLoginPorNome(vendedorNome) {
  if (!vendedorNome) return null;
  const n = String(vendedorNome).toLowerCase();
  for (const login of VENDEDORES_ATIVOS) {
    if (n.includes(login)) return login;
  }
  return null;
}

// Decide o DESTINO automatico do pedido. Retorna:
//   { tipo: 'vendedor', login: 'dickmann' }  → atribuido pro vendedor confirmar
//   { tipo: 'site' }                          → soma direto no bucket SITE (sem confirmacao)
//   { tipo: 'aguardando' }                    → vai pra fila da gerencia atribuir
//
// Regras:
//   - Sem vendedor no Bling → SITE (venda online sem consultor)
//   - Vendedor Bling com nome contendo "tray" → SITE (integrador da loja online)
//   - Vendedor Bling que bate com login ativo → vendedor
//   - Vendedor Bling desconhecido → aguardando (talvez vendedor antigo/errado)
function matchDestino(vendedorNome) {
  if (!vendedorNome || !String(vendedorNome).trim()) return { tipo: 'site' };
  const n = String(vendedorNome).toLowerCase();
  if (n.includes('tray')) return { tipo: 'site' };
  const login = matchLoginPorNome(n);
  if (login) return { tipo: 'vendedor', login };
  return { tipo: 'aguardando' };
}

// Registra pedidos detectados na varredura. Cada pedido novo (nao presente
// na fila) vira uma pendencia. Pedidos ja existentes sao ignorados (a menos
// que status seja 'confirmado' ou 'rejeitado_atribuir', pra nao reprocessar).
//
// pedidosBling: array de {
//   bling_pedido_id, empresa, numero, cliente_nome, valor, data_faturamento,
//   vendedor_bling_nome, vendedor_bling_id
// }
async function registrarPedidosDetectados(pedidosBling) {
  const fila = await _load();
  const now = new Date().toISOString();
  let novos = 0, ignorados = 0, atribuidos_vendedor = 0, atribuidos_site = 0, aguardando = 0;
  for (const p of pedidosBling) {
    if (!p.bling_pedido_id) continue;
    const id = String(p.bling_pedido_id);
    if (fila[id]) { ignorados++; continue; } // ja processado antes
    const destino = matchDestino(p.vendedor_bling_nome);
    let vendedor_atribuido = null;
    let status;
    if (destino.tipo === 'vendedor') {
      vendedor_atribuido = destino.login;
      status = 'pendente';
      atribuidos_vendedor++;
    } else if (destino.tipo === 'site') {
      vendedor_atribuido = 'site';
      status = 'pendente_site'; // gerencia precisa confirmar antes de somar
      atribuidos_site++;
    } else {
      status = 'aguardando_atribuicao';
      aguardando++;
    }
    fila[id] = {
      bling_pedido_id: id,
      empresa: p.empresa || null,
      numero: p.numero || null,
      cliente_nome: p.cliente_nome || null,
      valor: Number(p.valor) || 0,
      data_faturamento: p.data_faturamento || null,
      vendedor_bling_nome: p.vendedor_bling_nome || null,
      vendedor_bling_id: p.vendedor_bling_id || null,
      vendedor_atribuido,
      status,
      detectado_em: now,
      confirmado_por: null, confirmado_em: null,
      rejeitado_por: null, rejeitado_em: null,
      atribuido_manualmente_por: null, atribuido_manualmente_em: null,
      historico: [{ ts: now, acao: 'detectado_' + destino.tipo, login_match: vendedor_atribuido }],
    };
    novos++;
  }
  if (novos > 0) await _save(fila);
  return { novos, ignorados, atribuidos_vendedor, atribuidos_site, aguardando };
}

// Lista pendencias por audiencia:
//   - vendedor (login passado, admin=false): so os dele com status 'pendente'
//   - admin (admin=true): pedidos SITE (pendente_site) + aguardando_atribuicao
//     — NAO ve os pedidos dos vendedores. Nova regra do Luis.
async function listar({ login = null, admin = false } = {}) {
  const fila = await _load();
  const arr = Object.entries(fila)
    .filter(([k]) => k !== '_meta')
    .map(([, v]) => v);
  if (admin) {
    return arr.filter(p => p && (p.status === 'pendente_site' || p.status === 'aguardando_atribuicao'));
  }
  return arr.filter(p => p && p.status === 'pendente' && p.vendedor_atribuido === login);
}

// Confirma um pedido — marca como confirmado e retorna dados pra que a rota
// chame registrarVenda no comercialStore.
async function confirmar(blingPedidoId, actor) {
  const fila = await _load();
  const p = fila[blingPedidoId];
  if (!p) throw new Error('Pedido nao encontrado na fila');
  if (p.status !== 'pendente') throw new Error('Pedido nao esta pendente (status: ' + p.status + ')');
  if (p.vendedor_atribuido !== actor) {
    throw new Error('Este pedido nao esta atribuido a voce.');
  }
  const now = new Date().toISOString();
  p.status = 'confirmado';
  p.confirmado_por = actor;
  p.confirmado_em = now;
  p.historico.push({ ts: now, acao: 'confirmado', por: actor });
  fila[blingPedidoId] = p;
  await _save(fila);
  return p;
}

// Rejeita — volta pra fila da gerencia
async function rejeitar(blingPedidoId, actor) {
  const fila = await _load();
  const p = fila[blingPedidoId];
  if (!p) throw new Error('Pedido nao encontrado na fila');
  if (p.status !== 'pendente') throw new Error('Pedido nao esta pendente (status: ' + p.status + ')');
  const now = new Date().toISOString();
  p.status = 'aguardando_atribuicao';
  p.vendedor_atribuido = null;
  p.rejeitado_por = actor;
  p.rejeitado_em = now;
  p.historico.push({ ts: now, acao: 'rejeitado', por: actor });
  fila[blingPedidoId] = p;
  await _save(fila);
  return p;
}

// Admin atribui manualmente pra um vendedor. Volta pra "pendente" na fila dele.
async function atribuir(blingPedidoId, vendedorLogin, actor) {
  if (!VENDEDORES_ATIVOS.includes(vendedorLogin)) {
    throw new Error('Vendedor invalido. Aceitos: ' + VENDEDORES_ATIVOS.join(', '));
  }
  const fila = await _load();
  const p = fila[blingPedidoId];
  if (!p) throw new Error('Pedido nao encontrado na fila');
  if (p.status === 'confirmado') throw new Error('Pedido ja foi confirmado — nao pode reatribuir');
  const now = new Date().toISOString();
  p.status = 'pendente';
  p.vendedor_atribuido = vendedorLogin;
  p.atribuido_manualmente_por = actor;
  p.atribuido_manualmente_em = now;
  p.historico.push({ ts: now, acao: 'atribuido_manualmente', para: vendedorLogin, por: actor });
  fila[blingPedidoId] = p;
  await _save(fila);
  return p;
}

// Confirma um pedido SITE (soma no bucket site). So admin/diretor.
async function confirmarSite(blingPedidoId, actor) {
  const fila = await _load();
  const p = fila[blingPedidoId];
  if (!p) throw new Error('Pedido nao encontrado na fila');
  if (p.status !== 'pendente_site') throw new Error('Pedido nao esta pendente_site (status: ' + p.status + ')');
  const now = new Date().toISOString();
  p.status = 'site_confirmado';
  p.confirmado_por = actor;
  p.confirmado_em = now;
  p.historico.push({ ts: now, acao: 'site_confirmado', por: actor });
  fila[blingPedidoId] = p;
  await _save(fila);
  return p;
}

// Rejeita um pedido SITE — vai pra fila de atribuicao (talvez nao seja site).
async function rejeitarSite(blingPedidoId, actor) {
  const fila = await _load();
  const p = fila[blingPedidoId];
  if (!p) throw new Error('Pedido nao encontrado na fila');
  if (p.status !== 'pendente_site') throw new Error('Pedido nao esta pendente_site (status: ' + p.status + ')');
  const now = new Date().toISOString();
  p.status = 'aguardando_atribuicao';
  p.vendedor_atribuido = null;
  p.rejeitado_por = actor;
  p.rejeitado_em = now;
  p.historico.push({ ts: now, acao: 'site_rejeitado', por: actor });
  fila[blingPedidoId] = p;
  await _save(fila);
  return p;
}

module.exports = {
  registrarPedidosDetectados,
  listar,
  confirmar,
  rejeitar,
  atribuir,
  confirmarSite,
  rejeitarSite,
  matchLoginPorNome,
  matchDestino,
  getDataCorte,
  setDataCorte,
  VENDEDORES_ATIVOS,
};
