'use strict';
// Simulador mínimo de la API de Claude (/v1/messages) para pruebas, guiado por el texto del usuario:
//   "@tool <nombre> <json>"   → responde con ese tool_use (una línea por herramienta)
//   tool_result                → responde end_turn "RESULTADO: …" con el contenido recibido
//   "[Sistema] …"              → responde end_turn "ENTENDIDO: …"
//   "perdió la conexión"       → pide la herramienta eventos de esa máquina (diagnóstico de alertas)
// Valida la forma de cada petición como lo haría la API real y responde 400 si es inválida.
// Uso: node mock-claude.js <puerto> <archivo-log>

const http = require('node:http');
const fs = require('node:fs');

const [port, logFile] = process.argv.slice(2);
let n = 0;

function validate(req) {
  if (!req.model || !req.max_tokens) return 'faltan model o max_tokens';
  if (!Array.isArray(req.messages) || req.messages.length === 0) return 'messages vacío';
  for (const t of req.tools || []) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(t.name) || !t.description || t.input_schema?.type !== 'object') return `herramienta inválida ${t.name}`;
  }
  if (req.messages[0].role !== 'user') return 'el primer mensaje debe ser del usuario';
  for (let i = 0; i < req.messages.length; i++) {
    const m = req.messages[i];
    if (i > 0 && m.role === req.messages[i - 1].role) return `roles consecutivos iguales en ${i}`;
    if (Array.isArray(m.content)) {
      for (const b of m.content.filter((x) => x.type === 'tool_result')) {
        const prev = req.messages[i - 1];
        const ok = prev?.role === 'assistant' && prev.content.some((x) => x.type === 'tool_use' && x.id === b.tool_use_id);
        if (!ok) return `tool_result huérfano ${b.tool_use_id}`;
      }
    }
  }
  return null;
}

const reply = (content, stop) => ({
  id: `msg_${++n}`, type: 'message', role: 'assistant', model: 'mock', content, stop_reason: stop,
  usage: { input_tokens: 100, output_tokens: 20 },
});

http.createServer((r, res) => {
  let body = '';
  r.on('data', (c) => { body += c; });
  r.on('end', () => {
    fs.appendFileSync(logFile, body + '\n');
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (!r.headers['x-api-key']) return send(401, { type: 'error', error: { type: 'authentication_error', message: 'x-api-key header is required' } });
    let req;
    try { req = JSON.parse(body); } catch { return send(400, { type: 'error', error: { message: 'json inválido' } }); }
    const err = validate(req);
    if (err) return send(400, { type: 'error', error: { type: 'invalid_request_error', message: err } });

    const last = req.messages[req.messages.length - 1];
    const blocks = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content;
    const results = blocks.filter((b) => b.type === 'tool_result');
    if (results.length) {
      const text = results.map((b) => `${b.is_error ? 'ERROR' : 'OK'} ${String(b.content).slice(0, 600)}`).join('\n---\n');
      return send(200, reply([{ type: 'text', text: `RESULTADO: ${text}` }], 'end_turn'));
    }
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    const calls = [...text.matchAll(/^@tool (\w+) (.*)$/gm)];
    if (calls.length) {
      return send(200, reply(calls.map((c, i) => ({ type: 'tool_use', id: `toolu_${n}_${i}`, name: c[1], input: JSON.parse(c[2]) })), 'tool_use'));
    }
    if (text.startsWith('[Sistema]')) return send(200, reply([{ type: 'text', text: `ENTENDIDO: ${text.split('\n')[0]}` }], 'end_turn'));
    const lost = /La máquina (\S+) .*perdió la conexión/.exec(text);
    if (lost) return send(200, reply([{ type: 'tool_use', id: `toolu_${n}_a`, name: 'eventos', input: { maquina_id: lost[1], limite: 10 } }], 'tool_use'));
    return send(200, reply([{ type: 'text', text: `HOLA: ${text.slice(0, 200)}` }], 'end_turn'));
  });
}).listen(Number(port), '127.0.0.1');
