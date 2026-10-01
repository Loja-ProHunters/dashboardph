// lib/garantias.js
// Módulo de Garantias / Trocas / Devoluções.
//
// Operadores: admin + auxiliar (Maria). Checagem de permissão no api/index.js.
//
// Fluxo:
//   1. Garantia criada (manual pelo operador OU via webhook Tally — Fase 2).
//   2. Sistema roda triagem CDC → gera sugestao_sistema + justificativa.
//   3. Operador abre a garantia, revisa, aprova a sugestao ou faz override.
//   4. Status muda: aberto → em_analise → aguardando_cliente → resolvido.
//   5. Operador registra o resultado final (troca / restituicao / negada).
//
// Base legal da triagem: CDC Art. 18 (vícios), Art. 26 (prazos decadenciais),
// Art. 49 (arrependimento). Pro Hunters não tem assistência técnica —
// resolução comercial é só troca OU devolução integral.

const { getFile, saveFile } = require('./githubStore');
const crypto = require('crypto');

const FILE_PATH = 'garantias.json';

const STATUS = ['aberto', 'em_analise', 'aguardando_cliente', 'resolvido'];
const RESULTADOS = ['troca', 'restituicao', 'negada'];
const SUGESTOES = [
  'procedente_troca',
  'procedente_restituicao',
  'improcedente_prazo',
  'improcedente_mau_uso',
  'improcedente_sem_direito',
  'analise_manual',
];

// ────────────────────────────────────────────────────────────────────
// Estoque de garantias (fluxo pós-aprovação, logística do produto físico)
// ────────────────────────────────────────────────────────────────────
// Status do PRODUTO FÍSICO (paralelo ao status da garantia):
//   nao_solicitado      → garantia negada ou restituição sem retorno
//   aguardando_chegada  → operador pediu o cliente pra enviar o produto
//   recebido_loja       → produto chegou na loja, etiqueta impressa e colada
//   enviado_fabricante  → produto enviado pro fabricante no lote
//   resolvido_fabricante → fabricante respondeu (troca, crédito, reparo ou negada)
const STATUS_PRODUTO = [
  'nao_solicitado',
  'aguardando_chegada',
  'recebido_loja',
  'enviado_fabricante',
  'resolvido_fabricante',
];

// Resposta do fabricante no fechamento do ciclo
const RESOLUCOES_FABRICANTE = [
  'troca_recebida', // fabricante mandou produto novo
  'credito',        // fabricante deu crédito/bonificação
  'reparo_recebido',// fabricante consertou e devolveu
  'negada',         // fabricante negou (dano por uso, fora de garantia, etc.)
];

// Canal de contato com o fabricante (operador escolhe)
const CANAIS_FABRICANTE = ['email', 'portal', 'whatsapp', 'telefone', 'outro'];

let _cache = null;
let _cacheAt = 0;
const CACHE_MS = 10 * 1000;

function uuid() {
  const b = crypto.randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  return b.toString('hex').replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
}

async function _load() {
  const now = Date.now();
  if (_cache && (now - _cacheAt) < CACHE_MS) return _cache;
  let data = {};
  try {
    const raw = await getFile(FILE_PATH);
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') data = parsed;
  } catch (e) { /* arquivo novo */ }
  _cache = data;
  _cacheAt = now;
  return data;
}

async function _save(data) {
  await saveFile(FILE_PATH, JSON.stringify(data, null, 2), 'Atualiza garantias');
  _cache = data;
  _cacheAt = Date.now();
}

// ────────────────────────────────────────────────────────────────────
// MOTOR DE TRIAGEM CDC
// ────────────────────────────────────────────────────────────────────
// Entrada: campos coletados do cliente (formulário + perguntas do wizard).
// Saída: { sugestao, justificativa, score_confianca }
//
// Score de confiança:
//   alta  = decisão clara pela lei (fora de prazo, arrependimento presencial)
//   media = decisão clara pela evidência (queda/modificação com registro)
//   baixa = análise manual (operador decide)
//
// Prazos CDC Art. 26:
//   - não-durável: 30 dias
//   - durável:     90 dias
//   - vício oculto: conta a partir de quando o defeito apareceu
//
// Arrependimento CDC Art. 49:
//   - só vale compra à distância (online/marketplace)
//   - prazo de 7 dias corridos a partir do recebimento

function _diffDias(dataFim, dataInicio) {
  if (!dataFim || !dataInicio) return null;
  try {
    const a = new Date(dataFim);
    const b = new Date(dataInicio);
    const ms = a.getTime() - b.getTime();
    return Math.floor(ms / (1000 * 60 * 60 * 24));
  } catch (e) { return null; }
}

function triar(dados) {
  const {
    tipo_produto,            // 'durável' | 'não_durável'
    data_recebimento,        // ISO ou YYYY-MM-DD
    data_percebido_problema, // ISO ou YYYY-MM-DD
    tipo_vicio,              // 'aparente' | 'oculto'
    forma_compra,            // 'presencial' | 'online' | 'marketplace'
    eh_arrependimento,       // bool
    teve_queda_impacto_agua, // 'sim' | 'nao' | 'nao_sei'
    teve_modificacao,        // 'sim' | 'nao'
    tem_evidencia,           // bool — foto/vídeo anexado
    preferencia_cliente,     // 'troca' | 'restituicao' | 'operador_decide'
    _override,               // { sugestao, justificativa, score_confianca } — pular toda a lógica
  } = dados || {};

  // Override explícito (ex: cliente marcou "Funcionamento Normal" no Tally) —
  // o parser já tomou a decisão, confirma e devolve.
  if (_override && _override.sugestao) {
    return {
      sugestao: _override.sugestao,
      justificativa: _override.justificativa || '',
      score_confianca: _override.score_confianca || 'baixa',
    };
  }

  const hoje = new Date().toISOString().slice(0, 10);
  const diasDesdeRecebimento = _diffDias(hoje, data_recebimento);
  const diasDesdeProblema = _diffDias(hoje, data_percebido_problema);

  // ── CAMINHO 1: Arrependimento ──
  if (eh_arrependimento) {
    if (forma_compra === 'presencial') {
      return {
        sugestao: 'improcedente_sem_direito',
        justificativa:
          'Pedido de arrependimento em compra presencial. CDC Art. 49 ' +
          'garante direito de arrependimento APENAS em compras à distância ' +
          '(online, telefone, catálogo). Compra feita presencialmente na ' +
          'loja não gera direito de desistência.',
        score_confianca: 'alta',
      };
    }
    // Compra online/marketplace → verifica prazo de 7 dias
    if (diasDesdeRecebimento != null && diasDesdeRecebimento > 7) {
      return {
        sugestao: 'improcedente_prazo',
        justificativa:
          'Pedido de arrependimento em compra à distância, mas fora do ' +
          'prazo de 7 dias previsto no CDC Art. 49 (' + diasDesdeRecebimento +
          ' dias desde o recebimento).',
        score_confianca: 'alta',
      };
    }
    return {
      sugestao: 'procedente_restituicao',
      justificativa:
        'Pedido de arrependimento em compra à distância, dentro do prazo ' +
        'de 7 dias (CDC Art. 49). Devolução integral do valor pago, ' +
        'incluindo frete.',
      score_confianca: 'alta',
    };
  }

  // ── CAMINHO 2: Vício / defeito ──
  // Primeiro: há indício forte de mau uso?
  if (teve_queda_impacto_agua === 'sim' || teve_modificacao === 'sim') {
    const motivos = [];
    if (teve_queda_impacto_agua === 'sim') motivos.push('cliente relatou queda, impacto ou exposição a água/umidade');
    if (teve_modificacao === 'sim') motivos.push('cliente relatou modificação/customização no produto');
    return {
      sugestao: 'improcedente_mau_uso',
      justificativa:
        'Indício de mau uso: ' + motivos.join(' e ') + '. CDC Art. 18 §6º ' +
        'exclui vícios decorrentes de uso inadequado ou alteração do ' +
        'produto pelo consumidor. Recomenda-se laudo técnico se o ' +
        'cliente contestar.',
      score_confianca: 'media',
    };
  }

  // Verifica prazo decadencial (Art. 26)
  const prazoMax = (tipo_produto === 'não_durável') ? 30 : 90;
  let diasPraContar = null;
  let referenciaPrazo = '';
  if (tipo_vicio === 'oculto' && diasDesdeProblema != null) {
    diasPraContar = diasDesdeProblema;
    referenciaPrazo = 'da data em que o defeito apareceu (vício oculto)';
  } else if (diasDesdeRecebimento != null) {
    diasPraContar = diasDesdeRecebimento;
    referenciaPrazo = 'do recebimento (vício aparente)';
  }

  if (diasPraContar != null && diasPraContar > prazoMax) {
    return {
      sugestao: 'improcedente_prazo',
      justificativa:
        'Fora do prazo decadencial do CDC Art. 26 (' + prazoMax + ' dias ' +
        'para produto ' + (tipo_produto || 'durável') + '). Já se passaram ' +
        diasPraContar + ' dias ' + referenciaPrazo + '.',
      score_confianca: 'alta',
    };
  }

  // Dentro do prazo, sem indício de mau uso → procedente OU análise manual
  if (!tem_evidencia) {
    return {
      sugestao: 'analise_manual',
      justificativa:
        'Dentro do prazo legal e sem indício claro de mau uso, mas o ' +
        'cliente não anexou foto/vídeo do defeito. Solicitar evidência ' +
        'antes de decidir ou avaliar troca mediante inspeção presencial.',
      score_confianca: 'baixa',
    };
  }

  // Preferência do cliente orienta troca vs restituição
  if (preferencia_cliente === 'troca') {
    return {
      sugestao: 'procedente_troca',
      justificativa:
        'Dentro do prazo legal (CDC Art. 26), sem indício de mau uso, com ' +
        'evidência anexada. Cliente preferiu troca por produto igual novo ' +
        '(CDC Art. 18 §1º I).',
      score_confianca: 'media',
    };
  }
  if (preferencia_cliente === 'restituicao') {
    return {
      sugestao: 'procedente_restituicao',
      justificativa:
        'Dentro do prazo legal (CDC Art. 26), sem indício de mau uso, com ' +
        'evidência anexada. Cliente preferiu devolução integral do valor ' +
        '(CDC Art. 18 §1º II).',
      score_confianca: 'media',
    };
  }
  // Operador decide
  return {
    sugestao: 'analise_manual',
    justificativa:
      'Dentro do prazo legal, com evidência, sem indício de mau uso. ' +
      'Cliente deixou a resolução a critério da Pro Hunters — operador ' +
      'escolhe entre troca ou devolução conforme disponibilidade de ' +
      'estoque e política interna.',
    score_confianca: 'baixa',
  };
}

// ────────────────────────────────────────────────────────────────────
// CRUD
// ────────────────────────────────────────────────────────────────────

async function criar({ fonte, cliente, pedido, problema, triagemInput, preferencia_cliente, criado_por }) {
  if (!cliente || !cliente.nome) throw new Error('Nome do cliente obrigatório');
  if (!cliente.cpf_cnpj) throw new Error('CPF/CNPJ obrigatório');
  if (!problema || !problema.descricao_cliente) throw new Error('Descrição do problema obrigatória');
  if (!criado_por) throw new Error('Operador criador obrigatório');

  const fila = await _load();
  const id = uuid();
  const now = new Date().toISOString();

  // Roda a triagem automática (se temos input suficiente)
  let avaliacao = null;
  if (triagemInput && typeof triagemInput === 'object') {
    const r = triar({ ...triagemInput, preferencia_cliente });
    avaliacao = {
      ...triagemInput,
      preferencia_cliente: preferencia_cliente || null,
      sugestao_sistema: r.sugestao,
      justificativa_sistema: r.justificativa,
      score_confianca: r.score_confianca,
      calculado_em: now,
    };
  }

  fila[id] = {
    id,
    fonte: fonte || 'manual', // 'manual' | 'tally_webhook'
    cliente: {
      nome: String(cliente.nome).trim(),
      cpf_cnpj: String(cliente.cpf_cnpj).trim(),
      whatsapp: cliente.whatsapp || null,
      email: cliente.email || null,
      cidade: cliente.cidade || null,
      uf: cliente.uf || null,
      endereco: cliente.endereco || null,
      cep: cliente.cep || null,
    },
    pedido: {
      nf: (pedido && pedido.nf) || null,
      data_compra: (pedido && pedido.data_compra) || null,
      data_recebimento: (pedido && pedido.data_recebimento) || null,
      nome_produto: (pedido && pedido.nome_produto) || null,
      marca: (pedido && pedido.marca) || null,
      modelo: (pedido && pedido.modelo) || null,
      numero_serie: (pedido && pedido.numero_serie) || null,
      bling_pedido_id: (pedido && pedido.bling_pedido_id) || null,
      vendedor_bling: (pedido && pedido.vendedor_bling) || null,
      valor_pedido: (pedido && pedido.valor_pedido) || null,
    },
    problema: {
      descricao_cliente: String(problema.descricao_cliente || '').trim(),
      data_percebido_problema: problema.data_percebido_problema || null,
      chegou_defeito_ou_depois: problema.chegou_defeito_ou_depois || null,
      motivo_troca_devolucao: problema.motivo_troca_devolucao || null,
      uploads: Array.isArray(problema.uploads) ? problema.uploads : [], // [{tipo, url}]
    },
    preferencia_cliente: preferencia_cliente || null,
    avaliacao_cdc: avaliacao, // null se não rodou triagem ainda
    decisao_operador: null,   // { valor, justificativa, por, em }
    status: 'aberto',
    resultado: null,          // 'troca' | 'restituicao' | 'negada'
    // Estoque de garantias — rastreio do produto FÍSICO (paralelo ao atendimento).
    // Fica como 'nao_solicitado' até a garantia ser aprovada e o operador pedir
    // o produto. Se a decisão final é negada ou restituição sem retorno, nunca
    // sai de 'nao_solicitado' — não há produto físico pra rastrear.
    produto_fisico: {
      status: 'nao_solicitado',
      rastreio_entrada: null,       // código de postagem reversa (cliente → loja)
      aguardando_desde: null,
      recebido_em: null,
      recebido_por: null,
      localizacao_loja: null,       // ex: "Prateleira G-2, Caixa 5"
      etiqueta_impressa_em: null,
      etiqueta_impressa_por: null,
      envio_fabricante: null,       // { data, canal, contato, protocolo_rma, rastreio_saida, nota, por }
      resolucao_fabricante: null,   // { data, tipo, nota, por }
    },
    criado_por: String(criado_por).toLowerCase(),
    criado_em: now,
    atualizado_em: now,
    historico: [{ ts: now, acao: 'criada', por: String(criado_por).toLowerCase() }],
  };

  await _save(fila);
  return fila[id];
}

// Lista com filtros opcionais.
async function listar({ status, operador, limite } = {}) {
  const fila = await _load();
  let arr = Object.values(fila);
  if (status) arr = arr.filter(g => g.status === status);
  if (operador) arr = arr.filter(g => g.criado_por === String(operador).toLowerCase());
  // Mais recentes primeiro, mas pendentes (aberto/em_analise/aguardando) antes de resolvidos.
  const ordem = { aberto: 0, em_analise: 1, aguardando_cliente: 2, resolvido: 3 };
  arr.sort((a, b) => {
    const oa = ordem[a.status] != null ? ordem[a.status] : 9;
    const ob = ordem[b.status] != null ? ordem[b.status] : 9;
    if (oa !== ob) return oa - ob;
    return String(b.criado_em).localeCompare(String(a.criado_em));
  });
  if (limite) arr = arr.slice(0, Number(limite));
  return arr;
}

async function obter(id) {
  const fila = await _load();
  const g = fila[id];
  if (!g) throw new Error('Garantia não encontrada');
  return g;
}

// Atualiza status (aberto → em_analise → aguardando_cliente → resolvido).
async function mudarStatus(id, novoStatus, actor, nota) {
  if (!STATUS.includes(novoStatus)) throw new Error('Status inválido');
  const fila = await _load();
  const g = fila[id];
  if (!g) throw new Error('Garantia não encontrada');
  const now = new Date().toISOString();
  const anterior = g.status;
  g.status = novoStatus;
  g.atualizado_em = now;
  g.historico.push({
    ts: now,
    acao: 'status_mudou',
    por: String(actor).toLowerCase(),
    de: anterior,
    para: novoStatus,
    nota: nota ? String(nota).trim().slice(0, 500) : null,
  });
  fila[id] = g;
  await _save(fila);
  return g;
}

// Operador aprova a sugestão do sistema OU faz override.
// `valor` deve ser uma das SUGESTOES. `justificativa` é obrigatória se divergir.
async function registrarDecisao(id, { valor, justificativa, actor }) {
  if (!SUGESTOES.includes(valor)) throw new Error('Decisão inválida');
  const fila = await _load();
  const g = fila[id];
  if (!g) throw new Error('Garantia não encontrada');
  const now = new Date().toISOString();
  const sugeriu = g.avaliacao_cdc && g.avaliacao_cdc.sugestao_sistema;
  const divergiu = sugeriu && sugeriu !== valor;
  if (divergiu && (!justificativa || !String(justificativa).trim())) {
    throw new Error('Justificativa obrigatória quando o operador diverge da sugestão do sistema.');
  }
  g.decisao_operador = {
    valor,
    justificativa: justificativa ? String(justificativa).trim().slice(0, 2000) : null,
    por: String(actor).toLowerCase(),
    em: now,
    divergiu_do_sistema: !!divergiu,
    sugestao_original: sugeriu || null,
  };
  g.atualizado_em = now;
  g.historico.push({
    ts: now,
    acao: 'decisao_registrada',
    por: String(actor).toLowerCase(),
    valor,
    divergiu: !!divergiu,
  });
  fila[id] = g;
  await _save(fila);
  return g;
}

// Marca como resolvido com o resultado final (troca / restituicao / negada).
async function resolver(id, { resultado, nota, actor }) {
  if (!RESULTADOS.includes(resultado)) throw new Error('Resultado inválido');
  const fila = await _load();
  const g = fila[id];
  if (!g) throw new Error('Garantia não encontrada');
  const now = new Date().toISOString();
  g.status = 'resolvido';
  g.resultado = resultado;
  g.atualizado_em = now;
  g.historico.push({
    ts: now,
    acao: 'resolvida',
    por: String(actor).toLowerCase(),
    resultado,
    nota: nota ? String(nota).trim().slice(0, 1000) : null,
  });
  fila[id] = g;
  await _save(fila);
  return g;
}

// Reroda a triagem — útil quando o operador complementa dados que não vieram
// no formulário (tipo_produto, forma_compra, flags de mau uso).
async function reavaliar(id, triagemInput, actor) {
  const fila = await _load();
  const g = fila[id];
  if (!g) throw new Error('Garantia não encontrada');
  const r = triar({ ...triagemInput, preferencia_cliente: g.preferencia_cliente });
  const now = new Date().toISOString();
  g.avaliacao_cdc = {
    ...triagemInput,
    preferencia_cliente: g.preferencia_cliente,
    sugestao_sistema: r.sugestao,
    justificativa_sistema: r.justificativa,
    score_confianca: r.score_confianca,
    calculado_em: now,
  };
  g.atualizado_em = now;
  g.historico.push({ ts: now, acao: 'reavaliada', por: String(actor).toLowerCase(), sugestao: r.sugestao });
  fila[id] = g;
  await _save(fila);
  return g;
}

// Conta garantias abertas/em_analise/aguardando (não resolvidas) — pra badge.
async function contarPendentes() {
  const fila = await _load();
  return Object.values(fila).filter(g =>
    g.status === 'aberto' || g.status === 'em_analise' || g.status === 'aguardando_cliente'
  ).length;
}

// ════════════════════════════════════════════════════════════════════
// ESTOQUE DE GARANTIAS — fluxo pós-aprovação do produto físico
// ════════════════════════════════════════════════════════════════════

function _ensureProdutoFisico(g) {
  if (!g.produto_fisico) {
    g.produto_fisico = {
      status: 'nao_solicitado',
      rastreio_entrada: null,
      aguardando_desde: null,
      recebido_em: null,
      recebido_por: null,
      localizacao_loja: null,
      etiqueta_impressa_em: null,
      etiqueta_impressa_por: null,
      envio_fabricante: null,
      resolucao_fabricante: null,
    };
  }
  return g;
}

// Operador pediu o produto físico pro cliente — fica aguardando chegar na loja.
// Só faz sentido se a garantia já tem decisão procedente_troca ou procedente_restituicao.
async function marcarAguardandoChegada(id, { rastreio_entrada, actor }) {
  const fila = await _load();
  const g = fila[id];
  if (!g) throw new Error('Garantia não encontrada');
  _ensureProdutoFisico(g);
  if (!g.decisao_operador) {
    throw new Error('Registre a decisão antes de solicitar o produto físico.');
  }
  const dec = g.decisao_operador.valor;
  if (dec !== 'procedente_troca' && dec !== 'procedente_restituicao') {
    throw new Error('Produto físico só é solicitado em garantias procedentes (troca/restituição).');
  }
  const now = new Date().toISOString();
  g.produto_fisico.status = 'aguardando_chegada';
  g.produto_fisico.aguardando_desde = now;
  g.produto_fisico.rastreio_entrada = rastreio_entrada ? String(rastreio_entrada).trim() : null;
  g.atualizado_em = now;
  g.historico.push({
    ts: now, acao: 'produto_solicitado',
    por: String(actor).toLowerCase(),
    rastreio: g.produto_fisico.rastreio_entrada,
  });
  fila[id] = g;
  await _save(fila);
  return g;
}

// Produto chegou na loja — operador marca localização e sistema prepara pra
// emissão de etiqueta. Também move a garantia pra 'em_analise' se ainda estava
// em 'aguardando_cliente'.
async function marcarRecebimentoLoja(id, { localizacao_loja, nota, actor }) {
  const fila = await _load();
  const g = fila[id];
  if (!g) throw new Error('Garantia não encontrada');
  _ensureProdutoFisico(g);
  if (g.produto_fisico.status !== 'aguardando_chegada') {
    throw new Error('Produto não está aguardando chegada (status atual: ' + g.produto_fisico.status + ')');
  }
  const now = new Date().toISOString();
  g.produto_fisico.status = 'recebido_loja';
  g.produto_fisico.recebido_em = now;
  g.produto_fisico.recebido_por = String(actor).toLowerCase();
  g.produto_fisico.localizacao_loja = localizacao_loja ? String(localizacao_loja).trim().slice(0, 120) : null;
  g.atualizado_em = now;
  g.historico.push({
    ts: now, acao: 'produto_recebido',
    por: String(actor).toLowerCase(),
    localizacao: g.produto_fisico.localizacao_loja,
    nota: nota ? String(nota).trim().slice(0, 500) : null,
  });
  fila[id] = g;
  await _save(fila);
  return g;
}

// Marca que a etiqueta foi gerada e impressa — não impede reimprimir, só
// deixa claro no histórico quando a primeira impressão aconteceu.
async function registrarImpressaoEtiqueta(ids, actor) {
  const fila = await _load();
  const now = new Date().toISOString();
  const arr = Array.isArray(ids) ? ids : [ids];
  for (const id of arr) {
    const g = fila[id];
    if (!g) continue;
    _ensureProdutoFisico(g);
    if (!g.produto_fisico.etiqueta_impressa_em) {
      g.produto_fisico.etiqueta_impressa_em = now;
      g.produto_fisico.etiqueta_impressa_por = String(actor).toLowerCase();
    }
    g.historico.push({ ts: now, acao: 'etiqueta_impressa', por: String(actor).toLowerCase() });
    g.atualizado_em = now;
    fila[id] = g;
  }
  await _save(fila);
  return arr.length;
}

// Lote: operador seleciona N garantias (todas com produto_fisico=recebido_loja),
// registra o envio pro fabricante (canal, contato, protocolo, rastreio).
// Varia por fabricante — operador escolhe canal e preenche o que couber.
async function registrarEnvioFabricante({ ids, canal, contato, protocolo_rma, rastreio_saida, nota, actor }) {
  if (!Array.isArray(ids) || ids.length === 0) throw new Error('Selecione pelo menos uma garantia');
  if (canal && !CANAIS_FABRICANTE.includes(canal)) throw new Error('Canal inválido');
  const fila = await _load();
  const now = new Date().toISOString();
  const envioInfo = {
    data: now,
    canal: canal || null,
    contato: contato ? String(contato).trim().slice(0, 200) : null,
    protocolo_rma: protocolo_rma ? String(protocolo_rma).trim().slice(0, 100) : null,
    rastreio_saida: rastreio_saida ? String(rastreio_saida).trim().slice(0, 100) : null,
    nota: nota ? String(nota).trim().slice(0, 1000) : null,
    por: String(actor).toLowerCase(),
    lote_id: uuid(), // mesmo lote agrupa produtos enviados juntos
  };
  const atualizados = [];
  for (const id of ids) {
    const g = fila[id];
    if (!g) continue;
    _ensureProdutoFisico(g);
    if (g.produto_fisico.status !== 'recebido_loja') {
      // Pula silenciosamente — operador vê no retorno quais entraram.
      continue;
    }
    g.produto_fisico.status = 'enviado_fabricante';
    g.produto_fisico.envio_fabricante = { ...envioInfo };
    g.atualizado_em = now;
    g.historico.push({
      ts: now, acao: 'enviado_fabricante',
      por: String(actor).toLowerCase(),
      canal: envioInfo.canal,
      protocolo: envioInfo.protocolo_rma,
      lote_id: envioInfo.lote_id,
    });
    fila[id] = g;
    atualizados.push(id);
  }
  await _save(fila);
  return { atualizados, lote_id: envioInfo.lote_id, total: atualizados.length };
}

// Fabricante respondeu — fecha o ciclo de uma garantia.
async function registrarResolucaoFabricante(id, { tipo, nota, actor }) {
  if (!RESOLUCOES_FABRICANTE.includes(tipo)) throw new Error('Tipo de resolução inválido');
  const fila = await _load();
  const g = fila[id];
  if (!g) throw new Error('Garantia não encontrada');
  _ensureProdutoFisico(g);
  if (g.produto_fisico.status !== 'enviado_fabricante') {
    throw new Error('Produto não está no fabricante (status: ' + g.produto_fisico.status + ')');
  }
  const now = new Date().toISOString();
  g.produto_fisico.status = 'resolvido_fabricante';
  g.produto_fisico.resolucao_fabricante = {
    data: now,
    tipo,
    nota: nota ? String(nota).trim().slice(0, 1000) : null,
    por: String(actor).toLowerCase(),
  };
  g.atualizado_em = now;
  g.historico.push({
    ts: now, acao: 'resolvido_fabricante',
    por: String(actor).toLowerCase(),
    tipo,
  });
  fila[id] = g;
  await _save(fila);
  return g;
}

// Lista produtos em estoque de garantia, com filtros.
// filtros: { status (do produto), marca, agruparPorMarca }
async function listarEstoque({ status_produto, marca, agrupar_por_marca } = {}) {
  const fila = await _load();
  let arr = Object.values(fila).filter(g => {
    _ensureProdutoFisico(g);
    return g.produto_fisico.status !== 'nao_solicitado';
  });
  if (status_produto) arr = arr.filter(g => g.produto_fisico.status === status_produto);
  if (marca) {
    const m = String(marca).toLowerCase();
    arr = arr.filter(g => String(g.pedido.marca || '').toLowerCase() === m);
  }
  // Ordem lógica do estoque: aguardando → recebido → enviado → resolvido
  const ordem = {
    aguardando_chegada: 0,
    recebido_loja: 1,
    enviado_fabricante: 2,
    resolvido_fabricante: 3,
  };
  arr.sort((a, b) => {
    const oa = ordem[a.produto_fisico.status] ?? 9;
    const ob = ordem[b.produto_fisico.status] ?? 9;
    if (oa !== ob) return oa - ob;
    return String(b.atualizado_em).localeCompare(String(a.atualizado_em));
  });

  if (agrupar_por_marca) {
    const grupos = {};
    for (const g of arr) {
      const key = String(g.pedido.marca || 'Sem marca').trim();
      if (!grupos[key]) grupos[key] = [];
      grupos[key].push(g);
    }
    return grupos;
  }
  return arr;
}

// ════════════════════════════════════════════════════════════════════
// ETIQUETA PRA IMPRIMIR — folha A4 com 4 etiquetas 10x15cm por página
// ════════════════════════════════════════════════════════════════════

// Mascara CPF/CNPJ exibindo só os últimos dígitos — LGPD-friendly pra etiqueta
// que fica exposta na área de estoque.
function _mascararDoc(doc) {
  const s = String(doc || '').replace(/[^0-9]/g, '');
  if (s.length === 11) {
    // CPF: ***.***.123-45
    return '***.***.' + s.slice(6, 9) + '-' + s.slice(9);
  }
  if (s.length === 14) {
    // CNPJ: **.***.***/0001-45
    return '**.***.***/' + s.slice(8, 12) + '-' + s.slice(12);
  }
  return s ? '****' + s.slice(-4) : '';
}

function _escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function _idCurto(id) {
  // UUID → "GAR-XXXXXXXX" (primeiros 8 hex do uuid, caixa alta)
  return 'GAR-' + String(id || '').replace(/-/g, '').slice(0, 8).toUpperCase();
}

// Gera o HTML de UMA etiqueta (10x15cm) — usado tanto pela impressão
// individual quanto pela folha A4 que agrupa 4.
function _htmlEtiquetaUnica(g) {
  const idCurto = _idCurto(g.id);
  const docMask = _mascararDoc(g.cliente.cpf_cnpj);
  const dataAbertura = (g.criado_em || '').slice(0, 10).split('-').reverse().join('/');
  const problema = String(g.problema.descricao_cliente || '').slice(0, 220);
  const dec = g.decisao_operador && g.decisao_operador.valor;
  const situacaoTxt = {
    procedente_troca: 'TROCA APROVADA',
    procedente_restituicao: 'DEVOLUÇÃO APROVADA',
    improcedente_prazo: 'FORA DO PRAZO',
    improcedente_mau_uso: 'MAU USO',
    improcedente_sem_direito: 'SEM DIREITO',
    analise_manual: 'EM ANÁLISE',
  }[dec] || 'EM ANÁLISE';

  // Produto + nº série em destaque, cliente discreto, problema no rodapé.
  return `
<div class="etq">
  <div class="etq-cab">
    <div class="etq-id">${_escapeHtml(idCurto)}</div>
    <div class="etq-sit">${_escapeHtml(situacaoTxt)}</div>
  </div>
  <div class="etq-prod">
    <div class="etq-prod-nome">${_escapeHtml(g.pedido.nome_produto || '—')}</div>
    <div class="etq-prod-meta">
      <span><b>Marca:</b> ${_escapeHtml(g.pedido.marca || '—')}</span>
      <span><b>Modelo:</b> ${_escapeHtml(g.pedido.modelo || '—')}</span>
    </div>
    <div class="etq-prod-serie"><b>Nº Série:</b> ${_escapeHtml(g.pedido.numero_serie || 'N/A')}</div>
  </div>
  <div class="etq-cli">
    <div><b>Cliente:</b> ${_escapeHtml(g.cliente.nome || '')}</div>
    <div><b>CPF/CNPJ:</b> ${_escapeHtml(docMask)}</div>
    <div><b>Aberto em:</b> ${_escapeHtml(dataAbertura)}</div>
  </div>
  <div class="etq-prob">
    <b>Problema:</b> ${_escapeHtml(problema)}
  </div>
  <div class="etq-footer">PRO HUNTERS · GARANTIA</div>
</div>`;
}

// Gera folha A4 com até 4 etiquetas (2x2) — se vier mais que 4 IDs, pagina.
// Linhas tracejadas pra orientar o corte.
function gerarFolhaEtiquetasA4(garantias) {
  const arr = Array.isArray(garantias) ? garantias : [garantias];
  if (!arr.length) throw new Error('Nenhuma garantia pra imprimir');

  // Divide em grupos de 4 pra páginas
  const paginas = [];
  for (let i = 0; i < arr.length; i += 4) paginas.push(arr.slice(i, i + 4));

  const corpoPaginas = paginas.map((grupo, idx) => {
    // Preenche espaços vazios com placeholders invisíveis pra manter o grid
    while (grupo.length < 4) grupo.push(null);
    const cells = grupo.map(g => g ? _htmlEtiquetaUnica(g) : '<div class="etq etq-vazia"></div>').join('');
    const pageBreak = idx < paginas.length - 1 ? 'page-break-after: always;' : '';
    return `<section class="etq-folha" style="${pageBreak}">${cells}</section>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<title>Etiquetas de Garantia — Pro Hunters</title>
<style>
  @page { size: A4; margin: 0; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
    background: #e5e5e5;
    color: #000;
  }
  .etq-folha {
    width: 210mm;
    height: 297mm;
    padding: 10mm;
    display: grid;
    grid-template-columns: 1fr 1fr;
    grid-template-rows: 1fr 1fr;
    gap: 0;
    background: #fff;
    margin: 10mm auto;
    box-shadow: 0 0 8px rgba(0,0,0,.15);
  }
  .etq {
    border: 1px dashed #999;
    padding: 6mm;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    gap: 3mm;
    font-size: 10pt;
  }
  .etq-vazia { border: 1px dashed #ddd; }
  .etq-cab {
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-bottom: 2px solid #000;
    padding-bottom: 2mm;
  }
  .etq-id { font-weight: 800; font-size: 14pt; letter-spacing: 1px; }
  .etq-sit {
    background: #000;
    color: #fff;
    padding: 1mm 3mm;
    font-size: 9pt;
    font-weight: 700;
    border-radius: 2mm;
  }
  .etq-prod-nome {
    font-size: 13pt;
    font-weight: 700;
    line-height: 1.2;
    margin-bottom: 1mm;
  }
  .etq-prod-meta { display: flex; gap: 4mm; font-size: 9.5pt; margin-bottom: 1mm; }
  .etq-prod-serie {
    font-size: 10pt;
    padding: 1mm 2mm;
    background: #f0f0f0;
    display: inline-block;
    border-radius: 1mm;
  }
  .etq-cli {
    font-size: 9.5pt;
    line-height: 1.4;
    padding: 2mm 0;
    border-top: 1px solid #ddd;
    border-bottom: 1px solid #ddd;
  }
  .etq-prob {
    font-size: 8.5pt;
    line-height: 1.3;
    flex: 1;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 5;
    -webkit-box-orient: vertical;
  }
  .etq-footer {
    text-align: center;
    font-size: 8pt;
    letter-spacing: 2px;
    font-weight: 700;
    color: #666;
    border-top: 1px solid #000;
    padding-top: 1mm;
    margin-top: auto;
  }
  @media print {
    body { background: #fff; }
    .etq-folha { box-shadow: none; margin: 0; }
    .no-print { display: none !important; }
  }
  .toolbar {
    position: fixed;
    top: 10px;
    right: 10px;
    background: #000;
    color: #fff;
    padding: 10px 16px;
    border-radius: 6px;
    display: flex;
    gap: 10px;
    z-index: 1000;
  }
  .toolbar button {
    background: #fff;
    color: #000;
    border: 0;
    padding: 6px 14px;
    border-radius: 4px;
    font-weight: 600;
    cursor: pointer;
  }
</style>
</head>
<body>
<div class="toolbar no-print">
  <span>${arr.filter(Boolean).length} etiqueta(s) · ${paginas.length} página(s)</span>
  <button onclick="window.print()">Imprimir</button>
  <button onclick="window.close()">Fechar</button>
</div>
${corpoPaginas}
</body>
</html>`;
}

module.exports = {
  // CRUD + triagem
  criar, listar, obter, mudarStatus, registrarDecisao, resolver, reavaliar,
  contarPendentes, triar,
  // Estoque de garantias
  marcarAguardandoChegada, marcarRecebimentoLoja,
  registrarImpressaoEtiqueta,
  registrarEnvioFabricante, registrarResolucaoFabricante,
  listarEstoque, gerarFolhaEtiquetasA4,
  // Constantes
  STATUS, RESULTADOS, SUGESTOES,
  STATUS_PRODUTO, RESOLUCOES_FABRICANTE, CANAIS_FABRICANTE,
};
