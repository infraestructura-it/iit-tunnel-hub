'use strict';
// Panel: mi cuenta (contraseña y 2FA) y administración de usuarios y clientes. Usa api(), $, esc… de app.js.

// ---------- mi cuenta ----------

function openAccount(forced = false) {
  const me = state.me?.user;
  if (!me) return;
  const modal = $('#account-modal');
  modal.dataset.locked = forced ? '1' : '';
  $('#account-forced').classList.toggle('hidden', !forced);
  $('#account-close').classList.toggle('hidden', forced);
  $('#account-sub').innerHTML = me.via === 'token'
    ? 'Entró con el token de administración: no tiene cuenta propia. Cree usuarios en 👥 Usuarios.'
    : `<b>${esc(me.name || me.username)}</b> · ${esc(me.username)} · ${esc(me.roleLabel)}${state.me.clients.length && me.role !== 'admin' ? ' · ' + state.me.clients.map((c) => esc(c.name)).join(', ') : ''}`;
  $('#password-form').classList.toggle('hidden', me.via === 'token');
  $('#totp-section').classList.toggle('hidden', me.via === 'token' || forced);
  $('#password-form').reset();
  $('#password-error').textContent = '';
  $('#totp-error').textContent = '';
  renderTotp();
  modal.classList.remove('hidden');
  if (forced) setTimeout(() => $('#password-form [name="current"]').focus(), 0);
}

function renderTotp(setup = null) {
  const me = state.me.user;
  const box = $('#totp-body');
  if (me.totp) {
    box.innerHTML = `<div class="ok-line">✔ Activa: al entrar se pide el código de su app.</div>
      <form id="totp-off" class="row" style="align-items:end;margin-top:10px">
        <div class="field" style="margin:0"><label>Contraseña para desactivarla</label><input name="password" type="password" required autocomplete="current-password"></div>
        <div style="flex:none"><button class="btn small danger" type="submit">Desactivar</button></div>
      </form>`;
    return;
  }
  if (!setup) {
    box.innerHTML = `<div class="hint" style="margin:0 0 10px">Protege su cuenta aunque alguien conozca su contraseña. Use Google Authenticator, Microsoft Authenticator, Authy o similar.</div>
      <button class="btn small primary" type="button" id="totp-start">Activar verificación en dos pasos</button>`;
    return;
  }
  box.innerHTML = `<div class="totp-setup">
      <div class="qr" id="totp-qr"><span class="hint">Cargando código QR…</span></div>
      <div>
        <ol class="steps">
          <li>En la app, agregue una cuenta escaneando el código.</li>
          <li>Si no puede escanear, ingrese esta clave: <code class="copyable" title="Clic para copiar">${esc(setup.secret.replace(/(.{4})/g, '$1 ').trim())}</code></li>
          <li>Escriba el código de 6 dígitos que muestra la app.</li>
        </ol>
        <form id="totp-on" class="row" style="align-items:end">
          <div class="field" style="margin:0"><label>Código</label><input name="code" inputmode="numeric" maxlength="6" pattern="[0-9]{6}" required autocomplete="one-time-code" placeholder="123456"></div>
          <div style="flex:none"><button class="btn small primary" type="submit">Confirmar</button></div>
        </form>
      </div>
    </div>`;
  drawQr(setup.uri);
}

// QR con qrcode-generator 1.4.4 (MIT, Kazuhiko Arase), servido por el propio hub desde vendor/: funciona sin internet.
let qrLib = null;
function loadQrLib() {
  if (window.qrcode) return Promise.resolve(window.qrcode);
  if (qrLib) return qrLib;
  qrLib = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'vendor/qrcode.js';
    s.onload = () => resolve(window.qrcode);
    s.onerror = () => { qrLib = null; reject(new Error('sin conexión')); };
    document.head.appendChild(s);
  });
  return qrLib;
}
async function drawQr(uri) {
  const el = $('#totp-qr');
  try {
    const qrcode = await loadQrLib();
    const qr = qrcode(0, 'M');
    qr.addData(uri);
    qr.make();
    el.innerHTML = qr.createSvgTag(4, 8);
  } catch {
    el.innerHTML = '<span class="hint">No se pudo dibujar el QR. Use la clave de texto.</span>';
  }
}

$('#account-modal').addEventListener('click', async (e) => {
  if (e.target.closest('.copyable')) return copy(e.target.closest('.copyable').textContent.replace(/\s/g, ''));
  if (e.target.id !== 'totp-start') return;
  try { renderTotp(await api('POST', '/auth/totp/setup')); }
  catch (err) { $('#totp-error').textContent = err.message; }
});

$('#account-modal').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  try {
    if (e.target.id === 'password-form') {
      $('#password-error').textContent = '';
      if (f.password !== f.password2) { $('#password-error').textContent = 'Las contraseñas no coinciden'; return; }
      const r = await api('POST', '/auth/password', { current: f.current, password: f.password });
      state.me.user = { ...state.me.user, ...r.user };
      e.target.reset();
      const wasForced = !!$('#account-modal').dataset.locked;
      toast('Contraseña cambiada');
      if (wasForced) { $('#account-modal').classList.add('hidden'); $('#account-modal').dataset.locked = ''; refresh(); }
    }
    if (e.target.id === 'totp-on') {
      $('#totp-error').textContent = '';
      const r = await api('POST', '/auth/totp/enable', { code: f.code });
      state.me.user = { ...state.me.user, ...r.user };
      renderTotp();
      toast('Verificación en dos pasos activada');
    }
    if (e.target.id === 'totp-off') {
      $('#totp-error').textContent = '';
      const r = await api('POST', '/auth/totp/disable', { password: f.password });
      state.me.user = { ...state.me.user, ...r.user };
      renderTotp();
      toast('Verificación en dos pasos desactivada');
    }
  } catch (err) {
    $(e.target.id === 'password-form' ? '#password-error' : '#totp-error').textContent = err.message;
  }
});

$('#user-btn').addEventListener('click', () => openAccount(false));

// ---------- usuarios y clientes (administrador) ----------

const um = { users: [], clients: [], editing: null };

async function openUsers() {
  $('#users-modal').classList.remove('hidden');
  showUsersTab('users');
  await loadUsers();
  editUser(null);
}

function showUsersTab(tab) {
  $$('#users-tabs .tab').forEach((b) => b.classList.toggle('active', b.dataset.utab === tab));
  $$('#users-modal [data-upanel]').forEach((p) => p.classList.toggle('hidden', p.dataset.upanel !== tab));
}

async function loadUsers() {
  try {
    [um.users, um.clients] = await Promise.all([api('GET', '/users'), api('GET', '/clients')]);
  } catch (err) { toast(err.message, true); return; }
  const clientName = (id) => um.clients.find((c) => c.id === id)?.name || id;
  $('#users-list').innerHTML = `<table class="users-table">
    <thead><tr><th>Usuario</th><th>Rol</th><th class="hide-sm">Clientes</th><th class="hide-sm">Último ingreso</th><th></th></tr></thead>
    <tbody>${um.users.map((u) => `<tr class="${u.enabled ? '' : 'off'}">
      <td><b>${esc(u.username)}</b>${u.name ? `<br><span style="color:var(--muted)">${esc(u.name)}</span>` : ''}
        <div class="badges">${u.totp ? '<span class="tag state-online">2FA</span>' : ''}${u.locked ? '<span class="tag bad">bloqueado</span>' : ''}${!u.enabled ? '<span class="tag state-offline">deshabilitado</span>' : ''}${u.mustChangePassword ? '<span class="tag warn">contraseña temporal</span>' : ''}</div></td>
      <td><span class="tag role-${u.role}">${esc(u.roleLabel)}</span></td>
      <td class="hide-sm">${u.role === 'admin' ? '<span style="color:var(--dim)">todos</span>' : esc((u.role === 'cliente' ? [u.client] : u.clients).map(clientName).join(', ') || '—')}</td>
      <td class="hide-sm">${u.lastLoginAt ? ago(u.lastLoginAt) : 'nunca'}</td>
      <td><button class="btn small" data-edit-user="${u.id}">Editar</button></td>
    </tr>`).join('')}</tbody></table>`;
  $('#clients-list').innerHTML = um.clients.length ? `<table>
    <thead><tr><th>Cliente</th><th>Máquinas</th><th></th></tr></thead>
    <tbody>${um.clients.map((c) => `<tr>
      <td><b>${esc(c.name)}</b><br><span style="color:var(--dim);font-family:var(--code);font-size:11px">${esc(c.id)}</span></td>
      <td>${c.machines}</td>
      <td style="white-space:nowrap"><button class="btn small" data-rename-client="${esc(c.id)}">Renombrar</button>
        <button class="btn icon small danger" data-del-client="${esc(c.id)}" title="Eliminar">✕</button></td>
    </tr>`).join('')}</tbody></table>` : '<div style="color:var(--dim)">Aún no hay clientes. Se crean al registrar máquinas con cliente o aquí.</div>';
  fillClientPickers();
}

function fillClientPickers(selected = []) {
  $('#user-clients').innerHTML = um.clients.length
    ? um.clients.map((c) => `<label class="check"><input type="checkbox" value="${esc(c.id)}" ${selected.includes(c.id) ? 'checked' : ''}> ${esc(c.name)}</label>`).join('')
    : '<span class="hint" style="margin:0">Primero cree clientes (pestaña Clientes).</span>';
  $('#user-client').innerHTML = um.clients.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
}

function syncRoleFields() {
  const r = $('#user-form [name="role"]').value;
  $$('#user-form [data-role-field]').forEach((el) => el.classList.toggle('hidden', el.dataset.roleField !== r));
}

function editUser(u) {
  um.editing = u;
  const f = $('#user-form');
  f.reset();
  $('#user-error').textContent = '';
  $('#user-temp').classList.add('hidden');
  f.elements.id.value = u ? u.id : '';
  f.elements.username.readOnly = !!u;
  if (u) {
    f.elements.username.value = u.username;
    f.elements.name.value = u.name;
    f.elements.role.value = u.role;
  }
  fillClientPickers(u ? u.clients : []);
  if (u?.role === 'cliente') $('#user-client').value = u.client;
  $('#user-form-title').textContent = u ? `Editar ${u.username}` : 'Nuevo usuario';
  $('#user-submit').textContent = u ? 'Guardar cambios' : 'Crear usuario';
  $('#user-password-row').classList.toggle('hidden', !!u);
  const self = u && u.id === state.me.user.id;
  for (const b of $$('#user-form [data-uact]')) {
    const a = b.dataset.uact;
    b.classList.toggle('hidden', !u || (self && ['toggle', 'delete'].includes(a)) || (a === 'reset-totp' && !u.totp));
  }
  if (u) $('#user-form [data-uact="toggle"]').textContent = u.enabled ? (u.locked ? 'Desbloquear' : 'Deshabilitar') : 'Habilitar';
  syncRoleFields();
}

function showTemp(username, pw) {
  const el = $('#user-temp');
  el.innerHTML = `<div class="secret"><span>Contraseña temporal de <b>${esc(username)}</b>: ${esc(pw)}</span><button class="btn small" type="button" data-copy-temp="${esc(pw)}">Copiar</button></div>
    <div class="warning">Entréguela por un canal seguro: no se vuelve a mostrar. Deberá cambiarla al entrar.</div>`;
  el.classList.remove('hidden');
}

$('#users-btn').addEventListener('click', openUsers);
$('#users-tabs').addEventListener('click', (e) => { const t = e.target.closest('.tab'); if (t) showUsersTab(t.dataset.utab); });
$('#user-form [name="role"]').addEventListener('change', syncRoleFields);

$('#users-modal').addEventListener('click', async (e) => {
  const t = e.target;
  if (t.closest('[data-copy-temp]')) return copy(t.closest('[data-copy-temp]').dataset.copyTemp);
  const ed = t.closest('[data-edit-user]');
  if (ed) { editUser(um.users.find((u) => String(u.id) === ed.dataset.editUser)); $('#user-form').scrollIntoView({ behavior: 'smooth' }); return; }
  const act = t.closest('[data-uact]')?.dataset.uact;
  const u = um.editing;
  try {
    if (act === 'new') return editUser(null);
    if (act === 'reset-password' && u) {
      if (!confirm(`¿Restablecer la contraseña de ${u.username}? Se cerrarán sus sesiones.`)) return;
      const r = await api('PATCH', `/users/${u.id}`, { resetPassword: true });
      await loadUsers(); editUser(r.user); showTemp(u.username, r.tempPassword);
    }
    if (act === 'reset-totp' && u) {
      if (!confirm(`¿Quitar la verificación en dos pasos de ${u.username}? (por ejemplo, si perdió el teléfono)`)) return;
      const r = await api('PATCH', `/users/${u.id}`, { resetTotp: true });
      await loadUsers(); editUser(r.user); toast('2FA quitado');
    }
    if (act === 'toggle' && u) {
      const enable = !u.enabled || u.locked;
      const r = await api('PATCH', `/users/${u.id}`, { enabled: enable });
      await loadUsers(); editUser(r.user); toast(enable ? 'Usuario habilitado' : 'Usuario deshabilitado: sus sesiones se cerraron');
    }
    if (act === 'delete' && u) {
      if (prompt(`Para eliminar escriba el usuario: ${u.username}`) !== u.username) return;
      await api('DELETE', `/users/${u.id}`);
      await loadUsers(); editUser(null); toast('Usuario eliminado');
    }
    const rn = t.closest('[data-rename-client]');
    if (rn) {
      const c = um.clients.find((x) => x.id === rn.dataset.renameClient);
      const name = prompt('Nuevo nombre del cliente', c.name);
      if (!name || name.trim() === c.name) return;
      await api('PATCH', `/clients/${encodeURIComponent(c.id)}`, { name: name.trim() });
      await loadUsers(); refresh(); toast('Cliente renombrado');
    }
    const dc = t.closest('[data-del-client]');
    if (dc) {
      if (!confirm('¿Eliminar este cliente? Sus usuarios de cliente también se eliminan.')) return;
      await api('DELETE', `/clients/${encodeURIComponent(dc.dataset.delClient)}`);
      await loadUsers(); toast('Cliente eliminado');
    }
  } catch (err) {
    if (t.closest('#clients-list')) $('#client-error').textContent = err.message;
    else $('#user-error').textContent = err.message;
  }
});

$('#user-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  const body = { name: f.name.value.trim(), role: f.role.value };
  if (body.role === 'tecnico') body.clients = $$('#user-clients input:checked').map((i) => i.value);
  if (body.role === 'cliente') body.client = $('#user-client').value;
  $('#user-error').textContent = '';
  try {
    if (um.editing) {
      const r = await api('PATCH', `/users/${um.editing.id}`, body);
      await loadUsers(); editUser(r.user); toast('Usuario actualizado');
    } else {
      body.username = f.username.value.trim().toLowerCase();
      if (f.password.value) body.password = f.password.value;
      const r = await api('POST', '/users', body);
      await loadUsers(); editUser(null);
      if (r.tempPassword) showTemp(r.user.username, r.tempPassword);
      else toast('Usuario creado');
    }
  } catch (err) { $('#user-error').textContent = err.message; }
});

$('#client-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#client-error').textContent = '';
  try {
    await api('POST', '/clients', { name: e.target.elements.name.value.trim() });
    e.target.reset();
    await loadUsers();
    state.me = await api('GET', '/auth/me'); applyRole();
    toast('Cliente creado');
  } catch (err) { $('#client-error').textContent = err.message; }
});
