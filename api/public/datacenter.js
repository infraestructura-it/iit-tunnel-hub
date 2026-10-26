'use strict';
// Ventana Datacenter: tarjetas de sensores (temp/humedad/CO/aperturas/energía), cámaras IP y
// gráficas históricas. Usa la sesión del panel (misma cookie). Las lecturas llegan por push a /api/dc/ingest.

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let DATA = { sensors: [], cameras: [], machines: {} };
let site = ''; // filtro de sede (machineId) o '' = todas

async function api(method, path, body) {
  const opt = { method, headers: {}, credentials: 'same-origin' };
  if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  if (method !== 'GET') opt.headers['X-Requested-With'] = 'iit-panel';
  const r = await fetch('/api' + path, opt);
  if (r.status === 401) { document.body.innerHTML = '<div style="padding:60px;text-align:center;color:var(--muted)">Inicie sesión en el panel y vuelva a abrir el Datacenter.</div>'; throw new Error('sin sesión'); }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || ('error ' + r.status));
  return d;
}

const ICON = { temperatura: '🌡', humedad: '💧', monoxido: '🟤', apertura: '🚪', energia: '⚡' };
function rel(ts) {
  const s = Math.floor(Date.now() / 1000) - ts;
  if (s < 60) return 'hace ' + s + 's';
  if (s < 3600) return 'hace ' + Math.floor(s / 60) + 'm';
  if (s < 86400) return 'hace ' + Math.floor(s / 3600) + 'h';
  return 'hace ' + Math.floor(s / 86400) + 'd';
}

// ---------- carga y render ----------
async function load() {
  $('#dc-status').textContent = 'cargando…';
  try {
    DATA = await api('GET', '/dc/overview');
    fillSites();
    render();
    $('#dc-status').textContent = 'actualizado ' + new Date().toLocaleTimeString('es-CO');
  } catch (e) { $('#dc-status').textContent = e.message; }
}

function fillSites() {
  const ms = Object.values(DATA.machines);
  const opts = ['<option value="">Todas las sedes</option>'].concat(ms.map((m) => `<option value="${esc(m.id)}">${esc(m.name)}${m.client ? ' · ' + esc(m.client) : ''}</option>`));
  $('#dc-site').innerHTML = opts.join('');
  $('#dc-site').value = site;
  const siteOpts = ms.map((m) => `<option value="${esc(m.id)}">${esc(m.name)}${m.client ? ' · ' + esc(m.client) : ''}</option>`).join('');
  $('#dc-sensor-site').innerHTML = siteOpts || '<option value="">(sin equipos)</option>';
  $('#dc-camera-site').innerHTML = siteOpts || '<option value="">(sin equipos)</option>';
}

const inSite = (x) => !site || x.machineId === site;

function render() {
  const sensors = DATA.sensors.filter(inSite);
  $('#dc-sensors').innerHTML = sensors.length ? sensors.map(sensorCard).join('')
    : '<div class="chat-empty">No hay sensores. Use “+ Sensor” para registrar uno.</div>';
  const cams = DATA.cameras.filter(inSite);
  $('#dc-cameras').innerHTML = cams.length ? cams.map(cameraCard).join('')
    : '<div class="chat-empty">No hay cámaras. Use “+ Cámara” para registrar una.</div>';
}

function sensorCard(s) {
  const icon = ICON[s.kind] || '•';
  let body;
  if (s.kind === 'energia') {
    const v = (s.lastExtra && s.lastExtra.v) || [], i = (s.lastExtra && s.lastExtra.i) || [];
    body = `<div class="dc-phases">${[0, 1, 2].map((n) => `<div><div class="pl">L${n + 1}</div><div class="pv">${v[n] != null ? v[n] : '—'}</div><div class="pi">${i[n] != null ? i[n] + ' A' : ''}</div></div>`).join('')}</div>`;
  } else if (s.kind === 'apertura') {
    const st = (s.lastExtra && s.lastExtra.state) || (s.lastValue ? 'abierto' : 'cerrado');
    const u = s.lastExtra && s.lastExtra.user;
    body = `<div class="dc-value">${st === 'abierto' ? '🔓 Abierto' : '🔒 Cerrado'}</div><div class="dc-sub">${u ? 'último: ' + esc(u) + (s.lastExtra.result ? ' · ' + esc(s.lastExtra.result) : '') : ''}</div>`;
  } else {
    body = `<div class="dc-value">${s.lastValue != null ? s.lastValue : '—'}<small> ${esc(s.unit || '')}</small></div>`;
  }
  return `<div class="dc-card ${s.status}${s.stale ? ' stale' : ''}" data-sensor="${esc(s.id)}">
    <div class="dc-head"><span class="dc-name">${icon} ${esc(s.name)}</span><span class="dc-kind">${esc(s.kind)}</span></div>
    ${body}
    <div class="dc-sub">${s.link ? `<span class="dc-pill">${esc(s.link)}</span>` : ''}${s.stale ? '<span style="color:var(--amber)">sin datos recientes</span>' : ''}${s.lastTs ? `<span>${rel(s.lastTs)}</span>` : '<span>sin lecturas</span>'}</div>
  </div>`;
}

function cameraCard(c) {
  const shot = c.hasSnapshot
    ? `<img class="shot" src="/api/dc/cameras/${c.id}/snapshot?t=${Date.now()}" alt="" onerror="this.outerHTML='<div class=\\'shot empty\\'>Instantánea no disponible</div>'">`
    : '<div class="shot empty">Solo RTSP (sin instantánea)</div>';
  return `<div class="dc-cam" data-cam="${esc(c.id)}">
    ${shot}
    <div class="dc-cam-body">
      <div class="dc-cam-name">📹 ${esc(c.name)}</div>
      <div class="dc-cam-loc">${esc(c.location || '')}</div>
      <div class="dc-cam-actions">
        ${c.rtspUrl ? `<button class="btn small" data-cam-rtsp="${esc(c.rtspUrl)}">Copiar RTSP</button>` : ''}
        ${c.hasSnapshot ? '<button class="btn small" data-cam-refresh>Actualizar</button>' : ''}
        <button class="btn small danger" data-cam-del>Eliminar</button>
      </div>
    </div>
  </div>`;
}

// ---------- gráfica (SVG) ----------
let chartSensor = null, chartRange = '24h';
const RANGE_LABELS = { '12h': '12 h', '24h': '24 h', '48h': '48 h', '72h': '72 h', week: 'Semana', month: 'Mes' };
const PHASE_COLORS = ['#34f5a4', '#38bdf8', '#fbbf24'];

async function openChart(id) {
  chartSensor = DATA.sensors.find((s) => s.id === id); if (!chartSensor) return;
  $('#dc-chart-title').textContent = (ICON[chartSensor.kind] || '') + ' ' + chartSensor.name;
  $('#dc-ranges').innerHTML = Object.keys(RANGE_LABELS).map((r) => `<button data-range="${r}" class="${r === chartRange ? 'active' : ''}">${RANGE_LABELS[r]}</button>`).join('');
  $('#dc-chart-modal').classList.remove('hidden');
  await drawChart();
  if (chartSensor.kind === 'apertura') loadEvents(id); else $('#dc-events').innerHTML = '';
}

async function drawChart() {
  $('#dc-chart').innerHTML = '<div class="chat-empty">cargando…</div>';
  const { points } = await api('GET', `/dc/sensors/${chartSensor.id}/history?range=${chartRange}`);
  if (!points.length) { $('#dc-chart').innerHTML = '<div class="chat-empty">Sin datos en este rango.</div>'; $('#dc-chart-legend').innerHTML = ''; return; }
  let series;
  if (chartSensor.kind === 'energia') {
    series = [0, 1, 2].map((n) => ({ name: 'L' + (n + 1) + ' (V)', color: PHASE_COLORS[n], data: points.map((p) => [p.ts, p.extra && p.extra.v ? p.extra.v[n] : null]) }));
  } else {
    series = [{ name: chartSensor.name + (chartSensor.unit ? ' (' + chartSensor.unit + ')' : ''), color: '#38bdf8', data: points.map((p) => [p.ts, p.value]) }];
  }
  $('#dc-chart').innerHTML = buildChart(series);
  $('#dc-chart-legend').innerHTML = series.map((s) => `<span><b style="background:${s.color}"></b>${esc(s.name)}</span>`).join('')
    + (chartSensor.unit && chartSensor.kind !== 'energia' ? '' : '');
}

function buildChart(series) {
  const W = 900, H = 260, pad = { l: 46, r: 12, t: 12, b: 26 };
  const all = series.flatMap((s) => s.data.map((d) => d[1]).filter((v) => v != null && isFinite(v)));
  const xs = series.flatMap((s) => s.data.map((d) => d[0]));
  if (!all.length) return '<div class="chat-empty">Sin datos.</div>';
  let min = Math.min(...all), max = Math.max(...all);
  if (min === max) { min -= 1; max += 1; }
  const pad10 = (max - min) * 0.08; min -= pad10; max += pad10;
  const x0 = Math.min(...xs), x1 = Math.max(...xs) || x0 + 1;
  const sx = (t) => pad.l + (x1 === x0 ? 0 : (t - x0) / (x1 - x0)) * (W - pad.l - pad.r);
  const sy = (v) => H - pad.b - ((v - min) / (max - min)) * (H - pad.t - pad.b);
  const grid = [];
  for (let g = 0; g <= 4; g++) {
    const v = min + (max - min) * g / 4, y = sy(v);
    grid.push(`<line x1="${pad.l}" y1="${y.toFixed(1)}" x2="${W - pad.r}" y2="${y.toFixed(1)}" stroke="#1b2838" stroke-width="1"/>`);
    grid.push(`<text x="4" y="${(y + 4).toFixed(1)}" fill="#4f5d73" font-size="11">${(+v.toFixed(1))}</text>`);
  }
  const fmtT = (t) => new Date(t * 1000).toLocaleString('es-CO', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const xlabs = [`<text x="${pad.l}" y="${H - 8}" fill="#4f5d73" font-size="11">${fmtT(x0)}</text>`,
    `<text x="${W - pad.r}" y="${H - 8}" fill="#4f5d73" font-size="11" text-anchor="end">${fmtT(x1)}</text>`];
  const paths = series.map((s) => {
    let d = '', pen = false;
    for (const [t, v] of s.data) {
      if (v == null || !isFinite(v)) { pen = false; continue; }
      d += `${pen ? 'L' : 'M'}${sx(t).toFixed(1)} ${sy(v).toFixed(1)}`; pen = true;
    }
    return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round"/>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${grid.join('')}${paths.join('')}${xlabs.join('')}</svg>`;
}

async function loadEvents(id) {
  try {
    const evs = await api('GET', `/dc/sensors/${id}/events`);
    $('#dc-events').innerHTML = '<h4 class="section-title">Aperturas (biométrico)</h4>' + (evs.length
      ? evs.map((e) => `<div class="ev"><span>${new Date(e.ts * 1000).toLocaleString('es-CO')}</span><span>${e.state === 'abierto' ? '🔓' : '🔒'} ${esc(e.state || '')}</span><span>${esc(e.user || '')}</span><span class="${e.result === 'denegado' ? 'den' : 'ok'}">${esc(e.result || '')}</span></div>`).join('')
      : '<div class="chat-empty">Sin eventos.</div>');
  } catch { $('#dc-events').innerHTML = ''; }
}

// ---------- eventos de UI ----------
$('#dc-site').addEventListener('change', (e) => { site = e.target.value; render(); });
$('#dc-refresh').addEventListener('click', load);

$('#dc-sensors').addEventListener('click', (e) => {
  const card = e.target.closest('[data-sensor]'); if (card) openChart(card.dataset.sensor);
});

$('#dc-cameras').addEventListener('click', async (e) => {
  const cam = e.target.closest('[data-cam]'); if (!cam) return;
  const id = cam.dataset.cam;
  const rtsp = e.target.closest('[data-cam-rtsp]');
  if (rtsp) { try { await navigator.clipboard.writeText(rtsp.dataset.camRtsp); } catch {} $('#dc-status').textContent = 'RTSP copiado'; return; }
  if (e.target.closest('[data-cam-refresh]')) { const img = cam.querySelector('img.shot'); if (img) img.src = `/api/dc/cameras/${id}/snapshot?t=${Date.now()}`; return; }
  if (e.target.closest('[data-cam-del]')) { if (!confirm('¿Eliminar esta cámara?')) return; try { await api('DELETE', `/dc/cameras/${id}`); load(); } catch (err) { alert(err.message); } }
});

document.addEventListener('click', (e) => { if (e.target.matches('[data-close]')) e.target.closest('.overlay').classList.add('hidden'); });
$('#dc-ranges').addEventListener('click', (e) => {
  const b = e.target.closest('[data-range]'); if (!b) return;
  chartRange = b.dataset.range;
  $('#dc-ranges').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
  drawChart();
});

// alta de sensor
$('#dc-add-sensor').addEventListener('click', () => { $('#dc-sensor-error').textContent = ''; $('#dc-sensor-modal').classList.remove('hidden'); });
$('#dc-sensor-form').elements.kind.addEventListener('change', (e) => {
  const noThresh = e.target.value === 'apertura' || e.target.value === 'energia';
  $('#dc-thresholds').classList.toggle('hidden', noThresh);
});
$('#dc-sensor-form').addEventListener('submit', async (e) => {
  e.preventDefault(); const f = e.target; $('#dc-sensor-error').textContent = '';
  const n = (x) => (x === '' ? undefined : Number(x));
  try {
    await api('POST', '/dc/sensors', {
      name: f.name.value.trim(), kind: f.kind.value, machineId: f.machineId.value || undefined,
      link: f.link.value, key: f.key.value.trim() || undefined,
      warnLow: n(f.warnLow.value), warnHigh: n(f.warnHigh.value), critLow: n(f.critLow.value), critHigh: n(f.critHigh.value),
    });
    f.reset(); $('#dc-thresholds').classList.remove('hidden'); $('#dc-sensor-modal').classList.add('hidden'); load();
  } catch (err) { $('#dc-sensor-error').textContent = err.message; }
});

// alta de cámara
$('#dc-add-camera').addEventListener('click', () => { $('#dc-camera-error').textContent = ''; $('#dc-camera-modal').classList.remove('hidden'); });
$('#dc-camera-form').addEventListener('submit', async (e) => {
  e.preventDefault(); const f = e.target; $('#dc-camera-error').textContent = '';
  try {
    await api('POST', '/dc/cameras', { name: f.name.value.trim(), machineId: f.machineId.value || undefined, rtspUrl: f.rtspUrl.value.trim(), snapshotUrl: f.snapshotUrl.value.trim(), location: f.location.value.trim() });
    f.reset(); $('#dc-camera-modal').classList.add('hidden'); load();
  } catch (err) { $('#dc-camera-error').textContent = err.message; }
});

// arranque + autorefresco cada 30 s
load();
setInterval(() => { if (document.querySelector('#dc-chart-modal.hidden') && document.querySelector('#dc-sensor-modal.hidden') && document.querySelector('#dc-camera-modal.hidden')) load(); }, 30000);
