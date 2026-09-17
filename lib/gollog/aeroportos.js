// lib/gollog/aeroportos.js
// Base de aeroportos onde a Gol Airlines opera (rede 2026) + função pra
// sugerir o mais próximo a partir do CEP.
//
// Dados: fonte pública (ANAC/OpenFlights) — código IATA + coordenadas oficiais.
// Cobre 50+ aeroportos, todas as capitais + principais interiores atendidos
// pela GOL. Se um aeroporto novo entrar na malha, basta adicionar aqui.

const https = require('https');

const AEROPORTOS = [
  // ── Sudeste ─────────────────────────────────────────────────
  { iata: 'GRU', nome: 'Aeroporto Internacional de São Paulo/Guarulhos - Governador André Franco Montoro', cidade: 'Guarulhos',       uf: 'SP', lat: -23.4356, lon: -46.4731 },
  { iata: 'CGH', nome: 'Aeroporto de São Paulo/Congonhas',                                                cidade: 'São Paulo',       uf: 'SP', lat: -23.6273, lon: -46.6566 },
  { iata: 'VCP', nome: 'Aeroporto Internacional de Viracopos',                                            cidade: 'Campinas',        uf: 'SP', lat: -23.0074, lon: -47.1345 },
  { iata: 'SDU', nome: 'Aeroporto Santos Dumont',                                                         cidade: 'Rio de Janeiro',  uf: 'RJ', lat: -22.9105, lon: -43.1631 },
  { iata: 'GIG', nome: 'Aeroporto Internacional do Rio de Janeiro - Galeão',                              cidade: 'Rio de Janeiro',  uf: 'RJ', lat: -22.8099, lon: -43.2505 },
  { iata: 'CNF', nome: 'Aeroporto Internacional Tancredo Neves - Confins',                                cidade: 'Confins',         uf: 'MG', lat: -19.6244, lon: -43.9719 },
  { iata: 'PLU', nome: 'Aeroporto da Pampulha - Carlos Drummond de Andrade',                              cidade: 'Belo Horizonte',  uf: 'MG', lat: -19.8512, lon: -43.9506 },
  { iata: 'UDI', nome: 'Aeroporto Ten. Cel. Av. César Bombonato',                                         cidade: 'Uberlândia',      uf: 'MG', lat: -18.8830, lon: -48.2256 },
  { iata: 'IPN', nome: 'Aeroporto Usiminas',                                                              cidade: 'Ipatinga',        uf: 'MG', lat: -19.4707, lon: -42.4876 },
  { iata: 'MOC', nome: 'Aeroporto Mário Ribeiro',                                                         cidade: 'Montes Claros',   uf: 'MG', lat: -16.7069, lon: -43.8189 },
  { iata: 'VIX', nome: 'Aeroporto de Vitória - Eurico de Aguiar Salles',                                  cidade: 'Vitória',         uf: 'ES', lat: -20.2581, lon: -40.2864 },

  // ── Sul ──────────────────────────────────────────────────────
  { iata: 'CWB', nome: 'Aeroporto Internacional Afonso Pena',                                             cidade: 'São José dos Pinhais', uf: 'PR', lat: -25.5285, lon: -49.1758 },
  { iata: 'FLN', nome: 'Aeroporto Internacional Hercílio Luz',                                            cidade: 'Florianópolis',   uf: 'SC', lat: -27.6702, lon: -48.5525 },
  { iata: 'NVT', nome: 'Aeroporto Ministro Victor Konder',                                                cidade: 'Navegantes',      uf: 'SC', lat: -26.8799, lon: -48.6533 },
  { iata: 'JOI', nome: 'Aeroporto Lauro Carneiro de Loyola',                                              cidade: 'Joinville',       uf: 'SC', lat: -26.2245, lon: -48.7974 },
  { iata: 'CCM', nome: 'Aeroporto Diomício Freitas',                                                      cidade: 'Criciúma',        uf: 'SC', lat: -28.7256, lon: -49.4213 },
  { iata: 'XAP', nome: 'Aeroporto Serafin Enoss Bertaso',                                                 cidade: 'Chapecó',         uf: 'SC', lat: -27.1342, lon: -52.6567 },
  { iata: 'POA', nome: 'Aeroporto Internacional Salgado Filho',                                           cidade: 'Porto Alegre',    uf: 'RS', lat: -29.9944, lon: -51.1714 },
  { iata: 'CXJ', nome: 'Aeroporto Regional Hugo Cantergiani',                                             cidade: 'Caxias do Sul',   uf: 'RS', lat: -29.1971, lon: -51.1875 },
  { iata: 'PFB', nome: 'Aeroporto Lauro Kurtz',                                                           cidade: 'Passo Fundo',     uf: 'RS', lat: -28.2439, lon: -52.3266 },
  { iata: 'IGU', nome: 'Aeroporto Internacional de Foz do Iguaçu',                                        cidade: 'Foz do Iguaçu',   uf: 'PR', lat: -25.6003, lon: -54.4850 },
  { iata: 'LDB', nome: 'Aeroporto Governador José Richa',                                                 cidade: 'Londrina',        uf: 'PR', lat: -23.3336, lon: -51.1301 },
  { iata: 'MGF', nome: 'Aeroporto Regional de Maringá - Silvio Name Júnior',                              cidade: 'Maringá',         uf: 'PR', lat: -23.4794, lon: -52.0122 },
  { iata: 'CAC', nome: 'Aeroporto Municipal Adalberto Mendes da Silva',                                   cidade: 'Cascavel',        uf: 'PR', lat: -25.0004, lon: -53.5008 },

  // ── Centro-Oeste ────────────────────────────────────────────
  { iata: 'BSB', nome: 'Aeroporto Internacional de Brasília - Presidente Juscelino Kubitschek',           cidade: 'Brasília',        uf: 'DF', lat: -15.8697, lon: -47.9208 },
  { iata: 'GYN', nome: 'Aeroporto de Goiânia - Santa Genoveva',                                           cidade: 'Goiânia',         uf: 'GO', lat: -16.6320, lon: -49.2207 },
  { iata: 'CGB', nome: 'Aeroporto Internacional Marechal Rondon',                                         cidade: 'Várzea Grande',   uf: 'MT', lat: -15.6529, lon: -56.1167 },
  { iata: 'CGR', nome: 'Aeroporto Internacional de Campo Grande',                                         cidade: 'Campo Grande',    uf: 'MS', lat: -20.4687, lon: -54.6725 },
  { iata: 'BAT', nome: 'Aeroporto Chafei Amsei',                                                          cidade: 'Barretos',        uf: 'SP', lat: -20.5842, lon: -48.5940 },

  // ── Nordeste ────────────────────────────────────────────────
  { iata: 'SSA', nome: 'Aeroporto Internacional Deputado Luís Eduardo Magalhães',                         cidade: 'Salvador',        uf: 'BA', lat: -12.9086, lon: -38.3225 },
  { iata: 'IOS', nome: 'Aeroporto de Ilhéus - Jorge Amado',                                               cidade: 'Ilhéus',          uf: 'BA', lat: -14.8158, lon: -39.0331 },
  { iata: 'BPS', nome: 'Aeroporto de Porto Seguro',                                                       cidade: 'Porto Seguro',    uf: 'BA', lat: -16.4386, lon: -39.0808 },
  { iata: 'VDC', nome: 'Aeroporto Glauber de Andrade Rocha',                                              cidade: 'Vitória da Conquista', uf: 'BA', lat: -14.9074, lon: -40.9146 },
  { iata: 'REC', nome: 'Aeroporto Internacional do Recife - Gilberto Freyre',                             cidade: 'Recife',          uf: 'PE', lat: -8.1264,  lon: -34.9236 },
  { iata: 'PET', nome: 'Aeroporto Senador Nilo Coelho',                                                   cidade: 'Petrolina',       uf: 'PE', lat: -9.3624,  lon: -40.5691 },
  { iata: 'FOR', nome: 'Aeroporto Internacional Pinto Martins',                                           cidade: 'Fortaleza',       uf: 'CE', lat: -3.7763,  lon: -38.5326 },
  { iata: 'JDO', nome: 'Aeroporto Orlando Bezerra de Menezes',                                            cidade: 'Juazeiro do Norte', uf: 'CE', lat: -7.2189,  lon: -39.2701 },
  { iata: 'NAT', nome: 'Aeroporto Internacional Governador Aluízio Alves',                                cidade: 'São Gonçalo do Amarante', uf: 'RN', lat: -5.7681, lon: -35.3762 },
  { iata: 'JPA', nome: 'Aeroporto Presidente Castro Pinto',                                               cidade: 'Bayeux',          uf: 'PB', lat: -7.1487,  lon: -34.9505 },
  { iata: 'AJU', nome: 'Aeroporto Santa Maria',                                                           cidade: 'Aracaju',         uf: 'SE', lat: -10.9840, lon: -37.0703 },
  { iata: 'MCZ', nome: 'Aeroporto Internacional Zumbi dos Palmares',                                      cidade: 'Rio Largo',       uf: 'AL', lat: -9.5108,  lon: -35.7917 },
  { iata: 'THE', nome: 'Aeroporto Senador Petrônio Portella',                                             cidade: 'Teresina',        uf: 'PI', lat: -5.0596,  lon: -42.8235 },
  { iata: 'SLZ', nome: 'Aeroporto Internacional Marechal Cunha Machado',                                  cidade: 'São Luís',        uf: 'MA', lat: -2.5854,  lon: -44.2341 },
  { iata: 'IMP', nome: 'Aeroporto Prefeito Renato Moreira',                                               cidade: 'Imperatriz',      uf: 'MA', lat: -5.5313,  lon: -47.4599 },

  // ── Norte ────────────────────────────────────────────────────
  { iata: 'BEL', nome: 'Aeroporto Internacional de Belém - Val de Cans/Júlio Cezar Ribeiro',              cidade: 'Belém',           uf: 'PA', lat: -1.3792,  lon: -48.4762 },
  { iata: 'MAB', nome: 'Aeroporto de Marabá - João Correa da Rocha',                                      cidade: 'Marabá',          uf: 'PA', lat: -5.3687,  lon: -49.1380 },
  { iata: 'STM', nome: 'Aeroporto Maestro Wilson Fonseca',                                                cidade: 'Santarém',        uf: 'PA', lat: -2.4225,  lon: -54.7930 },
  { iata: 'ATM', nome: 'Aeroporto de Altamira',                                                           cidade: 'Altamira',        uf: 'PA', lat: -3.2539,  lon: -52.2540 },
  { iata: 'MAO', nome: 'Aeroporto Internacional Eduardo Gomes',                                           cidade: 'Manaus',          uf: 'AM', lat: -3.0386,  lon: -60.0497 },
  { iata: 'MCP', nome: 'Aeroporto Internacional de Macapá - Alberto Alcolumbre',                          cidade: 'Macapá',          uf: 'AP', lat: 0.0506,   lon: -51.0722 },
  { iata: 'BVB', nome: 'Aeroporto Internacional de Boa Vista - Atlas Brasil Cantanhede',                  cidade: 'Boa Vista',       uf: 'RR', lat: 2.8461,   lon: -60.6903 },
  { iata: 'PVH', nome: 'Aeroporto Internacional Governador Jorge Teixeira de Oliveira',                   cidade: 'Porto Velho',     uf: 'RO', lat: -8.7093,  lon: -63.9023 },
  { iata: 'RBR', nome: 'Aeroporto Internacional Plácido de Castro',                                       cidade: 'Rio Branco',      uf: 'AC', lat: -9.8687,  lon: -67.8983 },
  { iata: 'PMW', nome: 'Aeroporto de Palmas - Brigadeiro Lysias Rodrigues',                               cidade: 'Palmas',          uf: 'TO', lat: -10.2915, lon: -48.3570 },
];

// ── Haversine (km) ────────────────────────────────────────────
function distanciaKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ── Consulta CEP na BrasilAPI ─────────────────────────────────
// Retorna { cep, cidade, uf, lat, lon } ou lança.
function consultarCEP(cep) {
  const clean = String(cep || '').replace(/\D/g, '');
  if (clean.length !== 8) return Promise.reject(new Error('CEP inválido: ' + cep));
  return new Promise((resolve, reject) => {
    const req = https.get({
      hostname: 'brasilapi.com.br',
      path: '/api/cep/v2/' + clean,
      timeout: 8000,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (res.statusCode >= 400) return reject(new Error('BrasilAPI HTTP ' + res.statusCode + ': ' + (j.message || data.slice(0, 200))));
          const lat = j.location && j.location.coordinates && Number(j.location.coordinates.latitude);
          const lon = j.location && j.location.coordinates && Number(j.location.coordinates.longitude);
          resolve({
            cep: clean, cidade: j.city || null, uf: j.state || null,
            bairro: j.neighborhood || null, logradouro: j.street || null,
            lat: Number.isFinite(lat) ? lat : null,
            lon: Number.isFinite(lon) ? lon : null,
          });
        } catch (e) { reject(new Error('Erro parseando BrasilAPI: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout BrasilAPI')); });
  });
}

// Fallback: se o CEP não retornar lat/lon, tenta pegar coordenadas do
// aeroporto da capital do estado (aproximação razoável em >90% dos casos).
function centroDeEstado(uf) {
  const capital = AEROPORTOS.find(a => a.uf === uf);
  return capital ? { lat: capital.lat, lon: capital.lon, source: 'capital_uf' } : null;
}

// ── Sugere aeroporto mais próximo pelo CEP ───────────────────
// Retorna { melhor: {aeroporto, distancia_km}, top3: [...], origem: {...} }
async function sugerirPorCEP(cep) {
  const info = await consultarCEP(cep);
  let lat = info.lat, lon = info.lon, origemFonte = 'brasilapi_cep';
  if (lat == null || lon == null) {
    const alt = centroDeEstado(info.uf);
    if (!alt) throw new Error('CEP sem coordenadas e UF sem aeroporto na base: ' + cep);
    lat = alt.lat; lon = alt.lon; origemFonte = 'aeroporto_capital_' + info.uf;
  }
  const rankeados = AEROPORTOS.map(a => ({
    aeroporto: a,
    distancia_km: distanciaKm(lat, lon, a.lat, a.lon),
  })).sort((x, y) => x.distancia_km - y.distancia_km);
  const top3 = rankeados.slice(0, 3).map(x => ({
    iata: x.aeroporto.iata,
    nome: x.aeroporto.nome,
    cidade: x.aeroporto.cidade,
    uf: x.aeroporto.uf,
    distancia_km: Math.round(x.distancia_km * 10) / 10,
  }));
  return {
    melhor: top3[0],
    top3,
    origem: {
      cep: info.cep, cidade: info.cidade, uf: info.uf,
      lat, lon, fonte_coordenada: origemFonte,
    },
  };
}

module.exports = { AEROPORTOS, distanciaKm, consultarCEP, sugerirPorCEP };
