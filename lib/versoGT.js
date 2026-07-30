// lib/versoGT.js - Gerador do Verso da GT com Redespacho Gollog
// Autorização da Base Aérea de Canoas - BACO

const PDFDocument = require('pdfkit');

async function gerarVersoGT(dados) {
  const d = Object.assign({
    numero_guia: '',
    nome_aeroporto: '',
    data: '',
  }, dados || {});

  const doc = new PDFDocument({ size: 'A4', margin: 28 });
  let buffers = [];
  doc.on('data', buffers.push.bind(buffers));

  const W = 595.27;
  const cx = W / 2;

  // Moldura principal
  const boxX = 60;
  const boxW = W - 120;
  const boxH = 370;
  const boxY = 80;

  doc.rect(boxX, boxY, boxW, boxH).stroke();

  // Cabeçalho
  let y = boxY + 35;
  doc.font('Helvetica-Bold').fontSize(13);
  doc.text('MINISTÉRIO DA DEFESA', boxX, y, { width: boxW, align: 'center' });
  y += 18;
  doc.fontSize(12);
  doc.text('BASE AÉREA DE CANOAS - BACO', boxX, y, { width: boxW, align: 'center' });

  // Texto de autorização
  y += 40;
  doc.font('Helvetica').fontSize(10.5);
  doc.text('Autorizo o transporte por via aérea, no material especificado na Guia de Tráfego nº', boxX, y, { width: boxW, align: 'center' });

  y += 18;
  doc.font('Helvetica-Bold').fontSize(11);
  doc.text(d.numero_guia + ',', boxX, y, { width: boxW, align: 'center' });

  y += 16;
  doc.font('Helvetica').fontSize(10.5);
  doc.text('por atender as condições exigidas, conforme o disposto na Lei nº', boxX, y, { width: boxW, align: 'center' });

  y += 16;
  doc.text('11.182/2005 e Decreto nº 5.731/2006', boxX, y, { width: boxW, align: 'center' });

  // Trecho
  y += 35;
  doc.font('Helvetica').fontSize(10.5);
  doc.text('Trecho:', boxX + 40, y, { continued: true, lineBreak: false });
  doc.font('Helvetica-Bold').fontSize(10.5);
  doc.text('  ' + d.nome_aeroporto);

  // Assinatura
  y += 35;
  doc.font('Helvetica').fontSize(10.5);
  doc.text('Assinatura e Carimbo:', boxX, y, { width: boxW, align: 'center' });

  // Data - separada da legislação
  const yData = boxY + boxH - 75;
  doc.font('Helvetica').fontSize(10.5);
  doc.text('Em: ' + d.data, boxX + 12, yData);

  // Legislação no rodapé do box
  let yLeg = boxY + boxH - 48;
  doc.font('Helvetica').fontSize(7.5);
  doc.text('- ICA 55-36 – Autorização de voo no Espaço Aéreo Brasileiro, Portaria nº410/GC3, de 22 de JULHO de 2001', boxX, yLeg, { width: boxW, align: 'center' });
  yLeg += 11;
  doc.text('- AC 1604-0498 de 16 de Abril de 1998', boxX, yLeg, { width: boxW, align: 'center' });
  yLeg += 11;
  doc.text('- DCAR 709/2009, de 03 de novembro de 2009', boxX, yLeg, { width: boxW, align: 'center' });

  doc.end();

  return new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);
  });
}

module.exports = { gerarVersoGT };
