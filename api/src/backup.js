'use strict';
// Respaldos de hub.db: copia consistente en caliente (VACUUM INTO), sin sesiones, verificada,
// opcionalmente cifrada con BACKUP_KEY (AES-256-GCM), programada a diario y con retención.
//
// Restaurar: detener el hub, reemplazar hub.db por el respaldo (descifrado si es .enc), borrar
// hub.db-wal y hub.db-shm, y arrancar. Ver `node api/src/respaldo.js` para descifrar y verificar.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const SETTINGS_KEY = 'backup';
const STATE_KEY = 'backup_state';
const DEFAULTS = { enabled: true, hour: 3, keep: 14 };
const NAME_RE = /^hub-(\d{8}-\d{6,9})-(auto|manual)\.db(\.enc)?$/;
const MAGIC = Buffer.from('IITRESP1');

// ---------- cifrado ----------

function encrypt(plain, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(String(passphrase), salt, 32);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([MAGIC, salt, iv, c.getAuthTag(), data]);
}

function decrypt(buf, passphrase) {
  if (!buf.subarray(0, 8).equals(MAGIC)) throw new Error('no es un respaldo cifrado de IIT Tunnel Hub');
  const salt = buf.subarray(8, 24);
  const iv = buf.subarray(24, 36);
  const tag = buf.subarray(36, 52);
  const key = crypto.scryptSync(String(passphrase), salt, 32);
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  try { return Buffer.concat([d.update(buf.subarray(52)), d.final()]); }
  catch { throw new Error('clave incorrecta o archivo dañado'); }
}

/** Revisa que un archivo SQLite sea una base del hub íntegra. Devuelve un resumen. */
function inspect(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const check = db.prepare('PRAGMA quick_check').get();
    const ok = Object.values(check)[0] === 'ok';
    const count = (t) => { try { return db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n; } catch { return null; } };
    return { ok, check: Object.values(check)[0], machines: count('machines'), users: count('users'), services: count('services'), events: count('events') };
  } finally { db.close(); }
}

// ---------- hora local (zona horaria configurada) ----------

/** Último instante (ms) en que fueron las `hour`:00 en la zona horaria dada, no posterior a `now`. */
function lastSlot(now, hour, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(now)).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  const offset = Math.round((asUtc - now) / 60000) * 60000; // diferencia de la zona con UTC
  let slot = Date.UTC(+parts.year, +parts.month - 1, +parts.day, hour) - offset;
  if (slot > now) slot -= 86400000;
  return slot;
}

// AAAAMMDD-HHMMSSmmm (UTC, con milisegundos para que dos respaldos seguidos no se pisen)
const stamp = (d = new Date()) => d.toISOString().replace(/[-:.]/g, '').replace('T', '-').slice(0, 18);

class BackupService {
  /**
   * @param o.store     Store (usa store.db para VACUUM INTO)
   * @param o.dbPath    ruta de hub.db
   * @param o.dir       carpeta de respaldos
   * @param o.key       frase para cifrar (BACKUP_KEY); vacío = sin cifrar
   * @param o.timezone  zona horaria de la hora programada
   * @param o.notify    async (alerta) => void   para avisar si un respaldo falla
   */
  constructor({ store, dbPath, dir, key = '', timezone = 'America/Bogota', notify = null, log = console }) {
    Object.assign(this, { store, dbPath, dir, key, timezone, notify, log });
    this.timer = null;
    this.running = null;
  }

  settings() {
    const s = this.store.getSetting(SETTINGS_KEY, {}) || {};
    return {
      enabled: s.enabled !== undefined ? !!s.enabled : DEFAULTS.enabled,
      hour: Number.isInteger(s.hour) ? s.hour : DEFAULTS.hour,
      keep: Number.isInteger(s.keep) ? s.keep : DEFAULTS.keep,
    };
  }

  updateSettings(body, bad) {
    const next = this.settings();
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') throw bad('enabled debe ser true o false');
      next.enabled = body.enabled;
    }
    if (body.hour !== undefined) {
      const h = Number(body.hour);
      if (!Number.isInteger(h) || h < 0 || h > 23) throw bad('hour debe ser una hora entre 0 y 23');
      next.hour = h;
    }
    if (body.keep !== undefined) {
      const k = Number(body.keep);
      if (!Number.isInteger(k) || k < 1 || k > 365) throw bad('keep debe estar entre 1 y 365 respaldos');
      next.keep = k;
    }
    this.store.putSetting(SETTINGS_KEY, next);
    this.prune();
    return next;
  }

  state() { return this.store.getSetting(STATE_KEY, {}) || {}; }

  /** Próximo respaldo automático (ms) o null si están apagados. */
  nextAt(now = Date.now()) {
    const s = this.settings();
    if (!s.enabled) return null;
    const slot = lastSlot(now, s.hour, this.timezone);
    const last = this.state().lastAutoAt || 0;
    return last >= slot ? slot + 86400000 : now; // si se perdió el de hoy (hub apagado), toca ya
  }

  start() {
    fs.mkdirSync(this.dir, { recursive: true });
    const tick = () => {
      const next = this.nextAt();
      if (next !== null && next <= Date.now() && !this.running) {
        this.run('auto').catch(() => {});
      }
    };
    setTimeout(tick, 5000).unref?.(); // al arrancar, tras estabilizarse
    this.timer = setInterval(tick, 60000);
    this.timer.unref?.();
  }
  stop() { clearInterval(this.timer); }

  /** Lista los respaldos de la carpeta, del más reciente al más antiguo. */
  list() {
    let names = [];
    try { names = fs.readdirSync(this.dir); } catch { return []; }
    return names.filter((n) => NAME_RE.test(n)).sort().reverse().map((name) => {
      const st = fs.statSync(path.join(this.dir, name));
      const [, ts, kind, enc] = NAME_RE.exec(name);
      return { name, kind, encrypted: !!enc, size: st.size, at: Math.floor(st.mtimeMs / 1000), stamp: ts };
    });
  }

  /** Ruta segura de un respaldo por su nombre (sin barras ni nombres arbitrarios). */
  file(name) {
    if (!NAME_RE.test(String(name))) return null;
    const f = path.join(this.dir, name);
    return fs.existsSync(f) ? f : null;
  }

  remove(name) {
    const f = this.file(name);
    if (!f) return false;
    fs.unlinkSync(f);
    return true;
  }

  /** Borra los automáticos que excedan la retención (los manuales se conservan). */
  prune() {
    const { keep } = this.settings();
    const autos = this.list().filter((b) => b.kind === 'auto');
    for (const b of autos.slice(keep)) {
      try { fs.unlinkSync(path.join(this.dir, b.name)); } catch {}
    }
  }

  run(kind = 'manual') {
    if (this.running) return this.running;
    this.running = this.#run(kind).finally(() => { this.running = null; });
    return this.running;
  }

  async #run(kind) {
    const started = Date.now();
    const name = `hub-${stamp()}-${kind}.db${this.key ? '.enc' : ''}`;
    const final = path.join(this.dir, name);
    const tmp = path.join(this.dir, `.tmp-${crypto.randomBytes(4).toString('hex')}.db`);
    const record = (r) => {
      const st = this.state();
      st.last = r;
      if (r.ok) st.lastOkAt = r.at;
      if (kind === 'auto') st.lastAutoAt = started; // también si falla: se reintenta en el próximo horario
      this.store.putSetting(STATE_KEY, st);
    };
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      // Espacio: al menos el doble del tamaño de la base
      const size = fs.statSync(this.dbPath).size + (fs.existsSync(this.dbPath + '-wal') ? fs.statSync(this.dbPath + '-wal').size : 0);
      const fsInfo = fs.statfsSync(this.dir);
      if (fsInfo.bavail * fsInfo.bsize < size * 2) throw new Error(`espacio insuficiente en ${this.dir}`);

      // Copia consistente sin detener el hub
      this.store.db.prepare('VACUUM INTO ?').run(tmp);

      // Las sesiones no se restauran (obligaría a todos a entrar de nuevo de todas formas)
      const copy = new DatabaseSync(tmp);
      try { copy.exec('DELETE FROM sessions; VACUUM;'); } finally { copy.close(); }
      const info = inspect(tmp);
      if (!info.ok) throw new Error(`la copia no pasó la verificación: ${info.check}`);

      if (this.key) {
        fs.writeFileSync(final, encrypt(fs.readFileSync(tmp), this.key), { mode: 0o600 });
        fs.unlinkSync(tmp);
      } else {
        fs.renameSync(tmp, final);
        fs.chmodSync(final, 0o600);
      }
      const r = { ok: true, at: Math.floor(Date.now() / 1000), name, kind, size: fs.statSync(final).size, durationMs: Date.now() - started, machines: info.machines, users: info.users };
      record(r);
      this.prune();
      this.store.event(null, 'respaldo_creado', `${name} · ${(r.size / 1024).toFixed(0)} KB · ${r.durationMs} ms`, 0);
      return r;
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch {}
      const r = { ok: false, at: Math.floor(Date.now() / 1000), kind, error: e.message, durationMs: Date.now() - started };
      record(r);
      this.store.event(null, 'respaldo_fallido', e.message, 0);
      this.log.error('respaldo:', e.message);
      if (this.notify) this.notify({ type: 'backup_failed', at: r.at, error: e.message, kind }).catch(() => {});
      return r;
    }
  }
}

module.exports = { BackupService, encrypt, decrypt, inspect, lastSlot, NAME_RE };
