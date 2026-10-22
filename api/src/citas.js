'use strict';
// Citas de videoatención: sala WebRTC cámara a cámara + chat entre dos participantes.
// El cliente entra con un CÓDIGO dentro de la VENTANA de la cita; el hub solo hace la señalización
// (ofertas/respuestas/ICE) y relaya el chat y las imágenes — el audio y el video van punto a punto.
// Nota: la cámara/micrófono del navegador exige contexto seguro (HTTPS o 127.0.0.1); el chat funciona en http.

const crypto = require('node:crypto');

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // sin O/0/I/1/L para que sea fácil de dictar
const GRACE_BEFORE = 10 * 60;   // se puede entrar hasta 10 min antes de la hora de la cita
const TICKET_TTL = 120;         // s de validez del ticket para abrir el WebSocket
const MAX_PEERS = 2;            // sala de dos: agente y cliente
const MAX_MSG = 256 * 1024;     // tope por mensaje (imágenes pequeñas van por aquí)
const CODE_RE = /^[A-Z0-9-]{4,20}$/;

const now = () => Math.floor(Date.now() / 1000);

function randomCode(n = 8) {
  const b = crypto.randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += ALPHABET[b[i] % ALPHABET.length];
  return s;
}

/** Estado de una cita según la hora actual y si fue cancelada. */
function phase(a, t = now()) {
  if (a.cancelled_at) return 'cancelada';
  if (t < a.starts_at - GRACE_BEFORE) return 'programada';
  if (t > a.ends_at) return 'finalizada';
  return 'en_curso';
}

function view(a, { withCode = false } = {}) {
  if (!a) return null;
  return {
    id: a.id,
    code: withCode ? a.code : undefined,
    title: a.title,
    clientId: a.client_id,
    customerName: a.customer_name || '',
    startsAt: a.starts_at,
    endsAt: a.ends_at,
    cancelledAt: a.cancelled_at,
    createdBy: a.created_by,
    phase: phase(a),
  };
}

class CitaService {
  constructor({ store, config = {}, log = console } = {}) {
    this.store = store;
    this.log = log;
    this.iceServers = config.webrtc?.iceServers || [{ urls: ['stun:stun.l.google.com:19302'] }];
    this.rooms = new Map();     // citaId → Set<peer>  peer = { ws, role, name }
    this.tickets = new Map();   // ticket → { citaId, role, name, exp }
    this.attempts = new Map();  // ip → { n, since }
  }

  // --- códigos ---
  genCode() {
    for (let i = 0; i < 50; i++) { const c = randomCode(8); if (!this.store.appointmentCodeExists(c)) return c; }
    return randomCode(10);
  }

  normalizeCode(raw) {
    const c = String(raw || '').toUpperCase().replace(/\s+/g, '');
    return CODE_RE.test(c) ? c : null;
  }

  // --- tickets (un solo uso, corta vida) ---
  #issue(citaId, role, name) {
    const ticket = crypto.randomBytes(18).toString('base64url');
    this.tickets.set(ticket, { citaId, role, name: String(name || '').slice(0, 60), exp: now() + TICKET_TTL });
    return ticket;
  }
  takeTicket(t) {
    const v = t && this.tickets.get(t);
    if (!v) return null;
    this.tickets.delete(t);
    if (v.exp < now()) return null;
    return v;
  }

  /** Ticket del agente (staff ya autenticado en el panel). */
  staffTicket(cita, name) { return this.#issue(cita.id, 'agente', name || 'Agente'); }

  /** El cliente entra con el código: valida ventana y devuelve ticket. Lanza con {status,message}. */
  joinByCode(rawCode, ip, name) {
    this.#rateLimit(ip);
    const code = this.normalizeCode(rawCode);
    const bad = () => { this.#countBad(ip); const e = new Error('código no válido'); e.status = 404; return e; };
    if (!code) throw bad();
    const a = this.store.getAppointmentByCode(code);
    if (!a) throw bad();
    const ph = phase(a);
    if (ph === 'cancelada') { const e = new Error('la cita fue cancelada'); e.status = 409; throw e; }
    if (ph === 'programada') { const e = new Error('la cita aún no empieza'); e.status = 409; e.startsAt = a.starts_at; throw e; }
    if (ph === 'finalizada') { const e = new Error('la cita ya terminó'); e.status = 409; throw e; }
    return { ticket: this.#issue(a.id, 'cliente', name || a.customer_name || 'Cliente'), cita: view(a) };
  }

  #rateLimit(ip) {
    const r = this.attempts.get(ip);
    if (r && now() - r.since < 900 && r.n >= 10) { const e = new Error('demasiados intentos, espere unos minutos'); e.status = 429; throw e; }
  }
  #countBad(ip) {
    const r = this.attempts.get(ip);
    if (!r || now() - r.since >= 900) this.attempts.set(ip, { n: 1, since: now() });
    else r.n++;
  }

  // --- sala / señalización ---
  attach(ws, ticket) {
    let room = this.rooms.get(ticket.citaId);
    if (!room) {
      // primera persona: abre el registro de la llamada (con el código de la cita)
      let code = '';
      try { code = this.store.getAppointment(ticket.citaId)?.code || ''; } catch {}
      let callId = null;
      try { callId = this.store.createCall({ id: 'l_' + crypto.randomBytes(9).toString('base64url'), appointmentId: ticket.citaId, code }).id; } catch {}
      room = { peers: new Set(), callId, names: [], peak: 0 };
      this.rooms.set(ticket.citaId, room);
    }
    if (room.peers.size >= MAX_PEERS) { try { ws.send(JSON.stringify({ type: 'error', message: 'la sala ya tiene dos participantes' })); } catch {} ws.close(1008, 'sala llena'); return; }

    const peer = { ws, role: ticket.role, name: ticket.name };
    room.peers.add(peer);
    room.names.push({ role: peer.role, name: peer.name, at: now() });
    room.peak = Math.max(room.peak, room.peers.size);
    if (room.callId) { try { this.store.updateCall(room.callId, { peers: room.peak, participants: JSON.stringify(room.names.slice(0, 20)) }); } catch {} }

    ws.send(JSON.stringify({ type: 'bienvenido', self: { role: peer.role, name: peer.name }, iceServers: this.iceServers, peers: [...room.peers].filter((p) => p !== peer).map((p) => ({ role: p.role, name: p.name })) }));
    const others = [...room.peers].filter((p) => p !== peer);
    if (others.length) {
      ws.send(JSON.stringify({ type: 'listo', initiator: true, peer: { role: others[0].role, name: others[0].name } }));
      others.forEach((p) => p.ws.send(JSON.stringify({ type: 'listo', initiator: false, peer: { role: peer.role, name: peer.name } })));
    }

    ws.on('message', (data, isBinary) => {
      if (isBinary || typeof data !== 'string' || data.length > MAX_MSG) return;
      let msg; try { msg = JSON.parse(data); } catch { return; }
      if (!msg || typeof msg.type !== 'string') return;
      const out = JSON.stringify({ ...msg, from: { role: peer.role, name: peer.name } });
      for (const p of room.peers) if (p !== peer) { try { p.ws.send(out); } catch {} }
    });

    const leave = () => {
      room.peers.delete(peer);
      for (const p of room.peers) { try { p.ws.send(JSON.stringify({ type: 'peer-salio', peer: { role: peer.role, name: peer.name } })); } catch {} }
      if (room.peers.size === 0) {
        if (room.callId) { try { this.store.endCall(room.callId); } catch {} }
        this.rooms.delete(ticket.citaId);
      }
    };
    ws.on('close', leave);
  }

  // mantenimiento: limpia tickets vencidos (llamar de vez en cuando, opcional)
  sweep() { const t = now(); for (const [k, v] of this.tickets) if (v.exp < t) this.tickets.delete(k); }
}

/** Vista de un registro de llamada para la API. */
function callView(c) {
  if (!c) return null;
  let participants = [];
  try { participants = JSON.parse(c.participants || '[]'); } catch {}
  return {
    id: c.id,
    appointmentId: c.appointment_id,
    code: c.code,
    startedAt: c.started_at,
    endedAt: c.ended_at,
    durationSec: c.ended_at ? c.ended_at - c.started_at : null,
    peers: c.peers,
    participants,
    ongoing: !c.ended_at,
  };
}

module.exports = { CitaService, view, callView, phase, GRACE_BEFORE, TICKET_TTL, CODE_RE };
