// Обёртка: запускает наш обработчик как обычный веб-сервер (для Cloud Run из репозитория)
const http = require('http');
const { bot } = require('./index.js');
const PORT = process.env.PORT || 8080;

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const headers = req.headers;
  let raw = '';
  req.on('data', c => { raw += c; });
  req.on('end', async () => {
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch (e) { body = {}; }
    const rq = { method: req.method, path: url.pathname, body, get: (h) => headers[String(h).toLowerCase()] };
    const rs = {
      _status: 200, _headers: {},
      set(k, v) { this._headers[k] = v; return this; },
      status(c) { this._status = c; return this; },
      send(t) { res.writeHead(this._status, Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, this._headers)); res.end(t == null ? '' : String(t)); },
      json(o) { res.writeHead(this._status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, this._headers)); res.end(JSON.stringify(o)); },
    };
    try { await bot(rq, rs); } catch (e) { console.error(e); if (!res.headersSent) { res.writeHead(500); res.end('error'); } }
  });
}).listen(PORT, () => console.log('hedera-bot listening on', PORT));
