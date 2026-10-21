// lib/supabaseClient.js
// Client singleton do Supabase pra uso serverless (Vercel).
// Reutiliza a mesma instÃ¢ncia dentro de uma invocaÃ§Ã£o â a Vercel
// mantÃ©m o mÃ³dulo entre requests do mesmo container.

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

let _client = null;

function getClient() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error('Supabase nÃ£o configurado: SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY sÃ£o obrigatÃ³rios.');
  }
  if (!_client) {
    _client = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return _client;
}

// Testa a conexÃ£o (Ãºtil pro health-check)
async function ping() {
  const sb = getClient();
  const { error } = await sb.from('whatsapp_mensagens').select('id', { count: 'exact', head: true });
  if (error && error.code !== 'PGRST116') throw error; // PGRST116 = tabela vazia, ok
  return true;
}

module.exports = { getClient, ping };
