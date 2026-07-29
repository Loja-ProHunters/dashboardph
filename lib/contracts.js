// lib/contracts.js - Gerador de Contratos

const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

// Função original - gera PDF a partir de template
async function gerarContrato(dados) {
  const { tipo = 'venda_vista', cliente, produto, valor, parcelas } = dados;
  
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  let buffers = [];
  doc.on('data', buffers.push.bind(buffers));
  
  try {
    // Header
    doc.fontSize(12).font('Helvetica-Bold').text('CONTRATO', { align: 'center' });
    doc.fontSize(10).font('Helvetica').text(getTipoContrato(tipo), { align: 'center' });
    doc.moveDown();
    
    // Dados do cliente
    doc.text('CLIENTE:', { underline: true });
    doc.text(`Nome: ${cliente?.nome || 'N/A'}`);
    doc.text(`Documento: ${cliente?.doc || 'N/A'}`);
    doc.text(`Endereço: ${cliente?.endereco || 'N/A'}`);
    doc.moveDown();
    
    // Produto
    doc.text('PRODUTO:', { underline: true });
    doc.text(`${produto || 'N/A'}`);
    doc.text(`Valor: R\$ ${valor || '0,00'}`);
    
    if (parcelas) {
      doc.text(`Parcelas: ${parcelas}x`);
    }
    
    doc.moveDown(3);
    doc.text('________________          ________________', { align: 'center' });
    doc.text('Assinatura Cliente          Assinatura Empresa', { align: 'center' });
    
    doc.end();
    
    return new Promise((resolve, reject) => {
      doc.on('end', () => {
        const bytes = Buffer.concat(buffers);
        resolve({
          bytes,
          filename: `Contrato_${cliente?.nome || 'cliente'}_${Date.now()}.pdf`
        });
      });
      doc.on('error', reject);
    });
  } catch (e) {
    throw new Error('Erro ao gerar PDF: ' + e.message);
  }
}

// Função nova - Contrato Parceiro Influenciador
async function gerarContratoInfluenciador(templateBuffer, dados) {
  const {
    nomeParceiro,
    cpfCnpj,
    endereco,
    cidade,
    uf
  } = dados;

  try {
    let conteudo = templateBuffer.toString('binary');
    
    // Substituir variáveis no documento
    conteudo = conteudo.replace(/\[NOME DO PARCEIRO\]/g, nomeParceiro || '');
    conteudo = conteudo.replace(/\[_____________\]/g, cpfCnpj || '');
    conteudo = conteudo.replace(/\[ENDEREÇO COMPLETO\]/g, endereco || '');
    conteudo = conteudo.replace(/\[CIDADE\]/g, cidade || '');
    conteudo = conteudo.replace(/\[UF\]/g, uf || '');
    
    return Buffer.from(conteudo, 'binary');
  } catch (e) {
    throw new Error('Erro ao processar contrato: ' + e.message);
  }
}

// Função auxiliar - retorna nome do template
function getTipoContrato(tipo) {
  const tipos = {
    'venda_vista': 'Contrato de Venda à Vista',
    'venda_parcelada': 'Contrato de Venda Parcelada',
    'pagamento_combinado': 'Contrato de Pagamento Combinado Programado',
    'parceiro_influenciador': 'Contrato de Parceria - Influenciador'
  };
  return tipos[tipo] || tipo;
}

module.exports = {
  gerarContrato,
  gerarContratoInfluenciador,
  getTipoContrato
};
