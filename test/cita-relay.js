'use strict';
// Prueba del relay de la sala de citas: conecta dos participantes (dos tickets) y verifica que
// el hub relaya la señalización (mensaje 'listo') y un mensaje de chat de A hacia B.
//   node cita-relay.js <wsUrlA> <wsUrlB>
const [urlA, urlB] = process.argv.slice(2);
const done = (ok, msg) => { console.log(`${ok ? 'OK' : 'ERROR'} ${msg}`); process.exit(ok ? 0 : 1); };
setTimeout(() => done(false, 'tiempo agotado'), 15000);

let a, b;
try { a = new WebSocket(urlA); } catch (e) { done(false, e.message); }
a.onerror = () => done(false, 'A rechazado');

a.onopen = () => {
  // A ya está en la sala; ahora entra B (su llegada dispara 'listo' a ambos)
  try { b = new WebSocket(urlB); } catch (e) { done(false, e.message); }
  b.onerror = () => done(false, 'B rechazado');
  b.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === 'chat' && m.text === 'hola-desde-A' && m.from && m.from.role) done(true, 'relay de presencia y chat ok');
  };
};

a.onmessage = (ev) => {
  let m; try { m = JSON.parse(ev.data); } catch { return; }
  if (m.type === 'listo') a.send(JSON.stringify({ type: 'chat', text: 'hola-desde-A' }));
};
