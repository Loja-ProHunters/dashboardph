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

function defaultData() {
  return {
    sellers: DEFAULT_SELLERS.map(s => ({ ...s })),
    diasCorridos: 1,
    diasMes: 30,
    mesReferencia: new Date().toISOString().slice(0, 7), // AAAA-MM
    savedAt: null,
    history: [], // [{ mesReferencia, vencedor, sellers, fechadoEm }]
  };
}

let cache = { data: null, ts: 0 };
const CACHE_MS = 20 * 1000;

async function getComercialData() {
  const now = Date.now();
  if (cache.data && (now - cache.ts) < CACHE_MS) return cache.data;
  try {
    const text = await getFile(FILE_PATH);
    const data = JSON.parse(text);
    cache = { data, ts: now };
    return data;
  } catch (e) {
    try {
      const text = fs.readFileSync(LOCAL_FALLBACK, 'utf-8');
      return JSON.parse(text);
    } catch (e2) {
      return defaultData();
    }
  }
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
  data.mesReferencia = new Date().toISOString().slice(0, 7);
  await saveComercialData(data);
  return data;
}

module.exports = { getComercialData, saveComercialData, resetMonth, defaultData };
