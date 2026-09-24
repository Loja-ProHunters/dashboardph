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

// Diagnóstico: retorna se a cidade+UF bate em cada base (Ezequiel/LT/RPA/NNE)
// e a chave normalizada usada. Útil pra debugar "cidade que deveria ter cobertura
// mas não achou".
async function diagnosticar(cidade, uf) {
  const key = dados._keyCidade(cidade, uf);
  const d = await dados.carregar();
  const ufNorm = String(uf || '').toUpperCase();
  return {
    input: { cidade, uf: ufNorm },
    chave_normalizada: key,
    ezequiel: !!d.ezequiel.byKey[key],
    rpa: !!d.rpa.byKey[key],
    lt_rodoviario: !!d.lt.cidades.byKey[key],
    lt_nne_aereo: !!d.lt.cidades.byKey[dados._keyCidade(cidade, 'NNE')],
    contagens_base: {
      ezequiel_total: (d.ezequiel.list || []).length,
      rpa_total: (d.rpa.list || []).length,
      lt_total: (d.lt.cidades.list || []).length,
    },
    // Amostras próximas em cada base — ajudam a achar o nome exato do CSV
    sugestoes: {
      rpa: _sugerirProximas(d.rpa.list, cidade, ufNorm),
      ezequiel: _sugerirProximas(d.ezequiel.list, cidade, ufNorm),
      lt: _sugerirProximas(d.lt.cidades.list, cidade, ufNorm),
    },
  };
}

function _sugerirProximas(lista, cidade, uf) {
  if (!lista || !lista.length) return [];
  const alvo = dados._norm(cidade);
  const alvoUf = String(uf || '').toUpperCase();
  const filtrados = lista.filter(x => (x.uf || '').toUpperCase() === alvoUf);
  // Busca por substring do alvo ou o alvo contém a cidade
  const matches = filtrados.filter(x => {
    const n = dados._norm(x.cidade);
    return n.includes(alvo) || alvo.includes(n) || _distanciaSimples(n, alvo) <= 2;
  });
  return matches.slice(0, 5).map(x => ({ cidade: x.cidade, uf: x.uf }));
}

// Distância "edit" simples (Levenshtein-lite) — só pra sugestões de match aproximado
function _distanciaSimples(a, b) {
  if (Math.abs(a.length - b.length) > 3) return 999;
  let dif = 0;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) dif++;
  }
  return dif;
}

module.exports = { rotaPadrao, registrarEscolha, listar, diagnosticar };
