'use strict';
// Sondeo SNMP: cada equipo se consulta a su intervalo a través del frpc del hub (127.0.0.1:bind_port →
// sudp → frpc de la sede → IP del equipo en la LAN). Guarda el estado, el historial (~5 min) y alerta
// por umbrales con el mismo tiempo de gracia y canales que las alertas de máquinas.

const { SnmpSession } = require('./snmp');
const P = require('./snmp-profiles');

const HISTORY_EVERY = 290;        // s entre muestras guardadas por métrica
const HISTORY_DAYS = 30;
const CONCURRENCY = 6;
const now = () => Math.floor(Date.now() / 1000);
const json = (s, d) => { try { return JSON.parse(s); } catch { return d; } };

/** Estado sin respuesta que no es culpa del equipo: no alerta (la caída de la sede ya tiene su alerta). */
const NO_ALERT_STATES = new Set(['pendiente', 'sede_desconectada', 'sin_transporte', 'deshabilitado']);

class SnmpMonitor {
  constructor({ store, frps, hub, notify, graceSeconds, log = console }) {
    Object.assign(this, { store, frps, hub, notify, graceSeconds, log });
    this.sessions = new Map(); // id → { sig, s }
    this.lastHist = new Map();
    this.running = new Set();
    this.timer = null;
    this.lastPrune = 0;
    this.stats = { polls: 0, errors: 0, lastTickAt: null };
  }

  start() {
    this.timer = setInterval(() => this.tick().catch((e) => this.log.error('snmp:', e.message)), 5000);
    this.timer.unref?.();
  }
  stop() { clearInterval(this.timer); for (const { s } of this.sessions.values()) s.close(); }

  forget(id) {
    const x = this.sessions.get(id);
    if (x) { x.s.close(); this.sessions.delete(id); }
    this.lastHist.delete(id);
  }

  async tick() {
    this.stats.lastTickAt = now();
    const t = now();
    if (t - this.lastPrune > 3600) { this.lastPrune = t; this.store.pruneSamples(t - HISTORY_DAYS * 86400); }
    const due = this.store.listSnmp().filter((d) => d.enabled && !this.running.has(d.id) && (!d.last_poll_at || t - d.last_poll_at >= d.interval_s));
    if (!due.length) return;
    const status = await this.frps.status();
    for (let i = 0; i < due.length; i += CONCURRENCY) {
      await Promise.all(due.slice(i, i + CONCURRENCY).map((d) => this.poll(d, status).catch((e) => this.log.error('snmp:', e.message))));
    }
  }

  /** Consulta inmediata (botón "Consultar ahora" del panel). */
  /** Explorador: recorre un subárbol del equipo (solo lectura, máx. 500 OIDs). */
  async walk(id, oid, max = 500) {
    const d = this.store.getSnmp(id);
    this.frps.invalidate();
    const blocked = this.transport(d, await this.frps.status());
    if (blocked) throw Object.assign(new Error(blocked.error), { status: 409 });
    return this.#session(d).walk(oid, { max });
  }

  async pollNow(id) {
    const d = this.store.getSnmp(id);
    if (!d) return null;
    this.frps.invalidate();
    return this.poll(d, await this.frps.status(), { force: true });
  }

  #session(d) {
    const sig = JSON.stringify([d.bind_port, d.version, d.community, d.v3_user, d.auth_proto, d.auth_key, d.priv_proto, d.priv_key]);
    const cur = this.sessions.get(d.id);
    if (cur && cur.sig === sig) return cur.s;
    cur?.s.close();
    const s = new SnmpSession({
      host: '127.0.0.1', port: d.bind_port, version: d.version, community: d.community,
      user: d.v3_user, authProtocol: d.auth_proto, authKey: d.auth_key, privProtocol: d.priv_proto, privKey: d.priv_key,
      timeout: 2500, retries: 1,
    });
    this.sessions.set(d.id, { sig, s });
    return s;
  }

  /** ¿Puede el hub llegar al equipo? Devuelve null si sí, o { state, error } si no. */
  transport(d, status) {
    if (!d.enabled) return { state: 'deshabilitado', error: 'equipo deshabilitado' };
    if (!this.hub?.bin) return { state: 'sin_transporte', error: this.hub?.lastError || 'el hub no tiene frpc para consultar por el túnel' };
    if (!status.reachable) return { state: 'sin_transporte', error: 'frps no responde' };
    if (!status.clients.has(d.machine_id)) return { state: 'sede_desconectada', error: `la máquina ${d.machine_id} de la sede está desconectada` };
    if (status.proxies.get(`${d.machine_id}.snmp-${d.id}-r${d.rev}`)?.status !== 'online') {
      return { state: 'pendiente', error: 'falta aplicar en la sede: ejecute el script de accesos de la máquina y reinicie su frpc' };
    }
    if (!this.hub.proc) return { state: 'sin_transporte', error: this.hub.lastError || 'el frpc del hub no está corriendo' };
    return null;
  }

  async poll(d, status, { force = false } = {}) {
    if (this.running.has(d.id)) return null;
    this.running.add(d.id);
    const t = now();
    try {
      const blocked = this.transport(d, status);
      if (blocked) {
        this.store.updateSnmp(d.id, { last_poll_at: t, last_error: blocked.error, ...(d.state !== blocked.state ? { state: blocked.state, state_since: t } : {}) });
        return { ok: false, state: blocked.state, error: blocked.error };
      }
      this.stats.polls++;
      const s = this.#session(d);
      const prev = json(d.data, {});
      let profileId = d.profile === 'auto' ? d.detected : d.profile;
      let data;
      try {
        const sys = await P.readSystem(s);
        if (!profileId || (force && d.profile === 'auto')) profileId = await P.detectProfile(s, sys);
        const profile = P.PROFILES[profileId] || P.PROFILES.generic;
        const custom = json(d.custom, []);
        const watch = json(d.watch, []);
        const r = await profile.collect(s, { prev, now: t, watch });
        Object.assign(r.metrics, await P.readCustom(s, custom));
        data = { at: t, profile: profileId, sys, ...r };
      } catch (e) {
        this.stats.errors++;
        const fails = d.fails + 1;
        const conds = fails >= 2 ? [{ key: 'sin_respuesta', level: 'crit', text: `Sin respuesta SNMP: ${e.message}` }] : [];
        const alertState = await this.#alerts(d, conds, t, { keepOthers: true });
        this.store.updateSnmp(d.id, {
          last_poll_at: t, last_error: e.message, fails, alert_state: JSON.stringify(alertState),
          ...(fails >= 2 && d.state !== 'down' ? { state: 'down', state_since: t } : {}),
        });
        return { ok: false, state: fails >= 2 ? 'down' : d.state, error: e.message };
      }

      // Historial cada ~5 min
      const profile = P.PROFILES[data.profile] || P.PROFILES.generic;
      if (t - (this.lastHist.get(d.id) || 0) >= HISTORY_EVERY) {
        const hist = { ...(data.extraHistory || {}) };
        for (const [k, m] of Object.entries(profile.meta)) if (m.hist && typeof data.metrics[k] === 'number') hist[k] = data.metrics[k];
        for (const c of json(d.custom, [])) if (c.hist && typeof data.metrics[`c.${c.key}`] === 'number') hist[`c.${c.key}`] = data.metrics[`c.${c.key}`];
        if (Object.keys(hist).length) this.store.addSamples(d.id, t, hist);
        this.lastHist.set(d.id, t);
      }

      const th = { ...profile.thresholds, ...json(d.thresholds, {}) };
      const conds = [...profile.rules(data.metrics, th, data, json(d.watch, [])), ...P.customRules(data.metrics, json(d.custom, []))];
      const alertState = await this.#alerts(d, conds, t);
      const worst = conds.some((c) => c.level === 'crit') ? 'crit' : conds.length ? 'warn' : 'ok';
      delete data.extraHistory;
      this.store.updateSnmp(d.id, {
        last_poll_at: t, last_ok_at: t, last_error: null, fails: 0,
        data: JSON.stringify(data), sys: JSON.stringify(data.sys), alert_state: JSON.stringify(alertState),
        ...(d.profile === 'auto' && d.detected !== data.profile ? { detected: data.profile } : {}),
        ...(d.state !== worst ? { state: worst, state_since: t } : {}),
      });
      return { ok: true, state: worst, profile: data.profile, conditions: conds };
    } finally {
      this.running.delete(d.id);
    }
  }

  /**
   * Avisa las condiciones que superan la gracia y las recuperaciones de las ya avisadas.
   * keepOthers: en un fallo de consulta no se dan por resueltas las condiciones previas.
   */
  async #alerts(d, conds, t, { keepOthers = false } = {}) {
    const prev = json(d.alert_state, {});
    const next = {};
    const grace = this.graceSeconds();
    const m = this.store.getMachine(d.machine_id);
    const ctx = {
      device: { id: d.id, name: d.name, host: d.host },
      machine: m ? { id: m.id, name: m.name, client: m.client } : { id: d.machine_id, name: d.machine_id },
    };
    for (const c of conds) {
      const p = prev[c.key];
      const st = { level: c.level, text: c.text, since: p ? p.since : t, notified: p ? p.notified : false };
      const escalated = p && p.notified && p.level === 'warn' && c.level === 'crit';
      if ((!st.notified || escalated) && t - st.since >= grace) {
        st.notified = true;
        this.store.event(d.machine_id, 'snmp_alerta', `${d.name}: ${c.text}`, 0);
        if (d.alerts) await this.notify({ type: 'snmp_alert', at: t, since: st.since, level: c.level, text: c.text, ...ctx }).catch(() => {});
      }
      next[c.key] = st;
    }
    for (const [key, p] of Object.entries(prev)) {
      if (next[key]) continue;
      if (keepOthers) { next[key] = p; continue; }
      if (p.notified) {
        this.store.event(d.machine_id, 'snmp_normal', `${d.name}: ${p.text}`, 0);
        if (d.alerts) await this.notify({ type: 'snmp_ok', at: t, since: p.since, downtimeSeconds: t - p.since, text: p.text, ...ctx }).catch(() => {});
      }
    }
    return next;
  }
}

module.exports = { SnmpMonitor, NO_ALERT_STATES, HISTORY_DAYS };
