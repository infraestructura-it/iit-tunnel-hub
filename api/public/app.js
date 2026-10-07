'use strict';
// Panel de IIT Tunnel Hub — JavaScript sin dependencias.

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = { token: null, me: null, machines: [], summary: null, events: [], snmp: [], openId: null, timer: null };
const TOKEN_KEY = 'iit-hub-admin-token';

// ---------- API ----------

// Con sesión de usuario la cookie viaja sola; con el token de administración se envía como Bearer.
// X-Requested-With identifica al panel (el servidor rechaza cambios sin ella: protección CSRF).
async function api(method, path, body, { quiet401 = false } = {}) {
  const res = await fetch('/api' + path, {
    method,
    credentials: 'same-origin',
    headers: {
      'x-requested-with': 'iit-panel',
      ...(state.token ? { authorization: 'Bearer ' + state.token } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const isJson = (res.headers.get('content-type') || '').includes('json');
  const data = isJson ? await res.json() : await res.text();
  if (res.status === 401 && !quiet401 && !path.startsWith('/auth/')) { endSession(); throw new Error('La sesión terminó: ingrese de nuevo'); }
  if (res.status === 403 && data?.mustChangePassword) { openAccount(true); }
  if (!res.ok) { const e = new Error(data?.error || `Error ${res.status}`); e.status = res.status; e.data = data; throw e; }
  return data;
}

const role = () => state.me?.user?.role || 'cliente';
const isStaff = () => role() === 'admin' || role() === 'tecnico';

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
  usuario_creado: 'info', usuario_modificado: 'info', usuario_eliminado: 'warn', cliente_creado: 'info', cliente_renombrado: 'info',
  cliente_eliminado: 'warn', cliente_cambiado: 'info', sesion_iniciada: 'good', login_fallido: 'bad', contrasena_cambiada: 'info',
  '2fa_activado': 'good', '2fa_desactivado': 'warn',
  snmp_agregado: 'info', snmp_modificado: 'info', snmp_eliminado: 'warn', snmp_alerta: 'bad', snmp_normal: 'good',
  respaldo_creado: 'good', respaldo_fallido: 'bad', respaldo_descargado: 'info', respaldo_eliminado: 'warn', respaldos_configurados: 'info',
  acceso_otorgado: 'info', acceso_revocado: 'warn', clave_rotada: 'warn', reconexion: 'info', accesos_descargados: 'info',
  codigo_generado: 'info', codigo_canjeado: 'good', codigo_revocado: 'warn', codigo_rechazado: 'bad',
};
const EVENT_LABEL = {
  conectada: 'Conectada', servicio_activo: 'Servicio activo', habilitada: 'Habilitada', registrada: 'Registrada',
  servicio_agregado: 'Servicio agregado', token_rotado: 'Token rotado', deshabilitada: 'Deshabilitada',
  servicio_cerrado: 'Servicio cerrado', servicio_eliminado: 'Servicio eliminado', eliminada: 'Eliminada',
  login_rechazado: 'Login rechazado', servicio_rechazado: 'Servicio rechazado', conexion_rechazada: 'Conexión rechazada',
  desconectada: 'Desconectada', reconectada: 'Reconectada', servidor_caido: 'Servidor frps caído', servidor_recuperado: 'Servidor frps recuperado',
  alerta_enviada: 'Alerta enviada', alerta_fallida: 'Alerta no enviada', alertas_configuradas: 'Alertas configuradas',
  alertas_activadas: 'Alertas activadas', alertas_desactivadas: 'Alertas desactivadas', instalador_generado: 'Instalador generado',
  acceso_otorgado: 'Acceso privado otorgado', acceso_revocado: 'Acceso privado revocado', clave_rotada: 'Clave privada rotada',
  reconexion: 'Reconexión pedida por el hub', accesos_descargados: 'Accesos descargados',
  usuario_creado: 'Usuario creado', usuario_modificado: 'Usuario modificado', usuario_eliminado: 'Usuario eliminado',
  cliente_creado: 'Cliente creado', cliente_renombrado: 'Cliente renombrado', cliente_eliminado: 'Cliente eliminado',
  cliente_cambiado: 'Cambio de cliente', sesion_iniciada: 'Sesión iniciada', login_fallido: 'Ingreso fallido',
  contrasena_cambiada: 'Contraseña cambiada', '2fa_activado': '2FA activado', '2fa_desactivado': '2FA desactivado',
  snmp_agregado: 'Equipo SNMP agregado', snmp_modificado: 'Equipo SNMP modificado', snmp_eliminado: 'Equipo SNMP eliminado',
  snmp_alerta: 'Alerta SNMP', snmp_normal: 'SNMP normalizado',
  respaldo_creado: 'Respaldo creado', respaldo_fallido: 'Respaldo fallido', respaldo_descargado: 'Respaldo descargado',
  respaldo_eliminado: 'Respaldo eliminado', respaldos_configurados: 'Respaldos configurados',
  codigo_generado: 'Código de instalación generado', codigo_canjeado: 'Instalada con código',
  codigo_revocado: 'Código de instalación revocado', codigo_rechazado: 'Código de instalación rechazado',
};
const TYPE_LABEL = { stcp: 'privado' };
const typeTag = (t) => `<span class="tag ${t}">${TYPE_LABEL[t] || t}</span>`;
const plural = (n, s, p = s + 's') => `${n} ${n === 1 ? s : p}`;

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

function loginMode(mode) {
  for (const [id, m] of [['#login-form', 'user'], ['#token-form', 'token'], ['#setup-form', 'setup']]) $(id).classList.toggle('hidden', m !== mode);
  const focus = { user: '#login-user', token: '#admin-token', setup: '#setup-form [name="adminToken"]' }[mode];
  setTimeout(() => $(focus)?.focus(), 0);
}

async function showLogin() {
  $('#app').classList.add('hidden');
  $('#login').classList.remove('hidden');
  $$('.overlay').forEach((o) => o.classList.add('hidden'));
  let needsSetup = false;
  try { needsSetup = (await api('GET', '/auth/state')).needsSetup; } catch {}
  loginMode(needsSetup ? 'setup' : 'user');
}
function showApp() { $('#login').classList.add('hidden'); $('#app').classList.remove('hidden'); }

/** Termina la sesión en el navegador (la cookie la invalida el servidor en /auth/logout). */
function endSession() {
  state.token = null;
  state.me = null;
  try { sessionStorage.removeItem(TOKEN_KEY); } catch {}
  clearInterval(state.timer);
  closeDrawer();
  showLogin();
}

async function logout() {
  if (!state.token) { try { await api('POST', '/auth/logout'); } catch {} }
  endSession();
}

$('#login').addEventListener('click', (e) => {
  const a = e.target.closest('[data-login-mode]');
  if (a) { e.preventDefault(); loginMode(a.dataset.loginMode); }
});

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-error').textContent = '';
  const body = { username: $('#login-user').value.trim().toLowerCase(), password: $('#login-pass').value };
  const code = $('#login-code').value.trim();
  if (code) body.code = code;
  try {
    state.token = null;
    await api('POST', '/auth/login', body);
    $('#login-pass').value = ''; $('#login-code').value = '';
    $('#login-code-row').classList.add('hidden');
    start();
  } catch (err) {
    if (err.data?.needCode) {
      $('#login-code-row').classList.remove('hidden');
      $('#login-code').focus();
      return;
    }
    $('#login-error').textContent = err.message;
    if ($('#login-code-row').classList.contains('hidden')) $('#login-pass').select(); else { $('#login-code').value = ''; $('#login-code').focus(); }
  }
});

$('#token-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  state.token = $('#admin-token').value.trim();
  $('#token-error').textContent = '';
  try {
    await api('GET', '/auth/me');
    try { sessionStorage.setItem(TOKEN_KEY, state.token); } catch {}
    $('#admin-token').value = '';
    start();
  } catch {
    state.token = null;
    $('#token-error').textContent = 'Token incorrecto';
  }
});

$('#setup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  $('#setup-error').textContent = '';
  if (f.password !== f.password2) { $('#setup-error').textContent = 'Las contraseñas no coinciden'; return; }
  try {
    await api('POST', '/auth/setup', { adminToken: f.adminToken, username: f.username.trim().toLowerCase(), name: f.name, password: f.password });
    e.target.reset();
    start();
  } catch (err) { $('#setup-error').textContent = err.message; }
});

$('#logout').addEventListener('click', logout);

/** Ajusta la interfaz al rol: el CSS oculta .admin-only y .staff-only según data-role. */
function applyRole() {
  const u = state.me.user;
  document.body.dataset.role = u.role;
  $('#user-label').textContent = ' ' + (u.name || u.username);
  $('#user-btn').title = `${u.name || u.username} · ${u.roleLabel || 'Administrador'}${u.via === 'token' ? ' (token de administración)' : ''}`;
  $('#client-options').innerHTML = state.me.clients.map((c) => `<option value="${esc(c.name)}">`).join('');
  $('#create-form [name="client"]').required = role() !== 'admin';
}

// ---------- carga y render ----------

async function refresh() {
  try {
    const [summary, machines, events, snmp] = await Promise.all([
      api('GET', '/summary'), api('GET', '/machines'), api('GET', '/events?limit=60'), api('GET', '/snmp/devices').catch(() => []),
    ]);
    Object.assign(state, { summary, machines, events, snmp });
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
  if (s.frps.totalTrafficIn === undefined) {
    // Rol cliente: tráfico de hoy de sus servicios (el total de frps es de toda la plataforma)
    const today = state.machines.flatMap((m) => m.services).reduce((n, x) => n + (x.trafficInToday || 0) + (x.trafficOutToday || 0), 0);
    $('#t-traffic').textContent = bytes(today);
    $('#t-traffic').nextElementSibling.textContent = 'hoy en sus servicios';
  } else {
    $('#t-traffic').textContent = s.frps.reachable ? bytes((s.frps.totalTrafficIn || 0) + (s.frps.totalTrafficOut || 0)) : '–';
  }
  const pill = $('#frps-pill');
  pill.innerHTML = s.frps.reachable
    ? `<span class="dot online" style="margin:0"></span> frps ${esc(s.frps.version)} · ${esc(s.frps.publicAddr)}:${s.frps.bindPort}`
    : `<span class="dot" style="margin:0;background:var(--red)"></span> frps sin respuesta`;
  pill.title = s.frps.reachable ? `Dominio: *.${s.frps.subdomainHost}` : s.frps.error || '';
  if (!s.ai) return; // rol cliente: sin IA ni alertas
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
  if (s.private) {
    return `<div class="svc">
    ${typeTag(s.type)}
    <span class="name">${esc(s.name)}</span>
    <span class="url ${live ? '' : 'off'}">🔒 :${s.localPort}${s.access ? ' · ' + plural(s.access.length, 'acceso') : ' · privado'}</span>
    <span class="tag state-${s.status}">${SVC_LABEL[s.status] || s.status}</span>
  </div>`;
  }
  const url = s.type === 'tcp' ? s.publicUrl.replace('tcp://', '') : s.publicUrl;
  const link = live && s.type !== 'tcp'
    ? `<a class="url" href="${esc(s.publicUrl)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">${esc(url)}</a>`
    : `<span class="url ${live ? '' : 'off'}">${esc(url)}</span>`;
  return `<div class="svc">
    ${typeTag(s.type)}
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
          <h3>${esc(m.name)}${m.alerts !== false ? '' : ' <span class="muted-bell" title="Alertas desactivadas">🔕</span>'}</h3>
          ${m.client ? `<div class="client">${esc(m.client)}</div>` : ''}
          <div class="id">${esc(m.id)}</div>
        </div>
      </div>
      <div class="meta">${conn}</div>
      ${m.services.length ? m.services.map(serviceLine).join('') : (m.visits?.length ? '' : '<div class="no-svc">Sin servicios publicados</div>')}
      ${typeof snmpCardLine === 'function' ? snmpCardLine(m) : ''}
      ${m.visits?.length ? `<div class="visits-line">🔑 Entra a ${plural(m.visits.length, 'servicio privado', 'servicios privados')}</div>` : ''}
    </article>`;
  }).join('');
}

function eventItem(e, withMachine = true) {
  return `<li class="${EVENT_STYLE[e.kind] || ''}">
    <div class="ev-kind">${esc(EVENT_LABEL[e.kind] || e.kind)}${withMachine && e.machine_id ? ` · <span style="color:var(--purple)">${esc(e.machine_id)}</span>` : ''}</div>
    ${e.detail ? `<div class="ev-detail">${esc(e.detail)}</div>` : ''}
    <div class="ev-meta" title="${esc(dateTime(e.ts))}">${ago(e.ts)}${e.actor ? ` · por <b>${esc(e.actor)}</b>` : ''}</div>
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
    ${isStaff() ? `<div class="actions">
      <button class="btn small" data-act="toggle">${m.enabled ? 'Deshabilitar' : 'Habilitar'}</button>
      <button class="btn small" data-act="alerts" title="Avisar si esta máquina se desconecta">${m.alerts ? '🔔 Alertas activadas' : '🔕 Alertas apagadas'}</button>
      <button class="btn small primary" data-act="install">Generar instalador</button>
      ${role() === 'admin' ? '<button class="btn small" data-act="enroll" title="Código de un solo uso para instalar desde el propio equipo">📲 Instalar con código</button>' : ''}
      <button class="btn small" data-act="rotate">Rotar token</button>
      <button class="btn small danger" data-act="delete">Eliminar</button>
    </div>` : ''}

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
          <td>${typeTag(s.type)} ${esc(s.name)}<br><span class="tag state-${s.status}" style="margin-top:4px;display:inline-block">${SVC_LABEL[s.status] || s.status}</span></td>
          <td class="hide-sm" style="font-family:var(--code);font-size:11px">${esc(s.localIp || '')}${s.localIp ? ':' : 'puerto '}${s.localPort}${s.tlsMode ? `<br><span style="color:var(--dim)">TLS ${s.tlsMode === 'local' ? 'en la máquina' : 'del servicio'}</span>` : ''}</td>
          <td class="url">${s.private ? (isStaff() ? privateCell(m, s) : '<span class="lock" style="color:var(--amber)">🔒 Privado · acceso solo para soporte</span>')
            : (s.type === 'http' || s.type === 'https') && !isStaff()
              ? `<a href="${esc(s.publicUrl)}" target="_blank" rel="noopener">${esc(s.publicUrl)}</a>`
              : `<a href="#" data-copy-text="${esc(s.publicUrl)}" title="Copiar">${esc(s.publicUrl)}</a>`}</td>
          <td class="hide-sm" style="white-space:nowrap">↓ ${bytes(s.trafficInToday)}<br>↑ ${bytes(s.trafficOutToday)}</td>
          <td>${isStaff() ? `<button class="btn icon small danger" data-del-svc="${esc(s.name)}" title="Eliminar servicio">✕</button>` : ''}</td>
        </tr>`).join('')}</tbody></table>` : '<div style="color:var(--dim)">Sin servicios.</div>'}

      ${isStaff() ? `<form id="add-svc-form" style="margin-top:14px">
        <label>Agregar servicio</label>
        <div class="presets">Atajos privados:
          <button type="button" class="btn small" data-preset="ssh">SSH :22</button>
          <button type="button" class="btn small" data-preset="rdp">Escritorio remoto :3389</button>
          <button type="button" class="btn small" data-preset="vnc">VNC :5900</button>
        </div>
        <div class="svc-row" style="grid-template-columns:1fr 1fr 1fr 1fr">
          <div><label>Nombre</label><input name="name" required maxlength="20" pattern="[a-z0-9]([a-z0-9\\-]*[a-z0-9])?" placeholder="web"></div>
          <div><label>Tipo</label><select name="type"><option value="http">http</option><option value="https">https (SNI)</option><option value="tcp">tcp</option><option value="stcp">privado (stcp)</option></select></div>
          <div><label>IP local</label><input name="localIp" value="127.0.0.1"></div>
          <div><label>Puerto</label><input name="localPort" type="number" min="1" max="65535" required placeholder="1880"></div>
          <div style="grid-column:1/3"><label>Subdominio / puerto remoto</label><input name="extra" placeholder="automático"></div>
          <div><label>TLS (https)</label><select name="tlsMode"><option value="local">en la máquina</option><option value="passthrough">del servicio</option></select></div>
          <div style="align-self:end"><button class="btn primary small" type="submit" style="width:100%;justify-content:center">Agregar</button></div>
        </div>
        <div class="hint">Después de agregar o quitar servicios, descargue el frpc.toml de nuevo y conserve el token actual en la línea metadatas.token.
          Los <b>privados</b> no abren puertos en internet: solo entran las máquinas a las que les dé acceso.</div>
      </form>` : ''}
    </section>

    ${typeof snmpSection === 'function' ? snmpSection(m) : ''}

    ${isStaff() ? visitsSection(m) : ''}

    ${isStaff() ? `<section>
      <h4>🤖 Inteligencia artificial</h4>
      <div class="ai-summary" id="ai-summary">${m.ai ? 'Alcance habilitado' : 'La IA no tiene alcance sobre esta máquina'}</div>
      <div class="actions" style="margin-top:10px">
        <button class="btn small primary" data-ai-act="chat">Abrir asistente</button>
        <button class="btn small" data-ai-act="scope">Configurar alcance</button>
      </div>
    </section>` : ''}

    <section>
      <h4>Actividad de la máquina</h4>
      <ul class="events">${events.length ? events.map((e) => eventItem(e, false)).join('') : '<li style="border:0;color:var(--dim)">Sin eventos</li>'}</ul>
    </section>`;

  if (formValues) {
    const f = $('#add-svc-form', d);
    for (const [k, v] of Object.entries(formValues)) if (f.elements[k]) f.elements[k].value = v;
  }
  if (isStaff() && typeof aiDrawerSummary === 'function') aiDrawerSummary(m);
}

$('#drawer').addEventListener('click', async (e) => {
  const m = state.machines.find((x) => x.id === state.openId);
  if (!m) return;
  const copyEl = e.target.closest('[data-copy-text]');
  if (copyEl) { e.preventDefault(); return copy(copyEl.dataset.copyText); }
  const preset = e.target.closest('[data-preset]');
  if (preset) {
    const p = PRESETS[preset.dataset.preset];
    const f = $('#add-svc-form');
    f.elements.name.value = p.name; f.elements.type.value = 'stcp'; f.elements.localIp.value = '127.0.0.1'; f.elements.localPort.value = p.port; f.elements.extra.value = '';
    return;
  }
  const acc = e.target.closest('[data-acc]');
  if (acc) return accessAction(m, acc.dataset.acc, acc.dataset);
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
    if (act === 'enroll') openEnroll(m);
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
  if (f.extra.trim() && f.type !== 'stcp') { if (f.type === 'tcp') body.remotePort = Number(f.extra); else body.subdomain = f.extra.trim(); }
  if (f.type === 'https') body.tlsMode = f.tlsMode;
  try {
    await api('POST', `/machines/${state.openId}/services`, body);
    e.target.reset();
    toast('Servicio agregado');
    refresh();
  } catch (err) { toast(err.message, true); }
});

// ---------- servicios privados (stcp) y accesos ----------

const PRESETS = { ssh: { name: 'ssh', port: 22 }, rdp: { name: 'rdp', port: 3389 }, vnc: { name: 'vnc', port: 5900 } };

/** Celda "Público" de un servicio privado: quién tiene acceso y acciones. */
function privateCell(m, s) {
  const chips = s.access.map((a) => `<span class="chip" title="Puerto local ${a.bindPort} en ${esc(a.visitor)}">
      <span class="dot ${a.visitorOnline ? 'online' : 'offline'}" style="margin:0"></span>${esc(a.visitor)}<small>:${a.bindPort}</small>
      <button data-acc="revoke" data-id="${a.id}" title="Quitar acceso">✕</button></span>`).join('');
  return `<div class="private-cell">
      <span class="lock">🔒 Privado · sin puerto público</span>
      <div class="chips">${chips || '<span style="color:var(--dim)">Nadie tiene acceso todavía</span>'}</div>
      <div class="actions">
        <button class="btn small primary" data-acc="grant" data-svc="${esc(m.id)}/${esc(s.name)}">+ Acceso</button>
        <button class="btn small" data-acc="rotate" data-svc="${esc(s.name)}" title="Genera una clave nueva: los visitantes deben actualizar sus accesos">Rotar clave</button>
      </div>
    </div>`;
}

/** Sección "Accesos privados desde esta máquina": a qué servicios privados de otras máquinas entra. */
function visitsSection(m) {
  const anyPrivate = state.machines.some((x) => x.id !== m.id && x.services.some((s) => s.private));
  if (!m.visits.length && !anyPrivate) return '';
  const rows = m.visits.map((a) => `<tr>
      <td><b>${esc(a.machine)}</b> / ${esc(a.service)}<br><span class="tag state-${a.serviceOnline ? 'online' : 'offline'}" style="margin-top:4px;display:inline-block">${a.serviceOnline ? 'activo' : 'sin conectar'}</span></td>
      <td class="hide-sm" style="font-family:var(--code);font-size:11px;white-space:nowrap">127.0.0.1:${a.bindPort}<br><span style="color:var(--dim)">${esc(a.kind)}</span></td>
      <td class="url"><a href="#" data-copy-text="${esc(a.connect)}" title="Copiar">${esc(a.connect)}</a></td>
      <td class="row-btns">${a.kind === 'Escritorio remoto' ? `<button class="btn small" data-acc="rdp" data-id="${a.id}" title="Descargar archivo .rdp">.rdp</button> ` : ''}<button class="btn icon small danger" data-acc="revoke" data-id="${a.id}" title="Quitar acceso">✕</button></td>
    </tr>`).join('');
  return `<section>
      <h4>🔑 Accesos privados desde esta máquina</h4>
      ${m.visits.length ? `<table>
        <thead><tr><th>Servicio</th><th class="hide-sm">En este equipo</th><th>Conectar</th><th></th></tr></thead>
        <tbody>${rows}</tbody></table>` : '<div style="color:var(--dim)">Esta máquina no entra a ningún servicio privado.</div>'}
      <div class="actions" style="margin-top:12px">
        ${anyPrivate ? `<button class="btn small primary" data-acc="grant" data-visitor="${esc(m.id)}">+ Dar acceso a un servicio privado</button>` : ''}
        ${m.visits.length ? `<button class="btn small" data-acc="files" data-visitor="${esc(m.id)}">Descargar accesos para este equipo</button>` : ''}
      </div>
      <div class="hint">Cada vez que cambien los accesos, ejecute el script de accesos <b>en este equipo</b>: guarda las claves y reinicia frpc.</div>
    </section>`;
}

const ACCESS_FILES = {
  windows: { file: (id) => `accesos-${id}.ps1`, icon: '🪟', name: 'Windows', desc: 'Script: guarda y reinicia frpc' },
  linux: { file: (id) => `accesos-${id}.sh`, icon: '🐧', name: 'Linux', desc: 'Script: guarda y reinicia frpc' },
  toml: { file: (id) => `accesos-${id}.toml`, icon: '⚙', name: 'Solo el archivo', desc: 'Junto al frpc.toml; reinicie frpc' },
};

function accessFilesHtml(visitorId, title) {
  return `<div class="ok-title" style="color:var(--green);margin-bottom:10px">${title}</div>
    <div class="sub" style="margin-bottom:12px">Descargue los accesos y ejecútelos en el equipo <b>${esc(visitorId)}</b>:</div>
    <div class="installers">${Object.entries(ACCESS_FILES).map(([k, f]) => `<button class="installer" data-acc-file="${k}" data-visitor="${esc(visitorId)}">
      <span class="i-icon">${f.icon}</span><span class="i-name">${f.name}</span><span class="i-desc">${f.desc}</span></button>`).join('')}</div>
    <div class="install-help hidden" data-acc-help></div>
    <div class="hint" style="margin-top:10px">⚠ Contiene las claves de acceso: no lo comparta. El dueño del servicio se reconecta solo (unos 15 s) para aplicar el cambio.</div>`;
}

function accessHelp(platform, id) {
  const file = ACCESS_FILES[platform].file(id);
  const cmd = (c) => `<code title="Clic para copiar">${esc(c)}</code>`;
  const steps = {
    windows: [`Copie ${esc(file)} al equipo y ejecute en PowerShell (como administrador si frpc se instaló así): ${cmd(`powershell -ExecutionPolicy Bypass -File .\\${file}`)}`,
      `Si ejecuta frpc a mano, ponga el script en la carpeta de frpc.exe y reinicie frpc al terminar.`],
    linux: [`Copie ${esc(file)} al equipo y ejecútelo: ${cmd(`sudo bash ${file}`)}`],
    toml: [`Guárdelo con ese nombre en la carpeta desde donde ejecuta frpc (o la de instalación: /etc/iit-frpc o %ProgramData%\\iit-frpc).`, `Reinicie frpc.`],
  }[platform];
  return `<div class="ok-title">✔ ${esc(file)} descargado</div><ol>${steps.map((x) => `<li>${x}</li>`).join('')}</ol>`;
}

async function downloadAccess(platform, visitorId) {
  const path = platform === 'toml' ? `/machines/${encodeURIComponent(visitorId)}/accesos.toml` : `/machines/${encodeURIComponent(visitorId)}/accesos/${platform}`;
  let text = await api('GET', path);
  if (platform === 'windows' && !text.startsWith('\uFEFF')) text = '\uFEFF' + text; // fetch() quita el BOM
  download(ACCESS_FILES[platform].file(visitorId), text, platform === 'linux' ? 'text/x-shellscript' : 'text/plain');
  return accessHelp(platform, visitorId);
}

function openAccessModal({ svc, visitor } = {}) {
  const f = $('#access-form');
  f.reset();
  $('#access-error').textContent = '';
  f.classList.remove('hidden');
  $('#access-next').classList.add('hidden');
  const targets = state.machines.flatMap((m) => m.services.filter((s) => s.private).map((s) => ({ m, s })));
  f.elements.target.innerHTML = targets.map(({ m, s }) =>
    `<option value="${esc(m.id)}/${esc(s.name)}">${esc(m.name)} · ${esc(s.name)} (puerto ${s.localPort})</option>`).join('');
  if (svc) f.elements.target.value = svc;
  const fillVisitors = () => {
    const owner = f.elements.target.value.split('/')[0];
    const cur = f.elements.visitor.value || visitor;
    f.elements.visitor.innerHTML = state.machines.filter((m) => m.id !== owner)
      .map((m) => `<option value="${esc(m.id)}">${esc(m.name)}${m.client ? ' · ' + esc(m.client) : ''} (${esc(m.id)})</option>`).join('');
    if (cur) f.elements.visitor.value = cur;
  };
  f.elements.target.onchange = fillVisitors;
  fillVisitors();
  $('#access-modal').classList.remove('hidden');
}

$('#access-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const [machine, service] = f.elements.target.value.split('/');
  const body = { machine, service, visitor: f.elements.visitor.value };
  if (f.elements.bindPort.value) body.bindPort = Number(f.elements.bindPort.value);
  $('#access-error').textContent = '';
  try {
    const a = await api('POST', '/access', body);
    f.classList.add('hidden');
    const next = $('#access-next');
    next.innerHTML = `<h2>Acceso otorgado</h2>
      <div class="sub">${esc(a.visitor)} entrará a <b>${esc(a.machine)}/${esc(a.service)}</b> en <b>127.0.0.1:${a.bindPort}</b> · ${esc(a.kind)}: <code>${esc(a.connect)}</code></div>
      ${accessFilesHtml(a.visitor, 'Siguiente paso')}
      <div class="modal-actions"><button class="btn" data-close>Listo</button></div>`;
    next.classList.remove('hidden');
    refresh();
  } catch (err) { $('#access-error').textContent = err.message; }
});

$('#access-modal').addEventListener('click', async (e) => {
  const code = e.target.closest('.install-help code');
  if (code) return copy(code.textContent);
  const b = e.target.closest('[data-acc-file]');
  if (!b) return;
  try {
    const help = $('[data-acc-help]', $('#access-modal'));
    help.innerHTML = await downloadAccess(b.dataset.accFile, b.dataset.visitor);
    help.classList.remove('hidden');
  } catch (err) { toast(err.message, true); }
});

async function accessAction(m, act, d) {
  try {
    if (act === 'grant') return openAccessModal({ svc: d.svc, visitor: d.visitor });
    if (act === 'files') {
      const f = $('#access-form');
      f.classList.add('hidden');
      const next = $('#access-next');
      next.innerHTML = `<h2>Accesos de ${esc(d.visitor)}</h2>${accessFilesHtml(d.visitor, '')}<div class="modal-actions"><button class="btn" data-close>Listo</button></div>`;
      next.classList.remove('hidden');
      $('#access-modal').classList.remove('hidden');
      return;
    }
    if (act === 'revoke') {
      if (!confirm('¿Quitar este acceso? El dueño del servicio se reconecta en unos segundos y el visitante deja de entrar.')) return;
      await api('DELETE', `/access/${d.id}`);
      toast('Acceso revocado');
      return refresh();
    }
    if (act === 'rotate') {
      if (!confirm(`¿Rotar la clave de "${d.svc}"? Todos los visitantes deberán descargar y ejecutar sus accesos de nuevo.`)) return;
      const r = await api('POST', `/machines/${m.id}/services/${encodeURIComponent(d.svc)}/rotate-secret`);
      toast(r.visitors.length ? `Clave rotada. Actualice los accesos en: ${r.visitors.join(', ')}` : 'Clave rotada');
      return refresh();
    }
    if (act === 'rdp') {
      const text = await api('GET', `/access/${d.id}/rdp`);
      const a = m.visits.find((x) => String(x.id) === d.id);
      download(`${a ? `${a.machine}-${a.service}` : 'acceso'}.rdp`, text, 'application/x-rdp');
      toast('Abra el .rdp en este equipo con frpc y los accesos aplicados');
    }
  } catch (err) { toast(err.message, true); }
}

// ---------- registrar máquina ----------

function extraFor(type) {
  if (type === 'stcp') return `<label>Acceso</label><div class="hint" style="margin:0;padding:8px 0">🔒 Privado, sin puerto público</div>`;
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
const isLoopHost = (h) => !h || h === 'localhost' || h === '::1' || /^127\./.test(h);
/** Dirección de frps a proponer: la última usada, FRPS_PUBLIC_ADDR o la del panel, sin preferir 127.0.0.1 si hay otra. */
function defaultServerAddr() {
  let saved = '';
  try { saved = localStorage.getItem(SERVER_KEY) || ''; } catch {}
  const options = [saved, state.summary?.frps?.publicAddr || '', location.hostname].filter(Boolean);
  return options.find((h) => !isLoopHost(h)) || options[0] || '';
}
let creds = null; // { machine, token } — solo en memoria mientras el modal está abierto

function showCreds(m, token, toml, title) {
  creds = { machine: m, token };
  $('#creds-title').textContent = title;
  $('#creds-sub').textContent = `${m.name}${m.client ? ' · ' + m.client : ''} · usuario frp: ${m.id}`;
  $('#creds-token').textContent = token;
  $('#creds-toml').textContent = toml;
  $('#creds-error').textContent = '';
  $('#install-help').classList.add('hidden');
  $('#creds-server').value = defaultServerAddr();
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
  if (open?.dataset.locked) return; // cambio de contraseña obligatorio
  if (open) open.classList.add('hidden'); else if (state.openId) closeDrawer();
});

// ---------- arranque ----------

async function start() {
  try { state.me = await api('GET', '/auth/me'); }
  catch { return endSession(); }
  applyRole();
  showApp();
  if (state.me.user.mustChangePassword) openAccount(true);
  refresh();
  if (typeof statusDot === 'function') statusDot();
  clearInterval(state.timer);
  state.timer = setInterval(() => { if (!document.hidden) refresh(); }, 5000);
}

// Arranque: token guardado en esta pestaña, o la cookie de sesión si sigue vigente
try { state.token = sessionStorage.getItem(TOKEN_KEY); } catch {}
(async () => {
  try { state.me = await api('GET', '/auth/me', null, { quiet401: true }); start(); }
  catch { state.token = null; showLogin(); }
})();
