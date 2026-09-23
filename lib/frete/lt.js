// lib/frete/lt.js
// Cotação LT — tabela estática por UF de destino + tipo (curta/longa) + quantidade (1..10).
// Descoberta: preço é IDÊNTICO pra todos os municípios da mesma UF (LT cobra por UF).
// Coleta em SC. Redespacho aéreo pra N/NE/CO tem valor "a confirmar".

const dados = require('./dados');

// itens: [{ tipo: 'curta'|'curtaGlock'|'longa', quantidade: N }] — insumos NÃO entram na tabela LT
// A LT não cobra por insumos avulsos; se o pedido tem só insumos, a LT não cota.
async function cotar({ cidade, uf, itens }) {
  const d = await dados.carregar();
  if (!uf) return { ok: false, motivo: 'UF obrigatória' };

  const ufNorm = String(uf).toUpperCase();

  // Confere cobertura
  const cobre = !!d.lt.cidades.byKey[dados._keyCidade(cidade, ufNorm)];
  // A tabela de preços cobre 6 UFs (SC/PR/SP/MG/RJ/ES) + NNE.
  const precoUf = d.lt.precos[ufNorm] || null;
  const precoNne = d.lt.precos['NNE'] || null;

  // Se a UF não está na tabela de preços rodoviária mas a cidade está listada
  // no bucket NNE, é redespacho aéreo LT — valor "a confirmar".
  if (!precoUf) {
    if (cobre || precoNne) {
      return {
        ok: true,
        atendida: true,
        cidade: cidade || null,
        uf: ufNorm,
        modalidade: 'Redespacho aéreo (confirmar valor)',
        confirmar: true,
        valor_total: null,
        detalhes: 'Norte/Nordeste/Centro-Oeste. Tabela existe (curta/longa 1-10un) mas valores estão marcados como "a confirmar saindo de SC" — cotar direto com a LT antes de fechar.',
        tabela_estimada: precoNne,
      };
    }
    return { ok: true, atendida: false, motivo: 'UF ' + ufNorm + ' fora da tabela LT' };
  }
  if (!cobre) {
    return { ok: true, atendida: false, motivo: 'Cidade ' + (cidade || '?') + '/' + ufNorm + ' fora da cobertura LT (coleta SC)' };
  }

  // Soma preços por tipo (usa faixa 1..10; se qtd > 10, usa preço de 10 un + regra "a confirmar")
  let total = 0;
  let overflowQtd = false;
  const linhas = [];
  for (const it of (itens || [])) {
    const tipoRaw = String(it.tipo || '').trim();
    if (tipoRaw === 'insumos') continue; // LT não cota insumos
    // curta e curtaGlock caem na coluna "curta"
    const col = (tipoRaw === 'longa') ? 'longa' : 'curta';
    const qtd = Math.max(1, Number(it.quantidade) || 1);
    let idx = Math.min(qtd, 10) - 1;
    if (qtd > 10) overflowQtd = true;
    const arr = precoUf[col];
    const v = (arr && arr[idx] != null) ? Number(arr[idx]) : null;
    if (v != null) {
      total += v;
      linhas.push({ tipo: col, quantidade: qtd, valor: v });
    }
  }
  if (!linhas.length) {
    return { ok: true, atendida: false, motivo: 'Nenhum item da LT (arma) no pedido — só insumos' };
  }

  return {
    ok: true,
    atendida: true,
    cidade: cidade || null,
    uf: ufNorm,
    modalidade: precoUf.modalidade || 'Rodoviário, coleta SC',
    valor_total: total,
    itens: linhas,
    aviso_overflow: overflowQtd ? 'Pedido tem >10 un de arma — cotar direto com a LT pra faixas acima da tabela' : null,
  };
}

async function cobrePorCidade(cidade, uf) {
  const d = await dados.carregar();
  const k = dados._keyCidade(cidade, String(uf || '').toUpperCase());
  const kNNE = dados._keyCidade(cidade, 'NNE');
  return !!(d.lt.cidades.byKey[k] || d.lt.cidades.byKey[kNNE]);
}

module.exports = { cotar, cobrePorCidade };
