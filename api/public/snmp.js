'use strict';
// Panel: equipos SNMP de cada sede (lista en el detalle de la máquina, ficha con gráficas, formulario y explorador).
// Usa api(), $, esc, bytes, ago, dateTime, toast, state… de app.js.

const SNMP_STATE = {
  ok: ['online', 'Normal'], warn: ['warn', 'Aviso'], crit: ['down', 'Crítico'], down: ['down', 'Sin respuesta'],
  pendiente: ['warn', 'Pendiente en la sede'], sede_desconectada: ['offline', 'Sede desconectada'],
  sin_transporte: ['down', 'Sin transporte'], unknown: ['offline', 'Sin leer'], deshabilitado: ['disabled', 'Deshabilitado'],
};
const TH_LABEL = {
  chargeMin: 'Carga mínima de batería (%)', runtimeMin: 'Autonomía mínima (min)', loadWarn: 'Carga de salida: aviso (%)',
  loadCrit: 'Carga de salida: crítico (%)', tempMax: 'Temperatura máx. de batería (°C)', errorsPerPoll: 'Errores nuevos por lectura (interfaces vigiladas)',
  supplyWarn: 'Consumible: aviso (%)', supplyCrit: 'Consumible: crítico (%)',
  cpuWarn: 'CPU: aviso (%)', ramWarn: 'RAM: aviso (%)', diskWarn: 'Disco: aviso (%)', diskCrit: 'Disco: crítico (%)',
};
// Colores de las series (validados contra el fondo oscuro: banda de luminosidad, daltonismo y contraste)
const SERIES = ['#0ea5c4', '#9575f0'];

const sn = { profiles: null, open: null, chart: { metric: null, range: '24h' }, editing: null };

function bps(n) {
  if (n == null) return '—';
  const u = ['bps', 'Kbps', 'Mbps', 'Gbps']; let i = 0; let v = n;
  while (v >= 1000 && i < u.length - 1) { v /= 1000; i++; }
  return `${v < 10 && i ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}
function ticks(t) {
  if (t == null) return '—';
  const s = Math.floor(t / 100); const d = Math.floor(s / 86400); const h = Math.floor((s % 86400) / 3600);
  return d ? `${d} d ${h} h` : `${h} h ${Math.floor((s % 3600) / 60)} min`;
}
const stateBadge = (st) => { const [cls, label] = SNMP_STATE[st] || ['offline', st]; return `<span class="snmp-state ${cls}"><span class="dot ${cls}"></span>${label}</span>`; };

/** Resumen corto según el perfil, para listas y tarjetas. */
function snmpSummary(d) {
  const m = d.metrics || {};
  const t = d.tables || {};
  const p = d.detected || d.profile;
  if (p === 'ups' || p === 'ups-apc') {
    return [m.source && `Alimentación: ${m.source}`, m.charge != null && `batería ${m.charge}%`, m.runtime != null && `${m.runtime} min`, m.load != null && `carga ${m.load}%`].filter(Boolean).join(' · ');
  }
  if (p === 'printer') {
    const low = (t.supplies || []).filter((s) => s.percent != null).sort((a, b) => a.percent - b.percent)[0];
    return [m.status, low && `${low.name} ${low.percent}%`].filter(Boolean).join(' · ');
  }
  if (p === 'host') return [m.cpu != null && `CPU ${m.cpu}%`, m.ram != null && `RAM ${m.ram}%`, (t.storage || []).length && `disco máx. ${Math.max(...t.storage.map((x) => x.percent))}%`].filter(Boolean).join(' · ');
  if (p === 'network') return m.portsTotal != null ? `${m.portsUp}/${m.portsTotal} puertos arriba` : '';
  return d.sys?.descr ? d.sys.descr.slice(0, 60) : '';
}

/** Línea de la tarjeta de máquina en el tablero. */
function snmpCardLine(m) {
  const list = state.snmp.filter((d) => d.machine === m.id);
  if (!list.length) return '';
  const crit = list.filter((d) => d.state === 'crit' || d.state === 'down').length;
  const warn = list.filter((d) => d.state === 'warn' || d.state === 'pendiente').length;
  const cls = crit ? 'bad' : warn ? 'warn' : 'good';
  return `<div class="snmp-line ${cls}">📟 ${plural(list.length, 'equipo SNMP', 'equipos SNMP')}${crit ? ` · ${crit} con problema` : warn ? ` · ${warn} con aviso` : ' · todo normal'}</div>`;
}

/** Sección del detalle de la máquina. */
function snmpSection(m) {
  const list = state.snmp.filter((d) => d.machine === m.id);
  if (!list.length && !isStaff()) return '';
  const pending = list.some((d) => d.state === 'pendiente');
  return `<section>
    <h4>📟 Equipos SNMP de la sede</h4>
    ${list.length ? `<div class="snmp-list">${list.map((d) => `<button class="snmp-item" data-snmp-open="${d.id}">
        <div class="snmp-item-head">${stateBadge(d.state)}<b>${esc(d.name)}</b><span class="dim">${esc(d.host)} · ${esc(d.profileLabel)}</span></div>
        <div class="snmp-item-sum">${esc(snmpSummary(d) || d.lastError || 'Sin lecturas todavía')}</div>
        ${(d.alerts || []).filter((a) => a.notified).length ? `<div class="snmp-item-alerts">${d.alerts.filter((a) => a.notified).map((a) => `<span class="tag ${a.level === 'crit' ? 'bad' : 'warn'}">${esc(a.text)}</span>`).join('')}</div>` : ''}
      </button>`).join('')}</div>` : '<div style="color:var(--dim)">Sin equipos SNMP. Agregue las UPS, switches, impresoras o servidores de la red de esta sede.</div>'}
    ${isStaff() ? `<div class="actions" style="margin-top:12px">
      <button class="btn small primary" data-snmp-new="${esc(m.id)}">+ Equipo SNMP</button>
      ${list.length ? `<button class="btn small${pending ? ' primary' : ''}" data-acc="files" data-visitor="${esc(m.id)}">${pending ? '⚠ Aplicar en la sede' : 'Archivo de accesos de la sede'}</button>` : ''}
    </div>
    <div class="hint">El frpc de esta máquina reenvía el SNMP (UDP) de cada equipo de forma privada: solo el hub lo consulta. Después de agregar o cambiar la IP de un equipo, ejecute el script de accesos <b>en esta máquina</b>.</div>` : ''}
  </section>`;
}

$('#drawer').addEventListener('click', (e) => {
  const o = e.target.closest('[data-snmp-open]');
  if (o) return openSnmp(Number(o.dataset.snmpOpen));
  const n = e.target.closest('[data-snmp-new]');
  if (n) return openSnmpForm(null, n.dataset.snmpNew);
});

// ---------- ficha del equipo ----------

async function loadProfiles() {
  if (!sn.profiles) sn.profiles = Object.fromEntries((await api('GET', '/snmp/profiles')).map((p) => [p.id, p]));
  return sn.profiles;
}

async function openSnmp(id) {
  sn.open = id;
  sn.chart = { metric: null, range: sn.chart.range || '24h' };
  $('#snmp-modal').classList.remove('hidden');
  await renderSnmp();
}

function metricValue(meta, v) {
  if (v == null || v === '') return '—';
  if (typeof v === 'number') return `${Number.isInteger(v) ? v.toLocaleString('es-CO') : v.toLocaleString('es-CO', { maximumFractionDigits: 2 })}${meta?.unit ? ` <small>${esc(meta.unit)}</small>` : ''}`;
  return esc(v);
}

function meter(pct, warnAt = 85, critAt = 95, inverse = false) {
  if (pct == null) return '';
  const bad = inverse ? pct <= critAt : pct >= critAt;
  const warn = inverse ? pct <= warnAt : pct >= warnAt;
  return `<div class="meter"><span style="width:${Math.max(0, Math.min(100, pct))}%" class="${bad ? 'bad' : warn ? 'warn' : ''}"></span></div>`;
}

async function renderSnmp() {
  let d;
  try { d = await api('GET', `/snmp/devices/${sn.open}`); } catch (err) { toast(err.message, true); return; }
  const box = $('#snmp-body');
  const meta = { ...(d.meta || {}), ...(d.customMeta || {}) };
  const metrics = d.metrics || {};
  const metricKeys = Object.keys(metrics).filter((k) => metrics[k] != null && metrics[k] !== '');
  const alerts = (d.alerts || []).filter((a) => a.notified || isStaff());
  $('#snmp-title').innerHTML = `${esc(d.name)} ${stateBadge(d.state)}`;
  $('#snmp-sub').textContent = `${d.host}:${d.port} · ${d.profileLabel}${d.version ? ` · SNMP v${d.version}` : ''} · sede ${d.machine}${d.lastOkAt ? ` · leído ${ago(d.lastOkAt)}` : ''}`;
  $('#snmp-actions').innerHTML = isStaff() ? `
    <button class="btn small" data-snmp-act="poll">Consultar ahora</button>
    <button class="btn small" data-snmp-act="explore">Explorar OIDs</button>
    <button class="btn small" data-snmp-act="edit">Configurar</button>
    <button class="btn small danger" data-snmp-act="delete">Eliminar</button>` : '';

  const t = d.tables || {};
  const sys = d.sys || {};
  const info = Object.entries(d.info || {}).filter(([, v]) => v);
  box.innerHTML = `
    ${d.state === 'pendiente' ? `<div class="status-banner warn"><b>⚠ Falta aplicar en la sede</b><ul><li class="warn">${esc(d.lastError || '')}</li></ul>
      ${isStaff() ? `<button class="btn small primary" style="margin-top:8px" data-acc-files-for="${esc(d.machine)}">Descargar accesos de la sede</button>` : ''}</div>` : ''}
    ${d.lastError && !['pendiente'].includes(d.state) ? `<div class="status-banner ${d.state === 'down' || d.state === 'sin_transporte' ? 'bad' : 'warn'}"><b>${esc(SNMP_STATE[d.state]?.[1] || 'Error')}</b><ul><li>${esc(d.lastError)}</li></ul></div>` : ''}
    ${alerts.length ? `<div class="status-banner ${alerts.some((a) => a.level === 'crit') ? 'bad' : 'warn'}"><b>Alertas activas</b><ul>${alerts.map((a) => `<li class="${a.level === 'crit' ? 'bad' : 'warn'}">${a.level === 'crit' ? '✘' : '⚠'} ${esc(a.text)} <span class="dim">· desde ${ago(a.since)}${a.notified ? '' : ' · en gracia'}</span></li>`).join('')}</ul></div>` : ''}

    ${metricKeys.length ? `<div class="snmp-metrics">${metricKeys.map((k) => {
      const mm = meta[k] || { label: k };
      const v = metrics[k];
      const pct = mm.unit === '%' && typeof v === 'number' ? v : null;
      return `<div class="snmp-metric${mm.hist || meta[k]?.hist ? ' clickable' : ''}" ${mm.hist ? `data-chart="${esc(k)}" title="Ver gráfica"` : ''}>
        <div class="k">${esc(mm.label || k)}${mm.hist ? ' <span class="dim">📈</span>' : ''}</div>
        <div class="v">${metricValue(mm, v)}</div>
        ${pct != null ? meter(pct, k === 'charge' ? 50 : 85, k === 'charge' ? 30 : 95, k === 'charge') : ''}
      </div>`;
    }).join('')}</div>` : (d.lastOkAt ? '' : '<div class="hint">Aún no hay lecturas.</div>')}

    <div class="snmp-chart-box">
      <div class="snmp-chart-head">
        <select id="snmp-metric"></select>
        <div class="seg" id="snmp-range">${['6h', '24h', '7d', '30d'].map((r) => `<button class="${sn.chart.range === r ? 'on' : ''}" data-range="${r}">${r}</button>`).join('')}</div>
      </div>
      <div id="snmp-chart" class="snmp-chart"></div>
    </div>

    ${t.supplies?.length ? `<h4 class="section-title">Consumibles</h4><div class="snmp-supplies">${t.supplies.map((s) => `
      <div class="supply"><div class="k">${esc(s.name)}</div><div class="v">${s.percent != null ? `${s.percent}%` : esc(s.state || '—')}</div>${meter(s.percent, 15, 3, true)}</div>`).join('')}</div>` : ''}

    ${t.storage?.length ? `<h4 class="section-title">Discos</h4><table><thead><tr><th>Disco</th><th>Usado</th><th class="hide-sm">Tamaño</th><th></th></tr></thead><tbody>${t.storage.map((s) => `
      <tr><td style="word-break:break-all">${esc(s.name)}</td><td>${s.percent}%</td><td class="hide-sm">${bytes(s.usedBytes)} de ${bytes(s.sizeBytes)}</td><td style="width:30%">${meter(s.percent, 90, 97)}</td></tr>`).join('')}</tbody></table>` : ''}

    ${t.interfaces?.length ? `<h4 class="section-title">Interfaces</h4><div class="hint" style="margin-top:-6px">${isStaff() ? 'Marque "vigilar" en los enlaces importantes (uplinks, servidores): avisa si caen y se grafican.' : ''}</div>
      <table class="snmp-ifs"><thead><tr>${isStaff() ? '<th title="Vigilar">👁</th>' : ''}<th>Interfaz</th><th>Estado</th><th class="hide-sm">Velocidad</th><th>Entrada</th><th>Salida</th><th class="hide-sm">Errores</th></tr></thead><tbody>
      ${t.interfaces.map((i) => `<tr class="${i.oper === 'arriba' ? '' : 'off'}">
        ${isStaff() ? `<td><input type="checkbox" data-watch="${esc(i.index)}" ${(d.watch || []).includes(i.index) ? 'checked' : ''}></td>` : ''}
        <td><b>${esc(i.name)}</b>${i.alias ? `<br><span class="dim">${esc(i.alias)}</span>` : ''}</td>
        <td><span class="tag ${i.oper === 'arriba' ? 'state-online' : 'state-offline'}">${esc(i.oper)}</span></td>
        <td class="hide-sm">${i.speedMbps ? (i.speedMbps >= 1000 ? `${i.speedMbps / 1000} Gbps` : `${i.speedMbps} Mbps`) : '—'}</td>
        <td><a href="#" data-chart="if.${esc(i.index)}" title="Graficar">${bps(i.inBps)}</a></td><td>${bps(i.outBps)}</td>
        <td class="hide-sm">${i.errors || 0}</td></tr>`).join('')}</tbody></table>` : ''}

    <h4 class="section-title">Equipo</h4>
    <dl class="kv">
      ${sys.name ? `<dt>Nombre SNMP</dt><dd>${esc(sys.name)}</dd>` : ''}
      ${sys.descr ? `<dt>Descripción</dt><dd>${esc(sys.descr)}</dd>` : ''}
      ${info.map(([k, v]) => `<dt>${esc(k[0].toUpperCase() + k.slice(1))}</dt><dd>${esc(v)}</dd>`).join('')}
      ${sys.location ? `<dt>Ubicación</dt><dd>${esc(sys.location)}</dd>` : ''}
      ${sys.contact ? `<dt>Contacto</dt><dd>${esc(sys.contact)}</dd>` : ''}
      ${sys.uptimeTicks != null ? `<dt>Encendido hace</dt><dd>${ticks(sys.uptimeTicks)}</dd>` : ''}
      ${d.lastPollAt ? `<dt>Última consulta</dt><dd>${dateTime(d.lastPollAt)}${d.interval ? ` · cada ${d.interval} s` : ''}</dd>` : ''}
    </dl>
    <div id="snmp-explore" class="hidden"></div>`;
  sn.current = d;
  await fillChartOptions(d);
}

/** Opciones de la gráfica: métricas con historial guardado. */
async function fillChartOptions(d) {
  const meta = { ...(d.meta || {}), ...(d.customMeta || {}) };
  let h;
  try { h = await api('GET', `/snmp/devices/${d.id}/history?range=6h`); } catch { h = { available: [] }; }
  const opts = [];
  const seen = new Set();
  for (const m of h.available) {
    let key = m; let label;
    const ifm = /^if\.(\d+)\.(in|out)$/.exec(m);
    if (ifm) {
      key = `if.${ifm[1]}`;
      if (seen.has(key)) continue;
      const i = (d.tables?.interfaces || []).find((x) => x.index === ifm[1]);
      label = `Tráfico ${i ? i.name : ifm[1]}`;
    } else if (/^supply\.\d+$/.test(m)) {
      const s = (d.tables?.supplies || []).find((x) => `supply.${x.index}` === m);
      label = `Consumible: ${s ? s.name : m}`;
    } else if (/^disk\.\d+$/.test(m)) {
      const s = (d.tables?.storage || []).find((x) => `disk.${x.index}` === m);
      label = `Disco ${s ? s.name : m}`;
    } else label = meta[m]?.label || m;
    seen.add(key);
    opts.push([key, label]);
  }
  // Orden: métricas del perfil en su orden (carga, autonomía…), luego interfaces, consumibles, discos y OIDs propios
  const order = Object.keys(meta);
  const rank = (k) => { const i = order.indexOf(k); return i >= 0 ? i : /^if\./.test(k) ? 100 : /^supply\./.test(k) ? 200 : /^disk\./.test(k) ? 300 : 400; };
  opts.sort((a, b) => rank(a[0]) - rank(b[0]));
  const sel = $('#snmp-metric');
  if (!opts.length) {
    sel.innerHTML = '<option>Sin historial todavía</option>';
    sel.disabled = true;
    $('#snmp-chart').innerHTML = '<div class="chart-empty">El historial se guarda cada 5 minutos: aparecerá después de las primeras lecturas.</div>';
    return;
  }
  sel.disabled = false;
  sel.innerHTML = opts.map(([k, l]) => `<option value="${esc(k)}">${esc(l)}</option>`).join('');
  if (!sn.chart.metric || !opts.some(([k]) => k === sn.chart.metric)) sn.chart.metric = opts[0][0];
  sel.value = sn.chart.metric;
  drawChart();
}

async function drawChart() {
  const d = sn.current;
  const key = sn.chart.metric;
  const isIf = /^if\.\d+$/.test(key);
  const metrics = isIf ? [`${key}.in`, `${key}.out`] : [key];
  let h;
  try { h = await api('GET', `/snmp/devices/${d.id}/history?range=${sn.chart.range}&metric=${encodeURIComponent(metrics.join(','))}`); }
  catch (err) { $('#snmp-chart').innerHTML = `<div class="chart-empty">${esc(err.message)}</div>`; return; }
  const meta = { ...(d.meta || {}), ...(d.customMeta || {}) };
  const unit = isIf ? 'bps' : /^(supply|disk)\./.test(key) ? '%' : meta[key]?.unit || '';
  const fmt = isIf ? bps : (v) => `${v.toLocaleString('es-CO', { maximumFractionDigits: 1 })}${unit ? ' ' + unit : ''}`;
  const series = metrics.map((m, i) => ({ name: isIf ? (i ? 'Salida' : 'Entrada') : ($('#snmp-metric').selectedOptions[0]?.textContent || m), color: SERIES[i], pts: h.series[m] || [] }));
  const width = Math.max(280, Math.round($('#snmp-chart').clientWidth || 720));
  $('#snmp-chart').innerHTML = lineChart(series, { from: h.from, to: h.to, fmt, max: unit === '%' ? 100 : null, width });
  bindChartHover(series, fmt);
}

/** Gráfica de líneas en SVG: eje Y con valores redondos, línea de 2 px, área tenue, retícula fina. */
function lineChart(series, { from, to, fmt, max, width = 720 }) {
  const all = series.flatMap((s) => s.pts.map((p) => p[1]));
  if (!all.length) return '<div class="chart-empty">Sin datos en este rango.</div>';
  // Se dibuja al ancho real del contenedor: el texto no se deforma en pantallas angostas
  const W = width; const H = width < 500 ? 180 : 220; const L = 64; const R = 12; const T = 12; const B = 26;
  let hi = max ?? Math.max(...all);
  if (hi <= 0) hi = 1;
  const step = niceStep(hi / 4);
  hi = max ?? Math.ceil(hi / step) * step;
  const x = (ts) => L + ((ts - from) / (to - from)) * (W - L - R);
  const y = (v) => T + (1 - v / hi) * (H - T - B);
  const grid = [];
  for (let v = 0; v <= hi + 1e-9; v += step) {
    grid.push(`<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${L - 6}" y="${y(v) + 4}" class="axis" text-anchor="end">${esc(fmt(v))}</text>`);
  }
  const span = to - from;
  const nT = W < 500 ? 3 : 6;
  for (let i = 0; i <= nT; i++) {
    const ts = from + (span * i) / nT;
    const dt = new Date(ts * 1000);
    const lbl = span <= 86400 ? dt.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', hour12: false }) : dt.toLocaleDateString('es-CO', { day: 'numeric', month: 'short' });
    grid.push(`<text x="${x(ts)}" y="${H - 6}" class="axis" text-anchor="${i === 0 ? 'start' : i === nT ? 'end' : 'middle'}">${esc(lbl)}</text>`);
  }
  const paths = series.map((s) => {
    if (!s.pts.length) return '';
    // Cortes de más de 3 intervalos (equipo sin respuesta) se dejan en blanco
    let dLine = ''; let prev = null;
    for (const [ts, v] of s.pts) { dLine += `${!prev || ts - prev > 1800 * 3 ? 'M' : 'L'}${x(ts).toFixed(1)},${y(v).toFixed(1)}`; prev = ts; }
    const first = s.pts[0]; const last = s.pts[s.pts.length - 1];
    const area = series.length === 1 ? `<path d="${dLine}L${x(last[0]).toFixed(1)},${y(0)}L${x(first[0]).toFixed(1)},${y(0)}Z" fill="${s.color}" opacity=".1"/>` : '';
    return `${area}<path d="${dLine}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="${x(last[0])}" cy="${y(last[1])}" r="4" fill="${s.color}" stroke="var(--panel)" stroke-width="2"/>`;
  }).join('');
  const legend = series.length > 1 ? `<div class="chart-legend">${series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join('')}</div>` : '';
  const stats = series.map((s) => {
    const v = s.pts.map((p) => p[1]);
    if (!v.length) return '';
    return `<span>${series.length > 1 ? `${esc(s.name)}: ` : ''}mín. ${esc(fmt(Math.min(...v)))} · prom. ${esc(fmt(v.reduce((a, b) => a + b, 0) / v.length))} · máx. ${esc(fmt(Math.max(...s.pts.map((p) => p[2]))))}</span>`;
  }).join('');
  return `${legend}<div class="chart-wrap"><svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" class="chart-svg" data-from="${from}" data-to="${to}" data-l="${L}" data-r="${R}" data-w="${W}">
    ${grid.join('')}${paths}<line class="cross hidden" y1="${T}" y2="${H - B}"/></svg><div class="chart-tip hidden"></div></div>
    <div class="chart-stats">${stats}</div>`;
}

function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(raw || 1));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

/** Línea vertical + globo con el valor más cercano de cada serie. */
function bindChartHover(series, fmt) {
  const wrap = $('#snmp-chart .chart-wrap');
  if (!wrap) return;
  const svg = $('svg', wrap); const tip = $('.chart-tip', wrap); const cross = $('.cross', svg);
  const from = +svg.dataset.from; const to = +svg.dataset.to; const L = +svg.dataset.l; const R = +svg.dataset.r; const W = +svg.dataset.w;
  wrap.onmousemove = (e) => {
    const r = svg.getBoundingClientRect();
    const sx = ((e.clientX - r.left) / r.width) * W;
    if (sx < L || sx > W - R) { tip.classList.add('hidden'); cross.classList.add('hidden'); return; }
    const ts = from + ((sx - L) / (W - L - R)) * (to - from);
    const rows = series.map((s) => {
      let best = null;
      for (const p of s.pts) if (!best || Math.abs(p[0] - ts) < Math.abs(best[0] - ts)) best = p;
      return best && Math.abs(best[0] - ts) < (to - from) / 50 ? { s, p: best } : null;
    }).filter(Boolean);
    if (!rows.length) { tip.classList.add('hidden'); cross.classList.add('hidden'); return; }
    const px = L + ((rows[0].p[0] - from) / (to - from)) * (W - L - R);
    cross.setAttribute('x1', px); cross.setAttribute('x2', px); cross.classList.remove('hidden');
    tip.innerHTML = `<div class="dim">${new Date(rows[0].p[0] * 1000).toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' })}</div>`
      + rows.map(({ s, p }) => `<div><i style="background:${s.color}"></i>${series.length > 1 ? `${esc(s.name)}: ` : ''}<b>${esc(fmt(p[1]))}</b></div>`).join('');
    tip.classList.remove('hidden');
    const left = ((px / W) * r.width);
    tip.style.left = `${Math.min(r.width - tip.offsetWidth - 4, Math.max(4, left + 10))}px`;
  };
  wrap.onmouseleave = () => { tip.classList.add('hidden'); cross.classList.add('hidden'); };
}

$('#snmp-modal').addEventListener('change', async (e) => {
  if (e.target.id === 'snmp-metric') { sn.chart.metric = e.target.value; drawChart(); }
  const w = e.target.closest('[data-watch]');
  if (w) {
    const watch = $$('#snmp-modal [data-watch]:checked').map((x) => x.dataset.watch);
    try { await api('PATCH', `/snmp/devices/${sn.open}`, { watch }); toast(w.checked ? 'Interfaz vigilada' : 'Interfaz sin vigilancia'); }
    catch (err) { toast(err.message, true); w.checked = !w.checked; }
  }
});

$('#snmp-modal').addEventListener('click', async (e) => {
  const rg = e.target.closest('[data-range]');
  if (rg) { sn.chart.range = rg.dataset.range; $$('#snmp-range button').forEach((b) => b.classList.toggle('on', b === rg)); return drawChart(); }
  const ch = e.target.closest('[data-chart]');
  if (ch) {
    e.preventDefault();
    const opt = [...$('#snmp-metric').options].find((o) => o.value === ch.dataset.chart);
    if (!opt) return toast('Esa métrica aún no tiene historial (se guarda cada 5 min)');
    sn.chart.metric = ch.dataset.chart; $('#snmp-metric').value = sn.chart.metric; drawChart();
    $('#snmp-chart').scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  const af = e.target.closest('[data-acc-files-for]');
  if (af) { const m = state.machines.find((x) => x.id === af.dataset.accFilesFor); if (m) accessAction(m, 'files', { visitor: m.id }); return; }
  const addOid = e.target.closest('[data-add-oid]');
  if (addOid) return addCustomOid(addOid.dataset.addOid, addOid.dataset.name);
  const act = e.target.closest('[data-snmp-act]')?.dataset.snmpAct;
  if (!act) return;
  const d = sn.current;
  try {
    if (act === 'poll') {
      const b = e.target.closest('button'); b.disabled = true; b.textContent = 'Consultando…';
      const r = await api('POST', `/snmp/devices/${d.id}/poll`);
      toast(r.result?.ok ? 'Lectura actualizada' : `Sin lectura: ${r.result?.error || 'error'}`, !r.result?.ok);
      await renderSnmp(); refresh();
    }
    if (act === 'edit') openSnmpForm(d, d.machine);
    if (act === 'explore') toggleExplorer(d);
    if (act === 'delete') {
      if (!confirm(`¿Eliminar el equipo SNMP "${d.name}"? Se borra su historial.`)) return;
      await api('DELETE', `/snmp/devices/${d.id}`);
      $('#snmp-modal').classList.add('hidden');
      toast('Equipo SNMP eliminado'); refresh();
    }
  } catch (err) { toast(err.message, true); }
});

// ---------- explorador de OIDs ----------

function toggleExplorer(d) {
  const box = $('#snmp-explore');
  if (!box.classList.contains('hidden')) { box.classList.add('hidden'); return; }
  box.innerHTML = `<h4 class="section-title">Explorar OIDs</h4>
    <form id="snmp-walk" class="row" style="align-items:end">
      <div class="field" style="margin:0"><label>Recorrer desde</label><input name="oid" value="1.3.6.1.2.1.1" placeholder="1.3.6.1.2.1.1"></div>
      <div style="flex:none"><button class="btn small primary" type="submit">Recorrer</button></div>
    </form>
    <div class="hint">Ejemplos: 1.3.6.1.2.1.1 (sistema) · 1.3.6.1.2.1.33 (UPS-MIB) · 1.3.6.1.2.1.43 (impresoras) · 1.3.6.1.4.1 (MIB del fabricante). Máximo 500 valores.</div>
    <div id="snmp-walk-out"></div>`;
  box.classList.remove('hidden');
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

$('#snmp-modal').addEventListener('submit', async (e) => {
  if (e.target.id !== 'snmp-walk') return;
  e.preventDefault();
  const out = $('#snmp-walk-out');
  out.innerHTML = '<div class="hint">Consultando…</div>';
  try {
    const rows = await api('GET', `/snmp/devices/${sn.open}/walk?oid=${encodeURIComponent(e.target.elements.oid.value.trim())}`);
    out.innerHTML = rows.length ? `<table class="walk"><thead><tr><th>OID</th><th>Tipo</th><th>Valor</th><th></th></tr></thead><tbody>${rows.map((r) => `
      <tr><td style="font-family:var(--code);font-size:11px;word-break:break-all">${esc(r.oid)}</td><td class="dim">${esc(r.type)}</td><td style="word-break:break-all">${esc(r.value)}</td>
      <td>${isStaff() ? `<button class="btn icon small" data-add-oid="${esc(r.oid)}" data-name="" title="Agregar como OID propio">＋</button>` : ''}</td></tr>`).join('')}</tbody></table>`
      : '<div class="hint">El equipo no devolvió valores bajo ese OID.</div>';
  } catch (err) { out.innerHTML = `<div class="error">${esc(err.message)}</div>`; }
});

async function addCustomOid(oid) {
  const name = prompt(`Nombre para ${oid}`, '');
  if (!name) return;
  const d = sn.current;
  const custom = [...(d.custom || []), { name, oid, unit: '', scale: 1, hist: true }];
  try {
    await api('PATCH', `/snmp/devices/${d.id}`, { custom });
    toast('OID agregado: se leerá en la próxima consulta');
    await renderSnmp();
  } catch (err) { toast(err.message, true); }
}

// ---------- formulario ----------

async function openSnmpForm(d, machineId) {
  const profiles = await loadProfiles();
  sn.editing = d;
  const f = $('#snmp-form');
  f.reset();
  $('#snmp-form-error').textContent = '';
  $('#snmp-form-title').textContent = d ? `Configurar ${d.name}` : 'Nuevo equipo SNMP';
  f.dataset.machine = machineId;
  f.elements.profile.innerHTML = `<option value="auto">Automático (detectar)</option>${Object.values(profiles).map((p) => `<option value="${p.id}">${esc(p.label)}</option>`).join('')}`;
  const set = (k, v) => { if (f.elements[k] && v !== undefined && v !== null) f.elements[k].value = v; };
  if (d) {
    set('name', d.name); set('host', d.host); set('port', d.port); set('version', d.version); set('community', d.community);
    set('user', d.user); set('authProtocol', d.authProtocol === 'none' ? 'none' : d.authProtocol); set('authKey', d.authKey);
    set('privProtocol', d.privProtocol); set('privKey', d.privKey); set('profile', d.profile); set('interval', d.interval);
    f.elements.alerts.checked = d.alertsEnabled; f.elements.enabled.checked = d.enabled;
  } else {
    set('port', 161); set('version', '2c'); set('interval', 60); set('authProtocol', 'sha'); set('privProtocol', 'aes');
    f.elements.alerts.checked = true; f.elements.enabled.checked = true;
  }
  $('#snmp-custom').innerHTML = '';
  for (const c of d?.custom || []) addCustomRow(c);
  syncSnmpForm();
  $('#snmp-form-modal').classList.remove('hidden');
  f.elements.name.focus();
}

function syncSnmpForm() {
  const f = $('#snmp-form');
  const v3 = f.elements.version.value === '3';
  $$('#snmp-form [data-v]').forEach((el) => el.classList.toggle('hidden', el.dataset.v !== (v3 ? '3' : '2c')));
  const auth = f.elements.authProtocol.value !== 'none';
  f.elements.authKey.disabled = !auth;
  f.elements.privProtocol.disabled = !auth;
  if (!auth) f.elements.privProtocol.value = 'none';
  f.elements.privKey.disabled = !auth || f.elements.privProtocol.value === 'none';
  // Umbrales del perfil elegido (o del detectado)
  const pid = f.elements.profile.value === 'auto' ? (sn.editing?.detected || null) : f.elements.profile.value;
  const p = pid && sn.profiles[pid];
  const cur = sn.editing?.thresholds || {};
  $('#snmp-th').innerHTML = p && Object.keys(p.thresholds).length
    ? `<label>Umbrales de alerta · ${esc(p.label)}</label><div class="th-grid">${Object.entries(p.thresholds).map(([k, def]) => `
        <div class="field" style="margin:0"><label>${esc(TH_LABEL[k] || k)}</label><input type="number" step="any" data-th="${k}" value="${cur[k] ?? ''}" placeholder="${def}"></div>`).join('')}</div>
      <div class="hint">Vacío = valor por defecto.</div>`
    : `<div class="hint">${f.elements.profile.value === 'auto' ? 'Los umbrales aparecen cuando el hub detecte el tipo de equipo (o elija el perfil).' : 'Este perfil no tiene umbrales propios: use OIDs con condición.'}</div>`;
}

function addCustomRow(c = {}) {
  const row = document.createElement('div');
  row.className = 'custom-row';
  row.innerHTML = `
    <input data-c="name" placeholder="Nombre" value="${esc(c.name || '')}" maxlength="40">
    <input data-c="oid" placeholder="1.3.6.1.…" value="${esc(c.oid || '')}" style="font-family:var(--code)">
    <input data-c="unit" placeholder="Unidad" value="${esc(c.unit || '')}" maxlength="10">
    <input data-c="scale" type="number" step="any" placeholder="×1" value="${c.scale && c.scale !== 1 ? c.scale : ''}" title="Multiplicar el valor (p. ej. 0.1)">
    <select data-c="op" title="Alertar si…"><option value="">sin alerta</option>${['>', '>=', '<', '<=', '==', '!='].map((o) => `<option ${c.op === o ? 'selected' : ''}>${o}</option>`).join('')}</select>
    <input data-c="limit" placeholder="valor" value="${esc(c.limit ?? '')}">
    <select data-c="level"><option value="warn">aviso</option><option value="crit" ${c.level === 'crit' ? 'selected' : ''}>crítico</option></select>
    <div class="custom-end"><label class="check" title="Guardar historial y graficar"><input type="checkbox" data-c="hist" ${c.hist ? 'checked' : ''}> historial</label>
    <button type="button" class="btn icon small danger" data-c-del title="Quitar">✕</button></div>`;
  $('#snmp-custom').appendChild(row);
}

$('#snmp-form').addEventListener('change', (e) => { if (['version', 'authProtocol', 'privProtocol', 'profile'].includes(e.target.name)) syncSnmpForm(); });
$('#snmp-form').addEventListener('click', (e) => {
  if (e.target.id === 'snmp-add-custom') addCustomRow();
  if (e.target.closest('[data-c-del]')) e.target.closest('.custom-row').remove();
});

$('#snmp-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  const body = {
    name: f.name.value.trim(), host: f.host.value.trim(), port: Number(f.port.value) || 161, version: f.version.value,
    profile: f.profile.value, interval: Number(f.interval.value) || 60, alerts: f.alerts.checked, enabled: f.enabled.checked,
    thresholds: Object.fromEntries($$('#snmp-th [data-th]').map((i) => [i.dataset.th, i.value])),
    custom: $$('#snmp-custom .custom-row').map((r) => {
      const g = (k) => $(`[data-c="${k}"]`, r);
      return { name: g('name').value.trim(), oid: g('oid').value.trim(), unit: g('unit').value.trim(), scale: g('scale').value || 1, op: g('op').value, limit: g('limit').value, level: g('level').value, hist: g('hist').checked };
    }).filter((c) => c.oid),
  };
  if (body.version === '2c') body.community = f.community.value;
  else Object.assign(body, { user: f.user.value.trim(), authProtocol: f.authProtocol.value, authKey: f.authKey.value, privProtocol: f.privProtocol.value, privKey: f.privKey.value });
  $('#snmp-form-error').textContent = '';
  try {
    let d;
    if (sn.editing) d = await api('PATCH', `/snmp/devices/${sn.editing.id}`, body);
    else d = await api('POST', '/snmp/devices', { ...body, machine: e.target.dataset.machine });
    $('#snmp-form-modal').classList.add('hidden');
    await refresh();
    const changedAddr = sn.editing && (sn.editing.host !== d.host || sn.editing.port !== d.port);
    if (!sn.editing || changedAddr) {
      // Siguiente paso: aplicar el archivo de accesos en la máquina de la sede
      const m = state.machines.find((x) => x.id === d.machine);
      if (m) {
        await accessAction(m, 'files', { visitor: m.id });
        $('#access-next h2').textContent = `Aplicar "${d.name}" en la sede ${m.name}`;
      }
    } else {
      toast('Equipo actualizado');
      if (sn.open === d.id) renderSnmp();
    }
  } catch (err) { $('#snmp-form-error').textContent = err.message; }
});
