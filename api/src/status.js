'use strict';
// Estado del propio hub: proceso, base de datos, disco, respaldos, frps, plugin, alertas, Telegram e IA,
// más advertencias de configuración. /api/status (admin) da el detalle; /api/health el resumen público.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const fileSize = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };

function diskInfo(dir) {
  try {
    const s = fs.statfsSync(dir);
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    return { total, free, usedPct: total ? Math.round(((total - free) / total) * 100) : null };
  } catch { return null; }
}

/** ¿La base acepta escrituras? (bloqueo inmediato y vuelta atrás, sin cambiar nada) */
function dbWritable(store) {
  try { store.db.exec('BEGIN IMMEDIATE; ROLLBACK;'); return true; }
  catch { try { store.db.exec('ROLLBACK'); } catch {} return false; }
}

async function frpsProbe(frps) {
  const t = Date.now();
  try {
    const info = await frps.get('/api/serverinfo');
    return { reachable: true, latencyMs: Date.now() - t, version: info.version ?? null, info };
  } catch (e) {
    const code = e.cause?.code || (e.name === 'TimeoutError' ? 'TIMEOUT' : null);
    return { reachable: false, latencyMs: null, error: code ? `no responde (${code})` : e.message };
  }
}

const count = (store, table, where = '') => {
  try { return store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} ${where}`).get().n; } catch { return null; }
};

/**
 * Resumen para monitores externos (Uptime Kuma, etc.): 503 si la base no escribe o frps no responde.
 */
async function health({ store, frps, backups, version }) {
  const db = dbWritable(store);
  const f = await frpsProbe(frps);
  const b = backups.settings();
  const last = backups.state().lastOkAt || 0;
  const backupOk = !b.enabled || (Date.now() / 1000 - last) < 26 * 3600;
  const ok = db && f.reachable;
  return {
    code: ok ? 200 : 503,
    body: { ok, status: !ok ? 'falla' : backupOk ? 'ok' : 'degradado', version, checks: { db, frps: f.reachable, backup: backupOk } },
  };
}

async function gather({ config, store, frps, monitor, bot, ai, backups, stats, version, pluginListening }) {
  const now = Date.now();
  const f = await frpsProbe(frps);
  const live = await frps.status();
  const dbDir = path.dirname(path.resolve(config.dbPath));
  const disk = diskInfo(dbDir);
  const backupDisk = path.resolve(config.backupDir).startsWith(dbDir) ? disk : diskInfo(config.backupDir);
  const bs = backups.settings();
  const bstate = backups.state();
  const list = backups.list();
  const alertSettings = require('./alerts').loadSettings(store);
  const aiS = ai.settings();
  const tgEnabled = !!(aiS.telegramBot && alertSettings.telegram.botToken && alertSettings.telegram.chatId);
  const writable = dbWritable(store);
  const sessions = count(store, 'sessions', `WHERE expires_at > ${Math.floor(now / 1000)}`);
  const users = store.listUsers();

  const status = {
    at: Math.floor(now / 1000),
    hub: {
      version,
      startedAt: Math.floor(stats.startedAt / 1000),
      uptimeSeconds: Math.floor(process.uptime()),
      node: process.version,
      platform: `${os.platform()} ${os.arch()}`,
      hostname: os.hostname(),
      pid: process.pid,
      memory: { rss: process.memoryUsage().rss, heapUsed: process.memoryUsage().heapUsed },
      system: { load: os.platform() === 'win32' ? null : os.loadavg().map((x) => Math.round(x * 100) / 100), cpus: os.cpus().length, totalMem: os.totalmem(), freeMem: os.freemem() },
      timezone: config.timezone,
      panel: `${config.host}:${config.port}`,
    },
    db: {
      path: path.resolve(config.dbPath),
      size: fileSize(config.dbPath),
      walSize: fileSize(config.dbPath + '-wal'),
      writable,
      counts: {
        clients: count(store, 'clients'), machines: count(store, 'machines'), services: count(store, 'services'),
        users: users.length, sessions, events: count(store, 'events'), conversations: count(store, 'ai_conversations'),
      },
    },
    disk: disk ? { dir: dbDir, ...disk } : null,
    backups: {
      ...bs,
      dir: path.resolve(config.backupDir),
      encrypted: !!config.backupKey,
      count: list.length,
      totalSize: list.reduce((n, b) => n + b.size, 0),
      last: bstate.last || null,
      lastOkAt: bstate.lastOkAt || null,
      nextAt: backups.nextAt() ? Math.floor(backups.nextAt() / 1000) : null,
      running: !!backups.running,
      disk: backupDisk ? { free: backupDisk.free, usedPct: backupDisk.usedPct } : null,
    },
    frps: {
      reachable: f.reachable,
      latencyMs: f.latencyMs,
      error: f.error || null,
      version: f.version || null,
      apiUrl: config.frps.apiUrl,
      publicAddr: config.frps.publicAddr,
      bindPort: config.frps.bindPort,
      clientsOnline: live.clients.size,
      proxies: live.proxies.size,
      authToken: !!config.frps.authToken,
    },
    plugin: { listening: pluginListening(), address: `${config.pluginHost}:${config.pluginPort}`, ...stats.plugin },
    api: { ...stats.api },
    monitor: {
      intervalSeconds: config.alertCheckSeconds,
      lastCheckAt: monitor.lastCheckAt,
      lastError: monitor.lastError,
      frpsDown: monitor.server.down,
      channels: { telegram: !!(alertSettings.telegram.botToken && alertSettings.telegram.chatId), webhooks: alertSettings.webhooks.length },
      graceSeconds: alertSettings.graceSeconds,
    },
    telegram: { enabled: tgEnabled, lastOkAt: bot.lastOkAt ? Math.floor(bot.lastOkAt / 1000) : null, lastError: tgEnabled ? bot.lastError || null : null },
    ai: { enabled: aiS.enabled, ready: ai.ready(), model: aiS.model, pending: ai.pending().length },
  };
  status.warnings = warnings(status, { config, users });
  status.overall = status.warnings.some((w) => w.level === 'bad') ? 'falla' : status.warnings.some((w) => w.level === 'warn') ? 'atención' : 'ok';
  return status;
}

/** Advertencias legibles. level: bad (algo no funciona) · warn (riesgo) · info (sugerencia) */
function warnings(s, { config, users }) {
  const out = [];
  const add = (level, text) => out.push({ level, text });
  const nowS = s.at;

  if (!s.db.writable) add('bad', 'La base de datos no acepta escrituras (bloqueada o disco lleno).');
  if (!s.frps.reachable) add('bad', `frps no responde: ${s.frps.error}. Las máquinas no pueden conectarse.`);
  if (!s.plugin.listening) add('bad', `El plugin de frps no está escuchando en ${s.plugin.address}: frps rechazará todos los ingresos.`);
  if (s.monitor.lastCheckAt && nowS - s.monitor.lastCheckAt > Math.max(60, s.monitor.intervalSeconds * 4)) add('bad', 'El monitor de alertas no corre desde hace rato.');
  if (s.monitor.lastError) add('warn', `El monitor de alertas tuvo un error: ${s.monitor.lastError}`);

  if (s.disk && (s.disk.usedPct >= 95 || s.disk.free < 512 * 1024 * 1024)) add('bad', `Disco casi lleno (${s.disk.usedPct}% usado).`);
  else if (s.disk && s.disk.usedPct >= 85) add('warn', `Disco al ${s.disk.usedPct}%.`);
  if (s.db.walSize > 64 * 1024 * 1024) add('warn', 'El archivo -wal de la base pasa de 64 MB.');

  const b = s.backups;
  if (!b.enabled) add('warn', 'Los respaldos automáticos están apagados.');
  else if (b.last && !b.last.ok) add('bad', `El último respaldo falló: ${b.last.error}`);
  else if (!b.lastOkAt || nowS - b.lastOkAt > 26 * 3600) add('warn', 'No hay un respaldo correcto en las últimas 26 horas.');
  if (b.count && path.dirname(b.dir) === path.dirname(s.db.path)) add('info', 'Los respaldos están en el mismo disco que la base: cópielos también a otro lugar (NAS, nube) o use BACKUP_DIR.');
  if (b.count && !b.encrypted) add('info', 'Los respaldos no están cifrados (contienen claves de servicios y de la IA). Defina BACKUP_KEY para cifrarlos.');

  if (!users.length) add('warn', 'Aún no hay usuarios: cree el administrador desde el panel.');
  const admins = users.filter((u) => u.role === 'admin' && u.enabled);
  const no2fa = admins.filter((u) => !u.totp_enabled).map((u) => u.username);
  if (no2fa.length) add('warn', `Administradores sin verificación en dos pasos: ${no2fa.join(', ')}.`);
  if (/^(CAMBIAR|prueba-local)/i.test(config.adminToken)) add('warn', 'El ADMIN_TOKEN es el de ejemplo o el de pruebas: cámbielo en producción.');
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(config.host);
  if (!loopback && !config.cookieSecure) add('warn', `El panel escucha en ${config.host} sin COOKIE_SECURE=1: publíquelo solo detrás de HTTPS.`);
  if (!s.frps.authToken) add('warn', 'FRP_AUTH_TOKEN está vacío: cualquiera puede intentar hablar con frps (el hub igual valida cada máquina).');
  if (!s.monitor.channels.telegram && !s.monitor.channels.webhooks) add('warn', 'No hay canales de alertas: nadie se enterará si una máquina cae.');
  if (s.telegram.enabled && s.telegram.lastError) add('warn', `Bot de Telegram con error: ${s.telegram.lastError}`);
  if (s.api.errors > 0) add('info', `${s.api.errors} error(es) interno(s) de la API desde el arranque${s.api.lastError ? ` · último: ${s.api.lastError.message}` : ''}.`);
  if (s.plugin.errors > 0) add('warn', `${s.plugin.errors} error(es) del plugin desde el arranque (frps rechazó esas operaciones).`);
  return out;
}

module.exports = { gather, health, dbWritable };
