  return Number.isFinite(n) ? n : 0;
}

// ── Telefone / WhatsApp ──────────────────────────────────────────
// REGRA DE NEGÓCIO (Luis, out/2026): quando o cliente tem DOIS números no
// cadastro do Bling (um no campo "Telefone"/fixo e outro no "Celular"), o
// botão do WhatsApp SEMPRE usa o número do campo CELULAR — é o que tem mais
// chance de estar no WhatsApp. Só caímos pros outros campos quando o celular
// está vazio. Centralizamos a escolha aqui pra todo lugar seguir a mesma regra.
function _soDigitos(v) { return String(v || '').replace(/\D/g, ''); }

// Heurística de celular BR: 11 díg (DDD + 9xxxxxxxx) ou 9 díg começando em 9.
// Tolera o prefixo de país 55. Usada só como desempate quando o campo celular
// está vazio e sobram vários candidatos (NÃO sobrepõe a regra do campo celular).
function _pareceCelular(v) {
  let d = _soDigitos(v);
  if (d.length > 11 && d.startsWith('55')) d = d.slice(2);
  if (d.length === 11) return d[2] === '9';
  if (d.length === 9)  return d[0] === '9';
  return false;
}

// Escolhe o telefone de um objeto de contato do Bling seguindo a regra:
//   1º) campo CELULAR, se tiver número válido (>= 8 dígitos);
//   2º) senão, entre telefone/fone/adicional, um que PAREÇA celular;
//   3º) senão, o primeiro número válido que houver.
// Devolve a string original (formatada) ou null.
function escolherTelefone(c) {
  if (!c || typeof c !== 'object') return null;
  const valido = (v) => _soDigitos(v).length >= 8;
  if (valido(c.celular)) return String(c.celular).trim();           // 1º — regra do CELULAR
  const outros = [c.telefone, c.fone, c.telefoneAdicional].filter(valido);
  if (!outros.length) return null;
  const movel = outros.find(_pareceCelular);                        // 2º — desempate por celular
  return String(movel || outros[0]).trim();                         // 3º — primeiro válido
}

// ── Puxa lista paginada de pedidos ───────────────────────────────
// Bling API v3: GET /pedidos/vendas?pagina=1&limite=100&dataInicial=...&dataFinal=...
// Retorna: { data: [ {id, numero, ...}, ... ] }
@@ -280,7 +314,7 @@ async function processarPedido(detalhe, snapshot, ctx = {}) {
      razao_social: tipoDoc === 'pj' ? nome : null,
      nome_fantasia: contato.nomeFantasia || null,
      email: contato.email || null,
      telefone: contato.telefone || contato.celular || null,
      telefone: escolherTelefone(contato), // regra: CELULAR primeiro
      endereco: contato.endereco || null,
      status: 'ativo',
      owner_id: ctx.ownerFallback || 'gerencia',
@@ -384,9 +418,9 @@ async function processarPedido(detalhe, snapshot, ctx = {}) {
  }
  // Telefone: se a conta ainda nao tem e o payload do pedido trouxe um, aproveita
  // (sem custo de API). O enriquecimento via /contatos/{id} cobre o resto.
  if ((!account.telefone || !String(account.telefone).replace(/\D/g, '')) && (contato.telefone || contato.celular)) {
    account.telefone = contato.celular || contato.telefone;
    account.telefone_indisponivel = false;
  if ((!account.telefone || !_soDigitos(account.telefone)) ) {
    const telPedido = escolherTelefone(contato); // regra: CELULAR primeiro
    if (telPedido) { account.telefone = telPedido; account.telefone_indisponivel = false; }
  }
  // Categorias distintas compradas
  const catsSet = new Set(account.categorias_compradas || []);
@@ -422,28 +456,35 @@ async function processarPedido(detalhe, snapshot, ctx = {}) {
async function buscarTelefoneContato(contatoId, contaId) {
  const r = await blingApi.get('/contatos/' + encodeURIComponent(String(contatoId)), {}, contaId);
  const c = (r && r.data) || {};
  const bruto = c.celular || c.telefone || c.fone || c.telefoneAdicional || null;
  if (!bruto) return null;
  const s = String(bruto).trim();
  return s.replace(/\D/g, '').length >= 8 ? s : null;
  // Segue a regra única: campo CELULAR primeiro (ver escolherTelefone acima).
  return escolherTelefone(c);
}

// Varre os accounts SEM telefone e tenta preencher buscando o contato no Bling.
// Limitada por maxLookups (chamadas de API) pra respeitar rate-limit e tempo —
// o endpoint faz auto-chain ate zerar. Marca telefone_indisponivel nos que o
// Bling tambem nao tem numero, pra nao ficar tentando os mesmos pra sempre.
async function enriquecerTelefones({ maxLookups = 60, forcar = false } = {}) {
// repuxarNaoCelular: além dos accounts SEM telefone, reprocessa também os que
// JÁ têm número mas ele NÃO parece celular (fixo 10 díg) — pra trocar pelo
// celular do Bling quando houver. Nesse modo só sobrescreve se o novo número
// parecer celular (nunca rebaixa um número bom por um fixo).
async function enriquecerTelefones({ maxLookups = 60, forcar = false, repuxarNaoCelular = false } = {}) {
  const crmStore = require('../crm/store');
  const col = await crmStore.getCollection('accounts');
  const ids = Object.keys(col || {});
  let lookups = 0, atualizados = 0, marcadosSemTel = 0, semContatoId = 0, erros = 0;
  let lookups = 0, atualizados = 0, marcadosSemTel = 0, semContatoId = 0, erros = 0, trocadosPraCelular = 0;
  const amostraErros = [];
  const _temTel = (a) => a && a.telefone && String(a.telefone).replace(/\D/g, '').length >= 8;
  const _temTel = (a) => a && a.telefone && _soDigitos(a.telefone).length >= 8;
  const _temCel = (a) => a && _pareceCelular(a.telefone);
  // Precisa processar? Sem modo repuxar: só os sem telefone. Com repuxar:
  // os sem telefone OU com telefone que não parece celular.
  const _precisa = (a) => repuxarNaoCelular ? !_temCel(a) : !_temTel(a);

  for (const id of ids) {
    const acc = col[id];
    if (!acc || _temTel(acc)) continue;
    if (acc.telefone_indisponivel && !forcar) continue;
    if (!acc || !_precisa(acc)) continue;
    // No modo repuxar não respeitamos telefone_indisponivel (queremos reconferir).
    if (acc.telefone_indisponivel && !forcar && !repuxarNaoCelular) continue;

    // Candidatos de contato: prohunters primeiro, depois as outras contas Bling.
    const porConta = (acc.bling_contato_id_por_conta && typeof acc.bling_contato_id_por_conta === 'object')
@@ -465,36 +506,45 @@ async function enriquecerTelefones({ maxLookups = 60, forcar = false } = {}) {
      if (tel) break;
    }
    if (tel) {
      acc.telefone = tel;
      acc.telefone_indisponivel = false;
      acc.telefone_origem = 'bling-contato';
      acc.atualizado_em = new Date().toISOString();
      acc.atualizado_por = 'bling-telefone-backfill';
      atualizados++;
      // No modo repuxar, só troca um número já existente se o novo parecer
      // celular (não rebaixa). Se a conta não tinha nada, sempre grava.
      if (repuxarNaoCelular && _temTel(acc) && !_pareceCelular(tel)) {
        // novo também é fixo e já havia um número — mantém o antigo
      } else {
        const tinhaFixo = _temTel(acc) && !_pareceCelular(acc.telefone);
        acc.telefone = tel;
        acc.telefone_indisponivel = false;
        acc.telefone_origem = 'bling-contato';
        acc.atualizado_em = new Date().toISOString();
        acc.atualizado_por = repuxarNaoCelular ? 'bling-telefone-recelular' : 'bling-telefone-backfill';
        atualizados++;
        if (tinhaFixo && _pareceCelular(tel)) trocadosPraCelular++;
      }
    } else {
      // Buscou e o Bling tambem nao tem — marca pra nao reprocessar sempre.
      acc.telefone_indisponivel = true;
      // Buscou e o Bling tambem nao tem numero.
      acc.telefone_lookup_em = new Date().toISOString();
      marcadosSemTel++;
      // So marca "indisponivel" se a conta realmente nao tem numero algum.
      // No modo repuxar, uma conta com fixo continua tendo fixo — nao flaga.
      if (!_temTel(acc)) { acc.telefone_indisponivel = true; marcadosSemTel++; }
    }
  }

  if (atualizados > 0 || marcadosSemTel > 0) {
    await crmStore.saveCollection('accounts', col,
      'Backfill telefones Bling: +' + atualizados + ' tel, ' + marcadosSemTel + ' sem numero');
      'Backfill telefones Bling: +' + atualizados + ' tel, ' + trocadosPraCelular + ' trocados p/ celular, ' + marcadosSemTel + ' sem numero');
  }

  // Quantos ainda faltam processar (sem telefone, com contato id, nao marcados)
  // Quantos ainda faltam processar (precisam, com contato id, nao marcados)
  let faltam = 0;
  for (const id of ids) {
    const acc = col[id];
    if (!acc || _temTel(acc)) continue;
    if (acc.telefone_indisponivel && !forcar) continue;
    if (!acc || !_precisa(acc)) continue;
    if (acc.telefone_indisponivel && !forcar && !repuxarNaoCelular) continue;
    const porConta = acc.bling_contato_id_por_conta || {};
    if (acc.bling_contato_id || Object.keys(porConta).length) faltam++;
  }

  return { ok: true, total_accounts: ids.length, lookups, atualizados, marcados_sem_telefone: marcadosSemTel, sem_contato_id: semContatoId, erros, amostra_erros: amostraErros, faltam };
  return { ok: true, modo: repuxarNaoCelular ? 'repuxar-celular' : 'backfill', total_accounts: ids.length, lookups, atualizados, trocados_pra_celular: trocadosPraCelular, marcados_sem_telefone: marcadosSemTel, sem_contato_id: semContatoId, erros, amostra_erros: amostraErros, faltam };
}

module.exports = { CANAIS_ECOMMERCE,
@@ -505,4 +555,5 @@ module.exports = { CANAIS_ECOMMERCE,
  mapearVendedor,
  processarPedido,
  buscarTelefoneContato, enriquecerTelefones,
  escolherTelefone, _pareceCelular,
};
