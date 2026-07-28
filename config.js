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
//   SESSION_SECRET         → opcional, texto aleatório longo pra assinar o cookie de sessão (recomendado)
//   USERS_JSON            → lista de usuários em JSON (veja exemplo abaixo)
//
// Exemplo de valor para USERS_JSON (copie e cole em uma linha só na Vercel):
// [{"usuario":"gerencia","senha":"SUA_SENHA","nome":"Gerencia"},{"usuario":"vendas","senha":"SUA_SENHA","nome":"Vendedor"},{"usuario":"auxiliar","senha":"SUA_SENHA","nome":"Auxiliar"}]
// Papeis: "gerencia" = acesso total (Base de Conhecimento + Dashboard Comercial completo, inclusive lançamento).
//         "vendas" = tudo exceto Base de Conhecimento; ve o Dashboard Comercial mas nao edita o lançamento.
//         "auxiliar" = tudo exceto Base de Conhecimento e Dashboard Comercial.
//         Qualquer outro login cadastrado cai automaticamente no papel "vendas".
// ─────────────────────────────────────────────────────────────

const crypto = require('crypto');

function loadSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  return crypto.createHash('sha256')
    .update('prohunters-session-fallback|' + (process.env.ANTHROPIC_API_KEY || '') + '|' + (process.env.GITHUB_TOKEN || ''))
    .digest('hex');
}

function loadUsers() {
  if (process.env.USERS_JSON) {
    try { return JSON.parse(process.env.USERS_JSON); }
    catch (e) { console.error('USERS_JSON inválido:', e.message); }
  }
  // Fallback só para rodar local sem configurar nada (NUNCA usado em produção se USERS_JSON estiver setado)
  return [
    { usuario: 'gerencia', senha: 'phunters2025', nome: 'Gerencia' },
    { usuario: 'vendas',   senha: 'vendas2025',   nome: 'Vendedor' },
    { usuario: 'auxiliar', senha: 'auxiliar2025', nome: 'Auxiliar' },
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
  sessionSecret: loadSessionSecret(),
  users:        loadUsers(),
};
