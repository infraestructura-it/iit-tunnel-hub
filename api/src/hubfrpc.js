'use strict';
// frpc propio del hub: entra a frps como el usuario interno "_hub" y abre, solo en 127.0.0.1, los
// servicios privados que el hub necesita consultar (hoy: SNMP por sudp). Nadie más puede usar ese
// usuario: su token vive solo en memoria y en el archivo de configuración (permisos 600).
//
// El hub escribe data/hub-frpc.toml, arranca frpc y, cuando cambian los equipos, recarga con la API
// de administración de frpc (webServer en 127.0.0.1) sin cortar las demás consultas.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');

const HUB_USER = '_hub';
const q = (s) => JSON.stringify(String(s));

/** Busca frpc: HUB_FRPC_PATH, carpeta frp del proyecto, .frp de pruebas, instalación Linux o PATH. */
function findFrpc(root, explicit) {
  const exe = process.platform === 'win32' ? 'frpc.exe' : 'frpc';
  const candidates = [];
  if (explicit) candidates.push(explicit);
  candidates.push(path.join(root, 'frp', exe));
  try {
    for (const d of fs.readdirSync(path.join(root, '.frp'))) candidates.push(path.join(root, '.frp', d, exe));
  } catch {}
  if (process.platform !== 'win32') candidates.push('/usr/local/bin/frpc', '/usr/local/bin/iit-frpc', '/usr/bin/frpc');
  for (const c of candidates) { try { fs.accessSync(c, fs.constants.X_OK); return c; } catch {} }
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    const c = path.join(dir, exe);
    try { fs.accessSync(c, fs.constants.X_OK); return c; } catch {}
  }
  return null;
}

class HubFrpc {
  /**
   * @param o.config      configuración del hub (frps.bindPort, frps.authToken, ai.frpsLocalAddr, dbPath)
   * @param o.visitors    () => [{ name, type: 'sudp'|'stcp', serverUser, serverName, secretKey, bindPort }]
   */
  constructor({ config, visitors, root, log = console }) {
    this.config = config;
    this.visitors = visitors;
    this.log = log;
    this.token = crypto.randomBytes(32).toString('base64url');
    this.adminUser = 'hub';
    this.adminPass = crypto.randomBytes(16).toString('base64url');
    this.adminPort = config.hubFrpcAdminPort;
    const dir = path.dirname(path.resolve(config.dbPath));
    this.confPath = path.join(dir, 'hub-frpc.toml');
    this.logPath = path.join(dir, 'hub-frpc.log');
    this.pidPath = path.join(dir, 'hub-frpc.pid');
    this.bin = findFrpc(root, config.hubFrpcPath);
    this.proc = null;
    this.stopped = false;
    this.restarts = 0;
    this.lastError = this.bin ? null : 'no se encontró frpc en el servidor (defina HUB_FRPC_PATH o ejecute frp.ps1)';
    this.lastLoginAt = null;
    this.startedAt = null;
    this.syncTimer = null;
  }

  /** ¿El token corresponde al frpc del hub? (lo usa el plugin en Login) */
  tokenMatches(t) {
    const a = Buffer.from(String(t || '')); const b = Buffer.from(this.token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  toml() {
    const f = this.config.frps;
    const lines = [
      '# Generado por IIT Tunnel Hub: frpc interno del hub. No editar (se reescribe).',
      `serverAddr = ${q(this.config.ai.frpsLocalAddr || '127.0.0.1')}`,
      `serverPort = ${f.bindPort}`,
      `user = ${q(HUB_USER)}`,
      'loginFailExit = false',
      'transport.heartbeatInterval = 15',
      'transport.heartbeatTimeout = 45',
      `metadatas.token = ${q(this.token)}`,
      'webServer.addr = "127.0.0.1"',
      `webServer.port = ${this.adminPort}`,
      `webServer.user = ${q(this.adminUser)}`,
      `webServer.password = ${q(this.adminPass)}`,
      `log.to = ${q(this.logPath)}`,
      'log.level = "info"',
      'log.maxDays = 2',
    ];
    if (f.authToken) lines.push(`auth.token = ${q(f.authToken)}`);
    for (const v of this.visitors()) {
      lines.push('', '[[visitors]]',
        `name = ${q(v.name)}`, `type = ${q(v.type)}`,
        `serverUser = ${q(v.serverUser)}`, `serverName = ${q(v.serverName)}`,
        `secretKey = ${q(v.secretKey)}`, 'bindAddr = "127.0.0.1"', `bindPort = ${v.bindPort}`);
    }
    return lines.join('\n') + '\n';
  }

  #write() {
    fs.writeFileSync(this.confPath, this.toml(), { mode: 0o600 });
  }

  /** Si el hub anterior terminó sin cerrar su frpc, ese proceso ocupa los puertos: se detiene. */
  #killStale() {
    let pid;
    try { pid = Number(fs.readFileSync(this.pidPath, 'utf8')); } catch { return; }
    if (!pid || pid === this.proc?.pid) return;
    try {
      if (process.platform === 'win32') {
        const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
        if (!/frpc/i.test(out)) return;
      } else {
        const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
        if (!cmd.includes('hub-frpc.toml')) return;
      }
      process.kill(pid);
    } catch { /* ya no existe */ }
  }

  start() {
    if (!this.bin || this.stopped) return;
    if (!this.proc) this.#killStale();
    try { this.#write(); } catch (e) { this.lastError = `no se pudo escribir ${this.confPath}: ${e.message}`; return; }
    const p = spawn(this.bin, ['-c', this.confPath], { stdio: 'ignore', windowsHide: true });
    this.proc = p;
    this.startedAt = Date.now();
    try { fs.writeFileSync(this.pidPath, String(p.pid)); } catch {}
    p.on('error', (e) => { this.lastError = `frpc del hub: ${e.message}`; });
    p.on('exit', (code) => {
      if (this.proc === p) this.proc = null;
      if (this.stopped) return;
      this.lastError = `frpc del hub terminó (código ${code}); se reinicia`;
      this.restarts++;
      setTimeout(() => this.start(), Math.min(30000, 2000 * this.restarts)).unref?.();
    });
  }

  stop() {
    this.stopped = true;
    try { this.proc?.kill(); } catch {}
  }

  /** Aplica cambios de visitantes: reescribe la configuración y recarga (con pausa para agrupar cambios). */
  sync() {
    clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => this.#reload(), 300);
    this.syncTimer.unref?.();
  }

  async #reload() {
    if (!this.bin) return;
    try { this.#write(); } catch (e) { this.lastError = e.message; return; }
    if (!this.proc) return this.start();
    try {
      const res = await fetch(`http://127.0.0.1:${this.adminPort}/api/reload`, {
        headers: { authorization: 'Basic ' + Buffer.from(`${this.adminUser}:${this.adminPass}`).toString('base64') },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    } catch (e) {
      // Si la API no responde, se reinicia el proceso con la configuración nueva
      this.lastError = `recarga del frpc del hub falló (${e.message}); se reinicia`;
      try { this.proc?.kill(); } catch {}
    }
  }

  /** Últimas líneas del registro, para la página de estado. */
  logTail(n = 8) {
    try { return fs.readFileSync(this.logPath, 'utf8').trim().split('\n').slice(-n); } catch { return []; }
  }

  status() {
    return {
      available: !!this.bin, binary: this.bin, running: !!this.proc, pid: this.proc?.pid ?? null,
      restarts: this.restarts, lastError: this.lastError, lastLoginAt: this.lastLoginAt,
      visitors: this.visitors().length, adminPort: this.adminPort,
    };
  }
}

module.exports = { HubFrpc, HUB_USER, findFrpc };
