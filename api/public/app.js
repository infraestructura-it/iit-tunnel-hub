'use strict';
// Panel de IIT Tunnel Hub — JavaScript sin dependencias.

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = { token: null, machines: [], summary: null, events: [], openId: null, timer: null };
const TOKEN_KEY = 'iit-hub-admin-token';

// ---------- API ----------

async function api(method, path, body) {
  const res = await fetch('/api' + path, {
    method,
    headers: { authorization: 'Bearer ' + state.token, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { logout(); throw new Error('Sesión no válida'); }
  const isJson = (res.headers.get('content-type') || '').includes('json');
  const data = isJson ? await res.json() : await res.text();
  if (!res.ok) throw new Error(data?.error || `Error ${res.status}`);
  return data;
}

// ---------- formato ----------

function ago(ts) {
  if (!ts) return '—';
  const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (s < 60) return `hace ${s} s`;
  if (s < 3600) return `hace ${Math.floor(s / 60)} min`;
  if (s < 86400) return `hace ${Math.floor(s / 3600)} h`;
  return `hace ${Math.floor(s / 86400)} d`;
}
function dateTime(ts) { return ts ? new Date(ts * 1000).toLocaleString('es-CO') : '—'; }
function bytes(n) {
  if (n === null || n === undefined) return '–';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v < 10 && i ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}
function machineState(m) { return !m.enabled ? 'disabled' : m.online ? 'online' : 'offline'; }
const STATE_LABEL = { online: 'En línea', offline: 'Fuera de línea', disabled: 'Deshabilitada' };
const SVC_LABEL = { online: 'activo', offline: 'caído', sin_registro: 'sin conectar' };

const EVENT_STYLE = {
  conectada: 'good', servicio_activo: 'good', habilitada: 'good', registrada: 'info', servicio_agregado: 'info',
  token_rotado: 'warn', deshabilitada: 'warn', servicio_cerrado: 'warn', servicio_eliminado: 'warn', eliminada: 'warn',
  login_rechazado: 'bad', servicio_rechazado: 'bad', conexion_rechazada: 'bad',
};
const EVENT_LABEL = {
  conectada: 'Conectada', servicio_activo: 'Servicio activo', habilitada: 'Habilitada', registrada: 'Registrada',
  servicio_agregado: 'Servicio agregado', token_rotado: 'Token rotado', deshabilitada: 'Deshabilitada',
  servicio_cerrado: 'Servicio cerrado', servicio_eliminado: 'Servicio eliminado', eliminada: 'Eliminada',
  login_rechazado: 'Login rechazado', servicio_rechazado: 'Servicio rechazado', conexion_rechazada: 'Conexión rechazada',
};

function toast(msg, err = false) {
  const t = document.createElement('div');
  t.className = 'toast' + (err ? ' err' : '');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3200);
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('Copiado'); }
  catch { toast('No se pudo copiar', true); }
}

function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/toml' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- sesión ----------

function showLogin() { $('#app').classList.add('hidden'); $('#login').classList.remove('hidden'); $('#admin-token').focus(); }
function showApp() { $('#login').classList.add('hidden'); $('#app').classList.remove('hidden'); }

function logout() {
  state.token = null;
  try { sessionStorage.removeItem(TOKEN_KEY); } catch {}
  clearInterval(state.timer);
  showLogin();
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  state.token = $('#admin-token').value.trim();
  $('#login-error').textContent = '';
  try {
    await api('GET', '/summary');
    try { sessionStorage.setItem(TOKEN_KEY, state.token); } catch {}
    start();
  } catch {
    $('#login-error').textContent = 'Token incorrecto';
    showLogin();
  }
});
$('#logout').addEventListener('click', logout);

// ---------- carga y render ----------

async function refresh() {
  try {
    const [summary, machines, events] = await Promise.all([api('GET', '/summary'), api('GET', '/machines'), api('GET', '/events?limit=60')]);
    Object.assign(state, { summary, machines, events });
    renderSummary();
    renderMachines();
    renderEvents();
    const typing = $('#drawer').contains(document.activeElement) && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName);
    if (state.openId && !typing) renderDrawer();
  } catch (err) {
    if (state.token) toast(err.message, true);
  }
}

function renderSummary() {
  const s = state.summary;
  $('#t-machines').textContent = s.machines;
  $('#t-enabled').textContent = `${s.enabled} habilitadas`;
  $('#t-online').textContent = s.online;
  $('#t-online-s').textContent = s.enabled ? `${Math.round((s.online / s.enabled) * 100)}% de las habilitadas` : 'sin máquinas';
  $('#t-services').textContent = s.services;
  $('#t-traffic').textContent = s.frps.reachable ? bytes((s.frps.totalTrafficIn || 0) + (s.frps.totalTrafficOut || 0)) : '–';
  const pill = $('#frps-pill');
  pill.innerHTML = s.frps.reachable
    ? `<span class="dot online" style="margin:0"></span> frps ${esc(s.frps.version)} · ${esc(s.frps.publicAddr)}:${s.frps.bindPort}`
    : `<span class="dot" style="margin:0;background:var(--red)"></span> frps sin respuesta`;
  pill.title = s.frps.reachable ? `Dominio: *.${s.frps.subdomainHost}` : s.frps.error || '';
}

function filtered() {
  const q = $('#search').value.trim().toLowerCase();
  const f = $('#filter').value;
  return state.machines.filter((m) => {
    if (f !== 'all' && machineState(m) !== f) return false;
    if (!q) return true;
    return [m.name, m.client, m.id, m.description].some((v) => (v || '').toLowerCase().includes(q));
  });
}

function serviceLine(s) {
  const live = s.status === 'online';
  const url = s.type === 'tcp' ? s.publicUrl.replace('tcp://', '') : s.publicUrl;
  const link = live && s.type !== 'tcp'
    ? `<a class="url" href="${esc(s.publicUrl)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">${esc(url)}</a>`
    : `<span class="url ${live ? '' : 'off'}">${esc(url)}</span>`;
  return `<div class="svc">
    <span class="tag ${s.type}">${s.type}</span>
    <span class="name">${esc(s.name)}</span>
    ${link}
    <span class="tag state-${s.status}">${SVC_LABEL[s.status] || s.status}</span>
  </div>`;
}

function renderMachines() {
  const list = filtered();
  const el = $('#machines');
  if (!state.machines.length) {
    el.innerHTML = `<div class="empty" style="grid-column:1/-1"><h3>Aún no hay máquinas</h3>Registre la primera para obtener su token y su frpc.toml.</div>`;
    return;
  }
  if (!list.length) {
    el.innerHTML = `<div class="empty" style="grid-column:1/-1">Ninguna máquina coincide con el filtro.</div>`;
    return;
  }
  el.innerHTML = list.map((m) => {
    const st = machineState(m);
    const conn = m.online
      ? `<span>IP <b>${esc(m.connection.clientIp)}</b> · ${esc(m.connection.hostname)}</span><span>Conectada ${ago(m.connection.connectedSince)} · frpc ${esc(m.connection.version)}</span>`
      : `<span>${STATE_LABEL[st]}</span><span>Último login: <b>${m.lastLogin ? ago(m.lastLogin.at) : 'nunca'}</b>${m.lastLogin ? ' · ' + esc(m.lastLogin.address) : ''}</span>`;
    return `<article class="card ${st}" data-id="${esc(m.id)}">
      <div class="card-head">
        <span class="dot ${st}"></span>
        <div class="card-title">
          <h3>${esc(m.name)}</h3>
          ${m.client ? `<div class="client">${esc(m.client)}</div>` : ''}
          <div class="id">${esc(m.id)}</div>
        </div>
      </div>
      <div class="meta">${conn}</div>
      ${m.services.length ? m.services.map(serviceLine).join('') : '<div class="no-svc">Sin servicios publicados</div>'}
    </article>`;
  }).join('');
}

function eventItem(e, withMachine = true) {
  return `<li class="${EVENT_STYLE[e.kind] || ''}">
    <div class="ev-kind">${esc(EVENT_LABEL[e.kind] || e.kind)}${withMachine && e.machine_id ? ` · <span style="color:var(--purple)">${esc(e.machine_id)}</span>` : ''}</div>
    ${e.detail ? `<div class="ev-detail">${esc(e.detail)}</div>` : ''}
    <div class="ev-meta" title="${esc(dateTime(e.ts))}">${ago(e.ts)}</div>
  </li>`;
}

function renderEvents() {
  $('#events').innerHTML = state.events.length ? state.events.map((e) => eventItem(e)).join('') : '<li style="border:0;color:var(--dim)">Sin actividad todavía</li>';
}

$('#search').addEventListener('input', renderMachines);
$('#filter').addEventListener('change', renderMachines);
$('#machines').addEventListener('click', (e) => {
  const card = e.target.closest('.card');
  if (card) openDrawer(card.dataset.id);
});

// ---------- detalle ----------

async function openDrawer(id) {
  state.openId = id;
  $('#drawer-wrap').classList.remove('hidden');
  await renderDrawer();
}
function closeDrawer() { state.openId = null; $('#drawer-wrap').classList.add('hidden'); }
$('#drawer-wrap').addEventListener('click', (e) => { if (e.target.id === 'drawer-wrap') closeDrawer(); });

async function renderDrawer() {
  const m = state.machines.find((x) => x.id === state.openId);
  if (!m) return closeDrawer();
  let events = [];
  try { events = await api('GET', `/events?machine=${encodeURIComponent(m.id)}&limit=30`); } catch {}
  if (state.openId !== m.id) return;
  const st = machineState(m);
  const d = $('#drawer');
  const keepForm = d.dataset.id === m.id && $('#add-svc-form', d);
  const formValues = keepForm ? Object.fromEntries(new FormData($('#add-svc-form', d))) : null;
  d.dataset.id = m.id;
  d.innerHTML = `
    <div style="display:flex;gap:12px;align-items:flex-start">
      <span class="dot ${st}" style="margin-top:12px"></span>
      <div style="flex:1;min-width:0">
        <h2>${esc(m.name)}</h2>
        <div class="sub">${m.client ? esc(m.client) + ' · ' : ''}<span style="font-family:var(--code)">${esc(m.id)}</span> · ${STATE_LABEL[st]}</div>
      </div>
      <button class="btn icon" data-act="close" title="Cerrar">✕</button>
    </div>
    ${m.description ? `<p style="color:var(--muted);margin-top:0">${esc(m.description)}</p>` : ''}
    <div class="actions">
      <button class="btn small" data-act="toggle">${m.enabled ? 'Deshabilitar' : 'Habilitar'}</button>
      <button class="btn small" data-act="rotate">Rotar token</button>
      <button class="btn small" data-act="toml">Descargar frpc.toml</button>
      <button class="btn small danger" data-act="delete">Eliminar</button>
    </div>

    <section>
      <h4>Conexión</h4>
      <dl class="kv">
        ${m.online ? `
          <dt>IP de origen</dt><dd>${esc(m.connection.clientIp)}</dd>
          <dt>Hostname</dt><dd>${esc(m.connection.hostname)}</dd>
          <dt>Versión frpc</dt><dd>${esc(m.connection.version)}</dd>
          <dt>Conectada desde</dt><dd>${dateTime(m.connection.connectedSince)}</dd>` : `
          <dt>Estado</dt><dd>${STATE_LABEL[st]}</dd>`}
        <dt>Último login</dt><dd>${m.lastLogin ? `${dateTime(m.lastLogin.at)} · ${esc(m.lastLogin.os)}/${esc(m.lastLogin.arch)} · ${esc(m.lastLogin.address)}` : 'nunca'}</dd>
        <dt>Registrada</dt><dd>${dateTime(m.createdAt)}</dd>
      </dl>
    </section>

    <section>
      <h4>Servicios</h4>
      ${m.services.length ? `<table>
        <thead><tr><th>Servicio</th><th class="hide-sm">Local</th><th>Público</th><th class="hide-sm">Hoy</th><th></th></tr></thead>
        <tbody>${m.services.map((s) => `<tr>
          <td><span class="tag ${s.type}">${s.type}</span> ${esc(s.name)}<br><span class="tag state-${s.status}" style="margin-top:4px;display:inline-block">${SVC_LABEL[s.status] || s.status}</span></td>
          <td class="hide-sm" style="font-family:var(--code);font-size:11px">${esc(s.localIp)}:${s.localPort}${s.tlsMode ? `<br><span style="color:var(--dim)">TLS ${s.tlsMode === 'local' ? 'en la máquina' : 'del servicio'}</span>` : ''}</td>
          <td class="url"><a href="#" data-copy-text="${esc(s.publicUrl)}" title="Copiar">${esc(s.publicUrl)}</a></td>
          <td class="hide-sm" style="white-space:nowrap">↓ ${bytes(s.trafficInToday)}<br>↑ ${bytes(s.trafficOutToday)}</td>
          <td><button class="btn icon small danger" data-del-svc="${esc(s.name)}" title="Eliminar servicio">✕</button></td>
        </tr>`).join('')}</tbody></table>` : '<div style="color:var(--dim)">Sin servicios.</div>'}

      <form id="add-svc-form" style="margin-top:14px">
        <label>Agregar servicio</label>
        <div class="svc-row" style="grid-template-columns:1fr 1fr 1fr 1fr">
          <div><label>Nombre</label><input name="name" required maxlength="20" pattern="[a-z0-9]([a-z0-9\\-]*[a-z0-9])?" placeholder="web"></div>
          <div><label>Tipo</label><select name="type"><option value="http">http</option><option value="https">https (SNI)</option><option value="tcp">tcp</option></select></div>
          <div><label>IP local</label><input name="localIp" value="127.0.0.1"></div>
          <div><label>Puerto</label><input name="localPort" type="number" min="1" max="65535" required placeholder="1880"></div>
          <div style="grid-column:1/3"><label>Subdominio / puerto remoto</label><input name="extra" placeholder="automático"></div>
          <div><label>TLS (https)</label><select name="tlsMode"><option value="local">en la máquina</option><option value="passthrough">del servicio</option></select></div>
          <div style="align-self:end"><button class="btn primary small" type="submit" style="width:100%;justify-content:center">Agregar</button></div>
        </div>
        <div class="hint">Después de agregar o quitar servicios, descargue el frpc.toml de nuevo y conserve el token actual en la línea metadatas.token.</div>
      </form>
    </section>

    <section>
      <h4>Actividad de la máquina</h4>
      <ul class="events">${events.length ? events.map((e) => eventItem(e, false)).join('') : '<li style="border:0;color:var(--dim)">Sin eventos</li>'}</ul>
    </section>`;

  if (formValues) {
    const f = $('#add-svc-form', d);
    for (const [k, v] of Object.entries(formValues)) if (f.elements[k]) f.elements[k].value = v;
  }
}

$('#drawer').addEventListener('click', async (e) => {
  const m = state.machines.find((x) => x.id === state.openId);
  if (!m) return;
  const copyEl = e.target.closest('[data-copy-text]');
  if (copyEl) { e.preventDefault(); return copy(copyEl.dataset.copyText); }
  const del = e.target.closest('[data-del-svc]');
  if (del) {
    if (!confirm(`¿Eliminar el servicio "${del.dataset.delSvc}"? La máquina deberá actualizar su frpc.toml.`)) return;
    try { await api('DELETE', `/machines/${m.id}/services/${encodeURIComponent(del.dataset.delSvc)}`); toast('Servicio eliminado'); refresh(); }
    catch (err) { toast(err.message, true); }
    return;
  }
  const act = e.target.closest('[data-act]')?.dataset.act;
  try {
    if (act === 'close') closeDrawer();
    if (act === 'toggle') {
      await api('PATCH', `/machines/${m.id}`, { enabled: !m.enabled });
      toast(m.enabled ? 'Máquina deshabilitada: tráfico cortado' : 'Máquina habilitada');
      refresh();
    }
    if (act === 'rotate') {
      if (!confirm('El token actual dejará de servir en la próxima conexión. ¿Rotar?')) return;
      const r = await api('POST', `/machines/${m.id}/rotate-token`);
      showCreds(m, r.token, r.frpcToml, 'Token rotado');
    }
    if (act === 'toml') download(`frpc-${m.id}.toml`, await api('GET', `/machines/${m.id}/frpc.toml`));
    if (act === 'delete') {
      if (prompt(`Para eliminar escriba el id de la máquina: ${m.id}`) !== m.id) return;
      await api('DELETE', `/machines/${m.id}`);
      closeDrawer();
      toast('Máquina eliminada');
      refresh();
    }
  } catch (err) { toast(err.message, true); }
});

$('#drawer').addEventListener('submit', async (e) => {
  if (e.target.id !== 'add-svc-form') return;
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  const body = { name: f.name.trim(), type: f.type, localIp: f.localIp.trim(), localPort: Number(f.localPort) };
  if (f.extra.trim()) { if (f.type === 'tcp') body.remotePort = Number(f.extra); else body.subdomain = f.extra.trim(); }
  if (f.type === 'https') body.tlsMode = f.tlsMode;
  try {
    await api('POST', `/machines/${state.openId}/services`, body);
    e.target.reset();
    toast('Servicio agregado');
    refresh();
  } catch (err) { toast(err.message, true); }
});

// ---------- registrar máquina ----------

function extraFor(type) {
  if (type === 'tcp') return `<label>Puerto remoto</label><input data-k="remotePort" type="number" placeholder="automático">`;
  if (type === 'https') return `<label>Subdominio · TLS</label><div style="display:flex;gap:6px"><input data-k="subdomain" placeholder="auto"><select data-k="tlsMode" style="width:auto" title="Dónde termina el TLS"><option value="local">máquina</option><option value="passthrough">servicio</option></select></div>`;
  return `<label>Subdominio</label><input data-k="subdomain" placeholder="automático">`;
}

function addSvcRow(preset = {}) {
  const row = $('#svc-row-tpl').content.firstElementChild.cloneNode(true);
  const type = $('[data-k="type"]', row);
  if (preset.type) type.value = preset.type;
  if (preset.name) $('[data-k="name"]', row).value = preset.name;
  if (preset.localPort) $('[data-k="localPort"]', row).value = preset.localPort;
  $('[data-extra]', row).innerHTML = extraFor(type.value);
  type.addEventListener('change', () => { $('[data-extra]', row).innerHTML = extraFor(type.value); });
  $('[data-remove]', row).addEventListener('click', () => row.remove());
  $('#svc-rows').appendChild(row);
}

$('#new-machine').addEventListener('click', () => {
  $('#create-form').reset();
  $('#svc-rows').innerHTML = '';
  $('#create-error').textContent = '';
  addSvcRow({ name: 'web', type: 'http', localPort: 1880 });
  $('#create-modal').classList.remove('hidden');
  $('#create-form [name="name"]').focus();
});
$('#add-svc-row').addEventListener('click', () => addSvcRow());

$('#create-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  const services = $$('.svc-row', $('#svc-rows')).map((row) => {
    const s = {};
    for (const input of $$('[data-k]', row)) {
      const v = input.value.trim();
      if (v === '') continue;
      s[input.dataset.k] = ['localPort', 'remotePort'].includes(input.dataset.k) ? Number(v) : v;
    }
    return s;
  });
  const body = { name: f.name, client: f.client, description: f.description, services };
  if (f.id.trim()) body.id = f.id.trim();
  try {
    const r = await api('POST', '/machines', body);
    $('#create-modal').classList.add('hidden');
    showCreds(r.machine, r.token, r.frpcToml, 'Máquina registrada');
    refresh();
  } catch (err) {
    $('#create-error').textContent = err.message;
  }
});

function showCreds(m, token, toml, title) {
  $('#creds-title').textContent = title;
  $('#creds-sub').textContent = `${m.name}${m.client ? ' · ' + m.client : ''} · usuario frp: ${m.id}`;
  $('#creds-token').textContent = token;
  $('#creds-toml').textContent = toml;
  $('#creds-download').onclick = () => download(`frpc-${m.id}.toml`, toml);
  $('#creds-modal').classList.remove('hidden');
}

// ---------- modales genéricos ----------

document.addEventListener('click', (e) => {
  if (e.target.matches('[data-close]')) e.target.closest('.overlay').classList.add('hidden');
  const c = e.target.closest('[data-copy]');
  if (c) copy($('#' + c.dataset.copy).textContent);
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const open = $$('.overlay').find((o) => !o.classList.contains('hidden'));
  if (open) open.classList.add('hidden'); else if (state.openId) closeDrawer();
});

// ---------- arranque ----------

function start() {
  showApp();
  refresh();
  clearInterval(state.timer);
  state.timer = setInterval(() => { if (!document.hidden) refresh(); }, 5000);
}

try { state.token = sessionStorage.getItem(TOKEN_KEY); } catch {}
if (state.token) start(); else showLogin();
