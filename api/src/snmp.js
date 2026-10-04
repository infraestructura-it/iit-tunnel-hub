'use strict';
// Cliente SNMP sin dependencias: v2c y v3 (USM) sobre UDP.
//   - Codificación BER de mensajes y PDUs (GET, GETNEXT, GETBULK) y recorrido (walk)
//   - v3: descubrimiento del motor, llaves localizadas (RFC 3414 / RFC 7860), autenticación
//     HMAC-MD5/SHA-1/SHA-224/256/384/512, privacidad AES-128-CFB (RFC 3826) y DES-CBC si OpenSSL lo ofrece
// Solo lectura: no implementa SET (el hub monitorea, no configura equipos por SNMP).

const dgram = require('node:dgram');
const crypto = require('node:crypto');

// ---------- BER ----------

const T = {
  INTEGER: 0x02, OCTET_STRING: 0x04, NULL: 0x05, OID: 0x06, SEQUENCE: 0x30,
  IP_ADDRESS: 0x40, COUNTER32: 0x41, GAUGE32: 0x42, TIMETICKS: 0x43, OPAQUE: 0x44, COUNTER64: 0x46,
  NO_SUCH_OBJECT: 0x80, NO_SUCH_INSTANCE: 0x81, END_OF_MIB_VIEW: 0x82,
  GET: 0xa0, GET_NEXT: 0xa1, RESPONSE: 0xa2, SET: 0xa3, GET_BULK: 0xa5, INFORM: 0xa6, TRAP_V2: 0xa7, REPORT: 0xa8,
};
const TYPE_NAME = {
  [T.INTEGER]: 'Integer', [T.OCTET_STRING]: 'OctetString', [T.NULL]: 'Null', [T.OID]: 'OID',
  [T.IP_ADDRESS]: 'IpAddress', [T.COUNTER32]: 'Counter32', [T.GAUGE32]: 'Gauge32', [T.TIMETICKS]: 'TimeTicks',
  [T.OPAQUE]: 'Opaque', [T.COUNTER64]: 'Counter64',
  [T.NO_SUCH_OBJECT]: 'noSuchObject', [T.NO_SUCH_INSTANCE]: 'noSuchInstance', [T.END_OF_MIB_VIEW]: 'endOfMibView',
};

function encLength(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  while (n > 0) { bytes.unshift(n & 0xff); n >>= 8; }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag, value) => Buffer.concat([Buffer.from([tag]), encLength(value.length), value]);
const seq = (...items) => tlv(T.SEQUENCE, Buffer.concat(items));

function encInt(n) {
  // entero con signo, mínimo en complemento a dos
  let v = BigInt(n);
  const out = [];
  for (;;) {
    out.unshift(Number(v & 0xffn));
    const sign = out[0] & 0x80;
    v >>= 8n;
    if ((v === 0n && !sign) || (v === -1n && sign)) break;
  }
  return tlv(T.INTEGER, Buffer.from(out));
}
const encOctets = (b) => tlv(T.OCTET_STRING, Buffer.isBuffer(b) ? b : Buffer.from(String(b ?? ''), 'utf8'));
const encNull = () => Buffer.from([T.NULL, 0]);

function encOid(oid) {
  const parts = parseOid(oid);
  if (parts.length < 2) throw new Error(`OID inválido: ${oid}`);
  const out = [40 * parts[0] + parts[1]];
  for (const p of parts.slice(2)) {
    const chunk = [p & 0x7f];
    let v = Math.floor(p / 128);
    while (v > 0) { chunk.unshift((v & 0x7f) | 0x80); v = Math.floor(v / 128); }
    out.push(...chunk);
  }
  return tlv(T.OID, Buffer.from(out));
}

function parseOid(oid) {
  const s = String(oid).trim().replace(/^\./, '');
  if (!/^\d+(\.\d+)+$/.test(s)) throw new Error(`OID inválido: ${oid}`);
  return s.split('.').map(Number);
}

/** Lee un TLV en buf[pos]. Devuelve { tag, start (inicio del valor), end, next }. */
function readTlv(buf, pos) {
  if (pos + 2 > buf.length) throw new Error('mensaje SNMP truncado');
  const tag = buf[pos];
  let len = buf[pos + 1];
  let start = pos + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4) throw new Error('longitud BER no soportada');
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[start + i];
    start += n;
  }
  const end = start + len;
  if (end > buf.length) throw new Error('mensaje SNMP truncado');
  return { tag, start, end, next: end };
}

function children(buf, t) {
  const out = [];
  for (let p = t.start; p < t.end;) { const c = readTlv(buf, p); out.push(c); p = c.next; }
  return out;
}

function decInt(buf, t) {
  if (t.end === t.start) return 0;
  let v = BigInt.asIntN(8, BigInt(buf[t.start]));
  for (let i = t.start + 1; i < t.end; i++) v = (v << 8n) | BigInt(buf[i]);
  return Number(v);
}
function decUint(buf, t) {
  let v = 0n;
  for (let i = t.start; i < t.end; i++) v = (v << 8n) | BigInt(buf[i]);
  return Number(v);
}
function decOid(buf, t) {
  const b = buf.subarray(t.start, t.end);
  if (!b.length) return '';
  const out = [Math.floor(b[0] / 40), b[0] % 40];
  let v = 0;
  for (let i = 1; i < b.length; i++) {
    v = v * 128 + (b[i] & 0x7f);
    if (!(b[i] & 0x80)) { out.push(v); v = 0; }
  }
  if (b[0] >= 80) { out[0] = 2; out[1] = b[0] - 80; }
  return out.join('.');
}

function decValue(buf, t) {
  switch (t.tag) {
    case T.INTEGER: return decInt(buf, t);
    case T.OCTET_STRING: case T.OPAQUE: return Buffer.from(buf.subarray(t.start, t.end));
    case T.OID: return decOid(buf, t);
    case T.IP_ADDRESS: return [...buf.subarray(t.start, t.end)].join('.');
    case T.COUNTER32: case T.GAUGE32: case T.TIMETICKS: case T.COUNTER64: return decUint(buf, t);
    default: return null; // NULL y excepciones (noSuchObject, endOfMibView…)
  }
}

// ---------- PDU ----------

function encPdu(type, reqId, varbinds, { nonRepeaters = 0, maxRepetitions = 0 } = {}) {
  const vbs = seq(...varbinds.map((oid) => seq(encOid(oid), encNull())));
  const a = type === T.GET_BULK ? nonRepeaters : 0;
  const b = type === T.GET_BULK ? maxRepetitions : 0;
  return tlv(type, Buffer.concat([encInt(reqId), encInt(a), encInt(b), vbs]));
}

function decPdu(buf, t) {
  const [rid, es, ei, vbl] = children(buf, t);
  const varbinds = children(buf, vbl).map((vb) => {
    const [o, v] = children(buf, vb);
    return { oid: decOid(buf, o), type: TYPE_NAME[v.tag] || `0x${v.tag.toString(16)}`, value: decValue(buf, v) };
  });
  return { type: t.tag, requestId: decInt(buf, rid), errorStatus: decInt(buf, es), errorIndex: decInt(buf, ei), varbinds };
}

const ERROR_STATUS = ['', 'tooBig', 'noSuchName', 'badValue', 'readOnly', 'genErr', 'noAccess', 'wrongType', 'wrongLength',
  'wrongEncoding', 'wrongValue', 'noCreation', 'inconsistentValue', 'resourceUnavailable', 'commitFailed', 'undoFailed',
  'authorizationError', 'notWritable', 'inconsistentName'];

// ---------- USM (v3) ----------

const AUTH = {
  md5: { hash: 'md5', mac: 12 }, sha: { hash: 'sha1', mac: 12 }, sha224: { hash: 'sha224', mac: 16 },
  sha256: { hash: 'sha256', mac: 24 }, sha384: { hash: 'sha384', mac: 32 }, sha512: { hash: 'sha512', mac: 48 },
};
const PRIV = ['aes', 'des'];
const desAvailable = () => crypto.getCiphers().includes('des-cbc');

/** Llave localizada: 1 MB de la contraseña repetida, luego hash(Ku + engineID + Ku). (RFC 3414 A.2, RFC 7860) */
const keyCache = new Map();
function localizedKey(hash, password, engineId) {
  const id = `${hash}|${password}|${engineId.toString('hex')}`;
  if (keyCache.has(id)) return keyCache.get(id);
  const pw = Buffer.from(password, 'utf8');
  if (pw.length < 8) throw new Error('las contraseñas SNMPv3 deben tener al menos 8 caracteres');
  const h = crypto.createHash(hash);
  const block = Buffer.alloc(64);
  for (let count = 0, i = 0; count < 1048576; count += 64) {
    for (let j = 0; j < 64; j++) block[j] = pw[i++ % pw.length];
    h.update(block);
  }
  const ku = h.digest();
  const kul = crypto.createHash(hash).update(Buffer.concat([ku, engineId, ku])).digest();
  if (keyCache.size > 200) keyCache.clear();
  keyCache.set(id, kul);
  return kul;
}

const REPORT_OIDS = {
  '1.3.6.1.6.3.15.1.1.1.0': 'nivel de seguridad no soportado por el equipo',
  '1.3.6.1.6.3.15.1.1.2.0': 'fuera de la ventana de tiempo',
  '1.3.6.1.6.3.15.1.1.3.0': 'usuario SNMPv3 desconocido',
  '1.3.6.1.6.3.15.1.1.4.0': 'engineID desconocido',
  '1.3.6.1.6.3.15.1.1.5.0': 'contraseña de autenticación incorrecta (firma inválida)',
  '1.3.6.1.6.3.15.1.1.6.0': 'error al descifrar (contraseña o protocolo de privacidad incorrectos)',
};

class SnmpError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

// ---------- sesión ----------

let nextId = crypto.randomInt(1, 0x3fffffff);
const newId = () => { nextId = nextId >= 0x7ffffff0 ? 1 : nextId + 1; return nextId; };

class SnmpSession {
  /**
   * @param o.host, o.port (161)
   * @param o.version  '2c' | '3'
   * @param o.community  (v2c)
   * @param o.user, o.authProtocol ('none'|'md5'|'sha'|'sha224'|'sha256'|'sha384'|'sha512'), o.authKey,
   *        o.privProtocol ('none'|'aes'|'des'), o.privKey, o.context  (v3)
   * @param o.timeout ms por intento (3000), o.retries (1)
   */
  constructor(o) {
    this.o = { port: 161, version: '2c', community: 'public', timeout: 3000, retries: 1, authProtocol: 'none', privProtocol: 'none', context: '', ...o };
    if (this.o.version === '3') {
      if (this.o.authProtocol !== 'none' && !AUTH[this.o.authProtocol]) throw new SnmpError(`protocolo de autenticación no soportado: ${this.o.authProtocol}`);
      if (this.o.privProtocol !== 'none') {
        if (!PRIV.includes(this.o.privProtocol)) throw new SnmpError(`protocolo de privacidad no soportado: ${this.o.privProtocol}`);
        if (this.o.authProtocol === 'none') throw new SnmpError('la privacidad (cifrado) requiere autenticación');
        if (this.o.privProtocol === 'des' && !desAvailable()) throw new SnmpError('DES requiere arrancar el hub con "node --openssl-legacy-provider" (o use AES en el equipo)');
      }
    }
    this.socket = null;
    this.pending = new Map();
    this.engine = null; // { id, boots, time, syncedAt }
    this.salt = crypto.randomBytes(8).readBigUInt64BE();
  }

  #open() {
    if (this.socket) return;
    this.socket = dgram.createSocket(this.o.host.includes(':') ? 'udp6' : 'udp4');
    this.socket.on('message', (msg) => this.#onMessage(msg));
    this.socket.on('error', (e) => { for (const p of this.pending.values()) p.reject(e); this.pending.clear(); });
    this.socket.unref();
  }

  close() { try { this.socket?.close(); } catch {} this.socket = null; }

  #onMessage(msg) {
    try {
      const r = this.o.version === '3' ? this.#decodeV3(msg) : this.#decodeV2c(msg);
      const p = this.pending.get(r.key);
      if (p) { this.pending.delete(r.key); p.resolve(r); }
    } catch { /* paquete ajeno o dañado: se ignora y vence por tiempo */ }
  }

  /** Envía y espera respuesta con reintentos. key = id que se emparejará (requestId en v2c, msgID en v3). */
  async #exchange(build) {
    this.#open();
    let lastErr;
    for (let attempt = 0; attempt <= this.o.retries; attempt++) {
      const { buf, key } = build();
      try {
        return await new Promise((resolve, reject) => {
          const timer = setTimeout(() => { this.pending.delete(key); reject(new SnmpError(`sin respuesta de ${this.o.host}:${this.o.port} (${this.o.timeout} ms)`, 'TIMEOUT')); }, this.o.timeout);
          this.pending.set(key, {
            resolve: (r) => { clearTimeout(timer); resolve(r); },
            reject: (e) => { clearTimeout(timer); reject(e); },
          });
          this.socket.send(buf, this.o.port, this.o.host, (e) => { if (e) { clearTimeout(timer); this.pending.delete(key); reject(e); } });
        });
      } catch (e) {
        lastErr = e;
        if (e.code !== 'TIMEOUT') throw e;
      }
    }
    throw lastErr;
  }

  // ----- v2c -----

  #decodeV2c(msg) {
    const top = readTlv(msg, 0);
    const [, , pduT] = children(msg, top);
    const pdu = decPdu(msg, pduT);
    return { key: pdu.requestId, pdu };
  }

  async #requestV2c(type, oids, opts) {
    const r = await this.#exchange(() => {
      const id = newId();
      return { key: id, buf: seq(encInt(1), encOctets(this.o.community), encPdu(type, id, oids, opts)) };
    });
    return r.pdu;
  }

  // ----- v3 -----

  #flags() { return (this.o.authProtocol !== 'none' ? 1 : 0) | (this.o.privProtocol !== 'none' ? 2 : 0); }

  #engineTime() { return this.engine ? this.engine.time + Math.floor((Date.now() - this.engine.syncedAt) / 1000) : 0; }

  #buildV3(pduBuf, { discovery = false } = {}) {
    const msgId = newId();
    const flags = discovery ? 0x04 : this.#flags() | 0x04;
    const engineId = discovery ? Buffer.alloc(0) : this.engine.id;
    const boots = discovery ? 0 : this.engine.boots;
    const time = discovery ? 0 : this.#engineTime();
    const auth = !discovery && this.o.authProtocol !== 'none' ? AUTH[this.o.authProtocol] : null;
    const priv = !discovery && this.o.privProtocol !== 'none' ? this.o.privProtocol : null;

    let scoped = seq(encOctets(engineId), encOctets(this.o.context || ''), pduBuf);
    let privParams = Buffer.alloc(0);
    if (priv) {
      const key = localizedKey(auth.hash, this.o.privKey, engineId);
      if (priv === 'aes') {
        this.salt = (this.salt + 1n) & 0xffffffffffffffffn;
        privParams = Buffer.alloc(8); privParams.writeBigUInt64BE(this.salt);
        const iv = Buffer.alloc(16); iv.writeUInt32BE(boots, 0); iv.writeUInt32BE(time, 4); privParams.copy(iv, 8);
        const c = crypto.createCipheriv('aes-128-cfb', key.subarray(0, 16), iv);
        scoped = encOctets(Buffer.concat([c.update(scoped), c.final()]));
      } else {
        // DES-CBC (RFC 3414 8.1.1): sal = boots(4) + contador(4); IV = pre-IV XOR sal; relleno a múltiplo de 8
        this.salt = (this.salt + 1n) & 0xffffffffn;
        privParams = Buffer.alloc(8); privParams.writeUInt32BE(boots, 0); privParams.writeUInt32BE(Number(this.salt), 4);
        const preIv = key.subarray(8, 16);
        const iv = Buffer.from(preIv.map((b, i) => b ^ privParams[i]));
        const pad = (8 - (scoped.length % 8)) % 8;
        const c = crypto.createCipheriv('des-cbc', key.subarray(0, 8), iv); c.setAutoPadding(false);
        scoped = encOctets(Buffer.concat([c.update(Buffer.concat([scoped, Buffer.alloc(pad)])), c.final()]));
      }
    }
    const authZero = Buffer.alloc(auth ? auth.mac : 0);
    const usm = seq(encOctets(engineId), encInt(boots), encInt(time), encOctets(discovery ? '' : this.o.user), encOctets(authZero), encOctets(privParams));
    const header = seq(encInt(msgId), encInt(65507), encOctets(Buffer.from([flags])), encInt(3));
    let msg = seq(encInt(3), header, encOctets(usm), scoped);
    if (auth) {
      const key = localizedKey(auth.hash, this.o.authKey, engineId);
      const mac = crypto.createHmac(auth.hash, key).update(msg).digest().subarray(0, auth.mac);
      const at = msg.indexOf(Buffer.concat([Buffer.from([T.OCTET_STRING, auth.mac]), authZero]));
      mac.copy(msg, at + 2);
    }
    return { key: msgId, buf: msg };
  }

  #decodeV3(msg) {
    const top = readTlv(msg, 0);
    const [, headerT, usmT, scopedT] = children(msg, top);
    const [msgIdT, , flagsT] = children(msg, headerT);
    const msgId = decInt(msg, msgIdT);
    const flags = msg[flagsT.start];
    const usmSeq = readTlv(msg, usmT.start);
    const [eidT, bootsT, timeT, , authT, privT] = children(msg, usmSeq);
    const engine = { id: Buffer.from(msg.subarray(eidT.start, eidT.end)), boots: decInt(msg, bootsT), time: decInt(msg, timeT) };

    // Verifica la firma de la respuesta (si viene autenticada)
    if (flags & 1 && this.o.authProtocol !== 'none') {
      const auth = AUTH[this.o.authProtocol];
      const got = Buffer.from(msg.subarray(authT.start, authT.end));
      const copy = Buffer.from(msg); copy.fill(0, authT.start, authT.end);
      const key = localizedKey(auth.hash, this.o.authKey, engine.id);
      const mac = crypto.createHmac(auth.hash, key).update(copy).digest().subarray(0, auth.mac);
      if (got.length !== mac.length || !crypto.timingSafeEqual(got, mac)) throw new SnmpError('firma de respuesta inválida');
    }

    let scopedBuf = msg; let scoped = scopedT;
    if (flags & 2) {
      const privParams = msg.subarray(privT.start, privT.end);
      const auth = AUTH[this.o.authProtocol];
      const key = localizedKey(auth.hash, this.o.privKey, engine.id);
      const enc = msg.subarray(scopedT.start, scopedT.end);
      let plain;
      if (this.o.privProtocol === 'aes') {
        const iv = Buffer.alloc(16); iv.writeUInt32BE(engine.boots, 0); iv.writeUInt32BE(engine.time, 4); Buffer.from(privParams).copy(iv, 8);
        const d = crypto.createDecipheriv('aes-128-cfb', key.subarray(0, 16), iv);
        plain = Buffer.concat([d.update(enc), d.final()]);
      } else {
        const iv = Buffer.from(key.subarray(8, 16).map((b, i) => b ^ privParams[i]));
        const d = crypto.createDecipheriv('des-cbc', key.subarray(0, 8), iv); d.setAutoPadding(false);
        plain = Buffer.concat([d.update(enc), d.final()]);
      }
      scopedBuf = plain; scoped = readTlv(plain, 0);
    }
    const [, , pduT] = children(scopedBuf, scoped);
    return { key: msgId, engine, pdu: decPdu(scopedBuf, pduT) };
  }

  async #discover() {
    const r = await this.#exchange(() => this.#buildV3(encPdu(T.GET, newId(), []), { discovery: true }));
    if (!r.engine.id.length) throw new SnmpError('el equipo no informó su engineID');
    this.engine = { ...r.engine, syncedAt: Date.now() };
  }

  async #requestV3(type, oids, opts) {
    if (!this.engine) await this.#discover();
    for (let attempt = 0; attempt < 2; attempt++) {
      let r;
      try { r = await this.#exchange(() => this.#buildV3(encPdu(type, newId(), oids, opts))); }
      catch (e) {
        // El equipo respondió el descubrimiento pero calla ante la consulta cifrada: casi siempre es la clave de privacidad
        if (e.code === 'TIMEOUT' && this.o.privProtocol !== 'none') throw new SnmpError(`${e.message}: el equipo responde pero no a la consulta cifrada; revise la contraseña y el protocolo de privacidad`, 'TIMEOUT');
        throw e;
      }
      if (r.pdu.type !== T.REPORT) return r.pdu;
      const oid = r.pdu.varbinds[0]?.oid;
      if (oid === '1.3.6.1.6.3.15.1.1.2.0' && attempt === 0) { // fuera de la ventana de tiempo: se resincroniza
        this.engine = { ...r.engine, syncedAt: Date.now() };
        continue;
      }
      throw new SnmpError(REPORT_OIDS[oid] || `el equipo respondió un reporte SNMPv3 (${oid})`, 'REPORT');
    }
    throw new SnmpError('no se pudo sincronizar con el equipo (ventana de tiempo)', 'REPORT');
  }

  async #request(type, oids, opts) {
    const pdu = this.o.version === '3' ? await this.#requestV3(type, oids, opts) : await this.#requestV2c(type, oids, opts);
    if (pdu.errorStatus) {
      const vb = pdu.varbinds[pdu.errorIndex - 1];
      throw new SnmpError(`el equipo respondió ${ERROR_STATUS[pdu.errorStatus] || pdu.errorStatus}${vb ? ` en ${vb.oid}` : ''}`, 'PDU');
    }
    return pdu.varbinds;
  }

  get(oids) { return this.#request(T.GET, oids.map((o) => parseOid(o).join('.'))); }
  getNext(oids) { return this.#request(T.GET_NEXT, oids.map((o) => parseOid(o).join('.'))); }
  getBulk(oids, nonRepeaters = 0, maxRepetitions = 20) {
    return this.#request(T.GET_BULK, oids.map((o) => parseOid(o).join('.')), { nonRepeaters, maxRepetitions });
  }

  /** Recorre un subárbol con GETBULK. Devuelve los varbinds bajo `base` (máximo `max`). */
  async walk(base, { max = 2000, maxRepetitions = 25 } = {}) {
    const root = parseOid(base).join('.');
    const out = [];
    let cur = root;
    while (out.length < max) {
      const vbs = await this.getBulk([cur], 0, maxRepetitions);
      if (!vbs.length) break;
      let done = false;
      for (const vb of vbs) {
        if (vb.type === 'endOfMibView' || !(vb.oid === root || vb.oid.startsWith(root + '.'))) { done = true; break; }
        if (vb.oid === cur && out.length) { done = true; break; } // el agente no avanza
        out.push(vb);
        cur = vb.oid;
        if (out.length >= max) break;
      }
      if (done) break;
    }
    return out;
  }
}

// ---------- presentación ----------

/** Valor legible: textos imprimibles como texto, binarios en hex, TimeTicks como número. */
function display(vb) {
  if (vb.value === null || vb.value === undefined) return vb.type;
  if (Buffer.isBuffer(vb.value)) {
    const b = vb.value;
    const s = b.toString('utf8');
    const printable = b.length > 0 && !/[\x00-\x08\x0e-\x1f\x7f�]/.test(s.replace(/\0+$/, ''));
    return printable ? s.replace(/\0+$/, '').trim() : b.toString('hex').replace(/(..)(?!$)/g, '$1:');
  }
  return vb.value;
}

function ticksToText(t) {
  const s = Math.floor(Number(t) / 100);
  const d = Math.floor(s / 86400); const h = Math.floor((s % 86400) / 3600); const m = Math.floor((s % 3600) / 60);
  return d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : `${m} min`;
}

module.exports = { SnmpSession, SnmpError, display, ticksToText, parseOid, AUTH, desAvailable, _ber: { encOid, decOid, readTlv, encInt, decInt } };
