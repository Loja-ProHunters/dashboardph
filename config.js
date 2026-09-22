// config.js - Configuração do Portal Pro Hunters
// MULTI-BLING: suporta 2 contas Bling (prohunters + calibre) via variáveis
// separadas na Vercel. A conta "prohunters" mantém compat com as vars
// originais (BLING_CLIENT_ID etc). A conta "calibre" usa BLING_CLIENT_ID_CALIBRE.

// Dicionário de contas Bling suportadas.
// contaId → { clientId, clientSecret, redirectUri, nome, ativa }
// "ativa" fica true quando as 3 vars estão preenchidas.
function _montarContasBling() {
  const contas = {
    prohunters: {
      contaId: 'prohunters',
      nome: 'Pro Hunters',
      clientId:     process.env.BLING_CLIENT_ID     || '',
      clientSecret: process.env.BLING_CLIENT_SECRET || '',
      redirectUri:  process.env.BLING_REDIRECT_URI  || '',
    },
    calibre: {
      contaId: 'calibre',
      nome: 'Calibre Restrito',
      clientId:     process.env.BLING_CLIENT_ID_CALIBRE     || '',
      clientSecret: process.env.BLING_CLIENT_SECRET_CALIBRE || '',
      redirectUri:  process.env.BLING_REDIRECT_URI_CALIBRE  || '',
    },
  };
  for (const c of Object.values(contas)) {
    c.ativa = !!(c.clientId && c.clientSecret && c.redirectUri);
  }
  return contas;
}

module.exports = {
  // Sessão
  sessionHours: parseInt(process.env.SESSION_HOURS || '8', 10),
  sessionSecret: process.env.SESSION_SECRET || 'default-secret-key-change-this-in-vercel',

  // Anthropic API
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-opus-4-6',

  // GitHub
  githubToken: process.env.GITHUB_TOKEN || '',
  githubRepo: process.env.GITHUB_REPO || 'Loja-ProHunters/dashboardph',
  githubBranch: process.env.GITHUB_BRANCH || 'main',

  cronSecret: process.env.CRON_SECRET || '',

  // Bling API v3 — LEGADO (compat com código antigo que não passa contaId)
  // Sempre aponta pra conta padrão "prohunters".
  blingClientId:     process.env.BLING_CLIENT_ID     || '',
  blingClientSecret: process.env.BLING_CLIENT_SECRET || '',
  blingRedirectUri:  process.env.BLING_REDIRECT_URI  || '',

  // Bling API v3 — MULTI-CONTA (novo)
  blingContas: _montarContasBling(),
  blingContaPadrao: 'prohunters', // usada quando não passa contaId explícito

  // Usuários (padrão: admin/gerencia/auxiliar/vendas)
  users: (() => {
    try {
      const json = process.env.USERS_JSON;
      if (!json) {
        return [
          { usuario: 'gerencia', senha: 'gerencia123', role: 'gerencia' },
          { usuario: 'auxiliar', senha: 'auxiliar123', role: 'auxiliar' },
          { usuario: 'vendedor', senha: 'vendedor123', role: 'vendas' }
        ];
      }
      return JSON.parse(json);
    } catch (e) {
      console.warn('Erro ao parsear USERS_JSON, usando padrão:', e.message);
      return [
        { usuario: 'gerencia', senha: 'gerencia123', role: 'gerencia' },
        { usuario: 'auxiliar', senha: 'auxiliar123', role: 'auxiliar' },
        { usuario: 'vendedor', senha: 'vendedor123', role: 'vendas' }
      ];
    }
  })()
};
