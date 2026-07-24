// Mapa Estado (UF) -> número do SFPC (Setor de Fiscalização de Produtos Controlados)
const SFPC_POR_UF = {
  RJ: 1, ES: 1,
  SP: 2,
  RS: 3,
  MG: 4,
  PR: 5, SC: 5,
  BA: 6, SE: 6,
  AL: 7, PE: 7, PB: 7, RN: 7,
  PA: 8, AP: 8, MA: 8,
  MS: 9, MT: 9,
  CE: 10, PI: 10,
  DF: 11, GO: 11, TO: 11,
  AM: 12, AC: 12, RR: 12, RO: 12,
};

function sfpcPorUf(uf) {
  const n = SFPC_POR_UF[String(uf || '').toUpperCase().trim()];
  return n ? ('SFPC/' + String(n).padStart(2, '0')) : '';
}

module.exports = { SFPC_POR_UF, sfpcPorUf };
