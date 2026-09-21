// lib/bling/vendedores.js
// Cache do mapa de vendedores do Bling (id → {nome, email}).
// Bling API v3 costuma devolver `pedido.vendedor` como { id: 123 } SEM nome/email.
// Pra fazer o mapeamento com usuários do CRM, precisamos consultar /vendedores.
//
// Uso:
//   const vend = require('./vendedores');
//   await vend.puxarMapa();                // carrega TODOS de uma vez
//   const info = await vend.getById(123);  // {id, nome, email} — do cache; se miss, busca sob demanda
//   vend.invalidarCache();

const blingApi = require('./api');

let _mapa = null;         // { id → { id, nome, email } }
let _mapaTs = 0;
const CACHE_TTL = 6 * 60 * 60 * 1000; // 6h

// Puxa /vendedores paginado. Retorna { id → {id, nome, email} }.
async function puxarMapa({ forcar = false } = {}) {
  if (!forcar && _mapa && (Date.now() - _mapaTs) < CACHE_TTL) return _mapa;
  const mapa = {};
  let pagina = 1;
  while (pagina <= 20) { // safety: 20 pgs × 100 = 2000 vendedores
    let r;
    try {
      r = await blingApi.get('/vendedores', { pagina, limite: 100 });
    } catch (e) {
      // Alguns escopos não têm /vendedores — fallback via /contatos com tipo V (vendedor)
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
  _mapa = mapa;
  _mapaTs = Date.now();
  return mapa;
}

// Busca 1 vendedor por ID. Usa cache; se cache vazio, chama /vendedores/{id}.
async function getById(id) {
  if (!id) return null;
  const sid = String(id);
  if (_mapa && _mapa[sid]) return _mapa[sid];
  // Tenta puxar mapa inteiro (mais eficiente pra várias buscas)
  try {
    await puxarMapa();
    if (_mapa && _mapa[sid]) return _mapa[sid];
  } catch (e) {}
  // Fallback: pega 1 só direto
  try {
    const r = await blingApi.get('/vendedores/' + sid);
    const v = (r && r.data) || r;
    if (v) {
      const info = {
        id: sid,
        nome: String((v.contato && v.contato.nome) || v.nome || '').trim(),
        email: String((v.contato && v.contato.email) || v.email || '').trim().toLowerCase(),
      };
      if (!_mapa) _mapa = {};
      _mapa[sid] = info;
      return info;
    }
  } catch (e) {}
  return null;
}

function invalidarCache() { _mapa = null; _mapaTs = 0; }

// Estatísticas do cache (pra debug)
async function estatisticas() {
  const m = await puxarMapa();
  return {
    total: Object.keys(m).length,
    amostra: Object.values(m).slice(0, 10),
  };
}

module.exports = { puxarMapa, getById, invalidarCache, estatisticas };
