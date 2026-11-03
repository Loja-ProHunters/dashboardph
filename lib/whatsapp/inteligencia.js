// lib/whatsapp/inteligencia.js
// Engine de inteligência para análise de conversas WhatsApp.
// Calcula métricas (tempo de resposta, volume, conversas iniciadas)
// e roda análise semanal com IA (Claude API) usando metodologias
// de vendas consultivas (SPIN Selling, Challenger Sale).
//
// Visível apenas para admin/gerência/direção.

const { getClient } = require('../supabaseClient');
const config = require('../../config');

// ── Config ──────────────────────────────────────────────────────

// Modelo rápido e barato pra análise semanal (evita timeout Vercel 10s).
// Haiku 4.5 é a versão atual da família Haiku — a chave da conta tem acesso aos
// modelos 4.x (o resto do app usa opus-4-6). O antigo claude-3-5-haiku-20241022
// retornava 404 (a chave não tem acesso a ele). Pode ser trocado via env.
const MODELO_ANALISE = process.env.WHATSAPP_ANALISE_MODEL || 'claude-haiku-4-5';
const MAX_CONVERSAS_ANALISE = 25;   // top 25 conversas mais ativas
const MAX_MSGS_POR_CONVERSA  = 15;  // últimas 15 msgs de cada
const MIN_MSGS_POR_CONVERSA  = 3;   // ignora conversas com < 3 msgs

// Mapeamento instância Evolution → vendedor
// Adicionar aqui conforme conectar novos vendedores
const INSTANCIAS_VENDEDORES = {
  'CRM_prohunters_enzo': { nome: 'Pedro Dickmann', id: 'dickmann' },
  'crm_prohunters_enzo_real': { nome: 'Enzo Boschetto', id: 'boschetto' },
  'crm_prohunters_wesley': { nome: 'Wesley Mathias', id: 'mathias' },
};

// ── System Prompt ───────────────────────────────────────────────

const SYSTEM_PROMPT = `Você é um consultor especialista em vendas consultivas para uma loja de artigos de caça, tiro esportivo e pesca (Pro Hunters). Sua função é analisar conversas de WhatsApp entre vendedores e clientes e gerar um relatório executivo semanal.

METODOLOGIAS DE REFERÊNCIA:

1. SPIN Selling (Neil Rackham):
   - Situation: perguntas sobre contexto do cliente (o que pratica, que armas tem)
   - Problem: identificar dores (arma pesada, mira imprecisa, falta equipamento)
   - Implication: consequências do problema (perda de precisão, desconforto)
   - Need-payoff: mostrar o valor da solução (com essa óptica, seus grupos vão fechar)

2. Challenger Sale:
   - Teach: ensinar algo novo ao cliente (sabia que esse calibre tem melhor balística?)
   - Tailor: personalizar a abordagem (para caça de javali, o ideal é...)
   - Take Control: conduzir a negociação com segurança

3. Boas Práticas de Vendas Consultivas:
   - Diagnóstico ANTES de prescrição (entender antes de oferecer)
   - Escuta ativa (retomar o que o cliente disse)
   - Construção de valor (não baixar preço, mostrar benefício)
   - Urgência legítima (estoque limitado, promoção real)
   - Follow-up consistente (não deixar cliente esfriar)

CONTEXTO DO NEGÓCIO Pro Hunters:
- Produtos: armas de fogo, munições, ópticas, acessórios, equipamentos táticos
- Clientes: atiradores esportivos, caçadores, colecionadores, forças de segurança
- Ticket médio alto — venda consultiva é ESSENCIAL
- Cross-sell/upsell é chave: quem compra arma precisa de munição, óptica, suporte, case, coldre
- Processo burocrático (CR, guia de tráfego) — vendedor precisa orientar

CRITÉRIOS DE AVALIAÇÃO (peso na nota):

1. DIAGNÓSTICO (25%): Faz perguntas antes de oferecer? Entende a necessidade real?
2. ARGUMENTAÇÃO (20%): Usa benefícios, não só features? Compara com propriedade?
3. COMUNICAÇÃO (15%): Tom profissional? Clareza? Erros que prejudicam credibilidade?
4. TEMPO DE RESPOSTA (15%): Responde rápido? Não deixa cliente esperando horas?
5. OPORTUNIDADES (15%): Identifica cross-sell? Sugere complementos? Aproveita upsell?
6. FECHAMENTO (10%): Tenta fechar? Cria urgência? Faz follow-up?

ALERTAS CRÍTICOS (destacar sempre que encontrar):
- Vendedor mente sobre estoque/prazo
- Vendedor fala mal de concorrente de forma antiética
- Vendedor ignora cliente por horas/dias sem justificativa
- Vendedor perde venda por falta de follow-up óbvio
- Vendedor dá desconto sem necessidade (cliente nem pediu)
- Vendedor não sabe informações técnicas básicas do produto

Responda SEMPRE em JSON válido com esta estrutura EXATA:
{
  "score_geral": <número 0.0 a 10.0>,
  "resumo": "<2-3 frases resumindo o desempenho geral da semana>",
  "pontos_fortes": ["<ponto 1>", "<ponto 2>", ...],
  "pontos_fracos": ["<ponto 1>", "<ponto 2>", ...],
  "sugestoes": [
    {"area": "<categoria>", "sugestao": "<ação específica e prática>", "prioridade": "alta|media|baixa"}
  ],
  "alertas": ["<situação grave que precisa atenção imediata — vazio se não houver>"],
  "conversas_destaque": [
    {"telefone": "<telefone>", "tipo": "positivo|negativo", "motivo": "<por que destacar esta conversa>"}
  ]
}

LIMITES (seja conciso — não ultrapasse): no máximo 6 pontos_fortes, 6 pontos_fracos,
8 sugestoes e 8 conversas_destaque. Cada item com no máximo 1-2 frases curtas.
Responda APENAS com o JSON, sem texto antes ou depois e sem cercas de código.`;

// ── Métricas ────────────────────────────────────────────────────

async function calcularMetricas(instancia, de, ate) {
  const sb = getClient();

  let query = sb
    .from('whatsapp_mensagens')
    .select('telefone, from_me, timestamp, tipo, push_name')
    .order('timestamp', { ascending: true });

  if (instancia) query = query.eq('instancia', instancia);
  if (de)        query = query.gte('timestamp', de);
  if (ate)       query = query.lte('timestamp', ate);

  const { data: msgs, error } = await query;
  if (error) throw error;

  const mensagens = msgs || [];
  if (mensagens.length === 0) {
    return {
      total_mensagens: 0, recebidas: 0, enviadas: 0,
      conversas_total: 0, conversas_iniciadas: 0,
      tempo_resposta: { medio_minutos: null, mediano_minutos: null, distribuicao: {}, amostras: 0 },
      msgs_por_dia: 0, dias_ativos: 0,
    };
  }

  // Agrupa por telefone
  const porTelefone = {};
  for (const m of mensagens) {
    if (!porTelefone[m.telefone]) porTelefone[m.telefone] = [];
    porTelefone[m.telefone].push(m);
  }

  const totalConversas  = Object.keys(porTelefone).length;
  const recebidas       = mensagens.filter(m => !m.from_me).length;
  const enviadas        = mensagens.filter(m =>  m.from_me).length;

  // Conversas iniciadas pelo vendedor
  let conversasIniciadas = 0;
  for (const arr of Object.values(porTelefone)) {
    if (arr[0] && arr[0].from_me) conversasIniciadas++;
  }

  // Tempo de resposta: intervalo entre msg do cliente e próxima do vendedor
  const temposResposta = [];
  for (const convMsgs of Object.values(porTelefone)) {
    for (let i = 0; i < convMsgs.length - 1; i++) {
      if (!convMsgs[i].from_me && convMsgs[i + 1] && convMsgs[i + 1].from_me) {
        const tCli  = new Date(convMsgs[i].timestamp).getTime();
        const tVend = new Date(convMsgs[i + 1].timestamp).getTime();
        const diffMin = (tVend - tCli) / (1000 * 60);
        // Ignora > 24h (provavelmente contexto diferente)
        if (diffMin > 0 && diffMin < 1440) {
          temposResposta.push(diffMin);
        }
      }
    }
  }

  const sorted = [...temposResposta].sort((a, b) => a - b);
  const tempoMedio   = sorted.length > 0
    ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null;
  const tempoMediano = sorted.length > 0
    ? sorted[Math.floor(sorted.length / 2)] : null;

  // Distribuição de tempos
  const distribuicao = {
    ate_5min:   sorted.filter(t => t <= 5).length,
    ate_15min:  sorted.filter(t => t > 5  && t <= 15).length,
    ate_30min:  sorted.filter(t => t > 15 && t <= 30).length,
    ate_1h:     sorted.filter(t => t > 30 && t <= 60).length,
    ate_4h:     sorted.filter(t => t > 60 && t <= 240).length,
    mais_4h:    sorted.filter(t => t > 240).length,
  };

  // Msgs por dia
  const diasUnicos = new Set(mensagens.map(m => m.timestamp.slice(0, 10))).size;
  const msgsPorDia = diasUnicos > 0 ? mensagens.length / diasUnicos : 0;

  return {
    total_mensagens:     mensagens.length,
    recebidas,
    enviadas,
    conversas_total:     totalConversas,
    conversas_iniciadas: conversasIniciadas,
    tempo_resposta: {
      medio_minutos:   tempoMedio   ? Math.round(tempoMedio   * 10) / 10 : null,
      mediano_minutos: tempoMediano ? Math.round(tempoMediano * 10) / 10 : null,
      distribuicao,
      amostras: sorted.length,
    },
    msgs_por_dia: Math.round(msgsPorDia * 10) / 10,
    dias_ativos:  diasUnicos,
  };
}

// ── Condensar conversas pra IA ──────────────────────────────────

async function _condensarConversas(instancia, de, ate) {
  const sb = getClient();

  let query = sb
    .from('whatsapp_mensagens')
    .select('telefone, from_me, texto, tipo, timestamp, push_name')
    .order('timestamp', { ascending: true });

  if (instancia) query = query.eq('instancia', instancia);
  if (de)        query = query.gte('timestamp', de);
  if (ate)       query = query.lte('timestamp', ate);

  const { data: msgs, error } = await query;
  if (error) throw error;

  // Agrupa por telefone
  const porTelefone = {};
  for (const m of (msgs || [])) {
    if (!porTelefone[m.telefone]) porTelefone[m.telefone] = [];
    porTelefone[m.telefone].push(m);
  }

  // Filtra: só conversas com >= MIN msgs e pelo menos 1 texto
  const conversasRelevantes = Object.entries(porTelefone)
    .filter(([_, arr]) => arr.length >= MIN_MSGS_POR_CONVERSA && arr.some(m => m.texto))
    .sort((a, b) => b[1].length - a[1].length)   // mais ativas primeiro
    .slice(0, MAX_CONVERSAS_ANALISE);

  // Monta texto condensado
  const resumos = [];
  for (const [tel, convMsgs] of conversasRelevantes) {
    const nome    = convMsgs.find(m => m.push_name)?.push_name || 'Desconhecido';
    const ultimas = convMsgs.slice(-MAX_MSGS_POR_CONVERSA);
    const linhas  = ultimas
      .filter(m => m.texto)
      .map(m => {
        const quem = m.from_me ? 'VENDEDOR' : 'CLIENTE';
        const hora = m.timestamp.slice(0, 16).replace('T', ' ');
        return `[${hora}] ${quem}: ${m.texto.slice(0, 300)}`;
      });

    if (linhas.length > 0) {
      resumos.push(
        `--- Conversa com ${nome} (${tel}) | ${convMsgs.length} msgs total ---\n` +
        linhas.join('\n')
      );
    }
  }

  return {
    texto:               resumos.join('\n\n'),
    totalConversas:      Object.keys(porTelefone).length,
    conversasAnalisadas: conversasRelevantes.length,
  };
}

// ── Análise semanal com IA ──────────────────────────────────────

// ── Parse tolerante da resposta da IA ───────────────────────────
// A IA devolve JSON, mas às vezes vem (a) cercado de ```json, (b) truncado no
// meio quando bate o max_tokens, ou (c) com algum caractere solto. Se o parse
// estrito falha, o card ficava com o texto cru e score "–". Aqui tentamos em
// camadas: parse direto → reparo de truncamento (fecha strings/colchetes/chaves
// abertos) → resgate por regex dos campos principais. Nunca devolve null.
function _fecharJsonTruncado(s) {
  let inStr = false, esc = false;
  const stack = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') stack.push(c);
    else if (c === '}') { if (stack[stack.length - 1] === '{') stack.pop(); }
    else if (c === ']') { if (stack[stack.length - 1] === '[') stack.pop(); }
  }
  let out = s;
  if (inStr) out += '"';                        // fecha string aberta
  out = out.replace(/\s*$/, '');
  out = out.replace(/,\s*$/, '');               // vírgula pendente
  out = out.replace(/:\s*$/, ': null');         // chave sem valor
  out = out.replace(/,\s*"[^"]*"\s*$/, '');     // chave solta sem ":"
  for (let i = stack.length - 1; i >= 0; i--) out += (stack[i] === '{' ? '}' : ']');
  return out;
}

function _resgatarCampos(txt) {
  const out = { score_geral: null, resumo: null, pontos_fortes: [], pontos_fracos: [],
                sugestoes: [], alertas: [], conversas_destaque: [] };
  const mScore = txt.match(/"score_geral"\s*:\s*"?([\d]+(?:[.,][\d]+)?)"?/);
  if (mScore) { const n = parseFloat(mScore[1].replace(',', '.')); if (!isNaN(n)) out.score_geral = n; }
  const mResumo = txt.match(/"resumo"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (mResumo) out.resumo = mResumo[1].replace(/\\"/g, '"').replace(/\\n/g, ' ').trim();
  for (const campo of ['pontos_fortes', 'pontos_fracos', 'alertas']) {
    const m = txt.match(new RegExp('"' + campo + '"\\s*:\\s*\\[([\\s\\S]*?)\\]'));
    if (m) {
      const itens = m[1].match(/"((?:[^"\\]|\\.)*)"/g);
      if (itens) out[campo] = itens.map(x => x.slice(1, -1).replace(/\\"/g, '"')).filter(Boolean);
    }
  }
  return out;
}

function _parseAnaliseTolerante(textoResp) {
  let s = String(textoResp || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const ini = s.indexOf('{');
  if (ini > 0) s = s.slice(ini);
  else if (ini < 0) return { analise: _resgatarCampos(textoResp), via: 'sem_json' };
  // 1) parse direto (corta no último "}")
  try {
    const fim = s.lastIndexOf('}');
    if (fim > 0) return { analise: JSON.parse(s.slice(0, fim + 1)), via: 'direto' };
  } catch (_) {}
  // 2) reparo de truncamento
  try {
    return { analise: JSON.parse(_fecharJsonTruncado(s)), via: 'reparo' };
  } catch (_) {}
  // 3) resgate por regex (garante score + resumo no mínimo)
  return { analise: _resgatarCampos(textoResp), via: 'resgate' };
}

async function analisarVendedor(instancia, vendedorNome, de, ate) {
  // 1. Condensar conversas
  const { texto, totalConversas, conversasAnalisadas } =
    await _condensarConversas(instancia, de, ate);

  if (conversasAnalisadas === 0) {
    // Salva registro vazio pra não rodar de novo na mesma semana
    const sb = getClient();
    const vazio = {
      instancia, vendedor: vendedorNome, periodo_de: de, periodo_ate: ate,
      tipo: 'semanal', score_geral: null,
      resumo: 'Sem conversas suficientes para análise no período.',
      pontos_fortes: [], pontos_fracos: [], sugestoes: [],
      alertas: [], conversas_destaque: [],
      metricas: {}, conversas_analisadas: 0, analise_completa: null,
    };
    const { data: ins } = await sb.from('whatsapp_analises').insert(vazio).select().single();
    return ins || vazio;
  }

  // 2. Métricas numéricas
  const metricas = await calcularMetricas(instancia, de, ate);

  // 3. Prompt pro Claude
  const userPrompt =
    `Analise as conversas de WhatsApp do vendedor ${vendedorNome} ` +
    `no período de ${de.slice(0, 10)} a ${ate.slice(0, 10)}.\n\n` +
    `MÉTRICAS DO PERÍODO:\n` +
    `- Total de mensagens: ${metricas.total_mensagens}\n` +
    `- Recebidas: ${metricas.recebidas} | Enviadas: ${metricas.enviadas}\n` +
    `- Conversas: ${metricas.conversas_total} (${metricas.conversas_iniciadas} iniciadas pelo vendedor)\n` +
    `- Tempo médio de resposta: ${metricas.tempo_resposta.medio_minutos ?? 'N/A'} min\n` +
    `- Tempo mediano de resposta: ${metricas.tempo_resposta.mediano_minutos ?? 'N/A'} min\n` +
    `- Respostas em até 5 min: ${metricas.tempo_resposta.distribuicao.ate_5min || 0}\n` +
    `- Respostas > 4h: ${metricas.tempo_resposta.distribuicao.mais_4h || 0}\n\n` +
    `CONVERSAS ANALISADAS (${conversasAnalisadas} de ${totalConversas} total):\n\n` +
    texto;

  const apiKey = config.anthropicApiKey;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY não configurada');

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':     'application/json',
      'x-api-key':        apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:      MODELO_ANALISE,
      // 8000: com 25 conversas o JSON (resumo + pontos + sugestões + destaques)
      // às vezes passava de 4000 tokens e era cortado no meio — o parse falhava
      // e o score vinha null (card mostrava o JSON cru). Teto maior + parse
      // tolerante + limites de tamanho no prompt eliminam o truncamento. Haiku
      // gera só o necessário, então o teto alto não aumenta custo na prática.
      max_tokens: 8000,
      system:     SYSTEM_PROMPT,
      messages:   [{ role: 'user', content: userPrompt }],
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Anthropic API ${resp.status}: ${errText.slice(0, 300)}`);
  }

  const result       = await resp.json();
  const textoResp    = (result.content?.[0]?.text || '').trim();
  // Flag de corte do modelo (truncou por max_tokens) — útil pra log/diagnóstico.
  const truncou      = result.stop_reason === 'max_tokens';

  // Parse tolerante (direto → reparo de truncamento → resgate por regex).
  const { analise, via: parseVia } = _parseAnaliseTolerante(textoResp);
  // Normaliza: garante os campos esperados mesmo quando o resgate recuperou só parte.
  analise.pontos_fortes      = analise.pontos_fortes      || [];
  analise.pontos_fracos      = analise.pontos_fracos      || [];
  analise.sugestoes          = analise.sugestoes          || [];
  analise.alertas            = analise.alertas            || [];
  analise.conversas_destaque = analise.conversas_destaque || [];
  // Garante score numérico (modelo às vezes devolve "7.5" como texto)
  if (typeof analise.score_geral === 'string') {
    const n = parseFloat(analise.score_geral.replace(',', '.'));
    analise.score_geral = isNaN(n) ? null : n;
  }
  if (parseVia !== 'direto' || truncou) {
    console.warn('[WA-INTEL] parse via "' + parseVia + '"' + (truncou ? ' (modelo truncou em max_tokens)' : '') +
      ' — vendedor=' + vendedorNome + ' score=' + analise.score_geral);
  }

  // 4. Salva no Supabase
  const sb = getClient();
  const registro = {
    instancia,
    vendedor:              vendedorNome,
    periodo_de:            de,
    periodo_ate:           ate,
    tipo:                  'semanal',
    score_geral:           analise.score_geral   ?? null,
    resumo:                analise.resumo         || null,
    pontos_fortes:         analise.pontos_fortes  || [],
    pontos_fracos:         analise.pontos_fracos  || [],
    sugestoes:             analise.sugestoes      || [],
    alertas:               analise.alertas        || [],
    conversas_destaque:    analise.conversas_destaque || [],
    metricas,
    conversas_analisadas:  conversasAnalisadas,
    analise_completa:      analise,
  };

  const { data: inserted, error: errIns } = await sb
    .from('whatsapp_analises')
    .insert(registro)
    .select()
    .single();
  if (errIns) throw errIns;

  return inserted;
}

// ── Consultas ───────────────────────────────────────────────────

async function obterUltimaAnalise(vendedor) {
  const sb = getClient();
  const { data, error } = await sb
    .from('whatsapp_analises')
    .select('*')
    .eq('vendedor', vendedor)
    .order('criado_em', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function listarAnalises(opts = {}) {
  const sb = getClient();
  const { vendedor, limite = 20, offset = 0 } = opts;

  let query = sb
    .from('whatsapp_analises')
    .select('id, instancia, vendedor, periodo_de, periodo_ate, score_geral, resumo, conversas_analisadas, criado_em')
    .order('criado_em', { ascending: false })
    .range(offset, offset + limite - 1);

  if (vendedor) query = query.eq('vendedor', vendedor);

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

async function obterAnalise(id) {
  const sb = getClient();
  const { data, error } = await sb
    .from('whatsapp_analises')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

// ── Exports ─────────────────────────────────────────────────────

module.exports = {
  calcularMetricas,
  analisarVendedor,
  obterUltimaAnalise,
  obterAnalise,
  listarAnalises,
  INSTANCIAS_VENDEDORES,
};
