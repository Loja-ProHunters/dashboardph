// lib/frete/cotar.js
// Orquestra a cotação nas 4 transportadoras seguindo a regra:
//   Ezequiel → RPA → LT → Aéreo (Ezequiel+Gollog)
// Retorna cards ordenados por prioridade + rota sugerida da matriz.

const ezequiel = require('./ezequiel');
const lt = require('./lt');
const rpa = require('./rpa');
const gollog = require('./gollog');
const matriz = require('./matriz');
const dados = require('./dados');

// Descobre cidade+uf a partir do CEP.
// Estratégia: chama Ezequiel primeiro (a API dele já devolve cidade/uf).
// Se a Ezequiel não conhecer o CEP, usa a base RPA/LT (não temos base CEP→cidade).
async function _localizarPorCep({ cep, cidade, uf }) {
  // Se veio cidade+uf explícito, usa direto
  if (cidade && uf) return { cidade, uf: String(uf).toUpperCase(), fonte: 'input' };
  // Se veio só CEP, precisa achar. Usa a API do Ezequiel como resolver de CEP.
  if (!cep) return null;
  return null; // vamos tentar via API do Ezequiel na hora da cotação
}

async function cotarTudo({ cep, cidade, uf, itens, actor }) {
  const out = { ok: true, itens_input: itens, resultados: [], cidade: null, uf: null, rota_sugerida: null };

  // 1) Cota Ezequiel — a resposta dela nos dá cidade/uf autoritativos.
  const rez = await ezequiel.cotar({ cep, itens });
  if (rez.ok && rez.cidade) { out.cidade = rez.cidade; out.uf = rez.uf; }

  // Se veio cidade/uf manual, prefere isso (o CEP pode não estar na base Ezequiel)
  if (cidade && uf) { out.cidade = cidade; out.uf = String(uf).toUpperCase(); }

  // 2) Cota LT e RPA em paralelo (com base local, não chama serviço externo)
  const [rlt, rrpa] = await Promise.all([
    lt.cotar({ cidade: out.cidade, uf: out.uf, itens }),
    rpa.cotar({ cidade: out.cidade, uf: out.uf }),
  ]);

  // 3) Consulta rota sugerida da matriz
  if (out.cidade && out.uf) {
    try { out.rota_sugerida = await matriz.rotaPadrao(out.cidade, out.uf); } catch (e) {}
  }

  // 4) Monta resultados na ordem Ezequiel → LT → RPA → Aéreo
  //    Cada resultado tem: transportadora, atendida, valor, motivo, prioridade
  out.resultados.push({
    transportadora: 'ezequiel',
    label: 'Ezequiel',
    atendida: rez.ok && rez.atendida !== false,
    valor_total: rez.valor_total,
    detalhes: rez.itens || [],
    motivo: rez.motivo || null,
    cidade: rez.cidade, uf: rez.uf,
    modalidade: 'Rodoviário (API pública)',
    fonte: 'api_ezequiel',
  });

  out.resultados.push({
    transportadora: 'lt',
    label: 'LT — Grupo LT',
    atendida: rlt.ok && rlt.atendida !== false,
    valor_total: rlt.valor_total,
    detalhes: rlt.itens || [],
    modalidade: rlt.modalidade,
    confirmar: !!rlt.confirmar,
    aviso: rlt.aviso_overflow,
    motivo: rlt.motivo || null,
    fonte: 'tabela_lt',
  });

  out.resultados.push({
    transportadora: 'rpa',
    label: 'RPA',
    atendida: rrpa.ok && rrpa.atendida !== false,
    valor_total: null,
    valor_manual: true,
    prazo_dias_uteis: rrpa.prazo_dias_uteis || null,
    motivo: rrpa.motivo || null,
    detalhes: rrpa.detalhes || null,
    fonte: 'base_rpa',
  });

  // Rota aérea (Ezequiel+Gollog): só aparece se NENHUMA das terrestres atende
  const algumaTerrestreAtende = out.resultados.some(r => r.atendida && r.transportadora !== 'rpa') ||
                                 (out.resultados.find(r => r.transportadora === 'rpa') || {}).atendida;
  if (!algumaTerrestreAtende) {
    const aeroportos = out.uf ? gollog.porUf(out.uf) : [];
    out.resultados.push({
      transportadora: 'aereo',
      label: 'Ezequiel + Gollog (aéreo)',
      atendida: true,
      valor_total: null,
      valor_manual: true,
      modalidade: 'Aéreo — Ezequiel até o aeroporto + Gollog',
      motivo: 'Nenhuma rota terrestre atende essa cidade',
      aeroportos_uf: aeroportos,
      fonte: 'aereo_manual',
    });
  }

  return out;
}

module.exports = { cotarTudo };
