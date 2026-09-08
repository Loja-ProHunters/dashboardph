// tarifasStore.js — taxas das operadoras de cartão (Pagar.me, Blu) usadas pela
// Calculadora de Juros. Persistidas no GitHub (igual aos contatos/editorial) para
// que a gerência edite uma vez e valha para todos os vendedores.
const fs = require('fs');
const path = require('path');
const { getFile, saveFile } = require('./githubStore');

const FILE_PATH = 'tarifas.json';
const LOCAL_FALLBACK = path.join(__dirname, '..', 'tarifas.json');

async function getTarifas() {
  try {
    return JSON.parse(await getFile(FILE_PATH));
  } catch (e) {
    try { return JSON.parse(fs.readFileSync(LOCAL_FALLBACK, 'utf-8')); }
    catch (e2) { return {}; }
  }
}

async function saveTarifas(data) {
  await saveFile(FILE_PATH, JSON.stringify(data, null, 2), 'Atualiza taxas de cartão via portal');
}

module.exports = { getTarifas, saveTarifas };
