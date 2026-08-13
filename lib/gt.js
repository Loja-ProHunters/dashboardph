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
    let maxLines = 1;
    cols.forEach(c => {
      if (c.wrap) {
        const w = doc.font.widthOfTextAtSize(String(p[c.key] || ''), 7.5);
        const lines = Math.ceil(w / (c.w - 6)) || 1;
        if (lines > maxLines) maxLines = lines;
      }
    });
    const rowH = Math.max(52, 14 + maxLines * 10);
    x = M;
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
  drawProductsTable(doc, data.produtos);

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

function drawMinuta(doc, data) {
  const g = data.gollog || {};
  const emp = EMPRESA_ORIGEM[data.empresa];
  const dest = (data.destinatarios || [])[0] || {};
  doc.newPage();

  const LX = M;
  const FW = CW;
  const HW = FW / 2;
  const cx = LX + FW / 2;
  const rH = 28;

  // Auto-derivar produto predominante (primeira palavra do complemento do produto)
  const prod0 = (data.produtos || [])[0] || {};
  const autoProduto = (prod0.complemento || prod0.produto || '').split(' ')[0] || '';
  const prodPredominante = g.produtoPredominante || autoProduto;

  // Auto-derivar valor da mercadoria (da NF se disponível)
  const autoValor = data.valorTotal || data.valorNF || data.valorMercadoria || '';
  const valMercadoria = g.valorMercadoria || autoValor;

  // ── HEADER ──
  const tTxt = 'MINUTA DE DESPACHO ELETRÔNICA';
  const tW = doc.bold.widthOfTextAtSize(tTxt, 14);
  doc.text(tTxt, cx - tW / 2, doc.y - 4, { size: 14, bold: true });
  const uTxt = 'www.gollog.com.br';
  const uW = doc.font.widthOfTextAtSize(uTxt, 8);
  doc.text(uTxt, cx - uW / 2, doc.y - 20, { size: 8 });
  doc.y -= 34;

  // ── IMPORTANTE ──
  doc.text('IMPORTANTE:', LX, doc.y, { size: 6, bold: true });
  doc.y -= 8;
  const impParas = [
    'O expedidor tem conhecimento de que no caso de perda ou extravio da carga despachada e coberta por conhecimento aéreo, são aplicáveis os limites de indenização estabelecidos pelo Código Brasileiro de Aeronáutica (disponível no site http://legislacao.planalto.gov.br/) e nas Condições Gerais do Contrato.',
    '1. Declarei corretamente o conteúdo do(s) volume(s).',
    '2. Não aceitamos despacho(s) contendo DINHEIRO EM ESPÉCIE e ARTIGOS PROIBIDOS P/TRANSPORTE AÉREO.',
    '3. Não nos responsabilizamos por avarias, extravios ou faltas em despachos efetuados sem seguro ou decorrentes de má embalagem, vícios próprios de mercadorias ou falsa declaração de conteúdo.',
    '4. Não nos responsabilizamos por avarias em mercadorias cujas embalagens se encontram sujas, se estas não estiverem comprometendo a integridade do conteúdo/produto.',
    '5. O embarcador está ciente de que sua carga estará à sua disponibilidade por 10 dias após chegada no destino, não havendo interesse de nenhuma das partes neste período para sua recuperação, a carga será disponibilizada de nossos terminais.',
  ];
  impParas.forEach(p => { doc.y = doc.wrapText(p, LX, doc.y, FW, { size: 5.5, lineGap: 7 }); });
  doc.y -= 6;

  // ── SERVIÇO / PAGAMENTO / ENTREGA / AEROPORTO ──
  const sw = [FW * 0.20, FW * 0.26, FW * 0.24, FW * 0.30];
  let sx = LX;
  [['Serviço GOLLOG', 'Urgente'], ['Forma de Pagamento', g.formaPagamento || 'Pagamento a vista'],
   ['Tipo de Entrega', g.tipoEntrega || 'RETIRA AEROPORTO'], ['Aeroporto para Retirada', g.aeroporto || '']
  ].forEach((f, i) => { doc.field(sx, doc.y, sw[i], rH, f[0], f[1]); sx += sw[i]; });
  doc.y -= rH;

  // ── REMETENTE / DESTINATÁRIO ──
  doc.field(LX, doc.y, HW, rH, 'Remetente', emp.nomeMinuta);
  doc.field(LX + HW, doc.y, HW, rH, 'Destinatário', dest.nome || '');
  doc.y -= rH;

  doc.field(LX, doc.y, HW, rH, 'CPF / CNPJ', emp.cnpj);
  doc.field(LX + HW, doc.y, HW, rH, 'CPF / CNPJ', dest.doc || '');
  doc.y -= rH;

  doc.field(LX, doc.y, HW, rH, 'Endereço', emp.rua || '');
  doc.field(LX + HW, doc.y, HW, rH, 'Endereço', dest.endereco || '');
  doc.y -= rH;

  const cmpW = HW * 0.58, fonW = HW * 0.42;
  doc.field(LX, doc.y, cmpW, rH, 'Complemento', emp.complemento || '');
  doc.field(LX + cmpW, doc.y, fonW, rH, 'Fone', emp.fone || '');
  doc.field(LX + HW, doc.y, cmpW, rH, 'Complemento', dest.complemento || '');
  doc.field(LX + HW + cmpW, doc.y, fonW, rH, 'Fone', dest.telefone || '');
  doc.y -= rH;

  const bW = HW * 0.65, ufW = HW * 0.35;
  doc.field(LX, doc.y, bW, rH, 'Bairro', emp.bairro || '');
  doc.field(LX + bW, doc.y, ufW, rH, 'UF', emp.uf || '');
  doc.field(LX + HW, doc.y, bW, rH, 'Bairro', dest.bairro || '');
  doc.field(LX + HW + bW, doc.y, ufW, rH, 'UF', dest.uf || '');
  doc.y -= rH;

  const cpW = HW * 0.38, cdW = HW * 0.62;
  doc.field(LX, doc.y, cpW, rH, 'CEP', emp.cep || '');
  doc.field(LX + cpW, doc.y, cdW, rH, 'Cidade', emp.cidade || '');
  doc.field(LX + HW, doc.y, cpW, rH, 'CEP', dest.cep || '');
  doc.field(LX + HW + cpW, doc.y, cdW, rH, 'Cidade', dest.cidade || '');
  doc.y -= rH;

  doc.field(LX, doc.y, HW, rH, 'e-mail', emp.email || '');
  doc.field(LX + HW, doc.y, HW, rH, 'e-mail', dest.email || '');
  doc.y -= rH;

  // ── TOMADOR DO FRETE ──
  const tW1 = FW * 0.36, tW2 = FW * 0.34, tW3 = FW * 0.30;
  doc.field(LX, doc.y, tW1, rH, 'Tomador do Frete', emp.nomeMinuta);
  doc.field(LX + tW1, doc.y, tW2, rH, 'CNPJ', emp.cnpj);
  doc.field(LX + tW1 + tW2, doc.y, tW3, rH, 'Nº Conta Gollog', g.nContaGollog || '');
  doc.y -= rH;

  // ── VOLUMES / PESO / MEDIDAS ──
  const thW = FW / 3;
  doc.field(LX, doc.y, thW, rH, 'Nº de Volumes', g.nVolumes || '');
  doc.field(LX + thW, doc.y, thW, rH, 'Peso Total', g.pesoTotal || '');
  doc.field(LX + thW * 2, doc.y, thW, rH, 'Medidas das Embalagens', g.medidasEmbalagens || '');
  doc.y -= rH;

  // ── PRODUTO / ARTIGO / TIPO EMBALAGEM ──
  doc.field(LX, doc.y, thW, rH, 'Produto Predominante', prodPredominante);
  doc.field(LX + thW, doc.y, thW, rH, 'Artigo Perigoso UN', '');
  doc.field(LX + thW * 2, doc.y, thW, rH, 'Tipo de Embalagem', g.tipoEmbalagem || '');
  doc.y -= rH;

  // ── NOTAS FISCAIS ──
  doc.field(LX, doc.y, FW, rH, 'Notas Fiscais', String(data.notaFiscal || ''));
  doc.y -= rH;

  // ── TIPO DE SEGURO ──
  const segRH = 28;
  const segLbl = 55;
  doc.text('Tipo de', LX + 6, doc.y - segRH + 2, { size: 7, bold: true });
  doc.text('Seguro', LX + 6, doc.y - segRH - 10, { size: 7, bold: true });

  // Linha 1: Próprio
  doc.rect(LX, doc.y, FW, segRH);
  doc.text('(  ) Proprio', LX + segLbl + 4, doc.y - 12, { size: 7.5 });
  const apW2 = (FW - segLbl - 80) * 0.5;
  doc.field(LX + segLbl + 80, doc.y, apW2, segRH, 'Nº de Apólice', '');
  doc.field(LX + segLbl + 80 + apW2, doc.y, FW - segLbl - 80 - apW2, segRH, 'Seguradora', '');
  doc.y -= segRH;

  // Linha 2: Seguro GOL (selecionado)
  doc.rect(LX, doc.y, FW, segRH);
  doc.text('(X) Seguro GOL', LX + segLbl + 4, doc.y - 12, { size: 7.5 });
  doc.field(LX + segLbl + 110, doc.y, FW - segLbl - 110, segRH, 'Valor da Mercadoria', valMercadoria);
  doc.y -= segRH;

  // Linha 3: Sem Seguro
  doc.rect(LX, doc.y, FW, segRH);
  doc.text('(  ) Sem Seguro - nao declare o valor de mercadoria', LX + segLbl + 4, doc.y - 12, { size: 7.5 });
  doc.y -= segRH;

  // ── AUTORIZAÇÃO ──
  doc.rect(LX, doc.y, FW, rH);
  doc.text('Autorização', LX + 4, doc.y - 9, { size: 7, bold: true });
  doc.text('[X] Autorizo o(s) embarque(s) do(s) volume(s) relacionado(s), conforme especificacoes desta minuta.', LX + segLbl + 4, doc.y - 14, { size: 7.5 });
  doc.y -= rH;

  // ── LOCAL/DATA + NOME/RESPONSÁVEL ──
  doc.field(LX, doc.y, HW, rH, 'Local/Data', g.localData || ('Blumenau, ' + data.dataEnvio));
  doc.field(LX + HW, doc.y, HW, rH, 'Nome/Responsável', g.nomeResponsavel || 'Luis Henrique Gonçalves');
  doc.y -= rH;

  // ── USO DA GOL ──
  const usoH = 14;
  doc.rect(LX, doc.y, FW, usoH);
  const usoTxt = 'Uso da GOL';
  const usoTW = doc.bold.widthOfTextAtSize(usoTxt, 8);
  doc.text(usoTxt, cx - usoTW / 2, doc.y - 10, { size: 8, bold: true });
  doc.y -= usoH;

  doc.field(LX, doc.y, HW, rH, 'Recebido em', '');
  doc.field(LX + HW, doc.y, HW, rH, 'Nome/Responsável', '');
  doc.y -= rH;

  doc.field(LX, doc.y, HW, rH, 'Conhecimento Aéreo Nº', '');
  doc.field(LX + HW, doc.y, HW, rH, 'Emitido por:', '');
  doc.y -= rH;

  // ── FOOTER ──
  const footTxt = 'FORM - MIN-CGO/FF-001-007 - Rev.01 - Abr./2020';
  const footW = doc.font.widthOfTextAtSize(footTxt, 6.5);
  doc.text(footTxt, LX + FW - footW, doc.y - 8, { size: 6.5 });
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

  doc.pdf.removePage(0);

  const bytes = await doc.save();

  const empresaNome = data.empresa === 'ph' ? 'Pro Hunters' : 'Calibre Restrito';
  const dataFile = todayBR().split('/').reverse().join('-');
  const clienteNome = (data.destinatarios[0].nome || 'cliente').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9 \-]/g, '').trim();
  const filename = `${dataFile} - GT - ${clienteNome} - ${empresaNome}.pdf`;

  return { bytes, filename, numeroGuia: data.numeroGuia };
}

module.exports = { gerarGT, gerarNumeroGuia };
