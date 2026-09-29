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
  let novos = 0, ignorados = 0;
  for (const p of pedidosBling) {
    if (!p.bling_pedido_id) continue;
    const id = String(p.bling_pedido_id);
    if (fila[id]) { ignorados++; continue; } // ja processado antes
    const login = matchLoginPorNome(p.vendedor_bling_nome);
    fila[id] = {
      bling_pedido_id: id,
      empresa: p.empresa || null,
      numero: p.numero || null,
      cliente_nome: p.cliente_nome || null,
      valor: Number(p.valor) || 0,
      data_faturamento: p.data_faturamento || null,
      vendedor_bling_nome: p.vendedor_bling_nome || null,
      vendedor_bling_id: p.vendedor_bling_id || null,
      // Se bateu com um login, ja vai atribuido pra ele confirmar; senao,
      // fica na fila da gerencia atribuir manualmente.
      vendedor_atribuido: login || null,
      status: login ? 'pendente' : 'aguardando_atribuicao',
      detectado_em: now,
      confirmado_por: null, confirmado_em: null,
      rejeitado_por: null, rejeitado_em: null,
      atribuido_manualmente_por: null, atribuido_manualmente_em: null,
      historico: [{ ts: now, acao: login ? 'detectado_atribuido' : 'detectado_sem_match', login_match: login }],
    };
    novos++;
  }
  if (novos > 0) await _save(fila);
  return { novos, ignorados };
}

// Lista pendencias filtradas. Se login for passado, retorna so as dele.
// Se admin=true, retorna todas (inclusive aguardando_atribuicao).
async function listar({ login = null, admin = false } = {}) {
  const fila = await _load();
  const arr = Object.values(fila);
  if (admin) {
    // Admin ve: pendentes de todos + aguardando_atribuicao
    return arr.filter(p => p.status === 'pendente' || p.status === 'aguardando_atribuicao');
  }
  // Vendedor ve: pendentes atribuidas a ele
  return arr.filter(p => p.status === 'pendente' && p.vendedor_atribuido === login);
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

module.exports = {
  registrarPedidosDetectados,
  listar,
  confirmar,
  rejeitar,
  atribuir,
  matchLoginPorNome,
  VENDEDORES_ATIVOS,
};
