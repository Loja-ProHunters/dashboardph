// lib/frete/aprendizado.js
// Aprende valores de frete a partir dos envios reais.
// Toda vez que um envio recebe (transportadora + transporte_valor > 0) num destino
// (cidade+UF), registramos a amostra. A próxima cotação pra esse mesmo trecho
// sugere um valor com base no histórico:
//   - último_valor (mais recente)
//   - média das últimas N amostras (default 10)
//   - amostras totais
//
// Armazenamento: crm/frete/valores-aprendidos.json — dict indexado por
//   "<cidade normalizada>|<UF>|<transportadora>"

const { getFile, saveFile } = require('../githubStore');
const dados = require('./dados');

const PATH = 'crm/frete/valores-aprendidos.json';
const AMOSTRAS_JANELA = 10; // últimas N amostras usadas na média
const MAX_AMOSTRAS_GUARDADAS = 50; // histórico completo — mais que isso corta antigas

let _cache = { data: null, ts: 0 };
const CACHE_MS = 60 * 1000; // 60s

async function _carregar() {
  const now = Date.now();
  if (_cache.data && (now - _cache.ts) < CACHE_MS) return _cache.data;
  let data = {};
  try {
    const raw = await getFile(PATH);
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') data = parsed;
  } catch (e) { /* ainda não existe */ }
  _cache = { data, ts: now };
  return data;
}

async function _salvar(data, msg) {
  await saveFile(PATH, JSON.stringify(data, null, 2), msg || 'Frete: aprende valor');
  _cache = { data, ts: Date.now() };
}

function _chave(cidade, uf, transportadora) {
  return dados._norm(cidade) + '|' + String(uf || '').toUpperCase() + '|' + String(transportadora || '').toLowerCase();
}

// Registra uma amostra. Idempotente por envio_id — se o mesmo envio_id já
// registrou pra este trecho, apenas atualiza o valor (o vendedor pode ter
// corrigido).
async function registrarValor({ cidade, uf, transportadora, valor, envio_id, actor }) {
  if (!cidade || !uf || !transportadora) return null;
  const v = Number(valor);
  if (!v || v <= 0) return null; // ignora 0 / null / inválido
  const chave = _chave(cidade, uf, transportadora);
  const now = new Date().toISOString();
  const all = await _carregar();
  const rec = all[chave] || {
    cidade: String(cidade).trim(),
    uf: String(uf).toUpperCase(),
    transportadora: String(transportadora).toLowerCase(),
    amostras_hist: [],
  };
  // Se já tem amostra deste envio_id, substitui (não duplica)
  if (envio_id) {
    const existente = rec.amostras_hist.findIndex(a => a.envio_id === envio_id);
    if (existente >= 0) {
      rec.amostras_hist[existente] = { valor: v, envio_id, actor: actor || null, em: now };
    } else {
      rec.amostras_hist.push({ valor: v, envio_id, actor: actor || null, em: now });
    }
  } else {
    rec.amostras_hist.push({ valor: v, actor: actor || null, em: now });
  }
  // Ordena por data desc e trunca
  rec.amostras_hist.sort((a, b) => String(b.em).localeCompare(String(a.em)));
  if (rec.amostras_hist.length > MAX_AMOSTRAS_GUARDADAS) {
    rec.amostras_hist = rec.amostras_hist.slice(0, MAX_AMOSTRAS_GUARDADAS);
  }
  // Recalcula stats — usando janela das mais recentes
  const janela = rec.amostras_hist.slice(0, AMOSTRAS_JANELA).map(a => Number(a.valor)).filter(x => x > 0);
  rec.amostras_count = rec.amostras_hist.length;
  rec.ultimo_valor = rec.amostras_hist[0] ? Number(rec.amostras_hist[0].valor) : null;
  rec.ultima_em = rec.amostras_hist[0] ? rec.amostras_hist[0].em : null;
  rec.media = janela.length ? Math.round(janela.reduce((s, x) => s + x, 0) / janela.length) : null;
  rec.min = janela.length ? Math.min(...janela) : null;
  rec.max = janela.length ? Math.max(...janela) : null;
  rec.atualizado_em = now;
  all[chave] = rec;
  await _salvar(all, 'Frete aprende: ' + rec.cidade + '/' + rec.uf + ' · ' + rec.transportadora + ' R$' + v);
  return rec;
}

// Sugere valor pra próxima cotação. Retorna null se sem histórico.
async function sugerirValor(cidade, uf, transportadora) {
  const chave = _chave(cidade, uf, transportadora);
  const all = await _carregar();
  const rec = all[chave];
  if (!rec) return null;
  return {
    ultimo_valor: rec.ultimo_valor,
    ultima_em: rec.ultima_em,
    media: rec.media,
    min: rec.min,
    max: rec.max,
    amostras_count: rec.amostras_count,
    janela_media: Math.min(rec.amostras_count, AMOSTRAS_JANELA),
    cidade: rec.cidade,
    uf: rec.uf,
  };
}

// Lista todos os aprendidos — pra painel de gestão futuro
async function listar() {
  const all = await _carregar();
  return Object.values(all).sort((a, b) => (b.atualizado_em || '').localeCompare(a.atualizado_em || ''));
}

module.exports = { registrarValor, sugerirValor, listar };
