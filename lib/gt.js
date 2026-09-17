const bwipjs = require('bwip-js');
const fs = require('fs');
const path = require('path');
const { BoxDoc, PAGE_W, PAGE_H, M, CW } = require('./boxDoc');
const companies = require('./companies');
const minutaGollog = require('./gollog/minutaTemplate');

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
  ph: {
    codigo: '70512', nome: 'PRO HUNTERS COMERCIO DE IMPORTAÇÃO E EXPORTAÇÃO LTDA',
    cnpj: '12.304.207/0001-39', endereco: 'RUA ANTONIO DA VEIGA, Nº 69 - VICTOR KONDER - Blumenau / SC',
    telefone: '(47) 99176-1291',
    nomeMinuta: 'Pro Hunters', rua: 'Rua Antonio da Veiga N 69',
    complemento: 'Primeiro Andar', fone: '(47) 99176-1291',
    bairro: 'Victor Konder', uf: 'SC', cep: '89012500',
    cidade: 'Blumenau', email: 'loja.prohunters@gmail.com',
  },
  cr: {
    codigo: '247056', nome: 'CALIBRE RESTRITO COMÉRCIO DE IMPORTAÇÃO LTDA',
    cnpj: '34.760.885/0001-49', endereco: 'RUA ANTÔNIO DA VEIGA 69 - VICTOR KONDER - Blumenau / SC',
    telefone: '(47) 99176-1291',
    nomeMinuta: 'Calibre Restrito', rua: 'Rua Antônio da Veiga 69',
    complemento: 'Primeiro Andar', fone: '(47) 99176-1291',
    bairro: 'Victor Konder', uf: 'SC', cep: '89012500',
    cidade: 'Blumenau', email: 'loja.prohunters@gmail.com',
  },
};

const EZEQUIEL = {
  codigo: '77458', nome: 'EZEQUIEL SARTORI', doc: '07.332.384/0001-99',
  endereco: 'RUA TREZE DE MAIO, Nº 215 CASA - CENTRO - Antônio Prado / RS', telefone: '(54) 3298-3432',
};

const CPA_GOLLOG = {
  codigo: '453609', nome: 'C.P.A. SERVIÇOS DE MOVIMENTAÇÃO DE CARGAS', doc: '34.129.851/0001-50',
  endereco: 'AV SEVERO DULLIUS, 90010, ANEXO 06 - ANCHIETA', telefone: '(51) 3374-0055', sfpc: 'SFPC/03',
};

const RPACARGO = {
  codigo: '', nome: 'CONEXAO LOG TRANSPORTES E LOGISTICA LTDA', doc: '48.360.072/0001-76',
  endereco: 'ROD DOM GABRIEL PAULINO BUENO COUTO, S/N, KM 71 - GALPÃO 2 ANEXO 1 - MEDEIROS - Jundiaí / SP', telefone: '(11) 3623-4318',
};

function gerarNumeroGuia() {
  const ano = new Date().getFullYear();
  const meio = String(Math.floor(Math.random() * 90000000) + 10000000);
  return String(ano) + meio.slice(0, 8);
}

async function drawHeader(doc, crestBytes) {
  const crest = await doc.embedImageAuto(crestBytes);
  const crestH = 56;
  const scale = crestH / crest.height;
  const crestW = crest.width * scale;
  doc.page.drawImage(crest, { x: M + 24, y: doc.y - crestH, width: crestW, height: crestH });

  const cx = M + CW / 2;
  const hdr = [
    ['MINISTÉRIO DA DEFESA', 10],
    ['EXÉRCITO BRASILEIRO', 10],
    ['COMANDO LOGÍSTICO', 10],
    ['DIRETORIA DE FISCALIZAÇÃO DE PRODUTOS CONTROLADOS', 9],
  ];
  let hy = doc.y - 12;
  hdr.forEach(([t, sz]) => {
    const w = doc.bold.widthOfTextAtSize(t, sz);
    doc.text(t, cx - w / 2, hy, { size: sz, bold: true });
    hy -= sz + 4;
  });

  doc.y = doc.y - crestH - 10;
  const title = 'AUTORIZAÇÃO PARA TRÁFEGO DE PRODUTOS CONTROLADOS';
  const tw = doc.bold.widthOfTextAtSize(title, 11);
  doc.text(title, cx - tw / 2, doc.y, { size: 11, bold: true });
  doc.y -= 22;
}

function drawTopoInfo(doc, data) {
  const boxX = M + 70;
  const boxW = CW - 140;
  const rowH = 18;

  doc.rect(boxX, doc.y, boxW, rowH);
  doc.text('NÚMERO DA GUIA : ', boxX + 5, doc.y - 12, { size: 8.5, bold: true });
  const gLblW = doc.bold.widthOfTextAtSize('NÚMERO DA GUIA : ', 8.5);
  doc.text(data.numeroGuia, boxX + 5 + gLblW, doc.y - 12, { size: 8.5, bold: true });
  doc.text('SFPC/05', boxX + boxW * 0.55, doc.y - 12, { size: 8.5, bold: true });
  doc.text('Folha : 1 de 1', boxX + boxW * 0.78, doc.y - 12, { size: 8.5, bold: true });
  doc.y -= rowH;

  doc.rect(boxX, doc.y, boxW, rowH);
  doc.text('NOTA FISCAL Nº : ', boxX + 5, doc.y - 12, { size: 8.5, bold: true });
  const nLblW = doc.bold.widthOfTextAtSize('NOTA FISCAL Nº : ', 8.5);
  doc.text(String(data.notaFiscal || ''), boxX + 5 + nLblW, doc.y - 12, { size: 8.5, bold: true });
  doc.text('DATA: ', boxX + boxW * 0.55, doc.y - 12, { size: 8.5, bold: true });
  const dLblW = doc.bold.widthOfTextAtSize('DATA: ', 8.5);
  doc.text(data.dataEnvio, boxX + boxW * 0.55 + dLblW, doc.y - 12, { size: 8.5, bold: true });
  doc.y -= rowH;

  doc.rect(boxX, doc.y, boxW, rowH);
  const volTxt = 'NÚMERO DE VOLUMES: ' + String(data.numeroVolumes || 1);
  const volW = doc.bold.widthOfTextAtSize(volTxt, 8.5);
  doc.text(volTxt, boxX + (boxW - volW) / 2, doc.y - 12, { size: 8.5, bold: true });
  doc.y -= rowH;
  doc.y -= 6;
}

function drawParteOficial(doc, { titulo, nome, doc: docNum, endereco, telefone, sfpc, extraNome }) {
  const startY = doc.y;
  const cx = M + CW / 2;
  const rightX = M + CW - 5;

  // linha 1: titulo | nome (centralizado) | CNPJ (direita)
  doc.text(titulo, M + 3, doc.y - 10, { size: 8.5, bold: true });
  const nomeFull = (extraNome ? extraNome + ' ' : '') + nome;
  const nameSize = nomeFull.length > 50 ? 7 : 9;
  const nomeW = doc.font.widthOfTextAtSize(nomeFull, nameSize);
  doc.text(nomeFull, cx - nomeW / 2, doc.y - 10, { size: nameSize, bold: false });
  const cnpjTxt = 'CNPJ/CPF: ' + docNum;
  const cnpjW = doc.font.widthOfTextAtSize(cnpjTxt, 8.5);
  doc.text(cnpjTxt, rightX - cnpjW, doc.y - 10, { size: 8.5 });
  doc.y -= 24;

  // linha 2: endereço (esquerda, pode quebrar) | telefone (direita)
  const telTxt = telefone ? ('Telefone: ' + telefone) : '';
  const telW = telTxt ? doc.font.widthOfTextAtSize(telTxt, 8.5) : 0;
  if (telTxt) doc.text(telTxt, rightX - telW, doc.y - 2, { size: 8.5 });
  const endMaxW = CW - 20 - telW - 10;
  const endEndY = doc.wrapText(endereco, M + 3, doc.y - 2, endMaxW, { size: 8.5, lineGap: 11 });
  doc.y = Math.min(endEndY, doc.y - 13);

  // SFPC (só destinatário) numa linha à direita
  if (sfpc) {
    doc.y -= 4;
    const sfpcTxt = 'SFPC : ' + sfpc;
    const sfpcW = doc.font.widthOfTextAtSize(sfpcTxt, 8.5);
    doc.text(sfpcTxt, rightX - sfpcW, doc.y, { size: 8.5 });
    doc.y -= 14;
  }

  doc.y -= 4;
  doc.line(M, doc.y, M + CW, doc.y);
  doc.y -= 8;
}

function drawProductsTable(doc, produtos, reserveBottom) {
  reserveBottom = reserveBottom || 0;
  const cols = [
    { key: 'produto', label: 'Produto', w: 130, wrap: true },
    { key: 'complemento', label: 'Complemento', w: 125, wrap: true },
    { key: 'unidade', label: 'Unidade', w: 45 },
    { key: 'qtd', label: 'Qtd.', w: 30 },
    { key: 'volume', label: 'Volume', w: 35 },
    { key: 'marca', label: 'Marca', w: 60 },
    { key: 'serie', label: 'Nº Série', w: 90, wrap: true },
  ];
  const headH = 20;

  function drawTableHead() {
    let x = M;
    cols.forEach(c => {
      doc.rect(x, doc.y, c.w, headH);
      doc.text(c.label, x + 3, doc.y - 13, { size: 7.5, bold: true });
      x += c.w;
    });
    doc.y -= headH;
  }

  drawTableHead();

  produtos.forEach((p, idx) => {
    let maxLines = 1;
    cols.forEach(c => {
      if (c.wrap) {
        const w = doc.font.widthOfTextAtSize(String(p[c.key] || ''), 7.5);
        const lines = Math.ceil(w / (c.w - 6)) || 1;
        if (lines > maxLines) maxLines = lines;
      }
    });
    const rowH = Math.max(52, 14 + maxLines * 10);

    // Verificar se cabe na página — reservar espaço para selo se for o último produto
    const isLast = (idx === produtos.length - 1);
    const spaceNeeded = isLast ? rowH + reserveBottom : rowH + 20;
    if (doc.y - spaceNeeded < M) {
      doc.newPage();
      drawTableHead();
    }

    let x = M;
    cols.forEach(c => {
      doc.rect(x, doc.y, c.w, rowH);
      const val = String(p[c.key] ?? '');
      if (c.wrap) {
        const w = doc.font.widthOfTextAtSize(val, 7.5);
        const nLines = Math.max(1, Math.ceil(w / (c.w - 6)));
        const blockH = nLines * 9;
        const startY = doc.y - (rowH - blockH) / 2 - 7;
        doc.wrapText(val, x + 3, startY, c.w - 6, { size: 7.5, lineGap: 9 });
      } else {
        doc.text(val, x + 3, doc.y - rowH / 2 - 3, { size: 7.5, maxWidth: c.w - 6 });
      }
      x += c.w;
    });
    doc.y -= rowH;
  });
  doc.y -= 6;
}

async function drawSeloBarcodeValidade(doc, { seloNumero, assinanteNome, assinanteCargo, dataStr, validadeStr }) {
  const halfW = CW * 0.42;
  const rightW = CW - halfW;
  const topY = doc.y;

  const h1 = 100;
  const h2 = 72;

  // ESQUERDA topo: selo
  doc.rect(M, topY, halfW, h1);
  const seloTit = 'SELO DE AUTENTICIDADE';
  const seloTitW = doc.bold.widthOfTextAtSize(seloTit, 8);
  doc.text(seloTit, M + (halfW - seloTitW) / 2, topY - 12, { size: 8, bold: true });
  const obrig = 'OBRIGATÓRIO O USO DO SELO';
  const obrigW = doc.font.widthOfTextAtSize(obrig, 7);
  doc.text(obrig, M + (halfW - obrigW) / 2, topY - 26, { size: 7, bold: true });
  const seloNumTxt = 'Selo Número: ' + seloNumero;
  const seloNumW = doc.font.widthOfTextAtSize(seloNumTxt, 9);
  doc.text(seloNumTxt, M + (halfW - seloNumW) / 2, topY - 46, { size: 9 });

  // DIREITA topo: nome + cargo
  doc.rect(M + halfW, topY, rightW, h1);
  const nomeW = doc.font.widthOfTextAtSize(assinanteNome, 11);
  doc.text(assinanteNome, M + halfW + (rightW - nomeW) / 2, topY - h1 + 22, { size: 11 });
  const cargoUpper = String(assinanteCargo || '').toUpperCase();
  const cargoW = doc.font.widthOfTextAtSize(cargoUpper, 8.5);
  doc.text(cargoUpper, M + halfW + (rightW - cargoW) / 2, topY - h1 + 10, { size: 8.5 });
  doc.y = topY - h1;

  // ESQUERDA baixo: código de barras
  const by = doc.y;
  doc.rect(M, by, halfW, h2);
  const bcBytes = await barcodePng(seloNumero);
  const bcImg = await doc.embedImageAuto(bcBytes);
  const bcMaxW = halfW - 30;
  const bcMaxH = h2 - 12;
  const bcScale = Math.min(bcMaxW / bcImg.width, bcMaxH / bcImg.height);
  const bcW = bcImg.width * bcScale, bcH = bcImg.height * bcScale;
  doc.page.drawImage(bcImg, { x: M + (halfW - bcW) / 2, y: by - h2 + (h2 - bcH) / 2, width: bcW, height: bcH });

  // DIREITA baixo: data
  doc.rect(M + halfW, by, rightW, h2);
  const blumTxt = 'Blumenau (SC), ' + dataStr + '.';
  const blumW = doc.font.widthOfTextAtSize(blumTxt, 9);
  doc.text(blumTxt, M + halfW + (rightW - blumW) / 2, by - h2 / 2 - 3, { size: 9 });
  doc.y = by - h2;

  // Validade
  const h3 = 22;
  doc.rect(M, doc.y, CW, h3);
  const validadeTxt = 'Guia de Tráfego Válida até: ' + validadeStr;
  const validadeW = doc.bold.widthOfTextAtSize(validadeTxt, 9.5);
  doc.text(validadeTxt, M + (CW - validadeW) / 2, doc.y - 15, { size: 9.5, bold: true });
  doc.y -= h3;
}

async function gerarGTPagina(pdfCommon, data, destinatarios) {
  const { doc, crestBytes } = pdfCommon;
  doc.newPage();
  await drawHeader(doc, crestBytes);

  drawTopoInfo(doc, data);

  const emp = EMPRESA_ORIGEM[data.empresa];
  drawParteOficial(doc, {
    titulo: 'EMPRESA DE ORIGEM :',
    nome: emp.codigo + ' – ' + emp.nome,
    doc: emp.cnpj,
    endereco: emp.endereco,
    telefone: emp.telefone,
  });

  const tr = data.transportador;
  drawParteOficial(doc, {
    titulo: 'TRANSPORTADOR:',
    nome: (tr.codigo ? tr.codigo + ' - ' : '') + tr.nome,
    doc: tr.doc || tr.cnpj,
    endereco: tr.endereco,
    telefone: tr.telefone,
  });

  destinatarios.forEach(d => {
    drawParteOficial(doc, {
      titulo: 'DESTINATÁRIO:',
      nome: d.nome,
      doc: d.doc,
      endereco: d.endereco,
      telefone: d.telefone,
      sfpc: d.sfpc,
    });
  });

  doc.y -= 2;
  drawProductsTable(doc, data.produtos, 210);

  await drawSeloBarcodeValidade(doc, {
    seloNumero: data.seloNumero,
    assinanteNome: companies.representante.nome,
    assinanteCargo: companies.representante.cargo,
    dataStr: data.dataEnvio,
    validadeStr: addDaysBR(data.dataEnvio, 60),
  });

  const emitidoTxt = 'Emitido por : ' + companies.representante.nome.toUpperCase() + '-' + data.dataEnvio;
  const emitidoW = doc.font.widthOfTextAtSize(emitidoTxt, 7.5);
  doc.text(emitidoTxt, M + CW - emitidoW, doc.y - 12, { size: 7.5 });
}

function drawVersoGT(doc, data) {
  doc.newPage();
  const cx = M + CW / 2;
  const boxH = 440;
  const boxTop = doc.y;
  doc.rect(M, boxTop, CW, boxH);

  let cy = boxTop - 28;
  const centerText = (txt, y, sz, bold) => {
    const f = bold ? doc.bold : doc.font;
    const w = f.widthOfTextAtSize(txt, sz);
    doc.text(txt, cx - w / 2, y, { size: sz, bold: !!bold });
  };

  centerText('MINISTERIO DA DEFESA', cy, 12, true);
  cy -= 18;
  centerText('BASE AÉREA DE CANOAS - BACO', cy, 12, true);
  cy -= 36;

  const authTxt = `Autorizo o transporte por via aérea, no material especificado na Guia de Tráfego nº`;
  const authW = doc.font.widthOfTextAtSize(authTxt, 10);
  doc.text(authTxt, cx - authW / 2, cy, { size: 10 });
  cy -= 16;
  const numTxt = data.numeroGuia + ',';
  const numW = doc.bold.widthOfTextAtSize(numTxt, 10);
  const restTxt = ' por atender as condições exigidas, conforme o disposto na Lei nº';
  doc.text(numTxt, cx - (numW + doc.font.widthOfTextAtSize(restTxt, 10)) / 2, cy, { size: 10, bold: true });
  doc.text(restTxt, cx - (numW + doc.font.widthOfTextAtSize(restTxt, 10)) / 2 + numW, cy, { size: 10 });
  cy -= 16;
  centerText('11.182/2005 e Decreto nº 5.731/2006', cy, 10, false);
  cy -= 36;

  const trechoTxt = 'Trecho: ' + (data.gollog?.trecho || '');
  centerText(trechoTxt, cy, 13, true);
  cy -= 32;

  centerText('Assinatura e Carimbo:', cy, 10, false);
  cy -= 100;

  doc.text('Em: ' + data.dataEnvio, M + 10, cy, { size: 10 });
  cy -= 30;

  const refs = [
    '- ICA 55-36 – Autorização de voo no Espaço Aéreo Brasileiro, Portaria nº410/GC3, de 22 de JULHO de 2001',
    '- AC 1604-0498 de 16 de Abril de 1998',
    '- DCAR 709/2009, de 03 de novembro de 2009',
  ];
  refs.forEach(r => { centerText(r, cy, 7.5, false); cy -= 12; });

  doc.y = boxTop - boxH - 10;
}


async function gerarGT(data) {
  const crestBytes = loadAsset('exercito_brasao.png');
  const doc = new BoxDoc();
  await doc.init();
  doc.page = doc.pdf.getPages()[0];
  const pdfCommon = { doc, crestBytes };

  const emptyPage = doc.pdf.getPages()[0];

  if (!data.numeroGuia) data.numeroGuia = gerarNumeroGuia();

  if (data.variante === 'pessoa_fisica') {
    data.transportador = { ...data.destinatarios[0] };
  } else if (data.variante === 'rpacargo') {
    data.transportador = { codigo: RPACARGO.codigo, nome: RPACARGO.nome, doc: RPACARGO.doc, endereco: RPACARGO.endereco, telefone: RPACARGO.telefone };
  } else {
    data.transportador = { codigo: EZEQUIEL.codigo, nome: EZEQUIEL.nome, doc: EZEQUIEL.doc, endereco: EZEQUIEL.endereco, telefone: EZEQUIEL.telefone };
  }

  const destinatarios = data.variante === 'ezequiel_gollog'
    ? [data.destinatarios[0], { ...CPA_GOLLOG }]
    : [data.destinatarios[0]];

  await gerarGTPagina(pdfCommon, data, destinatarios);

  if (data.variante === 'ezequiel_gollog') {
    drawVersoGT(doc, data);
    // Minuta Gollog: preenche o TEMPLATE OFICIAL da Gollog (PDF em branco
    // versionado em assets/gollog-minuta-template.pdf) e mescla como próxima
    // página. Substitui a antiga drawMinuta() que desenhava aproximado.
    await minutaGollog.mergirNoDoc(doc, data);
  }

  doc.pdf.removePage(0);

  const bytes = await doc.save();

  const dataFile = todayBR().split('/').reverse().join('-');
  const clienteNome = (data.destinatarios[0].nome || 'cliente').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9 \-]/g, '').trim();
  const seloRaw = String(data.seloNumero || '').replace(/\D/g, '');
  const seloFmt = seloRaw.length >= 8
    ? seloRaw.replace(/^(\d{2})(\d{3})(\d{3})$/, '$1.$2.$3')
    : seloRaw;
  const tipos = new Set();
  (data.produtos || []).forEach(p => {
    const pr = (p.produto || '').toLowerCase();
    if (pr.includes('arma')) tipos.add('Arma');
    else if (pr.includes('muni') || pr.includes('cartucho')) tipos.add('Municao');
    else if (pr.includes('insumo')) tipos.add('Insumo');
    else if (pr.includes('recarga') || pr.includes('material')) tipos.add('Recarga');
    else tipos.add('Produto');
  });
  const classif = Array.from(tipos).join('-') || 'Produto';
  const filename = `GT-${dataFile} - Selo n°${seloFmt} - ${clienteNome} - ${classif}.pdf`;

  return { bytes, filename, numeroGuia: data.numeroGuia };
}

module.exports = { gerarGT, gerarNumeroGuia };
