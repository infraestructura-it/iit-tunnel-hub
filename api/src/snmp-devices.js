'use strict';
// Equipos SNMP: validación de lo que llega del panel y vistas para la API (sin secretos).

const { AUTH, parseOid, desAvailable } = require('./snmp');
const { PROFILES, OPS } = require('./snmp-profiles');
const M = require('./machines');

const MASK = '********';
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const HOST_RE = /^(?=.{1,253}$)[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
const json = (s, d) => { try { return JSON.parse(s); } catch { return d; } };

const keyOf = (name) => String(name).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 24) || 'oid';

/**
 * Valida un equipo nuevo (cur = null) o cambios sobre uno existente. Devuelve las columnas a guardar.
 * Los secretos que llegan como "********" (o vacíos al editar) conservan el valor guardado.
 */
function normalizeSnmp(body, cur, bad) {
  const out = {};
  const has = (k) => body[k] !== undefined;
  const str = (v, max, f) => { const s = String(v ?? '').trim(); if (s.length > max) throw bad(`${f} admite máximo ${max} caracteres`); return s; };
  const secret = (k, col) => {
    if (!has(k)) return cur ? cur[col] : '';
    const v = String(body[k] ?? '');
    if (cur && (v === MASK || v === '')) return cur[col];
    return v;
  };

  if (!cur || has('name')) { out.name = str(body.name, 60, 'name'); if (!out.name) throw bad('el nombre del equipo es obligatorio'); }
  if (!cur || has('host')) {
    out.host = str(body.host, 253, 'host');
    if (!IPV4_RE.test(out.host) && !HOST_RE.test(out.host)) throw bad('host debe ser la IP o el nombre del equipo en la red de la sede');
  }
  if (!cur || has('port')) {
    const p = body.port === undefined || body.port === '' ? 161 : Number(body.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) throw bad('port debe estar entre 1 y 65535');
    out.port = p;
  }
  const version = has('version') ? String(body.version) : cur ? cur.version : '2c';
  if (!['2c', '3'].includes(version)) throw bad('version debe ser "2c" o "3"');
  out.version = version;

  if (version === '2c') {
    out.community = secret('community', 'community');
    if (!out.community) throw bad('la comunidad SNMP es obligatoria (por ejemplo public)');
    if (out.community.length > 64) throw bad('la comunidad admite máximo 64 caracteres');
  } else {
    out.v3_user = has('user') ? str(body.user, 64, 'user') : cur ? cur.v3_user : '';
    if (!out.v3_user) throw bad('el usuario SNMPv3 es obligatorio');
    out.auth_proto = has('authProtocol') ? String(body.authProtocol) : cur ? cur.auth_proto : 'sha';
    if (out.auth_proto !== 'none' && !AUTH[out.auth_proto]) throw bad('authProtocol debe ser none, md5, sha, sha224, sha256, sha384 o sha512');
    out.priv_proto = has('privProtocol') ? String(body.privProtocol) : cur ? cur.priv_proto : 'none';
    if (!['none', 'aes', 'des'].includes(out.priv_proto)) throw bad('privProtocol debe ser none, aes o des');
    if (out.priv_proto !== 'none' && out.auth_proto === 'none') throw bad('el cifrado (privacidad) requiere autenticación');
    if (out.priv_proto === 'des' && !desAvailable()) throw bad('DES requiere arrancar el hub con "node --openssl-legacy-provider"; si el equipo lo permite, use AES');
    out.auth_key = out.auth_proto === 'none' ? '' : secret('authKey', 'auth_key');
    out.priv_key = out.priv_proto === 'none' ? '' : secret('privKey', 'priv_key');
    if (out.auth_proto !== 'none' && out.auth_key.length < 8) throw bad('la contraseña de autenticación SNMPv3 debe tener al menos 8 caracteres');
    if (out.priv_proto !== 'none' && out.priv_key.length < 8) throw bad('la contraseña de privacidad SNMPv3 debe tener al menos 8 caracteres');
  }

  if (!cur || has('profile')) {
    out.profile = String(body.profile || 'auto');
    if (out.profile !== 'auto' && !PROFILES[out.profile]) throw bad(`perfil desconocido: ${out.profile}`);
  }
  if (!cur || has('interval')) {
    const i = body.interval === undefined || body.interval === '' ? 60 : Number(body.interval);
    if (!Number.isInteger(i) || i < 30 || i > 3600) throw bad('interval debe estar entre 30 y 3600 segundos');
    out.interval_s = i;
  }
  for (const k of ['enabled', 'alerts']) {
    if (has(k)) { if (typeof body[k] !== 'boolean') throw bad(`${k} debe ser true o false`); out[k] = body[k] ? 1 : 0; }
  }

  if (has('custom')) {
    if (!Array.isArray(body.custom) || body.custom.length > 30) throw bad('custom debe ser una lista de hasta 30 OIDs');
    const keys = new Set();
    out.custom = JSON.stringify(body.custom.map((c, i) => {
      const name = str(c.name, 40, `custom[${i}].name`) || `OID ${i + 1}`;
      let oid;
      try { oid = parseOid(c.oid).join('.'); } catch { throw bad(`custom[${i}]: OID inválido "${c.oid}"`); }
      let key = keyOf(name);
      for (let n = 2; keys.has(key); n++) key = `${keyOf(name)}_${n}`;
      keys.add(key);
      const scale = c.scale === undefined || c.scale === '' ? 1 : Number(c.scale);
      if (!Number.isFinite(scale) || scale === 0) throw bad(`custom[${i}]: escala inválida`);
      const op = c.op ? String(c.op) : '';
      if (op && !OPS[op]) throw bad(`custom[${i}]: operador inválido (use > >= < <= == !=)`);
      return {
        key, name, oid, unit: str(c.unit, 10, `custom[${i}].unit`), scale, hist: !!c.hist,
        op, limit: op ? str(c.limit, 40, `custom[${i}].limit`) : '', level: c.level === 'crit' ? 'crit' : 'warn',
      };
    }));
  }
  if (has('thresholds')) {
    if (!body.thresholds || typeof body.thresholds !== 'object' || Array.isArray(body.thresholds)) throw bad('thresholds debe ser un objeto');
    const t = {};
    for (const [k, v] of Object.entries(body.thresholds)) {
      if (!/^[a-zA-Z]{2,30}$/.test(k)) throw bad(`umbral desconocido: ${k}`);
      if (v === '' || v === null) continue;
      const n = Number(v);
      if (!Number.isFinite(n)) throw bad(`el umbral ${k} debe ser un número`);
      t[k] = n;
    }
    out.thresholds = JSON.stringify(t);
  }
  if (has('watch')) {
    if (!Array.isArray(body.watch) || body.watch.length > 128) throw bad('watch debe ser una lista de índices de interfaz');
    out.watch = JSON.stringify([...new Set(body.watch.map((x) => String(x)).filter((x) => /^\d{1,10}$/.test(x)))]);
  }
  return out;
}

/** Vista para la API. withSecrets=false (rol cliente) omite toda la configuración sensible. */
function snmpView(d, status, { client = false } = {}) {
  const data = json(d.data, {});
  const profileId = d.profile === 'auto' ? d.detected : d.profile;
  const profile = PROFILES[profileId];
  const alerts = Object.entries(json(d.alert_state, {})).map(([key, a]) => ({ key, ...a }));
  const proxy = status?.proxies?.get(`${d.machine_id}.${M.snmpProxyName(d)}`);
  const v = {
    id: d.id, machine: d.machine_id, name: d.name, host: d.host, port: d.port,
    profile: d.profile, detected: d.detected, profileLabel: profile ? profile.label : (d.profile === 'auto' ? 'automático' : d.profile),
    enabled: !!d.enabled, state: d.enabled ? d.state : 'deshabilitado', stateSince: d.state_since,
    lastPollAt: d.last_poll_at, lastOkAt: d.last_ok_at, lastError: d.last_error,
    applied: proxy?.status === 'online',
    sys: json(d.sys, {}),
    info: data.info || {}, metrics: data.metrics || {}, tables: data.tables || {}, at: data.at || null,
    meta: profile ? profile.meta : {},
    alerts: alerts.filter((a) => a.notified || client === false),
  };
  if (client) return v;
  const custom = json(d.custom, []);
  return {
    ...v,
    version: d.version, interval: d.interval_s, alertsEnabled: !!d.alerts,
    community: d.community ? MASK : '', user: d.v3_user, authProtocol: d.auth_proto, authKey: d.auth_key ? MASK : '',
    privProtocol: d.priv_proto, privKey: d.priv_key ? MASK : '',
    custom, watch: json(d.watch, []),
    thresholds: json(d.thresholds, {}), defaultThresholds: profile ? profile.thresholds : {},
    customMeta: Object.fromEntries(custom.map((c) => [`c.${c.key}`, { label: c.name, unit: c.unit, hist: c.hist }])),
    proxyName: M.snmpProxyName(d),
  };
}

module.exports = { normalizeSnmp, snmpView, MASK };
