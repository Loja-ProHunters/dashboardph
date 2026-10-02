// lib/githubStore.js
// Camada de persistência sobre o GitHub Contents API.
//
// ARQUITETURA DE BRANCHES (FIX DO RATE LIMIT VERCEL):
//   - config.githubBranch (default 'main'): branch de CÓDIGO. Luis commita aqui
//     via GitHub Web. A Vercel acompanha ESTA branch e deploya a cada push.
//   - config.dataBranch (default 'data'): branch de DADOS. O backend commita
//     todos os JSONs aqui (garantias.json, solicitacoes.json, comercial-data.json,
//     crm/*.json, tokens, logs). A Vercel NÃO acompanha essa branch, então
//     commits automáticos NÃO geram deployment attempts no rate limit.
//
// LEITURA: tenta primeiro a 'data' branch; se arquivo não existe lá, cai pra
// 'main' (compatibilidade com arquivos legados que ainda estão só em main).
// WRITE: sempre escreve em 'data'.
//
// Antes dessa mudança, cada save (ex: nova garantia, update de solicitacao)
// disparava um push em 'main' → Vercel criava um deployment attempt → mesmo
// skipado pelo Ignored Build Step, contava no rate limit (100/dia Hobby).
// Com 2 vendedores ativos no CRM + sync Tally, isso estourava rápido.

const https = require('https');
const config = require('../config');

function _branches() {
  const data = config.dataBranch || 'data';
  const code = config.githubBranch || 'main';
  return { data, code };
}

function githubRequest(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    if (!config.githubToken || !config.githubRepo) {
      reject(new Error('GITHUB_TOKEN ou GITHUB_REPO não configurados nas variáveis de ambiente da Vercel.'));
      return;
    }
    const payload = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: 'api.github.com',
      path: apiPath,
      method,
      headers: {
        'User-Agent': 'prohunters-portal',
        'Accept': 'application/vnd.github+json',
        'Authorization': 'Bearer ' + config.githubToken,
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };
    const r = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(d); } catch (e) {}
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(parsed);
        else {
          const err = new Error('GitHub API ' + res.statusCode + ': ' + (parsed && parsed.message ? parsed.message : d));
          err.statusCode = res.statusCode;
          reject(err);
        }
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

// Garante que a branch 'data' existe no repo. Se não existe, cria a partir
// de 'main'. Chamado antes do primeiro write em 'data'. Memoiza em memória
// pra não bater na API toda vez.
let _dataBranchChecked = false;
async function _ensureDataBranch() {
  if (_dataBranchChecked) return;
  const { data, code } = _branches();
  try {
    await githubRequest('GET', '/repos/' + config.githubRepo + '/branches/' + encodeURIComponent(data));
    _dataBranchChecked = true;
  } catch (e) {
    if (e.statusCode === 404) {
      // Branch 'data' não existe — cria a partir da 'main'
      const main = await githubRequest('GET', '/repos/' + config.githubRepo + '/branches/' + encodeURIComponent(code));
      const sha = main && main.commit && main.commit.sha;
      if (!sha) throw new Error('Não consegui obter o SHA da branch ' + code);
      await githubRequest('POST', '/repos/' + config.githubRepo + '/git/refs', {
        ref: 'refs/heads/' + data,
        sha,
      });
      console.log('[githubStore] Branch de dados criada: ' + data + ' (partindo de ' + code + '@' + sha.slice(0,7) + ')');
      _dataBranchChecked = true;
    } else {
      throw e;
    }
  }
}

async function _getFromBranch(filePath, branch) {
  const apiPath = '/repos/' + config.githubRepo + '/contents/' + filePath + '?ref=' + encodeURIComponent(branch);
  const data = await githubRequest('GET', apiPath);
  // Contents API pode devolver content vazio quando arquivo > 1MB.
  // Nesse caso, o SHA vem preenchido — usamos ele pra buscar via Blobs API (suporta 100MB).
  if ((!data.content || data.content === '') && data.sha) {
    const blobPath = '/repos/' + config.githubRepo + '/git/blobs/' + data.sha;
    const blob = await githubRequest('GET', blobPath);
    if (!blob || !blob.content) {
      throw new Error('Blob API retornou vazio pra ' + filePath + ' (SHA ' + data.sha + ')');
    }
    const clean = String(blob.content).replace(/\s/g, '');
    return Buffer.from(clean, 'base64').toString('utf-8');
  }
  if (!data.content) {
    throw new Error('Contents API retornou content vazio e sem SHA pra ' + filePath);
  }
  return Buffer.from(data.content, 'base64').toString('utf-8');
}

async function _getBinaryFromBranch(filePath, branch) {
  const apiPath = '/repos/' + config.githubRepo + '/contents/' + filePath + '?ref=' + encodeURIComponent(branch);
  const data = await githubRequest('GET', apiPath);
  if ((!data.content || data.content === '') && data.sha) {
    const blob = await githubRequest('GET', '/repos/' + config.githubRepo + '/git/blobs/' + data.sha);
    if (!blob || !blob.content) throw new Error('Blob API vazia pra ' + filePath);
    return Buffer.from(String(blob.content).replace(/\s/g, ''), 'base64');
  }
  if (!data.content) throw new Error('Contents API vazia pra ' + filePath);
  return Buffer.from(data.content, 'base64');
}

// LEITURA: tenta 'data' primeiro, fallback a 'main' (compatibilidade).
async function getFile(filePath) {
  const { data, code } = _branches();
  try {
    return await _getFromBranch(filePath, data);
  } catch (e) {
    if (e.statusCode === 404 && data !== code) {
      // Arquivo pode estar só em main (legado antes do fix) — tenta lá
      return await _getFromBranch(filePath, code);
    }
    throw e;
  }
}

async function getFileBinary(filePath) {
  const { data, code } = _branches();
  try {
    return await _getBinaryFromBranch(filePath, data);
  } catch (e) {
    if (e.statusCode === 404 && data !== code) {
      return await _getBinaryFromBranch(filePath, code);
    }
    throw e;
  }
}

// WRITE: sempre na branch 'data'. Não dispara webhook pra Vercel (que acompanha
// só 'main'), portanto NÃO consome do rate limit de deployments.
async function saveFile(filePath, text, message) {
  await _ensureDataBranch();
  const { data } = _branches();
  const apiPath = '/repos/' + config.githubRepo + '/contents/' + filePath;
  // Precisa pegar o SHA do arquivo NA BRANCH 'data' pra atualizar
  let sha = null;
  try {
    const current = await githubRequest('GET', apiPath + '?ref=' + encodeURIComponent(data));
    sha = current.sha;
  } catch (e) {
    // arquivo novo na branch 'data' — segue sem sha
  }
  await githubRequest('PUT', apiPath, {
    message: message || ('Atualiza ' + filePath + ' via painel'),
    content: Buffer.from(text, 'utf-8').toString('base64'),
    branch: data,
    ...(sha ? { sha } : {}),
  });
}

async function saveFileBinary(filePath, buffer, message) {
  await _ensureDataBranch();
  const { data } = _branches();
  const apiPath = '/repos/' + config.githubRepo + '/contents/' + filePath;
  let sha = null;
  try {
    const current = await githubRequest('GET', apiPath + '?ref=' + encodeURIComponent(data));
    sha = current.sha;
  } catch (e) { /* novo */ }
  await githubRequest('PUT', apiPath, {
    message: message || ('Salva ' + filePath),
    content: buffer.toString('base64'),
    branch: data,
    ...(sha ? { sha } : {}),
  });
}

module.exports = { githubRequest, getFile, saveFile, getFileBinary, saveFileBinary };
