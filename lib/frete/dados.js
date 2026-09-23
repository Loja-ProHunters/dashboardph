// lib/frete/dados.js
// Carrega e cacheia os 4 arquivos de dados de frete (CSVs no repo):
//   crm/frete/ezequiel_cidades.csv   (778 cidades — cobertura Ezequiel)
//   crm/frete/rpa_cidades.csv        (4.690 cidades + prazo dias úteis)
//   crm/frete/lt_cidades.csv         (2.015 municípios de coleta LT)
//   crm/frete/lt_precos.csv          (tabela por UF de destino, curta/longa 1-10un)
// Cache em memória por invocação serverless (10 min).

const { getFile } = require('../githubStore');

const CACHE_MS = 10 * 60 * 1000;
const _cache = { data: null, ts: 0 };

// Normaliza pra key de busca: lowercase, sem acento, sem pontuação, trim.
function _norm(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}
function _keyCidade(cidade, uf) {
  return _norm(cidade) + '|' + String(uf || '').toUpperCase();
}

function _parseCsv(text) {
  // Parser CSV simples: aspas duplas, vírgula. Suficiente pros nossos arquivos.
  const rows = [];
  let cur = [''], inQ = false, i = 0, line = 0;
  const push = () => cur.push('');
  const commit = () => { rows.push(cur); cur = ['']; };
  while (i < text.length) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { cur[cur.length - 1] += '"'; i += 2; continue; }
        inQ = false; i++;
      } else { cur[cur.length - 1] += c; i++; }
    } else {
      if (c === '"') { inQ = true; i++; }
      else if (c === ',') { push(); i++; }
      else if (c === '\r') { i++; }
      else if (c === '\n') { commit(); line++; i++; }
      else { cur[cur.length - 1] += c; i++; }
    }
  }
  if (cur.length > 1 || cur[0] !== '') commit();
  if (!rows.length) return { header: [], data: [] };
  const header = rows[0].map(h => h.trim());
  const data = rows.slice(1)
    .filter(r => r.length && r.some(v => (v || '').trim() !== ''))
    .map(r => {
      const o = {};
      header.forEach((k, idx) => o[k] = (r[idx] === undefined ? '' : r[idx]).trim());
      return o;
    });
  return { header, data };
}

async function _loadCsv(path) {
  try {
    const raw = await getFile(path);
    return _parseCsv(raw);
  } catch (e) {
    return { header: [], data: [] };
  }
}

// Carrega tudo (1x por warm start)
async function carregar() {
  const now = Date.now();
  if (_cache.data && (now - _cache.ts) < CACHE_MS) return _cache.data;

  const [ez, rpa, ltCid, ltPr] = await Promise.all([
    _loadCsv('crm/frete/ezequiel_cidades.csv'),
    _loadCsv('crm/frete/rpa_cidades.csv'),
    _loadCsv('crm/frete/lt_cidades.csv'),
    _loadCsv('crm/frete/lt_precos.csv'),
  ]);

  // ── Ezequiel: cidade, estado, uf, lat, long ──────────────────
  const ezequiel = { byKey: {}, list: [] };
  for (const r of ez.data) {
    const uf = String(r.uf || '').toUpperCase();
    const cidade = r.cidade || '';
    if (!uf || !cidade) continue;
    const item = { cidade, uf, estado: r.estado || '', lat: Number(r.latitude) || null, lng: Number(r.longitude) || null };
    ezequiel.byKey[_keyCidade(cidade, uf)] = item;
    ezequiel.list.push(item);
  }

  // ── RPA: cidade, uf, prazo_dias_uteis ────────────────────────
  const rpaMap = { byKey: {}, list: [] };
  for (const r of rpa.data) {
    const uf = String(r.uf || '').toUpperCase();
    const cidade = r.cidade || '';
    if (!uf || !cidade) continue;
    const prazo = Number(r.prazo_dias_uteis) || null;
    const item = { cidade, uf, prazo_dias_uteis: prazo };
    rpaMap.byKey[_keyCidade(cidade, uf)] = item;
    rpaMap.list.push(item);
  }

  // ── LT cidades: estado_destino, municipio_ou_aeroporto ────────
  // O estado_destino pode ser UF (SC/PR/SP/MG/RJ/ES) ou "Norte/Nordeste/Centro-Oeste"
  // (redespacho aéreo). Guardamos como uf normalizado.
  const lt = { byKey: {}, list: [] };
  const aereoNNE = new Set(); // cidades que entram só via redespacho aéreo LT
  for (const r of ltCid.data) {
    const estado = r.estado_destino || '';
    const cidade = r.municipio_ou_aeroporto || '';
    if (!estado || !cidade) continue;
    const isAereo = estado.toUpperCase().startsWith('NORTE') || estado.includes('/');
    const uf = isAereo ? 'NNE' : estado.toUpperCase();
    const item = { cidade, uf, redespacho_aereo: isAereo };
    lt.byKey[_keyCidade(cidade, uf)] = item;
    lt.list.push(item);
    if (isAereo) aereoNNE.add(_norm(cidade));
  }

  // ── LT preços: por UF destino, curta/longa 1..10 un ──────────
  // Estrutura: precoUf[UF] = { curta: [v1..v10], longa: [v1..v10], modalidade }
  const ltPreco = {};
  for (const r of ltPr.data) {
    const ufRaw = r['Estado destino'] || '';
    const isAereo = ufRaw.toUpperCase().startsWith('NORTE') || ufRaw.includes('/');
    const uf = isAereo ? 'NNE' : ufRaw.toUpperCase();
    const curta = [], longa = [];
    for (let i = 1; i <= 10; i++) {
      curta.push(Number(r['Curta ' + i + ' un']) || null);
      longa.push(Number(r['Longa ' + i + ' un']) || null);
    }
    ltPreco[uf] = { modalidade: r.Modalidade || '', curta, longa };
  }

  _cache.data = { ezequiel, rpa: rpaMap, lt: { cidades: lt, precos: ltPreco, aereoNNE } };
  _cache.ts = now;
  return _cache.data;
}

module.exports = { carregar, _norm, _keyCidade };
