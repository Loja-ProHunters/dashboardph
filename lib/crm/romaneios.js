// lib/crm/romaneios.js
// Romaneio de transporte — documento que registra o motorista pegando um lote
// de envios pra levar. Uma vez gerado, os envios listados nele saem da Fila
// (viram status = 'enviado') e passam a aparecer na sub-aba "Enviados".
//
// Fluxo:
//   1) Auxiliar clica "Gerar romaneio" na Fila, escolhendo uma transportadora.
//   2) O sistema lista todos os envios prontos_coleta daquela transportadora.
//   3) Auxiliar seleciona os envios que serão coletados HOJE.
//   4) Sistema cria doc `romaneios/rom_YYYYMMDD_NNN` com número sequencial,
//      e marca os envios com romaneio_id + status='enviado' + coletado_em=now.
//   5) UI abre a página do romaneio em HTML print-ready pra imprimir e o
//      motorista assinar.
//
// Estrutura do doc:
//   {
//     id: 'rom_20260924_0001',
//     numero: '0001',
//     data: '2026-09-24',
//     transportadora: 'ezequiel',   // ou 'lt', 'rpa', 'aereo'
//     empresa_agrupada: 'ambas',    // 'prohunters' | 'calibre' | 'ambas'
//     envio_ids: [ 'env_prohunters_4132', ... ],
//     total_volumes: 4,
//     motorista_nome: null,          // preenchido depois da assinatura
//     motorista_cpf: null,
//     motorista_placa: null,
//     motorista_assinado_em: null,
//     gerado_por: 'ana',
//     criado_em: ISO,
//   }

const { getFile } = require('../githubStore');
const crmStore = require('./store');

// Gera o próximo número sequencial anual (0001, 0002, ...).
// Simples: conta quantos romaneios foram criados desde o começo do ano e soma 1.
async function _proximoNumero() {
  const ano = new Date().getFullYear();
  const all = await crmStore.getCollection('romaneios');
  const doAno = Object.values(all).filter(r => {
    const d = String(r.data || '');
    return d.startsWith(String(ano));
  });
  const n = doAno.length + 1;
  return String(n).padStart(4, '0');
}

function _dataHoje() {
  const d = new Date();
  const iso = d.toISOString().slice(0, 10);
  return iso;
}

// Cria um romaneio a partir de uma lista de envios.
// - envios: array de docs de envio (já carregados)
// - transportadora: string ('ezequiel' | 'lt' | 'rpa' | 'aereo')
// - gerado_por: login
async function criar({ envios, transportadora, gerado_por }) {
  if (!Array.isArray(envios) || envios.length === 0) {
    throw new Error('Nenhum envio pra colocar no romaneio');
  }
  if (!transportadora) throw new Error('Transportadora obrigatória');

  // Todos os envios devem ser da mesma transportadora e não estar em outro romaneio
  for (const e of envios) {
    if (e.transportadora !== transportadora) {
      throw new Error('Envio #' + e.numero + ' tem transportadora ' + e.transportadora + ' (esperado ' + transportadora + ')');
    }
    if (e.romaneio_id) {
      throw new Error('Envio #' + e.numero + ' já está no romaneio ' + e.romaneio_numero);
    }
  }

  const numero = await _proximoNumero();
  const data = _dataHoje();
  const id = 'rom_' + data.replace(/-/g, '') + '_' + numero;
  const empresas = new Set(envios.map(e => e.empresa));
  const totalVolumes = envios.reduce((s, e) => s + (Number(e.volumes_qtd) || 0), 0);

  const doc = {
    id,
    numero,
    data,
    transportadora,
    empresa_agrupada: empresas.size === 1 ? [...empresas][0] : 'ambas',
    envio_ids: envios.map(e => e.id),
    total_volumes: totalVolumes,
    motorista_nome: null,
    motorista_cpf: null,
    motorista_placa: null,
    motorista_assinado_em: null,
    gerado_por: gerado_por || null,
    criado_em: new Date().toISOString(),
  };
  return doc;
}

// Registra a assinatura do motorista (executado APÓS impressão)
function registrarAssinatura(rom, dadosMotorista) {
  const now = new Date().toISOString();
  return {
    ...rom,
    motorista_nome: (dadosMotorista.nome || '').trim() || rom.motorista_nome || null,
    motorista_cpf: (dadosMotorista.cpf || '').replace(/\D/g, '') || rom.motorista_cpf || null,
    motorista_placa: (dadosMotorista.placa || '').toUpperCase().trim() || rom.motorista_placa || null,
    motorista_assinado_em: now,
  };
}

// Renderiza HTML print-ready do romaneio
function renderHtml(rom, envios) {
  const empresas = { prohunters: 'Pro Hunters', calibre: 'Calibre Restrito', ambas: 'Pro Hunters + Calibre Restrito' };
  const transportadoras = { ezequiel: 'Ezequiel', lt: 'LT', rpa: 'RPA', aereo: 'Ezequiel + Gollog (aéreo)' };
  const empLbl = empresas[rom.empresa_agrupada] || rom.empresa_agrupada;
  const transLbl = transportadoras[rom.transportadora] || rom.transportadora;
  const dataFmt = rom.data.split('-').reverse().join('/');

  const linhas = envios.map((e, i) => {
    const volumes = e.volumes_qtd || 0;
    const cidUf = (e.cliente_cidade || '—') + '/' + (e.cliente_uf || '');
    const nome = (e.cliente_nome || '—').substring(0, 60);
    return `
      <tr>
        <td class="c">${i + 1}</td>
        <td>${_esc(e.nf_numero || '—')}</td>
        <td>${_esc(e.numero || '')}</td>
        <td>${_esc(nome)}</td>
        <td>${_esc(cidUf)}</td>
        <td>${_esc(e.gt_numero || '—')}</td>
        <td class="c">${volumes}</td>
        <td>${_esc({prohunters:'PH', calibre:'CR'}[e.empresa] || e.empresa)}</td>
      </tr>`;
  }).join('');

  // Assinaturas — se já assinado, exibe; senão, deixa linhas em branco
  const assinaturaBloco = rom.motorista_assinado_em
    ? `<div class="ass"><div>Motorista: <b>${_esc(rom.motorista_nome || '_______________________')}</b></div>
       <div>CPF: <b>${_esc(_fmtCpf(rom.motorista_cpf))}</b> · Placa: <b>${_esc(rom.motorista_placa || '_________')}</b></div>
       <div>Assinado em ${_fmtDateTime(rom.motorista_assinado_em)}</div></div>`
    : `<div class="ass">
         <div class="ass-line">Nome do Motorista: __________________________________________________________</div>
         <div class="ass-line">CPF: ___________________________ · Placa do Veículo: _____________</div>
         <div class="ass-line" style="margin-top:22px">Assinatura: ________________________________________________ · Data: ____/____/______</div>
       </div>`;

  return `<!doctype html>
<html><head><meta charset="utf-8">
<title>Romaneio ${rom.numero}/${rom.data.slice(0,4)} — ${transLbl}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: 'Arial', 'Helvetica', sans-serif; font-size: 12px; color: #111; padding: 20px 26px; margin: 0; }
  .hd { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 14px; border-bottom: 2px solid #0a6e2e; padding-bottom: 10px; }
  .hd .l { max-width: 65%; }
  .hd .r { text-align: right; }
  h1 { margin: 0 0 4px; font-size: 18px; color: #0a6e2e; font-weight: 700; }
  .sub { font-size: 12px; color: #444; }
  .meta { font-size: 11.5px; color: #555; margin-top: 4px; }
  .meta b { color: #111; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th { background: #0a6e2e; color: #fff; padding: 7px 6px; text-align: left; font-size: 11px; font-weight: 700; border: 1px solid #0a6e2e; }
  td { padding: 6px 6px; border: 1px solid #d0d0d0; font-size: 11.5px; vertical-align: top; }
  .c { text-align: center; }
  tr:nth-child(even) td { background: #fafafa; }
  .total-row td { background: #e7f5ec; font-weight: 700; border-top: 2px solid #0a6e2e; }
  .ass { margin-top: 30px; padding: 14px 18px; border: 1px solid #999; border-radius: 6px; background: #f9f9f9; font-size: 12.5px; line-height: 1.9; }
  .ass-line { line-height: 2.4; letter-spacing: .3px; }
  .foot { margin-top: 22px; padding-top: 10px; border-top: 1px dashed #999; font-size: 10px; color: #777; display: flex; justify-content: space-between; }
  @media print {
    body { padding: 12mm; }
    .no-print { display: none !important; }
  }
  .no-print { position: fixed; top: 10px; right: 10px; }
  .btn-print { background: #0a6e2e; color: #fff; border: 0; border-radius: 6px; padding: 10px 16px; cursor: pointer; font-size: 13px; font-weight: 700; box-shadow: 0 4px 10px rgba(0,0,0,.15); }
</style></head><body>
  <div class="no-print"><button class="btn-print" onclick="window.print()">🖨️ Imprimir / Salvar PDF</button></div>
  <div class="hd">
    <div class="l">
      <h1>Romaneio de Transporte</h1>
      <div class="sub">${_esc(empLbl)}</div>
      <div class="meta">
        Transportadora: <b>${_esc(transLbl)}</b>
      </div>
    </div>
    <div class="r">
      <div style="font-size:20px;font-weight:700;color:#0a6e2e">Nº ${_esc(rom.numero)}</div>
      <div class="meta">Emitido em <b>${dataFmt}</b></div>
      <div class="meta">Gerado por: ${_esc(rom.gerado_por || '—')}</div>
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th style="width:32px">#</th>
        <th style="width:80px">Nota Fiscal</th>
        <th style="width:70px">Pedido</th>
        <th>Destinatário</th>
        <th style="width:150px">Cidade / UF</th>
        <th style="width:90px">Guia Trânsito</th>
        <th style="width:60px">Volumes</th>
        <th style="width:44px">Empr.</th>
      </tr>
    </thead>
    <tbody>
      ${linhas}
      <tr class="total-row">
        <td class="c" colspan="6" style="text-align:right">TOTAL DE VOLUMES</td>
        <td class="c">${rom.total_volumes}</td>
        <td></td>
      </tr>
    </tbody>
  </table>

  ${assinaturaBloco}

  <div class="foot">
    <div>Sistema Pro Hunters CRM · Documento gerado eletronicamente</div>
    <div>Romaneio ${_esc(rom.id)}</div>
  </div>
</body></html>`;
}

function _esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function _fmtCpf(cpf) {
  if (!cpf) return '________________';
  const c = String(cpf).replace(/\D/g, '');
  if (c.length !== 11) return c;
  return c.slice(0,3) + '.' + c.slice(3,6) + '.' + c.slice(6,9) + '-' + c.slice(9);
}
function _fmtDateTime(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleString('pt-BR', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
  } catch (e) { return iso; }
}

module.exports = {
  criar,
  registrarAssinatura,
  renderHtml,
};
