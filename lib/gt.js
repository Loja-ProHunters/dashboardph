// lib/gt.js - Gerador de Guias de Trânsito (GT)
// Inclui: GT front + Verso GT + Minuta Gollog (quando tipo = ezequiel_gollog)

const PDFDocument = require('pdfkit');
const bwipjs = require('bwip-js');

// Mapa de SFPC por UF
const sfpcByUF = {
  'AC': '01', 'AL': '02', 'AP': '03', 'AM': '04', 'BA': '05',
  'CE': '06', 'DF': '07', 'ES': '08', 'GO': '09', 'MA': '10',
  'MT': '11', 'MS': '12', 'MG': '13', 'PA': '14', 'PB': '15',
  'PR': '16', 'PE': '17', 'PI': '18', 'RJ': '19', 'RN': '20',
  'RS': '05', 'RO': '21', 'RR': '22', 'SC': '05', 'SP': '23',
  'SE': '24', 'TO': '25'
};

// ══════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════

function drawRect(doc, x, y, w, h) {
  doc.rect(x, y, w, h).stroke();
}

function drawField(doc, x, y, w, h, label, value) {
  drawRect(doc, x, y, w, h);
  if (label) {
    doc.font('Courier').fontSize(7);
    doc.text(label, x + 3, y + 3, { width: w - 6, lineBreak: false });
  }
  if (value) {
    doc.font('Courier').fontSize(10);
    doc.text(value, x + 5, y + h - 15, { width: w - 10, lineBreak: false });
  }
}

// ══════════════════════════════════════════════════════════════
// PÁGINA 1: GT FRONT (existente)
// ══════════════════════════════════════════════════════════════

function desenharGTFront(doc, dados) {
  const {
    tipo, numeroGuia, dataEmissao, nfNumero, dataNF,
    destinatario, cpfCnpj, endereco, telefone, ufDestino,
    transportador, cpfTransportador, enderecoTransportador,
    produtos, selos
  } = dados;

  // Header do Exército
  doc.fontSize(9).font('Helvetica').text('MINISTÉRIO DA DEFESA EXÉRCITO BRASILEIRO COMANDO LOGÍSTICO', { align: 'center' });
  doc.fontSize(8).text('DIRETORIA DE FISCALIZAÇÃO DE PRODUTOS CONTROLADOS', { align: 'center' });
  doc.fontSize(14).text('AUTORIZAÇÃO PARA TRÁFEGO DE PRODUTOS CONTROLADOS', { align: 'center' });

  // SFPC / Data / Folha
  doc.fontSize(10).text('NÚMERO DA GUIA: ' + numeroGuia + '          SFPC/' + (sfpcByUF[ufDestino] || '00') + '          Folha: 1 de 1', 50, 120);
  doc.fontSize(10).text('NOTA FISCAL Nº: ' + nfNumero + '          DATA: ' + dataNF);
  doc.fontSize(10).text('NÚMERO DE VOLUMES: ' + (selos ? selos.length : 1));

  // EMPRESA DE ORIGEM
  doc.fontSize(10).text('EMPRESA DE ORIGEM:', 50, 180);
  doc.fontSize(9).text('247056 – CALIBRE RESTRITO', 50, 195);
  doc.fontSize(9).text('COMÉRCIO DE IMPORTAÇÃO LTDA', 50, 207);
  doc.fontSize(9).text('CNPJ: 34.760.885/0001-49', 50, 219);
  doc.fontSize(8).text('RUA ANTÔNIO DA VEIGA 69 SALA 02 ANDAR 2 - VICTOR KONDER', 50, 231);
  doc.fontSize(8).text('Blumenau/SC CEP 89012-500     Telefone: (47) 9176-1291', 50, 241);

  // TRANSPORTADOR
  doc.fontSize(10).text('TRANSPORTADOR:', 50, 270);
  doc.fontSize(9).text((transportador || '') + '     CNPJ/CPF: ' + (cpfTransportador || ''), 50, 285);
  doc.fontSize(8).text(enderecoTransportador || '', 50, 295);

  // DESTINATÁRIO
  doc.fontSize(10).text('DESTINATÁRIO:', 50, 320);
  doc.fontSize(9).text((destinatario || '') + '     CNPJ/CPF: ' + (cpfCnpj || ''), 50, 335);
  doc.fontSize(8).text(endereco || '', 50, 345);
  doc.fontSize(8).text('Telefone: ' + (telefone || ''), 50, 355);

  // Tabela de Produtos
  const tableTop = 380;
  doc.fontSize(9).font('Helvetica-Bold');
  doc.text('Produto', 50, tableTop);
  doc.text('Complemento', 210, tableTop);
  doc.text('Unidade', 320, tableTop);
  doc.text('Qtde.', 390, tableTop);
  doc.text('Volume', 440, tableTop);
  doc.text('Marca', 500, tableTop);
  doc.text('Nº Série', 570, tableTop);

  doc.fontSize(8).font('Helvetica');
  let y = tableTop + 25;
  if (produtos && produtos.length) {
    produtos.forEach(function(p) {
      doc.text(p.produto || '', 50, y, { width: 150 });
      doc.text(p.complemento || '', 210, y, { width: 100 });
      doc.text(p.unidade || '', 320, y, { width: 60 });
      doc.text(p.qtde || '', 390, y, { width: 40 });
      doc.text(p.volume || '', 440, y, { width: 50 });
      doc.text(p.marca || '', 500, y, { width: 60 });
      doc.text(p.serie || '', 570, y, { width: 120 });
      y += 40;
    });
  }

  y += 70;

  // Selo
  doc.fontSize(10).text('SELO DE AUTENTICIDADE', 50, y);
  doc.fontSize(9).text('OBRIGATÓRIO O USO DO SELO', 50, y + 20);
  doc.fontSize(10).text('Selo Número: ' + ((selos && selos[0]) || ''), 50, y + 40);

  // Assinatura
  doc.fontSize(9).text('João Carlos Redin', 400, y, { align: 'center' });
  doc.fontSize(8).text('SÓCIO DIRETOR', 400, y + 15, { align: 'center' });

  return y;
}

// ══════════════════════════════════════════════════════════════
// PÁGINA 2: VERSO GT (autorização aérea)
// ══════════════════════════════════════════════════════════════

function desenharVersoGT(doc, dados) {
  const W = 595.27;
  const cx = W / 2;

  const boxX = 60, boxW = W - 120, boxH = 370, boxY = 80;
  doc.rect(boxX, boxY, boxW, boxH).stroke();

  let y = boxY + 35;
  doc.font('Helvetica-Bold').fontSize(13);
  doc.text('MINISTÉRIO DA DEFESA', boxX, y, { width: boxW, align: 'center' });
  y += 18;
  doc.fontSize(12);
  doc.text('BASE AÉREA DE CANOAS - BACO', boxX, y, { width: boxW, align: 'center' });

  y += 40;
  doc.font('Helvetica').fontSize(10.5);
  doc.text('Autorizo o transporte por via aérea, no material especificado na Guia de Tráfego nº', boxX, y, { width: boxW, align: 'center' });

  y += 18;
  doc.font('Helvetica-Bold').fontSize(11);
  doc.text((dados.numeroGuia || '') + ',', boxX, y, { width: boxW, align: 'center' });

  y += 16;
  doc.font('Helvetica').fontSize(10.5);
  doc.text('por atender as condições exigidas, conforme o disposto na Lei nº', boxX, y, { width: boxW, align: 'center' });

  y += 16;
  doc.text('11.182/2005 e Decreto nº 5.731/2006', boxX, y, { width: boxW, align: 'center' });

  y += 35;
  doc.font('Helvetica').fontSize(10.5);
  doc.text('Trecho:  ', boxX + 40, y, { continued: true, lineBreak: false });
  doc.font('Helvetica-Bold').fontSize(10.5);
  doc.text(dados.gollog_trecho || dados.nome_aeroporto || '');

  y += 35;
  doc.font('Helvetica').fontSize(10.5);
  doc.text('Assinatura e Carimbo:', boxX, y, { width: boxW, align: 'center' });

  var yData = boxY + boxH - 75;
  doc.font('Helvetica').fontSize(10.5);
  doc.text('Em: ' + (dados.dataEmissao || dados.dataNF || ''), boxX + 12, yData);

  var yLeg = boxY + boxH - 48;
  doc.font('Helvetica').fontSize(7.5);
  doc.text('- ICA 55-36 – Autorização de voo no Espaço Aéreo Brasileiro, Portaria nº410/GC3, de 22 de JULHO de 2001', boxX, yLeg, { width: boxW, align: 'center' });
  yLeg += 11;
  doc.text('- AC 1604-0498 de 16 de Abril de 1998', boxX, yLeg, { width: boxW, align: 'center' });
  yLeg += 11;
  doc.text('- DCAR 709/2009, de 03 de novembro de 2009', boxX, yLeg, { width: boxW, align: 'center' });
}

// ══════════════════════════════════════════════════════════════
// PÁGINA 3: MINUTA DE DESPACHO ELETRÔNICA GOLLOG
// ══════════════════════════════════════════════════════════════

function desenharMinuta(doc, dados) {
  var W = 595.27;
  var ML = 28, MR = W - 28, TW = MR - ML;
  var fh = 28, gap = 1;
  var half = TW / 2 - 1;

  // Dados da minuta com padrões
  var m = {
    servico: 'Urgente',
    forma_pagamento: dados.gollog_forma_pagamento || 'CONTA CORRENTE',
    tipo_entrega: dados.gollog_tipo_entrega || 'RETIRA AEROPORTO',
    aeroporto_retirada: dados.gollog_aeroporto || '',
    rem_nome: dados.empresaNome || 'Pro Hunters',
    rem_cpf_cnpj: dados.empresaCnpj || '12.304.207/0001-39',
    rem_endereco: 'Rua Antonio da Veiga N 69',
    rem_complemento: 'Primeiro Andar',
    rem_fone: '47991190416',
    rem_bairro: 'Victor Konder',
    rem_uf: 'SC',
    rem_cep: '89012900',
    rem_cidade: 'Blumenau',
    rem_email: 'loja.prohunters@gmail.com',
    dest_nome: dados.destinatario || '',
    dest_cpf_cnpj: dados.cpfCnpj || '',
    dest_endereco: dados.endereco || '',
    dest_complemento: dados.complemento || '',
    dest_fone: dados.telefone || '',
    dest_bairro: dados.bairro || '',
    dest_uf: dados.ufDestino || '',
    dest_cep: dados.cep || '',
    dest_cidade: dados.cidade || '',
    dest_email: dados.email || '',
    tomador_nome: dados.gollog_tomador || dados.destinatario || '',
    tomador_cnpj: dados.gollog_tomador_cnpj || dados.cpfCnpj || '',
    conta_gollog: dados.gollog_conta || '',
    num_volumes: String((dados.selos && dados.selos.length) || '1'),
    peso_total: dados.gollog_peso || '',
    medidas: dados.gollog_medidas || '',
    produto_predominante: dados.gollog_produto || ((dados.produtos && dados.produtos[0]) ? dados.produtos[0].produto : ''),
    artigo_perigoso: '',
    tipo_embalagem: dados.gollog_embalagem || '',
    notas_fiscais: dados.nfNumero || '',
    tipo_seguro: dados.gollog_tipo_seguro || 'seguro_gol',
    valor_mercadoria: dados.gollog_valor_mercadoria || '',
    local_data: 'Blumenau ' + (dados.dataEmissao || new Date().toLocaleDateString('pt-BR')),
    nome_responsavel: 'Luis Henrique Gonçalves',
  };

  // CABEÇALHO
  doc.font('Courier').fontSize(7);
  doc.text('Notas Fiscais', ML, 15);

  doc.font('Courier-Bold').fontSize(16);
  doc.text('MINUTA DE DESPACHO ELETRÔNICA', ML, 15, { width: TW, align: 'center' });

  drawRect(doc, MR - 55, 12, 55, 20);
  doc.font('Courier').fontSize(9);
  doc.text('Imprimir', MR - 53, 18, { width: 51, align: 'center' });

  doc.font('Courier').fontSize(9);
  doc.text('www.gollog.com.br', ML, 34, { width: TW, align: 'center' });

  // IMPORTANTE
  var y = 50;
  doc.font('Courier-Bold').fontSize(6.5);
  doc.text('IMPORTANTE:', ML, y);
  y += 9;

  doc.font('Courier').fontSize(6);
  var notas = [
    'O expedidor tem conhecimento de que, no caso de perda ou extravio da carga despachada e acobertada por conhecimento aéreo, são aplicáveis os limites de indenização',
    'estabelecidos pelo Código Brasileiro de Aeronáutica (disponível no site http://anac.gov.br/) em território nacional.',
    '',
    '1. Declare correta e claramente o conteúdo do(s) volume(s)',
    '2. Não aceitamos despacho(s) contendo DINHEIRO EM ESPÉCIE e ARTIGOS PROIBIDOS P/ TRANSPORTE AÉREO.',
    '3. Não nos responsabilizamos por avarias, extravios ou faltas em despachos efetuados sem seguro ou decorrentes de má embalagem, vícios próprios da mercadorias ou',
    '   falsa declaração de conteúdo.',
    '4. Não nos responsabilizamos por avarias em mercadorias usadas se esta não seguir com laudo técnico que garanta integridade do produto;',
    '5. O embarcador está ciente de que esta carga estará a sua disponibilidade por 180 dias após chegada no destino, não havendo interesse de nenhuma das partes neste',
    '   período por sua recuperação a carga será dispensada de nossos terminais.',
  ];
  notas.forEach(function(n) { doc.text(n, ML, y, { width: TW }); y += 7.5; });

  // CAMPOS
  y += 6;
  var c1w = TW * 0.22, c2w = TW * 0.26, c3w = TW * 0.27, c4w = TW - c1w - c2w - c3w;
  drawField(doc, ML, y, c1w, fh, 'Serviço GOLLOG', m.servico);
  drawField(doc, ML + c1w, y, c2w, fh, 'Forma de Pagamento', m.forma_pagamento);
  drawField(doc, ML + c1w + c2w, y, c3w, fh, 'Tipo de Entrega', m.tipo_entrega);
  drawField(doc, ML + c1w + c2w + c3w, y, c4w, fh, 'Aeroporto para Retirada', m.aeroporto_retirada);
  y += fh + gap;

  drawField(doc, ML, y, half, fh, 'Remetente', m.rem_nome);
  drawField(doc, ML + half + 2, y, half, fh, 'Destinatário', m.dest_nome);
  y += fh + gap;

  drawField(doc, ML, y, half, fh, 'CPF / CNPJ', m.rem_cpf_cnpj);
  drawField(doc, ML + half + 2, y, half, fh, 'CPF / CNPJ', m.dest_cpf_cnpj);
  y += fh + gap;

  drawField(doc, ML, y, half, fh, 'Endereço', m.rem_endereco);
  drawField(doc, ML + half + 2, y, half, fh, 'Endereço', m.dest_endereco);
  y += fh + gap;

  var cwComp = half * 0.58, cwFone = half * 0.42;
  drawField(doc, ML, y, cwComp, fh, 'Complemento', m.rem_complemento);
  drawField(doc, ML + cwComp, y, cwFone, fh, 'Fone', m.rem_fone);
  drawField(doc, ML + half + 2, y, cwComp, fh, 'Complemento', m.dest_complemento);
  drawField(doc, ML + half + 2 + cwComp, y, cwFone, fh, 'Fone', m.dest_fone);
  y += fh + gap;

  var cwBairro = half * 0.78, cwUf = half * 0.22;
  drawField(doc, ML, y, cwBairro, fh, 'Bairro', m.rem_bairro);
  drawField(doc, ML + cwBairro, y, cwUf, fh, 'UF', m.rem_uf);
  drawField(doc, ML + half + 2, y, cwBairro, fh, 'Bairro', m.dest_bairro);
  drawField(doc, ML + half + 2 + cwBairro, y, cwUf, fh, 'UF', m.dest_uf);
  y += fh + gap;

  var cwCep = half * 0.35, cwCid = half * 0.65;
  drawField(doc, ML, y, cwCep, fh, 'CEP', m.rem_cep);
  drawField(doc, ML + cwCep, y, cwCid, fh, 'Cidade', m.rem_cidade);
  drawField(doc, ML + half + 2, y, cwCep, fh, 'CEP', m.dest_cep);
  drawField(doc, ML + half + 2 + cwCep, y, cwCid, fh, 'Cidade', m.dest_cidade);
  y += fh + gap;

  drawField(doc, ML, y, half, fh, 'e-mail', m.rem_email);
  drawField(doc, ML + half + 2, y, half, fh, 'e-mail', m.dest_email);
  y += fh + gap;

  var tw1 = TW * 0.40, tw2 = TW * 0.35, tw3 = TW * 0.25;
  drawField(doc, ML, y, tw1, fh, 'Tomador do Frete', m.tomador_nome);
  drawField(doc, ML + tw1, y, tw2, fh, 'CNPJ', m.tomador_cnpj);
  drawField(doc, ML + tw1 + tw2, y, tw3, fh, 'Nº Conta Gollog', m.conta_gollog);
  y += fh + 4;

  var vw1 = TW * 0.25, vw2 = TW * 0.25, vw3 = TW * 0.50;
  drawField(doc, ML, y, vw1, fh, 'Nº de Volumes', m.num_volumes);
  drawField(doc, ML + vw1, y, vw2, fh, 'Peso Total', m.peso_total);
  drawField(doc, ML + vw1 + vw2, y, vw3, fh, 'Medidas das Embalagens', m.medidas);
  y += fh + gap;

  var pw1 = TW * 0.40, pw2 = TW * 0.30, pw3 = TW * 0.30;
  drawField(doc, ML, y, pw1, fh, 'Produto Predominante', m.produto_predominante);
  drawField(doc, ML + pw1, y, pw2, fh, 'Artigo Perigoso UN', m.artigo_perigoso);
  drawField(doc, ML + pw1 + pw2, y, pw3, fh, 'Tipo de Embalagem', m.tipo_embalagem);
  y += fh + gap;

  drawField(doc, ML, y, TW, fh, 'Notas Fiscais', m.notas_fiscais);
  y += fh + gap;

  // SEGURO
  var segH = 62;
  drawRect(doc, ML, y, TW, segH);
  doc.font('Courier').fontSize(8);
  doc.text('Tipo de Seguro', ML + 6, y + 8);

  var rx = ML + 100, ry = y + 6;
  var markP = m.tipo_seguro === 'proprio' ? '(X)' : '( )';
  doc.text(markP + ' Próprio', rx, ry, { lineBreak: false });
  doc.text('Nº de Apolice', rx + 100, ry, { lineBreak: false });
  drawRect(doc, rx + 170, ry - 2, 115, 14);
  doc.text('Seguradora', rx + 300, ry, { lineBreak: false });
  drawRect(doc, rx + 360, ry - 2, 80, 14);

  ry += 20;
  var markG = m.tipo_seguro === 'seguro_gol' ? '(X)' : '( )';
  doc.text(markG + ' Seguro GOL', rx, ry, { lineBreak: false });
  doc.text('Valor da Mercadoria', rx + 100, ry, { lineBreak: false });
  drawRect(doc, rx + 205, ry - 2, 120, 14);
  if (m.valor_mercadoria) doc.text(m.valor_mercadoria, rx + 209, ry);

  ry += 20;
  var markS = m.tipo_seguro === 'sem_seguro' ? '(X)' : '( )';
  doc.text(markS + ' Sem Seguro - não declare o valor de mercadoria', rx, ry);

  y += segH + gap;

  // AUTORIZAÇÃO
  var authH = 22;
  drawRect(doc, ML, y, TW, authH);
  doc.font('Courier').fontSize(8);
  doc.text('Autorização', ML + 6, y + 7, { lineBreak: false });
  doc.text('[X] Autorizo o(s) embarque(s) do(s) volume(s) relacionado(s), conforme especificações desta minuta', ML + 80, y + 7);
  y += authH + gap;

  var lw = TW * 0.58, nw = TW * 0.42;
  drawField(doc, ML, y, lw, fh, 'Local/Data', m.local_data);
  drawField(doc, ML + lw, y, nw, fh, 'Nome/ Reponsável', m.nome_responsavel);
  y += fh + 16;

  // USO DA GOL
  doc.font('Courier-Bold').fontSize(9);
  doc.text('Uso da GOL', ML, y, { width: TW, align: 'center' });
  y += 14;

  drawField(doc, ML, y, half, fh, 'Recebido em', '');
  drawField(doc, ML + half + 2, y, half, fh, 'Nome/ Reponsável', '');
  y += fh + gap;
  drawField(doc, ML, y, half, fh, 'Conhecimento Aéreo Nº', '');
  drawField(doc, ML + half + 2, y, half, fh, 'Emitido por:', '');

  // Rodapé
  doc.font('Courier').fontSize(7);
  doc.text('Serviço GOLLOG', ML, 820);
  doc.text('FORM - MN-CGO/FF-001-007 - Rev.01 - Abr./2020', ML, 820, { width: TW, align: 'right' });
}

// ══════════════════════════════════════════════════════════════
// FUNÇÃO PRINCIPAL
// ══════════════════════════════════════════════════════════════

async function gerarGT(dados) {
  var doc = new PDFDocument({ size: 'A4', margin: 30 });
  var buffers = [];
  doc.on('data', buffers.push.bind(buffers));

  // ── PÁGINA 1: GT FRONT ──
  var yAfterProducts = desenharGTFront(doc, dados);

  // Barcode
  try {
    var png = await bwipjs.toBuffer({
      bctype: 'code128',
      text: dados.numeroGuia || '0000000000',
      scale: 2,
      height: 10
    });
    doc.image(png, 50, yAfterProducts + 60, { width: 200 });
  } catch (err) {
    console.error('Erro barcode:', err);
  }

  var validadeDate = new Date(new Date().getTime() + 60 * 24 * 60 * 60 * 1000).toLocaleDateString('pt-BR');
  doc.fontSize(9).text('Guia de Tráfego Válida até: ' + validadeDate, 400, yAfterProducts + 60, { align: 'center' });
  doc.fontSize(8).text('Emitido por: JOÃO CARLOS REDIN ' + new Date().toLocaleDateString('pt-BR'), 400, yAfterProducts + 80, { align: 'right' });

  // ── PÁGINAS EXTRAS: VERSO + MINUTA (só para ezequiel_gollog) ──
  if (dados.tipo === 'ezequiel_gollog') {
    // Página 2: Verso GT
    doc.addPage({ size: 'A4', margin: 30 });
    desenharVersoGT(doc, dados);

    // Página 3: Minuta Gollog
    doc.addPage({ size: 'A4', margin: 28 });
    desenharMinuta(doc, dados);
  }

  doc.end();

  return new Promise(function(resolve, reject) {
    doc.on('end', function() {
      var buf = Buffer.concat(buffers);
      var filename = 'GT-' + (dados.dataEmissao || new Date().toISOString().slice(0,10)) + '.pdf';
      resolve({ bytes: buf, filename: filename });
    });
    doc.on('error', reject);
  });
}

module.exports = { gerarGT };
