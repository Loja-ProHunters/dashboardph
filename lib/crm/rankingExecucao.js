// lib/crm/rankingExecucao.js
// CORRIDA DE EXECUÇÃO — ranking mensal dos vendedores por tarefas EXECUTADAS
// (com contato/resultado registrado) e % de conversão. Alimenta a aba "Corrida"
// do CRM, aberta pra todos os vendedores (gamificação).
//
// Regras (decididas com o Luis, nov/2026):
//   • Só conta tarefa COMERCIAL (contrato de arma tem seção própria).
//   • Só conta como "executada" se tiver CONTATO/RESULTADO registrado
//     (resultado convertida / nao_convertida / follow_up_agendado, ou canal de
//     contato preenchido) — marcar "concluída" sem registro NÃO conta.
//   • Janela = mês civil corrente (horário de Brasília), pela data de conclusão.
//   • Crédito pro DONO da tarefa (owner_id) — é a execução da carteira dele.
//   • Conversão = convertidas / (convertidas + não convertidas). Follow-up não
//     entra no denominador (ainda não é desfecho final).
//   • Score da corrida = executadas + convertidas × BONUS_CONVERSAO
//     (volume premiado, conversão premiada em dobro). Pesos ajustáveis abaixo.

const BONUS_CONVERSAO = 2;
const RESULTADOS_VALIDOS = ['convertida', 'nao_convertida', 'follow_up_agendado'];

function _norm(v) { return String(v || '').toLowerCase().trim(); }

// Mês civil (AAAA-MM) em horário de Brasília (UTC-3), a partir de um ISO UTC.
function _mesBRT(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso).slice(0, 7);
  const brt = new Date(d.getTime() - 3 * 3600 * 1000);
  return brt.toISOString().slice(0, 7);
}

function _ehContrato(a) {
  return !!a && (String(a.tipo || '').indexOf('contrato') === 0 || a.fonte === 'contrato_arma');
}

function _temContatoOuResultado(a) {
  if (RESULTADOS_VALIDOS.indexOf(a.resultado) !== -1) return true;
  if (a.canal_contato) return true;
  if (a.primeiro_contato_em) return true;
  if (Array.isArray(a.contatos) && a.contatos.length) return true;
  return false;
}

// Função PURA (testável): recebe as activities + a lista de vendedores
// ({ login, nome }) + "agora", devolve o ranking do mês.
function montar(activities, vendedores, agora) {
  agora = agora || new Date();
  const mes = _mesBRT(agora.toISOString());

  const porVend = {};
  for (const v of vendedores) {
    const login = _norm(v.login);
    porVend[login] = {
      login, nome: v.nome || login, primeiro_nome: String(v.nome || login).split(' ')[0],
      executadas: 0, convertidas: 0, nao_convertidas: 0, follow_ups: 0,
      sem_registro: 0, // concluídas sem contato/resultado — NÃO contam, só informativo
    };
  }

  for (const a of (activities || [])) {
    if (!a || _ehContrato(a)) continue;
    if (a.status !== 'concluida') continue;
    const fim = a.concluida_em || a.concluido_em || a.atualizado_em;
    if (!fim || _mesBRT(fim) !== mes) continue;
    const dono = _norm(a.owner_id || a.dono);
    const r = porVend[dono];
    if (!r) continue; // só vendedores da corrida
    if (!_temContatoOuResultado(a)) { r.sem_registro++; continue; }
    r.executadas++;
    if (a.resultado === 'convertida') r.convertidas++;
    else if (a.resultado === 'nao_convertida') r.nao_convertidas++;
    else if (a.resultado === 'follow_up_agendado') r.follow_ups++;
  }

  const lista = Object.values(porVend).map(r => {
    const baseConv = r.convertidas + r.nao_convertidas;
    r.conversao = baseConv ? Math.round((r.convertidas / baseConv) * 100) : null;
    r.score = r.executadas + r.convertidas * BONUS_CONVERSAO;
    return r;
  });
  // Ordena: score, depois executadas, depois conversão.
  lista.sort((a, b) =>
    (b.score - a.score) ||
    (b.executadas - a.executadas) ||
    ((b.conversao || 0) - (a.conversao || 0)) ||
    a.nome.localeCompare(b.nome));
  lista.forEach((r, i) => { r.posicao = i + 1; });

  const totalExec = lista.reduce((s, r) => s + r.executadas, 0);
  const totalConv = lista.reduce((s, r) => s + r.convertidas, 0);
  return {
    mes,
    gerado_em: agora.toISOString(),
    bonus_conversao: BONUS_CONVERSAO,
    equipe: { executadas: totalExec, convertidas: totalConv },
    ranking: lista,
  };
}

module.exports = { montar, _mesBRT, BONUS_CONVERSAO };
