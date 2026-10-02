'use strict';
// Persistencia en SQLite usando el módulo nativo node:sqlite (Node >= 22.13). Sin dependencias.

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function open(dbPath) {
  fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS machines (
      id                  TEXT PRIMARY KEY,
      name                TEXT NOT NULL,
      client              TEXT NOT NULL DEFAULT '',
      description         TEXT NOT NULL DEFAULT '',
      token_hash          TEXT NOT NULL,
      enabled             INTEGER NOT NULL DEFAULT 1,
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL,
      last_login_at       INTEGER,
      last_client_address TEXT,
      last_hostname       TEXT,
      last_os             TEXT,
      last_arch           TEXT,
      last_version        TEXT
    );

    CREATE TABLE IF NOT EXISTS services (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      machine_id  TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      type        TEXT NOT NULL CHECK (type IN ('http','https','tcp')),
      local_ip    TEXT NOT NULL DEFAULT '127.0.0.1',
      local_port  INTEGER NOT NULL,
      subdomain   TEXT UNIQUE,
      remote_port INTEGER UNIQUE,
      tls_mode    TEXT,
      created_at  INTEGER NOT NULL,
      UNIQUE (machine_id, name)
    );

    CREATE TABLE IF NOT EXISTS events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      ts          INTEGER NOT NULL,
      machine_id  TEXT,
      kind        TEXT NOT NULL,
      detail      TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS events_machine_ts ON events (machine_id, ts DESC);

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Conversaciones con la IA (panel, Telegram o análisis de alertas)
    CREATE TABLE IF NOT EXISTS ai_conversations (
      id          TEXT PRIMARY KEY,
      machine_id  TEXT,                 -- null = conversación general
      channel     TEXT NOT NULL,        -- panel | telegram | alerta
      messages    TEXT NOT NULL DEFAULT '[]',
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    -- Acciones propuestas por la IA que requieren aprobación humana
    CREATE TABLE IF NOT EXISTS ai_actions (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id  TEXT NOT NULL,
      machine_id       TEXT NOT NULL,
      kind             TEXT NOT NULL,   -- http | ssh
      item_id          TEXT NOT NULL,   -- id de la consulta o del comando en el alcance
      params           TEXT NOT NULL DEFAULT '{}',
      summary          TEXT NOT NULL,
      reason           TEXT NOT NULL DEFAULT '',
      status           TEXT NOT NULL,   -- pendiente | ejecutada | fallida | rechazada | expirada
      result           TEXT,
      requested_at     INTEGER NOT NULL,
      decided_at       INTEGER,
      decided_by       TEXT
    );
    CREATE INDEX IF NOT EXISTS ai_actions_status ON ai_actions (status, requested_at DESC);
  `);
  migrate(db);
  return new Store(db);
}

// Columnas agregadas después de la primera versión: se crean si faltan (bases existentes)
function migrate(db) {
  const cols = new Set(db.prepare('PRAGMA table_info(machines)').all().map((c) => c.name));
  const add = (name, def) => { if (!cols.has(name)) db.exec(`ALTER TABLE machines ADD COLUMN ${name} ${def}`); };
  add('alerts', 'INTEGER NOT NULL DEFAULT 1');          // 1 = enviar alertas de esta máquina
  add('state', "TEXT NOT NULL DEFAULT 'unknown'");     // unknown | online | offline (último estado observado)
  add('state_since', 'INTEGER');                        // desde cuándo está en ese estado
  add('offline_alerted', 'INTEGER NOT NULL DEFAULT 0'); // 0 pendiente · 1 avisada · 2 sin aviso
  add('ai_scope', "TEXT NOT NULL DEFAULT '{}'");        // alcance de la IA (JSON, ver ai-scope.js)
}

const now = () => Math.floor(Date.now() / 1000);

class Store {
  constructor(db) {
    this.db = db;
    this.q = {
      listMachines: db.prepare('SELECT * FROM machines ORDER BY client, name'),
      getMachine: db.prepare('SELECT * FROM machines WHERE id = ?'),
      insertMachine: db.prepare(`INSERT INTO machines (id, name, client, description, token_hash, enabled, created_at, updated_at)
                                 VALUES (?, ?, ?, ?, ?, 1, ?, ?)`),
      deleteMachine: db.prepare('DELETE FROM machines WHERE id = ?'),
      setToken: db.prepare('UPDATE machines SET token_hash = ?, updated_at = ? WHERE id = ?'),
      recordLogin: db.prepare(`UPDATE machines SET last_login_at = ?, last_client_address = ?, last_hostname = ?,
                               last_os = ?, last_arch = ?, last_version = ? WHERE id = ?`),

      listServices: db.prepare('SELECT * FROM services ORDER BY machine_id, name'),
      servicesOf: db.prepare('SELECT * FROM services WHERE machine_id = ? ORDER BY name'),
      getService: db.prepare('SELECT * FROM services WHERE machine_id = ? AND name = ?'),
      insertService: db.prepare(`INSERT INTO services (machine_id, name, type, local_ip, local_port, subdomain, remote_port, tls_mode, created_at)
                                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      deleteService: db.prepare('DELETE FROM services WHERE machine_id = ? AND name = ?'),
      subdomainOwner: db.prepare('SELECT machine_id, name FROM services WHERE subdomain = ?'),
      usedPorts: db.prepare('SELECT remote_port FROM services WHERE remote_port IS NOT NULL'),

      insertEvent: db.prepare('INSERT INTO events (ts, machine_id, kind, detail) VALUES (?, ?, ?, ?)'),
      lastEvent: db.prepare('SELECT * FROM events WHERE kind = ? AND detail = ? AND (machine_id IS ? ) ORDER BY id DESC LIMIT 1'),
      recentEvents: db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?'),
      machineEvents: db.prepare('SELECT * FROM events WHERE machine_id = ? ORDER BY id DESC LIMIT ?'),
      pruneEvents: db.prepare('DELETE FROM events WHERE id <= (SELECT MAX(id) FROM events) - ?'),

      setState: db.prepare('UPDATE machines SET state = ?, state_since = ?, offline_alerted = ? WHERE id = ?'),
      setAlerted: db.prepare('UPDATE machines SET offline_alerted = ? WHERE id = ?'),
      setScope: db.prepare('UPDATE machines SET ai_scope = ?, updated_at = ? WHERE id = ?'),
      getConv: db.prepare('SELECT * FROM ai_conversations WHERE id = ?'),
      putConv: db.prepare(`INSERT INTO ai_conversations (id, machine_id, channel, messages, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
                           ON CONFLICT(id) DO UPDATE SET messages = excluded.messages, updated_at = excluded.updated_at`),
      delConv: db.prepare('DELETE FROM ai_conversations WHERE id = ?'),
      insertAction: db.prepare(`INSERT INTO ai_actions (conversation_id, machine_id, kind, item_id, params, summary, reason, status, requested_at)
                                VALUES (?, ?, ?, ?, ?, ?, ?, 'pendiente', ?)`),
      getAction: db.prepare('SELECT * FROM ai_actions WHERE id = ?'),
      decideAction: db.prepare(`UPDATE ai_actions SET status = ?, result = ?, decided_at = ?, decided_by = ? WHERE id = ? AND status = 'pendiente'`),
      setActionResult: db.prepare('UPDATE ai_actions SET status = ?, result = ? WHERE id = ?'),
      pendingActions: db.prepare(`SELECT * FROM ai_actions WHERE status = 'pendiente' ORDER BY id DESC`),
      convActions: db.prepare('SELECT * FROM ai_actions WHERE conversation_id = ? ORDER BY id'),
      expireActions: db.prepare(`UPDATE ai_actions SET status = 'expirada', decided_at = ? WHERE status = 'pendiente' AND requested_at < ?`),
      getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
      putSetting: db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
    };
  }

  // offline_alerted: 0 = pendiente, 1 = se avisó, 2 = no se avisa (deshabilitada, sin alertas o nunca vista)
  setState(id, state, since, alerted) { this.q.setState.run(state, since, alerted, id); }
  setAlerted(id, alerted) { this.q.setAlerted.run(alerted, id); }

  // ---------- IA ----------
  getScope(id) {
    const m = this.getMachine(id);
    if (!m) return null;
    try { return JSON.parse(m.ai_scope || '{}'); } catch { return {}; }
  }
  setScope(id, scope) { this.q.setScope.run(JSON.stringify(scope), now(), id); }

  getConversation(id) {
    const c = this.q.getConv.get(id);
    if (!c) return null;
    return { ...c, messages: JSON.parse(c.messages) };
  }
  saveConversation(c) {
    const t = now();
    this.q.putConv.run(c.id, c.machine_id ?? null, c.channel, JSON.stringify(c.messages), c.created_at || t, t);
  }
  deleteConversation(id) { this.q.delConv.run(id); }

  createAction(a) {
    const r = this.q.insertAction.run(a.conversationId, a.machineId, a.kind, a.itemId, JSON.stringify(a.params || {}), a.summary, a.reason || '', now());
    return this.getAction(Number(r.lastInsertRowid));
  }
  getAction(id) { return this.q.getAction.get(id) || null; }
  /** Pasa una acción pendiente a otro estado. Devuelve false si ya no estaba pendiente (doble clic, dos canales). */
  decideAction(id, status, result, by) { return this.q.decideAction.run(status, result ?? null, now(), by, id).changes > 0; }
  setActionResult(id, status, result) { this.q.setActionResult.run(status, result, id); }
  pendingActions() { return this.q.pendingActions.all(); }
  conversationActions(convId) { return this.q.convActions.all(convId); }
  expireActions(maxAgeSeconds) { return this.q.expireActions.run(now(), now() - maxAgeSeconds).changes; }

  getSetting(key, fallback = null) {
    const row = this.q.getSetting.get(key);
    if (!row) return fallback;
    try { return JSON.parse(row.value); } catch { return fallback; }
  }
  putSetting(key, value) { this.q.putSetting.run(key, JSON.stringify(value)); }

  listMachines() { return this.q.listMachines.all(); }
  getMachine(id) { return this.q.getMachine.get(id) || null; }

  createMachine({ id, name, client, description, tokenHash }) {
    const t = now();
    this.q.insertMachine.run(id, name, client, description, tokenHash, t, t);
    return this.getMachine(id);
  }

  updateMachine(id, fields) {
    const allowed = ['name', 'client', 'description', 'enabled', 'alerts'];
    const sets = [];
    const values = [];
    for (const k of allowed) {
      if (fields[k] !== undefined) { sets.push(`${k} = ?`); values.push(fields[k]); }
    }
    if (sets.length === 0) return this.getMachine(id);
    sets.push('updated_at = ?');
    values.push(now(), id);
    this.db.prepare(`UPDATE machines SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    return this.getMachine(id);
  }

  deleteMachine(id) { return this.q.deleteMachine.run(id).changes > 0; }
  setTokenHash(id, hash) { this.q.setToken.run(hash, now(), id); }

  recordLogin(id, c) {
    this.q.recordLogin.run(now(), c.client_address || '', c.hostname || '', c.os || '', c.arch || '', c.version || '', id);
  }

  listServices() { return this.q.listServices.all(); }
  servicesOf(machineId) { return this.q.servicesOf.all(machineId); }
  getService(machineId, name) { return this.q.getService.get(machineId, name) || null; }
  subdomainOwner(sub) { return this.q.subdomainOwner.get(sub) || null; }
  usedPorts() { return new Set(this.q.usedPorts.all().map((r) => r.remote_port)); }

  createService(machineId, s) {
    this.q.insertService.run(machineId, s.name, s.type, s.localIp, s.localPort,
      s.subdomain ?? null, s.remotePort ?? null, s.tlsMode ?? null, now());
    return this.getService(machineId, s.name);
  }

  deleteService(machineId, name) { return this.q.deleteService.run(machineId, name).changes > 0; }

  /**
   * Registra un evento. Si el mismo evento (tipo + detalle + máquina) ocurrió hace menos de
   * `dedupeSeconds`, no se repite: frpc reintenta el login constantemente y llenaría la tabla.
   */
  event(machineId, kind, detail = '', dedupeSeconds = 60) {
    const t = now();
    if (dedupeSeconds > 0) {
      const last = this.q.lastEvent.get(kind, detail, machineId ?? null);
      if (last && t - last.ts < dedupeSeconds) return;
    }
    this.q.insertEvent.run(t, machineId ?? null, kind, detail);
    if (Math.random() < 0.02) this.q.pruneEvents.run(5000);
  }

  events({ machineId, limit = 100 }) {
    const n = Math.min(Math.max(limit, 1), 500);
    return machineId ? this.q.machineEvents.all(machineId, n) : this.q.recentEvents.all(n);
  }

  transaction(fn) {
    this.db.exec('BEGIN');
    try { const r = fn(); this.db.exec('COMMIT'); return r; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
}

module.exports = { open };
