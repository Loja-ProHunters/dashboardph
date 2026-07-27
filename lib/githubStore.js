const https = require('https');
const config = require('../config');

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
        else reject(new Error('GitHub API ' + res.statusCode + ': ' + (parsed && parsed.message ? parsed.message : d)));
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

async function getFile(filePath) {
  const apiPath = '/repos/' + config.githubRepo + '/contents/' + filePath + '?ref=' + config.githubBranch;
  const data = await githubRequest('GET', apiPath);
  return Buffer.from(data.content, 'base64').toString('utf-8');
}

async function saveFile(filePath, text, message) {
  const apiPath = '/repos/' + config.githubRepo + '/contents/' + filePath;
  let sha = null;
  try {
    const current = await githubRequest('GET', apiPath + '?ref=' + config.githubBranch);
    sha = current.sha;
  } catch (e) {
    // arquivo pode não existir ainda — segue sem sha (cria novo)
  }
  await githubRequest('PUT', apiPath, {
    message: message || ('Atualiza ' + filePath + ' via painel'),
    content: Buffer.from(text, 'utf-8').toString('base64'),
    branch: config.githubBranch,
    ...(sha ? { sha } : {}),
  });
}

module.exports = { githubRequest, getFile, saveFile };
