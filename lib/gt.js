const bwipjs = require('bwip-js');
const fs = require('fs');
const path = require('path');
const { BoxDoc, PAGE_W, M, CW } = require('./boxDoc');
const companies = require('./companies');

function loadAsset(name) {
  return fs.readFileSync(path.join(__dirname, '..', 'assets', name));
}

function todayBR() {
  const d = new Date();
  return String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0') + '/' + d.getFullYear();
}

function addDaysBR(dateStr, days) {
  const [dd, mm, yyyy] = dateStr.split('/').map(Number);
  const d = new Date(yyyy, mm - 1, dd);
  d.setDate(d.getDate() + days);
  return String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0') + '/' + d.getFullYear();
}

async function barcodePng(text) {
  return bwipjs.toBuffer({ bcid: 'code128', text: String(text || '0'), scale: 2, height: 10, includetext: false });
}

const EMPRESA_ORIGEM = {
  ph: { codigo: '70512', nome: 'PRO HUNTERS COMERCIO DE IMPORTAÇÃO E EXPORTAÇÃO LTDA', cnpj: '12.304.207/0001-39', endereco: 'RUA ANTONIO DA VEIGA, Nº 69 - VICTOR KONDER - Blumenau / SC', telefone: '(47) 99176-1291' },
  cr: { codigo: '247056', nome: 'CALIBRE RESTRITO COMÉRCIO DE IMPORTAÇÃO LTDA', cnpj: '34.760.885/0001-49', endereco: 'RUA ANTÔNIO DA VEIGA 69 - VICTOR KONDER - Blumenau / SC', telefone: '(47) 99176-1291' },
};

const EZEQUIEL = {
  codigo: '77458', nome: 'EZEQUIEL SARTORI', doc: '07.332.384/0001-99',
  endereco: 'RUA TREZE DE MAIO, Nº 215 CASA - CENTRO - Antônio Prado / RS', telefone: '(54) 3298-3432',
};

const CPA_GOLLOG = {
  codigo: '453609', nome: 'C.P.A. SERVIÇOS DE MOVIMENTAÇÃO DE CARGAS', doc: '34.129.851/0001-50',
  endereco: 'AV SEVERO DULLIUS, 90010, ANEXO 06 - ANCHIETA', telefone: '(51) 3374-0055', sfpc: 'SFPC/03',
};

function guiaNumero() {
  const ano = new Date().getFullYear();
  const suf = String(Math.floor(Math.random() * 900) + 100);
  return ano + '00000' + Math.floor(Math.random() * 90000 + 10000) + suf.slice(0, 0); // placeholder, refinado abaixo
}

function gerarNumeroGuia() {
  const ano = new Date().getFullYear();
  const meio = String(Math.floor(Math.random() * 90000000) + 10000000); // 8 dígitos
  return String(ano) + meio.slice(0, 8);
}

async function drawHeader(doc, crestBytes) {
  const crest = await doc.embedImageAuto(crestBytes);
  const scale = 44 / crest.height;
  doc.page.drawImage(crest, { x: M, y: doc.y - 46, width: crest.width * scale, height: 44 });
  doc.text('MINISTÉRIO DA DEFESA', M + 55, doc.y - 10, { size: 10, bold: true });
  doc.text('EXÉRCITO BRASILEIRO', M + 55, doc.y - 21, { size: 10, bold: true });
  doc.text('COMANDO LOGÍSTICO', M + 55, doc.y - 32, { size: 10, bold: true });
  doc.text('DIRETORIA DE FISCALIZAÇÃO DE PRODUTOS CONTROLADOS', M + 55, doc.y - 44, { size: 8, bold: true });
  doc.y -= 60;
  doc.line(M, doc.y, M + CW, doc.y);
  doc.y -= 16;
  const title = 'AUTORIZAÇÃO PARA TRÁFEGO DE PRODUTOS CONTROLADOS';
  const tw = doc.bold.widthOfTextAtSize(title, 12);
  doc.text(title, M + (CW - tw) / 2, doc.y, { size: 12, bold: true });
  doc.y -= 20;
}

function drawPartyBlock(doc, title, p) {
  const h = 60;
  doc.rect(M, doc.y, CW, h);
  doc.text(title, M + 5, doc.y - 11, { size: 8, bold: true });
  let ty = doc.y - 24;
  doc.text((p.codigo ? p.codigo + ' - ' : '') + p.nome, M + 5, ty, { size: 9, bold: true, maxWidth: CW - 10 });
  ty -= 12;
  doc.text('CNPJ/CPF: ' + (p.doc || p.cnpj), M + 5, ty, { size: 8.5 });
  ty -= 12;
  doc.text(p.endereco + (p.telefone ? '  Telefone: ' + p.telefone : ''), M + 5, ty, { size: 8.5, maxWidth: CW - 10 });
  doc.y -= h;
}

function drawDestinatarioBlock(doc, d) {
  const h = 68;
  doc.rect(M, doc.y, CW, h);
  doc.text('DESTINATÁRIO', M + 5, doc.y - 11, { size: 8, bold: true });
  let ty = doc.y - 24;
  doc.text(d.nome, M + 5, ty, { size: 9, bold: true, maxWidth: CW - 10 });
  ty -= 12;
  doc.text('CNPJ/CPF: ' + d.doc, M + 5, ty, { size: 8.5 });
  ty -= 12;
  doc.text(d.endereco + (d.telefone ? '  Telefone: ' + d.telefone : ''), M + 5, ty, { size: 8.5, maxWidth: CW - 10 });
  ty -= 12;
  doc.text('SFPC: ' + d.sfpc, M + 5, ty, { size: 8.5, bold: true });
  doc.y -= h;
}

function drawProductsTable(doc, produtos) {
  const cols = [
    { key: 'produto', label: 'Produto', w: 130, wrap: true },
    { key: 'complemento', label: 'Complemento', w: 125, wrap: true },
    { key: 'unidade', label: 'Unidade', w: 45 },
    { key: 'qtd', label: 'Qtd.', w: 30 },
    { key: 'volume', label: 'Volume', w: 35 },
    { key: 'marca', label: 'Marca', w: 60 },
    { key: 'serie', label: 'Nº Série', w: 90, wrap: true },
  ];
  let x = M;
  const headH = 20;
  cols.forEach(c => {
    doc.rect(x, doc.y, c.w, headH);
    doc.text(c.label, x + 3, doc.y - 13, { size: 7.5, bold: true });
    x += c.w;
  });
  doc.y -= headH;

  produtos.forEach(p => {
    // altura dinâmica: olha a maior quantidade de linhas entre as colunas com quebra de texto
    let maxLines = 1;
    cols.forEach(c => {
      if (c.wrap) {
        const w = doc.font.widthOfTextAtSize(String(p[c.key] || ''), 7.5);
        const lines = Math.ceil(w / (c.w - 6)) || 1;
        if (lines > maxLines) maxLines = lines;
      }
    });
    const rowH = Math.max(26, 10 + maxLines * 9);
    x = M;
    cols.forEach(c => {
      doc.rect(x, doc.y, c.w, rowH);
      if (c.wrap) {
        doc.wrapText(String(p[c.key] || ''), x + 3, doc.y - 10, c.w - 6, { size: 7.5, lineGap: 9 });
      } else {
        doc.text(String(p[c.key] ?? ''), x + 3, doc.y - 14, { size: 7.5, maxWidth: c.w - 6 });
      }
      x += c.w;
    });
    doc.y -= rowH;
  });
  doc.y -= 6;
}


async function drawSeloBarcodeValidade(doc, { seloNumero, assinanteNome, assinanteCargo, dataStr, validadeStr }) {
  const halfW = CW / 2 - 4;
  // linha 1: selo | assinante (com espaço para assinatura física)
  const h1 = 62;
  doc.rect(M, doc.y, halfW, h1);
  doc.text('SELO DE AUTENTICIDADE', M + 5, doc.y - 11, { size: 7.5, bold: true });
  doc.text('OBRIGATÓRIO O USO DO SELO', M + 5, doc.y - 21, { size: 6.5 });
  doc.text('Selo Número: ' + seloNumero, M + 5, doc.y - 40, { size: 9, bold: true });

  const assX = M + halfW + 8;
  doc.rect(assX, doc.y, halfW, h1);
  // linha para assinatura física
  doc.line(assX + 10, doc.y - 14, assX + halfW - 10, doc.y - 14);
  doc.text('Assinatura', assX + 10, doc.y - 24, { size: 6.5, color: undefined });
  doc.text(assinanteNome, assX + 10, doc.y - 40, { size: 9, bold: true });
  doc.text(assinanteCargo, assX + 10, doc.y - 52, { size: 8.5 });
  doc.y -= h1;

  // linha 2: barcode | data
  const h2 = 40;
  doc.rect(M, doc.y, halfW, h2);
  const bcBytes = await barcodePng(seloNumero);
  const bcImg = await doc.embedImageAuto(bcBytes);
  const bcScale = Math.min((halfW - 20) / bcImg.width, 26 / bcImg.height);
  doc.page.drawImage(bcImg, { x: M + 10, y: doc.y - h2 + 8, width: bcImg.width * bcScale, height: bcImg.height * bcScale });
  doc.rect(M + halfW + 8, doc.y, halfW, h2);
  doc.text('Blumenau (SC), ' + dataStr + '.', M + halfW + 13, doc.y - 24, { size: 9 });
  doc.y -= h2;

  // linha 3: validade (centralizada)
  const h3 = 26;
  doc.rect(M, doc.y, CW, h3);
  const validadeTxt = 'Guia de Tráfego Válida até: ' + validadeStr;
  const validadeW = doc.bold.widthOfTextAtSize(validadeTxt, 9);
  doc.text(validadeTxt, M + (CW - validadeW) / 2, doc.y - 17, { size: 9, bold: true });
  doc.y -= h3;
}

async function gerarGTPagina(pdfCommon, data, destinatarios) {
  const { doc, crestBytes } = pdfCommon;
  doc.newPage();
  await drawHeader(doc, crestBytes);

  // linha guia/sfpc/folha
  const w1 = CW * 0.5, w2 = CW * 0.2, w3 = CW * 0.3;
  const hRow = 34;
  doc.field(M, doc.y, w1, hRow, 'NÚMERO DA GUIA', data.numeroGuia, { bold: true });
  doc.field(M + w1, doc.y, w2, hRow, 'SFPC', 'SFPC/05', { bold: true });
  doc.field(M + w1 + w2, doc.y, w3, hRow, 'FOLHA', '1 de 1', { bold: true });
  doc.y -= hRow;

  const hRow2 = 30;
  doc.field(M, doc.y, CW * 0.55, hRow2, 'NOTA FISCAL Nº', data.notaFiscal);
  doc.field(M + CW * 0.55, doc.y, CW * 0.45, hRow2, 'DATA', data.dataEnvio);
  doc.y -= hRow2;

  doc.field(M, doc.y, CW, 26, 'NÚMERO DE VOLUMES', String(data.numeroVolumes || 1));
  doc.y -= 26;
  doc.y -= 6;

  drawPartyBlock(doc, 'EMPRESA DE ORIGEM', EMPRESA_ORIGEM[data.empresa]);
  doc.y -= 4;
  drawPartyBlock(doc, 'TRANSPORTADOR', data.transportador);
  doc.y -= 4;
  destinatarios.forEach(d => { drawDestinatarioBlock(doc, d); doc.y -= 4; });

  drawProductsTable(doc, data.produtos);

  await drawSeloBarcodeValidade(doc, {
    seloNumero: data.seloNumero,
    assinanteNome: companies.representante.nome,
    assinanteCargo: companies.representante.cargo,
    dataStr: data.dataEnvio,
    validadeStr: addDaysBR(data.dataEnvio, 60),
  });

  const emitidoTxt = 'Emitido por: ' + companies.representante.nome.toUpperCase() + ' - ' + data.dataEnvio;
  const emitidoW = doc.font.widthOfTextAtSize(emitidoTxt, 7.5);
  doc.text(emitidoTxt, M + CW - emitidoW, doc.y - 20, { size: 7.5 });
}

function drawVersoGT(doc, data) {
  doc.newPage();
  doc.text('MINISTÉRIO DA DEFESA', M, doc.y - 14, { size: 11, bold: true });
  doc.text('BASE AÉREA DE CANOAS - BACO', M, doc.y - 30, { size: 11, bold: true });
  doc.y -= 60;
  doc.wrapText(
    `Autorizo o transporte por via aérea, no material especificado na Guia de Tráfego nº ${data.numeroGuia}, por atender as condições exigidas, conforme o disposto na Lei nº 11.182/2005 e Decreto nº 5.731/2006`,
    M, doc.y, CW, { size: 10, lineGap: 14 }
  );
  doc.y -= 60;
  doc.text('Trecho: ' + (data.gollog?.trecho || ''), M, doc.y, { size: 10, bold: true });
  doc.y -= 30;
  doc.text('Assinatura e Carimbo:', M, doc.y, { size: 10 });
  doc.y -= 60;
  doc.text('Em: ' + data.dataEnvio, M, doc.y, { size: 10 });
  doc.y -= 40;
  doc.text('- ICA 55-36 – Autorização de voo no Espaço Aéreo Brasileiro, Portaria nº410/GC3, de 22 de julho de 2001', M, doc.y, { size: 8 });
  doc.y -= 12;
  doc.text('- AC 1604-0498 de 16 de abril de 1998', M, doc.y, { size: 8 });
  doc.y -= 12;
  doc.text('- DCAR 709/2009, de 03 de novembro de 2009', M, doc.y, { size: 8 });
}

function drawMinuta(doc, data) {
  const g = data.gollog || {};
  doc.newPage();
  doc.text('MINUTA DE DESPACHO ELETRÔNICA', M, doc.y - 4, { size: 13, bold: true });
  doc.text('www.gollog.com.br', M, doc.y - 18, { size: 9 });
  doc.y -= 36;

  const half = CW / 2 - 6;
  function kv(label, value, x, w) {
    doc.text(label, x, doc.y, { size: 7.5, bold: true, color: undefined });
    doc.text(String(value || ''), x, doc.y - 11, { size: 9, maxWidth: w });
  }

  const rows = [
    [['Forma de Pagamento', g.formaPagamento], ['Tipo de Entrega', g.tipoEntrega]],
    [['Aeroporto para Retirada', g.aeroporto], ['Nº Conta Gollog', g.nContaGollog]],
  ];
  rows.forEach(pair => {
    kv(pair[0][0], pair[0][1], M, half);
    kv(pair[1][0], pair[1][1], M + half + 12, half);
    doc.y -= 30;
  });

  doc.line(M, doc.y, M + CW, doc.y); doc.y -= 14;
  doc.text('REMETENTE', M, doc.y, { size: 9, bold: true });
  doc.text('DESTINATÁRIO', M + half + 12, doc.y, { size: 9, bold: true });
  doc.y -= 16;

  const remetente = EMPRESA_ORIGEM[data.empresa];
  const dest = (data.destinatarios || [])[0] || {};
  const remRows = [
    ['CPF/CNPJ', remetente.cnpj], ['Endereço', remetente.endereco], ['Telefone', remetente.telefone],
  ];
  const destRows = [
    ['CPF/CNPJ', dest.doc], ['Endereço', dest.endereco], ['Telefone', dest.telefone],
  ];
  for (let i = 0; i < remRows.length; i++) {
    kv(remRows[i][0], remRows[i][1], M, half);
    kv(destRows[i][0], destRows[i][1], M + half + 12, half);
    doc.y -= 26;
  }

  doc.line(M, doc.y, M + CW, doc.y); doc.y -= 14;
  const rows2 = [
    ['Tomador do Frete', g.tomadorFrete, 'CNPJ Tomador', g.cnpjTomador],
    ['Nº de Volumes', g.nVolumes, 'Peso Total', g.pesoTotal],
    ['Tipo de Embalagem', g.tipoEmbalagem, 'Produto Predominante', g.produtoPredominante],
    ['Medidas das Embalagens', g.medidasEmbalagens, 'Tipo de Seguro', g.tipoSeguro],
    ['Valor da Mercadoria', g.valorMercadoria, '', ''],
  ];
  rows2.forEach(r => {
    kv(r[0], r[1], M, half);
    if (r[2]) kv(r[2], r[3], M + half + 12, half);
    doc.y -= 26;
  });

  doc.line(M, doc.y, M + CW, doc.y); doc.y -= 20;
  doc.wrapText('Autorizo o(s) embarque(s) do(s) volume(s) relacionado(s), conforme especificações desta minuta.', M, doc.y, CW, { size: 8.5, lineGap: 11 });
  doc.y -= 30;
  kv('Local/Data', g.localData || ('Blumenau, ' + data.dataEnvio), M, half);
  kv('Nome/Responsável', g.nomeResponsavel || companies.representante.nome, M + half + 12, half);
}

async function gerarGT(data) {
  const crestBytes = loadAsset('exercito_brasao.png');
  const doc = new BoxDoc();
  await doc.init();
  doc.page = doc.pdf.getPages()[0]; // primeira página criada no init será substituída
  const pdfCommon = { doc, crestBytes };

  // remove a página inicial vazia do init (vamos criar via newPage dentro de gerarGTPagina)
  const emptyPage = doc.pdf.getPages()[0];

  if (!data.numeroGuia) data.numeroGuia = gerarNumeroGuia();

  // monta transportador conforme variante
  if (data.variante === 'pessoa_fisica') {
    data.transportador = { ...data.destinatarios[0] };
  } else {
    data.transportador = { codigo: EZEQUIEL.codigo, nome: EZEQUIEL.nome, doc: EZEQUIEL.doc, endereco: EZEQUIEL.endereco, telefone: EZEQUIEL.telefone };
  }

  const destinatarios = data.variante === 'ezequiel_gollog'
    ? [data.destinatarios[0], { ...CPA_GOLLOG }]
    : [data.destinatarios[0]];

  await gerarGTPagina(pdfCommon, data, destinatarios);

  if (data.variante === 'ezequiel_gollog') {
    drawVersoGT(doc, data);
    drawMinuta(doc, data);
  }

  // remove a primeira página em branco do init
  doc.pdf.removePage(0);

  const bytes = await doc.save();

  const empresaNome = data.empresa === 'ph' ? 'Pro Hunters' : 'Calibre Restrito';
  const dataFile = todayBR().split('/').reverse().join('-');
  const clienteNome = (data.destinatarios[0].nome || 'cliente').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9 \-]/g, '').trim();
  const filename = `${dataFile} - GT - ${clienteNome} - ${empresaNome}.pdf`;

  return { bytes, filename, numeroGuia: data.numeroGuia };
}

module.exports = { gerarGT, gerarNumeroGuia };
