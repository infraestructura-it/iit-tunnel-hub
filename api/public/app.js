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
  desconectada: 'bad', reconectada: 'good', servidor_caido: 'bad', servidor_recuperado: 'good',
  alerta_enviada: 'info', alerta_fallida: 'bad', alertas_configuradas: 'info',
  alertas_activadas: 'info', alertas_desactivadas: 'warn', instalador_generado: 'info',
};
const EVENT_LABEL = {
  conectada: 'Conectada', servicio_activo: 'Servicio activo', habilitada: 'Habilitada', registrada: 'Registrada',
  servicio_agregado: 'Servicio agregado', token_rotado: 'Token rotado', deshabilitada: 'Deshabilitada',
  servicio_cerrado: 'Servicio cerrado', servicio_eliminado: 'Servicio eliminado', eliminada: 'Eliminada',
  login_rechazado: 'Login rechazado', servicio_rechazado: 'Servicio rechazado', conexion_rechazada: 'Conexión rechazada',
  desconectada: 'Desconectada', reconectada: 'Reconectada', servidor_caido: 'Servidor frps caído', servidor_recuperado: 'Servidor frps recuperado',
  alerta_enviada: 'Alerta enviada', alerta_fallida: 'Alerta no enviada', alertas_configuradas: 'Alertas configuradas',
  alertas_activadas: 'Alertas activadas', alertas_desactivadas: 'Alertas desactivadas', instalador_generado: 'Instalador generado',
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

function download(name, text, type = 'text/plain') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
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
  const aiBtn = $('#ai-btn');
  aiBtn.classList.toggle('on', !!s.ai?.ready);
  $('#ai-badge').textContent = s.ai?.pending || '';
  $('#ai-badge').classList.toggle('hidden', !s.ai?.pending);
  aiBtn.title = s.ai?.ready ? (s.ai.pending ? `${s.ai.pending} acción(es) esperando aprobación` : 'Asistente IA') : 'IA sin configurar';
  const channels = (s.alerts.telegram ? 1 : 0) + s.alerts.webhooks;
  const bell = $('#alerts-btn');
  bell.classList.toggle('on', channels > 0);
  bell.title = channels ? `Alertas: ${[s.alerts.telegram && 'Telegram', s.alerts.webhooks && `${s.alerts.webhooks} webhook(s)`].filter(Boolean).join(' y ')} · gracia ${s.alerts.graceSeconds} s` : 'Alertas sin configurar';
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
      : `<span>${m.enabled && m.lastLogin && m.stateSince ? `<b class="down">Sin conexión ${ago(m.stateSince)}</b>` : STATE_LABEL[st]}</span><span>Último login: <b>${m.lastLogin ? ago(m.lastLogin.at) : 'nunca'}</b>${m.lastLogin ? ' · ' + esc(m.lastLogin.address) : ''}</span>`;
    return `<article class="card ${st}" data-id="${esc(m.id)}">
      <div class="card-head">
        <span class="dot ${st}"></span>
        <div class="card-title">
          <h3>${esc(m.name)}${m.alerts ? '' : ' <span class="muted-bell" title="Alertas desactivadas">🔕</span>'}</h3>
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
      <button class="btn small" data-act="alerts" title="Avisar si esta máquina se desconecta">${m.alerts ? '🔔 Alertas activadas' : '🔕 Alertas apagadas'}</button>
      <button class="btn small primary" data-act="install">Generar instalador</button>
      <button class="btn small" data-act="rotate">Rotar token</button>
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
      <h4>🤖 Inteligencia artificial</h4>
      <div class="ai-summary" id="ai-summary">${m.ai ? 'Alcance habilitado' : 'La IA no tiene alcance sobre esta máquina'}</div>
      <div class="actions" style="margin-top:10px">
        <button class="btn small primary" data-ai-act="chat">Abrir asistente</button>
        <button class="btn small" data-ai-act="scope">Configurar alcance</button>
      </div>
    </section>

    <section>
      <h4>Actividad de la máquina</h4>
      <ul class="events">${events.length ? events.map((e) => eventItem(e, false)).join('') : '<li style="border:0;color:var(--dim)">Sin eventos</li>'}</ul>
    </section>`;

  if (formValues) {
    const f = $('#add-svc-form', d);
    for (const [k, v] of Object.entries(formValues)) if (f.elements[k]) f.elements[k].value = v;
  }
  if (typeof aiDrawerSummary === 'function') aiDrawerSummary(m);
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
    if (act === 'alerts') {
      await api('PATCH', `/machines/${m.id}`, { alerts: !m.alerts });
      toast(m.alerts ? 'Alertas apagadas para esta máquina' : 'Alertas activadas para esta máquina');
      refresh();
    }
    if (act === 'rotate' || act === 'install') {
      const msg = act === 'install'
        ? 'Para generar el instalador se crea un token nuevo.\nSi el equipo ya estaba instalado, quedará desconectado hasta que ejecute el instalador nuevo.\n\n¿Continuar?'
        : 'El token actual dejará de servir en la próxima conexión. ¿Rotar?';
      if (!confirm(msg)) return;
      const r = await api('POST', `/machines/${m.id}/rotate-token`);
      showCreds(m, r.token, r.frpcToml, act === 'install' ? 'Instalador de la máquina' : 'Token rotado');
    }
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

const SERVER_KEY = 'iit-hub-server-addr';
let creds = null; // { machine, token } — solo en memoria mientras el modal está abierto

function showCreds(m, token, toml, title) {
  creds = { machine: m, token };
  $('#creds-title').textContent = title;
  $('#creds-sub').textContent = `${m.name}${m.client ? ' · ' + m.client : ''} · usuario frp: ${m.id}`;
  $('#creds-token').textContent = token;
  $('#creds-toml').textContent = toml;
  $('#creds-error').textContent = '';
  $('#install-help').classList.add('hidden');
  let saved = '';
  try { saved = localStorage.getItem(SERVER_KEY) || ''; } catch {}
  $('#creds-server').value = saved || state.summary?.frps?.publicAddr || '';
  $('#creds-modal').classList.remove('hidden');
}

const INSTALL_FILE = { linux: (id) => `instalar-${id}.sh`, windows: (id) => `instalar-${id}.ps1`, toml: (id) => `frpc-${id}.toml` };

function installHelp(platform, id, server) {
  const file = INSTALL_FILE[platform](id);
  const cmd = (c) => `<code title="Clic para copiar">${esc(c)}</code>`;
  const steps = {
    linux: [
      `Copie el archivo al equipo (USB, o desde esta PC): ${cmd(`scp ${file} usuario@IP-DEL-EQUIPO:~`)}`,
      `En el equipo, ejecútelo como root: ${cmd(`sudo bash ${file}`)}`,
      `Descarga frpc según la arquitectura (Raspberry, ARM o x86), lo instala como servicio y confirma la conexión.`,
      `Para desvincular el equipo: ${cmd(`sudo bash ${file} --desinstalar`)}`,
    ],
    windows: [
      `Copie el archivo al equipo Windows.`,
      `Abra PowerShell <b>como administrador</b> en esa carpeta y ejecute: ${cmd(`powershell -ExecutionPolicy Bypass -File .\\${file}`)}`,
      `Como administrador arranca con el equipo; sin administrador, al iniciar sesión el usuario.`,
      `Para desvincular el equipo: ${cmd(`powershell -ExecutionPolicy Bypass -File .\\${file} -Desinstalar`)}`,
    ],
    toml: [
      `Copie el archivo junto al ejecutable frpc del equipo.`,
      `Ejecute: ${cmd(`frpc -c ${file}`)}`,
    ],
  }[platform];
  return `<div class="ok-title">✔ ${esc(file)} descargado · servidor ${esc(server)}</div><ol>${steps.map((x) => `<li>${x}</li>`).join('')}</ol>
    <div class="hint" style="margin-top:10px">⚠ El archivo contiene el token de la máquina: no lo comparta ni lo suba a repositorios.</div>`;
}

$('#creds-modal').addEventListener('click', async (e) => {
  const code = e.target.closest('.install-help code');
  if (code) return copy(code.textContent);
  const btn = e.target.closest('.installer');
  if (!btn || !creds) return;
  const platform = btn.dataset.platform;
  const serverAddr = $('#creds-server').value.trim();
  $('#creds-error').textContent = '';
  $$('.installer').forEach((b) => { b.disabled = true; });
  try {
    let text = await api('POST', `/machines/${encodeURIComponent(creds.machine.id)}/installer`, { platform, token: creds.token, serverAddr });
    // fetch().text() descarta el BOM; Windows PowerShell 5.1 lo necesita para leer el .ps1 como UTF-8
    if (platform === 'windows' && !text.startsWith('\uFEFF')) text = '\uFEFF' + text;
    const file = INSTALL_FILE[platform](creds.machine.id);
    download(file, text, platform === 'linux' ? 'text/x-shellscript' : 'text/plain');
    try { if (serverAddr) localStorage.setItem(SERVER_KEY, serverAddr); } catch {}
    const help = $('#install-help');
    help.innerHTML = installHelp(platform, creds.machine.id, serverAddr || state.summary?.frps?.publicAddr || '');
    help.classList.remove('hidden');
  } catch (err) {
    $('#creds-error').textContent = err.message;
  } finally {
    $$('.installer').forEach((b) => { b.disabled = false; });
  }
});

// ---------- configuración de alertas ----------

async function openAlerts() {
  const f = $('#alerts-form');
  $('#alerts-error').textContent = '';
  $('#alerts-results').innerHTML = '';
  try {
    const a = await api('GET', '/alerts/settings');
    const grace = f.elements.graceSeconds;
    if (![...grace.options].some((o) => Number(o.value) === a.graceSeconds)) grace.add(new Option(`${a.graceSeconds} s`, a.graceSeconds));
    grace.value = String(a.graceSeconds);
    f.elements.botToken.value = '';
    f.elements.botToken.placeholder = a.telegram.botTokenMasked ? `Configurado (${a.telegram.botTokenMasked}) · deje vacío para conservarlo` : '123456789:AAE…';
    f.elements.clearToken.checked = false;
    $('#clear-token-row').classList.toggle('hidden', !a.telegram.botTokenMasked);
    f.elements.chatId.value = a.telegram.chatId;
    f.elements.webhooks.value = a.webhooks.join('\n');
    $('#alerts-modal').classList.remove('hidden');
  } catch (err) { toast(err.message, true); }
}

async function saveAlerts() {
  const f = $('#alerts-form');
  const body = {
    graceSeconds: Number(f.elements.graceSeconds.value),
    telegram: { chatId: f.elements.chatId.value.trim() },
    webhooks: f.elements.webhooks.value.split(/\s+/).filter(Boolean),
  };
  if (f.elements.clearToken.checked) body.telegram.botToken = null;
  else if (f.elements.botToken.value.trim()) body.telegram.botToken = f.elements.botToken.value.trim();
  return api('PUT', '/alerts/settings', body);
}

$('#alerts-btn').addEventListener('click', openAlerts);

$('#alerts-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#alerts-error').textContent = '';
  try {
    await saveAlerts();
    $('#alerts-modal').classList.add('hidden');
    toast('Alertas guardadas');
    refresh();
  } catch (err) { $('#alerts-error').textContent = err.message; }
});

$('#alerts-test').addEventListener('click', async () => {
  const btn = $('#alerts-test');
  $('#alerts-error').textContent = '';
  $('#alerts-results').innerHTML = '';
  btn.disabled = true;
  try {
    await saveAlerts();
    const r = await api('POST', '/alerts/test');
    $('#alerts-results').innerHTML = r.results.map((x) =>
      `<li class="${x.ok ? 'good' : 'bad'}">${x.ok ? '✔' : '✘'} ${esc(x.channel)}${x.ok ? ' · enviado' : ` · ${esc(x.error)}`}</li>`).join('');
    refresh();
  } catch (err) { $('#alerts-error').textContent = err.message; }
  finally { btn.disabled = false; }
});

// ---------- modales genéricos ----------

document.addEventListener('click', (e) => {
  if (e.target.matches('[data-close]')) {
    const ov = e.target.closest('.overlay');
    ov.classList.add('hidden');
    if (ov.id === 'creds-modal') creds = null;
  }
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
