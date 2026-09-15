// config.js - Configuração do Portal Pro Hunters

// Ler variáveis de ambiente com valores padrão (fail-safe)
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

  // Segredo do cron (usado por /api/crm/cron/vencimentos quando chamado por
  // agendador — Vercel Cron ou similar. Também pode ser chamado por gerência logada.)
  cronSecret: process.env.CRON_SECRET || '',

  // Bling API v3 (OAuth 2.0)
  blingClientId:     process.env.BLING_CLIENT_ID     || '',
  blingClientSecret: process.env.BLING_CLIENT_SECRET || '',
  blingRedirectUri:  process.env.BLING_REDIRECT_URI  || '',
  
  // Usuários (padrão: admin/gerencia/auxiliar/vendas)
  users: (() => {
    try {
      const json = process.env.USERS_JSON;
      if (!json) {
        // Valores padrão para desenvolvimento
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
