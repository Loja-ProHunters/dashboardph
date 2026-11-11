// lib/woo/afiliados.js — Coleta de vendas de afiliados (influenciadores) a
// partir dos pedidos do WooCommerce, atribuindo por CUPOM de desconto.
//
// Cada influenciador tem um cupom (ex.: MARIA10). Puxamos os pedidos pagos das
// lojas, olhamos os coupon_lines de cada pedido e, quando o cupom bate com um
// influenciador cadastrado, viramos aquilo numa "venda" atribuída a ele.
//
// NÃO persiste nada — devolve as vendas coletadas pro endpoint mesclar (dedup
// por ref = loja#pedido).

const woo = require('./client');

function _round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function _ymd(s) { return s ? String(s).slice(0, 10) : null; }

// Monta o nome do cliente a partir do billing do pedido.
function _nomeCliente(o) {
  const b = o.billing || {};
  const nome = ((b.first_name || '') + ' ' + (b.last_name || '')).trim();
  return nome || b.company || b.email || '—';
}

// Coleta vendas atribuíveis. Params:
//   influenciadores: lista do parceiros.json
//   opts.statuses:   status de pedido a considerar (default pagos)
//   opts.after:      ISO date — só pedidos criados depois (sync incremental)
// Retorna { porLoja: {slug:{...}}, vendas: [ {ref, loja, ...} ] }
async function coletarVendas(influenciadores, opts) {
  opts = opts || {};
  const ativos = (influenciadores || []).filter(i => i && i.ativo !== false);
  // mapa CUPOM(maiúsculo) -> influenciador
  const porCupom = {};
  for (const inf of ativos) {
    if (inf.cupom) porCupom[String(inf.cupom).trim().toUpperCase()] = inf;
  }

  const statuses = opts.statuses || 'completed,processing';
  const resultado = { porLoja: {}, vendas: [] };

  for (const loja of woo.lojasAtivas()) {
    const query = { status: statuses, orderby: 'date', order: 'desc' };
    if (opts.after) query.after = opts.after;

    let pedidos = [];
    try {
      pedidos = await woo.wooGetAll(loja, 'orders', query, { perPage: 100, maxPaginas: 30, delayMs: 120 });
    } catch (e) {
      resultado.porLoja[loja.slug] = { nome: loja.nome, erro: e.message };
      continue;
    }

    let comCupom = 0, atribuidas = 0;
    const cuponsVistos = {}; // code -> qtd (inclusive os sem influenciador, pra diagnóstico)

    for (const o of pedidos) {
      const cupons = Array.isArray(o.coupon_lines) ? o.coupon_lines : [];
      if (!cupons.length) continue;
      comCupom++;

      let inf = null, cupomUsado = null;
      for (const c of cupons) {
        const code = String(c.code || '').trim().toUpperCase();
        if (code) cuponsVistos[code] = (cuponsVistos[code] || 0) + 1;
        if (!inf && porCupom[code]) { inf = porCupom[code]; cupomUsado = code; }
      }
      if (!inf) continue;
      atribuidas++;

      const frete = _round2(o.shipping_total);
      const bruto = _round2(o.total);
      const liquido = _round2(bruto - frete);
      const pct = Number(inf.comissaoPct) || 0;
      const produtos = (o.line_items || []).map(li => ({
        nome: li.name,
        qty: Number(li.quantity) || 0,
        total: _round2(li.total),
      }));

      resultado.vendas.push({
        ref: loja.slug + '#' + o.id,      // chave única pra dedup
        loja: loja.slug,
        lojaNome: loja.nome,
        pedidoWoo: o.id,
        pedidoTray: String(o.number || o.id), // reaproveita campo de exibição existente
        cupom: cupomUsado,
        influenciadorId: inf.id,
        data: _ymd(o.date_paid || o.date_created),
        cliente: _nomeCliente(o),
        valorBruto: bruto,
        valorFrete: frete,
        valorLiquido: liquido,
        comissaoPct: pct,
        comissao: _round2(liquido * pct / 100),
        produtos,
        origem: 'woo',
        statusWoo: o.status,
        cancelada: false,
        criadaEm: new Date().toISOString(),
      });
    }

    resultado.porLoja[loja.slug] = {
      nome: loja.nome,
      pedidos: pedidos.length,
      comCupom,
      atribuidas,
      cupons: cuponsVistos, // ajuda a ver cupons usados que ainda não têm influenciador
    };
  }

  return resultado;
}

// Amostra crua (poucos pedidos) pra validar o formato real da API de uma loja.
// Devolve só campos úteis — sem dados sensíveis além do primeiro nome.
async function amostraPedidos(slug, limite) {
  const loja = woo.lojaPorSlug(slug) || woo.lojasAtivas()[0];
  if (!loja) throw new Error('Nenhuma loja WooCommerce ativa.');
  const pedidos = await woo.wooGet(loja, 'orders', { per_page: Math.max(1, Math.min(10, limite || 3)), orderby: 'date', order: 'desc' });
  const lista = (Array.isArray(pedidos) ? pedidos : []).map(o => ({
    id: o.id,
    number: o.number,
    status: o.status,
    date_created: o.date_created,
    date_paid: o.date_paid,
    total: o.total,
    shipping_total: o.shipping_total,
    discount_total: o.discount_total,
    coupon_lines: (o.coupon_lines || []).map(c => ({ code: c.code, discount: c.discount })),
    primeiro_nome: (o.billing && o.billing.first_name) || null,
    line_items: (o.line_items || []).map(li => ({ name: li.name, quantity: li.quantity, total: li.total })),
  }));
  return { loja: loja.slug, nome: loja.nome, qtd: lista.length, pedidos: lista };
}

// Lista TODOS os cupons criados nas lojas (usados ou não) — via API de cupons
// do WooCommerce. Serve pra DESCOBRIR parceiros novos: um cupom que existe na
// loja mas ainda não está vinculado a nenhum influenciador, mesmo com zero
// vendas, aparece aqui. Agrupa por código (um mesmo código pode existir nas 2
// lojas) e soma os usos (usage_count que o próprio WooCommerce conta).
async function listarCupons() {
  const porLoja = {};
  const porCodigo = {}; // code -> { code, usos, lojas:Set, criado, tipo, valor, descricao }
  for (const loja of woo.lojasAtivas()) {
    let cupons = [];
    try {
      cupons = await woo.wooGetAll(loja, 'coupons', { orderby: 'date', order: 'desc' }, { perPage: 100, maxPaginas: 20, delayMs: 120 });
    } catch (e) {
      porLoja[loja.slug] = { nome: loja.nome, erro: e.message };
      continue;
    }
    porLoja[loja.slug] = { nome: loja.nome, total: cupons.length };
    cupons.forEach(c => {
      const code = String(c.code || '').trim().toUpperCase();
      if (!code) return;
      if (!porCodigo[code]) porCodigo[code] = { code: code, usos: 0, lojas: [], criado: null, tipo: c.discount_type || '', valor: c.amount || '', descricao: c.description || '' };
      const reg = porCodigo[code];
      reg.usos += Number(c.usage_count) || 0;
      if (reg.lojas.indexOf(loja.nome) === -1) reg.lojas.push(loja.nome);
      const dc = (c.date_created || '').slice(0, 10);
      if (dc && (!reg.criado || dc < reg.criado)) reg.criado = dc; // data de criação mais antiga
    });
  }
  return { porLoja, cupons: Object.values(porCodigo) };
}

module.exports = { coletarVendas, amostraPedidos, listarCupons };
