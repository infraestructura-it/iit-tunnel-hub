'use strict';
// Reglas de negocio: validación, tokens por máquina, servicios y generación de frpc.toml.

const crypto = require('node:crypto');

const ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const SVC_RE = /^[a-z0-9](?:[a-z0-9-]{0,18}[a-z0-9])?$/;
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const HOST_RE = /^[a-zA-Z0-9]([a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?$/;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg) => new HttpError(400, msg);

// ---------- tokens ----------

function newToken() { return crypto.randomBytes(32).toString('base64url'); }
function hashToken(token) { return crypto.createHash('sha256').update(String(token)).digest('hex'); }
function tokenMatches(token, hash) {
  if (typeof token !== 'string' || !token || !hash) return false;
  const a = Buffer.from(hashToken(token), 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- normalización ----------

function rawSlug(text) {
  return String(text || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// Recorta a 32 caracteres cortando en un guion, no a mitad de palabra
function slugify(text) {
  const s = rawSlug(text);
  if (s.length <= 32) return s;
  const cut = s.slice(0, 33).lastIndexOf('-');
  return (cut > 0 ? s.slice(0, cut) : s.slice(0, 32)).replace(/-+$/, '');
}

function str(v, max, field) {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw bad(`${field} debe ser texto`);
  const s = v.trim();
  if (s.length > max) throw bad(`${field} admite máximo ${max} caracteres`);
  return s;
}

function port(v, field) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw bad(`${field} debe ser un puerto entre 1 y 65535`);
  return n;
}

/** Valida los datos de una máquina nueva y resuelve su id. */
function normalizeMachine(body, store) {
  const name = str(body.name, 80, 'name');
  if (!name) throw bad('name es obligatorio');
  const client = str(body.client, 80, 'client');
  const description = str(body.description, 500, 'description');

  let id = body.id !== undefined && body.id !== '' ? str(body.id, 32, 'id').toLowerCase() : '';
  if (id) {
    if (!ID_RE.test(id)) throw bad('id solo admite a-z, 0-9 y guiones (máx. 32, sin guion al inicio o final)');
    if (store.getMachine(id)) throw new HttpError(409, `ya existe una máquina con id "${id}"`);
  } else {
    // Cliente + nombre si cabe completo; si no, solo el nombre (el id es el usuario frp y prefijo de subdominios)
    const both = client ? rawSlug(`${client}-${name}`) : '';
    const base = (both && both.length <= 32 ? both : slugify(name)) || 'maquina';
    id = base;
    for (let i = 2; store.getMachine(id); i++) id = `${base.slice(0, 28)}-${i}`;
    if (!ID_RE.test(id)) throw bad('no se pudo generar un id válido; envíe "id" explícito');
  }
  return { id, name, client, description };
}

/**
 * Valida un servicio. Tipos:
 *  - http:  frps lo publica en http://<subdominio>.<dominio>
 *  - https: frps enruta por SNI sin descifrar. tlsMode:
 *           "local"       → frpc termina TLS con el plugin https2http (certificado en la máquina)
 *           "passthrough" → el servicio local ya habla HTTPS
 *  - tcp:   frps abre un puerto público del rango configurado
 */
function normalizeService(body, machineId, store, frps) {
  const name = str(body.name, 20, 'service.name').toLowerCase();
  if (!SVC_RE.test(name)) throw bad('el nombre del servicio solo admite a-z, 0-9 y guiones (máx. 20)');
  if (store.getService(machineId, name)) throw new HttpError(409, `la máquina ya tiene un servicio "${name}"`);

  const type = str(body.type, 10, 'service.type').toLowerCase() || 'http';
  if (!['http', 'https', 'tcp'].includes(type)) throw bad('service.type debe ser http, https o tcp');

  const localIp = str(body.localIp, 253, 'service.localIp') || '127.0.0.1';
  if (!IPV4_RE.test(localIp) && !HOST_RE.test(localIp)) throw bad('service.localIp no es una IP o host válido');
  const localPort = port(body.localPort, 'service.localPort');

  const out = { name, type, localIp, localPort, subdomain: null, remotePort: null, tlsMode: null };

  if (type === 'http' || type === 'https') {
    const sub = (str(body.subdomain, 63, 'service.subdomain') || `${name}-${machineId}`).toLowerCase();
    if (!LABEL_RE.test(sub) || sub.length > 63) throw bad(`el subdominio "${sub}" no es válido (máx. 63 caracteres, a-z 0-9 -)`);
    const owner = store.subdomainOwner(sub);
    if (owner) throw new HttpError(409, `el subdominio "${sub}" ya lo usa ${owner.machine_id}/${owner.name}`);
    out.subdomain = sub;
  }

  if (type === 'https') {
    const mode = str(body.tlsMode, 20, 'service.tlsMode') || 'local';
    if (!['local', 'passthrough'].includes(mode)) throw bad('service.tlsMode debe ser "local" o "passthrough"');
    out.tlsMode = mode;
  }

  if (type === 'tcp') {
    const used = store.usedPorts();
    if (body.remotePort !== undefined && body.remotePort !== null && body.remotePort !== '') {
      const p = port(body.remotePort, 'service.remotePort');
      if (p < frps.tcpPortMin || p > frps.tcpPortMax) throw bad(`service.remotePort debe estar entre ${frps.tcpPortMin} y ${frps.tcpPortMax}`);
      if (used.has(p)) throw new HttpError(409, `el puerto remoto ${p} ya está asignado`);
      out.remotePort = p;
    } else {
      for (let p = frps.tcpPortMin; p <= frps.tcpPortMax; p++) {
        if (!used.has(p)) { out.remotePort = p; break; }
      }
      if (!out.remotePort) throw new HttpError(409, 'no quedan puertos TCP libres en el rango configurado');
    }
  }
  return out;
}

// ---------- URLs públicas ----------

function publicUrl(svc, frps) {
  if (svc.type === 'tcp') return `tcp://${frps.publicAddr}:${svc.remote_port}`;
  const host = `${svc.subdomain}.${frps.subdomainHost}`;
  if (svc.type === 'http') return `http://${host}${frps.publicHttpPort === 80 ? '' : ':' + frps.publicHttpPort}`;
  return `https://${host}${frps.publicHttpsPort === 443 ? '' : ':' + frps.publicHttpsPort}`;
}

// ---------- frpc.toml ----------

const q = (s) => JSON.stringify(String(s)); // cadena TOML básica (compatible con JSON escapado)

function frpcToml(machine, services, frps, token) {
  const lines = [
    `# frpc.toml generado por IIT Tunnel Hub`,
    `# Máquina: ${machine.name}${machine.client ? ' · Cliente: ' + machine.client : ''}`,
    `# Guarde este archivo junto a frpc y ejecute:  frpc -c frpc.toml`,
    ``,
    `serverAddr = ${q(frps.publicAddr)}`,
    `serverPort = ${frps.bindPort}`,
    `user = ${q(machine.id)}`,
    `loginFailExit = false`,
    `transport.heartbeatInterval = 15`,
    `transport.heartbeatTimeout = 45`,
  ];
  if (frps.authToken) lines.push(`auth.token = ${q(frps.authToken)}`);
  lines.push(`metadatas.token = ${q(token || 'PEGUE_AQUI_EL_TOKEN_DE_LA_MAQUINA')}`);

  for (const s of services) {
    lines.push('', `[[proxies]]`, `name = ${q(s.name)}`, `type = ${q(s.type)}`);
    if (s.type === 'https' && s.tls_mode === 'local') {
      lines.push(
        `subdomain = ${q(s.subdomain)}`,
        ``,
        `[proxies.plugin]`,
        `type = "https2http"`,
        `localAddr = ${q(`${s.local_ip}:${s.local_port}`)}`,
        `crtPath = "./certs/fullchain.pem"   # certificado para ${s.subdomain}.${frps.subdomainHost}`,
        `keyPath = "./certs/privkey.pem"`,
        `hostHeaderRewrite = ${q(s.local_ip)}`,
      );
    } else {
      lines.push(`localIP = ${q(s.local_ip)}`, `localPort = ${s.local_port}`);
      if (s.type === 'tcp') lines.push(`remotePort = ${s.remote_port}`);
      else lines.push(`subdomain = ${q(s.subdomain)}`);
    }
  }
  if (services.length === 0) lines.push('', '# Aún no hay servicios. Agréguelos desde el panel y vuelva a descargar este archivo.');
  return lines.join('\n') + '\n';
}

module.exports = {
  HttpError, bad, newToken, hashToken, tokenMatches, normalizeMachine, normalizeService, publicUrl, frpcToml, ID_RE,
};
