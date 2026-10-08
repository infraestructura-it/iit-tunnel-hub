'use strict';
// Sesiones remotas desde el navegador (como Raspberry Pi Connect): pantalla por VNC y terminal por SSH.
//
//   navegador ──WebSocket (sesión del panel)──▶ hub ──127.0.0.1:<puerto>──▶ frpc del hub (visitante stcp)
//                                                      ──▶ frps ──▶ frpc de la máquina ──▶ VNC :5900 / SSH :22
//
// Ningún puerto queda público: el hub entra como visitante "_hub" del servicio privado de la máquina.
// VNC: el hub solo transporta los bytes RFB (el visor es noVNC en el navegador).
// SSH: el hub es el cliente SSH (ssh2) y el navegador muestra la terminal (xterm.js).

const fs = require('node:fs');
const net = require('node:net');
const crypto = require('node:crypto');
const { Client: SshClient } = require('../deps/ssh2');

const KINDS = { vnc: 'Pantalla (VNC)', ssh: 'Terminal (SSH)', rdp: 'Escritorio remoto (RDP)' };
const BROWSER_KINDS = new Set(['vnc', 'ssh']); // RDP llega en otra entrega (guacd)
const TICKET_TTL_MS = 60 * 1000;
const MAX_SESSIONS = 20;

/** Tipo de acceso remoto de un servicio privado: por nombre (ssh*, vnc*, rdp*) o por puerto conocido. */
function remoteKind(s) {
  if (!s || s.type !== 'stcp') return null;
  const n = String(s.name || '').toLowerCase();
  if (/^ssh/.test(n)) return 'ssh';
  if (/^vnc/.test(n)) return 'vnc';
  if (/^(rdp|escritorio)/.test(n)) return 'rdp';
  const p = Number(s.local_port ?? s.localPort);
  if (p === 22) return 'ssh';
  if (p >= 5900 && p <= 5999) return 'vnc';
  if (p === 3389) return 'rdp';
  return null;
}
const browserKind = (s) => { const k = remoteKind(s); return BROWSER_KINDS.has(k) ? k : null; };

/** Puerto local (127.0.0.1) donde el frpc del hub abre el servicio; fijo por servicio. */
const visitorPort = (base, svc) => (base + svc.id <= 65000 ? base + svc.id : null);

class RemoteService {
  constructor({ store, config, frps, hub, log = console }) {
    Object.assign(this, { store, config, frps, hub, log });
    this.tickets = new Map(); // ticket → { machineId, serviceId, kind, actor, exp }
    this.sessions = new Set();
  }

  /** Visitantes stcp del frpc del hub para todos los servicios con acceso desde el navegador. */
  visitors() {
    const out = [];
    for (const s of this.store.listServices()) {
      if (!browserKind(s) || !s.secret) continue;
      const m = this.store.getMachine(s.machine_id);
      const port = visitorPort(this.config.remotePortBase, s);
      if (!m || !m.enabled || !port) continue;
      out.push({ name: `remoto-${s.id}`, type: 'stcp', serverUser: m.id, serverName: s.name, secretKey: s.secret, bindPort: port });
    }
    return out;
  }

  createTicket({ machineId, service, actor }) {
    const now = Date.now();
    for (const [k, t] of this.tickets) if (t.exp < now) this.tickets.delete(k);
    const ticket = crypto.randomBytes(24).toString('base64url');
    this.tickets.set(ticket, { machineId, serviceId: service.id, kind: browserKind(service), actor, exp: now + TICKET_TTL_MS });
    return ticket;
  }

  takeTicket(ticket) {
    const t = this.tickets.get(String(ticket || ''));
    if (!t) return null;
    this.tickets.delete(ticket);
    return t.exp >= Date.now() ? t : null;
  }

  /** Atiende un WebSocket ya aceptado con su ticket validado. */
  attach(ws, t, { ip, run }) {
    const svc = this.store.listServices().find((s) => s.id === t.serviceId);
    const m = svc && this.store.getMachine(svc.machine_id);
    const fail = (msg) => { try { ws.send(JSON.stringify({ type: 'error', message: msg })); } catch {} ws.close(1011, msg.slice(0, 100)); };
    if (!svc || !m || m.id !== t.machineId) return fail('el servicio ya no existe');
    if (!m.enabled) return fail('la máquina está deshabilitada');
    if (this.sessions.size >= MAX_SESSIONS) return fail('demasiadas sesiones abiertas en el hub');
    const port = visitorPort(this.config.remotePortBase, svc);
    if (!port) return fail('el servicio no tiene puerto local en el hub');

    const sess = { ws, svc, m, kind: t.kind, actor: t.actor, ip, start: Date.now(), bytesIn: 0, bytesOut: 0 };
    this.sessions.add(sess);
    const label = `${KINDS[t.kind]} · ${svc.name} · ${ip}`;
    run(() => this.store.event(m.id, 'sesion_remota', `inicio · ${label}`, 0));
    let ended = false;
    sess.end = (why = '') => {
      if (ended) return;
      ended = true;
      this.sessions.delete(sess);
      const secs = Math.round((Date.now() - sess.start) / 1000);
      run(() => this.store.event(m.id, 'sesion_remota_fin', `${label} · ${secs} s · ${fmtBytes(sess.bytesIn + sess.bytesOut)}${why ? ' · ' + why : ''}`, 0));
    };
    ws.on('close', () => sess.end());
    if (t.kind === 'vnc') return this.#vnc(sess, port, fail);
    if (t.kind === 'ssh') return this.#ssh(sess, port, fail);
    return fail('tipo de sesión no soportado');
  }

  // VNC: puente binario WebSocket ⇄ TCP (el protocolo RFB lo hablan noVNC y el servidor VNC)
  #vnc(sess, port, fail) {
    const { ws } = sess;
    const tcp = net.connect({ host: '127.0.0.1', port });
    let gotData = false;
    tcp.setNoDelay(true);
    // "ready" recién con el primer byte del servidor VNC (su saludo RFB): el puerto local del frpc del hub
    // acepta aunque la máquina no responda, así que conectar no prueba nada
    tcp.on('data', (d) => {
      if (!gotData) ws.send(JSON.stringify({ type: 'ready' }));
      gotData = true;
      sess.bytesIn += d.length;
      if (!ws.send(d)) { tcp.pause(); ws.once('drain', () => tcp.resume()); }
    });
    tcp.on('error', (e) => fail(e.code === 'ECONNREFUSED' ? 'el hub aún no abre este servicio: espere unos segundos y reintente' : `conexión: ${e.message}`));
    tcp.on('close', () => {
      if (!gotData) fail('la máquina no respondió: revise que esté en línea y que el servidor VNC corra en ese puerto');
      else ws.close(1000, 'el equipo cerró la sesión');
    });
    ws.on('message', (data, binary) => {
      if (!binary) return; // los textos son mensajes de control del panel
      sess.bytesOut += data.length;
      if (!tcp.write(data)) { ws.pause(); tcp.once('drain', () => ws.resume()); }
    });
    ws.on('close', () => tcp.destroy());
  }

  // SSH: el hub es el cliente; el navegador manda {type:auth} y luego teclas (binario) y {type:resize}
  #ssh(sess, port, fail) {
    const { ws, svc } = sess;
    let client = null; let stream = null;
    const authTimer = setTimeout(() => fail('no llegaron las credenciales'), 120000);
    ws.on('close', () => { clearTimeout(authTimer); try { client?.end(); } catch {} });
    ws.on('message', (data, binary) => {
      if (binary) { if (stream) { sess.bytesOut += data.length; stream.write(data); } return; }
      let msg; try { msg = JSON.parse(data); } catch { return; }
      if (msg.type === 'resize' && stream) {
        stream.setWindow(clampInt(msg.rows, 2, 500, 24), clampInt(msg.cols, 10, 1000, 80), 0, 0);
        return;
      }
      if (msg.type !== 'auth' || client) return;
      clearTimeout(authTimer);
      const username = String(msg.username || '').trim().slice(0, 64);
      if (!/^[A-Za-z0-9._@-]+$/.test(username)) return fail('usuario no válido');
      const cfg = {
        host: '127.0.0.1', port, username, readyTimeout: 20000, keepaliveInterval: 20000,
        hostVerifier: (key) => this.#checkHostKey(svc, key, ws),
        tryKeyboard: true,
      };
      if (msg.useHubKey) {
        try { cfg.privateKey = fs.readFileSync(this.config.ai.sshKeyPath); }
        catch { return fail('el hub aún no tiene su clave SSH (se crea al configurar la IA)'); }
      } else {
        cfg.password = String(msg.password ?? '');
      }
      client = new SshClient();
      client.on('keyboard-interactive', (_n, _i, _l, prompts, finish) => finish(prompts.map(() => String(msg.password ?? ''))));
      client.on('ready', () => {
        client.shell({ term: 'xterm-256color', cols: clampInt(msg.cols, 10, 1000, 80), rows: clampInt(msg.rows, 2, 500, 24) }, (err, sh) => {
          if (err) return fail(`no se pudo abrir la terminal: ${err.message}`);
          stream = sh;
          ws.send(JSON.stringify({ type: 'ready' }));
          sh.on('data', (d) => { sess.bytesIn += d.length; if (!ws.send(d)) { sh.pause(); ws.once('drain', () => sh.resume()); } });
          sh.stderr?.on('data', (d) => ws.send(d));
          sh.on('close', () => ws.close(1000, 'sesión terminada'));
        });
      });
      client.on('error', (e) => {
        const level = e.level === 'client-authentication' ? 'usuario o contraseña incorrectos'
          : /hostkey|host key/i.test(e.message) ? e.message
          : e.code === 'ECONNREFUSED' ? 'el hub aún no abre este servicio: espere unos segundos y reintente'
          : /handshake|timed out|ECONNRESET/i.test(e.message) ? 'la máquina no respondió: revise que esté en línea y que SSH corra en ese puerto'
          : e.message;
        fail(level);
      });
      client.on('close', () => { if (!ws.closed) ws.close(1000, 'sesión terminada'); });
      client.connect(cfg);
    });
    ws.send(JSON.stringify({ type: 'auth', hubKey: fs.existsSync(this.config.ai.sshKeyPath + '.pub') }));
  }

  /** Primera vez: se guarda la huella del equipo. Después debe coincidir (protege contra suplantación). */
  #checkHostKey(svc, key, ws) {
    const fp = 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
    const all = this.store.getSetting('ssh_hostkeys', {}) || {};
    const k = `${svc.machine_id}/${svc.name}`;
    if (!all[k]) {
      all[k] = { fp, at: Math.floor(Date.now() / 1000) };
      this.store.putSetting('ssh_hostkeys', all);
      ws.send(JSON.stringify({ type: 'info', message: `Huella del equipo guardada: ${fp}` }));
      return true;
    }
    if (all[k].fp === fp) return true;
    ws.send(JSON.stringify({ type: 'error', message: `La huella SSH del equipo cambió (antes ${all[k].fp}, ahora ${fp}). Si reinstaló el sistema, un administrador debe olvidar la huella en el panel.` }));
    return false;
  }

  forgetHostKey(machineId, service) {
    const all = this.store.getSetting('ssh_hostkeys', {}) || {};
    const k = `${machineId}/${service}`;
    if (!all[k]) return false;
    delete all[k];
    this.store.putSetting('ssh_hostkeys', all);
    return true;
  }

  active() {
    return [...this.sessions].map((s) => ({ machine: s.m.id, service: s.svc.name, kind: s.kind, actor: s.actor, since: Math.floor(s.start / 1000) }));
  }
}

const clampInt = (v, min, max, def) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : def; };
function fmtBytes(n) {
  const u = ['B', 'KB', 'MB', 'GB']; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n < 10 && i ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
}

module.exports = { RemoteService, remoteKind, browserKind, visitorPort, KINDS };
