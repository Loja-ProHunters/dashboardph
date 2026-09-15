// lib/crm/docsSchemas.js
// Um objeto por tipo de documento suportado. Contém:
//  - prompt: system prompt específico pra IA extrair só os campos daquele tipo
//  - campos: whitelist dos campos que serão persistidos (o resto é descartado)
//  - build(dados) : valida + normaliza + retorna doc pronto pra collections.js
//
// Adicionar novo tipo (Aptidão, SFPC-PJ, Contrato Social) é só adicionar
// uma nova entrada em TIPOS. O resto do CRM (roteador, UI, alertas) usa isso
// como fonte da verdade — não precisa mexer em mais nada.

// ── CR (Certificado de Registro CAC) ─────────────────────────────
const CR = {
  label: 'CR — Certificado de Registro CAC',
  prompt: `Você extrai dados de um "Certificado de Registro" emitido pelo Exército Brasileiro (Ministério da Defesa) pra CAC (Caçador, Atirador, Colecionador).

Extraia SÓ estes campos, retornando JSON puro sem markdown:
{
  "numero_cr": "número no formato oficial (ex: 000.031.395-57)",
  "validade": "AAAA-MM-DD",
  "titular_nome": "nome completo como está escrito",
  "cpf": "só dígitos (ex: 07571689813)",
  "sfpc_vinculacao": "ex: 'Cmdo 2ª RM' ou similar",
  "orgao_emissor": "ex: 'SFPC - 6ª CSM, Bauru/SP'",
  "data_emissao": "AAAA-MM-DD (data em que o doc foi assinado)",
  "atividades_cac": ["tiro_desportivo" | "caca" | "colecionismo"],
  "hash_autenticidade": "hash SisGCOrp se aparecer (ou null)",
  "amparo_legal": "texto curto (ou null)",
  "avisos": ["qualquer observação que valha a pena registrar"]
}

Regras:
- CPF: só os 11 dígitos, sem pontos/traços.
- Datas em ISO (AAAA-MM-DD).
- atividades_cac: array; identifique a partir de textos como "Tiro Desportivo — Atirador Desportivo" (→ "tiro_desportivo"), "Caçador Excepcional" (→ "caca"), "Colecionador" (→ "colecionismo"). Um mesmo CR pode ter várias atividades.
- Se não encontrar um campo, use null (não invente).
- Se não conseguir ler algum campo com clareza, coloque em "avisos".`,
  campos: ['numero_cr','validade','titular_nome','cpf','sfpc_vinculacao','orgao_emissor','data_emissao','atividades_cac','hash_autenticidade','amparo_legal','avisos'],
  campoValidade: 'validade',
  campoNumero: 'numero_cr',
  labelResumo: (d) => 'CR ' + (d.numero_cr || '?'),
};

// ── CRAF (Certificado de Registro de Arma de Fogo) ───────────────
const CRAF = {
  label: 'CRAF — Certificado de Registro de Arma de Fogo',
  prompt: `Você extrai dados de um "Certificado de Registro de Arma de Fogo" (CRAF) emitido pelo Exército Brasileiro (Ministério da Defesa) ou pela Polícia Federal.

Extraia SÓ estes campos, retornando JSON puro sem markdown:
{
  "numero_registro": "ex: 'BR NR 4 DE 09/04/2014, 6ª CSM'",
  "arma_tipo": "ex: 'Carabina / Fuzil', 'Pistola', 'Revólver', 'Espingarda'",
  "arma_marca": "ex: 'CBC', 'Taurus', 'Glock'",
  "arma_modelo": "campo do doc, se aparecer (ou null — CRAF nem sempre tem)",
  "arma_calibre": "ex: '.22 LR', '.380 ACP', '9mm', 'calibre 12'",
  "arma_numero_serie": "número de série da arma (chave única)",
  "arma_numero_sigma": "número SIGMA (ou null)",
  "data_expedicao": "AAAA-MM-DD",
  "validade": "AAAA-MM-DD (campo 'Validade do CRAF')",
  "titular_nome": "nome do titular",
  "cpf": "só dígitos",
  "titular_rg": "RG do titular (ou null)",
  "titular_rg_orgao": "órgão emissor do RG (ex: SSP/SP)",
  "assinado_por": "nome de quem assinou (ex: 'Marcelo Franco - Ten Cel')",
  "orgao_emissor": "ex: 'SFPC' ou 'Polícia Federal'",
  "avisos": []
}

Regras:
- Se algum campo não estiver visível ou legível, retorne null.
- CPF só os 11 dígitos.
- Datas em ISO (AAAA-MM-DD).
- arma_numero_serie é a informação mais crítica: sem ela não conseguimos criar a arma no sistema. Se ilegível, coloque null e explique em avisos.`,
  campos: ['numero_registro','arma_tipo','arma_marca','arma_modelo','arma_calibre','arma_numero_serie','arma_numero_sigma','data_expedicao','validade','titular_nome','cpf','titular_rg','titular_rg_orgao','assinado_por','orgao_emissor','avisos'],
  campoValidade: 'validade',
  campoNumero: 'numero_registro',
  labelResumo: (d) => 'CRAF ' + [d.arma_marca, d.arma_calibre].filter(Boolean).join(' ') + (d.arma_numero_serie ? ' · série ' + d.arma_numero_serie : ''),
};

// ── CNH (Carteira Nacional de Habilitação) ───────────────────────
const CNH = {
  label: 'CNH — Carteira Nacional de Habilitação',
  prompt: `Você extrai dados de uma "Carteira Nacional de Habilitação" (CNH) brasileira.

Extraia SÓ estes campos, retornando JSON puro sem markdown:
{
  "titular_nome": "nome completo",
  "titular_rg": "número do documento de identidade (só dígitos)",
  "titular_rg_orgao": "órgão emissor do RG (ex: 'SSP/SP')",
  "cpf": "só dígitos",
  "titular_data_nascimento": "AAAA-MM-DD",
  "filiacao_mae": "nome",
  "filiacao_pai": "nome",
  "categoria": "ex: 'A', 'B', 'AB', 'C', 'D', 'E' (Cat. Hab.)",
  "numero_registro": "N° Registro da CNH",
  "validade": "AAAA-MM-DD",
  "data_primeira_habilitacao": "AAAA-MM-DD (1ª Habilitação)",
  "local_emissao": "cidade, UF",
  "data_emissao": "AAAA-MM-DD",
  "orgao_emissor": "ex: 'Detran-SP'",
  "codigos_seguranca": ["lista dos códigos de segurança que aparecem"],
  "avisos": []
}

Regras:
- CPF: só 11 dígitos.
- Datas em ISO.
- Se algum campo estiver tarjado/em branco (comum em permissão/ACC), retorne null.`,
  campos: ['titular_nome','titular_rg','titular_rg_orgao','cpf','titular_data_nascimento','filiacao_mae','filiacao_pai','categoria','numero_registro','validade','data_primeira_habilitacao','local_emissao','data_emissao','orgao_emissor','codigos_seguranca','avisos'],
  campoValidade: 'validade',
  campoNumero: 'numero_registro',
  labelResumo: (d) => 'CNH ' + (d.categoria || '') + ' ' + (d.numero_registro || ''),
};

// ── Registry ─────────────────────────────────────────────────────
const TIPOS = { cr: CR, craf: CRAF, cnh: CNH };

// Prompt do classificador — quando o usuário sobe um doc sem dizer o tipo
const CLASSIFIER_PROMPT = `Você recebe uma imagem ou PDF de um documento brasileiro relacionado a CAC (Caçador/Atirador/Colecionador). Retorne apenas um JSON:
{ "tipo": "cr" | "craf" | "cnh" | "desconhecido", "motivo": "por que classificou assim (uma frase curta)" }

Regras:
- "cr" → "Certificado de Registro" (CAC) emitido pelo Exército Brasileiro / SFPC. Cabeçalho fala em "Ministério da Defesa" e "Certificado de Registro" (sem "de Arma de Fogo"). Tem QR Code.
- "craf" → "Certificado de Registro de Arma de Fogo" emitido pelo Exército ou PF. Menciona tipo/marca/calibre/nº série da arma. Duas metades (esquerda: dados do titular; direita: dados da arma).
- "cnh" → "Carteira Nacional de Habilitação" — Departamento Nacional de Trânsito / Detran, com foto do titular e "CAT. HAB.".
- "desconhecido" → qualquer outra coisa.`;

// Status de vencimento de qualquer documento com "validade"
// Retorna { status, dias_pra_vencer } — usado tanto pra badge visual quanto pro cron
function calcularStatusValidade(validadeIso, hoje) {
  hoje = hoje || new Date();
  if (!validadeIso) return { status: 'sem_validade', dias_pra_vencer: null };
  const venc = new Date(validadeIso + 'T00:00:00');
  if (isNaN(venc.getTime())) return { status: 'sem_validade', dias_pra_vencer: null };
  const dias = Math.floor((venc - hoje) / 86400000);
  if (dias < 0)    return { status: 'vencido',      dias_pra_vencer: dias };
  if (dias <= 30)  return { status: 'critico',      dias_pra_vencer: dias };
  if (dias <= 60)  return { status: 'vence_em_60',  dias_pra_vencer: dias };
  if (dias <= 90)  return { status: 'vence_em_90',  dias_pra_vencer: dias };
  return { status: 'em_dia', dias_pra_vencer: dias };
}

// Filtra um objeto extraído da IA pelos campos permitidos daquele tipo
function normalizarExtraido(tipo, bruto) {
  const t = TIPOS[tipo];
  if (!t) throw new Error('Tipo de documento desconhecido: ' + tipo);
  const out = {};
  for (const k of t.campos) {
    if (bruto[k] !== undefined) out[k] = bruto[k];
  }
  return out;
}

module.exports = {
  TIPOS,
  CLASSIFIER_PROMPT,
  calcularStatusValidade,
  normalizarExtraido,
};
