// ── ATENÇÃO ──────────────────────────────────────────────────
// Este arquivo NÃO contém mais nenhum segredo (chave de API, senhas).
// Tudo é lido das Variáveis de Ambiente configuradas no painel da Vercel
// (Project → Settings → Environment Variables), para nunca mais ficar
// exposto no GitHub, mesmo que o repositório seja público.
//
// Variáveis que você precisa cadastrar na Vercel:
//   ANTHROPIC_API_KEY   → sua chave da API Anthropic (sk-ant-...)
//   GITHUB_TOKEN         → token do GitHub com permissão de escrita no repo (para salvar a base de conhecimento)
//   GITHUB_REPO          → ex: "Loja-ProHunters/dashboardph"
//   GITHUB_BRANCH        → ex: "main" (opcional, padrão "main")
//   SESSION_HOURS         → ex: "8" (opcional, padrão 8)
//   USERS_JSON            → lista de usuários em JSON (veja exemplo abaixo)
//
// Exemplo de valor para USERS_JSON (copie e cole em uma linha só na Vercel):
// [{"usuario":"luis","senha":"SUA_SENHA_AQUI","nome":"Luis"},{"usuario":"vendas","senha":"SUA_SENHA_AQUI","nome":"Vendedor"},{"usuario":"admin","senha":"SUA_SENHA_AQUI","nome":"Admin"}]
// ─────────────────────────────────────────────────────────────

function loadUsers() {
  if (process.env.USERS_JSON) {
    try { return JSON.parse(process.env.USERS_JSON); }
    catch (e) { console.error('USERS_JSON inválido:', e.message); }
  }
  // Fallback só para rodar local sem configurar nada (NUNCA usado em produção se USERS_JSON estiver setado)
  return [
    { usuario: 'luis',   senha: 'phunters2025', nome: 'Luis'     },
    { usuario: 'vendas', senha: 'vendas2025',   nome: 'Vendedor' },
    { usuario: 'admin',  senha: 'admin2025',    nome: 'Admin'    },
  ];
}

module.exports = {
  anthropicKey: process.env.ANTHROPIC_API_KEY || '',
  githubToken:  process.env.GITHUB_TOKEN || '',
  githubRepo:   process.env.GITHUB_REPO || '',
  githubBranch: process.env.GITHUB_BRANCH || 'main',
  model:        process.env.MODEL || 'claude-sonnet-4-6',
  maxTokens:    parseInt(process.env.MAX_TOKENS || '1000', 10),
  sessionHours: parseInt(process.env.SESSION_HOURS || '8', 10),
  users:        loadUsers(),
};
