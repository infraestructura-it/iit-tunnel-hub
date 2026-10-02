'use strict';
// Simulador mínimo de la Bot API de Telegram para pruebas.
//   POST /bot<token>/<método>   getUpdates (cola), sendMessage y demás (se registran)
//   POST /__push                agrega una actualización a la cola (cuerpo: objeto update sin update_id)
//   GET  /__sent                devuelve las llamadas registradas (sendMessage, editMessageReplyMarkup…)
// Uso: node mock-telegram.js <puerto>

const http = require('node:http');

const [port] = process.argv.slice(2);
const queue = [];
const sent = [];
let nextId = 1;

http.createServer((r, res) => {
  let body = '';
  r.on('data', (c) => { body += c; });
  r.on('end', async () => {
    const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (r.url === '/__push') { queue.push({ update_id: nextId++, ...JSON.parse(body) }); return json({ ok: true }); }
    if (r.url === '/__sent') return json(sent);
    const m = /^\/bot([^/]+)\/(\w+)$/.exec(r.url);
    if (!m) { res.writeHead(404); return res.end(); }
    const req = body ? JSON.parse(body) : {};
    if (m[2] === 'getUpdates') {
      for (let i = 0; i < 10 && !queue.some((u) => u.update_id >= (req.offset || 0)); i++) await new Promise((x) => setTimeout(x, 100));
      return json({ ok: true, result: queue.filter((u) => u.update_id >= (req.offset || 0)) });
    }
    sent.push({ method: m[2], ...req });
    return json({ ok: true, result: { message_id: sent.length } });
  });
}).listen(Number(port), '127.0.0.1');
