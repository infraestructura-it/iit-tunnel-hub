'use strict';
// Correo saliente (SMTP) sin dependencias: configura un servidor SMTP en Ajustes y envía
// el link de conexión de un equipo (u otros avisos) por correo.
//   - Transporte: net/tls nativos; AUTH LOGIN; STARTTLS (587) o TLS implícito (465) o sin cifrar (25).
//   - La clave del SMTP es un secreto: nunca sale en la API (se enmascara, igual que SNMP/IA/Telegram).
// Config en settings['mail'] = { host, port, secure, user, pass, fromName, fromAddr }.

const net = require('node:net');
const tls = require('node:tls');

const SETTINGS_KEY = 'mail';
const DEFAULTS = { host: '', port: 587, secure: 'starttls', user: '', pass: '', fromName: 'IIT Tunnel Hub', fromAddr: '' };
const SECURE = ['tls', 'starttls', 'none'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------- configuración ----------

function loadSettings(store) {
  const s = store.getSetting(SETTINGS_KEY, {}) || {};
  return {
    host: typeof s.host === 'string' ? s.host : DEFAULTS.host,
    port: Number.isInteger(s.port) ? s.port : DEFAULTS.port,
    secure: SECURE.includes(s.secure) ? s.secure : DEFAULTS.secure,
    user: typeof s.user === 'string' ? s.user : '',
    pass: typeof s.pass === 'string' ? s.pass : '',
    fromName: typeof s.fromName === 'string' ? s.fromName : DEFAULTS.fromName,
    fromAddr: typeof s.fromAddr === 'string' ? s.fromAddr : '',
  };
}

/** Vista segura para la API: la clave nunca se devuelve. */
function publicSettings(s) {
  return {
    configured: !!(s.host && s.fromAddr),
    host: s.host,
    port: s.port,
    secure: s.secure,
    user: s.user,
    fromName: s.fromName,
    fromAddr: s.fromAddr,
    passSet: !!s.pass,
  };
}

/** Aplica cambios validados. pass vacío o ausente conserva la actual; null la borra. */
function updateSettings(store, body, bad) {
  const cur = loadSettings(store);
  const next = { ...cur };

  if (body.host !== undefined) next.host = String(body.host ?? '').trim();
  if (body.port !== undefined) {
    const p = Number(body.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) throw bad('puerto SMTP inválido (1–65535)');
    next.port = p;
  }
  if (body.secure !== undefined) {
    if (!SECURE.includes(body.secure)) throw bad("secure debe ser 'tls', 'starttls' o 'none'");
    next.secure = body.secure;
  }
  if (body.user !== undefined) next.user = String(body.user ?? '').trim();
  if (body.pass === null) next.pass = '';
  else if (typeof body.pass === 'string' && body.pass !== '') next.pass = body.pass;
  if (body.fromName !== undefined) next.fromName = String(body.fromName ?? '').trim().slice(0, 120);
  if (body.fromAddr !== undefined) {
    const a = String(body.fromAddr ?? '').trim();
    if (a && !EMAIL_RE.test(a)) throw bad('remitente (fromAddr) no es un correo válido');
    next.fromAddr = a;
  }
  store.putSetting(SETTINGS_KEY, next);
  return next;
}

// ---------- SMTP ----------

function b64(s) { return Buffer.from(s, 'utf8').toString('base64'); }

// Enmascara datos sensibles en mensajes de error (clave en AUTH, nunca registrar).
function safeErr(e) { return new Error(String(e && e.message ? e.message : e).replace(/AUTH\s+\S+.*/i, 'AUTH …')); }

// Lee respuestas SMTP completas (soporta multilínea "250-… / 250 …").
function makeExpect(getSock) {
  let buf = '';
  let pending = null;
  const onData = (d) => { buf += d.toString('utf8'); flush(); };
  function flush() {
    if (!pending) return;
    const lines = buf.split('\r\n');
    for (let i = 0; i < lines.length; i++) {
      if (/^\d{3} /.test(lines[i])) {
        const reply = lines.slice(0, i + 1);
        const code = parseInt(reply[reply.length - 1].slice(0, 3), 10);
        buf = lines.slice(i + 1).join('\r\n');
        const p = pending; pending = null;
        p.resolve({ code, text: reply.join('\n') });
        return;
      }
    }
  }
  getSock().on('data', onData);
  return {
    rebind(sock) { sock.on('data', onData); },
    expect() { return new Promise((resolve, reject) => { pending = { resolve, reject }; flush(); }); },
  };
}

function buildMessage({ fromName, fromAddr }, { to, subject, text, html }) {
  const encSubject = `=?UTF-8?B?${b64(subject)}?=`;
  const fromHdr = fromName ? `=?UTF-8?B?${b64(fromName)}?= <${fromAddr}>` : `<${fromAddr}>`;
  const headers = [
    `From: ${fromHdr}`,
    `To: <${to}>`,
    `Subject: ${encSubject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@iit-tunnel-hub>`,
    'MIME-Version: 1.0',
  ];
  const wrap = (s) => s.replace(/(.{1,76})/g, '$1\r\n').trimEnd();
  if (html) {
    const bnd = `=_iit_${Math.random().toString(36).slice(2)}`;
    headers.push(`Content-Type: multipart/alternative; boundary="${bnd}"`);
    const body = [
      `--${bnd}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', wrap(b64(text || '')),
      `--${bnd}`, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', wrap(b64(html)),
      `--${bnd}--`, '',
    ].join('\r\n');
    return headers.join('\r\n') + '\r\n\r\n' + body;
  }
  headers.push('Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64');
  return headers.join('\r\n') + '\r\n\r\n' + wrap(b64(text || ''));
}

// Envía un correo por SMTP. Devuelve cuando el servidor acepta el mensaje (250 tras DATA).
function smtpSend(s, mail, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    let done = false;
    let sock = s.secure === 'tls'
      ? tls.connect({ host: s.host, port: s.port, servername: s.host })
      : net.connect({ host: s.host, port: s.port });
    const timer = setTimeout(() => fail(new Error('tiempo de espera SMTP agotado')), timeoutMs);
    function fail(e) { if (done) return; done = true; clearTimeout(timer); try { sock.destroy(); } catch {} reject(safeErr(e)); }
    function ok() { if (done) return; done = true; clearTimeout(timer); try { sock.end(); } catch {} resolve(); }
    sock.on('error', fail);

    const io = makeExpect(() => sock);
    const send = (line) => sock.write(line + '\r\n');
    const need = (r, ...codes) => { if (!codes.includes(r.code)) throw new Error(`SMTP respondió ${r.text.split('\n').pop()}`); return r; };
    const ehloName = 'iit-tunnel-hub';

    (async () => {
      const start = () => new Promise((res) => (s.secure === 'tls' ? sock.once('secureConnect', res) : sock.once('connect', res)));
      await start();
      need(await io.expect(), 220);
      send(`EHLO ${ehloName}`); need(await io.expect(), 250);

      if (s.secure === 'starttls') {
        send('STARTTLS'); need(await io.expect(), 220);
        sock = tls.connect({ socket: sock, servername: s.host });
        sock.on('error', fail);
        await new Promise((res) => sock.once('secureConnect', res));
        io.rebind(sock);
        send(`EHLO ${ehloName}`); need(await io.expect(), 250);
      }

      if (s.user) {
        send('AUTH LOGIN'); need(await io.expect(), 334);
        send(b64(s.user)); need(await io.expect(), 334);
        send(b64(s.pass)); need(await io.expect(), 235);
      }

      send(`MAIL FROM:<${s.fromAddr}>`); need(await io.expect(), 250);
      send(`RCPT TO:<${mail.to}>`); need(await io.expect(), 250, 251);
      send('DATA'); need(await io.expect(), 354);
      sock.write(buildMessage(s, mail) + '\r\n.\r\n');
      need(await io.expect(), 250);
      send('QUIT');
      ok();
    })().catch(fail);
  });
}

/** Carga la config y envía. Lanza si no está configurado el correo. */
async function sendMail(store, mail) {
  const s = loadSettings(store);
  if (!s.host || !s.fromAddr) { const e = new Error('el correo saliente no está configurado'); e.code = 'MAIL_NOT_CONFIGURED'; throw e; }
  if (!EMAIL_RE.test(mail.to)) { const e = new Error('destinatario inválido'); e.code = 'BAD_RECIPIENT'; throw e; }
  await smtpSend(s, mail);
  return { to: mail.to, from: s.fromAddr };
}

/** Correo con el link de conexión de un equipo. */
function connectionLinkEmail({ machine, serviceLabel, url, note }) {
  const name = `${machine.name}${machine.client ? ` · ${machine.client}` : ''}`;
  const subject = `Conexión remota · ${machine.name}`;
  const text = [
    `Equipo: ${name}`,
    serviceLabel ? `Servicio: ${serviceLabel}` : '',
    note ? `\n${note}\n` : '',
    'Abra este enlace (debe iniciar sesión en el panel):',
    url,
    '',
    '— IIT Tunnel Hub',
  ].filter(Boolean).join('\n');
  const esc = (x) => String(x).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const html = `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;font-size:14px;color:#0b1220">
<p>Equipo: <b>${esc(name)}</b>${serviceLabel ? ` · ${esc(serviceLabel)}` : ''}</p>
${note ? `<p>${esc(note)}</p>` : ''}
<p>Abra este enlace (debe iniciar sesión en el panel):</p>
<p><a href="${esc(url)}">${esc(url)}</a></p>
<p style="color:#64748b">— IIT Tunnel Hub</p></div>`;
  return { subject, text, html };
}

/** Correo con el link y el código de una cita de videoatención. */
function citaEmail({ cita, link, code, note }) {
  const when = cita.startsAt ? new Date(cita.startsAt * 1000).toLocaleString('es-CO', { dateStyle: 'full', timeStyle: 'short' }) : '';
  const subject = `Cita de videoatención · ${cita.title}`;
  const text = [
    `Tiene una cita de videoatención: ${cita.title}`,
    cita.customerName ? `Para: ${cita.customerName}` : '',
    when ? `Fecha y hora: ${when}` : '',
    note ? `\n${note}\n` : '',
    'A la hora de la cita, entre a la sala con este enlace:',
    link,
    `Código: ${code}`,
    '',
    'Para que funcionen la cámara y el micrófono, abra el enlace en un navegador actualizado.',
    '',
    '— IIT · Infraestructura-IT',
  ].filter(Boolean).join('\n');
  const esc = (x) => String(x).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const html = `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;font-size:14px;color:#0b1220">
<p>Tiene una cita de videoatención: <b>${esc(cita.title)}</b></p>
${cita.customerName ? `<p>Para: ${esc(cita.customerName)}</p>` : ''}
${when ? `<p>Fecha y hora: <b>${esc(when)}</b></p>` : ''}
${note ? `<p>${esc(note)}</p>` : ''}
<p>A la hora de la cita, entre a la sala:</p>
<p><a href="${esc(link)}" style="display:inline-block;padding:10px 16px;background:#0ea5e9;color:#fff;border-radius:8px;text-decoration:none">Entrar a la sala</a></p>
<p>O con el código: <b style="font-family:monospace;font-size:16px">${esc(code)}</b></p>
<p style="color:#64748b">— IIT · Infraestructura-IT</p></div>`;
  return { subject, text, html };
}

module.exports = { SETTINGS_KEY, loadSettings, publicSettings, updateSettings, sendMail, smtpSend, connectionLinkEmail, citaEmail, EMAIL_RE };
