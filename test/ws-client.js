'use strict';
// Cliente de prueba de las sesiones remotas: node ws-client.js <url> <vnc|ssh> [usuario] [origin]
// Imprime "OK ..." si la sesión hace lo esperado, o "ERROR ..." y sale con código 1.
const [url, mode, user = 'root', origin] = process.argv.slice(2);
const done = (ok, msg) => { console.log(`${ok ? 'OK' : 'ERROR'} ${msg}`); process.exit(ok ? 0 : 1); };
setTimeout(() => done(false, 'tiempo agotado'), 20000);

let ws;
try { ws = new WebSocket(url, { headers: origin ? { origin } : {} }); } catch (e) { done(false, e.message); }
ws.binaryType = 'arraybuffer';
let stage = 'start';
let out = '';
const marker = `hola-ssh-${process.pid}`;
ws.onerror = () => { if (stage === 'start') done(false, 'rechazado'); };
ws.onclose = (e) => { if (stage !== 'end') done(false, `cerrado: ${e.code} ${e.reason}`); };
ws.onmessage = (ev) => {
  if (typeof ev.data === 'string') {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'error') return done(false, msg.message);
    if (mode === 'vnc' && msg.type === 'ready') { stage = 'ready'; return; }
    if (mode === 'ssh' && msg.type === 'auth') {
      stage = 'auth';
      return ws.send(JSON.stringify({ type: 'auth', username: user, useHubKey: true, cols: 100, rows: 30 }));
    }
    if (mode === 'ssh' && msg.type === 'ready') {
      stage = 'ready';
      ws.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
      return ws.send(new TextEncoder().encode(`echo ${marker} $(stty size)\n`));
    }
    return;
  }
  const text = Buffer.from(ev.data).toString('utf8');
  if (mode === 'vnc') {
    if (stage === 'ready' && text.startsWith('RFB 003.008')) { stage = 'echo'; return ws.send(new TextEncoder().encode('hola-vnc')); }
    if (stage === 'echo' && text.includes('hola-vnc')) { stage = 'end'; ws.close(); return done(true, 'saludo RFB y eco por el túnel'); }
  }
  if (mode === 'ssh') {
    out += text;
    const m = out.match(new RegExp(`${marker} (\\d+) (\\d+)`));
    if (m) { stage = 'end'; ws.close(); return done(true, `terminal ${m[2]}x${m[1]}`); }
  }
};
