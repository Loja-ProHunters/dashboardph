// lib/crm/sugerir.js
// Camada 3.2 do "cérebro" do CRM: motor de sugestão de próxima venda.
//
// Função `sugerirParaCliente({ accountId, orderId?, contexto? })`:
//   1. Carrega histórico de compras do cliente (do CRM)
//   2. Se orderId foi passado, foca no pedido novo (UPSELL contextual)
//      Senão, olha o histórico todo (REATIVAÇÃO)
//   3. Traduz cada item comprado via bling-fenix-map.json → código Fenix
//   4. Cruza com Camada 1 (compat Fenix) — acessórios/baterias oficiais
//   5. Cruza com Camada 2 (coocorrência histórica) — "quem comprou X levou Y"
//   6. Remove sugestões que o cliente JÁ COMPROU antes
//   7. Passa contexto estruturado pra Claude, que ranqueia + gera pitch
//      pronto pra WhatsApp com o nome do cliente e detalhes
//   8. Retorna [{sku_bling, sku_fenix, nome, motivo, confianca, fonte, pitch}]
//
// A IA NUNCA INVENTA SKU — só usa códigos que existem no catálogo real do
// Bling (via bling-fenix-map ou coocorrência). Se não achar match, retorna [].

const https = require('https');
const config = require('../../config');
const crmStore     = require('./store');
const fenixCompat  = require('./fenixCompat');
const blingFenixMap = require('./blingFenixMap');
const coocorrencia = require('./coocorrencia');

const MODEL = 'claude-sonnet-4-5-20250929';
const MAX_SUGESTOES = 3;

// ── Núcleo do motor ─────────────────────────────────────────────
// Retorna { sugestoes: [...], contexto: {...}, avisos: [...] }
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

  // ── 4. Coleta candidatos: da compat Fenix + coocorrência ─────
  const candidatos = {}; // sku_bling → { motivos: [...], fontes: Set, score }

  for (const skuBling of skusFocoUnicos) {
    // 4a. Via bling-fenix-map → busca no compat Fenix
    const mapping = await blingFenixMap.resolverSku(skuBling);
    if (mapping.encontrado && mapping.codes.length && mapping.marca === 'fenix') {
      for (const codeFenix of mapping.codes) {
        const modelo = await fenixCompat.consultarModelo(codeFenix);
        if (!modelo) continue;
        const acessorios = [...modelo.compativel, ...modelo.baterias];
        for (const ac of acessorios) {
          // Mapeia código Fenix → sku Bling real (caso exista no catálogo)
          const blingsQueFornecemEsseFenix = await _buscarBlingPorFenix(ac.sku);
          for (const blingCandidate of blingsQueFornecemEsseFenix) {
            if (skusJaComprados.has(blingCandidate.sku_bling)) continue;
            if (!candidatos[blingCandidate.sku_bling]) {
              candidatos[blingCandidate.sku_bling] = {
                sku_bling: blingCandidate.sku_bling,
                nome: blingCandidate.descricao_bling,
                sku_fenix: ac.sku,
                motivos: [],
                fontes: new Set(),
                score: 0,
              };
            }
            candidatos[blingCandidate.sku_bling].motivos.push(
              'Acessório oficial Fenix compatível com ' + codeFenix + ' (' + ac.grupo + ')'
            );
            candidatos[blingCandidate.sku_bling].fontes.add('fabricante');
            candidatos[blingCandidate.sku_bling].score += 3;
          }
        }
      }
    }

    // 4b. Via coocorrência histórica
    const cooc = await coocorrencia.getPara(skuBling);
    if (cooc) {
      for (const item of (cooc.compraram_junto || [])) {
        if (skusJaComprados.has(item.sku)) continue;
        if (!candidatos[item.sku]) {
          candidatos[item.sku] = {
            sku_bling: item.sku,
            nome: item.descricao,
            motivos: [],
            fontes: new Set(),
            score: 0,
          };
        }
        candidatos[item.sku].motivos.push(
          Math.round(item.confianca * 100) + '% dos que compraram esse produto também levaram este (' + item.vezes + '× no mesmo pedido)'
        );
        candidatos[item.sku].fontes.add('coocorrencia');
        candidatos[item.sku].score += item.confianca * 5;
      }
      for (const item of (cooc.compraram_depois || [])) {
        if (skusJaComprados.has(item.sku)) continue;
        if (!candidatos[item.sku]) {
          candidatos[item.sku] = {
            sku_bling: item.sku,
            nome: item.descricao,
            motivos: [],
            fontes: new Set(),
            score: 0,
          };
        }
        candidatos[item.sku].motivos.push(
          Math.round(item.confianca * 100) + '% voltaram pra comprar este em média em ' + item.dias_medios + ' dias'
        );
        candidatos[item.sku].fontes.add('coocorrencia');
        candidatos[item.sku].score += item.confianca * 4;
      }
    }
  }

  // ── 5. Ordena por score e pega top N pra passar pra IA ────────
  const shortlist = Object.values(candidatos)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxSugestoes * 3); // dá margem pra IA escolher

  if (!shortlist.length) {
    return { sugestoes: [], contexto: { motivo: 'Sem candidatos após cruzar compat + coocorrência' }, avisos };
  }

  // ── 6. Chama Claude pra ranquear + gerar pitch ────────────────
  let ranked = shortlist;
  try {
    ranked = await _rankearComIA({
      account, orderFoco, orders, shortlist, contextoExtra, maxSugestoes,
    });
  } catch (e) {
    avisos.push('IA falhou (' + e.message + '), usando ranking heurístico');
    ranked = shortlist.slice(0, maxSugestoes).map(c => ({
      ...c, fontes: [...c.fontes],
      pitch: 'Olá ' + (account.nome || 'cliente') + '! Vi que você comprou algo compatível — quer conhecer ' + (c.nome || c.sku_bling) + '?',
      confianca: Math.min(1, c.score / 10),
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
    },
    avisos,
  };
}

// ── Helper: dado um código Fenix, acha SKUs Bling que o representam ─
// (via bling-fenix-map, o inverso do resolverSku).
async function _buscarBlingPorFenix(codeFenix) {
  const map = await blingFenixMap.carregar();
  const out = [];
  for (const [skuBling, m] of Object.entries(map.mapeamentos || {})) {
    if (!m.revisado_por_humano) continue; // só usa mappings aprovados
    if ((m.fenix_codes || []).includes(codeFenix)) {
      out.push({ sku_bling: skuBling, descricao_bling: m.descricao_bling });
    }
  }
  return out;
}

// ── Helper: chama Claude com contexto estruturado ────────────────
function _rankearComIA({ account, orderFoco, orders, shortlist, contextoExtra, maxSugestoes }) {
  const historico = orders.slice(0, 10).map(o => ({
    data: o.data_pedido,
    valor: o.valor_total,
    itens: (o.itens || []).map(i => i.descricao || i.sku).slice(0, 5),
  }));

  const prompt = `Você é um assistente comercial da Pro Hunters (loja brasileira de armas, munições e acessórios táticos). Ajuda o vendedor a decidir qual próxima venda oferecer a um cliente específico.

# CLIENTE
Nome: ${account.nome}
${orderFoco ? `Fez COMPRA RECENTE em ${orderFoco.data_pedido} de R$ ${orderFoco.valor_total || '?'} — foco na sugestão pós-venda:\n${(orderFoco.itens||[]).map(i => '  - ' + (i.descricao || i.sku) + ' (qtd ' + i.quantidade + ')').join('\n')}` : `Análise de REATIVAÇÃO (sem pedido específico). Histórico:`}

# HISTÓRICO DE COMPRAS (últimos 10)
${JSON.stringify(historico, null, 2)}

# CANDIDATOS A SUGERIR (já filtrados: cliente NÃO tem esses ainda)
${JSON.stringify(shortlist.map(c => ({
  sku_bling: c.sku_bling,
  nome: c.nome,
  sku_fenix: c.sku_fenix,
  motivos: c.motivos,
  fontes: [...c.fontes],
})), null, 2)}

${contextoExtra ? '# CONTEXTO EXTRA\n' + JSON.stringify(contextoExtra, null, 2) + '\n' : ''}

# TAREFA
Escolha as ${maxSugestoes} MELHORES sugestões dessa lista (não invente SKUs — use APENAS os da lista acima). Ordene por probabilidade real de conversão (mais provável primeiro).

Para cada uma:
- \`sku_bling\`: EXATO da lista acima
- \`nome\`: nome do produto
- \`sku_fenix\`: se aplicável
- \`motivo\`: 1 frase curta em PT explicando por que fará sentido pra esse cliente específico (mencione algo do histórico dele quando possível)
- \`confianca\`: 0.0 a 1.0 (chance real de fechar)
- \`fonte\`: "fabricante" / "coocorrencia" / "mista"
- \`pitch\`: mensagem pronta pra WhatsApp, tom informal-profissional, começando com "Oi ${account.nome ? account.nome.split(' ')[0] : 'cliente'}", máximo 3 linhas, mencionando o produto que ele comprou e por que essa sugestão faz sentido

# FORMATO DE RESPOSTA
JSON válido, nada antes/depois:
{
  "sugestoes": [
    { "sku_bling": "...", "nome": "...", "sku_fenix": "...", "motivo": "...", "confianca": 0.85, "fonte": "fabricante", "pitch": "Oi ..." }
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
      timeout: 40000,
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
