// lib/crm/sugerir.js
// Camada 3.2 do "cérebro" do CRM: motor de sugestão de próxima venda.
//
// v2 — TURBINADO com catálogo Bling completo + marcas fortes (Nível 2).
// Agora funciona pra TODAS as marcas, não só Fenix.
//
// Função `sugerirParaCliente({ accountId, orderId?, contexto? })`:
//   1. Carrega histórico do cliente + catálogo Bling + coocorrência + compat Fenix
//   2. Enriquece itens comprados com descrição/marca/categoria do catálogo
//   3. Detecta PERFIL do cliente (tier premium/mainstream/volume, marcas usadas)
//   4. Monta shortlist de candidatos via 4 fontes:
//        (a) compat Fenix (acessórios oficiais)
//        (b) coocorrência histórica (quem comprou X levou Y)
//        (c) MESMA MARCA de itens comprados (via catálogo) — NOVO
//        (d) MESMA CATEGORIA de itens comprados (via catálogo) — NOVO
//   5. Remove SKUs já comprados, inativos, sem estoque (bônus: prefere com estoque)
//   6. Passa contexto rico pra Claude com perfil + lista de marcas fortes,
//      preços e estoques dos candidatos. Claude ranqueia + escreve pitch.
//   7. Retorna [{sku_bling, sku_fenix?, nome, motivo, confianca, fonte, pitch}]
//
// A IA NUNCA inventa SKU — só escolhe do catálogo real.

const https           = require('https');
const config          = require('../../config');
const crmStore        = require('./store');
const fenixCompat     = require('./fenixCompat');
const blingFenixMap   = require('./blingFenixMap');
const coocorrencia    = require('./coocorrencia');
const catalogoBling   = require('./catalogoBling');
const marcas          = require('./marcas');

const MODEL = 'claude-sonnet-4-5-20250929';
const MAX_SUGESTOES = 3;
const SHORTLIST_MAX = 40; // margem generosa pra IA escolher

// ── Núcleo do motor ─────────────────────────────────────────────
async function sugerirParaCliente({ accountId, orderId, contextoExtra = null, maxSugestoes = MAX_SUGESTOES } = {}) {
  const avisos = [];

  // ── 1. Carrega a conta e o histórico ──────────────────────────
  const account = await crmStore.getDoc('accounts', accountId);
  if (!account) throw new Error('Conta não encontrada: ' + accountId);

  const orders = await crmStore.listDocs('orders', o => o.account_id === accountId && o.status !== 'cancelado');
  orders.sort((a, b) => String(b.data_pedido || '').localeCompare(String(a.data_pedido || '')));

  let orderFoco = null;
  if (orderId) {
    orderFoco = orders.find(o => o.id === orderId);
    if (!orderFoco) avisos.push('Pedido de foco não encontrado; usando histórico completo');
  }

  // ── 2. Coleta SKUs a analisar ────────────────────────────────
  const skusFoco = orderFoco
    ? (orderFoco.itens || []).map(i => String(i.sku)).filter(Boolean)
    : orders.slice(0, 5).flatMap(o => (o.itens || []).map(i => String(i.sku)).filter(Boolean));

  const skusFocoUnicos = [...new Set(skusFoco)];
  if (!skusFocoUnicos.length) {
    return { sugestoes: [], contexto: { motivo: 'Cliente sem itens em pedidos válidos' }, avisos };
  }

  // ── 3. SKUs que o cliente JÁ TEM (pra excluir do que sugerir) ─
  const skusJaComprados = new Set();
  for (const o of orders) {
    for (const it of (o.itens || [])) if (it && it.sku) skusJaComprados.add(String(it.sku));
  }

  // ── 4. Enriquece itens comprados com dados do catálogo e detecta perfil ─
  const todosItensComprados = orders.flatMap(o => (o.itens || []));
  const itensEnriquecidos = await catalogoBling.enriquecer(todosItensComprados);
  const itensComMarca = itensEnriquecidos.map(it => ({
    sku: it.sku,
    descricao: it.descricao || (it.catalogo && it.catalogo.nome) || '',
    marca: (it.catalogo && it.catalogo.marca) || marcas.detectarMarca(it.descricao || '') || null,
    categoria: (it.catalogo && it.catalogo.categoria) || null,
  }));
  const perfilCliente = marcas.perfilDoCliente(itensComMarca);

  // Marcas + categorias dos itens no foco (pra expansão dirigida)
  const marcasFoco = new Set();
  const categoriasFoco = new Set();
  const itensFocoEnriquecidos = itensComMarca.filter(it => skusFocoUnicos.includes(it.sku));
  for (const it of itensFocoEnriquecidos) {
    if (it.marca) marcasFoco.add(String(it.marca).toLowerCase());
    if (it.categoria) categoriasFoco.add(it.categoria);
  }

  // ── 5. Monta shortlist via 4 fontes ──────────────────────────
  const candidatos = {}; // sku_bling → { motivos, fontes, score, catalogo? }

  function _addCandidato(sku, nome, motivo, fonte, delta) {
    const s = String(sku || '').trim();
    if (!s) return;
    if (skusJaComprados.has(s)) return;
    if (!candidatos[s]) {
      candidatos[s] = { sku_bling: s, nome: nome || s, motivos: [], fontes: new Set(), score: 0 };
    }
    candidatos[s].motivos.push(motivo);
    candidatos[s].fontes.add(fonte);
    candidatos[s].score += delta;
  }

  // 5a — Compat Fenix (via bling-fenix-map)
  for (const skuBling of skusFocoUnicos) {
    const mapping = await blingFenixMap.resolverSku(skuBling);
    if (mapping.encontrado && mapping.codes && mapping.codes.length && mapping.marca === 'fenix') {
      for (const codeFenix of mapping.codes) {
        const modelo = await fenixCompat.consultarModelo(codeFenix);
        if (!modelo) continue;
        const acessorios = [...(modelo.compativel || []), ...(modelo.baterias || [])];
        for (const ac of acessorios) {
          const blingsQueFornecemEsseFenix = await _buscarBlingPorFenix(ac.sku);
          for (const blc of blingsQueFornecemEsseFenix) {
            _addCandidato(
              blc.sku_bling, blc.descricao_bling,
              'Acessório oficial Fenix compatível com ' + codeFenix + ' (' + (ac.grupo || ac.tipo || 'acessório') + ')',
              'fabricante', 5
            );
            if (candidatos[blc.sku_bling]) candidatos[blc.sku_bling].sku_fenix = ac.sku;
          }
        }
      }
    }
  }

  // 5b — Coocorrência histórica
  for (const skuBling of skusFocoUnicos) {
    const cooc = await coocorrencia.getPara(skuBling);
    if (!cooc) continue;
    for (const item of (cooc.compraram_junto || [])) {
      _addCandidato(
        item.sku, item.descricao,
        Math.round((item.confianca || 0) * 100) + '% dos que compraram esse produto também levaram este (' + (item.vezes || '?') + '× no mesmo pedido)',
        'coocorrencia', (item.confianca || 0) * 5
      );
    }
    for (const item of (cooc.compraram_depois || [])) {
      _addCandidato(
        item.sku, item.descricao,
        Math.round((item.confianca || 0) * 100) + '% voltaram pra comprar este em média em ' + (item.dias_medios || '?') + ' dias',
        'coocorrencia', (item.confianca || 0) * 4
      );
    }
  }

  // 5c — MESMA MARCA (via catálogo) — NOVO
  for (const marcaNome of marcasFoco) {
    const meta = marcas.getMeta(marcaNome);
    if (meta.tier === 'desconhecido') continue; // só marcas fortes
    const produtos = await catalogoBling.buscarPorMarca(marcaNome, { somenteAtivos: true, somenteComEstoque: false });
    for (const p of produtos.slice(0, 30)) { // limita pra não explodir shortlist
      if (skusJaComprados.has(p.sku)) continue;
      _addCandidato(
        p.sku, p.nome,
        'Mesma marca (' + (p.marca || marcaNome) + ') do que já comprou',
        'marca', 2
      );
    }
  }

  // 5d — MESMA CATEGORIA (via catálogo) — NOVO. Score baixo (contexto pra IA).
  for (const cat of categoriasFoco) {
    const produtos = await catalogoBling.buscarPorCategoria(cat, { somenteAtivos: true, somenteComEstoque: true });
    for (const p of produtos.slice(0, 15)) {
      if (skusJaComprados.has(p.sku)) continue;
      _addCandidato(
        p.sku, p.nome,
        'Mesma categoria (' + cat + ') — em estoque',
        'categoria', 1
      );
    }
  }

  // ── 6. Enriquece shortlist com dados do catálogo (preço, estoque, marca) ─
  let shortlist = Object.values(candidatos)
    .sort((a, b) => b.score - a.score)
    .slice(0, SHORTLIST_MAX);

  shortlist = await catalogoBling.enriquecer(shortlist);

  // Filtro: ignora inativos e boosta com estoque
  shortlist = shortlist
    .filter(c => !c.catalogo || c.catalogo.ativo !== false) // se não tá no catálogo, mantém (pode ser SKU antigo)
    .map(c => {
      let boost = 0;
      if (c.catalogo) {
        if (c.catalogo.estoque_saldo > 0) boost += 1;
        if (c.catalogo.marca && marcas.getMeta(c.catalogo.marca).tier === 'premium') boost += 0.5;
      }
      return { ...c, score: c.score + boost };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, maxSugestoes * 4);

  if (!shortlist.length) {
    return { sugestoes: [], contexto: { motivo: 'Sem candidatos após cruzar todas as fontes' }, avisos };
  }

  // ── 7. Chama Claude pra ranquear + gerar pitch ────────────────
  let ranked = shortlist;
  try {
    ranked = await _rankearComIA({
      account, orderFoco, orders, shortlist, perfilCliente,
      itensFocoEnriquecidos, contextoExtra, maxSugestoes,
    });
  } catch (e) {
    avisos.push('IA falhou (' + e.message + '), usando ranking heurístico');
    ranked = shortlist.slice(0, maxSugestoes).map(c => ({
      sku_bling: c.sku_bling,
      sku_fenix: c.sku_fenix || null,
      nome: (c.catalogo && c.catalogo.nome) || c.nome || c.sku_bling,
      motivo: (c.motivos || [])[0] || 'Compatível com histórico',
      confianca: Math.min(1, c.score / 10),
      fonte: [...(c.fontes || [])][0] || 'mista',
      pitch: 'Oi ' + ((account.nome || 'cliente').split(' ')[0]) + '! Vi que você comprou algo compatível — quer conhecer ' + ((c.catalogo && c.catalogo.nome) || c.nome || c.sku_bling) + '?',
    }));
  }

  return {
    sugestoes: ranked,
    contexto: {
      account_id: accountId,
      account_nome: account.nome,
      order_foco: orderFoco ? orderFoco.id : null,
      total_candidatos: shortlist.length,
      total_pedidos_historico: orders.length,
      perfil_cliente: perfilCliente,
    },
    avisos,
  };
}

// ── Helper: dado um código Fenix, acha SKUs Bling que o representam ─
async function _buscarBlingPorFenix(codeFenix) {
  const map = await blingFenixMap.carregar();
  const out = [];
  for (const [skuBling, m] of Object.entries(map.mapeamentos || {})) {
    if (!m.revisado_por_humano) continue;
    if ((m.fenix_codes || []).includes(codeFenix)) {
      out.push({ sku_bling: skuBling, descricao_bling: m.descricao_bling });
    }
  }
  return out;
}

// ── Helper: chama Claude com contexto RICO (v2 do prompt) ────────
function _rankearComIA({ account, orderFoco, orders, shortlist, perfilCliente, itensFocoEnriquecidos, contextoExtra, maxSugestoes }) {
  const historicoResumido = orders.slice(0, 10).map(o => ({
    data: o.data_pedido,
    valor: o.valor_total,
    itens: (o.itens || []).map(i => i.descricao || i.sku).slice(0, 5),
  }));

  // Contexto de candidatos ENRIQUECIDO (com marca, preço, estoque, categoria)
  const candidatosContexto = shortlist.map(c => {
    const cat = c.catalogo || {};
    return {
      sku_bling: c.sku_bling,
      nome: cat.nome || c.nome,
      marca: cat.marca || null,
      categoria: cat.categoria || null,
      preco: cat.preco || null,
      em_estoque: (cat.estoque_saldo || 0) > 0,
      sku_fenix: c.sku_fenix || null,
      motivos: c.motivos,
      fontes: [...(c.fontes || [])],
    };
  });

  const marcasAgrupadas = marcas.listaAgrupada();
  const primeiroNome = account.nome ? account.nome.split(' ')[0] : 'cliente';

  const prompt = `Você é um assistente comercial da Pro Hunters (loja brasileira de armas, munições, óptica e acessórios táticos). Ajuda o vendedor a decidir qual próxima venda oferecer a um cliente específico.

# CLIENTE
Nome: ${account.nome}
${orderFoco
  ? 'COMPRA RECENTE em ' + orderFoco.data_pedido + ' de R$ ' + (orderFoco.valor_total || '?') + ' — foco pós-venda:\n'
    + (orderFoco.itens||[]).map(i => '  - ' + (i.descricao || i.sku) + ' (qtd ' + i.quantidade + ')').join('\n')
  : 'Análise de REATIVAÇÃO (sem pedido de foco).'}

# PERFIL DO CLIENTE (deduzido do histórico dele)
- Tier predominante: ${perfilCliente.tier_predominante}   ← use pra calibrar preço/qualidade das sugestões
- Marcas que já compra: ${perfilCliente.marcas_compradas.join(', ') || '(nenhuma marca forte identificada)'}
- Categorias que já explora: ${perfilCliente.categorias.join(', ') || '(nenhuma categoria mapeada)'}

# HISTÓRICO DE COMPRAS (últimos 10)
${JSON.stringify(historicoResumido, null, 2)}

# CATÁLOGO — MARCAS FORTES QUE VENDEMOS (por categoria)
${JSON.stringify(marcasAgrupadas, null, 2)}

# CANDIDATOS A SUGERIR (já filtrados: cliente NÃO tem esses ainda)
${JSON.stringify(candidatosContexto, null, 2)}

${contextoExtra ? '# CONTEXTO EXTRA\n' + JSON.stringify(contextoExtra, null, 2) + '\n' : ''}

# REGRAS DE OURO
1. NUNCA invente SKU — use APENAS os \`sku_bling\` da lista de candidatos acima.
2. Priorize itens EM ESTOQUE (\`em_estoque: true\`).
3. Coerência de tier: cliente premium não deve receber sugestão de item volume genérico como "próxima grande compra"; cliente volume não deve receber Weatherby de R$ 15.000 fora de contexto.
4. Coerência de ecossistema: quem compra Glock ganha munição 9mm + acessório Magpul + óptica compatível; quem compra Bergara/Weatherby/Anschutz ganha munição do calibre + óptica GPO/Vector Optics + acessório high-end.
5. Se o cliente comprou uma ARMA recentemente, priorize MUNIÇÃO daquele calibre e ACESSÓRIO essencial (holster, luneta, bipé conforme o tipo).
6. Se comprou MUNIÇÃO em volume, sugira acessório de recarga (Hornady) ou outra munição complementar.
7. Se comprou ÓPTICA/LANTERNA, sugira suporte/montagem/bateria compatível.

# TAREFA
Escolha as ${maxSugestoes} MELHORES sugestões. Ordene por probabilidade real de conversão (mais provável primeiro).

Para cada uma:
- \`sku_bling\`: EXATO da lista de candidatos
- \`nome\`: nome do produto (use o do candidato, não invente)
- \`sku_fenix\`: se aplicável (null se não for Fenix)
- \`motivo\`: 1 frase curta em PT explicando por que faz sentido pra ESSE cliente (mencione algo do histórico ou perfil)
- \`confianca\`: 0.0 a 1.0 (chance real de fechar)
- \`fonte\`: "fabricante" / "coocorrencia" / "marca" / "categoria" / "mista"
- \`pitch\`: mensagem pronta pra WhatsApp, tom informal-profissional, começando com "Oi ${primeiroNome}", máximo 3 linhas, mencionando o produto que ele comprou e por que essa sugestão faz sentido. NÃO invente promessa de estoque/preço.

# FORMATO DE RESPOSTA
JSON válido, nada antes/depois:
{
  "sugestoes": [
    { "sku_bling": "...", "nome": "...", "sku_fenix": null, "motivo": "...", "confianca": 0.85, "fonte": "marca", "pitch": "Oi ..." }
  ]
}`;

  return new Promise((resolve, reject) => {
    if (!config.anthropicApiKey) return reject(new Error('ANTHROPIC_API_KEY não configurada'));
    const body = JSON.stringify({ model: MODEL, max_tokens: 2048, messages: [{ role: 'user', content: prompt }] });
    const req = https.request({
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
        'x-api-key': config.anthropicApiKey, 'anthropic-version': '2023-06-01',
      },
      timeout: 45000,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (res.statusCode >= 400) return reject(new Error('Claude API ' + res.statusCode));
          const texto = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
          let s = texto.trim();
          const m = s.match(/```(?:json)?\s*([\s\S]*?)```/);
          if (m) s = m[1].trim();
          const parsed = JSON.parse(s);
          resolve(parsed.sugestoes || []);
        } catch (e) { reject(new Error('Parse Claude: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout Claude')); });
    req.write(body); req.end();
  });
}

module.exports = { sugerirParaCliente };
