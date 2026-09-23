// lib/frete/gollog.js
// Trecho aéreo — usado APENAS em conjunto com o Ezequiel (Ezequiel leva
// a mercadoria até o aeroporto de origem; Gollog faz o trecho aéreo;
// cliente paga a Gollog na retirada). Não temos API pública da Gollog,
// então:
//   - fornecemos lista fixa dos aeroportos comerciais brasileiros por UF;
//   - a auxiliar seleciona o aeroporto mais próximo do cliente;
//   - o trecho Ezequiel (até o aeroporto) sai da API do Ezequiel;
//   - o valor da Gollog é "a confirmar" (o cliente paga na retirada).

// Aeroportos principais por UF (nome / IATA). Base fixa — atualize se preciso.
const AEROPORTOS = [
  // Norte
  { uf: 'AC', iata: 'RBR', nome: 'Rio Branco (Presidente Médici)' },
  { uf: 'AM', iata: 'MAO', nome: 'Manaus (Eduardo Gomes)' },
  { uf: 'AP', iata: 'MCP', nome: 'Macapá' },
  { uf: 'PA', iata: 'BEL', nome: 'Belém (Val de Cans)' },
  { uf: 'PA', iata: 'MAB', nome: 'Marabá' },
  { uf: 'PA', iata: 'STM', nome: 'Santarém' },
  { uf: 'RO', iata: 'PVH', nome: 'Porto Velho' },
  { uf: 'RR', iata: 'BVB', nome: 'Boa Vista' },
  { uf: 'TO', iata: 'PMW', nome: 'Palmas' },
  // Nordeste
  { uf: 'AL', iata: 'MCZ', nome: 'Maceió (Zumbi dos Palmares)' },
  { uf: 'BA', iata: 'SSA', nome: 'Salvador (Dep. Luís Eduardo Magalhães)' },
  { uf: 'BA', iata: 'IOS', nome: 'Ilhéus' },
  { uf: 'BA', iata: 'BPS', nome: 'Porto Seguro' },
  { uf: 'CE', iata: 'FOR', nome: 'Fortaleza (Pinto Martins)' },
  { uf: 'CE', iata: 'JDO', nome: 'Juazeiro do Norte (Orlando Bezerra)' },
  { uf: 'MA', iata: 'SLZ', nome: 'São Luís (Cunha Machado)' },
  { uf: 'PB', iata: 'JPA', nome: 'João Pessoa (Presidente Castro Pinto)' },
  { uf: 'PE', iata: 'REC', nome: 'Recife (Gilberto Freyre)' },
  { uf: 'PE', iata: 'PNZ', nome: 'Petrolina' },
  { uf: 'PI', iata: 'THE', nome: 'Teresina (Sen. Petrônio Portella)' },
  { uf: 'RN', iata: 'NAT', nome: 'Natal (Aluízio Alves)' },
  { uf: 'SE', iata: 'AJU', nome: 'Aracaju (Santa Maria)' },
  // Centro-Oeste
  { uf: 'DF', iata: 'BSB', nome: 'Brasília (Presidente Juscelino Kubitschek)' },
  { uf: 'GO', iata: 'GYN', nome: 'Goiânia (Santa Genoveva)' },
  { uf: 'MS', iata: 'CGR', nome: 'Campo Grande' },
  { uf: 'MT', iata: 'CGB', nome: 'Cuiabá (Marechal Rondon)' },
  // Sudeste
  { uf: 'ES', iata: 'VIX', nome: 'Vitória (Eurico de Aguiar Salles)' },
  { uf: 'MG', iata: 'CNF', nome: 'Belo Horizonte / Confins (Tancredo Neves)' },
  { uf: 'MG', iata: 'MOC', nome: 'Montes Claros' },
  { uf: 'MG', iata: 'UDI', nome: 'Uberlândia' },
  { uf: 'RJ', iata: 'GIG', nome: 'Rio de Janeiro (Galeão)' },
  { uf: 'RJ', iata: 'SDU', nome: 'Rio de Janeiro (Santos Dumont)' },
  { uf: 'SP', iata: 'GRU', nome: 'São Paulo (Guarulhos)' },
  { uf: 'SP', iata: 'CGH', nome: 'São Paulo (Congonhas)' },
  { uf: 'SP', iata: 'VCP', nome: 'Campinas (Viracopos)' },
  { uf: 'SP', iata: 'RAO', nome: 'Ribeirão Preto' },
  { uf: 'SP', iata: 'PPB', nome: 'Presidente Prudente' },
  // Sul
  { uf: 'PR', iata: 'CWB', nome: 'Curitiba (Afonso Pena)' },
  { uf: 'PR', iata: 'IGU', nome: 'Foz do Iguaçu' },
  { uf: 'PR', iata: 'LDB', nome: 'Londrina' },
  { uf: 'RS', iata: 'POA', nome: 'Porto Alegre (Salgado Filho)' },
  { uf: 'RS', iata: 'PET', nome: 'Pelotas' },
  { uf: 'RS', iata: 'CXJ', nome: 'Caxias do Sul' },
  { uf: 'SC', iata: 'FLN', nome: 'Florianópolis (Hercílio Luz)' },
  { uf: 'SC', iata: 'JOI', nome: 'Joinville (Lauro Carneiro de Loyola)' },
  { uf: 'SC', iata: 'NVT', nome: 'Navegantes (Ministro Victor Konder)' },
  { uf: 'SC', iata: 'XAP', nome: 'Chapecó' },
];

function porUf(uf) {
  const u = String(uf || '').toUpperCase();
  return AEROPORTOS.filter(a => a.uf === u);
}

module.exports = { AEROPORTOS, porUf };
