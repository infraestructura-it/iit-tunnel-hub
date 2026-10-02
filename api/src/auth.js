'use strict';
// Autenticación de personas: contraseñas (scrypt), segundo factor TOTP (RFC 6238), sesiones y permisos.
// Sin dependencias: todo con node:crypto.

const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);

const ROLES = ['admin', 'tecnico', 'cliente'];
const ROLE_LABEL = { admin: 'Administrador', tecnico: 'Técnico', cliente: 'Cliente' };
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,31}$/;
const MIN_PASSWORD = 10;
const SESSION_HOURS = 12;
const MAX_FAILS = 5;
const LOCK_MINUTES = 15;

// ---------- contraseñas ----------

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(String(password), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

// Hash de relleno: si el usuario no existe se verifica contra él para no revelar por el tiempo de respuesta.
let dummyHash = null;

async function verifyPassword(password, stored) {
  if (!stored) {
    dummyHash = dummyHash || await hashPassword('relleno-' + crypto.randomBytes(8).toString('hex'));
    stored = dummyHash;
    password = String(password) + '\0';
  }
  const [alg, N, r, p, salt, key] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(key, 'base64');
  const got = await scrypt(String(password), Buffer.from(salt, 'base64'), expected.length, { N: Number(N), r: Number(r), p: Number(p) });
  return crypto.timingSafeEqual(expected, got);
}

function checkPasswordPolicy(password, bad) {
  const p = String(password || '');
  if (p.length < MIN_PASSWORD) throw bad(`la contraseña debe tener al menos ${MIN_PASSWORD} caracteres`);
  if (p.length > 200) throw bad('la contraseña es demasiado larga');
  if (/^(.)\1+$/.test(p)) throw bad('la contraseña no puede ser un mismo carácter repetido');
  return p;
}

/** Contraseña temporal legible (sin caracteres ambiguos) para usuarios nuevos o restablecidos. */
function tempPassword() {
  const abc = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const b = crypto.randomBytes(14);
  let s = '';
  for (const x of b) s += abc[x % abc.length];
  return `${s.slice(0, 4)}-${s.slice(4, 9)}-${s.slice(9, 14)}`;
}

// ---------- TOTP (Google Authenticator, Authy, Microsoft Authenticator…) ----------

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0; let value = 0; let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const s = String(str).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0; let value = 0; const out = [];
  for (const c of s) {
    value = (value << 5) | B32.indexOf(c); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

function newTotpSecret() { return base32Encode(crypto.randomBytes(20)); }

function totpAt(secret, step) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1e6).padStart(6, '0');
}

const currentStep = (t = Date.now()) => Math.floor(t / 1000 / 30);
function totpCode(secret, t = Date.now()) { return totpAt(secret, currentStep(t)); }

/**
 * Verifica un código con tolerancia de ±1 intervalo (30 s). Devuelve el intervalo usado, o null.
 * `lastStep` evita reutilizar un código ya aceptado.
 */
function verifyTotp(secret, code, lastStep = 0) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c) || !secret) return null;
  const now = currentStep();
  for (const step of [now - 1, now, now + 1]) {
    if (step <= (lastStep || 0)) continue;
    const a = Buffer.from(totpAt(secret, step));
    if (crypto.timingSafeEqual(a, Buffer.from(c))) return step;
  }
  return null;
}

function totpUri(secret, username, issuer = 'IIT Tunnel Hub') {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(username)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

// ---------- sesiones ----------

const COOKIE = 'iit_sesion';
function newSessionToken() { return crypto.randomBytes(32).toString('base64url'); }
function hashSession(token) { return crypto.createHash('sha256').update(String(token)).digest('hex'); }

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sessionCookie(token, { secure, maxAge = SESSION_HOURS * 3600 } = {}) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

// ---------- permisos ----------

/**
 * Quién hace la petición y qué puede ver.
 *  - clientIds = null → todas las máquinas (admin o token de API)
 *  - clientIds = Set  → solo máquinas de esos clientes (técnico: asignados; cliente: el suyo)
 */
class Access {
  constructor({ user = null, role, clientIds = null, via }) {
    this.user = user;
    this.role = role;
    this.clientIds = clientIds;
    this.via = via; // 'sesion' | 'token'
  }
  get isAdmin() { return this.role === 'admin'; }
  get isStaff() { return this.role === 'admin' || this.role === 'tecnico'; }
  get actor() { return this.user ? this.user.username : 'token-api'; }
  /** Las máquinas sin cliente solo las ve el administrador. */
  canSee(machine) { return !!machine && (this.clientIds === null || (machine.client_id != null && this.clientIds.has(machine.client_id))); }
  canWrite(machine) { return this.isStaff && this.canSee(machine); }
  canUseClient(clientId) { return this.clientIds === null || this.clientIds.has(clientId); }
}

module.exports = {
  ROLES, ROLE_LABEL, USERNAME_RE, MIN_PASSWORD, SESSION_HOURS, MAX_FAILS, LOCK_MINUTES, COOKIE,
  hashPassword, verifyPassword, checkPasswordPolicy, tempPassword,
  newTotpSecret, totpCode, verifyTotp, totpUri, base32Encode, base32Decode,
  newSessionToken, hashSession, parseCookies, sessionCookie, Access,
};
