// metaDiaria.js — Contador de meta diária dos vendedores.
// Regra: meta = R$ 8.800 por dia útil (seg-sex, excluindo feriados).
// Meta acumulada até hoje = R$ 8.800 × dias úteis já passados (inclusive hoje).
// Saldo do vendedor = faturamento do mês − meta acumulada.
// Saldo positivo = ele está adiantado. Saldo negativo = está atrasado.

const fs = require('fs');
const path = require('path');
const { getFile, saveFile } = require('./githubStore');

const META_DIA = 8800;
const FILE_PATH = 'feriados.json';
const LOCAL_FALLBACK = path.join(__dirname, '..', 'feriados.json');

// Feriados nacionais fixos (dia-mês)
const FERIADOS_NACIONAIS_FIXOS = [
  '01-01', // Confraternização Universal
  '04-21', // Tiradentes
  '05-01', // Dia do Trabalho
  '09-07', // Independência
  '10-12', // Nossa Senhora Aparecida
  '11-02', // Finados
  '11-15', // Proclamação da República
  '11-20', // Consciência Negra (nacional desde 2024)
  '12-25', // Natal
];

async function getFeriadosCustom() {
  try {
    const raw = await getFile(FILE_PATH);
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
  } catch (e) {
    try {
      const raw = fs.readFileSync(LOCAL_FALLBACK, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    } catch (e2) { /* segue */ }
  }
  return [];
}

async function saveFeriadosCustom(lista) {
  await saveFile(FILE_PATH, JSON.stringify(lista, null, 2), 'Atualiza lista de feriados via portal');
}

function _isoDate(d) {
  return d.toISOString().slice(0, 10);
}
function _mmdd(d) {
  return String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// Retorna true se a data é útil (não é sábado/domingo, não é feriado)
function _isUtil(date, feriadosCustom) {
  const dow = date.getDay(); // 0=dom, 6=sab
  if (dow === 0 || dow === 6) return false;
  const iso = _isoDate(date);
  const mmdd = _mmdd(date);
  if (FERIADOS_NACIONAIS_FIXOS.includes(mmdd)) return false;
  if (feriadosCustom.includes(iso)) return false;
  return true;
}

// Conta quantos dias úteis já passaram no mês atual (inclusive hoje).
async function diasUteisAte(dataRef) {
  const feriadosCustom = await getFeriadosCustom();
  const ref = dataRef || new Date();
  const ano = ref.getFullYear(), mes = ref.getMonth();
  const dia = ref.getDate();
  let count = 0;
  for (let d = 1; d <= dia; d++) {
    const dt = new Date(ano, mes, d);
    if (_isUtil(dt, feriadosCustom)) count++;
  }
  return count;
}

// Total de dias úteis do mês inteiro (usado pra projeção)
async function diasUteisDoMes(dataRef) {
  const feriadosCustom = await getFeriadosCustom();
  const ref = dataRef || new Date();
  const ano = ref.getFullYear(), mes = ref.getMonth();
  const ultimoDia = new Date(ano, mes + 1, 0).getDate();
  let count = 0;
  for (let d = 1; d <= ultimoDia; d++) {
    const dt = new Date(ano, mes, d);
    if (_isUtil(dt, feriadosCustom)) count++;
  }
  return count;
}

async function calcularProgressoMeta(sellers) {
  const hoje = new Date();
  const uteisAte = await diasUteisAte(hoje);
  const uteisMes = await diasUteisDoMes(hoje);
  const metaAcumulada = META_DIA * uteisAte;
  const metaMes = META_DIA * uteisMes;
  const hojeUtil = uteisAte > 0 && _isUtil(hoje, await getFeriadosCustom());

  const vendedores = sellers.map(s => {
    const fat = Number(s.fat) || 0;
    const saldo = fat - metaAcumulada;
    const pct = metaAcumulada > 0 ? Math.round((fat / metaAcumulada) * 100) : 0;
    return {
      id: s.id, name: s.name, foto: s.foto,
      faturamento: fat,
      metaAcumulada, saldo, pct,
      status: saldo >= 0 ? 'adiantado' : 'atrasado',
    };
  });
  return { metaDia: META_DIA, uteisAte, uteisMes, metaAcumulada, metaMes, hojeUtil, vendedores };
}

module.exports = {
  META_DIA,
  getFeriadosCustom, saveFeriadosCustom,
  diasUteisAte, diasUteisDoMes,
  calcularProgressoMeta,
};
