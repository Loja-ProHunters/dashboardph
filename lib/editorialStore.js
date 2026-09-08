// editorialStore.js — marcações de "programado" do calendário da Linha Editorial,
// persistidas no GitHub (igual aos contatos) para que TODOS da gerência vejam o
// mesmo estado, de qualquer dispositivo.
const fs = require('fs');
const path = require('path');
const { getFile, saveFile } = require('./githubStore');

const FILE_PATH = 'editorial.json';
const LOCAL_FALLBACK = path.join(__dirname, '..', 'editorial.json');

async function getEditorial() {
  try {
    return JSON.parse(await getFile(FILE_PATH));
  } catch (e) {
    try { return JSON.parse(fs.readFileSync(LOCAL_FALLBACK, 'utf-8')); }
    catch (e2) { return {}; }
  }
}

async function saveEditorial(state) {
  await saveFile(FILE_PATH, JSON.stringify(state, null, 2), 'Atualiza marcações da linha editorial via portal');
}

module.exports = { getEditorial, saveEditorial };
