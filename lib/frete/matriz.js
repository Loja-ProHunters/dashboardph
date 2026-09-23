// lib/frete/matriz.js
// Matriz de cidades → rota padrão.
// Base inicial é calculada dos 3 CSVs (Ezequiel > LT > RPA) com prioridade,
// e cada cidade nova fechada em cotação é registrada aqui.
// Persistência: crm/frete/matriz-cidades.json (gerada sob demanda + augmentada por commit).

const { getFile, saveFile } = require('../githubStore');
const dados = require('./dados');

const PATH = 'crm/frete/matriz-cidades.json';

let _cache = { data: null, ts: 0 };
const CACHE_MS = 5 * 60 * 1000;

// Retorna dict { "cidade|UF" (normalizado): { cidade, uf, rota_padrao, origem, atualizado_em, atualizado_por } }
async function carregar() {
  const now = Date.now();
  if (_cache.data && (now - _cache.ts) < CACHE_MS) return _cache.data;
  let data = {};
  try {
    const raw = await getFile(PATH);
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') data = parsed;
  } catch (e) { /* arquivo ainda não existe */ }
  _cache = { data, ts: now };
  return data;
}

async function salvar(data, msg) {
  await saveFile(PATH, JSON.stringify(data, null, 2), msg || 'Matriz de cidades: atualiza');
  _cache = { data, ts: Date.now() };
}

// Regra de escolha: Ezequiel > LT > RPA > NNE(LT redespacho) > nada.
// (Ordem do doc: Ezequiel → RPA → LT → Aéreo. Mas o painel prefere LT que tem
//  tabela sólida sobre RPA que ainda é manual. Mantemos Ezequiel > LT > RPA.)
function _rotaAutoMatica(cobre) {
  if (cobre.ezequiel) return 'ezequiel';
  if (cobre.lt) return 'lt';
  if (cobre.rpa) return 'rpa';
  if (cobre.lt_aereo) return 'aereo'; // LT NNE
  return 'aereo'; // default: aéreo (Ezequiel+Gollog) — usuário confirma
}

// Consulta rota padrão pra uma cidade. Primeiro olha a matriz persistida
// (que tem escolhas humanas); se não achar, calcula da base.
async function rotaPadrao(cidade, uf) {
  const key = dados._keyCidade(cidade, uf);
  const m = await carregar();
  if (m[key]) return { rota: m[key].rota_padrao, origem: m[key].origem || 'matriz', persisted: true, cidade, uf };

  // Calcula das bases
  const d = await dados.carregar();
  const cobre = {
    ezequiel: !!d.ezequiel.byKey[key],
    rpa: !!d.rpa.byKey[key],
    lt: !!d.lt.cidades.byKey[key],
    lt_aereo: !!d.lt.cidades.byKey[dados._keyCidade(cidade, 'NNE')],
  };
  const rota = _rotaAutoMatica(cobre);
  return { rota, origem: 'base_inicial', persisted: false, cobertura: cobre, cidade, uf };
}

// Registra uma escolha humana (ao fechar cotação): grava na matriz.
async function registrarEscolha({ cidade, uf, rota, atualizado_por }) {
  if (!cidade || !uf || !rota) return;
  const key = dados._keyCidade(cidade, uf);
  const m = await carregar();
  m[key] = {
    cidade, uf: String(uf).toUpperCase(),
    rota_padrao: rota,
    origem: 'manual',
    atualizado_em: new Date().toISOString(),
    atualizado_por: atualizado_por || null,
  };
  await salvar(m, 'Matriz cidades: fechado ' + cidade + '/' + uf + ' → ' + rota);
}

// Lista todas as entradas persistidas (só as manuais)
async function listar() {
  const m = await carregar();
  return Object.values(m).sort((a, b) => (a.uf + a.cidade).localeCompare(b.uf + b.cidade));
}

module.exports = { rotaPadrao, registrarEscolha, listar };
