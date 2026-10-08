'use strict';
// WebSocket mínimo (RFC 6455) para las sesiones remotas del navegador: sin dependencias.
// Solo servidor: acepta el upgrade, desenmascara lo que manda el navegador, arma tramas sin máscara,
// responde ping, cierra limpio y propaga la contrapresión del socket ('drain').

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 16 * 1024 * 1024;

class WsConn extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.frags = null; // { opcode, parts[] } de un mensaje fragmentado
    this.closed = false;
    this.alive = true;
    socket.setNoDelay(true);
    socket.on('data', (d) => this.#onData(d));
    socket.on('drain', () => this.emit('drain'));
    socket.on('close', () => this.#finish());
    socket.on('error', () => this.#finish());
    this.pinger = setInterval(() => {
      if (!this.alive) return this.terminate();
      this.alive = false;
      this.#frame(0x9, Buffer.alloc(0));
    }, 30000);
    this.pinger.unref?.();
  }

  get bufferedAmount() { return this.socket.writableLength; }
  pause() { this.socket.pause(); }
  resume() { this.socket.resume(); }

  /** Envía texto (string) o binario (Buffer). Devuelve false si conviene esperar 'drain'. */
  send(data) {
    if (this.closed) return false;
    return typeof data === 'string' ? this.#frame(0x1, Buffer.from(data, 'utf8')) : this.#frame(0x2, data);
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    const r = Buffer.from(String(reason).slice(0, 120), 'utf8');
    const p = Buffer.alloc(2 + r.length);
    p.writeUInt16BE(code, 0);
    r.copy(p, 2);
    this.#frame(0x8, p);
    this.closed = true;
    this.socket.end();
    setTimeout(() => this.socket.destroy(), 2000).unref?.();
    this.#finish(code, reason);
  }

  terminate() { this.socket.destroy(); this.#finish(1006, ''); }

  #finish(code = 1006, reason = '') {
    clearInterval(this.pinger);
    if (this.done) return;
    this.done = true;
    this.closed = true;
    this.emit('close', code, reason);
  }

  #frame(opcode, payload) {
    const len = payload.length;
    let head;
    if (len < 126) { head = Buffer.alloc(2); head[1] = len; }
    else if (len < 65536) { head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.alloc(10); head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
    head[0] = 0x80 | opcode;
    if (this.socket.destroyed) return false;
    return this.socket.write(Buffer.concat([head, payload]));
  }

  #onData(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (this.buf.length >= 2) {
      const b0 = this.buf[0]; const b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0; const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f; let off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) {
        if (this.buf.length < 10) return;
        const big = this.buf.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE)) return this.close(1009, 'mensaje demasiado grande');
        len = Number(big); off = 10;
      }
      if (!masked) return this.close(1002, 'el cliente debe enmascarar');
      if (len > MAX_MESSAGE) return this.close(1009, 'mensaje demasiado grande');
      if (this.buf.length < off + 4 + len) return;
      const mask = this.buf.subarray(off, off + 4);
      const data = Buffer.from(this.buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      this.buf = this.buf.subarray(off + 4 + len);
      this.#onFrame(fin, opcode, data);
      if (this.closed) return;
    }
  }

  #onFrame(fin, opcode, data) {
    if (opcode === 0x8) { // cierre
      const code = data.length >= 2 ? data.readUInt16BE(0) : 1005;
      if (!this.closed) this.close(code === 1005 ? 1000 : code);
      return;
    }
    if (opcode === 0x9) { this.#frame(0xA, data); return; } // ping → pong
    if (opcode === 0xA) { this.alive = true; return; }
    if (opcode === 0x0) { // continuación
      if (!this.frags) return this.close(1002, 'continuación sin inicio');
      this.frags.parts.push(data);
      if (this.frags.parts.reduce((n, p) => n + p.length, 0) > MAX_MESSAGE) return this.close(1009, 'mensaje demasiado grande');
      if (fin) { const { opcode: op, parts } = this.frags; this.frags = null; this.#deliver(op, Buffer.concat(parts)); }
      return;
    }
    if (opcode === 0x1 || opcode === 0x2) {
      if (!fin) { this.frags = { opcode, parts: [data] }; return; }
      this.#deliver(opcode, data);
      return;
    }
    this.close(1002, 'opcode desconocido');
  }

  #deliver(opcode, data) {
    this.alive = true;
    this.emit('message', opcode === 0x1 ? data.toString('utf8') : data, opcode === 0x2);
  }
}

/**
 * Completa el handshake de un 'upgrade'. Devuelve la conexión o null (ya respondió el error).
 * opts.protocols: subprotocolos que acepta el servidor (se elige el primero que pida el cliente).
 */
function accept(req, socket, { protocols = [] } = {}) {
  const key = req.headers['sec-websocket-key'];
  if (String(req.headers.upgrade || '').toLowerCase() !== 'websocket' || !key || req.headers['sec-websocket-version'] !== '13') {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    return null;
  }
  const asked = String(req.headers['sec-websocket-protocol'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  const proto = asked.find((p) => protocols.includes(p));
  const acceptKey = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write([
    'HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey}`, ...(proto ? [`Sec-WebSocket-Protocol: ${proto}`] : []), '', '',
  ].join('\r\n'));
  return new WsConn(socket);
}

/** Rechaza un upgrade con un estado HTTP. */
function reject(socket, status, text) {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

module.exports = { accept, reject, WsConn };
