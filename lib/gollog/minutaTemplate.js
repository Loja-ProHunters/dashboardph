// lib/gollog/minutaTemplate.js
// Preenche o template oficial PDF da Gollog (Minuta de Despacho Eletrônica)
// usando pdf-lib. Substitui a antiga função drawMinuta() do lib/gt.js que
// tentava desenhar do zero e não batia 100% com o padrão da Gollog.
//
// Estratégia:
//   1. Carrega `assets/gollog-minuta-template.pdf` (o PDF em branco oficial)
//   2. Reconstrói o /AcroForm no /Root (o template vem com AcroForm órfão —
//      as widgets estão nas páginas mas o dict global foi despido por
//      processamento anterior)
//   3. Preenche os 47 campos AcroForm com os dados
//   4. Devolve os bytes do PDF, prontos pra serem mesclados ao output final
//
// O resultado é BYTES do PDF oficial da Gollog, apenas com os valores
// preenchidos. Layout, fontes, diagramação — tudo idêntico ao original.

const fs = require('fs');
const path = require('path');
const { PDFDocument, PDFName, PDFBool, StandardFonts } = require('pdf-lib');

const TEMPLATE_PATH = path.join(__dirname, '..', '..', 'assets', 'gollog-minuta-template.pdf');

// ── Valores FIXOS conforme regra de negócio Pro Hunters/Calibre Restrito ──
const FIXOS = {
  tipoEntrega: 'RETIRA AEROPORTO',
  formaPagamento: 'FRETE A COBRAR',
  nomeResponsavel: 'Luis Henrique Gonçalves',
  tipoSeguro: 'proprio', // sempre "Próprio"
  servicoGollog: 'URGENTE', // padrão comercial da Pro Hunters
};

// ── Dados fixos das empresas de origem (remetente) ────────────
const EMPRESAS = {
  ph: {
    nomeMinuta: 'Pro Hunters',
    cnpj: '12.304.207/0001-39',
    endereco: 'Rua Antonio da Veiga N 69',
    complemento: 'Primeiro Andar',
    fone: '(47) 99176-1291',
    bairro: 'Victor Konder',
    uf: 'SC',
    cep: '89012-500',
    cidade: 'Blumenau',
    email: 'loja.prohunters@gmail.com',
  },
  cr: {
    nomeMinuta: 'Calibre Restrito',
    cnpj: '34.760.885/0001-49',
    endereco: 'Rua Antônio da Veiga 69',
    complemento: 'Primeiro Andar',
    fone: '(47) 99176-1291',
    bairro: 'Victor Konder',
    uf: 'SC',
    cep: '89012-500',
    cidade: 'Blumenau',
    email: 'loja.prohunters@gmail.com',
  },
};

// ── Reconstrói AcroForm dict no /Root a partir das widgets ────
function reconstruirAcroForm(pdf) {
  const pages = pdf.getPages();
  const widgetRefs = [];
  for (const page of pages) {
    const annots = page.node.Annots();
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      const ref = annots.get(i);
      const obj = pdf.context.lookup(ref);
      if (!obj) continue;
      const subtype = obj.get(PDFName.of('Subtype'));
      const T = obj.get(PDFName.of('T'));
      if (subtype && subtype.toString() === '/Widget' && T) {
        widgetRefs.push(ref);
      }
    }
  }
  const acro = pdf.context.obj({
    Fields: widgetRefs,
    NeedAppearances: PDFBool.True,
  });
  const acroRef = pdf.context.register(acro);
  pdf.catalog.set(PDFName.of('AcroForm'), acroRef);
  return widgetRefs.length;
}

// ── Helpers de acesso seguro ─────────────────────────────────
function setText(form, name, value) {
  try {
    const f = form.getTextField(name);
    if (value == null || value === '') return;
    f.setText(String(value));
  } catch (e) { /* campo pode não existir — ignora silenciosamente */ }
}

function setDropdown(form, name, value) {
  try {
    const f = form.getDropdown(name);
    if (!value) return;
    const opts = f.getOptions();
    // aceita match case-insensitive ou substring
    const alvo = String(value).toUpperCase().trim();
    const match = opts.find(o => String(o).toUpperCase().trim() === alvo)
               || opts.find(o => String(o).toUpperCase().includes(alvo));
    if (match) f.select(match);
  } catch (e) { /* ignora */ }
}

function setCheck(form, name, checked) {
  try {
    const f = form.getCheckBox(name);
    if (checked) f.check(); else f.uncheck();
  } catch (e) { /* ignora */ }
}

// ── Parser completo de endereço vindo da NF ─────────────────
// Aceita formatos como:
//   "Rua do Farol, 1301, Sao Marcos, São Luís - MA, CEP 65.077-450"
//   "Av. Paulista, 1000, Apto 42, Bela Vista, São Paulo - SP, CEP 01310-100"
//   "Rua X, 100 - Bairro Y - Cidade/UF - 12345-678"
// Retorna: { logradouro, numero, complemento, bairro, cidade, uf, cep }
function parseEndereco(str) {
  const out = { logradouro: '', numero: '', complemento: '', bairro: '', cidade: '', uf: '', cep: '' };
  if (!str) return out;
  let s = String(str).trim();

  // 1) CEP — remove e guarda (aceita "65.077-450", "65077-450", "65077450", "CEP 12345-678")
  const cepMatch = s.match(/(?:CEP[\s.]*)?(\d{2})[.\s]?(\d{3})[-\s]?(\d{3})/i);
  if (cepMatch) {
    out.cep = cepMatch[1] + cepMatch[2] + '-' + cepMatch[3];
    s = s.replace(cepMatch[0], '').replace(/,\s*,/g, ',').replace(/^\s*,\s*|\s*,\s*$/g, '').trim();
  }

  // 2) Cidade - UF (pode ser "Cidade - UF" ou "Cidade/UF")
  const cidUfMatch = s.match(/,?\s*([A-Za-zÀ-ÿ\s.'`-]+?)\s*[-–\/]\s*([A-Z]{2})\b\s*,?/);
  if (cidUfMatch) {
    out.cidade = cidUfMatch[1].trim().replace(/^,\s*|\s*,$/g, '');
    out.uf = cidUfMatch[2];
    s = s.replace(cidUfMatch[0], ',').replace(/,\s*,/g, ',').replace(/^\s*,\s*|\s*,\s*$/g, '').trim();
  }

  // 3) O que restou é logradouro/número/complemento/bairro separados por vírgula ou hífen
  //    Normaliza hífens em vírgulas pra split uniforme
  const partes = s.split(/,|\s+-\s+/).map(p => p.trim()).filter(Boolean);

  // Estratégia:
  //   1 parte  → tudo em logradouro
  //   2 partes → [logradouro, bairro] OU [logradouro+número, bairro]
  //              (se a 2ª parte for só número, é [logradouro, número])
  //   3 partes → [logradouro, número, bairro]
  //   4+ partes → [logradouro, número, complemento, bairro (última)]
  if (partes.length === 1) {
    out.logradouro = partes[0];
  } else if (partes.length === 2) {
    // Se a segunda parte é só número: [logradouro, número]
    if (/^\d+[a-zA-Z]?$/.test(partes[1])) {
      out.logradouro = partes[0];
      out.numero = partes[1];
    } else {
      out.logradouro = partes[0];
      out.bairro = partes[1];
    }
  } else if (partes.length === 3) {
    out.logradouro = partes[0];
    out.numero = /^\d+[a-zA-Z]?$/.test(partes[1]) ? partes[1] : '';
    out.bairro = out.numero ? partes[2] : partes[1] + ', ' + partes[2];
    if (!out.numero) out.numero = '';
  } else {
    // 4+ partes: logradouro, número, complemento(s), bairro
    out.logradouro = partes[0];
    out.numero = /^\d+[a-zA-Z]?$/.test(partes[1]) ? partes[1] : '';
    out.bairro = partes[partes.length - 1];
    // Complementos = o que sobrar no meio (partes 2..N-2 se número foi extraído; 1..N-2 senão)
    const start = out.numero ? 2 : 1;
    const end = partes.length - 1;
    out.complemento = partes.slice(start, end).join(', ');
  }

  // Se o número não foi extraído mas o logradouro termina com número, separa
  if (!out.numero && out.logradouro) {
    const m = out.logradouro.match(/^(.+?)[,\s]+(\d+[a-zA-Z]?)$/);
    if (m) { out.logradouro = m[1].trim(); out.numero = m[2]; }
  }

  return out;
}

// Compat: helpers antigos ainda usados por códigos externos
function extrairCEP(str) { return parseEndereco(str).cep || null; }
function extrairCidadeUF(str) {
  const p = parseEndereco(str);
  return { cidade: p.cidade || null, uf: p.uf || null };
}

// ── Classifica cada produto da GT em uma das 4 categorias oficiais ──
// (mesma lógica que o gt.js usa pro filename, mas com nomes completos com
// acento que vão pro campo Produto Predominante da Minuta Gollog).
function classificarProduto(p) {
  const texto = ((p.produto || '') + ' ' + (p.complemento || '')).toLowerCase();
  if (texto.includes('recarga') || texto.includes('material de recarga')) return 'Material de Recarga';
  if (texto.includes('insumo')) return 'Insumo';
  if (texto.includes('muni') || texto.includes('cartucho') || texto.includes('espoleta') || texto.includes('propelente') || texto.includes('pólvora') || texto.includes('polvora')) return 'Munição';
  if (texto.includes('arma') || texto.includes('pistola') || texto.includes('carabina') || texto.includes('rifle') || texto.includes('revólver') || texto.includes('revolver') || texto.includes('espingarda')) return 'Arma';
  return 'Produto';
}

function classificarProdutos(produtos) {
  if (!produtos || !produtos.length) return '';
  const tipos = new Set();
  for (const p of produtos) tipos.add(classificarProduto(p));
  // Ordem canônica pra ficar sempre igual: Arma, Munição, Material de Recarga, Insumo, Produto
  const ordem = ['Arma', 'Munição', 'Material de Recarga', 'Insumo', 'Produto'];
  return ordem.filter(t => tipos.has(t)).join(' / ');
}

// ── Preenche o PDF template ─────────────────────────────────
async function gerar(data) {
  const g = data.gollog || {};
  const empKey = data.empresa === 'cr' ? 'cr' : 'ph';
  const emp = EMPRESAS[empKey];
  const dest = (data.destinatarios || [])[0] || {};

  // Produto predominante — classificação padrão da GT:
  // Arma / Munição / Insumo / Material de Recarga. Se tiver mais de um
  // tipo no pedido, junta com " / " (ex: "Arma / Munição").
  const produtoPredominante = g.produtoPredominante ||
    classificarProdutos(data.produtos || []);

  // Valor da mercadoria — da NF ou explícito
  const valorMercadoria = g.valorMercadoria || data.valorTotal || data.valorNF || '';

  // Endereço do destinatário — quebra em partes pra preencher cada campo
  const destParsed = parseEndereco(dest.endereco || '');
  // Junta logradouro + número → "Rua do Farol, 1301" pro campo Endereço
  const destEndereco = dest.logradouro || (destParsed.logradouro + (destParsed.numero ? ', ' + destParsed.numero : '')).trim();
  const destComplemento = dest.complemento || destParsed.complemento || '';
  const destBairro = dest.bairro || destParsed.bairro || '';
  const destCep = dest.cep || destParsed.cep || '';
  const destCidade = dest.cidade || destParsed.cidade || '';
  const destUf = dest.uf || destParsed.uf || '';

  // Carrega template
  const bytes = fs.readFileSync(TEMPLATE_PATH);
  const pdf = await PDFDocument.load(bytes);
  reconstruirAcroForm(pdf);

  const form = pdf.getForm();

  // ── DROPDOWNS ─────────────────────────────────────
  setDropdown(form, 'servico gollog',      g.servicoGollog || FIXOS.servicoGollog);
  setDropdown(form, 'tipo de entrga',      FIXOS.tipoEntrega);       // fixo
  setDropdown(form, 'FORMA PAGAMENTO',     FIXOS.formaPagamento);    // fixo
  setDropdown(form, 'tipi de embalagem',   g.tipoEmbalagem || '');

  // ── CABEÇALHO ────────────────────────────────────
  setText(form, 'NUMERO COTACAO',          g.numeroCotacao || '');
  setText(form, 'Valor do frete',          g.valorFrete || '');
  setText(form, 'Aeroporto para Retirada', g.aeroporto || '');

  // ── REMETENTE (empresa Pro Hunters ou Calibre Restrito) ─
  setText(form, 'Remetente',   emp.nomeMinuta);
  setText(form, 'CPF  CNPJ',   emp.cnpj);
  setText(form, 'Endereço',    emp.endereco);
  setText(form, 'Complemento', emp.complemento);
  setText(form, 'Fone',        emp.fone);
  setText(form, 'Bairro',      emp.bairro);
  setText(form, 'UF',          emp.uf);
  setText(form, 'CEP',         emp.cep);
  setText(form, 'Cidade',      emp.cidade);
  setText(form, 'email 1',     emp.email);

  // ── DESTINATÁRIO (da NF, endereço quebrado em partes) ──
  setText(form, 'Destinatário',  dest.nome || '');
  setText(form, 'CPF  CNPJ_2',   dest.doc || '');
  setText(form, 'Endereço_2',    destEndereco);
  setText(form, 'Complemento_2', destComplemento);
  setText(form, 'Fone_2',        dest.telefone || '');
  setText(form, 'Bairro_2',      destBairro);
  setText(form, 'UF_2',          destUf);
  setText(form, 'CEP_2',         destCep);
  setText(form, 'Cidade_2',      destCidade);
  setText(form, 'email 2',       dest.email || '');

  // ── FRETE ────────────────────────────────────────
  setText(form, 'tomador de frete', emp.nomeMinuta);
  setText(form, 'CNPJ',             emp.cnpj);
  setText(form, 'N Conta Gollog',   g.nContaGollog || '');

  // ── CARGA ────────────────────────────────────────
  setText(form, 'N de Volumes',    g.nVolumes || String(data.numeroVolumes || ''));
  setText(form, 'Peso Total',      g.pesoTotal || '');
  setText(form, 'medidas',         g.medidasEmbalagens || '');
  setText(form, 'PRODUTO',         produtoPredominante);
  setText(form, 'Artigo Perigoso UN', g.artigoPerigoso || '');
  setText(form, 'notas fiscais',   String(data.notaFiscal || ''));

  // ── SEGURO (fixo: Próprio) ───────────────────────
  setText(form, 'N de Apolice',       g.numApolice || '');
  setText(form, 'Seguradora',         g.seguradora || '');
  setText(form, 'Valor da Mercadoria', valorMercadoria);
  // Radio "Próprio" está em widgets sem nome — o AcroForm original marca
  // por padrão. Não mexemos (deixa como veio no template, que é "Próprio").

  // ── AUTORIZAÇÃO (checkbox já vem marcado no template) ──
  setCheck(form, 'Autorizo os embarques dos volumes relacionados conforme especificações desta minuta', true);

  // ── RODAPÉ ───────────────────────────────────────
  const localData = g.localData || (emp.cidade + ', ' + (data.dataEnvio || ''));
  setText(form, 'local e data', localData);
  setText(form, 'nome rep1',    FIXOS.nomeResponsavel);

  // ── FLATTEN (achata o form pra ninguém editar depois) ─
  // Precisa embed a fonte Helvetica antes, senão pdf-lib erra com
  // "Font dictionary for /Helv not found" em alguns viewers.
  try {
    const helv = await pdf.embedFont(StandardFonts.Helvetica);
    form.updateFieldAppearances(helv);
  } catch (e) { /* segue mesmo se falhar */ }
  form.flatten();

  return pdf.save();
}

// ── Merge do PDF preenchido no doc principal (BoxDoc) ────────
// Chama gerar(data) e copia a página resultante pro pdf-lib do BoxDoc.
// Assim a Minuta Gollog vira a 3ª página do PDF final (GT + Verso + Minuta).
async function mergirNoDoc(boxDoc, data) {
  const minutaBytes = await gerar(data);
  const minutaPdf = await PDFDocument.load(minutaBytes);
  const [page] = await boxDoc.pdf.copyPages(minutaPdf, [0]);
  boxDoc.pdf.addPage(page);
}

module.exports = { gerar, mergirNoDoc, FIXOS, EMPRESAS };
