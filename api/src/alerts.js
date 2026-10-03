'use strict';
// Alertas: vigila el estado de las máquinas y de frps, y notifica por Telegram y webhooks.
//
// Reglas:
//  - Una máquina que estaba EN LÍNEA y se desconecta genera alerta si sigue caída tras el tiempo de gracia
//    (evita avisos por micro-cortes o por reinicios del hub, que desconectan a todos unos segundos).
//  - Al volver, se envía la recuperación con el tiempo que estuvo caída (solo si se había alertado).
//  - Máquinas nunca conectadas, deshabilitadas o con alertas apagadas no generan avisos.
//  - Si frps no responde, se avisa una sola vez del servidor caído y NO se marcan las máquinas como caídas.

const SETTINGS_KEY = 'alerts';
const DEFAULTS = { graceSeconds: 60, telegram: { botToken: '', chatId: '' }, webhooks: [] };

const now = () => Math.floor(Date.now() / 1000);

function duration(sec) {
  sec = Math.max(0, Math.round(sec));
  if (sec < 60) return `${sec} s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${m % 60} min`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

// ---------- configuración ----------

function loadSettings(store) {
  const s = store.getSetting(SETTINGS_KEY, {}) || {};
  return {
    graceSeconds: Number.isInteger(s.graceSeconds) ? s.graceSeconds : DEFAULTS.graceSeconds,
    telegram: { botToken: s.telegram?.botToken || '', chatId: s.telegram?.chatId || '' },
    webhooks: Array.isArray(s.webhooks) ? s.webhooks : [],
  };
}

/** Vista segura para la API: el token del bot nunca se devuelve completo. */
function publicSettings(s) {
  const t = s.telegram.botToken;
  return {
    graceSeconds: s.graceSeconds,
    telegram: { configured: !!(t && s.telegram.chatId), botTokenMasked: t ? `${t.slice(0, 4)}…${t.slice(-4)}` : '', chatId: s.telegram.chatId },
    webhooks: s.webhooks,
  };
}

/** Aplica cambios validados. botToken vacío o ausente conserva el actual; null lo borra. */
function updateSettings(store, body, bad) {
  const cur = loadSettings(store);
  const next = structuredClone(cur);

  if (body.graceSeconds !== undefined) {
    const g = Number(body.graceSeconds);
    if (!Number.isInteger(g) || g < 0 || g > 86400) throw bad('graceSeconds debe ser un entero entre 0 y 86400');
    next.graceSeconds = g;
  }
  if (body.telegram) {
    const { botToken, chatId } = body.telegram;
    if (botToken === null) next.telegram.botToken = '';
    else if (typeof botToken === 'string' && botToken.trim()) {
      if (!/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(botToken.trim())) throw bad('el token del bot de Telegram no tiene el formato esperado (123456:ABC…)');
      next.telegram.botToken = botToken.trim();
    }
    if (chatId !== undefined) {
      const c = String(chatId ?? '').trim();
      if (c && !/^(-?\d{1,20}|@[A-Za-z0-9_]{4,})$/.test(c)) throw bad('chatId de Telegram inválido (número o @canal)');
      next.telegram.chatId = c;
    }
  }
  if (body.webhooks !== undefined) {
    if (!Array.isArray(body.webhooks)) throw bad('webhooks debe ser una lista de URLs');
    const list = body.webhooks.map((u) => String(u).trim()).filter(Boolean);
    if (list.length > 10) throw bad('máximo 10 webhooks');
    for (const u of list) {
      let url;
      try { url = new URL(u); } catch { throw bad(`URL de webhook inválida: ${u}`); }
      if (!['http:', 'https:'].includes(url.protocol)) throw bad(`el webhook debe ser http o https: ${u}`);
    }
    next.webhooks = [...new Set(list)];
  }
  store.putSetting(SETTINGS_KEY, next);
  return next;
}

// ---------- envío ----------

function message(alert, tz) {
  const when = (ts) => new Date(ts * 1000).toLocaleString('es-CO', { timeZone: tz, dateStyle: 'short', timeStyle: 'short' });
  const m = alert.machine;
  const who = m ? `${m.name}${m.client ? ` · ${m.client}` : ''}\nid: ${m.id}` : '';
  switch (alert.type) {
    case 'machine_offline':
      return `🔴 Máquina sin conexión\n${who}\nDesde: ${when(alert.since)} (hace ${duration(alert.at - alert.since)})${m.lastAddress ? `\nÚltima IP: ${m.lastAddress}` : ''}`;
    case 'machine_online':
      return `🟢 Máquina reconectada\n${who}\nEstuvo sin conexión ${duration(alert.downtimeSeconds)}`;
    case 'server_down':
      return `⚠️ El servidor de túneles (frps) no responde\nDesde: ${when(alert.since)}\n${alert.error || ''}`.trim();
    case 'server_up':
      return `✅ El servidor de túneles (frps) volvió a responder\nEstuvo caído ${duration(alert.downtimeSeconds)}`;
    case 'ai_analysis':
      return `🤖 Diagnóstico IA · ${m.name}${m.client ? ` · ${m.client}` : ''}\n${alert.analysis}`;
    case 'backup_failed':
      return `💾 Falló el respaldo ${alert.kind === 'auto' ? 'automático ' : ''}de la base del hub\n${alert.error || ''}`.trim();
    case 'test':
      return '🔔 Prueba de alertas de IIT Tunnel Hub\nSi recibe este mensaje, el canal está bien configurado.';
    default:
      return alert.type;
  }
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'iit-tunnel-hub' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 200); } catch {}
    throw new Error(`HTTP ${res.status}${detail ? ` · ${detail}` : ''}`);
  }
}

/** Envía una alerta a todos los canales. Devuelve [{channel, ok, error}]. */
async function send(settings, alert, tz, telegramBase = 'https://api.telegram.org') {
  const text = message(alert, tz);
  const payload = { source: 'iit-tunnel-hub', ...alert, text };
  const jobs = [];
  if (settings.telegram.botToken && settings.telegram.chatId) {
    jobs.push(['telegram', postJson(`${telegramBase}/bot${settings.telegram.botToken}/sendMessage`,
      { chat_id: settings.telegram.chatId, text, disable_web_page_preview: true })]);
  }
  for (const url of settings.webhooks) jobs.push([`webhook ${new URL(url).host}`, postJson(url, payload)]);
  const results = await Promise.allSettled(jobs.map(([, p]) => p));
  return results.map((r, i) => ({ channel: jobs[i][0], ok: r.status === 'fulfilled', error: r.status === 'rejected' ? r.reason.message : null }));
}

// ---------- monitor ----------

class AlertMonitor {
  constructor(store, frps, { intervalSeconds = 15, timezone = 'America/Bogota', telegramBase, log = console } = {}) {
    this.telegramBase = telegramBase;
    this.ai = null; // AIService opcional: diagnóstico automático de caídas
    this.store = store;
    this.frps = frps;
    this.intervalMs = intervalSeconds * 1000;
    this.tz = timezone;
    this.log = log;
    this.timer = null;
    this.running = false;
    // Estado de frps en memoria: si el hub reinicia con frps caído, se vuelve a avisar (es lo deseable)
    this.server = { down: false, since: null, alerted: false, error: null };
    this.lastCheckAt = null; // para la página de estado
    this.lastError = null;
  }

  start() {
    this.timer = setInterval(() => this.tick().catch((e) => this.log.error('alertas:', e.message)), this.intervalMs);
    this.timer.unref?.();
  }
  stop() { clearInterval(this.timer); }

  async notify(alert) {
    const settings = loadSettings(this.store);
    const results = await send(settings, alert, this.tz, this.telegramBase);
    const mid = alert.machine?.id ?? null;
    if (results.length === 0) return results;
    const failed = results.filter((r) => !r.ok);
    if (failed.length) this.store.event(mid, 'alerta_fallida', failed.map((f) => `${f.channel}: ${f.error}`).join(' · '), 0);
    const okc = results.filter((r) => r.ok).map((r) => r.channel);
    if (okc.length) this.store.event(mid, 'alerta_enviada', `${alert.type} → ${okc.join(', ')}`, 0);
    return results;
  }

  /** Diagnóstico de la IA en segundo plano: llega como un segundo mensaje, sin retrasar la alerta. */
  #diagnose(machine, since) {
    if (!this.ai?.ready()) return;
    this.ai.analyzeOffline(machine, since)
      .then((analysis) => analysis && this.notify({ type: 'ai_analysis', at: now(), since, machine, analysis }))
      .catch((e) => this.store.event(machine.id, 'ia_error', `diagnóstico: ${e.message}`, 300));
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try { await this.#check(); this.lastError = null; }
    catch (e) { this.lastError = e.message; throw e; }
    finally { this.running = false; this.lastCheckAt = now(); }
  }

  async #check() {
    const settings = loadSettings(this.store);
    const grace = settings.graceSeconds;
    this.frps.invalidate();
    const status = await this.frps.status();
    const t = now();

    // --- el propio servidor frps ---
    if (!status.reachable) {
      if (!this.server.down) {
        this.server = { down: true, since: t, alerted: false, error: status.error };
        this.store.event(null, 'servidor_caido', status.error || '', 0);
      }
      if (!this.server.alerted && t - this.server.since >= grace) {
        this.server.alerted = true;
        await this.notify({ type: 'server_down', at: t, since: this.server.since, error: status.error });
      }
      return; // sin datos de frps no se puede juzgar a las máquinas
    }
    if (this.server.down) {
      const was = this.server;
      this.server = { down: false, since: null, alerted: false, error: null };
      this.store.event(null, 'servidor_recuperado', `caído ${duration(t - was.since)}`, 0);
      if (was.alerted) await this.notify({ type: 'server_up', at: t, since: was.since, downtimeSeconds: t - was.since });
    }

    // --- cada máquina ---
    for (const m of this.store.listMachines()) {
      const online = status.clients.has(m.id);
      const info = { id: m.id, name: m.name, client: m.client, lastAddress: m.last_client_address || null };

      if (online) {
        if (m.state !== 'online') {
          const downSince = m.state_since;
          this.store.setState(m.id, 'online', t, 0);
          if (m.state === 'offline') this.store.event(m.id, 'reconectada', downSince ? `sin conexión ${duration(t - downSince)}` : '', 0);
          if (m.offline_alerted === 1) {
            await this.notify({ type: 'machine_online', at: t, since: downSince, downtimeSeconds: downSince ? t - downSince : 0, machine: info });
          }
        }
        continue;
      }

      // fuera de línea
      if (m.state === 'online') {
        this.store.setState(m.id, 'offline', t, 0);
        this.store.event(m.id, 'desconectada', '', 0);
      } else if (m.state === 'unknown') {
        // nunca vista en línea: se registra el estado sin alertar
        this.store.setState(m.id, 'offline', t, 2);
      } else if (!m.offline_alerted && t - (m.state_since || t) >= grace) {
        const notify = !!(m.enabled && m.alerts);
        this.store.setAlerted(m.id, notify ? 1 : 2); // se marca antes de enviar para no repetir si el envío tarda
        if (notify) {
          await this.notify({ type: 'machine_offline', at: t, since: m.state_since, machine: info });
          this.#diagnose(info, m.state_since);
        }
      }
    }
  }
}

module.exports = { AlertMonitor, loadSettings, publicSettings, updateSettings, send, duration };
