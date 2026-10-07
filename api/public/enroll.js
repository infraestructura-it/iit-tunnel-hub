'use strict';
// Panel: instalación con código de un solo uso (solo administradores).
// Desde la ficha de una máquina: reinstala esa máquina. Desde la barra: crea una máquina nueva al instalar.

const enroll = { machine: null, timer: null, expiresAt: 0 };
const ENROLL_STATUS = { vigente: ['state-online', 'vigente'], usado: ['stcp', 'usado'], vencido: ['state-offline', 'vencido'], revocado: ['state-offline', 'revocado'] };

function openEnroll(machine = null) {
  enroll.machine = machine;
  clearInterval(enroll.timer);
  const f = $('#enroll-form');
  f.reset();
  $('#enroll-error').textContent = '';
  $('#enroll-result').classList.add('hidden');
  $('#enroll-client-row').classList.toggle('hidden', !!machine);
  $('#enroll-sub').innerHTML = machine
    ? `Reinstalar <b>${esc(machine.name)}</b> (${esc(machine.id)}) desde el propio equipo. El equipo instalado hoy sigue conectado hasta que se use el código.`
    : 'Registra una máquina nueva desde el propio equipo, sin descargar archivos con el token.';
  $('#enroll-client').innerHTML = `<option value="">Sin cliente</option>${(state.me?.clients || []).map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}`;
  $('#enroll-server').value = defaultServerAddr();
  $('#enroll-title').textContent = machine ? `Reinstalar ${machine.name} con código` : 'Máquina nueva con código';
  $('#enroll-modal').classList.remove('hidden');
  loadEnrollments();
}

async function loadEnrollments() {
  const box = $('#enroll-list');
  try {
    let list = await api('GET', '/enrollments');
    if (enroll.machine) list = list.filter((e) => e.machine === enroll.machine.id || e.usedMachine === enroll.machine.id);
    if (!list.length) { box.innerHTML = '<div class="hint">Aún no hay códigos.</div>'; return; }
    box.innerHTML = `<table class="enroll-table"><thead><tr><th>Código</th><th>Para</th><th>Estado</th><th class="hide-sm">Creado</th><th></th></tr></thead><tbody>
      ${list.slice(0, 20).map((e) => {
        const [cls, label] = ENROLL_STATUS[e.status] || ['', e.status];
        const target = e.mode === 'maquina' ? esc(e.machine) : `nueva · ${esc(e.client || 'sin cliente')}`;
        const detail = e.status === 'usado'
          ? `${esc(e.usedMachine || '')} · ${esc(e.usedHost || '')} · ${ago(e.usedAt)}`
          : e.status === 'vigente' ? `vence ${remaining(e.expiresAt)}` : '';
        return `<tr><td style="font-family:var(--code)">…${esc(e.hint)}</td><td>${target}</td>
          <td><span class="tag ${cls}">${label}</span><div class="hint" style="margin:2px 0 0">${detail}</div></td>
          <td class="hide-sm">${ago(e.createdAt)}<div class="hint" style="margin:2px 0 0">${esc(e.createdBy || '')}</div></td>
          <td class="row-btns">${e.status === 'vigente' ? `<button class="btn small danger" data-revoke="${e.id}">Revocar</button>` : ''}</td></tr>`;
      }).join('')}</tbody></table>`;
  } catch (err) { box.innerHTML = `<div class="error">${esc(err.message)}</div>`; }
}

function remaining(ts) {
  const s = Math.max(0, ts - Math.floor(Date.now() / 1000));
  if (s <= 0) return 'ya';
  if (s < 3600) return `en ${Math.ceil(s / 60)} min`;
  return `en ${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
}

function tickExpiry() {
  const s = enroll.expiresAt - Math.floor(Date.now() / 1000);
  const el = $('#enroll-expiry');
  if (s <= 0) { el.textContent = 'vencido'; el.classList.add('expired'); clearInterval(enroll.timer); return; }
  el.classList.remove('expired');
  el.textContent = `vence en ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

$('#enroll-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  const body = { minutes: Number(f.minutes), serverAddr: f.serverAddr.trim() };
  if (enroll.machine) body.machine = enroll.machine.id; else if (f.client) body.client = f.client;
  $('#enroll-error').textContent = '';
  $('#enroll-submit').disabled = true;
  try {
    const r = await api('POST', '/enrollments', body);
    try { localStorage.setItem(SERVER_KEY, r.enrollment.serverAddr); } catch {}
    $('#enroll-code').textContent = r.code;
    $('#enroll-cmd-windows').textContent = r.commands.windows;
    $('#enroll-cmd-linux').textContent = r.commands.linux;
    const lb = $('#enroll-loopback');
    lb.classList.toggle('hidden', !r.loopback && !r.base.startsWith('http://'));
    lb.textContent = r.loopback
      ? `⚠ La URL del hub es ${r.base}: solo funciona en este mismo equipo. Defina HUB_PUBLIC_URL (o abra el panel por la IP de red) para instalar en otros equipos.`
      : `⚠ La URL del hub usa http (${r.base}): el token viaja sin cifrar. Úsela solo dentro de su red; en producción, HTTPS.`;
    const adj = $('#enroll-adjusted');
    adj.classList.toggle('hidden', !r.serverAdjusted);
    adj.textContent = r.serverAdjusted ? `ℹ El servidor frps ${body.serverAddr || '127.0.0.1'} solo sirve en el propio hub: el código usa ${r.enrollment.serverAddr}.` : '';
    $('#enroll-server').value = r.enrollment.serverAddr;
    $('#enroll-note-mode').textContent = enroll.machine
      ? `Al usarlo se crea un token nuevo para ${enroll.machine.id}: si la máquina estaba instalada en otro equipo, ese queda desconectado.`
      : `La máquina aparece en el panel con el nombre del equipo${r.enrollment.client ? `, en el cliente ${r.enrollment.client}` : ''}.`;
    enroll.expiresAt = r.enrollment.expiresAt;
    clearInterval(enroll.timer);
    enroll.timer = setInterval(tickExpiry, 1000);
    tickExpiry();
    $('#enroll-result').classList.remove('hidden');
    loadEnrollments();
    refresh();
  } catch (err) {
    $('#enroll-error').textContent = err.message;
  } finally {
    $('#enroll-submit').disabled = false;
  }
});

$('#enroll-modal').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-revoke]');
  if (!b) return;
  if (!confirm('¿Revocar este código? Ya no se podrá usar para instalar.')) return;
  try { await api('DELETE', `/enrollments/${b.dataset.revoke}`); toast('Código revocado'); loadEnrollments(); refresh(); }
  catch (err) { toast(err.message, true); }
});

$('#enroll-new').addEventListener('click', () => openEnroll(null));
