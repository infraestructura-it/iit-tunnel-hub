'use strict';
// Módulo Datacenter: sensores que ENVÍAN sus lecturas al hub por HTTP (push) con el token de la máquina.
// Agnóstico al medio físico (RS232, Modbus, Ethernet, 4G, 5G): lo que lee el sensor en sitio lo manda aquí.
// Tipos: temperatura, humedad, monóxido (umbrales → estado ok/warn/crit), apertura (biométrica, eventos),
// energía (3 fases: voltajes y corrientes). Cámaras IP (RTSP) se registran aparte.

const crypto = require('node:crypto');

const KINDS = ['temperatura', 'humedad', 'monoxido', 'apertura', 'energia'];
const NUMERIC = new Set(['temperatura', 'humedad', 'monoxido']);
const UNIT = { temperatura: '°C', humedad: '%', monoxido: 'ppm', apertura: '', energia: 'V' };
const LINKS = ['ethernet', '4g', '5g', 'rs232', 'modbus', ''];
const RANGES = { '12h': 12 * 3600, '24h': 86400, '48h': 2 * 86400, '72h': 3 * 86400, week: 7 * 86400, month: 30 * 86400 };
const RETENTION = 35 * 86400; // se conserva algo más que el rango "mes"

const now = () => Math.floor(Date.now() / 1000);
const newId = (p) => `${p}_` + crypto.randomBytes(9).toString('base64url');
const slug = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

/** Estado por umbrales. Para apertura: crit si la validación biométrica fue denegada. */
function statusOf(sensor, value, extra) {
  if (sensor.kind === 'apertura') {
    const r = extra && extra.result;
    return r === 'denegado' ? 'crit' : 'ok';
  }
  if (!NUMERIC.has(sensor.kind)) return 'ok';
  const v = Number(value);
  if (!Number.isFinite(v)) return 'sin_datos';
  const { crit_low, crit_high, warn_low, warn_high } = sensor;
  if (crit_high != null && v >= crit_high) return 'crit';
  if (crit_low != null && v <= crit_low) return 'crit';
  if (warn_high != null && v >= warn_high) return 'warn';
  if (warn_low != null && v <= warn_low) return 'warn';
  return 'ok';
}

function view(s) {
  if (!s) return null;
  let lastExtra = null;
  try { lastExtra = s.last_extra ? JSON.parse(s.last_extra) : null; } catch {}
  return {
    id: s.id, machineId: s.machine_id, key: s.key, kind: s.kind, name: s.name,
    unit: s.unit, link: s.link, enabled: !!s.enabled, status: s.status,
    warnLow: s.warn_low, warnHigh: s.warn_high, critLow: s.crit_low, critHigh: s.crit_high,
    lastTs: s.last_ts, lastValue: s.last_value, lastExtra,
    stale: s.last_ts ? (now() - s.last_ts > 900) : true,
  };
}

/** Oculta la contraseña en una URL (rtsp://usuario:clave@host → rtsp://usuario:***@host). */
const maskUrl = (u) => String(u || '').replace(/(:\/\/[^:/@]+:)[^@]+@/, '$1***@');

function cameraView(c, { withSecrets = false } = {}) {
  if (!c) return null;
  return {
    id: c.id, machineId: c.machine_id, name: c.name, location: c.location,
    rtspUrl: withSecrets ? c.rtsp_url : maskUrl(c.rtsp_url),
    snapshotUrl: withSecrets ? c.snapshot_url : maskUrl(c.snapshot_url),
    hasSnapshot: !!c.snapshot_url, enabled: !!c.enabled,
  };
}

/**
 * Procesa un push de lecturas de una máquina. body.readings: [{key, value?, ts?, phases?, event?}].
 * Devuelve { accepted, results:[{key, status}|{key, error}] }. notify(alert) es opcional.
 */
function ingest(store, machine, body, { notify } = {}) {
  const readings = Array.isArray(body?.readings) ? body.readings : (body?.key ? [body] : []);
  if (!readings.length) { const e = new Error('cuerpo sin lecturas (readings[])'); e.status = 400; throw e; }
  const out = [];
  for (const r of readings.slice(0, 200)) {
    const key = slug(r.key);
    if (!key) { out.push({ error: 'key vacía' }); continue; }
    const s = store.getDcSensorByKey(machine.id, key);
    if (!s) { out.push({ key, error: 'sensor no registrado' }); continue; }
    if (!s.enabled) { out.push({ key, status: 'deshabilitado' }); continue; }
    const ts = Number.isFinite(Number(r.ts)) ? Math.floor(Number(r.ts)) : now();

    let value, extra = null;
    if (s.kind === 'energia') {
      const p = r.phases || {};
      const v = Array.isArray(p.v) ? p.v.map(Number) : [];
      const i = Array.isArray(p.i) ? p.i.map(Number) : [];
      extra = JSON.stringify({ v, i, f: Number(p.f) || null, pf: Number(p.pf) || null });
      value = Number.isFinite(Number(r.value)) ? Number(r.value) : (v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0);
    } else if (s.kind === 'apertura') {
      const ev = r.event || { state: r.state, user: r.user, result: r.result };
      value = (ev.state === 'abierto' || r.value === 1) ? 1 : 0;
      extra = JSON.stringify({ state: ev.state || (value ? 'abierto' : 'cerrado'), user: ev.user || '', result: ev.result || '' });
      store.addDcEvent({ sensorId: s.id, ts, state: ev.state || (value ? 'abierto' : 'cerrado'), usr: ev.user || '', result: ev.result || '', detail: r.detail || '' });
    } else {
      value = Number(r.value);
      if (!Number.isFinite(value)) { out.push({ key, error: 'value no numérico' }); continue; }
    }

    store.addDcSample(s.id, ts, value, extra);
    const parsedExtra = extra ? JSON.parse(extra) : null;
    const prev = s.status;
    const status = statusOf(s, value, parsedExtra);
    store.updateDcSensor(s.id, { last_ts: ts, last_value: value, last_extra: extra, status });

    // Alerta al entrar en crítico y aviso de normalización al salir (reusa el monitor del hub)
    if (notify && status !== prev) {
      const m = machine;
      if (status === 'crit') notify({ type: 'dc_alert', at: now(), sensor: { id: s.id, name: s.name, kind: s.kind, unit: s.unit }, value, extra: parsedExtra, machine: { id: m.id, name: m.name, client: m.client } });
      else if (prev === 'crit' && status === 'ok') notify({ type: 'dc_ok', at: now(), sensor: { id: s.id, name: s.name, kind: s.kind, unit: s.unit }, value, machine: { id: m.id, name: m.name, client: m.client } });
    }
    out.push({ key, status });
  }
  // Poda de muestras viejas de vez en cuando
  if (Math.random() < 0.05) store.pruneDcSamples(now() - RETENTION);
  return { accepted: out.filter((x) => !x.error).length, results: out };
}

module.exports = { KINDS, NUMERIC, UNIT, LINKS, RANGES, RETENTION, newId, slug, statusOf, view, cameraView, maskUrl, ingest };
