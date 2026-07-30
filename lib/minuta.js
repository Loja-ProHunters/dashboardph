// lib/minuta.js - Gerador de Minuta de Despacho Eletrônica Gollog
// Réplica fiel do modelo original da Gollog

const PDFDocument = require('pdfkit');

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

async function gerarMinuta(dados) {
  const d = Object.assign({
    servico: 'Urgente',
    forma_pagamento: 'CONTA CORRENTE',
    tipo_entrega: 'RETIRA AEROPORTO',
    aeroporto_retirada: '',
    rem_nome: '', rem_cpf_cnpj: '', rem_endereco: '',
    rem_complemento: '', rem_fone: '', rem_bairro: '',
    rem_uf: '', rem_cep: '', rem_cidade: '', rem_email: '',
    dest_nome: '', dest_cpf_cnpj: '', dest_endereco: '',
    dest_complemento: '', dest_fone: '', dest_bairro: '',
    dest_uf: '', dest_cep: '', dest_cidade: '', dest_email: '',
    tomador_nome: '', tomador_cnpj: '', conta_gollog: '',
    num_volumes: '', peso_total: '', medidas: '',
    produto_predominante: '', artigo_perigoso: '',
    tipo_embalagem: '',
    notas_fiscais: '',
    tipo_seguro: '', num_apolice: '', seguradora: '',
    valor_mercadoria: '',
    local_data: '', nome_responsavel: 'Luis Henrique Gonçalves',
  }, dados || {});

  const doc = new PDFDocument({ size: 'A4', margin: 28 });
  let buffers = [];
  doc.on('data', buffers.push.bind(buffers));

  const W = 595.27;
  const ML = 28;
  const MR = W - 28;
  const TW = MR - ML;

  // ═══════════════════════════════════════════
  // CABEÇALHO
  // ═══════════════════════════════════════════
  let y = 812 - 30;

  doc.font('Courier').fontSize(7);
  doc.text('Notas Fiscais', ML, 15);

  doc.font('Courier-Bold').fontSize(16);
  doc.text('MINUTA DE DESPACHO ELETRÔNICA', ML, 15, { width: TW, align: 'center' });

  drawRect(doc, MR - 55, 12, 55, 20);
  doc.font('Courier').fontSize(9);
  doc.text('Imprimir', MR - 53, 18, { width: 51, align: 'center' });

  doc.font('Courier').fontSize(9);
  doc.text('www.gollog.com.br', ML, 34, { width: TW, align: 'center' });

  // ═══════════════════════════════════════════
  // IMPORTANTE
  // ═══════════════════════════════════════════
  y = 50;
  doc.font('Courier-Bold').fontSize(6.5);
  doc.text('IMPORTANTE:', ML, y);
  y += 9;

  doc.font('Courier').fontSize(6);
  const notas = [
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
  notas.forEach(n => {
    doc.text(n, ML, y, { width: TW });
    y += 7.5;
  });

  // ═══════════════════════════════════════════
  // CAMPOS
  // ═══════════════════════════════════════════
  const fh = 28;
  const gap = 1;

  // Serviço | Pagamento | Entrega | Aeroporto
  y += 6;
  const c1w = TW * 0.22, c2w = TW * 0.26, c3w = TW * 0.27, c4w = TW - c1w - c2w - c3w;
  drawField(doc, ML, y, c1w, fh, 'Serviço GOLLOG', d.servico);
  drawField(doc, ML + c1w, y, c2w, fh, 'Forma de Pagamento', d.forma_pagamento);
  drawField(doc, ML + c1w + c2w, y, c3w, fh, 'Tipo de Entrega', d.tipo_entrega);
  drawField(doc, ML + c1w + c2w + c3w, y, c4w, fh, 'Aeroporto para Retirada', d.aeroporto_retirada);
  y += fh + gap;

  const half = TW / 2 - 1;

  // Remetente / Destinatário
  drawField(doc, ML, y, half, fh, 'Remetente', d.rem_nome);
  drawField(doc, ML + half + 2, y, half, fh, 'Destinatário', d.dest_nome);
  y += fh + gap;

  // CPF/CNPJ
  drawField(doc, ML, y, half, fh, 'CPF / CNPJ', d.rem_cpf_cnpj);
  drawField(doc, ML + half + 2, y, half, fh, 'CPF / CNPJ', d.dest_cpf_cnpj);
  y += fh + gap;

  // Endereço
  drawField(doc, ML, y, half, fh, 'Endereço', d.rem_endereco);
  drawField(doc, ML + half + 2, y, half, fh, 'Endereço', d.dest_endereco);
  y += fh + gap;

  // Complemento + Fone
  const cwComp = half * 0.58, cwFone = half * 0.42;
  drawField(doc, ML, y, cwComp, fh, 'Complemento', d.rem_complemento);
  drawField(doc, ML + cwComp, y, cwFone, fh, 'Fone', d.rem_fone);
  drawField(doc, ML + half + 2, y, cwComp, fh, 'Complemento', d.dest_complemento);
  drawField(doc, ML + half + 2 + cwComp, y, cwFone, fh, 'Fone', d.dest_fone);
  y += fh + gap;

  // Bairro + UF
  const cwBairro = half * 0.78, cwUf = half * 0.22;
  drawField(doc, ML, y, cwBairro, fh, 'Bairro', d.rem_bairro);
  drawField(doc, ML + cwBairro, y, cwUf, fh, 'UF', d.rem_uf);
  drawField(doc, ML + half + 2, y, cwBairro, fh, 'Bairro', d.dest_bairro);
  drawField(doc, ML + half + 2 + cwBairro, y, cwUf, fh, 'UF', d.dest_uf);
  y += fh + gap;

  // CEP + Cidade
  const cwCep = half * 0.35, cwCid = half * 0.65;
  drawField(doc, ML, y, cwCep, fh, 'CEP', d.rem_cep);
  drawField(doc, ML + cwCep, y, cwCid, fh, 'Cidade', d.rem_cidade);
  drawField(doc, ML + half + 2, y, cwCep, fh, 'CEP', d.dest_cep);
  drawField(doc, ML + half + 2 + cwCep, y, cwCid, fh, 'Cidade', d.dest_cidade);
  y += fh + gap;

  // E-mail
  drawField(doc, ML, y, half, fh, 'e-mail', d.rem_email);
  drawField(doc, ML + half + 2, y, half, fh, 'e-mail', d.dest_email);
  y += fh + gap;

  // Tomador do Frete + CNPJ + Conta Gollog
  const tw1 = TW * 0.40, tw2 = TW * 0.35, tw3 = TW * 0.25;
  drawField(doc, ML, y, tw1, fh, 'Tomador do Frete', d.tomador_nome);
  drawField(doc, ML + tw1, y, tw2, fh, 'CNPJ', d.tomador_cnpj);
  drawField(doc, ML + tw1 + tw2, y, tw3, fh, 'Nº Conta Gollog', d.conta_gollog);
  y += fh + 4;

  // Volumes / Peso / Medidas
  const vw1 = TW * 0.25, vw2 = TW * 0.25, vw3 = TW * 0.50;
  drawField(doc, ML, y, vw1, fh, 'Nº de Volumes', d.num_volumes);
  drawField(doc, ML + vw1, y, vw2, fh, 'Peso Total', d.peso_total);
  drawField(doc, ML + vw1 + vw2, y, vw3, fh, 'Medidas das Embalagens', d.medidas);
  y += fh + gap;

  // Produto + Artigo + Embalagem
  const pw1 = TW * 0.40, pw2 = TW * 0.30, pw3 = TW * 0.30;
  drawField(doc, ML, y, pw1, fh, 'Produto Predominante', d.produto_predominante);
  drawField(doc, ML + pw1, y, pw2, fh, 'Artigo Perigoso UN', d.artigo_perigoso);
  drawField(doc, ML + pw1 + pw2, y, pw3, fh, 'Tipo de Embalagem', d.tipo_embalagem);
  y += fh + gap;

  // Notas Fiscais
  drawField(doc, ML, y, TW, fh, 'Notas Fiscais', d.notas_fiscais);
  y += fh + gap;

  // ═══════════════════════════════════════════
  // SEGURO
  // ═══════════════════════════════════════════
  const segH = 62;
  drawRect(doc, ML, y, TW, segH);

  doc.font('Courier').fontSize(8);
  doc.text('Tipo de Seguro', ML + 6, y + 8);

  const rx = ML + 100;
  let ry = y + 6;
  const markP = d.tipo_seguro === 'proprio' ? '(X)' : '( )';
  doc.text(markP + ' Próprio', rx, ry, { lineBreak: false });
  doc.text('Nº de Apolice', rx + 100, ry, { lineBreak: false });
  drawRect(doc, rx + 170, ry - 2, 115, 14);
  if (d.num_apolice) doc.text(d.num_apolice, rx + 174, ry);
  doc.text('Seguradora', rx + 300, ry, { lineBreak: false });
  drawRect(doc, rx + 360, ry - 2, 80, 14);
  if (d.seguradora) doc.text(d.seguradora, rx + 364, ry);

  ry += 20;
  const markG = d.tipo_seguro === 'seguro_gol' ? '(X)' : '( )';
  doc.text(markG + ' Seguro GOL', rx, ry, { lineBreak: false });
  doc.text('Valor da Mercadoria', rx + 100, ry, { lineBreak: false });
  drawRect(doc, rx + 205, ry - 2, 120, 14);
  if (d.valor_mercadoria) doc.text(d.valor_mercadoria, rx + 209, ry);

  ry += 20;
  const markS = d.tipo_seguro === 'sem_seguro' ? '(X)' : '( )';
  doc.text(markS + ' Sem Seguro - não declare o valor de mercadoria', rx, ry);

  y += segH + gap;

  // ═══════════════════════════════════════════
  // AUTORIZAÇÃO
  // ═══════════════════════════════════════════
  const authH = 22;
  drawRect(doc, ML, y, TW, authH);
  doc.font('Courier').fontSize(8);
  doc.text('Autorização', ML + 6, y + 7, { lineBreak: false });
  doc.text('[X] Autorizo o(s) embarque(s) do(s) volume(s) relacionado(s), conforme especificações desta minuta', ML + 80, y + 7);
  y += authH + gap;

  // Local/Data + Nome
  const lw = TW * 0.58, nw = TW * 0.42;
  drawField(doc, ML, y, lw, fh, 'Local/Data', d.local_data);
  drawField(doc, ML + lw, y, nw, fh, 'Nome/ Reponsável', d.nome_responsavel);
  y += fh + 16;

  // ═══════════════════════════════════════════
  // USO DA GOL
  // ═══════════════════════════════════════════
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

  doc.end();

  return new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);
  });
}

module.exports = { gerarMinuta };
