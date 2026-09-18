// lib/crm/marcas.js
// Base de marcas fortes da Pro Hunters + classificação por tier e categoria.
// Usado pelo motor de sugestão (sugerir.js) pra:
//   - Ajudar a IA a raciocinar sobre coerência ("cliente comprou Weatherby →
//     não faz sentido sugerir munição no-name")
//   - Expandir shortlist de candidatos por marca/ecossistema
//   - Detectar perfil do cliente (premium / mainstream / volume)
//
// Fonte: lista aprovada pelo Luis (Pro Hunters). Novas marcas devem entrar aqui
// com tier + categoria pra a IA usar corretamente.

// tier: 'premium' (top de linha), 'mainstream' (marcas fortes de volume),
//       'volume' (munição/consumíveis)
// categoria: 'arma_curta' | 'arma_longa' | 'arma_ar_comprimido' | 'municao' |
//            'optica' | 'acessorio' | 'faca' | 'iluminacao' | 'recarga'

const MARCAS = {
  // ── Armas de fogo — premium ───────────────────────────────────
  'weatherby':      { tier: 'premium',    categorias: ['arma_longa'] },
  'ruger':          { tier: 'premium',    categorias: ['arma_curta','arma_longa'] },
  'colt':           { tier: 'premium',    categorias: ['arma_curta'] },
  'tanfoglio':      { tier: 'premium',    categorias: ['arma_curta'] },
  'glock':          { tier: 'premium',    categorias: ['arma_curta'] },
  'cz':             { tier: 'premium',    categorias: ['arma_curta','arma_longa'] },
  'huglu':          { tier: 'premium',    categorias: ['arma_longa'] },
  'anschutz':       { tier: 'premium',    categorias: ['arma_longa'] },
  'bergara':        { tier: 'premium',    categorias: ['arma_longa'] },
  'aselkon':        { tier: 'premium',    categorias: ['arma_ar_comprimido'] },
  'akar':           { tier: 'premium',    categorias: ['arma_longa'] },

  // ── Armas de fogo — mainstream ────────────────────────────────
  'taurus':         { tier: 'mainstream', categorias: ['arma_curta','arma_longa'] },

  // ── Óptica (miras, red dots, lunetas) ─────────────────────────
  'vector optics':  { tier: 'premium',    categorias: ['optica'] },
  'gpo':            { tier: 'premium',    categorias: ['optica'] },
  'fire eagle':     { tier: 'mainstream', categorias: ['optica'] },
  'bélica':         { tier: 'mainstream', categorias: ['optica'] },
  'belica':         { tier: 'mainstream', categorias: ['optica'] },
  'warfare':        { tier: 'mainstream', categorias: ['optica'] },

  // ── Munição / consumíveis (alta rotação) ──────────────────────
  'cbc':            { tier: 'volume',     categorias: ['municao'] },
  'cci':            { tier: 'volume',     categorias: ['municao'] },
  'hornady':        { tier: 'premium',    categorias: ['municao','recarga'] },
  'federal':        { tier: 'volume',     categorias: ['municao'] },
  'remington':      { tier: 'mainstream', categorias: ['municao','arma_longa'] },
  'fiocchi':        { tier: 'mainstream', categorias: ['municao'] },

  // ── Acessórios táticos / MOLLE / equipamentos ─────────────────
  'mag pull':       { tier: 'premium',    categorias: ['acessorio'] },
  'magpul':         { tier: 'premium',    categorias: ['acessorio'] },
  'ntk':            { tier: 'mainstream', categorias: ['acessorio'] },
  'eternal':        { tier: 'mainstream', categorias: ['acessorio'] },
  'extreme hunter': { tier: 'mainstream', categorias: ['acessorio'] },
  'atta':           { tier: 'mainstream', categorias: ['acessorio'] },
  'revint':         { tier: 'mainstream', categorias: ['acessorio'] },

  // ── Facas e ferramentas ───────────────────────────────────────
  'ruike':          { tier: 'premium',    categorias: ['faca'] },

  // ── Iluminação tática (já tem compat estruturada) ─────────────
  'fenix':          { tier: 'premium',    categorias: ['iluminacao'] },
};

// Normaliza texto de marca pra chave do MARCAS (lowercase + trim)
function normalizar(nome) {
  return String(nome || '').toLowerCase().trim();
}

// Retorna metadados da marca. Marca desconhecida = { tier: 'desconhecido', categorias: [] }
function getMeta(nome) {
  const k = normalizar(nome);
  if (!k) return { tier: 'desconhecido', categorias: [] };
  // Tenta match exato
  if (MARCAS[k]) return { marca: k, ...MARCAS[k] };
  // Tenta match parcial (marca contém a chave)
  for (const [key, meta] of Object.entries(MARCAS)) {
    if (k.includes(key) || key.includes(k)) return { marca: key, ...meta };
  }
  return { tier: 'desconhecido', categorias: [] };
}

// Lista de todas as marcas fortes, agrupadas por categoria
function listaAgrupada() {
  const out = {};
  for (const [nome, m] of Object.entries(MARCAS)) {
    for (const c of m.categorias) {
      if (!out[c]) out[c] = [];
      out[c].push({ marca: nome, tier: m.tier });
    }
  }
  return out;
}

// Retorna perfil do cliente baseado nas marcas que ele já comprou
// { tier_predominante, marcas_compradas: [...], categorias: [...] }
function perfilDoCliente(itensComprados) {
  const tiers = { premium: 0, mainstream: 0, volume: 0, desconhecido: 0 };
  const marcasSet = new Set();
  const catSet = new Set();
  for (const it of (itensComprados || [])) {
    const nome = it.marca || it.catalogo?.marca || _detectarMarca(it.descricao || it.nome || '');
    const meta = getMeta(nome);
    tiers[meta.tier || 'desconhecido']++;
    if (meta.marca) marcasSet.add(meta.marca);
    for (const c of (meta.categorias || [])) catSet.add(c);
  }
  const tierPred = Object.entries(tiers).sort((a,b)=>b[1]-a[1])[0][0];
  return {
    tier_predominante: tierPred,
    marcas_compradas: [...marcasSet],
    categorias: [...catSet],
    distribuicao: tiers,
  };
}

// Heurística: tenta detectar marca pelo texto da descrição
function _detectarMarca(texto) {
  const t = String(texto || '').toLowerCase();
  for (const marca of Object.keys(MARCAS)) {
    if (t.includes(marca)) return marca;
  }
  return null;
}

module.exports = {
  MARCAS,
  normalizar,
  getMeta,
  listaAgrupada,
  perfilDoCliente,
  detectarMarca: _detectarMarca,
};
