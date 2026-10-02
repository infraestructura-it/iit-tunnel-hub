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
/** Clave de un servicio privado (stcp). La comparten frps (la inyecta el hub) y los visitantes autorizados. */
function newSecret() { return crypto.randomBytes(24).toString('base64url'); }
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
 *  - stcp:  servicio PRIVADO (SSH, RDP, VNC…): frps no abre ningún puerto; solo entran las máquinas
 *           visitantes autorizadas en el panel. La clave la genera el hub y la inyecta en NewProxy.
 */
function normalizeService(body, machineId, store, frps) {
  const name = str(body.name, 20, 'service.name').toLowerCase();
  if (!SVC_RE.test(name)) throw bad('el nombre del servicio solo admite a-z, 0-9 y guiones (máx. 20)');
  if (store.getService(machineId, name)) throw new HttpError(409, `la máquina ya tiene un servicio "${name}"`);

  const type = str(body.type, 10, 'service.type').toLowerCase() || 'http';
  if (!['http', 'https', 'tcp', 'stcp'].includes(type)) throw bad('service.type debe ser http, https, tcp o stcp');

  const localIp = str(body.localIp, 253, 'service.localIp') || '127.0.0.1';
  if (!IPV4_RE.test(localIp) && !HOST_RE.test(localIp)) throw bad('service.localIp no es una IP o host válido');
  const localPort = port(body.localPort, 'service.localPort');

  const out = { name, type, localIp, localPort, subdomain: null, remotePort: null, tlsMode: null, secret: null };
  if (type === 'stcp') out.secret = newSecret();

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
  if (svc.type === 'stcp') return null; // privado: no tiene dirección pública
  if (svc.type === 'tcp') return `tcp://${frps.publicAddr}:${svc.remote_port}`;
  const host = `${svc.subdomain}.${frps.subdomainHost}`;
  if (svc.type === 'http') return `http://${host}${frps.publicHttpPort === 80 ? '' : ':' + frps.publicHttpPort}`;
  return `https://${host}${frps.publicHttpsPort === 443 ? '' : ':' + frps.publicHttpsPort}`;
}

// ---------- frpc.toml ----------

const q = (s) => JSON.stringify(String(s)); // cadena TOML básica (compatible con JSON escapado)
// Rutas: cadena literal TOML (comillas simples) para no escapar las barras invertidas de Windows
const tq = (s) => (String(s).includes("'") ? q(s) : `'${s}'`);

const HOSTNAME_RE = /^(?=.{1,253}$)[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
/** Valida la dirección del servidor que se escribirá en la configuración de una máquina. */
function normalizeServerAddr(v, fallback) {
  if (v === undefined || v === null || String(v).trim() === '') return fallback;
  const s = String(v).trim();
  if (!IPV4_RE.test(s) && !HOSTNAME_RE.test(s)) throw bad('serverAddr debe ser una IP o un nombre de host válido');
  return s;
}

/**
 * opts.serverAddr: dirección del servidor para esta máquina (por defecto FRPS_PUBLIC_ADDR)
 * opts.certDir:    carpeta de certificados para https con TLS local (por defecto ./certs)
 * opts.extra:      líneas adicionales de configuración global (p. ej. log.to)
 * opts.accessFile: archivo de accesos privados que frpc incluye (por defecto ./accesos-<id>.toml,
 *                  relativo a la carpeta desde donde se ejecuta frpc). Si no existe, frpc lo ignora.
 */
function frpcToml(machine, services, frps, token, opts = {}) {
  const certDir = opts.certDir || './certs';
  const lines = [
    `# frpc.toml generado por IIT Tunnel Hub`,
    `# Máquina: ${machine.name}${machine.client ? ' · Cliente: ' + machine.client : ''}`,
    `# Guarde este archivo junto a frpc y ejecute:  frpc -c frpc.toml`,
    ``,
    `serverAddr = ${q(opts.serverAddr || frps.publicAddr)}`,
    `serverPort = ${frps.bindPort}`,
    `user = ${q(machine.id)}`,
    `loginFailExit = false`,
    `transport.heartbeatInterval = 15`,
    `transport.heartbeatTimeout = 45`,
  ];
  if (frps.authToken) lines.push(`auth.token = ${q(frps.authToken)}`);
  lines.push(`metadatas.token = ${q(token || 'PEGUE_AQUI_EL_TOKEN_DE_LA_MAQUINA')}`);
  for (const l of opts.extra || []) lines.push(l);
  // Accesos a servicios privados de otras máquinas: van en un archivo aparte que se cambia sin tocar el token
  lines.push(`includes = [${tq(opts.accessFile || accessFileName(machine.id, './'))}]`);

  for (const s of services) {
    lines.push('', `[[proxies]]`, `name = ${q(s.name)}`, `type = ${q(s.type)}`);
    if (s.type === 'https' && s.tls_mode === 'local') {
      lines.push(
        `subdomain = ${q(s.subdomain)}`,
        ``,
        `[proxies.plugin]`,
        `type = "https2http"`,
        `localAddr = ${q(`${s.local_ip}:${s.local_port}`)}`,
        `crtPath = ${tq(certDir + '/fullchain.pem')}   # certificado para ${s.subdomain}.${frps.subdomainHost}`,
        `keyPath = ${tq(certDir + '/privkey.pem')}`,
        `hostHeaderRewrite = ${q(s.local_ip)}`,
      );
    } else {
      lines.push(`localIP = ${q(s.local_ip)}`, `localPort = ${s.local_port}`);
      if (s.type === 'tcp') lines.push(`remotePort = ${s.remote_port}`);
      else if (s.type === 'stcp') lines.push(`# Privado: sin puerto público. La clave y los visitantes permitidos los asigna el hub.`);
      else lines.push(`subdomain = ${q(s.subdomain)}`);
    }
  }
  if (services.length === 0) lines.push('', '# Aún no hay servicios. Agréguelos desde el panel y vuelva a descargar este archivo.');
  return lines.join('\n') + '\n';
}

// ---------- accesos a servicios privados (stcp) ----------

const ACCESS_PORT_MIN = 6000;
const ACCESS_PORT_MAX = 6999;

function accessFileName(machineId, dir = '') { return `${dir}accesos-${machineId}.toml`; }

/** Puertos sugeridos según el puerto local del servicio, para que sea fácil reconocerlos. */
function suggestedPort(localPort) {
  if (localPort === 22) return 6022;
  if (localPort === 3389) return 6389;
  if (localPort === 5900) return 6900;
  return ACCESS_PORT_MIN + 100;
}

/**
 * Valida un acceso nuevo: la máquina `visitorId` podrá abrir el servicio privado `service`
 * en 127.0.0.1:<bindPort> de su propio equipo.
 */
function normalizeAccess(body, store) {
  const ownerId = str(body.machine, 32, 'machine');
  const svcName = str(body.service, 20, 'service');
  const visitorId = str(body.visitor, 32, 'visitor');
  const owner = store.getMachine(ownerId);
  if (!owner) throw new HttpError(404, `no existe la máquina "${ownerId}"`);
  const svc = store.getService(ownerId, svcName);
  if (!svc) throw new HttpError(404, `la máquina ${ownerId} no tiene el servicio "${svcName}"`);
  if (svc.type !== 'stcp') throw bad(`el servicio "${svcName}" no es privado (stcp): sus accesos no se administran aquí`);
  const visitor = store.getMachine(visitorId);
  if (!visitor) throw new HttpError(404, `no existe la máquina visitante "${visitorId}"`);
  if (visitorId === ownerId) throw bad('la máquina visitante debe ser otra (desde la misma máquina use el servicio local)');

  const mine = store.accessOfVisitor(visitorId);
  if (mine.some((a) => a.service_id === svc.id)) throw new HttpError(409, `${visitorId} ya tiene acceso a ${ownerId}/${svcName}`);
  const used = new Set(mine.map((a) => a.bind_port));
  let bindPort;
  if (body.bindPort !== undefined && body.bindPort !== null && body.bindPort !== '') {
    bindPort = port(body.bindPort, 'bindPort');
    if (bindPort < 1024) throw bad('bindPort debe ser 1024 o mayor (los puertos bajos requieren administrador)');
    if (used.has(bindPort)) throw new HttpError(409, `${visitorId} ya usa el puerto ${bindPort} para otro acceso`);
  } else {
    for (let p = suggestedPort(svc.local_port); p <= ACCESS_PORT_MAX && !bindPort; p++) if (!used.has(p)) bindPort = p;
    for (let p = ACCESS_PORT_MIN; p <= ACCESS_PORT_MAX && !bindPort; p++) if (!used.has(p)) bindPort = p;
    if (!bindPort) throw new HttpError(409, 'no quedan puertos libres para accesos en esta máquina');
  }
  return { svc, owner, visitor, bindPort };
}

/** Archivo de accesos de una máquina visitante: un [[visitors]] por servicio privado autorizado. */
function accessToml(visitor, grants) {
  const lines = [
    `# Accesos privados de ${visitor.name} (${visitor.id}) — generado por IIT Tunnel Hub ${new Date().toISOString()}`,
    `# Va en la misma carpeta que el frpc.toml de esta máquina, con el nombre ${accessFileName(visitor.id)}.`,
    `# Después de reemplazarlo, reinicie frpc. Contiene claves de acceso: no lo comparta.`,
  ];
  for (const a of grants) {
    lines.push('',
      `# ${a.owner_id}/${a.service} → 127.0.0.1:${a.bind_port} en este equipo (puerto ${a.local_port} en la máquina remota)`,
      `[[visitors]]`,
      `name = ${q(`acceso-${a.owner_id}-${a.service}`)}`,
      `type = "stcp"`,
      `serverUser = ${q(a.owner_id)}`,
      `serverName = ${q(a.service)}`,
      `secretKey = ${q(a.secret)}`,
      `bindAddr = "127.0.0.1"`,
      `bindPort = ${a.bind_port}`);
  }
  if (!grants.length) lines.push('', '# Esta máquina no tiene accesos a servicios privados.');
  return lines.join('\n') + '\n';
}

/** Archivo .rdp para Escritorio remoto apuntando al puerto local del visitante. */
function rdpFile(a, user = '') {
  const l = [
    `full address:s:127.0.0.1:${a.bind_port}`,
    'prompt for credentials:i:1',
    'administrative session:i:0',
    'screen mode id:i:2',
    'authentication level:i:2',
  ];
  if (user) l.push(`username:s:${user}`);
  return l.join('\r\n') + '\r\n';
}

module.exports = {
  normalizeAccess, accessToml, accessFileName, rdpFile, newSecret, suggestedPort,
  HttpError, bad, newToken, hashToken, tokenMatches, normalizeMachine, normalizeService, publicUrl, frpcToml, normalizeServerAddr, ID_RE,
};
