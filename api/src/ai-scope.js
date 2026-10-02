'use strict';
// Alcance de la IA por máquina: qué puede consultar y qué acciones puede proponer.
//
// Forma (columna machines.ai_scope, JSON):
// {
//   enabled: true,
//   context: "UPS APC 3 kVA de la sala técnica. Normal: carga < 60 %…",
//   ssh: { service: "ssh", user: "pi" },                       // servicio tcp de la máquina que apunta al puerto 22
//   http: [{ id, name, description, service, method, path, headers: {…secretos}, body, mode }],
//   commands: [{ id, name, description, command, mode }]
// }
//  - mode "read": la IA lo ejecuta sola · "action": queda pendiente hasta que un humano lo apruebe.
//  - Toda consulta HTTP que no sea GET es "action" obligatoriamente.
//  - Los valores de las cabeceras (tokens) nunca se envían a la IA ni se devuelven completos al panel.
//  - Parámetros: marcadores {nombre} en path/body; la IA solo puede dar valores que cumplan PARAM_VALUE_RE.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const HEADER_RE = /^[A-Za-z0-9-]{1,64}$/;
const PLACEHOLDER_RE = /\{([a-z_][a-z0-9_]{0,30})\}/g;
const PARAM_VALUE_RE = /^[A-Za-z0-9_.:@\-]{1,120}$/;
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const MASK = '********';
const MAX_OUTPUT = 6000;

const placeholders = (...texts) => [...new Set(texts.flatMap((t) => [...String(t || '').matchAll(PLACEHOLDER_RE)].map((m) => m[1])))];

function str(v, max, field, bad, { required = false, oneLine = true } = {}) {
  if (v === undefined || v === null) v = '';
  if (typeof v !== 'string') throw bad(`${field} debe ser texto`);
  const s = v.trim();
  if (required && !s) throw bad(`${field} es obligatorio`);
  if (s.length > max) throw bad(`${field} admite máximo ${max} caracteres`);
  if (oneLine && /[\r\n]/.test(s)) throw bad(`${field} no puede tener saltos de línea`);
  return s;
}

/**
 * Valida el alcance enviado desde el panel. `prev` es el alcance guardado: las cabeceras con valor
 * "********" conservan el valor anterior (el panel nunca recibe los secretos completos).
 */
function normalizeScope(body, services, prev, bad) {
  if (!body || typeof body !== 'object') throw bad('alcance inválido');
  const byName = new Map(services.map((s) => [s.name, s]));
  const out = {
    enabled: body.enabled === true,
    context: str(body.context, 3000, 'context', bad, { oneLine: false }),
    ssh: null,
    http: [],
    commands: [],
  };

  if (body.ssh && (body.ssh.service || body.ssh.user)) {
    const service = str(body.ssh.service, 20, 'ssh.service', bad, { required: true });
    const user = str(body.ssh.user, 32, 'ssh.user', bad, { required: true });
    const svc = byName.get(service);
    if (!svc || svc.type !== 'tcp') throw bad(`ssh.service debe ser un servicio tcp de la máquina ("${service}" no lo es)`);
    if (!/^[a-z_][a-z0-9_.-]{0,31}$/i.test(user)) throw bad('ssh.user no es un usuario válido');
    out.ssh = { service, user };
  }

  const ids = new Set();
  const uniqueId = (id, field) => {
    if (!ID_RE.test(id)) throw bad(`${field}: el id solo admite a-z, 0-9, _ y - (máx. 40)`);
    if (ids.has(id)) throw bad(`${field}: el id "${id}" está repetido`);
    ids.add(id);
  };

  const prevHttp = new Map((prev?.http || []).map((h) => [h.id, h]));
  if (body.http !== undefined && !Array.isArray(body.http)) throw bad('http debe ser una lista');
  for (const [i, h] of (body.http || []).entries()) {
    const f = `http[${i}]`;
    const id = str(h.id, 40, `${f}.id`, bad, { required: true });
    uniqueId(id, f);
    const service = str(h.service, 20, `${f}.service`, bad, { required: true });
    const svc = byName.get(service);
    if (!svc) throw bad(`${f}: la máquina no tiene el servicio "${service}"`);
    if (!['http', 'tcp'].includes(svc.type)) throw bad(`${f}: solo se admiten servicios http o tcp (el servicio "${service}" es ${svc.type})`);
    const method = str(h.method || 'GET', 7, `${f}.method`, bad).toUpperCase();
    if (!METHODS.includes(method)) throw bad(`${f}.method debe ser ${METHODS.join(', ')}`);
    const p = str(h.path, 500, `${f}.path`, bad, { required: true });
    if (!p.startsWith('/') || /\s/.test(p)) throw bad(`${f}.path debe empezar con / y no tener espacios`);
    const reqBody = str(h.body, 4000, `${f}.body`, bad, { oneLine: false });
    let mode = h.mode === 'read' ? 'read' : 'action';
    if (method !== 'GET') mode = 'action';

    const headers = {};
    const prevHeaders = prevHttp.get(id)?.headers || {};
    const entries = Object.entries(h.headers && typeof h.headers === 'object' ? h.headers : {});
    if (entries.length > 10) throw bad(`${f}: máximo 10 cabeceras`);
    for (const [k, v] of entries) {
      if (!HEADER_RE.test(k)) throw bad(`${f}: nombre de cabecera inválido "${k}"`);
      if (/^(host|content-length|connection|transfer-encoding)$/i.test(k)) throw bad(`${f}: la cabecera ${k} la define el hub`);
      const val = v === MASK ? prevHeaders[k] : v;
      if (typeof val !== 'string' || !val || val.length > 2000 || /[\r\n]/.test(val)) throw bad(`${f}: valor inválido para la cabecera ${k}`);
      headers[k] = val;
    }

    out.http.push({
      id, method, path: p, service, mode, headers, body: reqBody,
      name: str(h.name, 80, `${f}.name`, bad) || id,
      description: str(h.description, 500, `${f}.description`, bad, { oneLine: false }),
    });
  }

  if (body.commands !== undefined && !Array.isArray(body.commands)) throw bad('commands debe ser una lista');
  if ((body.commands || []).length && !out.ssh) throw bad('para usar comandos configure primero ssh (servicio y usuario)');
  for (const [i, c] of (body.commands || []).entries()) {
    const f = `commands[${i}]`;
    const id = str(c.id, 40, `${f}.id`, bad, { required: true });
    uniqueId(id, f);
    out.commands.push({
      id,
      name: str(c.name, 80, `${f}.name`, bad) || id,
      description: str(c.description, 500, `${f}.description`, bad, { oneLine: false }),
      command: str(c.command, 500, `${f}.command`, bad, { required: true }),
      mode: c.mode === 'read' ? 'read' : 'action',
    });
  }

  if (out.http.length + out.commands.length > 60) throw bad('máximo 60 consultas y comandos por máquina');
  return out;
}

/** Para el panel: igual al alcance pero con los secretos enmascarados. */
function scopeForPanel(scope) {
  const s = { enabled: false, context: '', ssh: null, http: [], commands: [], ...scope };
  return { ...s, http: s.http.map((h) => ({ ...h, headers: Object.fromEntries(Object.keys(h.headers || {}).map((k) => [k, MASK])) })) };
}

/** Para la IA: sin cabeceras, sin cuerpos ni comandos literales; solo lo que necesita para elegir. */
function scopeForAI(scope) {
  if (!scope?.enabled) return { habilitado: false };
  return {
    habilitado: true,
    contexto: scope.context || '',
    consultas_http: (scope.http || []).map((h) => ({
      id: h.id, nombre: h.name, descripcion: h.description, metodo: h.method, ruta: h.path,
      modo: h.mode === 'read' ? 'lectura' : 'accion (requiere aprobacion)',
      parametros: placeholders(h.path, h.body),
    })),
    comandos_ssh: (scope.commands || []).map((c) => ({
      id: c.id, nombre: c.name, descripcion: c.description,
      modo: c.mode === 'read' ? 'lectura' : 'accion (requiere aprobacion)',
    })),
  };
}

function fillParams(item, params, bad) {
  const needed = placeholders(item.path, item.body);
  const values = {};
  for (const name of needed) {
    const v = params?.[name];
    if (typeof v !== 'string' || !PARAM_VALUE_RE.test(v)) {
      throw bad(`el parámetro "${name}" es obligatorio y solo admite letras, números y . _ : @ - (máx. 120)`);
    }
    values[name] = v;
  }
  const extra = Object.keys(params || {}).filter((k) => !needed.includes(k));
  if (extra.length) throw bad(`parámetros no definidos en el alcance: ${extra.join(', ')}`);
  const reqPath = item.path.replace(PLACEHOLDER_RE, (_, n) => encodeURIComponent(values[n]));
  const reqBody = (item.body || '').replace(PLACEHOLDER_RE, (_, n) => JSON.stringify(values[n]).slice(1, -1));
  return { values, path: reqPath, body: reqBody };
}

function truncate(text) {
  const t = String(text ?? '');
  return t.length > MAX_OUTPUT ? `${t.slice(0, MAX_OUTPUT)}\n…[recortado: ${t.length - MAX_OUTPUT} caracteres más]` : t;
}

// ---------- ejecución ----------

/** Llama a una consulta HTTP del alcance a través de frps (que corre en el mismo servidor que el hub). */
function runHttp({ item, service, filled, frps, localAddr }) {
  let port; let host;
  if (service.type === 'http') {
    port = frps.vhostHttpPort;
    host = `${service.subdomain}.${frps.subdomainHost}`;
  } else {
    port = service.remote_port;
    host = `${localAddr}:${port}`;
  }
  const headers = { ...item.headers, host, 'user-agent': 'iit-tunnel-hub-ia' };
  if (filled.body) {
    headers['content-type'] = headers['content-type'] || headers['Content-Type'] || 'application/json';
    headers['content-length'] = Buffer.byteLength(filled.body);
  }
  return new Promise((resolve) => {
    const req = http.request({ host: localAddr, port, method: item.method, path: filled.path, headers, timeout: 10000 }, (res) => {
      const chunks = []; let size = 0;
      res.on('data', (c) => { size += c.length; if (size <= 64 * 1024) chunks.push(c); });
      res.on('end', () => resolve({ ok: res.statusCode < 400, status: res.statusCode, output: truncate(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('timeout', () => req.destroy(new Error('sin respuesta en 10 s')));
    req.on('error', (e) => resolve({ ok: false, status: 0, output: `error de conexión: ${e.message}` }));
    if (filled.body) req.write(filled.body);
    req.end();
  });
}

class SshKey {
  constructor(keyPath) {
    this.keyPath = keyPath;
    this.knownHosts = path.join(path.dirname(keyPath), 'ia_known_hosts');
  }

  async ensure() {
    if (fs.existsSync(this.keyPath)) return;
    fs.mkdirSync(path.dirname(this.keyPath), { recursive: true });
    await new Promise((resolve, reject) => {
      const p = spawn('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'iit-tunnel-hub-ia', '-f', this.keyPath, '-q']);
      p.on('error', (e) => reject(new Error(`no se pudo ejecutar ssh-keygen (${e.message}). Instale el cliente OpenSSH.`)));
      p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ssh-keygen terminó con código ${code}`))));
    });
    // En Windows, OpenSSH rechaza llaves privadas legibles por otros usuarios ("UNPROTECTED PRIVATE KEY FILE")
    if (process.platform === 'win32') {
      await new Promise((resolve) => {
        const p = spawn('icacls', [this.keyPath, '/inheritance:r', '/grant:r', `${os.userInfo().username}:F`]);
        p.on('error', resolve);
        p.on('exit', resolve);
      });
    }
  }

  publicKey() {
    try { return fs.readFileSync(`${this.keyPath}.pub`, 'utf8').trim(); } catch { return null; }
  }
}

/** Ejecuta un comando de la lista blanca por SSH, a través del puerto tcp que frps publica para la máquina. */
function runSsh({ command, user, port, localAddr, key }) {
  return new Promise((resolve) => {
    const args = [
      '-i', key.keyPath, '-p', String(port),
      '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new',
      '-o', `UserKnownHostsFile=${key.knownHosts}`, '-o', 'ConnectTimeout=8', '-o', 'LogLevel=ERROR',
      `${user}@${localAddr}`, '--', command,
    ];
    let p;
    try { p = spawn('ssh', args); } catch (e) { return resolve({ ok: false, exitCode: -1, output: `no se pudo ejecutar ssh: ${e.message}` }); }
    const out = []; const err = []; let size = 0;
    const take = (arr) => (c) => { size += c.length; if (size <= 64 * 1024) arr.push(c); };
    p.stdout.on('data', take(out));
    p.stderr.on('data', take(err));
    const timer = setTimeout(() => p.kill('SIGKILL'), 20000);
    p.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, exitCode: -1, output: `no se pudo ejecutar ssh: ${e.message}` }); });
    p.on('close', (code, signal) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(out).toString('utf8');
      const stderr = Buffer.concat(err).toString('utf8');
      const text = signal ? `${stdout}\n[cancelado: más de 20 s]` : stdout + (stderr ? `\n[stderr]\n${stderr}` : '');
      resolve({ ok: code === 0, exitCode: code, output: truncate(text.trim() || '(sin salida)') });
    });
  });
}

module.exports = { normalizeScope, scopeForPanel, scopeForAI, fillParams, runHttp, runSsh, SshKey, placeholders, MASK };
