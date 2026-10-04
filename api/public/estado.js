'use strict';
// Panel: estado del propio hub y respaldos de la base (solo administrador). Usa api(), $, esc, bytes… de app.js.

const est = { timer: null, last: null };

function span(sec) {
  if (sec === null || sec === undefined) return '—';
  sec = Math.max(0, Math.round(sec));
  const d = Math.floor(sec / 86400); const h = Math.floor((sec % 86400) / 3600); const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d} d ${h} h`;
  if (h) return `${h} h ${m} min`;
  if (m) return `${m} min`;
  return `${sec} s`;
}
const yes = (ok, a = 'sí', b = 'no') => `<b class="${ok ? 'ok' : 'ko'}">${ok ? a : b}</b>`;
const kv = (rows) => `<dl class="kv">${rows.filter(Boolean).map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;
const LEVEL = { bad: '✘', warn: '⚠', info: 'ℹ' };
const OVERALL = {
  ok: { cls: 'good', text: '✔ Todo en orden' },
  atención: { cls: 'warn', text: '⚠ Requiere atención' },
  falla: { cls: 'bad', text: '✘ Hay fallas' },
};

/** Punto de color en el botón 🩺 del encabezado (se consulta cada 30 s). */
async function statusDot() {
  if (role() !== 'admin') return;
  try {
    const s = await api('GET', '/status');
    est.last = s;
    const dot = $('#status-dot');
    dot.className = 'dot ' + (s.overall === 'ok' ? 'online' : s.overall === 'falla' ? 'down' : 'warn');
    $('#status-btn').title = `Estado del hub: ${OVERALL[s.overall].text.slice(2)}${s.warnings.length ? ` · ${s.warnings.length} aviso(s)` : ''}`;
  } catch {}
}

async function openStatus() {
  $('#status-modal').classList.remove('hidden');
  await Promise.all([loadStatus(), loadBackups()]);
  clearInterval(est.timer);
  est.timer = setInterval(() => { if ($('#status-modal').classList.contains('hidden')) clearInterval(est.timer); else loadStatus(); }, 10000);
}

async function loadStatus() {
  let s;
  try { s = await api('GET', '/status'); } catch (err) { toast(err.message, true); return; }
  est.last = s;
  const o = OVERALL[s.overall];
  $('#status-sub').textContent = `${s.hub.hostname} · versión ${s.hub.version} · actualizado ${new Date(s.at * 1000).toLocaleTimeString('es-CO')}`;
  $('#status-banner').innerHTML = `<div class="status-banner ${o.cls}"><b>${o.text}</b>
    ${s.warnings.length ? `<ul>${s.warnings.map((w) => `<li class="${w.level}">${LEVEL[w.level]} ${esc(w.text)}</li>`).join('')}</ul>` : ''}</div>`;

  const ops = Object.entries(s.plugin.byOp || {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${esc(k)} ${v}`).join(' · ');
  const disk = s.disk ? `<div class="meter"><span style="width:${s.disk.usedPct}%" class="${s.disk.usedPct >= 95 ? 'bad' : s.disk.usedPct >= 85 ? 'warn' : ''}"></span></div>
      ${kv([['Usado', `${s.disk.usedPct}% de ${bytes(s.disk.total)}`], ['Libre', bytes(s.disk.free)], ['Carpeta', `<code>${esc(s.disk.dir)}</code>`]])}` : '<div class="hint">No disponible</div>';
  const cards = [
    ['🖥 Hub', kv([
      ['En marcha', `${span(s.hub.uptimeSeconds)} <span class="dim">(desde ${dateTime(s.hub.startedAt)})</span>`],
      ['Versión', `${esc(s.hub.version)} · Node ${esc(s.hub.node)}`],
      ['Sistema', `${esc(s.hub.platform)} · ${s.hub.system.cpus} CPU${s.hub.system.load ? ` · carga ${s.hub.system.load.join(' / ')}` : ''}`],
      ['Memoria', `hub ${bytes(s.hub.memory.rss)} · equipo ${bytes(s.hub.system.totalMem - s.hub.system.freeMem)} de ${bytes(s.hub.system.totalMem)}`],
      ['Panel', `<code>${esc(s.hub.panel)}</code>`],
    ])],
    ['🔌 frps', kv([
      ['Estado', s.frps.reachable ? `<b class="ok">responde</b> · ${s.frps.latencyMs} ms` : `<b class="ko">sin respuesta</b> · ${esc(s.frps.error || '')}`],
      ['Versión', esc(s.frps.version || '—')],
      ['Máquinas en línea', s.frps.clientsOnline],
      ['Túneles activos', s.frps.proxies],
      ['Dirección pública', `<code>${esc(s.frps.publicAddr)}:${s.frps.bindPort}</code>`],
      ['Token global', yes(s.frps.authToken, 'configurado', 'vacío')],
    ])],
    ['🛡 Plugin de frps', kv([
      ['Escuchando', `${yes(s.plugin.listening)} · <code>${esc(s.plugin.address)}</code>`],
      ['Consultas', `${s.plugin.calls} · rechazos ${s.plugin.rejects} · errores ${s.plugin.errors}`],
      ['Última', s.plugin.lastAt ? ago(s.plugin.lastAt) : 'ninguna'],
      ops && ['Por operación', `<span class="dim">${ops}</span>`],
    ])],
    ['🗄 Base de datos', kv([
      ['Tamaño', `${bytes(s.db.size)}${s.db.walSize ? ` + WAL ${bytes(s.db.walSize)}` : ''}`],
      ['Escritura', yes(s.db.writable, 'correcta', 'BLOQUEADA')],
      ['Contenido', `${s.db.counts.machines} máquinas · ${s.db.counts.services} servicios · ${s.db.counts.clients} clientes`],
      ['Personas', `${s.db.counts.users} usuarios · ${s.db.counts.sessions} sesiones activas`],
      ['Eventos', s.db.counts.events],
      ['Archivo', `<code>${esc(s.db.path)}</code>`],
    ])],
    ['💽 Disco', disk],
    ['📟 SNMP', kv([
      ['Equipos', `${s.snmp.enabled} activos de ${s.snmp.devices}${s.snmp.devices ? ` · <b class="ok">${s.snmp.ok} normal</b>${s.snmp.warn ? ` · ${s.snmp.warn} aviso` : ''}${s.snmp.crit ? ` · <b class="ko">${s.snmp.crit} crítico</b>` : ''}${s.snmp.down ? ` · <b class="ko">${s.snmp.down} sin respuesta</b>` : ''}${s.snmp.pending ? ` · ${s.snmp.pending} pendiente(s)` : ''}` : ''}`],
      ['Consultas', `${s.snmp.polls} · ${s.snmp.errors} con error`],
      ['frpc del hub', !s.snmp.hubFrpc ? '—' : !s.snmp.hubFrpc.available ? '<b class="ko">no instalado</b>'
        : s.snmp.hubFrpc.running ? `<b class="ok">corriendo</b> · ${s.snmp.hubFrpc.visitors} túnel(es)${s.snmp.hubFrpc.lastLoginAt ? ` · entró ${ago(s.snmp.hubFrpc.lastLoginAt)}` : ''}` : '<b class="ko">detenido</b>'],
      s.snmp.hubFrpc?.lastError && ['Último error', `<span class="dim">${esc(s.snmp.hubFrpc.lastError)}</span>`],
    ])],
    ['🔔 Alertas, Telegram e IA', kv([
      ['Monitor', s.monitor.lastCheckAt ? `revisó ${ago(s.monitor.lastCheckAt)} · cada ${s.monitor.intervalSeconds} s` : 'aún no revisa'],
      ['Canales', [s.monitor.channels.telegram && 'Telegram', s.monitor.channels.webhooks && `${s.monitor.channels.webhooks} webhook(s)`].filter(Boolean).join(' y ') || '<b class="ko">ninguno</b>'],
      ['Bot de Telegram', s.telegram.enabled ? (s.telegram.lastError ? `<b class="ko">error</b> · ${esc(s.telegram.lastError)}` : `<b class="ok">activo</b>${s.telegram.lastOkAt ? ` · ${ago(s.telegram.lastOkAt)}` : ''}`) : 'apagado'],
      ['IA', s.ai.ready ? `<b class="ok">lista</b> · ${esc(s.ai.model)}${s.ai.pending ? ` · ${s.ai.pending} pendiente(s)` : ''}` : (s.ai.enabled ? '<b class="ko">sin clave</b>' : 'apagada')],
      ['API', `${s.api.requests} peticiones · ${s.api.errors} errores${s.api.lastError ? ` · último ${ago(s.api.lastError.at)}: ${esc(s.api.lastError.message)}` : ''}`],
    ])],
  ];
  $('#status-grid').innerHTML = cards.map(([t, body]) => `<div class="status-card"><h5>${t}</h5>${body}</div>`).join('');
  statusDotFrom(s);
}

function statusDotFrom(s) {
  $('#status-dot').className = 'dot ' + (s.overall === 'ok' ? 'online' : s.overall === 'falla' ? 'down' : 'warn');
}

// ---------- respaldos ----------

async function loadBackups() {
  let b;
  try { b = await api('GET', '/backups'); } catch (err) { $('#backup-error').textContent = err.message; return; }
  const f = $('#backup-form');
  if (!f.elements.hour.options.length) {
    for (let h = 0; h < 24; h++) f.elements.hour.add(new Option(`${String(h).padStart(2, '0')}:00`, h));
  }
  f.elements.enabled.checked = b.settings.enabled;
  f.elements.hour.value = String(b.settings.hour);
  if (![...f.elements.keep.options].some((o) => Number(o.value) === b.settings.keep)) f.elements.keep.add(new Option(`${b.settings.keep} respaldos`, b.settings.keep));
  f.elements.keep.value = String(b.settings.keep);

  const last = b.state.last;
  $('#backup-info').innerHTML = kv([
    ['Último', last ? (last.ok ? `<b class="ok">correcto</b> · ${ago(last.at)} · ${esc(last.name)} · ${bytes(last.size)}` : `<b class="ko">falló</b> ${ago(last.at)} · ${esc(last.error)}`) : 'todavía ninguno'],
    ['Próximo', b.settings.enabled ? (b.nextAt ? dateTime(b.nextAt) : '—') : 'automáticos apagados'],
    ['Cifrado', b.encrypted ? '<b class="ok">sí</b> (BACKUP_KEY)' : 'no · defina <code>BACKUP_KEY</code> para cifrarlos'],
    ['Carpeta', `<code>${esc(b.dir)}</code>`],
  ]);
  $('#backup-list').innerHTML = b.list.length ? `<table>
    <thead><tr><th>Respaldo</th><th class="hide-sm">Tipo</th><th>Tamaño</th><th class="hide-sm">Fecha</th><th></th></tr></thead>
    <tbody>${b.list.map((x) => `<tr>
      <td style="font-family:var(--code);font-size:11px;word-break:break-all">${esc(x.name)}${x.encrypted ? ' 🔒' : ''}</td>
      <td class="hide-sm"><span class="tag ${x.kind === 'auto' ? 'http' : 'tcp'}">${x.kind === 'auto' ? 'automático' : 'manual'}</span></td>
      <td style="white-space:nowrap">${bytes(x.size)}</td>
      <td class="hide-sm" style="white-space:nowrap">${dateTime(x.at)}</td>
      <td class="row-btns"><button class="btn small" data-bk-get="${esc(x.name)}">Descargar</button>
        <button class="btn icon small danger" data-bk-del="${esc(x.name)}" title="Eliminar">✕</button></td>
    </tr>`).join('')}</tbody></table>` : '<div style="color:var(--dim)">No hay respaldos todavía.</div>';
}

/** Descarga binaria: api() devuelve texto, que dañaría el archivo. */
async function downloadBackup(name) {
  const res = await fetch(`/api/backups/${encodeURIComponent(name)}`, {
    credentials: 'same-origin',
    headers: { 'x-requested-with': 'iit-panel', ...(state.token ? { authorization: 'Bearer ' + state.token } : {}) },
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Error ${res.status}`);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(await res.blob());
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

$('#status-btn').addEventListener('click', openStatus);
$('#status-refresh').addEventListener('click', () => { loadStatus(); loadBackups(); });

$('#backup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  $('#backup-error').textContent = '';
  try {
    await api('PUT', '/backups/settings', { enabled: f.enabled.checked, hour: Number(f.hour.value), keep: Number(f.keep.value) });
    toast('Respaldos configurados');
    loadBackups(); loadStatus();
  } catch (err) { $('#backup-error').textContent = err.message; }
});

$('#backup-now').addEventListener('click', async () => {
  const btn = $('#backup-now');
  btn.disabled = true; btn.textContent = 'Respaldando…';
  $('#backup-error').textContent = '';
  try {
    const r = await api('POST', '/backups');
    toast(`Respaldo listo: ${bytes(r.size)} en ${r.durationMs} ms`);
  } catch (err) { $('#backup-error').textContent = err.message; }
  finally { btn.disabled = false; btn.textContent = 'Respaldar ahora'; loadBackups(); loadStatus(); }
});

$('#backup-list').addEventListener('click', async (e) => {
  const g = e.target.closest('[data-bk-get]');
  const d = e.target.closest('[data-bk-del]');
  try {
    if (g) await downloadBackup(g.dataset.bkGet);
    if (d) {
      if (!confirm(`¿Eliminar el respaldo ${d.dataset.bkDel}?`)) return;
      await api('DELETE', `/backups/${encodeURIComponent(d.dataset.bkDel)}`);
      toast('Respaldo eliminado');
      loadBackups();
    }
  } catch (err) { toast(err.message, true); }
});

// El punto del botón se actualiza cada 30 s (la consulta prueba frps y la base)
setInterval(() => { if (state.me && !document.hidden) statusDot(); }, 30000);
