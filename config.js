// ============================================================
//  Pro Hunters Portal — CONFIGURAÇÕES
//  Este é o único arquivo que você precisa editar.
//  Após qualquer alteração, reinicie o servidor:
//    Ctrl+C para parar → node server.js para reiniciar
// ============================================================

module.exports = {

  // ── Chave da API Anthropic (nunca aparece no navegador) ──
  anthropicKey: 'sk-ant-api03-aYx6rvNY6nv1ccoqCvt8sE55ki1ABahqQ-wWw_NJlNh17nDWE0YrSov-f1q6ZiSoiXPehxHoAmN1Z02vSEHaMw-J9oPAwAA',

  // ── Modelo utilizado ──
  // Opções: 'claude-sonnet-4-6' (recomendado) | 'claude-haiku-4-5-20251001' (mais barato)
  model: 'claude-sonnet-4-6',

  // ── Máximo de tokens por resposta ──
  maxTokens: 1000,

  // ── Porta do servidor ──
  port: 3000,

  // ── Sessão ──
  // Tempo em horas que o login fica ativo (ex: 8 = expira ao fim do expediente)
  sessionHours: 8,

  // ── Usuários com acesso ao portal ──
  // Adicione ou remova usuários aqui. Nunca compartilhe este arquivo.
  // formato: { usuario: 'nome', senha: 'senha', nome: 'Nome exibido' }
  users: [
    { usuario: 'luis',    senha: 'phunters2025', nome: 'Luis'    },
    { usuario: 'vendas',  senha: 'vendas2025',   nome: 'Vendedor' },
    { usuario: 'admin',   senha: 'admin2025',    nome: 'Admin'    },
  ],

};
