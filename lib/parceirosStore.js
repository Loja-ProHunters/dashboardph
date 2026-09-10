// parceirosStore.js — Programa de parceiros/influenciadores.
// Persiste tudo no GitHub (igual aos outros stores): influenciadores cadastrados,
// vendas com cupom (vindas da Tray ou lançadas manualmente), pagamentos feitos
// e a configuração da integração com a Tray.
const fs = require('fs');
const path = require('path');
const { getFile, saveFile } = require('./githubStore');

const FILE_PATH = 'parceiros.json';
const LOCAL_FALLBACK = path.join(__dirname, '..', 'parceiros.json');

const DEFAULT_SHAPE = {
  influenciadores: [],
  vendas: [],
  pagamentos: [],
  tray: { consumer_key: null, consumer_secret: null, code: null, ultimaSync: null, modoTeste: true },
};

async function getParceiros() {
  let raw = null;
  try { raw = await getFile(FILE_PATH); }
  catch (e) {
    try { raw = fs.readFileSync(LOCAL_FALLBACK, 'utf-8'); }
    catch (e2) { return { ...DEFAULT_SHAPE }; }
  }
  try {
    const d = JSON.parse(raw);
    // completa campos que possam faltar em versões antigas do arquivo
    return {
      influenciadores: Array.isArray(d.influenciadores) ? d.influenciadores : [],
      vendas: Array.isArray(d.vendas) ? d.vendas : [],
      pagamentos: Array.isArray(d.pagamentos) ? d.pagamentos : [],
      tray: Object.assign({}, DEFAULT_SHAPE.tray, d.tray || {}),
    };
  } catch (e) { return { ...DEFAULT_SHAPE }; }
}

async function saveParceiros(data) {
  await saveFile(FILE_PATH, JSON.stringify(data, null, 2), 'Atualiza parceiros via portal');
}

module.exports = { getParceiros, saveParceiros };
