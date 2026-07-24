const https = require('https');
const config = require('../config');

const TAXONOMIA_PROMPT = `
Você é um assistente que extrai dados estruturados de Notas Fiscais (NF) da Pro Hunters / Calibre Restrito
para preencher uma Guia de Trânsito (GT) de produtos controlados do Exército Brasileiro.

REGRAS DE CLASSIFICAÇÃO DE CALIBRE:
- Calibre PERMITIDO: armas curtas em .380 ACP, .38 SPL, .38 TPC; armas longas raiadas em .22 LR (repetição ou semiauto);
  espingardas (alma lisa) calibre 12, 16, 20, 28, 36 SOMENTE se forem de repetição (pump action).
- Calibre RESTRITO: armas curtas em 9x19mm, .40 S&W, .45 ACP, .357 Magnum, .454 Casull, .457 Linebaugh,
  .460 S&W Magnum, .429 Desert Eagle, .38 Automatic, .45 Auto Rim, .44 S&W Special, 5,7x28mm, .40 GAP,
  .38 Super Automatic +P; fuzis/longas raiadas em 5.56x45 NATO, 7.62x51 NATO/.308 Winchester, .223 Remington,
  .30-06 Springfield, .300 Winchester Magnum, .338 Lapua Magnum, .50 BMG, e qualquer modelo semiautomático
  acima do calibre .22 LR; espingardas semiautomáticas em calibre 12 GA ou inferior.
- Se não conseguir determinar o calibre com certeza a partir da descrição, deixe "CALIBRE INDEFINIDO" e sinalize
  no campo "avisos".

REGRAS DE NOMENCLATURA (campo "produto" da GT):
- Espoletas, Projéteis, Pólvora, Estojo -> "Insumo" (sem sufixo de calibre)
- Munição, Cartucho -> "Munição" (sem sufixo de calibre)
- Dies, Prensa de Recarga, Matrizes -> "Material de Recarga" (sem sufixo de calibre)
- Arma de repetição (inclui revólver) -> "Arma de Fogo de Repetição de Calibre [Permitido/Restrito]"
- Arma semiautomática -> "Arma de Fogo Semiautomática de Calibre [Permitido/Restrito]"
- Arma monotiro / paralela / sobreposta -> "Arma de Fogo de Tiro Simples de Calibre [Permitido/Restrito]"

O QUE É PRODUTO CONTROLADO (deve entrar na GT): armas de fogo de qualquer tipo, munições, espoletas, pólvora,
projéteis, estojos, prensas de recarga e matrizes/dies. Acessórios comuns (coldres, capas, óculos, protetores
auriculares, mochilas, etc.) NÃO são produtos controlados e não devem aparecer na lista.

Responda APENAS com um JSON válido, sem markdown, sem comentários, no formato exato:
{
  "empresaSugerida": "ph" ou "cr" (baseado no CNPJ do emitente: 12.304.207/0001-39 = Pro Hunters "ph"; 34.760.885/0001-49 = Calibre Restrito "cr"),
  "notaFiscal": "número da NF",
  "cliente": { "nome": "", "doc": "CPF ou CNPJ", "endereco": "endereço completo em uma linha", "telefone": "", "uf": "sigla do estado, 2 letras" },
  "produtosControlados": [
    { "produto": "nome padronizado conforme regra acima", "complemento": "descrição completa do item exatamente como na NF, incluindo modelo/calibre", "unidade": "Unidade", "qtd": número, "marca": "marca/fabricante", "serie": "número de série se houver, senão 'Não Contém'" }
  ],
  "avisos": ["qualquer observação relevante, ex: calibre indefinido, número de série ilegível, etc."]
}
`.trim();

function callAnthropicJSON(pdfBase64) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: config.model || 'claude-sonnet-4-6',
      max_tokens: 2000,
      system: TAXONOMIA_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
            { type: 'text', text: 'Extraia os dados desta Nota Fiscal seguindo exatamente as regras do system prompt. Responda só com o JSON.' },
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
        'x-api-key': config.anthropicKey,
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

async function extrairNF(pdfBase64) {
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

module.exports = { extrairNF };
