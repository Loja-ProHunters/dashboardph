// ============================================================
//  Pro Hunters Portal — CONFIGURAÇÕES
//  Este é o único arquivo que você precisa editar.
//  Após qualquer alteração, faça git push — Vercel atualiza sozinho.
// ============================================================

module.exports = {

  // ── Chave da API Anthropic (nunca aparece no navegador) ──
  anthropicKey: 'sk-ant-api03-aYx6rvNY6nv1ccoqCvt8sE55ki1ABahqQ-wWw_NJlNh17nDWE0YrSov-f1q6ZiSoiXPehxHoAmN1Z02vSEHaMw-J9oPAwAA',

  // ── Modelo utilizado ──
  // 'claude-sonnet-4-6'         → recomendado (melhor qualidade)
  // 'claude-haiku-4-5-20251001' → mais barato (respostas mais simples)
  model: 'claude-sonnet-4-6',

  // ── Máximo de tokens por resposta ──
  // 1000 = respostas objetivas | aumente para respostas mais longas
  maxTokens: 1000,

  // ── Sessão ──
  // Tempo em horas que o login fica ativo
  sessionHours: 8,

  // ── Usuários com acesso ao portal ──
  // Adicione ou remova linhas conforme necessário
  users: [
    { usuario: 'luis',   senha: 'phunters2025', nome: 'Luis'     },
    { usuario: 'vendas', senha: 'vendas2025',   nome: 'Vendedor'  },
    { usuario: 'admin',  senha: 'admin2025',    nome: 'Admin'     },
  ],

};
