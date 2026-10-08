// Sesión remota en el navegador: pantalla (VNC, con noVNC) o terminal (SSH, con xterm.js).
// La página recibe ?m=<máquina>&s=<servicio>, pide un ticket de un solo uso al hub y abre el WebSocket.
import RFB from './vendor/novnc/core/rfb.js';

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const machineId = params.get('m') || '';
const service = params.get('s') || '';
const TOKEN_KEY = 'iit-hub-admin-token';

let ws = null; let rfb = null; let term = null; let fit = null;
let finished = false;

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

async function ticket() {
  let token = null;
  try { token = sessionStorage.getItem(TOKEN_KEY); } catch {}
  const res = await fetch(`/api/machines/${encodeURIComponent(machineId)}/remote`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'iit-panel', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify({ service }),
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
function askCredentials({ title, hint, user = true, pass = true, hubKey = false }) {
  return new Promise((resolve, reject) => {
    const f = $('#r-auth');
    $('#r-auth-title').textContent = title;
    $('#r-auth-hint').textContent = hint || '';
    $('#r-user-row').classList.toggle('hidden', !user);
    $('#r-pass-row').classList.toggle('hidden', !pass);
    $('#r-hubkey-row').classList.toggle('hidden', !hubKey);
    $('#r-hubkey').checked = false;
    $('#r-pass').disabled = false;
    try { if (user && !$('#r-user').value) $('#r-user').value = localStorage.getItem(`iit-remote-user:${machineId}/${service}`) || ''; } catch {}
    $('#r-pass').value = '';
    f.classList.remove('hidden');
    setTimeout(() => (user && !$('#r-user').value ? $('#r-user') : $('#r-pass')).focus(), 0);
    f.onsubmit = (e) => {
      e.preventDefault();
      const out = { username: $('#r-user').value.trim(), password: $('#r-pass').value, useHubKey: hubKey && $('#r-hubkey').checked };
      try { if (out.username) localStorage.setItem(`iit-remote-user:${machineId}/${service}`, out.username); } catch {}
      f.classList.add('hidden');
      resolve(out);
    };
    $('#r-auth-cancel').onclick = () => { f.classList.add('hidden'); reject(new Error('cancelado')); };
  });
}
$('#r-hubkey').addEventListener('change', (e) => { $('#r-pass').disabled = e.target.checked; });

// ---------- VNC ----------

function startVnc(t) {
  document.body.classList.add('kind-vnc');
  const sock = openSocket(t);
  sock.onmessage = (ev) => {
    if (typeof ev.data !== 'string') return;
    let msg = {}; try { msg = JSON.parse(ev.data); } catch {}
    if (msg.type === 'error') return showMessage('No se pudo conectar', msg.message);
    if (msg.type !== 'ready') return;
    // Desde aquí el WebSocket transporta RFB: noVNC toma el control del canal ya abierto
    status('Negociando con el servidor VNC…');
    rfb = new RFB($('#r-screen'), sock, { shared: true });
    rfb.scaleViewport = true;
    rfb.background = '#05070b';
    rfb.addEventListener('connect', () => {
      status('Conectado', 'on');
      for (const id of ['#r-cad', '#r-scale', '#r-clip']) $(id).disabled = false;
      rfb.focus();
    });
    rfb.addEventListener('disconnect', (e) => showMessage(e.detail.clean ? 'Sesión terminada' : 'Conexión perdida',
      e.detail.clean ? 'El equipo cerró la sesión.' : 'Se perdió la conexión con el equipo (red, frpc o servidor VNC).'));
    rfb.addEventListener('credentialsrequired', async (e) => {
      const types = e.detail.types || ['password'];
      try {
        const c = await askCredentials({ title: 'Credenciales VNC', hint: 'Las que usa el servidor VNC del equipo (en Raspberry Pi: su usuario y contraseña).', user: types.includes('username'), pass: types.includes('password') });
        rfb.sendCredentials({ username: c.username, password: c.password });
      } catch { rfb.disconnect(); }
    });
    rfb.addEventListener('serververification', (e) => {
      // El túnel ya autentica a la máquina; se acepta y se muestra la huella por transparencia
      status('Verificando servidor…');
      try { console.info('Clave pública del servidor VNC', e.detail.publickey); } catch {}
      rfb.approveServer();
    });
    rfb.addEventListener('securityfailure', (e) => showMessage('Acceso denegado', e.detail.reason || 'El servidor VNC rechazó las credenciales.'));
    rfb.addEventListener('clipboard', (e) => { $('#r-clip-text').value = e.detail.text; });
    rfb.addEventListener('desktopname', (e) => { document.title = `${e.detail.name} · ${t.machine.name} · VNC`; });
  };
  sock.onclose = (e) => { if (!rfb) showMessage('No se pudo conectar', e.reason || 'El hub cerró la conexión.'); };
  ws = sock;
}

$('#r-cad').onclick = () => rfb?.sendCtrlAltDel();
$('#r-scale').onclick = () => {
  if (!rfb) return;
  rfb.scaleViewport = !rfb.scaleViewport;
  rfb.clipViewport = !rfb.scaleViewport;
  $('#r-scale').textContent = `Ajustar: ${rfb.scaleViewport ? 'sí' : 'no'}`;
};
$('#r-clip').onclick = () => $('#r-clip-panel').classList.remove('hidden');
$('#r-clip-send').onclick = () => { rfb?.clipboardPasteFrom($('#r-clip-text').value); $('#r-clip-panel').classList.add('hidden'); rfb?.focus(); };
document.addEventListener('click', (e) => { const id = e.target.dataset?.hide; if (id) $('#' + id).classList.add('hidden'); });

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
$('#r-close').onclick = () => { finished = true; try { rfb?.disconnect(); ws?.close(); } catch {} window.close(); setTimeout(() => showMessage('Sesión terminada', 'Puede cerrar esta pestaña.'), 200); };
$('#r-msg-close').onclick = () => window.close();
$('#r-msg-retry').onclick = () => location.reload();
window.addEventListener('beforeunload', () => { try { rfb?.disconnect(); ws?.close(); } catch {} });

(async () => {
  if (!machineId || !service) return showMessage('Faltan datos', 'Abra la sesión desde el panel (botón "Conectar por").', { retry: false });
  $('#r-machine').textContent = machineId;
  try {
    const t = await ticket();
    $('#r-machine').textContent = t.machine.name;
    $('#r-kind').textContent = ` · ${t.label} · ${t.service}`;
    document.title = `${t.machine.name} · ${t.label} · IIT Tunnel Hub`;
    status('Conectando por el túnel…');
    if (t.kind === 'vnc') startVnc(t);
    else if (t.kind === 'ssh') startSsh(t);
    else showMessage('No soportado', `El tipo ${t.kind} aún no se abre en el navegador.`, { retry: false });
  } catch (err) {
    showMessage('No se pudo abrir la sesión', err.message);
  }
})();
