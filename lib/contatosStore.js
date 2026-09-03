// contatosStore.js — lista de contatos úteis (fornecedores / telefones),
// persistida no GitHub igual aos outros dados do portal.
const fs = require('fs');
const path = require('path');
const { getFile, saveFile } = require('./githubStore');

const FILE_PATH = 'contatos.json';
const LOCAL_FALLBACK = path.join(__dirname, '..', 'contatos.json');

async function getContatos() {
  try {
    return JSON.parse(await getFile(FILE_PATH));
  } catch (e) {
    try { return JSON.parse(fs.readFileSync(LOCAL_FALLBACK, 'utf-8')); }
    catch (e2) { return []; }
  }
}

async function saveContatos(list) {
  await saveFile(FILE_PATH, JSON.stringify(list, null, 2), 'Atualiza contatos úteis via portal');
}

module.exports = { getContatos, saveContatos };
