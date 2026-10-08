'use strict';
// Persistencia en SQLite usando el módulo nativo node:sqlite (Node >= 22.13). Sin dependencias.

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { currentActor } = require('./context');

// Tabla de servicios. stcp = servicio privado: sin puerto público, solo visitantes autorizados (secret = clave stcp)
const SERVICES_TABLE = (name) => `
    CREATE TABLE IF NOT EXISTS ${name} (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      machine_id  TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      type        TEXT NOT NULL CHECK (type IN ('http','https','tcp','stcp')),
      local_ip    TEXT NOT NULL DEFAULT '127.0.0.1',
      local_port  INTEGER NOT NULL,
      subdomain   TEXT UNIQUE,
      remote_port INTEGER UNIQUE,
      tls_mode    TEXT,
      secret      TEXT,
      created_at  INTEGER NOT NULL,
      UNIQUE (machine_id, name)
    );`;

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

${SERVICES_TABLE('services')}

    CREATE TABLE IF NOT EXISTS events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      ts          INTEGER NOT NULL,
      machine_id  TEXT,
      kind        TEXT NOT NULL,
      detail      TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS events_machine_ts ON events (machine_id, ts DESC);

    -- Clientes de IIT: agrupan máquinas y definen qué ve cada técnico y cada usuario de cliente
    CREATE TABLE IF NOT EXISTS clients (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
      created_at  INTEGER NOT NULL
    );

    -- Personas que entran al panel. role: admin | tecnico | cliente
    CREATE TABLE IF NOT EXISTS users (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      username        TEXT NOT NULL UNIQUE,
      name            TEXT NOT NULL DEFAULT '',
      role            TEXT NOT NULL CHECK (role IN ('admin','tecnico','cliente')),
      client_id       TEXT REFERENCES clients(id) ON DELETE CASCADE,  -- solo rol cliente
      password_hash   TEXT NOT NULL,
      must_change     INTEGER NOT NULL DEFAULT 1,
      totp_secret     TEXT,
      totp_enabled    INTEGER NOT NULL DEFAULT 0,
      totp_last_step  INTEGER NOT NULL DEFAULT 0,
      enabled         INTEGER NOT NULL DEFAULT 1,
      failed_count    INTEGER NOT NULL DEFAULT 0,
      locked_until    INTEGER,
      created_at      INTEGER NOT NULL,
      last_login_at   INTEGER
    );

    -- Clientes asignados a cada técnico
    CREATE TABLE IF NOT EXISTS user_clients (
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      client_id  TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      PRIMARY KEY (user_id, client_id)
    );

    -- Sesiones del panel: se guarda el hash del token de la cookie, nunca el token
    CREATE TABLE IF NOT EXISTS sessions (
      id          TEXT PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at  INTEGER NOT NULL,
      expires_at  INTEGER NOT NULL,
      last_seen   INTEGER NOT NULL,
      ip          TEXT NOT NULL DEFAULT '',
      user_agent  TEXT NOT NULL DEFAULT ''
    );

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
  db.exec(`
    -- Accesos a servicios privados (stcp): la máquina visitante abre bind_port en su equipo
    CREATE TABLE IF NOT EXISTS service_access (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      service_id  INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
      visitor_id  TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
      bind_port   INTEGER NOT NULL,
      created_at  INTEGER NOT NULL,
      UNIQUE (service_id, visitor_id),
      UNIQUE (visitor_id, bind_port)
    );
  `);
  db.exec(`
    -- Equipos SNMP de la red local de una sede. La máquina de la sede (machine_id) publica el UDP 161
    -- del equipo como servicio privado sudp "snmp-<id>"; el frpc del hub lo abre en 127.0.0.1:bind_port.
    CREATE TABLE IF NOT EXISTS snmp_devices (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      machine_id    TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
      name          TEXT NOT NULL,
      host          TEXT NOT NULL,
      port          INTEGER NOT NULL DEFAULT 161,
      version       TEXT NOT NULL CHECK (version IN ('2c','3')),
      community     TEXT NOT NULL DEFAULT '',
      v3_user       TEXT NOT NULL DEFAULT '',
      auth_proto    TEXT NOT NULL DEFAULT 'none',
      auth_key      TEXT NOT NULL DEFAULT '',
      priv_proto    TEXT NOT NULL DEFAULT 'none',
      priv_key      TEXT NOT NULL DEFAULT '',
      profile       TEXT NOT NULL DEFAULT 'auto',
      detected      TEXT,
      custom        TEXT NOT NULL DEFAULT '[]',
      thresholds    TEXT NOT NULL DEFAULT '{}',
      watch         TEXT NOT NULL DEFAULT '[]',
      interval_s    INTEGER NOT NULL DEFAULT 60,
      enabled       INTEGER NOT NULL DEFAULT 1,
      alerts        INTEGER NOT NULL DEFAULT 1,
      secret        TEXT NOT NULL,
      bind_port     INTEGER NOT NULL UNIQUE,
      created_at    INTEGER NOT NULL,
      sys           TEXT NOT NULL DEFAULT '{}',
      state         TEXT NOT NULL DEFAULT 'unknown',
      state_since   INTEGER,
      last_poll_at  INTEGER,
      last_ok_at    INTEGER,
      last_error    TEXT,
      fails         INTEGER NOT NULL DEFAULT 0,
      data          TEXT NOT NULL DEFAULT '{}',
      alert_state   TEXT NOT NULL DEFAULT '{}',
      rev           INTEGER NOT NULL DEFAULT 1   -- sube al cambiar IP/puerto: obliga a aplicar el archivo nuevo en la sede
    );
    CREATE INDEX IF NOT EXISTS snmp_devices_machine ON snmp_devices (machine_id);

    -- Historial (cada ~5 min por métrica, 30 días)
    CREATE TABLE IF NOT EXISTS snmp_samples (
      device_id  INTEGER NOT NULL REFERENCES snmp_devices(id) ON DELETE CASCADE,
      metric     TEXT NOT NULL,
      ts         INTEGER NOT NULL,
      value      REAL NOT NULL,
      PRIMARY KEY (device_id, metric, ts)
    ) WITHOUT ROWID;
  `);
  db.exec(`
    -- Códigos de instalación de un solo uso: el equipo descarga el instalador directamente del hub.
    -- Con machine_id instala esa máquina (rota su token al canjearse); sin machine_id crea una nueva
    -- en client_id (o sin cliente) con el nombre del equipo. Solo se guarda el hash del código.
    CREATE TABLE IF NOT EXISTS enrollments (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      code_hash     TEXT NOT NULL UNIQUE,
      hint          TEXT NOT NULL,
      machine_id    TEXT REFERENCES machines(id) ON DELETE CASCADE,
      client_id     TEXT REFERENCES clients(id) ON DELETE CASCADE,
      server_addr   TEXT NOT NULL,
      created_by    TEXT,
      created_at    INTEGER NOT NULL,
      expires_at    INTEGER NOT NULL,
      used_at       INTEGER,
      used_ip       TEXT,
      used_host     TEXT,
      used_machine  TEXT,
      revoked_at    INTEGER,
      services      TEXT NOT NULL DEFAULT '[]',  -- máquina nueva: servicios a crear al canjear
      visitor_id    TEXT                         -- máquina nueva: visitante con acceso a sus servicios privados
    );
  `);
  const enCols = new Set(db.prepare('PRAGMA table_info(enrollments)').all().map((c) => c.name));
  if (!enCols.has('services')) db.exec("ALTER TABLE enrollments ADD COLUMN services TEXT NOT NULL DEFAULT '[]'");
  if (!enCols.has('visitor_id')) db.exec('ALTER TABLE enrollments ADD COLUMN visitor_id TEXT');
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
  add('client_id', 'TEXT REFERENCES clients(id) ON DELETE SET NULL'); // cliente al que pertenece (client = su nombre)

  const evCols = new Set(db.prepare('PRAGMA table_info(events)').all().map((c) => c.name));
  if (!evCols.has('actor')) db.exec('ALTER TABLE events ADD COLUMN actor TEXT'); // usuario que hizo el cambio

  // El cliente era un texto libre en cada máquina: se crean los clientes y se enlazan por nombre
  const orphans = db.prepare("SELECT DISTINCT client FROM machines WHERE client_id IS NULL AND TRIM(client) <> ''").all();
  for (const { client } of orphans) {
    const name = client.trim();
    let c = db.prepare('SELECT id FROM clients WHERE name = ?').get(name);
    if (!c) {
      const base = clientSlug(name);
      let id = base;
      for (let i = 2; db.prepare('SELECT 1 FROM clients WHERE id = ?').get(id); i++) id = `${base.slice(0, 28)}-${i}`;
      db.prepare('INSERT INTO clients (id, name, created_at) VALUES (?, ?, ?)').run(id, name, now());
      c = { id };
    }
    db.prepare("UPDATE machines SET client_id = ? WHERE client_id IS NULL AND TRIM(client) = ?").run(c.id, name);
  }
  if (orphans.length) db.exec('UPDATE machines SET client = (SELECT name FROM clients WHERE id = machines.client_id) WHERE client_id IS NOT NULL');

  // services: el CHECK de tipo no admitía 'stcp' y faltaba la columna secret. SQLite no altera
  // un CHECK: se reconstruye la tabla conservando ids y datos.
  const svcSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'services'").get()?.sql || '';
  if (!svcSql.includes("'stcp'")) {
    const cols = 'id, machine_id, name, type, local_ip, local_port, subdomain, remote_port, tls_mode, created_at';
    db.exec('PRAGMA foreign_keys = OFF');
    try {
      db.exec('BEGIN');
      db.exec(SERVICES_TABLE('services_nueva'));
      db.exec(`INSERT INTO services_nueva (${cols}) SELECT ${cols} FROM services`);
      db.exec('DROP TABLE services');
      db.exec('ALTER TABLE services_nueva RENAME TO services');
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    finally { db.exec('PRAGMA foreign_keys = ON'); }
  }
}

const now = () => Math.floor(Date.now() / 1000);

function clientSlug(name) {
  const s = String(name).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '');
  return s || 'cliente';
}

class Store {
  constructor(db) {
    this.db = db;
    this.q = {
      listMachines: db.prepare('SELECT * FROM machines ORDER BY client, name'),
      getMachine: db.prepare('SELECT * FROM machines WHERE id = ?'),
      insertMachine: db.prepare(`INSERT INTO machines (id, name, client, client_id, description, token_hash, enabled, created_at, updated_at)
                                 VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`),
      deleteMachine: db.prepare('DELETE FROM machines WHERE id = ?'),
      setToken: db.prepare('UPDATE machines SET token_hash = ?, updated_at = ? WHERE id = ?'),
      recordLogin: db.prepare(`UPDATE machines SET last_login_at = ?, last_client_address = ?, last_hostname = ?,
                               last_os = ?, last_arch = ?, last_version = ? WHERE id = ?`),

      listServices: db.prepare('SELECT * FROM services ORDER BY machine_id, name'),
      servicesOf: db.prepare('SELECT * FROM services WHERE machine_id = ? ORDER BY name'),
      getService: db.prepare('SELECT * FROM services WHERE machine_id = ? AND name = ?'),
      insertService: db.prepare(`INSERT INTO services (machine_id, name, type, local_ip, local_port, subdomain, remote_port, tls_mode, secret, created_at)
                                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      setSecret: db.prepare('UPDATE services SET secret = ? WHERE id = ?'),

      listAccess: db.prepare(`SELECT a.id, a.service_id, a.visitor_id, a.bind_port, a.created_at,
                                     s.machine_id AS owner_id, s.name AS service, s.secret, s.local_port
                              FROM service_access a JOIN services s ON s.id = a.service_id
                              ORDER BY a.visitor_id, a.bind_port`),
      insertAccess: db.prepare('INSERT INTO service_access (service_id, visitor_id, bind_port, created_at) VALUES (?, ?, ?, ?)'),
      deleteAccess: db.prepare('DELETE FROM service_access WHERE id = ?'),
      deleteService: db.prepare('DELETE FROM services WHERE machine_id = ? AND name = ?'),
      subdomainOwner: db.prepare('SELECT machine_id, name FROM services WHERE subdomain = ?'),
      usedPorts: db.prepare('SELECT remote_port FROM services WHERE remote_port IS NOT NULL'),

      insertEvent: db.prepare('INSERT INTO events (ts, machine_id, kind, detail, actor) VALUES (?, ?, ?, ?, ?)'),
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

  createMachine({ id, name, client, clientId = null, description, tokenHash }) {
    const t = now();
    this.q.insertMachine.run(id, name, client, clientId, description, tokenHash, t, t);
    return this.getMachine(id);
  }

  updateMachine(id, fields) {
    const allowed = ['name', 'client', 'client_id', 'description', 'enabled', 'alerts'];
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
      s.subdomain ?? null, s.remotePort ?? null, s.tlsMode ?? null, s.secret ?? null, now());
    return this.getService(machineId, s.name);
  }
  setServiceSecret(serviceId, secret) { this.q.setSecret.run(secret, serviceId); }

  // ---------- accesos a servicios privados (stcp) ----------
  // Cada fila trae: id, service_id, visitor_id, bind_port, owner_id, service, secret, local_port
  listAccess() { return this.q.listAccess.all(); }
  getAccess(id) { return this.listAccess().find((a) => a.id === Number(id)) || null; }
  accessForService(serviceId) { return this.listAccess().filter((a) => a.service_id === serviceId); }
  accessOfVisitor(visitorId) { return this.listAccess().filter((a) => a.visitor_id === visitorId); }
  createAccess(serviceId, visitorId, bindPort) {
    const r = this.q.insertAccess.run(serviceId, visitorId, bindPort, now());
    return this.getAccess(Number(r.lastInsertRowid));
  }
  deleteAccess(id) { return this.q.deleteAccess.run(Number(id)).changes > 0; }

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
    this.q.insertEvent.run(t, machineId ?? null, kind, detail, currentActor());
    if (Math.random() < 0.02) this.q.pruneEvents.run(5000);
  }

  /** visible(machineId) filtra para usuarios con alcance limitado (los eventos sin máquina quedan fuera). */
  events({ machineId, limit = 100, visible = null }) {
    const n = Math.min(Math.max(limit, 1), 500);
    if (machineId || !visible) return machineId ? this.q.machineEvents.all(machineId, n) : this.q.recentEvents.all(n);
    const out = [];
    for (let offset = 0; out.length < n && offset < 20000; offset += 500) {
      const page = this.db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 500 OFFSET ?').all(offset);
      if (!page.length) break;
      for (const e of page) if (e.machine_id && visible(e.machine_id) && out.length < n) out.push(e);
    }
    return out;
  }

  // ---------- SNMP ----------
  listSnmp() { return this.db.prepare('SELECT * FROM snmp_devices ORDER BY machine_id, name').all(); }
  snmpOf(machineId) { return this.db.prepare('SELECT * FROM snmp_devices WHERE machine_id = ? ORDER BY name').all(machineId); }
  getSnmp(id) { return this.db.prepare('SELECT * FROM snmp_devices WHERE id = ?').get(Number(id)) || null; }
  usedSnmpPorts() { return new Set(this.db.prepare('SELECT bind_port FROM snmp_devices').all().map((r) => r.bind_port)); }
  createSnmp(d) {
    const cols = Object.keys(d);
    const r = this.db.prepare(`INSERT INTO snmp_devices (${cols.join(', ')}, created_at) VALUES (${cols.map(() => '?').join(', ')}, ?)`)
      .run(...cols.map((k) => d[k]), now());
    return this.getSnmp(Number(r.lastInsertRowid));
  }
  updateSnmp(id, fields) {
    const cols = Object.keys(fields);
    if (cols.length) this.db.prepare(`UPDATE snmp_devices SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((k) => fields[k]), Number(id));
    return this.getSnmp(id);
  }
  deleteSnmp(id) { return this.db.prepare('DELETE FROM snmp_devices WHERE id = ?').run(Number(id)).changes > 0; }
  addSamples(deviceId, ts, values) {
    const ins = this.db.prepare('INSERT OR REPLACE INTO snmp_samples (device_id, metric, ts, value) VALUES (?, ?, ?, ?)');
    this.transaction(() => { for (const [m, v] of Object.entries(values)) if (Number.isFinite(v)) ins.run(deviceId, m, ts, v); });
  }
  samples(deviceId, metric, from) {
    return this.db.prepare('SELECT ts, value FROM snmp_samples WHERE device_id = ? AND metric = ? AND ts >= ? ORDER BY ts').all(Number(deviceId), metric, from);
  }
  sampleMetrics(deviceId) {
    return this.db.prepare('SELECT DISTINCT metric FROM snmp_samples WHERE device_id = ?').all(Number(deviceId)).map((r) => r.metric);
  }
  pruneSamples(olderThan) { return this.db.prepare('DELETE FROM snmp_samples WHERE ts < ?').run(olderThan).changes; }

  // ---------- clientes ----------
  listClients() {
    return this.db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM machines m WHERE m.client_id = c.id) AS machines
                            FROM clients c ORDER BY c.name`).all();
  }
  getClient(id) { return this.db.prepare('SELECT * FROM clients WHERE id = ?').get(id) || null; }
  clientByName(name) { return this.db.prepare('SELECT * FROM clients WHERE name = ?').get(String(name).trim()) || null; }
  createClient(name) {
    const base = clientSlug(name);
    let id = base;
    for (let i = 2; this.getClient(id); i++) id = `${base.slice(0, 28)}-${i}`;
    this.db.prepare('INSERT INTO clients (id, name, created_at) VALUES (?, ?, ?)').run(id, String(name).trim(), now());
    return this.getClient(id);
  }
  renameClient(id, name) {
    this.transaction(() => {
      this.db.prepare('UPDATE clients SET name = ? WHERE id = ?').run(name, id);
      this.db.prepare('UPDATE machines SET client = ? WHERE client_id = ?').run(name, id);
    });
    return this.getClient(id);
  }
  deleteClient(id) { return this.db.prepare('DELETE FROM clients WHERE id = ?').run(id).changes > 0; }

  // ---------- usuarios ----------
  countUsers() { return this.db.prepare('SELECT COUNT(*) AS n FROM users').get().n; }
  countAdmins(exceptId = 0) { return this.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND enabled = 1 AND id <> ?").get(exceptId).n; }
  listUsers() { return this.db.prepare('SELECT * FROM users ORDER BY role, username').all(); }
  getUser(id) { return this.db.prepare('SELECT * FROM users WHERE id = ?').get(Number(id)) || null; }
  userByName(username) { return this.db.prepare('SELECT * FROM users WHERE username = ?').get(String(username)) || null; }
  createUser(u) {
    const r = this.db.prepare(`INSERT INTO users (username, name, role, client_id, password_hash, must_change, created_at)
                               VALUES (?, ?, ?, ?, ?, ?, ?)`).run(u.username, u.name || '', u.role, u.clientId ?? null, u.passwordHash, u.mustChange ? 1 : 0, now());
    return this.getUser(Number(r.lastInsertRowid));
  }
  updateUser(id, fields) {
    const allowed = ['name', 'role', 'client_id', 'password_hash', 'must_change', 'totp_secret', 'totp_enabled', 'totp_last_step', 'enabled', 'failed_count', 'locked_until', 'last_login_at'];
    const sets = []; const values = [];
    for (const k of allowed) if (fields[k] !== undefined) { sets.push(`${k} = ?`); values.push(fields[k]); }
    if (sets.length) this.db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...values, Number(id));
    return this.getUser(id);
  }
  deleteUser(id) { return this.db.prepare('DELETE FROM users WHERE id = ?').run(Number(id)).changes > 0; }
  userClientIds(userId) { return this.db.prepare('SELECT client_id FROM user_clients WHERE user_id = ?').all(Number(userId)).map((r) => r.client_id); }
  setUserClients(userId, ids) {
    this.transaction(() => {
      this.db.prepare('DELETE FROM user_clients WHERE user_id = ?').run(Number(userId));
      const ins = this.db.prepare('INSERT INTO user_clients (user_id, client_id) VALUES (?, ?)');
      for (const c of new Set(ids)) ins.run(Number(userId), c);
    });
  }

  // ---------- sesiones ----------
  createSession(idHash, userId, { ip = '', userAgent = '', hours }) {
    const t = now();
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(t);
    this.db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(idHash, userId, t, t + hours * 3600, t, String(ip).slice(0, 64), String(userAgent).slice(0, 200));
  }
  getSession(idHash) {
    const s = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(idHash);
    if (!s) return null;
    if (s.expires_at < now()) { this.deleteSession(idHash); return null; }
    if (now() - s.last_seen > 60) this.db.prepare('UPDATE sessions SET last_seen = ? WHERE id = ?').run(now(), idHash);
    return s;
  }
  deleteSession(idHash) { this.db.prepare('DELETE FROM sessions WHERE id = ?').run(idHash); }
  deleteUserSessions(userId, exceptIdHash = '') { this.db.prepare('DELETE FROM sessions WHERE user_id = ? AND id <> ?').run(Number(userId), exceptIdHash); }

  // ---------- códigos de instalación ----------
  createEnrollment(e) {
    const r = this.db.prepare(`INSERT INTO enrollments (code_hash, hint, machine_id, client_id, server_addr, created_by, created_at, expires_at, services, visitor_id)
                               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(e.codeHash, e.hint, e.machineId ?? null, e.clientId ?? null, e.serverAddr, e.createdBy ?? null, now(), e.expiresAt,
        JSON.stringify(e.services || []), e.visitorId ?? null);
    return this.getEnrollment(Number(r.lastInsertRowid));
  }
  getEnrollment(id) { return this.db.prepare('SELECT * FROM enrollments WHERE id = ?').get(Number(id)) || null; }
  enrollmentByHash(hash) { return this.db.prepare('SELECT * FROM enrollments WHERE code_hash = ?').get(hash) || null; }
  listEnrollments(limit = 50) {
    // Se conservan 7 días para la auditoría; los eventos guardan el resto
    this.db.prepare('DELETE FROM enrollments WHERE expires_at < ?').run(now() - 7 * 86400);
    return this.db.prepare('SELECT * FROM enrollments ORDER BY id DESC LIMIT ?').all(Math.min(Math.max(limit, 1), 200));
  }
  /** Marca el código como usado solo si sigue vigente. false = ya usado, vencido o revocado (canje doble). */
  useEnrollment(id, { ip, host }) {
    return this.db.prepare(`UPDATE enrollments SET used_at = ?, used_ip = ?, used_host = ?
                            WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?`)
      .run(now(), String(ip).slice(0, 64), String(host).slice(0, 64), Number(id), now()).changes > 0;
  }
  setEnrollmentMachine(id, machineId) { this.db.prepare('UPDATE enrollments SET used_machine = ? WHERE id = ?').run(machineId, Number(id)); }
  revokeEnrollment(id) {
    return this.db.prepare('UPDATE enrollments SET revoked_at = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL').run(now(), Number(id)).changes > 0;
  }

  transaction(fn) {
    this.db.exec('BEGIN');
    try { const r = fn(); this.db.exec('COMMIT'); return r; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
}

module.exports = { open, clientSlug };
