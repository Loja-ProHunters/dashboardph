// lib/frete/rpa.js
// RPA — cobertura + prazo. Sem tabela de preço (por enquanto).
// Retorna valor_total=null → UI trata como "campo manual" com destaque amarelo.

const dados = require('./dados');

async function cotar({ cidade, uf }) {
  const d = await dados.carregar();
  const item = d.rpa.byKey[dados._keyCidade(cidade, String(uf || '').toUpperCase())];
  if (!item) {
    return { ok: true, atendida: false, motivo: 'Cidade ' + (cidade || '?') + '/' + uf + ' fora da cobertura RPA' };
  }
  return {
    ok: true,
    atendida: true,
    cidade: item.cidade,
    uf: item.uf,
    prazo_dias_uteis: item.prazo_dias_uteis,
    valor_total: null,
    confirmar: true,
    detalhes: 'Valor manual — cotar no SSW/painel RPA e digitar aqui. Prazo estimado: ' + (item.prazo_dias_uteis || '?') + ' dias úteis.',
  };
}

async function cobrePorCidade(cidade, uf) {
  const d = await dados.carregar();
  return !!d.rpa.byKey[dados._keyCidade(cidade, String(uf || '').toUpperCase())];
}

module.exports = { cotar, cobrePorCidade };
