// lib/frete/ezequiel.js
// Cotação pela API pública do Transporte Ezequiel.
//   POST https://api.transporteexp.com/api/publico/cotacao
//   Body: { cep, itens: [{tipo, quantidade|valor}] }
//   Tipos aceitos: curta, curtaGlock, longa, insumos
// Rate limit: 20 req/min por IP → chamamos on-demand (só quando o vendedor pede cotar).

const https = require('https');
const dados = require('./dados');

const HOST = 'api.transporteexp.com';
const PATH = '/api/publico/cotacao';
const TIMEOUT_MS = 15000;

function _post(body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: HOST,
      path: PATH,
      method: 'POST',
      timeout: TIMEOUT_MS,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'Accept': 'application/json',
        'User-Agent': 'prohunters-crm/1.0',
      },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        let parsed = null;
        try { parsed = d ? JSON.parse(d) : null; } catch (e) { parsed = { raw: d }; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.write(payload);
    req.end();
  });
}

// itens: [{ tipo: 'curta'|'curtaGlock'|'longa'|'insumos', quantidade?: N, valor?: R$ }]
// Retorna: { ok, atendida, cidade, uf, valor_total, itens, motivo?, resposta_bruta? }
async function cotar({ cep, itens }) {
  if (!cep) return { ok: false, motivo: 'CEP obrigatório' };
  const cepLimpo = String(cep).replace(/\D/g, '');
  if (cepLimpo.length !== 8) return { ok: false, motivo: 'CEP inválido' };

  const itensBody = (itens || []).filter(i => i && i.tipo).map(i => {
    const t = String(i.tipo).trim();
    if (t === 'insumos') return { tipo: 'insumos', valor: Number(i.valor) || 0 };
    return { tipo: t, quantidade: Number(i.quantidade) || 1 };
  });

  if (!itensBody.length) return { ok: false, motivo: 'Nenhum item pra cotar' };

  let res;
  try {
    res = await _post({ cep: cepLimpo, itens: itensBody });
  } catch (e) {
    return { ok: false, motivo: 'Falha na API do Ezequiel: ' + (e.message || String(e)) };
  }

  // 404 = fora de cobertura; 429 = rate limit
  if (res.status === 404) {
    return { ok: true, atendida: false, motivo: 'CEP fora da cobertura Ezequiel' };
  }
  if (res.status === 429) {
    return { ok: false, motivo: 'API Ezequiel bloqueou por rate limit (20 req/min). Aguarde 1 min.' };
  }
  if (res.status < 200 || res.status >= 300) {
    return { ok: false, motivo: 'API Ezequiel retornou ' + res.status };
  }
  const b = res.body || {};
  if (b.ok === false) return { ok: true, atendida: false, motivo: b.erro || 'CEP não encontrado' };
  if (!b.destino) return { ok: false, motivo: 'Resposta Ezequiel inesperada' };

  return {
    ok: true,
    atendida: b.destino.atendida !== false,
    cidade: b.destino.cidade,
    uf: b.destino.uf,
    praca: b.destino.praca || null,
    valor_total: Number(b.total) || 0,
    itens: b.itens || [],
    moeda: b.moeda || 'BRL',
  };
}

// Verificação rápida de cobertura pela base local (778 cidades), sem chamar a API.
// Usada pra saber se a Ezequiel é a rota padrão da cidade antes de cotar.
async function cobrePorCidade(cidade, uf) {
  const d = await dados.carregar();
  return !!d.ezequiel.byKey[dados._keyCidade(cidade, uf)];
}

module.exports = { cotar, cobrePorCidade };
