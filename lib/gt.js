// lib/gt.js - Gerador de Guias de Trânsito (GT) com quebra de linha na empresa

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

async function gerarGT(dados) {
  const {
    tipo, // 'pessoa_fisica', 'ezequiel', 'ezequiel_gollog'
    numeroGuia,
    dataEmissao,
    nfNumero,
    dataNF,
    destinatario,
    cpfCnpj,
    endereco,
    telefone,
    ufDestino,
    transportador,
    cpfTransportador,
    enderecoTransportador,
    produtos,
    selos
  } = dados;

  const doc = new PDFDocument({ size: 'A4', margin: 30 });
  let buffers = [];
  doc.on('data', buffers.push.bind(buffers));
  doc.on('end', () => {});

  // Header do Exército
  doc.fontSize(9).text('MINISTÉRIO DA DEFESA EXÉRCITO BRASILEIRO COMANDO LOGÍSTICO', { align: 'center' });
  doc.fontSize(8).text('DIRETORIA DE FISCALIZAÇÃO DE PRODUTOS CONTROLADOS', { align: 'center' });
  doc.fontSize(14).text('AUTORIZAÇÃO PARA TRÁFEGO DE PRODUTOS CONTROLADOS', { align: 'center' });

  // Tabela de SFPC / Data / Folha
  doc.fontSize(10).text(`NÚMERO DA GUIA: ${numeroGuia}          SFPC/${sfpcByUF[ufDestino] || '00'}          Folha: 1 de 1`, 50, 120);
  doc.fontSize(10).text(`NOTA FISCAL Nº: ${nfNumero}          DATA: ${dataNF}`);
  doc.fontSize(10).text(`NÚMERO DE VOLUMES: ${selos.length}`);

  // EMPRESA DE ORIGEM - COM QUEBRA DE LINHA
  doc.fontSize(10).text('EMPRESA DE ORIGEM:', 50, 180);
  doc.fontSize(9).text('247056 – CALIBRE RESTRITO', 50, 195);
  doc.fontSize(9).text('COMÉRCIO DE IMPORTAÇÃO LTDA', 50, 207);
  doc.fontSize(9).text('CNPJ: 34.760.885/0001-49', 50, 219);
  doc.fontSize(8).text('RUA ANTÔNIO DA VEIGA 69 SALA 02 ANDAR 2 - VICTOR KONDER', 50, 231);
  doc.fontSize(8).text('Blumenau/SC CEP 89012-500     Telefone: (47) 9176-1291', 50, 241);

  // TRANSPORTADOR
  doc.fontSize(10).text('TRANSPORTADOR:', 50, 270);
  doc.fontSize(9).text(`${transportador}     CNPJ/CPF: ${cpfTransportador}`, 50, 285);
  doc.fontSize(8).text(enderecoTransportador, 50, 295);

  // DESTINATÁRIO
  doc.fontSize(10).text('DESTINATÁRIO:', 50, 320);
  doc.fontSize(9).text(`${destinatario}     CNPJ/CPF: ${cpfCnpj}`, 50, 335);
  doc.fontSize(8).text(endereco, 50, 345);
  doc.fontSize(8).text(`Telefone: ${telefone}`, 50, 355);

  // Tabela de Produtos
  const tableTop = 380;
  const colWidths = { produto: 150, complemento: 100, unidade: 60, qtde: 40, volume: 50, marca: 60, serie: 120 };

  // Headers
  doc.fontSize(9).font('Helvetica-Bold');
  doc.text('Produto', 50, tableTop);
  doc.text('Complemento', 210, tableTop);
  doc.text('Unidade', 320, tableTop);
  doc.text('Qtde.', 390, tableTop);
  doc.text('Volume', 440, tableTop);
  doc.text('Marca', 500, tableTop);
  doc.text('Nº Série', 570, tableTop);

  // Dados dos produtos
  doc.fontSize(8).font('Helvetica');
  let y = tableTop + 25;
  produtos.forEach(p => {
    doc.text(p.produto, 50, y, { width: 150 });
    doc.text(p.complemento || '', 210, y, { width: 100 });
    doc.text(p.unidade || '', 320, y, { width: 60 });
    doc.text(p.qtde || '', 390, y, { width: 40 });
    doc.text(p.volume || '', 440, y, { width: 50 });
    doc.text(p.marca || '', 500, y, { width: 60 });
    doc.text(p.serie || '', 570, y, { width: 120 });
    y += 40;
  });

  // Espaço para selo e assinatura (70px)
  y += 70;

  // Selo de autenticidade
  doc.fontSize(10).text('SELO DE AUTENTICIDADE', 50, y);
  doc.fontSize(9).text('OBRIGATÓRIO O USO DO SELO', 50, y + 20, { color: 'red' });
  doc.fontSize(10).text(`Selo Número: ${selos[0] || ''}`, 50, y + 40);

  // Assinatura
  doc.fontSize(9).text('João Carlos Redin', 400, y, { align: 'center' });
  doc.fontSize(8).text('SÓCIO DIRETOR', 400, y + 15, { align: 'center' });

  // Barcode (Code128) e válidade
  try {
    const png = await bwipjs.toBuffer({
      bctype: 'code128',
      text: numeroGuia,
      scale: 2,
      height: 10
    });
    doc.image(png, 50, y + 60, { width: 200 });
  } catch (err) {
    console.error('Erro ao gerar barcode:', err);
  }

  doc.fontSize(9).text(`Guia de Tráfego Válida até: ${new Date(new Date().getTime() + 60 * 24 * 60 * 60 * 1000).toLocaleDateString('pt-BR')}`, 400, y + 60, { align: 'center' });
  doc.fontSize(8).text(`Emitido por: JOÃO CARLOS REDIN ${new Date().toLocaleDateString('pt-BR')}`, 400, y + 80, { align: 'right' });

  doc.end();

  return new Promise((resolve, reject) => {
    doc.on('end', () => {
      resolve(Buffer.concat(buffers));
    });
    doc.on('error', reject);
  });
}

module.exports = { gerarGT };
