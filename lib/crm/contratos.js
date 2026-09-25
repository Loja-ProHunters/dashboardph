// lib/crm/contratos.js
// Geração de contratos a partir de templates .docx com variáveis {{xxx}}.
// Usa docxtemplater + pizzip. Templates ficam em crm/contratos/*.docx no GitHub.
// Contratos gerados ficam salvos em crm/contratos/gerados/<partner_id>/<timestamp>.docx
// e no doc do parceiro em `contratos_gerados` (metadata: id, data, valores, path).

const PizZip = require('pizzip');
const Docxtemplater = require('docxtemplater');
const { getFileBinary, saveFileBinary } = require('../githubStore');
const parceirosStore = require('../parceirosStore');

// Templates disponíveis (mapeamento id → path no repo + label + variáveis).
// Pra adicionar novos modelos, sobe o .docx no repo e adiciona uma entrada aqui.
const TEMPLATES = {
  'parceiro-influencer': {
    id: 'parceiro-influencer',
    label: 'Contrato de Parceria com Influenciador',
    path: 'crm/contratos/modelo-parceiro-influencer.docx',
    // Variáveis com metadados pra UI gerar formulário automaticamente
    variaveis: [
      { key: 'nome_parceiro',  label: 'Nome do parceiro',        obrigatorio: true, tipo: 'text' },
      { key: 'cpf_cnpj',       label: 'CPF ou CNPJ',             obrigatorio: true, tipo: 'text',  placeholder: '000.000.000-00' },
      { key: 'endereco',       label: 'Endereço completo',       obrigatorio: true, tipo: 'text',  placeholder: 'Rua, número, bairro, CEP' },
      { key: 'cidade',         label: 'Cidade',                  obrigatorio: true, tipo: 'text' },
      { key: 'uf',             label: 'UF',                      obrigatorio: true, tipo: 'text',  maxlength: 2, upper: true },
      { key: 'tipo_parceiro',  label: 'Tipo de parceiro',        obrigatorio: true, tipo: 'select', opcoes: ['INFLUENCIADOR', 'AFILIADO'] },
      { key: 'pct_cupom',      label: '% de desconto do cupom',  obrigatorio: true, tipo: 'number', sufixo: '%', hint: 'Desconto que os seguidores dele ganham' },
      { key: 'pct_comissao',   label: '% de comissão do parceiro', obrigatorio: true, tipo: 'number', sufixo: '%', hint: 'O que o parceiro recebe por venda' },
      { key: 'dia',            label: 'Dia da assinatura',       obrigatorio: true, tipo: 'text', placeholder: 'ex: 24', default: 'hoje_dia' },
      { key: 'mes',            label: 'Mês da assinatura',       obrigatorio: true, tipo: 'text', placeholder: 'ex: setembro', default: 'hoje_mes' },
      { key: 'ano',            label: 'Ano da assinatura',       obrigatorio: true, tipo: 'text', placeholder: 'ex: 2026',    default: 'hoje_ano' },
    ],
  },
};

const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

function listarTemplates() {
  return Object.values(TEMPLATES).map(t => ({
    id: t.id, label: t.label, variaveis: t.variaveis,
  }));
}

// Retorna o template completo (incluindo path) — uso interno
function getTemplate(templateId) {
  return TEMPLATES[templateId] || null;
}

// Preenche defaults automáticos (data de hoje)
function _resolverDefaults(variaveis, valores) {
  const out = { ...valores };
  const hoje = new Date();
  for (const v of variaveis) {
    if (out[v.key] != null && out[v.key] !== '') continue;
    if (v.default === 'hoje_dia') out[v.key] = String(hoje.getDate()).padStart(2, '0');
    else if (v.default === 'hoje_mes') out[v.key] = MESES[hoje.getMonth()];
    else if (v.default === 'hoje_ano') out[v.key] = String(hoje.getFullYear());
  }
  return out;
}

// Gera o documento .docx substituindo as variáveis.
// Retorna { buffer: Buffer, filename: string }
async function gerar({ templateId, valores }) {
  const tpl = getTemplate(templateId);
  if (!tpl) throw new Error('Template desconhecido: ' + templateId);

  const valoresFinal = _resolverDefaults(tpl.variaveis, valores || {});

  // Valida obrigatórios
  const faltantes = tpl.variaveis
    .filter(v => v.obrigatorio && (valoresFinal[v.key] == null || valoresFinal[v.key] === ''))
    .map(v => v.label);
  if (faltantes.length) throw new Error('Campos obrigatórios faltando: ' + faltantes.join(', '));

  // UF em maiúsculas
  for (const v of tpl.variaveis) {
    if (v.upper && valoresFinal[v.key]) valoresFinal[v.key] = String(valoresFinal[v.key]).toUpperCase();
  }

  // Lê o modelo .docx do GitHub como Buffer
  const templateBuffer = await getFileBinary(tpl.path);
  const zip = new PizZip(templateBuffer);
  const doc = new Docxtemplater(zip, {
    delimiters: { start: '{{', end: '}}' },
    paragraphLoop: true,
    linebreaks: true,
    nullGetter: () => '_______',
  });
  doc.render(valoresFinal);
  const bufferOut = doc.getZip().generate({ type: 'nodebuffer' });

  const partnerNome = String(valoresFinal.nome_parceiro || 'parceiro')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 40);
  const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const filename = 'contrato_' + tpl.id + '_' + partnerNome + '_' + ts + '.docx';

  return { buffer: bufferOut, filename, valores_final: valoresFinal };
}

// Registra metadados do contrato gerado no doc do INFLUENCIADOR (parceiros.json).
// SEMPRE salva o arquivo binário no repo em crm/contratos/gerados/<inf_id>/<filename>.docx
// pra ter histórico consultável depois. O download imediato usa o buffer em memória.
async function registrarNoParceiro({ influenciadorId, templateId, filename, valores, actor, buffer }) {
  if (!influenciadorId) return null;
  const d = await parceirosStore.getParceiros();
  const inf = (d.influenciadores || []).find(x => x.id === influenciadorId);
  if (!inf) return null;

  const registro = {
    id: 'ct_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    template_id: templateId,
    template_label: (TEMPLATES[templateId] || {}).label || templateId,
    gerado_em: new Date().toISOString(),
    gerado_por: actor || null,
    filename,
    valores: {
      nome_parceiro: valores.nome_parceiro || null,
      cpf_cnpj: valores.cpf_cnpj || null,
      tipo_parceiro: valores.tipo_parceiro || null,
      pct_cupom: valores.pct_cupom || null,
      pct_comissao: valores.pct_comissao || null,
      endereco: valores.endereco || null,
      cidade: valores.cidade || null,
      uf: valores.uf || null,
    },
    arquivo_path: null,
  };

  // Salva o docx binário no repo pra download futuro
  if (buffer) {
    try {
      const p = 'crm/contratos/gerados/' + influenciadorId + '/' + filename;
      await saveFileBinary(p, buffer, 'Contrato gerado: ' + filename);
      registro.arquivo_path = p;
    } catch (e) { /* falha ao salvar arquivo não bloqueia o registro */ }
  }

  inf.contratos_gerados = Array.isArray(inf.contratos_gerados) ? inf.contratos_gerados : [];
  inf.contratos_gerados.unshift(registro);
  if (inf.contratos_gerados.length > 50) inf.contratos_gerados = inf.contratos_gerados.slice(0, 50);
  // Também guarda o "último contrato" no nível raiz do inf pra facilitar UI
  inf.ultimo_contrato_em = registro.gerado_em;
  await parceirosStore.saveParceiros(d);
  return registro;
}

// Busca um contrato gerado no histórico e retorna o buffer pra download
async function buscarContratoGerado(influenciadorId, contratoId) {
  const d = await parceirosStore.getParceiros();
  const inf = (d.influenciadores || []).find(x => x.id === influenciadorId);
  if (!inf) return null;
  const rec = (inf.contratos_gerados || []).find(c => c.id === contratoId);
  if (!rec || !rec.arquivo_path) return null;
  const buffer = await getFileBinary(rec.arquivo_path);
  return { registro: rec, buffer };
}

module.exports = { listarTemplates, getTemplate, gerar, registrarNoParceiro, buscarContratoGerado, TEMPLATES };
