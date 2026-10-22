// Sesión remota en el navegador: pantalla (VNC, con noVNC), terminal (SSH, con xterm.js) o escritorio de Windows
// (RDP, con guacamole-common-js; el hub habla con guacd).
// La página recibe ?m=<máquina>&s=<servicio>, pide un ticket de un solo uso al hub y abre el WebSocket.
import RFB from './vendor/novnc/core/rfb.js';
import { initLogging } from './vendor/novnc/core/util/logging.js';
import Guacamole from './vendor/guacamole/guacamole-common.min.js';

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const machineId = params.get('m') || '';
const service = params.get('s') || '';
const TOKEN_KEY = 'iit-hub-admin-token';

let ws = null; let rfb = null; let term = null; let fit = null;
let finished = false;

// noVNC solo informa el motivo de un fallo por console.error: se guarda para mostrarlo en pantalla
let vncFailure = '';
const origError = console.error.bind(console);
console.error = (...args) => {
  const text = args.map(String).join(' ');
  if (/^(Failed (when|while)|RFB failure)/.test(text)) vncFailure = text.replace(/^[^:]*:\s*/, '');
  origError(...args);
};
initLogging('warn'); // noVNC enlaza console.error al importarse: se vuelve a enlazar con el interceptor

/** Traduce el motivo técnico de noVNC a una explicación útil (en especial, wayvnc de Raspberry Pi). */
function explainVncFailure(reason) {
  const m = /Unsupported security types \(types: ([^)]*)\)/.exec(reason);
  if (m) {
    const t = m[1].split(',').map((x) => x.trim()).filter(Boolean);
    const names = { 1: 'sin clave', 2: 'VNC', 5: 'RSA-AES', 6: 'RSA-AES sin cifrado', 13: 'RSA-AES-256', 16: 'Tight', 18: 'TLS', 19: 'VeNCrypt (TLS)', 30: 'Apple DH', 129: 'RSA-AES-256' };
    const offered = t.map((x) => `${x} (${names[x] || '?'})`).join(', ');
    if (!window.isSecureContext && t.some((x) => ['6', '30'].includes(x))) {
      return `El servidor VNC ofrece ${offered}, que en el navegador solo funcionan si el panel se abre por HTTPS (o en el propio hub, http://127.0.0.1).\n\n` +
        'Opciones: abrir el panel por HTTPS, o usar contraseña VNC clásica en el equipo ' +
        '(RealVNC Server: Authentication=VncAuth y Encryption=PreferOff; wayvnc: enable_auth=false con address=127.0.0.1).';
    }
    return `El servidor VNC ofrece métodos de autenticación que el navegador no soporta: ${offered}.\n\n` +
      'En una Raspberry Pi con wayvnc, agregue a /etc/wayvnc/config la línea\n  allow_broken_crypto=true\n' +
      '(habilita Apple DH: pide usuario y contraseña de la Raspberry) o use enable_auth=false con address=127.0.0.1, ' +
      'y reinicie con: sudo systemctl restart wayvnc';
  }
  if (/Connection closed|Unexpected server disconnect/.test(reason)) {
    return `El servidor VNC cerró la conexión durante la negociación (${reason}).\n\n` +
      'Si es wayvnc con enable_auth=true y sin TLS ni clave RSA, no ofrece ningún método: agregue allow_broken_crypto=true o use enable_auth=false.';
  }
  return reason;
}

function status(text, kind = 'wait') {
  $('#r-status-text').textContent = text;
  $('#r-status').dataset.state = kind;
}

function showMessage(title, text, { retry = true } = {}) {
  if (finished) return;
  finished = true;
  status(title, 'off');
  $('#r-msg-title').textContent = title;
  $('#r-msg-text').textContent = text || '';
  $('#r-msg-retry').classList.toggle('hidden', !retry);
  $('#r-msg').classList.remove('hidden');
  $('#r-auth').classList.add('hidden');
  document.title = `${title} · IIT Tunnel Hub`;
}

async function ticket(extra = {}) {
  let token = null;
  try { token = sessionStorage.getItem(TOKEN_KEY); } catch {}
  const res = await fetch(`/api/machines/${encodeURIComponent(machineId)}/remote`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'iit-panel', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify({ service, ...extra }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) throw new Error('Su sesión del panel terminó: ingrese de nuevo en el panel y vuelva a abrir la conexión.');
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

function openSocket(t) {
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${t.ws}?t=${encodeURIComponent(t.ticket)}`;
  const sock = new WebSocket(url, ['binary']);
  sock.binaryType = 'arraybuffer';
  return sock;
}

/** Credenciales: VNC (lo que pida el servidor) o SSH (usuario y contraseña, o la clave del hub). */
function askCredentials({ title, hint, user = true, pass = true, hubKey = false, rdp = false }) {
  return new Promise((resolve, reject) => {
    const f = $('#r-auth');
    $('#r-auth-title').textContent = title;
    $('#r-auth-hint').textContent = hint || '';
    $('#r-user-row').classList.toggle('hidden', !user);
    $('#r-pass-row').classList.toggle('hidden', !pass);
    $('#r-hubkey-row').classList.toggle('hidden', !hubKey);
    $('#r-domain-row').classList.toggle('hidden', !rdp);
    $('#r-layout-row').classList.toggle('hidden', !rdp);
    try {
      if (rdp && !$('#r-domain').value) $('#r-domain').value = localStorage.getItem(`iit-remote-domain:${machineId}/${service}`) || '';
      if (rdp) $('#r-layout').value = localStorage.getItem(`iit-remote-layout:${machineId}/${service}`) || 'es-latam-qwerty';
    } catch {}
    $('#r-hubkey').checked = false;
    $('#r-pass').disabled = false;
    try { if (user && !$('#r-user').value) $('#r-user').value = localStorage.getItem(`iit-remote-user:${machineId}/${service}`) || ''; } catch {}
    $('#r-pass').value = '';
    f.classList.remove('hidden');
    setTimeout(() => (user && !$('#r-user').value ? $('#r-user') : $('#r-pass')).focus(), 0);
    f.onsubmit = (e) => {
      e.preventDefault();
      const out = { username: $('#r-user').value.trim(), password: $('#r-pass').value, useHubKey: hubKey && $('#r-hubkey').checked };
      if (rdp) Object.assign(out, { domain: $('#r-domain').value.trim(), layout: $('#r-layout').value });
      try {
        if (out.username) localStorage.setItem(`iit-remote-user:${machineId}/${service}`, out.username);
        if (rdp) { localStorage.setItem(`iit-remote-domain:${machineId}/${service}`, out.domain); localStorage.setItem(`iit-remote-layout:${machineId}/${service}`, out.layout); }
      } catch {}
      f.classList.add('hidden');
      resolve(out);
    };
    $('#r-auth-cancel').onclick = () => { f.classList.add('hidden'); reject(new Error('cancelado')); };
  });
}
$('#r-hubkey').addEventListener('change', (e) => { $('#r-pass').disabled = e.target.checked; });

// ---------- VNC ----------

/** noVNC sobre un canal ya abierto: WebSocket del hub (túnel) o canal de datos WebRTC (directo). */
function attachRfb(channel, t, via) {
  status('Negociando con el servidor VNC…');
  rfb = new RFB($('#r-screen'), channel, { shared: true });
  rfb.scaleViewport = true;
  rfb.background = '#05070b';
  let wasConnected = false;
  rfb.addEventListener('connect', () => {
    wasConnected = true;
    status(via === 'directo' ? 'Conectado · directo (WebRTC)' : 'Conectado · por el túnel', 'on');
    for (const id of ['#r-cad', '#r-scale', '#r-clip']) $(id).disabled = false;
    rfb.focus();
  });
  rfb.addEventListener('disconnect', (e) => {
    if (e.detail.clean) return showMessage('Sesión terminada', 'El equipo cerró la sesión.');
    if (!wasConnected && vncFailure) return showMessage('El servidor VNC no aceptó la conexión', explainVncFailure(vncFailure));
    showMessage('Conexión perdida', (via === 'directo'
      ? 'Se cortó la conexión directa con el equipo (red o servidor VNC).'
      : 'Se perdió la conexión con el equipo (red, frpc o servidor VNC).') + (vncFailure ? `\n\nDetalle: ${vncFailure}` : ''));
  });
  rfb.addEventListener('credentialsrequired', async (e) => {
    const types = e.detail.types || ['password'];
    try {
      const c = await askCredentials({ title: 'Credenciales VNC', hint: types.includes('username') ? 'Usuario y contraseña del equipo (en Raspberry Pi: los de su cuenta, p. ej. pi).' : 'Contraseña del servidor VNC del equipo.', user: types.includes('username'), pass: types.includes('password') });
      rfb.sendCredentials({ username: c.username, password: c.password });
    } catch { rfb.disconnect(); }
  });
  rfb.addEventListener('serververification', (e) => {
    // El túnel (o el agente autenticado del equipo) ya identifica a la máquina; se acepta y se muestra la huella
    status('Verificando servidor…');
    try { console.info('Clave pública del servidor VNC', e.detail.publickey); } catch {}
    rfb.approveServer();
  });
  rfb.addEventListener('securityfailure', (e) => showMessage('Acceso denegado', e.detail.reason || 'El servidor VNC rechazó las credenciales.'));
  rfb.addEventListener('clipboard', (e) => { $('#r-clip-text').value = e.detail.text; });
  rfb.addEventListener('desktopname', (e) => { document.title = `${e.detail.name} · ${t.machine.name} · VNC`; });
}

// Por el túnel: el hub conecta con el visitante stcp y transporta los bytes RFB por su WebSocket
function startVnc(t) {
  document.body.classList.add('kind-vnc');
  const sock = openSocket(t);
  sock.onmessage = (ev) => {
    if (typeof ev.data !== 'string') return;
    let msg = {}; try { msg = JSON.parse(ev.data); } catch {}
    if (msg.type === 'error') return showMessage('No se pudo conectar', msg.message);
    if (msg.type !== 'ready') return;
    // Desde aquí el WebSocket transporta RFB: noVNC toma el control del canal ya abierto
    attachRfb(sock, t, 'tunel');
  };
  sock.onclose = (e) => { if (!rfb) showMessage('No se pudo conectar', e.reason || 'El hub cerró la conexión.'); };
  ws = sock;
}

/** Espera a reunir los candidatos ICE (señalización sin "trickle": una oferta completa). */
function iceGathered(pc, ms) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); resolve(); } });
  });
}

// Directo: el agente del equipo responde la oferta WebRTC y la pantalla viaja navegador ⇄ equipo.
// Si el canal no se abre a tiempo (firewall, NAT estricto sin TURN), se usa el túnel.
let pc = null;
function startVncRtc(t) {
  document.body.classList.add('kind-vnc');
  status('Conectando directo (WebRTC)…');
  const sock = openSocket(t);
  ws = sock;
  let settled = false;
  const fallback = async (why) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    console.info('WebRTC directo no disponible:', why);
    try { pc?.close(); } catch {}
    try { sock.close(); } catch {}
    status('Conectando por el túnel…');
    try { startVnc(await ticket({ transport: 'tunnel' })); }
    catch (err) { showMessage('No se pudo abrir la sesión', `La conexión directa falló (${why}) y por el túnel tampoco: ${err.message}`); }
  };
  const timer = setTimeout(() => fallback('el canal directo no se abrió a tiempo'), 10000);
  sock.onmessage = async (ev) => {
    if (typeof ev.data !== 'string') return;
    let msg = {}; try { msg = JSON.parse(ev.data); } catch {}
    try {
      if (msg.type === 'rtc') {
        pc = new RTCPeerConnection({ iceServers: msg.iceServers || [] });
        const dc = pc.createDataChannel('rfb', { ordered: true });
        dc.binaryType = 'arraybuffer';
        dc.onopen = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          sock.send(JSON.stringify({ type: 'conectado' }));
          attachRfb(dc, t, 'directo');
        };
        pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') fallback('la red no permitió la conexión directa'); };
        await pc.setLocalDescription(await pc.createOffer());
        await iceGathered(pc, 2500);
        sock.send(JSON.stringify({ type: 'offer', sdp: pc.localDescription.sdp }));
      } else if (msg.type === 'answer') {
        await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
      } else if (msg.type === 'error') {
        if (!settled) fallback(msg.message);
        else if (!rfb) showMessage('No se pudo conectar', msg.message);
      }
    } catch (err) { fallback(err.message); }
  };
  sock.onclose = () => { if (!settled) fallback('el hub cerró la señalización'); };
}

// ---------- Pantalla por el agente del equipo (captura propia, WebRTC directo) ----------

// KeyboardEvent.code → scancode de Windows (set 1) + bandera "extendida" (teclas grises: flechas, ctrl/alt der…)
const SCAN = {
  Escape: [0x01], Digit1: [0x02], Digit2: [0x03], Digit3: [0x04], Digit4: [0x05], Digit5: [0x06],
  Digit6: [0x07], Digit7: [0x08], Digit8: [0x09], Digit9: [0x0a], Digit0: [0x0b], Minus: [0x0c], Equal: [0x0d],
  Backspace: [0x0e], Tab: [0x0f], KeyQ: [0x10], KeyW: [0x11], KeyE: [0x12], KeyR: [0x13], KeyT: [0x14],
  KeyY: [0x15], KeyU: [0x16], KeyI: [0x17], KeyO: [0x18], KeyP: [0x19], BracketLeft: [0x1a], BracketRight: [0x1b],
  Enter: [0x1c], ControlLeft: [0x1d], KeyA: [0x1e], KeyS: [0x1f], KeyD: [0x20], KeyF: [0x21], KeyG: [0x22],
  KeyH: [0x23], KeyJ: [0x24], KeyK: [0x25], KeyL: [0x26], Semicolon: [0x27], Quote: [0x28], Backquote: [0x29],
  ShiftLeft: [0x2a], Backslash: [0x2b], KeyZ: [0x2c], KeyX: [0x2d], KeyC: [0x2e], KeyV: [0x2f], KeyB: [0x30],
  KeyN: [0x31], KeyM: [0x32], Comma: [0x33], Period: [0x34], Slash: [0x35], ShiftRight: [0x36],
  NumpadMultiply: [0x37], AltLeft: [0x38], Space: [0x39], CapsLock: [0x3a],
  F1: [0x3b], F2: [0x3c], F3: [0x3d], F4: [0x3e], F5: [0x3f], F6: [0x40], F7: [0x41], F8: [0x42], F9: [0x43],
  F10: [0x44], F11: [0x57], F12: [0x58], NumLock: [0x45], ScrollLock: [0x46],
  Numpad7: [0x47], Numpad8: [0x48], Numpad9: [0x49], NumpadSubtract: [0x4a], Numpad4: [0x4b], Numpad5: [0x4c],
  Numpad6: [0x4d], NumpadAdd: [0x4e], Numpad1: [0x4f], Numpad2: [0x50], Numpad3: [0x51], Numpad0: [0x52], NumpadDecimal: [0x53],
  IntlBackslash: [0x56],
  // Extendidas (0xE0)
  NumpadEnter: [0x1c, 1], ControlRight: [0x1d, 1], NumpadDivide: [0x35, 1], AltRight: [0x38, 1],
  Home: [0x47, 1], ArrowUp: [0x48, 1], PageUp: [0x49, 1], ArrowLeft: [0x4b, 1], ArrowRight: [0x4d, 1],
  End: [0x4f, 1], ArrowDown: [0x50, 1], PageDown: [0x51, 1], Insert: [0x52, 1], Delete: [0x53, 1],
  MetaLeft: [0x5b, 1], MetaRight: [0x5c, 1], ContextMenu: [0x5d, 1],
};

let screen = null; // { dc, send, w, h }

function startPantalla(t) {
  document.body.classList.add('kind-vnc', 'kind-pantalla');
  status('Conectando directo (WebRTC)…');
  const canvas = document.createElement('canvas');
  canvas.className = 'r-canvas';
  canvas.tabIndex = 0;
  $('#r-screen').appendChild(canvas);
  const g2d = canvas.getContext('2d', { alpha: false });
  const sock = openSocket(t);
  ws = sock;
  let settled = false;
  const done = (title, text) => { if (!settled) { settled = true; showMessage(title, text); } };
  const timer = setTimeout(() => done('No se pudo conectar', 'El agente del equipo no abrió la pantalla a tiempo.'), 15000);

  const send = (buf) => { try { if (screen?.dc?.readyState === 'open') screen.dc.send(buf); } catch {} };
  // Coordenadas del ratón en píxeles de la pantalla del equipo
  const toXY = (e) => {
    const r = canvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(canvas.width - 1, Math.round((e.clientX - r.left) * canvas.width / r.width)));
    const y = Math.max(0, Math.min(canvas.height - 1, Math.round((e.clientY - r.top) * canvas.height / r.height)));
    return [x, y];
  };
  const put2 = (dv, o, v) => dv.setUint16(o, v);
  const mouseMsg = (op, btn, x, y) => {
    const b = new ArrayBuffer(op === 0x6d ? 5 : 6); const dv = new DataView(b); let o = 0;
    dv.setUint8(o++, op);
    if (op !== 0x6d) dv.setUint8(o++, btn);
    put2(dv, o, x); put2(dv, o + 2, y); return b;
  };
  canvas.addEventListener('mousemove', (e) => { const [x, y] = toXY(e); send(mouseMsg(0x6d, 0, x, y)); });
  canvas.addEventListener('mousedown', (e) => { e.preventDefault(); canvas.focus(); const [x, y] = toXY(e); send(mouseMsg(0x64, e.button === 1 ? 1 : e.button === 2 ? 2 : 0, x, y)); });
  canvas.addEventListener('mouseup', (e) => { const [x, y] = toXY(e); send(mouseMsg(0x75, e.button === 1 ? 1 : e.button === 2 ? 2 : 0, x, y)); });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault(); const [x, y] = toXY(e);
    const b = new ArrayBuffer(7); const dv = new DataView(b);
    dv.setUint8(0, 0x77); dv.setInt16(1, e.deltaY > 0 ? -1 : 1); put2(dv, 3, x); put2(dv, 5, y); send(b);
  }, { passive: false });
  const keyMsg = (code, down) => {
    const sc = SCAN[code]; if (!sc) return null;
    const b = new ArrayBuffer(5); const dv = new DataView(b);
    dv.setUint8(0, 0x6b); dv.setUint8(1, down ? 1 : 0); put2(dv, 2, sc[0]); dv.setUint8(4, sc[1] ? 1 : 0); return b;
  };
  const typing = () => !$('#r-clip-panel').classList.contains('hidden') || !$('#r-msg').classList.contains('hidden');
  const onKey = (e, down) => { if (typing() || !screen) return; const m = keyMsg(e.code, down); if (m) { e.preventDefault(); send(m); } };
  document.addEventListener('keydown', (e) => onKey(e, true));
  document.addEventListener('keyup', (e) => onKey(e, false));

  sock.onmessage = async (ev) => {
    if (typeof ev.data !== 'string') return;
    let msg = {}; try { msg = JSON.parse(ev.data); } catch {}
    try {
      if (msg.type === 'rtc') {
        pc = new RTCPeerConnection({ iceServers: msg.iceServers || [] });
        const dc = pc.createDataChannel('pantalla', { ordered: true });
        dc.binaryType = 'arraybuffer';
        screen = { dc };
        dc.onopen = () => { clearTimeout(timer); settled = true; status('Conectado · directo (WebRTC)', 'on'); for (const id of ['#r-cad', '#r-win', '#r-clip']) $(id).disabled = false; canvas.focus(); };
        dc.onmessage = (m) => onScreenData(m.data);
        pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') done('Conexión perdida', 'Se cortó la conexión directa con el equipo.'); };
        await pc.setLocalDescription(await pc.createOffer());
        await iceGathered(pc, 2500);
        sock.send(JSON.stringify({ type: 'offer', sdp: pc.localDescription.sdp }));
      } else if (msg.type === 'answer') {
        await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
      } else if (msg.type === 'error') {
        done('No se pudo conectar', msg.message);
      }
    } catch (err) { done('No se pudo conectar', err.message); }
  };
  sock.onclose = () => done('Sesión terminada', 'Se cerró la conexión con el equipo.');

  const dec = new TextDecoder();
  let blocked = false;
  async function onScreenData(data) {
    const b = new Uint8Array(data); if (!b.length) return;
    const op = b[0];
    if (op === 0x49) { // init
      let info = {}; try { info = JSON.parse(dec.decode(b.subarray(1))); } catch {}
      canvas.width = info.w || 800; canvas.height = info.h || 600;
      g2d.fillStyle = '#05070b'; g2d.fillRect(0, 0, canvas.width, canvas.height);
      screen.w = canvas.width; screen.h = canvas.height;
      document.title = `${t.machine.name} · Pantalla · IIT Tunnel Hub`;
    } else if (op === 0x54) { // tile
      if (blocked) { blocked = false; status('Conectado · directo (WebRTC)', 'on'); }
      const dv = new DataView(data, 1, 8);
      const x = dv.getUint16(0), y = dv.getUint16(2);
      const blob = new Blob([b.subarray(9)], { type: 'image/jpeg' });
      try { const bmp = await createImageBitmap(blob); g2d.drawImage(bmp, x, y); bmp.close?.(); } catch {}
    } else if (op === 0x42) { // bloqueado
      blocked = true;
      status('Pantalla protegida de Windows', 'wait');
    } else if (op === 0x4b) { // portapapeles del equipo
      $('#r-clip-text').value = dec.decode(b.subarray(1));
    }
  }

  // Portapapeles y teclas especiales para esta pantalla
  screenSendText = (text) => { const e = new TextEncoder().encode(text); const b = new Uint8Array(1 + e.length); b[0] = 0x70; b.set(e, 1); send(b.buffer); };
  screenCombo = (codes) => { for (const c of codes) { const m = keyMsg(c, true); if (m) send(m); } for (const c of [...codes].reverse()) { const m = keyMsg(c, false); if (m) send(m); } };
  window.addEventListener('beforeunload', () => { try { pc?.close(); } catch {} });
}
let screenSendText = null; let screenCombo = null;

$('#r-cad').onclick = () => { if (rfb) rfb.sendCtrlAltDel(); else if (gclient) pressCombo([0xffe3, 0xffe9, 0xffff]); else if (screenCombo) screenCombo(['ControlLeft', 'AltLeft', 'Delete']); };
$('#r-win').onclick = () => { if (screenCombo) screenCombo(['MetaLeft']); else pressCombo([0xffeb]); };
$('#r-scale').onclick = () => {
  if (!rfb) return;
  rfb.scaleViewport = !rfb.scaleViewport;
  rfb.clipViewport = !rfb.scaleViewport;
  $('#r-scale').textContent = `Ajustar: ${rfb.scaleViewport ? 'sí' : 'no'}`;
};
$('#r-clip').onclick = () => $('#r-clip-panel').classList.remove('hidden');
$('#r-clip-send').onclick = () => {
  const text = $('#r-clip-text').value;
  if (rfb) { rfb.clipboardPasteFrom(text); rfb.focus(); }
  if (gclient) {
    const w = new Guacamole.StringWriter(gclient.createClipboardStream('text/plain'));
    w.sendText(text); w.sendEnd();
  }
  if (screenSendText) screenSendText(text);
  $('#r-clip-panel').classList.add('hidden');
};
document.addEventListener('click', (e) => { const id = e.target.dataset?.hide; if (id) $('#' + id).classList.add('hidden'); });

// ---------- RDP (escritorio de Windows) ----------

let gclient = null;
function pressCombo(keys) {
  if (!gclient) return;
  for (const k of keys) gclient.sendKeyEvent(1, k);
  for (const k of [...keys].reverse()) gclient.sendKeyEvent(0, k);
}

/** Mensaje claro según el código de estado de Guacamole (guacd manda el detalle en inglés; el hub, en español). */
function explainGuac(st) {
  const code = Number(st?.code); const msg = String(st?.message || '');
  const fixed = {
    769: ['Acceso denegado', 'Usuario o contraseña de Windows incorrectos (o la cuenta no tiene permiso de Escritorio remoto).'],
    771: ['Acceso denegado', 'Windows no permitió iniciar la sesión con ese usuario.'],
    519: ['No se pudo conectar', 'El equipo no respondió: revise que esté en línea y que Escritorio remoto esté activado (puerto 3389).'],
    521: ['Sesión tomada', 'Otra persona inició sesión en el equipo y cerró esta conexión.'],
    522: ['Sesión terminada', 'La sesión de Windows terminó por inactividad.'],
    523: ['Sesión terminada', 'La sesión de Windows se cerró.'],
  };
  if (fixed[code]) return fixed[code];
  if (code === 515) return ['No se pudo conectar', `El equipo no aceptó la conexión RDP: revise que Escritorio remoto esté activado y que el servicio apunte al puerto 3389.${msg ? `\n\nDetalle: ${msg}` : ''}`];
  return ['No se pudo conectar', msg && !/^\d+$/.test(msg) ? msg : `Error ${Number.isFinite(code) ? code : ''} en la sesión.`];
}

async function startRdp(info) {
  document.body.classList.add('kind-rdp');
  status('Esperando credenciales…');
  let c;
  try {
    c = await askCredentials({ title: 'Escritorio remoto (Windows)', hint: `Usuario y contraseña de Windows en ${info.machine.name}. No se guardan en el hub.`, rdp: true });
  } catch { return showMessage('Sesión cancelada', ''); }
  status('Conectando por el túnel…');
  let t;
  try { t = await ticket({ credentials: c }); } catch (err) { return showMessage('No se pudo abrir la sesión', err.message); }
  const screen = $('#r-screen');
  const tunnel = new Guacamole.WebSocketTunnel(t.ws);
  const client = new Guacamole.Client(tunnel);
  gclient = client;
  const display = client.getDisplay();
  const el = display.getElement();
  screen.appendChild(el);

  // Escala: la sesión pide el tamaño de la ventana; si Windows no acepta el cambio, se reduce para que quepa
  const rescale = () => {
    const w = display.getWidth(); const h = display.getHeight();
    if (!w || !h) return;
    display.scale(Math.min(screen.clientWidth / w, screen.clientHeight / h, 1));
  };
  display.onresize = rescale;
  let resizeTimer = null;
  new ResizeObserver(() => {
    rescale();
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (connected) client.sendSize(screen.clientWidth, screen.clientHeight); }, 400);
  }).observe(screen);

  let connected = false; let failed = false;
  client.onstatechange = (st) => {
    if (st === 3) {
      connected = true;
      status('Conectado', 'on');
      for (const id of ['#r-cad', '#r-win', '#r-clip']) $(id).disabled = false;
      document.title = `${t.machine.name} · Escritorio remoto`;
    } else if (st === 5 && !failed) {
      showMessage(connected ? 'Sesión terminada' : 'No se pudo conectar', connected ? 'Se cerró el escritorio remoto.' : 'El hub cerró la conexión.');
    }
  };
  const onErr = (st) => { if (failed) return; failed = true; const [title, text] = explainGuac(st); showMessage(title, text); };
  client.onerror = onErr;
  tunnel.onerror = onErr;
  client.onclipboard = (stream, mimetype) => {
    if (!/^text\//.test(mimetype)) return;
    const r = new Guacamole.StringReader(stream);
    let data = '';
    r.ontext = (x) => { data += x; };
    r.onend = () => { $('#r-clip-text').value = data; };
  };

  // Ratón sobre la pantalla; teclado en toda la página salvo cuando hay un formulario abierto
  const mouse = new Guacamole.Mouse(el);
  mouse.onEach(['mousedown', 'mouseup', 'mousemove'], (e) => client.sendMouseState(e.state, true));
  mouse.on('mouseout', () => display.showCursor(false));
  display.showCursor(false);
  const typing = () => !$('#r-clip-panel').classList.contains('hidden') || !$('#r-auth').classList.contains('hidden') || !$('#r-msg').classList.contains('hidden');
  const kb = new Guacamole.Keyboard(document);
  kb.onkeydown = (k) => { if (typing() || !connected) return true; client.sendKeyEvent(1, k); return false; };
  kb.onkeyup = (k) => { if (typing() || !connected) return; client.sendKeyEvent(0, k); };
  window.addEventListener('blur', () => kb.reset());

  let audio = [];
  try { audio = Guacamole.AudioPlayer.getSupportedTypes(); } catch {}
  let tz = '';
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch {}
  const q = new URLSearchParams({ t: t.ticket, width: String(screen.clientWidth), height: String(screen.clientHeight), dpi: '96', timezone: tz });
  for (const a of audio) q.append('audio', a);
  status('Iniciando sesión en Windows…');
  client.connect(q.toString());
  window.addEventListener('beforeunload', () => { try { client.disconnect(); } catch {} });
}

// ---------- SSH ----------

function startSsh(t) {
  document.body.classList.add('kind-ssh');
  term = new window.Terminal({
    cursorBlink: true, lineHeight: 1.2, fontFamily: '"DM Mono", "Cascadia Mono", Consolas, monospace', fontSize: 14, scrollback: 5000,
    theme: { background: '#05070b', foreground: '#d7e3f4', cursor: '#22d3ee', selectionBackground: '#22d3ee55' },
  });
  fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open($('#r-screen'));
  fit.fit();
  const sock = openSocket(t);
  const enc = new TextEncoder();
  let ready = false;
  sock.onmessage = async (ev) => {
    if (typeof ev.data !== 'string') { term.write(new Uint8Array(ev.data)); return; }
    let msg = {}; try { msg = JSON.parse(ev.data); } catch {}
    if (msg.type === 'auth') {
      try {
        const c = await askCredentials({ title: 'Iniciar sesión SSH', hint: `Usuario del equipo ${t.machine.name}.`, hubKey: msg.hubKey });
        status('Autenticando…');
        sock.send(JSON.stringify({ type: 'auth', ...c, cols: term.cols, rows: term.rows }));
      } catch { sock.close(); showMessage('Sesión cancelada', '', { retry: true }); }
    } else if (msg.type === 'ready') {
      ready = true;
      status('Conectado', 'on');
      term.focus();
    } else if (msg.type === 'info') {
      term.write(`\x1b[90m${msg.message}\x1b[0m\r\n`);
    } else if (msg.type === 'error') {
      showMessage('No se pudo conectar', msg.message);
    }
  };
  sock.onclose = (e) => {
    if (ready) showMessage('Sesión terminada', e.reason || 'La terminal se cerró.');
    else showMessage('No se pudo conectar', e.reason || 'El hub cerró la conexión.');
  };
  term.onData((d) => { if (ready && sock.readyState === 1) sock.send(enc.encode(d)); });
  const sendSize = () => { if (ready && sock.readyState === 1) sock.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })); };
  new ResizeObserver(() => { try { fit.fit(); } catch {} sendSize(); }).observe($('#r-screen'));
  ws = sock;
}

// ---------- arranque y barra ----------

$('#r-full').onclick = () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.();
};
$('#r-close').onclick = () => { finished = true; try { rfb?.disconnect(); ws?.close(); gclient?.disconnect(); } catch {} window.close(); setTimeout(() => showMessage('Sesión terminada', 'Puede cerrar esta pestaña.'), 200); };
$('#r-msg-close').onclick = () => window.close();
$('#r-msg-retry').onclick = () => location.reload();
window.addEventListener('beforeunload', () => { try { rfb?.disconnect(); ws?.close(); pc?.close(); } catch {} });

(async () => {
  if (!machineId || !service) return showMessage('Faltan datos', 'Abra la sesión desde el panel (botón "Conectar por").', { retry: false });
  $('#r-machine').textContent = machineId;
  try {
    const t = await ticket();
    $('#r-machine').textContent = t.machine.name;
    $('#r-kind').textContent = ` · ${t.label} · ${t.service}`;
    document.title = `${t.machine.name} · ${t.label} · IIT Tunnel Hub`;
    status('Conectando por el túnel…');
    if (t.kind === 'pantalla') startPantalla(t);
    else if (t.kind === 'rdp') startRdp(t);
    else if (t.kind === 'vnc' && t.webrtc && window.RTCPeerConnection) startVncRtc(t);
    else if (t.kind === 'vnc') startVnc(t);
    else if (t.kind === 'ssh') startSsh(t);
    else showMessage('No soportado', `El tipo ${t.kind} aún no se abre en el navegador.`, { retry: false });
  } catch (err) {
    showMessage('No se pudo abrir la sesión', err.message);
  }
})();
