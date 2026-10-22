'use strict';
// Sala de videoatención: ingreso por código → WebRTC cámara a cámara + chat.
// El hub solo hace señalización; audio/video van punto a punto. Cámara/micrófono requieren HTTPS o 127.0.0.1.

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);

let ws, pc, localStream;
let iceServers = [{ urls: ['stun:stun.l.google.com:19302'] }];
const secure = location.protocol === 'https:' || ['127.0.0.1', 'localhost'].includes(location.hostname);

function show(which) {
  $('#join').classList.toggle('hidden', which !== 'join');
  $('#room').classList.toggle('hidden', which !== 'room');
}
function setStatus(t) { $('#cita-status').textContent = t; }
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// ---------- ingreso ----------
async function joinWithCode() {
  const code = $('#code').value.trim();
  const name = $('#name').value.trim();
  if (!code) { $('#join-msg').textContent = 'Ingrese el código.'; return; }
  $('#join-btn').disabled = true;
  $('#join-msg').textContent = 'Validando…';
  try {
    const r = await fetch('/api/citas/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, name }) });
    const d = await r.json();
    if (!r.ok) {
      $('#join-msg').textContent = (d.error || 'No se pudo entrar')
        + (d.startsAt ? ` — empieza el ${new Date(d.startsAt * 1000).toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' })}` : '');
      $('#join-btn').disabled = false;
      return;
    }
    startRoom(d.ticket, d.cita);
  } catch { $('#join-msg').textContent = 'Error de conexión con el servidor.'; $('#join-btn').disabled = false; }
}

// ---------- sala ----------
async function startRoom(ticket, cita) {
  if (cita && cita.title) $('#room-title').textContent = cita.title;
  show('room');
  await getMedia();
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/api/citas/ws?t=${encodeURIComponent(ticket)}`);
  ws.onmessage = onSignal;
  ws.onclose = () => setStatus('Desconectado de la sala');
  ws.onerror = () => setStatus('Error de conexión');
  setStatus('En la sala · esperando al otro participante…');
}

async function getMedia() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    $('#localVideo').srcObject = localStream;
  } catch (e) {
    $('#media-note').textContent = secure
      ? `No se pudo abrir la cámara/micrófono: ${e.message}. Puede continuar por chat.`
      : 'La cámara y el micrófono necesitan HTTPS (o abrir la página en 127.0.0.1). Puede continuar por chat.';
    $('#media-note').classList.remove('hidden');
    $('#btn-cam').classList.add('off'); $('#btn-mic').classList.add('off');
  }
}

function newPC() {
  if (pc) return pc;
  pc = new RTCPeerConnection({ iceServers });
  if (localStream) localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
  pc.onicecandidate = (e) => { if (e.candidate) sig({ type: 'ice', candidate: e.candidate }); };
  pc.ontrack = (e) => { $('#remoteVideo').srcObject = e.streams[0]; setStatus('En llamada'); };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') setStatus('En llamada');
    if (pc.connectionState === 'failed') setStatus('No se pudo establecer el video directo (posible NAT; se necesitaría un servidor TURN). El chat sigue.');
  };
  return pc;
}

function sig(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }

async function onSignal(ev) {
  let m; try { m = JSON.parse(ev.data); } catch { return; }
  switch (m.type) {
    case 'bienvenido':
      if (Array.isArray(m.iceServers) && m.iceServers.length) iceServers = m.iceServers;
      break;
    case 'listo': {
      newPC();
      setStatus(`Conectado con ${m.peer?.name || 'el otro participante'}`);
      if (m.initiator) { const off = await pc.createOffer(); await pc.setLocalDescription(off); sig({ type: 'offer', sdp: off }); }
      break;
    }
    case 'offer': {
      newPC();
      await pc.setRemoteDescription(m.sdp);
      const ans = await pc.createAnswer(); await pc.setLocalDescription(ans); sig({ type: 'answer', sdp: ans });
      break;
    }
    case 'answer': if (pc) await pc.setRemoteDescription(m.sdp); break;
    case 'ice': if (pc && m.candidate) { try { await pc.addIceCandidate(m.candidate); } catch {} } break;
    case 'chat': addChat(m.from?.name || 'Otro', m.text, false); break;
    case 'img': addImg(m.from?.name || 'Otro', m.data, false); break;
    case 'peer-salio': setStatus('El otro participante salió de la sala'); if ($('#remoteVideo').srcObject) $('#remoteVideo').srcObject = null; break;
    case 'error': setStatus(m.message || 'Error'); break;
  }
}

// ---------- chat ----------
function addChat(who, text, me) {
  const d = document.createElement('div');
  d.className = 'chat-msg ' + (me ? 'me' : 'them');
  d.innerHTML = `<span class="who">${esc(who)}</span>${esc(text)}`;
  $('#chat-log').appendChild(d); $('#chat-log').scrollTop = 1e9;
}
function addImg(who, dataUrl, me) {
  if (!/^data:image\//.test(dataUrl || '')) return;
  const d = document.createElement('div');
  d.className = 'chat-msg ' + (me ? 'me' : 'them');
  d.innerHTML = `<span class="who">${esc(who)}</span>`;
  const img = document.createElement('img'); img.src = dataUrl; img.onclick = () => window.open(dataUrl, '_blank');
  d.appendChild(img);
  $('#chat-log').appendChild(d); $('#chat-log').scrollTop = 1e9;
}

$('#chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const t = $('#chat-input').value.trim();
  if (!t) return;
  sig({ type: 'chat', text: t });
  addChat('Yo', t, true);
  $('#chat-input').value = '';
});

// imagen: se reduce a 900px y se envía como JPEG por el chat
$('#btn-img').addEventListener('click', () => $('#img-input').click());
$('#img-input').addEventListener('change', (e) => {
  const file = e.target.files[0]; if (!file) return;
  const img = new Image();
  img.onload = () => {
    const max = 900, scale = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement('canvas'); c.width = img.width * scale; c.height = img.height * scale;
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const data = c.toDataURL('image/jpeg', 0.7);
    if (data.length > 230000) { setStatus('La imagen es muy grande incluso reducida; intente otra.'); return; }
    sig({ type: 'img', data }); addImg('Yo', data, true);
  };
  img.src = URL.createObjectURL(file);
  e.target.value = '';
});

// ---------- controles de medios ----------
$('#btn-mic').addEventListener('click', () => {
  const tr = localStream && localStream.getAudioTracks()[0]; if (!tr) return;
  tr.enabled = !tr.enabled; $('#btn-mic').classList.toggle('off', !tr.enabled);
});
$('#btn-cam').addEventListener('click', () => {
  const tr = localStream && localStream.getVideoTracks()[0]; if (!tr) return;
  tr.enabled = !tr.enabled; $('#btn-cam').classList.toggle('off', !tr.enabled);
});
$('#btn-hang').addEventListener('click', () => {
  try { sig({ type: 'bye' }); ws && ws.close(); } catch {}
  try { pc && pc.close(); } catch {}
  try { localStream && localStream.getTracks().forEach((t) => t.stop()); } catch {}
  setStatus('Llamada finalizada');
  show('join'); $('#join-btn').disabled = false; $('#join-msg').textContent = 'Llamada finalizada.';
});

// ---------- arranque ----------
$('#join-btn').addEventListener('click', joinWithCode);
$('#code').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinWithCode(); });

if (params.get('ticket')) {
  // el agente abre la sala desde el panel con un ticket (sin código)
  startRoom(params.get('ticket'), { title: params.get('titulo') || 'Videoatención' });
} else {
  if (params.get('code')) $('#code').value = params.get('code').toUpperCase();
  show('join');
  $('#code').focus();
}
