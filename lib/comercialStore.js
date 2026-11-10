const fs = require('fs');
const path = require('path');
const { getFile, getFileFrom, getFileWithSha, saveFile, ehConflito } = require('./githubStore');

const FILE_PATH = 'comercial-data.json';
const LOCAL_FALLBACK = path.join(__dirname, '..', 'comercial-data.json');

const DEFAULT_SELLERS = [
  { id: 1, name: 'Pedro',          foto: 'consultor_pedro.jpg',  fat: 0, etiqueta: 100, tarefas: 100, faltas: 0, atrasos: 0 },
  { id: 2, name: 'Enzo',           foto: 'consultor_enzo.jpg',   fat: 0, etiqueta: 100, tarefas: 100, faltas: 0, atrasos: 0 },
  { id: 3, name: 'Wesley Mathias', foto: 'consultor_wesley.jpg', fat: 0, etiqueta: 100, tarefas: 100, faltas: 0, atrasos: 0 },
];

const META_IND = 150000;

function calcScoreServer(s) {
  const fatNorm = Math.min(100, ((s.fat || 0) / (META_IND * 2)) * 100);
  const score = (fatNorm * 3) + (Math.min(100, s.etiqueta || 0) * 1) + (Math.min(100, s.tarefas || 0) * 1);
  const maxScore = 100 * (3 + 1 + 1);
  const base = Math.round((score / maxScore) * 100);
  // Penalidade: 5 pontos por advertencia (bate com calcScore do frontend).
  // Sem isso, o "vencedor do mes" arquivado poderia ficar diferente do "1o do
  // ranking em tempo real" — vendedor com muita advertencia poderia ganhar
  // o mes so pq o backend nao considerava a penalidade.
  const penalidade = (s.advertencias || 0) * 5;
  return Math.max(0, base - penalidade);
}

function hojeReferencia() {
  return new Date().toISOString().slice(0, 7); // AAAA-MM
}

function defaultData() {
  return {
    sellers: DEFAULT_SELLERS.map(s => ({ ...s })),
    // Faturamento do SITE — bucket separado. Não é vendedor: não entra no
    // rank, não recebe IPC/score/comissão. Só soma pro Total Geral do mês.
    siteFat: 0,
    diasCorridos: 1,
    diasMes: 30,
    mesReferencia: hojeReferencia(),
    savedAt: null,
    history: [], // [{ mesReferencia, vencedor, sellers, siteFat, fechadoEm }]
  };
}

let cache = { data: null, ts: 0 };
// 90s: reduz a pressao na API do GitHub (menos leituras) sem defasar demais o
// placar. Ajuda a nao reesbarrar no rate limit.
const CACHE_MS = 90 * 1000;

// Devolve { data, source }. source: 'data' (branch de dados, confiavel),
// 'main' (fallback legado), 'local' (arquivo do repo) ou 'default' (vazio).
// O source importa pro autoRollover: so fecha/zera o mes a partir da branch
// de dados — nunca a partir de um fallback stale (senao arquivaria numero
// velho e sobrescreveria o estado bom).
async function fetchRawData() {
  try {
    const { text, source } = await getFileFrom(FILE_PATH);
    return { data: JSON.parse(text), source };
  } catch (e) {
    // Erro TEMPORARIO do GitHub (rate limit 403/429 ou 5xx): NAO servir o arquivo
    // LOCAL do repo (snapshot de semanas atras) — isso mostraria numero velho e
    // assustaria "mudou sozinho". Propaga como erro temporario; o dado bom segue
    // intacto na branch de dados e getComercialData serve o ultimo cache bom.
    const code = e && e.statusCode;
    const msg = String((e && e.message) || '');
    const temporario = code === 403 || code === 429 || (code >= 500 && code < 600) || /rate limit|secondary rate|abuse/i.test(msg);
    if (temporario) {
      const err = new Error('Comercial temporariamente indisponivel (limite de API do GitHub) — o dado esta salvo e volta em instantes.');
      err.temporario = true;
      throw err;
    }
    // Só usa o local/default quando o arquivo REALMENTE não existe (404 em data e main).
    try {
      const text = fs.readFileSync(LOCAL_FALLBACK, 'utf-8');
      return { data: JSON.parse(text), source: 'local' };
    } catch (e2) {
      return { data: defaultData(), source: 'default' };
    }
  }
}

// Fecha automaticamente o mes anterior (arquiva no historico com o vencedor por
// maior score) sempre que o mes civil atual for diferente do mesReferencia salvo.
// Isso roda sozinho, sem precisar de ninguem clicar em nada.
async function autoRolloverSeNecessario(data, source) {
  const atual = hojeReferencia();
  if (!data.mesReferencia || data.mesReferencia === atual) return data;

  // SEGURANCA 1 — so fecha o mes a partir da branch de DADOS. Se a leitura caiu
  // num fallback (main/local/default), os numeros podem estar stale: fechar e
  // salvar a partir dai ARQUIVARIA valores velhos e SOBRESCREVERIA o estado bom
  // na branch de dados. Nesse caso NAO fecha nada (so loga) e deixa o estado
  // como esta ate uma leitura confiavel acontecer.
  if (source && source !== 'data') {
    console.warn('[comercial] autoRollover ABORTADO: leitura veio de "' + source + '" (fallback), nao da branch de dados. Mes ' + data.mesReferencia + ' NAO foi fechado pra nao arquivar/sobrescrever numero stale.');
    return data;
  }

  data.history = data.history || [];

  // SEGURANCA 2 — nao arquiva o mesmo mes duas vezes. Se ja existe snapshot pra
  // data.mesReferencia no historico, NAO cria outro (evita sobrescrever um
  // fechamento bom quando o mesReferencia regride por algum motivo).
  if (data.history.some(h => h && h.mesReferencia === data.mesReferencia)) {
    console.warn('[comercial] autoRollover: mes ' + data.mesReferencia + ' ja estava no historico — avanco o ponteiro sem arquivar de novo.');
    data.sellers = data.sellers.map(s => ({ ...s, fat: 0, etiqueta: 100, tarefas: 100, faltas: 0, atrasos: 0, advertencias: 0 }));
    data.siteFat = 0;
    data.mesReferencia = atual;
    await saveComercialData(data);
    return data;
  }

  const ranked = [...data.sellers].sort((a, b) => calcScoreServer(b) - calcScoreServer(a));
  const vencedor = ranked[0] ? ranked[0].name : null;

  data.history.unshift({
    mesReferencia: data.mesReferencia,
    vencedor,
    sellers: data.sellers.map(s => ({ ...s })),
    siteFat: data.siteFat || 0,
    fechadoEm: new Date().toISOString(),
  });
  data.sellers = data.sellers.map(s => ({
    ...s,
    fat: 0, etiqueta: 100, tarefas: 100, faltas: 0, atrasos: 0,
    // Zera o CONTADOR de advertencias pra nao penalizar o Score eternamente —
    // vendedor comeca o mes novo em pe de igualdade. O historico detalhado
    // (advertenciasLog) e PRESERVADO: continua visivel no card do vendedor
    // pra registro e auditoria, e o snapshot do mes fechado em data.history[]
    // tambem guarda tudo via spread acima.
    advertencias: 0,
  }));
  data.siteFat = 0;
  data.mesReferencia = atual;
  await saveComercialData(data);
  return data;
}

async function getComercialData() {
  const now = Date.now();
  if (cache.data && (now - cache.ts) < CACHE_MS) return cache.data;
  let raw, source;
  try {
    const r = await fetchRawData();
    raw = r.data; source = r.source;
  } catch (e) {
    // Indisponibilidade temporaria (rate limit): se temos um ultimo valor BOM em
    // cache (lido antes da branch de dados), servimos ele (dado correto, so nao
    // atualizado) em vez de erro ou numero velho. Sem cache, propaga o erro —
    // o endpoint mostra "indisponivel", nunca dados de semanas atras.
    if (e && e.temporario && cache.data) return cache.data;
    throw e;
  }
  const data = await autoRolloverSeNecessario(raw, source);
  cache = { data, ts: Date.now() };
  return data;
}

// Overwrite DIRETO do objeto inteiro. Usado só por recuperação/restaurar e pelo
// autoRollover (que já leu da branch de dados). Para mudanças INCREMENTAIS de
// vendedores (faturamento, site), use mutateComercial — ele tem trava otimista
// e nunca perde um lançamento concorrente.
async function saveComercialData(data) {
  data.savedAt = new Date().toISOString();
  await saveFile(FILE_PATH, JSON.stringify(data, null, 2), 'Atualiza dados do Dashboard Comercial');
  cache = { data, ts: Date.now() };
}

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Leitura FRESCA (sem cache) + sha, direto da branch de dados. Toda mutação
// passa por aqui pra não gravar por cima de um estado velho — o cache de 90s é
// POR INSTÂNCIA serverless, então duas instâncias diferentes enxergam valores
// diferentes; era essa leitura velha + gravação sem trava que fazia a venda
// "retroceder".
async function _lerFrescoComSha() {
  try {
    const { text, sha } = await getFileWithSha(FILE_PATH);
    return { data: JSON.parse(text), sha };
  } catch (e) {
    if (e && e.statusCode === 404) {
      try { return { data: JSON.parse(fs.readFileSync(LOCAL_FALLBACK, 'utf-8')), sha: null }; }
      catch (_) { return { data: defaultData(), sha: null }; }
    }
    throw e;
  }
}

// Read-modify-write ATÔMICO com trava otimista (sha do GitHub). Lê fresco,
// aplica a mudança, grava com o sha lido. Se outra escrita entrou no meio, o
// GitHub recusa (409/422-sha) e a gente RELÊ o estado novo e REAPLICA a mudança
// por cima dele — nunca sobrescreve nem perde o que o outro gravou. applyFn
// recebe o objeto fresco e muta nele (ou devolve um novo objeto).
async function mutateComercial(applyFn, message) {
  let ultimoErro;
  for (let t = 1; t <= 6; t++) {
    const { data, sha } = await _lerFrescoComSha();
    const novo = applyFn(data) || data;
    novo.savedAt = new Date().toISOString();
    const body = JSON.stringify(novo, null, 2);
    try {
      // Com sha: PUT condicional (409 se mudou). Sem sha (primeiro write na
      // branch de dados): cria o arquivo pelo caminho normal com retry interno.
      if (sha) await saveFile(FILE_PATH, body, message || ('Atualiza ' + FILE_PATH), { sha });
      else await saveFile(FILE_PATH, body, message || ('Atualiza ' + FILE_PATH));
      cache = { data: novo, ts: Date.now() };
      return novo;
    } catch (e) {
      ultimoErro = e;
      if (!ehConflito(e)) throw e;
      await _sleep(250 * t + Math.floor(Math.random() * 200)); // backoff e relê fresco
    }
  }
  throw ultimoErro || new Error('Não consegui gravar o comercial (conflitos seguidos na trava otimista).');
}

async function resetMonth(vencedorNome) {
  return mutateComercial(data => {
    data.history = data.history || [];
    data.history.unshift({
      mesReferencia: data.mesReferencia,
      vencedor: vencedorNome || null,
      sellers: (data.sellers || []).map(s => ({ ...s })),
      siteFat: data.siteFat || 0,
      fechadoEm: new Date().toISOString(),
    });
    data.sellers = (data.sellers || []).map(s => ({
      ...s,
      fat: 0, etiqueta: 100, tarefas: 100, faltas: 0, atrasos: 0,
      // Zera CONTADOR de advertencias (mesma logica do autoRollover acima).
      advertencias: 0,
    }));
    data.siteFat = 0;
    data.diasCorridos = 1;
    data.mesReferencia = hojeReferencia();
    return data;
  }, 'Fecha o mes e zera o Dashboard Comercial');
}

// Atualiza (SOMA) o faturamento de UM vendedor — autolancamento do proprio
// vendedor ("registrei uma venda de RX"). ATÔMICO: lê fresco e reaplica o
// delta mesmo sob concorrência, então nunca perde um lançamento.
async function registrarVenda(sellerId, valor) {
  const delta = Number(valor) || 0;
  return mutateComercial(data => {
    const s = (data.sellers || []).find(x => x.id === sellerId);
    if (!s) throw new Error('Vendedor nao encontrado.');
    s.fat = (Number(s.fat) || 0) + delta;
    return data;
  }, 'registrar-venda: +' + delta + ' no vendedor ' + sellerId);
}

// DEFINE (valor absoluto) o faturamento de um vendedor — correção manual da
// gerência (ex.: tirar uma venda lançada errada). É o ÚNICO outro caminho que
// mexe em fat além de registrar-venda; o autosave do quadro NÃO mexe mais em
// fat, por isso ele não consegue mais fazer a venda retroceder.
async function ajustarFat(sellerId, valorAbsoluto) {
  const v = Math.max(0, Number(valorAbsoluto) || 0);
  return mutateComercial(data => {
    const s = (data.sellers || []).find(x => x.id === sellerId);
    if (!s) throw new Error('Vendedor nao encontrado.');
    s.fat = v;
    return data;
  }, 'ajustar-fat: vendedor ' + sellerId + ' = ' + v);
}

// Soma (ou subtrai) no bucket do SITE. Não é vendedor: não entra no
// rank/score/comissão. Só compõe o Total Geral do mês.
//
// Aceita valor NEGATIVO pra correção ("lancei errado, quero remover R$ X").
// Se a operação levaria o total a ficar negativo, lança erro pra evitar
// corromper o histórico do mês.
async function registrarVendaSite(valor) {
  const delta = Number(valor);
  return mutateComercial(data => {
    const atual = Number(data.siteFat) || 0;
    const novo = atual + delta;
    if (novo < 0) {
      throw new Error('A remoção deixaria o total do Site negativo (atual: R$ ' + atual.toFixed(2) + '). Ajuste o valor.');
    }
    data.siteFat = novo;
    return data;
  }, 'registrar-venda-site: ' + delta);
}

module.exports = { getComercialData, saveComercialData, mutateComercial, resetMonth, registrarVenda, registrarVendaSite, ajustarFat, defaultData };
