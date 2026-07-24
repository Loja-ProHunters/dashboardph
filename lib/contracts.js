
const { LetterheadDoc, loadAsset } = require('./pdfDoc');
const companies = require('./companies');

function fmtMoney(v) {
  const n = Number(v) || 0;
  return 'R$ ' + n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function todayBR() {
  const d = new Date();
  return String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0') + '/' + d.getFullYear();
}

function sanitizeFilenamePart(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9 \-]/g, '')
    .trim();
}

async function buildHeaderAndParties(doc, empresa, cliente, tituloContrato) {
  doc.addParagraph(tituloContrato, { size: 14, center: true, gapAfter: 18 });
  doc.addParagraph([
    { text: 'CONTRATANTE', bold: true },
    { text: `: ${cliente.nome}, inscrito no CPF/CNPJ nº ${cliente.doc}, residente e domiciliado na ${cliente.endereco}. Doravante denominado simplesmente `, bold: false },
    { text: 'CONTRATANTE.', bold: true },
  ]);
  doc.addParagraph([
    { text: 'CONTRATADA', bold: true },
    { text: `: ${empresa.nome}, Pessoa jurídica, inscrita no CNPJ, nº ${empresa.cnpj}, com escritório na ${empresa.endereco}, neste ato representada por seu sócio diretor, `, bold: false },
    { text: companies.representante.nome, bold: true },
    { text: `, brasileiro, inscrito no CPF nº ${companies.representante.cpf}, residente e domiciliado na Rua Antônio da Veiga, nº 105, Térreo, Bairro Victor Konder, CEP: 89012-500 em Blumenau – SC. Doravante denominada simplesmente `, bold: false },
    { text: 'CONTRATADA.', bold: true },
  ]);
  doc.addParagraph('As partes acima identificadas têm, entre si, justo e acertado o presente contrato, que se regerá pelas cláusulas seguintes e condições que mutuamente aceitam e outorgam, a saber;', { gapAfter: 14 });
}

function footerSignature(doc, empresa, cliente) {
  doc.addParagraph(`Por estarem assim justos e contratados, firmam o presente instrumento, em duas vias de igual teor, juntamente com 2 (duas) testemunhas.`, { gapAfter: 6 });
  doc.addParagraph(`Blumenau, ${todayBR()}`, { gapAfter: 20 });
  doc.addSignatureBlock({
    leftTitle: 'CONTRATADA',
    leftName: companies.representante.nome,
    leftDoc: 'CPF/MF nº ' + companies.representante.cpf,
    leftExtra: empresa.nome,
    rightTitle: 'CONTRATANTE',
    rightName: cliente.nome,
    rightDoc: 'CPF/MF nº ' + cliente.doc,
  });
  doc.addSpacer(20);
  doc.addParagraph('Testemunhas:', { gapAfter: 30 });
  doc.addSignatureBlock({
    leftTitle: '', leftName: 'Nome:', leftDoc: 'CPF/MF n°:', leftExtra: null,
    rightTitle: '', rightName: 'Nome:', rightDoc: 'CPF/MF n°:',
  });
}

async function makeDoc(empresaKey) {
  const empresa = companies[empresaKey];
  const logoBytes = loadAsset(empresa.logo);
  const doc = new LetterheadDoc({
    logoBytes,
    footerLines: [empresa.footerLegal, empresa.footerEndereco, empresa.footerCidade],
  });
  await doc.init();
  return { doc, empresa };
}

// ---------- Modelo A: À Vista ----------
async function gerarAVista(data) {
  const { doc, empresa } = await makeDoc(data.empresa);
  const cliente = data.cliente;
  await buildHeaderAndParties(doc, empresa, cliente, 'CONTRATO DE ANTECIPAÇÃO DE VALORES PARA COMPRA DE PRODUTO');

  doc.addParagraph([{ text: 'I – DO OBJETO', bold: true }], { gapAfter: 8 });
  doc.addParagraph([
    { text: 'Cláusula Primeira. ', bold: true },
    { text: `O presente contrato tem como objeto ${data.produto}. A nota fiscal do produto será emitida no prazo máximo de 48 horas a partir da apresentação da autorização deferida apresentada a CONTRATADA.`, bold: false },
  ]);

  doc.addParagraph([{ text: 'II - DO PAGAMENTO', bold: true }], { gapAfter: 8 });
  doc.addParagraph([
    { text: 'Cláusula Segunda. ', bold: true },
    { text: 'O CONTRATANTE se reconhece pagador da quantia paga à CONTRATADA.', bold: false },
  ]);
  doc.addParagraph([
    { text: 'Cláusula Terceira. ', bold: true },
    { text: `Será dado em garantia, o penhor da mercadoria ${data.produto}. Tais mercadorias depositadas em nome da CONTRATADA no bunker da empresa situada à ${empresa.enderecoBunker}.`, bold: false },
  ]);

  doc.addParagraph([{ text: 'III - DO PAGAMENTO', bold: true }], { gapAfter: 8 });
  if (data.personalizado) {
    doc.addParagraph([
      { text: 'Cláusula Quarta. ', bold: true },
      { text: data.textoPersonalizado, bold: false },
    ]);
  } else {
    doc.addParagraph([
      { text: 'Cláusula Quarta. ', bold: true },
      { text: `O montante de ${fmtMoney(data.valor)} pago por ${data.formaPagamento} no dia ${data.dataPagamento}. Salvo o contratante do reembolso interino sem taxas ou multas em caso de problemas de fabricação ou disponibilidade imediata do item.`, bold: false },
    ]);
  }
  doc.addParagraph([
    { text: 'Cláusula Quinta. ', bold: true },
    { text: 'O pagamento fornecido pelo CONTRATANTE não está sujeito a charge-back ou cancelamento transacional, salvo da ocorrência presente na cláusula quarta. Fica de responsabilidade da CONTRATADA a reserva imediata do item após o pagamento, incluindo modelo, unidade e número de série.', bold: false },
  ]);
  doc.addParagraph([
    { text: 'Cláusula Sexta. ', bold: true },
    { text: 'Em caso de problemas para emissão de autorização de compra ou emissão do CRAF por qualquer motivo de legislação a CONTRATADA se compromete a reembolsar o valor pago pelo CONTRATANTE sem juros ou qualquer tipo de correção monetária. Sendo necessário a apresentação do comprovante de indeferimento.', bold: false },
  ]);

  doc.addParagraph([{ text: 'IV - DOS DIREITOS E OBRIGAÇÕES DO CONTRATANTE', bold: true }], { gapAfter: 8 });
  doc.addParagraph([
    { text: 'Cláusula Sétima. ', bold: true },
    { text: 'O CONTRATANTE reconhece o pagamento do item citado na cláusula primeira como quitado. Caso o CONTRATANTE desista por quaisquer motivos exceto citado na cláusula sexta, da aquisição a CONTRATADA irá fazer a devolução do valor do produto e aplicará a multa de 30%. O valor devolvido pela CONTRATADA não contemplará juros ou qualquer correção monetária. Não haverá, para isso, necessidade de nenhuma espécie de formalidade judicial ou extrajudicial.', bold: false },
  ]);
  doc.addParagraph([
    { text: 'Cláusula Oitava. ', bold: true },
    { text: 'A Nota Fiscal será emitida mediante apresentação de Certificado de Registro, Documento de Identificação e Comprovante de Endereço do CONTRATANTE.', bold: false },
  ]);
  doc.addParagraph([
    { text: 'Cláusula Nona. ', bold: true },
    { text: 'O objeto deste contrato será despachado pela TRANSPORTADORA E/OU GOLLOG e as despesas de despacho correm por conta do CONTRATANTE ou poderá ser retirado da empresa.', bold: false },
  ]);

  doc.addParagraph([{ text: 'V - DA RESCISÃO', bold: true }], { gapAfter: 8 });
  doc.addParagraph([
    { text: 'Cláusula Décima. ', bold: true },
    { text: 'O contrato poderá ser rescindido de pleno direito pelo CONTRATANTE sem multas ou taxas caso o item citado neste instrumento não esteja de acordo com o ofertado pela CONTRATADA e se o item apresentar quaisquer defeitos de fabricação ou disponibilidade.', bold: false },
  ]);

  doc.addParagraph([{ text: 'VI - DO FORO', bold: true }], { gapAfter: 8 });
  doc.addParagraph([
    { text: 'Cláusula Décima Primeira. ', bold: true },
    { text: 'Para dirigir quaisquer controvérsias oriundas do CONTRATO, as partes elegem o foro da comarca de Blumenau-SC.', bold: false },
  ], { gapAfter: 16 });

  footerSignature(doc, empresa, cliente);
  return doc.finish();
}

// ---------- Modelo B: Parcelado ----------
async function gerarParcelado(data) {
  const { doc, empresa } = await makeDoc(data.empresa);
  const cliente = data.cliente;
  await buildHeaderAndParties(doc, empresa, cliente, 'CONTRATO DE ANTECIPAÇÃO DE VALORES PARA COMPRA DE PRODUTO');

  doc.addParagraph([{ text: 'I – DO OBJETO', bold: true }], { gapAfter: 8 });
  doc.addParagraph([
    { text: 'Cláusula Primeira. ', bold: true },
    { text: `O presente contrato tem como objeto ${data.produto}. A nota fiscal do produto será emitida no prazo máximo de 48 horas a partir da apresentação da autorização deferida apresentada a CONTRATADA.`, bold: false },
  ]);

  doc.addParagraph([{ text: 'II - DA DÍVIDA E DA GARANTIA DE PAGAMENTO', bold: true }], { gapAfter: 8 });
  doc.addParagraph([
    { text: 'Cláusula Segunda. ', bold: true },
    { text: 'O CONTRATANTE se reconhece devedor da quantia de que deverá ser paga à CONTRATADA.', bold: false },
  ]);
  doc.addParagraph([
    { text: 'Cláusula Terceira. ', bold: true },
    { text: `Será dado em garantia de quitação do débito, o penhor da mercadoria ${data.produto}.`, bold: false },
  ]);

  doc.addParagraph([{ text: 'III - DO PAGAMENTO', bold: true }], { gapAfter: 8 });
  if (data.personalizado) {
    doc.addParagraph([
      { text: 'Cláusula Quarta. ', bold: true },
      { text: data.textoPersonalizado, bold: false },
    ]);
  } else {
    doc.addParagraph([
      { text: 'Cláusula Quarta. ', bold: true },
      { text: `O montante deverá ser quitado por PIX ou Boleto totalizando ${fmtMoney(data.valorTotal)}, a ser pago nas datas abaixo especificadas:`, bold: false },
    ]);
    doc.addSpacer(4);
    (data.parcelas || []).forEach(p => {
      doc.addParagraph(`${p.descricao} de ${fmtMoney(p.valor)} no ${p.forma} no dia ${p.data}`, { gapAfter: 4 });
    });
    doc.addSpacer(6);
  }
  doc.addParagraph([
    { text: 'Cláusula Quinta. ', bold: true },
    { text: 'Em caso de problemas para emissão de autorização de compra ou emissão do CRAF por qualquer motivo de legislação a CONTRATADA se compromete a reembolsar o valor pago pelo CONTRATANTE sem juros ou qualquer tipo de correção monetária, isso se apresentado o comprovante de indeferimento da solicitação.', bold: false },
  ]);

  doc.addParagraph([{ text: 'IV - DOS DIREITOS E OBRIGAÇÕES DO CONTRATANTE', bold: true }], { gapAfter: 8 });
  doc.addParagraph([
    { text: 'Cláusula Sexta. ', bold: true },
    { text: 'O CONTRATANTE compromete-se a quitar os boletos/PIX nas datas ora acertadas sob pena de ter esse instrumento cancelado. Caso o CONTRATANTE não cumpra com sua obrigação de quitar os boletos especificados, a CONTRATADA poderá dispor do objeto desse contrato que estará sob seu poder. Neste caso, ou em caso de desistência por parte do CONTRATANTE a CONTRATADA irá fazer a devolução do valor do produto e aplicará a multa de 30% do valor já pago. O valor devolvido pela CONTRATADA não contemplará juros ou qualquer correção monetária. Não haverá, para isso, necessidade de nenhuma espécie de formalidade judicial ou extrajudicial.', bold: false },
  ]);
  doc.addParagraph([
    { text: 'Cláusula Sétima. ', bold: true },
    { text: 'Caso o CONTRATANTE não cumpra com sua obrigação de quitar os boletos especificados, a CONTRATADA poderá dispor do objeto desse contrato que estará sob seu poder, desde que devolva o valor já quitado pelo CONTRATANTE. Salvo o valor de 30% de multa aplicada, sem juros ou qualquer correção monetária. Não haverá, para isso, necessidade de nenhuma espécie de formalidade judicial ou extrajudicial.', bold: false },
  ]);
  doc.addParagraph([
    { text: 'Cláusula Oitava. ', bold: true },
    { text: 'A Nota Fiscal será emitida mediante apresentação da Autorização de compra deferida, Documento de Identificação e Comprovante de Endereço do CONTRATANTE.', bold: false },
  ]);
  doc.addParagraph([
    { text: 'Cláusula Nona. ', bold: true },
    { text: 'O objeto deste contrato será despachado pela TRANSPORTADORA E/OU GOLLOG e as despesas de despacho correm por conta do CONTRATANTE ou poderá ser retirado da empresa somente depois de totalmente quitado.', bold: false },
  ]);
  doc.addParagraph([
    { text: 'Cláusula Décima. ', bold: true },
    { text: 'Se houver atraso no pagamento de duas parcelas, consecutivas ou não, haverá rescisão do contrato, podendo a CONTRATADA dispor da mercadoria dada como garantia de pagamento da dívida.', bold: false },
  ]);

  doc.addParagraph([{ text: 'VI - DO FORO', bold: true }], { gapAfter: 8 });
  doc.addParagraph([
    { text: 'Cláusula Décima Primeira. ', bold: true },
    { text: 'Para dirimir quaisquer controvérsias oriundas do CONTRATO, as partes elegem o foro da comarca de Blumenau-SC.', bold: false },
  ], { gapAfter: 16 });

  footerSignature(doc, empresa, cliente);
  return doc.finish();
}

// ---------- Modelo C: Pagamento Combinado Programado (só PH) ----------
async function gerarCombinado(data) {
  const { doc, empresa } = await makeDoc('ph');
  const cliente = data.cliente;
  await buildHeaderAndParties(doc, empresa, cliente, 'CONTRATO DE COMPRA POR PAGAMENTO COMBINADO PROGRAMADO');

  doc.addParagraph([{ text: 'I – DO OBJETO', bold: true }], { gapAfter: 8 });
  doc.addParagraph([
    { text: 'Cláusula Primeira. ', bold: true },
    { text: `O presente contrato tem como objeto ${data.produto}. A nota fiscal do produto será emitida no prazo máximo de 48 horas a partir da apresentação da autorização deferida apresentada a CONTRATADA.`, bold: false },
  ]);

  doc.addParagraph([{ text: 'II - DO PAGAMENTO', bold: true }], { gapAfter: 8 });
  doc.addParagraph([
    { text: 'Cláusula Segunda. ', bold: true },
    { text: 'Para adesão ao presente contrato, o CONTRATANTE deverá efetuar o pagamento de entrada correspondente a 20% (vinte por cento) do valor total do produto.', bold: false },
  ]);
  doc.addParagraph('A entrada tem como finalidade a formalização da intenção de compra, a reserva do equipamento e a cobertura de custos administrativos.');
  doc.addParagraph([
    { text: 'Cláusula Terceira. ', bold: true },
    { text: `Será dado em garantia, o penhor da mercadoria ${data.produto}. Tais mercadorias depositadas em nome da CONTRATADA no bunker da empresa situada à ${empresa.enderecoBunker}.`, bold: false },
  ]);
  if (data.personalizado) {
    doc.addParagraph([
      { text: 'Cláusula Quarta. ', bold: true },
      { text: data.textoPersonalizado, bold: false },
    ]);
  } else {
    doc.addParagraph([
      { text: 'Cláusula Quarta. ', bold: true },
      { text: `Após o pagamento da entrada, o CONTRATANTE compromete-se a realizar pagamentos mensais mínimos equivalentes a 5% (cinco por cento) do valor total inicial do produto citado na cláusula primeira.`, bold: false },
    ]);
    doc.addParagraph(`O pagamento será realizado por ${data.formaPagamento}, em data previamente acordada entre as partes.`);
  }
  doc.addParagraph([
    { text: 'Cláusula Quinta. ', bold: true },
    { text: 'O pagamento fornecido pelo CONTRATANTE não está sujeito a charge-back ou cancelamento transacional, salvo da ocorrência presente no inciso III. Fica de responsabilidade da CONTRATADA a reserva imediata do item após o pagamento, incluindo modelo, unidade e número de série.', bold: false },
  ]);

  doc.addParagraph([{ text: 'III - DO ESTORNO DE VALORES EM CASO DE INDEFERIMENTO', bold: true }], { gapAfter: 8 });
  doc.addParagraph('Em caso de indeferimento definitivo da documentação do CONTRATANTE pelos órgãos competentes, devidamente comprovado, a CONTRATADA compromete-se a realizar o estorno dos valores efetivamente pagos, sem incidência de juros ou correção monetária, no prazo máximo de até 45 (quarenta e cinco) dias corridos, contados a partir da data da apresentação formal do comprovante de indeferimento.');
  doc.addParagraph([
    { text: 'Parágrafo Primeiro. ', bold: true },
    { text: 'O prazo estabelecido neste artigo justifica-se pela necessidade de apuração, compensação, restituição ou estorno de tributos incidentes sobre as operações financeiras e comerciais realizadas, sendo vedado à CONTRATADA o adiantamento de valores antes da efetiva recuperação fiscal correspondente.', bold: false },
  ]);
  doc.addParagraph([
    { text: 'Parágrafo Segundo. ', bold: true },
    { text: 'O CONTRATANTE declara ciência e concordância de que o referido prazo é razoável, necessário e proporcional, não configurando mora, inadimplemento ou retenção indevida de valores por parte da CONTRATADA.', bold: false },
  ]);

  doc.addParagraph([{ text: 'IV - DOS DIREITOS E OBRIGAÇÕES DO CONTRATANTE', bold: true }], { gapAfter: 8 });
  doc.addParagraph([
    { text: 'Cláusula Sexta. ', bold: true },
    { text: 'O CONTRATANTE reconhece o pagamento do item citado na cláusula primeira como a reserva do item. Caso o CONTRATANTE desista por quaisquer motivos exceto citado no inciso IV, da aquisição a CONTRATADA irá fazer a devolução do valor do produto e aplicará a multa de 30% sobre o valor pago até o momento. O valor devolvido pela CONTRATADA não contemplará juros ou qualquer correção monetária. Não haverá, para isso, necessidade de nenhuma espécie de formalidade judicial ou extrajudicial.', bold: false },
  ]);
  doc.addParagraph([
    { text: 'Cláusula Sétima. Da INADIMPLÊNCIA. ', bold: true },
    { text: 'O não pagamento do valor mínimo mensal por dois meses consecutivos caracterizará inadimplência grave, acarretando:', bold: false },
  ]);
  doc.addParagraph('I – Cancelamento automático do contrato;');
  doc.addParagraph('II – Perda integral do valor pago até o momento;');
  doc.addParagraph('III – Cancelamento da reserva do equipamento.', { gapAfter: 10 });
  doc.addParagraph([
    { text: 'Cláusula Oitava. ', bold: true },
    { text: 'A Nota Fiscal será emitida mediante apresentação de Certificado de Registro, Documento de Identificação e Comprovante de Endereço do CONTRATANTE.', bold: false },
  ]);
  doc.addParagraph([
    { text: 'Cláusula Nona. ', bold: true },
    { text: 'O objeto deste contrato será despachado pela TRANSPORTADORA E/OU GOLLOG e as despesas de despacho correm por conta do CONTRATANTE ou poderá ser retirado da empresa.', bold: false },
  ]);

  doc.addParagraph([{ text: 'V - DA RESCISÃO', bold: true }], { gapAfter: 8 });
  doc.addParagraph([
    { text: 'Cláusula Décima. ', bold: true },
    { text: 'O contrato poderá ser rescindido de pleno direito pelo CONTRATANTE sem multas ou taxas caso o item citado neste instrumento não esteja de acordo com o ofertado pela CONTRATADA e se o item apresentar quaisquer defeitos de fabricação ou disponibilidade.', bold: false },
  ]);

  doc.addParagraph([{ text: 'VI - DO FORO', bold: true }], { gapAfter: 8 });
  doc.addParagraph([
    { text: 'Cláusula Décima Primeira. ', bold: true },
    { text: 'Para dirigir quaisquer controvérsias oriundas do CONTRATO, as partes elegem o foro da comarca de Blumenau-SC.', bold: false },
  ], { gapAfter: 16 });

  footerSignature(doc, empresa, cliente);
  return doc.finish();
}

async function gerarContrato(data) {
  let bytes;
  if (data.tipo === 'avista') bytes = await gerarAVista(data);
  else if (data.tipo === 'parcelado') bytes = await gerarParcelado(data);
  else if (data.tipo === 'combinado') bytes = await gerarCombinado(data);
  else throw new Error('Tipo de contrato inválido.');

  const empresaNome = data.tipo === 'combinado' ? 'Pro Hunters' : (data.empresa === 'ph' ? 'Pro Hunters' : 'Calibre Restrito');
  const formaPagto = data.personalizado
    ? 'Negociacao Personalizada'
    : (data.tipo === 'parcelado' ? 'Parcelado' : (data.tipo === 'combinado' ? 'Combinado Programado' : (data.formaPagamento || 'Pagamento')));

  const dataStr = todayBR().split('/').reverse().join('-'); // AAAA-MM-DD
  const filename = `${dataStr} - ${sanitizeFilenamePart(data.cliente.nome)} - ${sanitizeFilenamePart(empresaNome)} - ${sanitizeFilenamePart(formaPagto)}.pdf`;

  return { bytes, filename };
}

module.exports = { gerarContrato };
