const https = require('https');
const config = require('../config');

const PROMPT = `
Você extrai dados de um "Pedido de Venda" impresso do Bling (Pro Hunters ou Calibre Restrito) para
preencher automaticamente um contrato de compra e venda.

Como identificar a empresa: CNPJ 12.304.207/0001-39 = Pro Hunters ("ph"); CNPJ 34.760.885/0001-49 = Calibre Restrito ("cr").

Como classificar o tipo de contrato a partir da tabela "Parcelas":
- Se houver APENAS 1 parcela (pagamento único) -> tipoSugerido = "avista"
- Se houver 2 OU MAIS parcelas com datas definidas -> tipoSugerido = "parcelado"
Ignore a linha de "N° de itens / Soma das Qtdes / Total..." — essa não é uma parcela.

Monte o campo "produto" com a descrição do(s) item(ns) do pedido (campo "Descrição do produto/serviço").
Se houver mais de um item, junte as descrições separadas por "; ".
NÃO inclua número de série no campo produto (isso não vai no texto do contrato).

Responda APENAS com um JSON válido, sem markdown, no formato exato:
{
  "empresaSugerida": "ph" ou "cr",
  "cliente": { "nome": "", "doc": "CPF ou CNPJ do cliente", "endereco": "endereço completo em uma linha (rua, número, complemento, bairro, cidade/UF, CEP)", "telefone": "" },
  "produto": "descrição do(s) produto(s)",
  "tipoSugerido": "avista" ou "parcelado",
  "valorTotal": número (Total do pedido),
  "parcelas": [
    { "descricao": "texto curto, ex: '1ª Parcela' ou o banco/forma", "valor": número, "forma": "forma de pagamento como está no pedido (ex: Banco C6, Pix, Boleto)", "data": "DD/MM/AAAA (data de vencimento)" }
  ],
  "avisos": ["qualquer observação relevante"]
}
Se tipoSugerido for "avista", ainda assim preencha "parcelas" com o único item (será usado para pegar valor/forma/data).
`.trim();

function callAnthropicJSON(pdfBase64) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: config.model || 'claude-sonnet-4-6',
      max_tokens: 1500,
      system: PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
            { type: 'text', text: 'Extraia os dados deste Pedido de Venda seguindo exatamente as regras do system prompt. Responda só com o JSON.' },
          ],
        },
      ],
    });
    const opts = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.anthropicApiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(payload),
      },
    };
    const r = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    r.on('error', reject);
    r.write(payload);
    r.end();
  });
}

async function extrairPedido(pdfBase64) {
  const result = await callAnthropicJSON(pdfBase64);
  if (result.status !== 200) {
    throw new Error('Erro na API Anthropic: ' + result.body.slice(0, 300));
  }
  const parsed = JSON.parse(result.body);
  const text = (parsed.content || []).map(b => b.text || '').join('');
  let clean = text.trim().replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();
  let data;
  try {
    data = JSON.parse(clean);
  } catch (e) {
    throw new Error('Não foi possível interpretar a resposta da IA. Tente novamente ou preencha manualmente.');
  }
  return data;
}

module.exports = { extrairPedido };
