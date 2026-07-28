const fs = require('fs');
const path = require('path');
const { getFile, saveFile } = require('./githubStore');

const FILE_PATH = 'comercial-data.json';
const LOCAL_FALLBACK = path.join(__dirname, '..', 'comercial-data.json');

const DEFAULT_SELLERS = [
  { id: 1, name: 'Pedro',          foto: 'consultor_pedro.jpg',  fat: 0, etiqueta: 0, tarefas: 0, faltas: 0, atrasos: 0 },
  { id: 2, name: 'Enzo',           foto: 'consultor_enzo.jpg',   fat: 0, etiqueta: 0, tarefas: 0, faltas: 0, atrasos: 0 },
  { id: 3, name: 'Wesley Mathias', foto: 'consultor_wesley.jpg', fat: 0, etiqueta: 0, tarefas: 0, faltas: 0, atrasos: 0 },
];

const META_IND = 150000;

function calcScoreServer(s) {
  const fatNorm = Math.min(100, ((s.fat || 0) / (META_IND * 2)) * 100);
  const score = (fatNorm * 3) + (Math.min(100, s.etiqueta || 0) * 1) + (Math.min(100, s.tarefas || 0) * 1);
  const maxScore = 100 * (3 + 1 + 1);
  return Math.round((score / maxScore) * 100);
}

function hojeReferencia() {
  return new Date().toISOString().slice(0, 7); // AAAA-MM
}

function defaultData() {
  return {
    sellers: DEFAULT_SELLERS.map(s => ({ ...s })),
    diasCorridos: 1,
    diasMes: 30,
    mesReferencia: hojeReferencia(),
    savedAt: null,
    history: [], // [{ mesReferencia, vencedor, sellers, fechadoEm }]
  };
}

let cache = { data: null, ts: 0 };
const CACHE_MS = 20 * 1000;

async function fetchRawData() {
  try {
    const text = await getFile(FILE_PATH);
    return JSON.parse(text);
  } catch (e) {
    try {
      const text = fs.readFileSync(LOCAL_FALLBACK, 'utf-8');
      return JSON.parse(text);
    } catch (e2) {
      return defaultData();
    }
  }
}

// Fecha automaticamente o mes anterior (arquiva no historico com o vencedor por
// maior score) sempre que o mes civil atual for diferente do mesReferencia salvo.
// Isso roda sozinho, sem precisar de ninguem clicar em nada.
async function autoRolloverSeNecessario(data) {
  const atual = hojeReferencia();
  if (!data.mesReferencia || data.mesReferencia === atual) return data;

  const ranked = [...data.sellers].sort((a, b) => calcScoreServer(b) - calcScoreServer(a));
  const vencedor = ranked[0] ? ranked[0].name : null;

  data.history = data.history || [];
  data.history.unshift({
    mesReferencia: data.mesReferencia,
    vencedor,
    sellers: data.sellers.map(s => ({ ...s })),
    fechadoEm: new Date().toISOString(),
  });
  data.sellers = data.sellers.map(s => ({
    ...s,
    fat: 0, etiqueta: 0, tarefas: 0, faltas: 0, atrasos: 0,
  }));
  data.mesReferencia = atual;
  await saveComercialData(data);
  return data;
}

async function getComercialData() {
  const now = Date.now();
  if (cache.data && (now - cache.ts) < CACHE_MS) return cache.data;
  let data = await fetchRawData();
  data = await autoRolloverSeNecessario(data);
  cache = { data, ts: Date.now() };
  return data;
}

async function saveComercialData(data) {
  data.savedAt = new Date().toISOString();
  await saveFile(FILE_PATH, JSON.stringify(data, null, 2), 'Atualiza dados do Dashboard Comercial');
  cache = { data, ts: Date.now() };
}

async function resetMonth(vencedorNome) {
  const data = await getComercialData();
  data.history = data.history || [];
  data.history.unshift({
    mesReferencia: data.mesReferencia,
    vencedor: vencedorNome || null,
    sellers: data.sellers.map(s => ({ ...s })),
    fechadoEm: new Date().toISOString(),
  });
  data.sellers = data.sellers.map(s => ({
    ...s,
    fat: 0, etiqueta: 0, tarefas: 0, faltas: 0, atrasos: 0,
  }));
  data.diasCorridos = 1;
  data.mesReferencia = hojeReferencia();
  await saveComercialData(data);
  return data;
}

// Atualiza (soma) o faturamento de UM vendedor especifico — usado pelo
// autolancamento dos proprios vendedores ("registrei uma venda de RX").
async function registrarVenda(sellerId, valor) {
  const data = await getComercialData();
  const s = data.sellers.find(x => x.id === sellerId);
  if (!s) throw new Error('Vendedor nao encontrado.');
  s.fat = (s.fat || 0) + valor;
  await saveComercialData(data);
  return data;
}

module.exports = { getComercialData, saveComercialData, resetMonth, registrarVenda, defaultData };
