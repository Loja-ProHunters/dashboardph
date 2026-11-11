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

// Dicionário de lojas WooCommerce (sites WordPress). Suporta várias lojas via
// WOO_LOJA1_*, WOO_LOJA2_*, ... Cada loja tem a URL do site + o par
// consumer_key/consumer_secret da API REST do WooCommerce (WooCommerce >
// Configurações > Avançado > API REST). "ativa" fica true quando URL+ck+cs
// estão preenchidas. NENHUM segredo fica no código — tudo vem da env da Vercel.
// Descobre as lojas pelas envs no formato WOO_LOJA_<SLUG>_URL
// (ex.: WOO_LOJA_PROHUNTERS_URL). O <SLUG> identifica a loja. Cada loja usa:
//   WOO_LOJA_<SLUG>_URL   → endereço do site (https://...)
//   WOO_LOJA_<SLUG>_CK    → consumer_key  (ck_...)
//   WOO_LOJA_<SLUG>_CS    → consumer_secret (cs_...)
//   WOO_LOJA_<SLUG>_NOME  → nome de exibição (opcional; cai em WOO_LOJA_<SLUG>
//                           sem sufixo, ou no próprio slug, se não houver)
// Também aceita o formato antigo WOO_LOJA1_URL/_CK/_CS/_NOME.
function _montarLojasWoo() {
  const lojas = [];
  const vistos = new Set();
  const addLoja = (slug, url, ck, cs, nome) => {
    const chave = String(slug).toLowerCase();
    if (vistos.has(chave)) return;
    vistos.add(chave);
    lojas.push({
      slug: chave,
      nome: nome || slug,
      url: String(url || '').replace(/\/+$/, ''), // tira barra(s) finais
      consumerKey: ck || '',
      consumerSecret: cs || '',
      ativa: !!(url && ck && cs),
    });
  };
  // Formato por slug: WOO_LOJA_<SLUG>_URL
  for (const chave of Object.keys(process.env)) {
    const m = /^WOO_LOJA_(.+)_URL$/.exec(chave);
    if (!m) continue;
    const slug = m[1];
    addLoja(
      slug,
      process.env['WOO_LOJA_' + slug + '_URL'],
      process.env['WOO_LOJA_' + slug + '_CK'],
      process.env['WOO_LOJA_' + slug + '_CS'],
      process.env['WOO_LOJA_' + slug + '_NOME'] || process.env['WOO_LOJA_' + slug] || slug
    );
  }
  // Formato antigo numerado: WOO_LOJA1_URL, WOO_LOJA2_URL, ...
  for (let i = 1; i <= 10; i++) {
    const url = process.env['WOO_LOJA' + i + '_URL'];
    const ck  = process.env['WOO_LOJA' + i + '_CK'];
    const cs  = process.env['WOO_LOJA' + i + '_CS'];
    if (!url && !ck && !cs) continue;
    addLoja('loja' + i, url, ck, cs, process.env['WOO_LOJA' + i + '_NOME'] || ('Loja ' + i));
  }
  return lojas;
}

// SEGURANÇA CRÍTICA: SESSION_SECRET assina cookies de sessão E deriva chave
// AES-256-GCM que criptografa tokens OAuth do Bling. Se não vier da env ou for
// muito curto/default, atacante forja sessões de admin. Falhamos hard no boot
// pra impedir deploy inseguro em produção.
const _rawSessionSecret = process.env.SESSION_SECRET || '';
const _isDefaultOrWeak = !_rawSessionSecret
  || _rawSessionSecret === 'default-secret-key-change-this-in-vercel'
  || _rawSessionSecret.length < 32;
if (_isDefaultOrWeak) {
  const msg = '[CONFIG FATAL] SESSION_SECRET nao configurado (ou default/curto). ' +
    'Configure uma env var SESSION_SECRET de PELO MENOS 32 caracteres aleatorios na Vercel. ' +
    'Gere com: `openssl rand -hex 32` (ou node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"). ' +
    'Sem isso: qualquer um forja sessao de admin e descriptografa tokens Bling.';
  console.error(msg);
  // Nao usar `throw` pra nao quebrar builds de dev totalmente — em producao,
  // sessSecret vazio faz o crypto.createHmac lancar erro na primeira request.
}

module.exports = {
  // Sessão
  sessionHours: parseInt(process.env.SESSION_HOURS || '8', 10),
  sessionSecret: _rawSessionSecret,

  // Anthropic API
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-opus-4-6',

  // GitHub
  githubToken: process.env.GITHUB_TOKEN || '',
  githubRepo: process.env.GITHUB_REPO || 'Loja-ProHunters/dashboardph',
  githubBranch: process.env.GITHUB_BRANCH || 'main',
  // Branch SEPARADA pra dados (JSON de garantias, solicitações, CRM, etc).
  // Vercel só acompanha githubBranch — writes aqui NÃO geram deploys.
  // Resolve o estouro de rate limit da Vercel que acontecia com o backend
  // commitando dados várias vezes por dia no mesmo branch do código.
  dataBranch: process.env.GITHUB_DATA_BRANCH || 'data',

  cronSecret: process.env.CRON_SECRET || '',

  // Evolution API — webhook secret pra validar requests
  evolutionWebhookSecret: process.env.EVOLUTION_WEBHOOK_SECRET || '',

  // Evolution API — conexão direta (pull de mensagens via cron)
  evolutionApiUrl: process.env.EVOLUTION_API_URL || '',
  evolutionApiKey: process.env.EVOLUTION_API_KEY || '',

  // Bling API v3 — LEGADO (compat com código antigo que não passa contaId)
  // Sempre aponta pra conta padrão "prohunters".
  blingClientId:     process.env.BLING_CLIENT_ID     || '',
  blingClientSecret: process.env.BLING_CLIENT_SECRET || '',
  blingRedirectUri:  process.env.BLING_REDIRECT_URI  || '',

  // Bling API v3 — MULTI-CONTA (novo)
  blingContas: _montarContasBling(),
  blingContaPadrao: 'prohunters', // usada quando não passa contaId explícito

  // WooCommerce — lojas WordPress (afiliados/influenciadores + CRM)
  lojasWoo: _montarLojasWoo(),

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
