// lib/supabaseClient.js
// Client singleton do Supabase.
// Timeout de 12s em toda chamada pra evitar que painéis pendurem
// quando o Supabase está degradado/unhealthy.

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const FETCH_TIMEOUT_MS = 12000; // 12 segundos

let _client = null;

/**
 * fetch com timeout — aborta se o Supabase não responder em FETCH_TIMEOUT_MS.
 * Assim o portal mostra "Erro ao carregar" em vez de "Carregando…" infinito.
 */
function fetchWithTimeout(url, opts) {
  if (!opts) opts = {};
  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, FETCH_TIMEOUT_MS);

  // Preserva signal externo se houver
  if (opts.signal) {
    opts.signal.addEventListener('abort', function () { controller.abort(); });
  }

  return fetch(url, Object.assign({}, opts, { signal: controller.signal }))
    .finally(function () { clearTimeout(timer); });
}

function getClient() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error('Supabase não configurado: SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são obrigatórios.');
  }
  if (!_client) {
    _client = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: fetchWithTimeout },
    });
  }
  return _client;
}

// Testa a conexão (útil pro health-check)
async function ping() {
  var sb = getClient();
  var result = await sb.from('whatsapp_mensagens').select('id', { count: 'exact', head: true });
  if (result.error && result.error.code !== 'PGRST116') throw result.error; // PGRST116 = tabela vazia, ok
  return true;
}

module.exports = { getClient, ping };
