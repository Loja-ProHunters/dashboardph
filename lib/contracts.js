// lib/contracts.js - Gerador de Contratos

const { Document, Packer, Paragraph, Table, TableRow, TableCell, BorderStyle, WidthType, AlignmentType, TextRun } = require('docx');
const fs = require('fs');
const path = require('path');

/**
 * Substitui placeholders no DOCX template com dados do formulário
 * @param {Buffer} templateBuffer - Arquivo DOCX original
 * @param {Object} dados - Dados para substituição
 * @returns {Promise<Buffer>} - DOCX processado
 */
async function gerarContratoInfluenciador(templateBuffer, dados) {
  const {
    nomeParceiro,
    cpfCnpj,
    endereco,
    cidade,
    uf
  } = dados;

  // Como estamos trabalhando com DOCX binário, vamos fazer substituição de texto
  // Esta é uma abordagem simplificada - para casos reais, use library como docx ou docxtemplater
  
  let conteudo = templateBuffer.toString('binary');
  
  // Substituir variáveis no documento
  conteudo = conteudo.replace(/\[NOME DO PARCEIRO\]/g, nomeParceiro || '');
  conteudo = conteudo.replace(/\[_____________\]/g, cpfCnpj || '');
  conteudo = conteudo.replace(/\[ENDEREÇO COMPLETO\]/g, endereco || '');
  conteudo = conteudo.replace(/\[CIDADE\]/g, cidade || '');
  conteudo = conteudo.replace(/\[UF\]/g, uf || '');
  
  return Buffer.from(conteudo, 'binary');
}

/**
 * Alterna tipo de contrato
 * @param {string} tipo - 'venda_vista', 'venda_parcelada', 'pagamento_combinado', 'parceiro_influenciador'
 * @returns {string} - ID do template
 */
function getTipoContrato(tipo) {
  const tipos = {
    'venda_vista': 'Contrato_Venda_a_Vista.docx',
    'venda_parcelada': 'Contrato_Venda_Parcelada.docx',
    'pagamento_combinado': 'Contrato_Pagamento_Combinado_Programado.docx',
    'parceiro_influenciador': 'Contrato_Parceria_-_Luis__1_.docx'
  };
  return tipos[tipo] || tipo;
}

module.exports = {
  gerarContratoInfluenciador,
  getTipoContrato
};
