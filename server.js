// server.js — adaptador pra rodar o Portal como app Node PERSISTENTE
// (Hostinger Web App, ou qualquer host Node: Render, Railway, VPS...).
//
// Na Vercel, api/index.js é uma função serverless (um handler (req,res) que a
// plataforma chama a cada request). Aqui a gente "liga" exatamente o MESMO
// handler num servidor HTTP que escuta a porta que o host fornece. Nada do
// resto do sistema muda — roteamento, telas e APIs continuam em api/index.js.
//
// A porta vem do ambiente (o host decide qual é). Fallback 3000 pra rodar local.

const http = require('http');
const { URL } = require('url');
const handler = require('./api/index.js');

const port = process.env.PORT || 3000;

const server = http.createServer(function (req, res) {
  // A Vercel preenchia req.query automaticamente; no Node puro não existe.
  // Replicamos aqui pra qualquer rota que leia req.query funcionar igual ao
  // que funcionava na Vercel (ex.: fallback do callback OAuth do Bling).
  try {
    const sp = new URL(req.url || '/', 'http://x').searchParams;
    req.query = {};
    for (const [k, v] of sp) { req.query[k] = v; }
  } catch (e) { req.query = {}; }
  // O handler é async; captura qualquer erro não tratado pra não derrubar o processo.
  Promise.resolve()
    .then(function () { return handler(req, res); })
    .catch(function (e) {
      console.error('[portal] erro não tratado:', e && e.stack ? e.stack : e);
      if (!res.headersSent) {
        try { res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); } catch (_) {}
      }
      try { res.end('Erro interno do servidor.'); } catch (_) {}
    });
});

// Tempo de vida de conexões ociosas (evita conexões penduradas).
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

server.listen(port, function () {
  console.log('[prohunters-portal] no ar na porta ' + port);
});
