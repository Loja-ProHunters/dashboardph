// lib/bling/vendedores.js
// Cache do mapa de vendedores do Bling (id → {nome, email}) — POR CONTA.
// Bling API v3 costuma devolver `pedido.vendedor` como { id: 123 } SEM nome/email.
// Pra fazer o mapeamento com usuários do CRM, precisamos consultar /vendedores.
//
// IMPORTANTE (correcao 20/10/2026): cada conta do Bling (Pro Hunters e Calibre
// Restrito) tem seus PROPRIOS ids de vendedor. Antes o cache era unico e sempre
// lido da conta padrao — os pedidos da Calibre nao achavam o vendedor e caiam
// no "dono" do cliente (que podia ter vindo do rodizio). Agora tudo e por conta.
//
// Uso:
//   const vend = require('./vendedores');
//   await vend.puxarMapa({ contaId: 'calibre' });   // carrega TODOS da conta
//   const info = await vend.getById(123, 'calibre'); // {id, nome, email}
//   vend.invalidarCache();

const blingApi = require('./api');

const _mapas = {};        // contaId → { id → { id, nome, email } }
const _ts = {};           // contaId → timestamp
const CACHE_TTL = 6 * 60 * 60 * 1000; // 6h

function _cid(contaId) {
  try { return contaId || require('../../config').blingContaPadrao || 'prohunters'; }
  catch (e) { return contaId || 'prohunters'; }
}

// Puxa /vendedores paginado da conta. Retorna { id → {id, nome, email} }.
async function puxarMapa({ forcar = false, contaId } = {}) {
  const cid = _cid(contaId);
  if (!forcar && _mapas[cid] && (Date.now() - (_ts[cid] || 0)) < CACHE_TTL) return _mapas[cid];
  const mapa = {};
  let pagina = 1;
  while (pagina <= 20) { // safety: 20 pgs × 100 = 2000 vendedores
    let r;
    try {
      r = await blingApi.get('/vendedores', { pagina, limite: 100 }, cid);
    } catch (e) {
      if (e.status === 403 || e.status === 404) break;
      throw e;
    }
    const lote = Array.isArray(r) ? r : (r && Array.isArray(r.data) ? r.data : []);
    if (!lote.length) break;
    for (const v of lote) {
      const id = v.id || (v.contato && v.contato.id);
      if (!id) continue;
      const nome = String((v.contato && v.contato.nome) || v.nome || '').trim();
      const email = String((v.contato && v.contato.email) || v.email || '').trim().toLowerCase();
      mapa[String(id)] = { id: String(id), nome, email };
    }
    if (lote.length < 100) break;
    pagina++;
  }
  _mapas[cid] = mapa;
  _ts[cid] = Date.now();
  return mapa;
}

// Busca 1 vendedor por ID NA CONTA certa. Usa cache; se miss, chama /vendedores/{id}.
async function getById(id, contaId) {
  if (!id) return null;
  const cid = _cid(contaId);
  const sid = String(id);
  if (_mapas[cid] && _mapas[cid][sid]) return _mapas[cid][sid];
  try {
    await puxarMapa({ contaId: cid });
    if (_mapas[cid] && _mapas[cid][sid]) return _mapas[cid][sid];
  } catch (e) {}
  try {
    const r = await blingApi.get('/vendedores/' + sid, undefined, cid);
    const v = (r && r.data) || r;
    if (v) {
      const info = {
        id: sid,
        nome: String((v.contato && v.contato.nome) || v.nome || '').trim(),
        email: String((v.contato && v.contato.email) || v.email || '').trim().toLowerCase(),
      };
      if (!_mapas[cid]) _mapas[cid] = {};
      _mapas[cid][sid] = info;
      return info;
    }
  } catch (e) {}
  return null;
}

function invalidarCache() { for (const k of Object.keys(_mapas)) { delete _mapas[k]; delete _ts[k]; } }

async function estatisticas(contaId) {
  const m = await puxarMapa({ contaId });
  return { conta: _cid(contaId), total: Object.keys(m).length, amostra: Object.values(m).slice(0, 10) };
}

module.exports = { puxarMapa, getById, invalidarCache, estatisticas };
