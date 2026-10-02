'use strict';
// Panel · módulo de IA: chat (general y por máquina), acciones pendientes, ajustes y editor de alcance.
// Usa las utilidades globales de app.js: $, $$, esc, api, toast, copy, state, refresh.

const ai = { cid: 'general', machine: null, busy: false };

// ---------- formato de mensajes ----------

/** Markdown mínimo y seguro: escapa todo y luego aplica **negrita**, `código` y listas. */
function md(text) {
  const lines = esc(text).split('\n');
  let html = ''; let inList = false;
  for (const raw of lines) {
    const line = raw
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/^#{1,4}\s+(.*)$/, '<b>$1</b>');
    const li = /^\s*(?:[-*•]|\d+\.)\s+(.*)$/.exec(line);
    if (li) { if (!inList) { html += '<ul>'; inList = true; } html += `<li>${li[1]}</li>`; continue; }
    if (inList) { html += '</ul>'; inList = false; }
    html += line.trim() ? `<p>${line}</p>` : '';
  }
  return html + (inList ? '</ul>' : '');
}

const ACTION_LABEL = { pendiente: 'Pendiente', ejecutando: 'Ejecutando…', ejecutada: 'Ejecutada', fallida: 'Falló', rechazada: 'Rechazada', expirada: 'Expirada' };

function actionCard(a, withMachine = false) {
  const open = a.status === 'pendiente';
  return `<div class="action-card ${a.status}" data-action="${a.id}">
    <div class="ac-head"><b>Acción #${a.id}</b>${withMachine ? ` · <span style="color:var(--purple)">${esc(a.machine_id)}</span>` : ''}<span class="ac-status">${ACTION_LABEL[a.status] || a.status}</span></div>
    <div class="ac-summary">${esc(a.summary)}</div>
    ${a.reason ? `<div class="ac-reason">Motivo: ${esc(a.reason)}</div>` : ''}
    ${a.result && !open ? `<pre class="ac-result">${esc(a.result)}</pre>` : ''}
    ${a.decided_by && !open ? `<div class="ac-reason">${a.status === 'rechazada' ? 'Rechazada' : 'Aprobada'} desde ${esc(a.decided_by)}</div>` : ''}
    ${open ? `<div class="ac-buttons"><button class="btn small danger" data-ai-reject="${a.id}">Rechazar</button><button class="btn small primary" data-ai-approve="${a.id}">Aprobar y ejecutar</button></div>` : ''}
  </div>`;
}

function renderChat(view) {
  const box = $('#ai-chat');
  const items = view.messages.map((m) => {
    if (m.role === 'tool') return `<div class="msg tool">🔧 ${esc(m.text)}</div>`;
    if (m.role === 'system') return `<div class="msg system">${esc(m.text.split('\n')[0])}</div>`;
    return `<div class="msg ${m.role}">${m.role === 'assistant' ? md(m.text) : esc(m.text).replace(/\n/g, '<br>')}</div>`;
  });
  // Pendientes siempre; de las ya resueltas, solo las 2 últimas (el historial completo queda en la conversación)
  const pend = view.actions.filter((a) => a.status === 'pendiente' || a.status === 'ejecutando');
  const done = view.actions.filter((a) => !pend.includes(a)).slice(-2);
  const shown = [...done, ...pend];
  const acts = shown.length ? `<div class="chat-actions">${shown.map((a) => actionCard(a)).join('')}</div>` : '';
  box.innerHTML = items.length || acts
    ? items.join('') + acts + (ai.busy ? '<div class="msg assistant thinking"><span></span><span></span><span></span></div>' : '')
    : `<div class="chat-empty">${ai.machine
      ? `Pregunte por <b>${esc(ai.machine.name)}</b>: estado, diagnóstico, o pida una acción del alcance (requerirá su aprobación).`
      : 'Pregunte por cualquier máquina: “¿Qué equipos están caídos?”, “¿Hay desconexiones repetidas hoy?”.'}</div>`;
  box.scrollTop = box.scrollHeight;
}

// ---------- abrir ----------

async function openAI(machine = null) {
  ai.machine = machine;
  ai.cid = machine ? `m-${machine.id}` : 'general';
  $('#ai-title').textContent = machine ? `Asistente · ${machine.name}` : 'Asistente IA';
  $('#ai-sub').textContent = machine
    ? `${machine.client ? machine.client + ' · ' : ''}Solo opera sobre esta máquina y su alcance.`
    : 'Pregunte por el estado de las máquinas o pida diagnósticos.';
  const isAdmin = state.me?.user?.role === 'admin';
  $('#ai-settings-tab').classList.toggle('hidden', !!machine || !isAdmin);
  $('#ai-modal').classList.remove('hidden');
  if (!isAdmin) {
    // Los técnicos no ven los ajustes: solo si la IA está lista
    showTab('chat');
    if (!state.summary?.ai?.ready) { $('#ai-chat').innerHTML = '<div class="chat-empty">La IA no está configurada. Pídale al administrador que la active.</div>'; return; }
    await loadChat();
    $('#ai-text').focus();
    return;
  }
  const s = await api('GET', '/ai/settings').catch(() => null);
  if (!s?.enabled || !(s.apiKeyMasked)) {
    showTab(machine ? 'chat' : 'settings');
    if (machine) $('#ai-chat').innerHTML = '<div class="chat-empty">La IA no está configurada. Ábrala desde el botón 🤖 IA de arriba → Ajustes.</div>';
    if (!machine) loadSettings(s);
    return;
  }
  showTab('chat');
  await loadChat();
  $('#ai-text').focus();
}

function showTab(tab) {
  $$('#ai-tabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  $$('#ai-modal .tab-panel').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== tab));
  if (tab === 'pending') loadPending();
  if (tab === 'settings') loadSettings();
}

async function loadChat() {
  try { renderChat(await api('GET', `/ai/conversations/${encodeURIComponent(ai.cid)}`)); }
  catch (err) { toast(err.message, true); }
}

$('#ai-btn').addEventListener('click', () => openAI(null));
$('#ai-tabs').addEventListener('click', (e) => { const t = e.target.closest('.tab'); if (t) showTab(t.dataset.tab); });

// ---------- enviar ----------

$('#ai-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('#ai-text').value.trim();
  if (!text || ai.busy) return;
  ai.busy = true;
  $('#ai-send').disabled = true;
  $('#ai-text').value = '';
  const prev = await api('GET', `/ai/conversations/${encodeURIComponent(ai.cid)}`).catch(() => ({ messages: [], actions: [] }));
  prev.messages.push({ role: 'user', text });
  renderChat(prev);
  try {
    const r = await api('POST', `/ai/conversations/${encodeURIComponent(ai.cid)}/messages`, { text });
    ai.busy = false;
    renderChat(r);
    refresh();
  } catch (err) {
    ai.busy = false;
    renderChat(prev);
    toast(err.message, true);
    $('#ai-text').value = text;
  } finally {
    $('#ai-send').disabled = false;
    $('#ai-text').focus();
  }
});

$('#ai-text').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#ai-form').requestSubmit(); }
});

$('#ai-reset').addEventListener('click', async () => {
  if (!confirm('¿Empezar una conversación nueva? Se borra el historial de esta conversación.')) return;
  await api('DELETE', `/ai/conversations/${encodeURIComponent(ai.cid)}`).catch((e) => toast(e.message, true));
  loadChat();
});

// ---------- aprobar / rechazar ----------

$('#ai-modal').addEventListener('click', async (e) => {
  const ap = e.target.closest('[data-ai-approve]');
  const re = e.target.closest('[data-ai-reject]');
  if (!ap && !re) return;
  const id = (ap || re).dataset.aiApprove || (ap || re).dataset.aiReject;
  if (ap && !confirm(`¿Aprobar y ejecutar la acción #${id} en el equipo?`)) return;
  (ap || re).disabled = true;
  try {
    const r = await api('POST', `/ai/actions/${id}/${ap ? 'approve' : 'reject'}`);
    toast(ap ? (r.action.status === 'ejecutada' ? `Acción #${id} ejecutada` : `Acción #${id}: ${r.action.status}`) : `Acción #${id} rechazada`, r.action.status === 'fallida');
    if (!$('[data-panel="chat"]').classList.contains('hidden')) {
      if (r.action.conversation_id === (ai.machine ? `panel:m:${ai.machine.id}` : 'panel:general')) renderChat(r);
      else loadChat();
    } else loadPending();
    refresh();
  } catch (err) { toast(err.message, true); loadPending(); }
});

async function loadPending() {
  try {
    const list = await api('GET', '/ai/actions');
    $('#ai-pending').innerHTML = list.length
      ? list.map((a) => actionCard(a, true)).join('')
      : '<div class="chat-empty">No hay acciones esperando aprobación.</div>';
    $('#ai-tab-badge').textContent = list.length || '';
    $('#ai-tab-badge').classList.toggle('hidden', !list.length);
  } catch (err) { toast(err.message, true); }
}

// ---------- ajustes ----------

async function loadSettings(pre) {
  const s = pre || await api('GET', '/ai/settings').catch((e) => { toast(e.message, true); return null; });
  if (!s) return;
  const f = $('#ai-settings-form');
  f.elements.enabled.checked = s.enabled;
  f.elements.analyzeAlerts.checked = s.analyzeAlerts;
  f.elements.telegramBot.checked = s.telegramBot;
  f.elements.model.value = s.model;
  f.elements.maxSteps.value = s.maxSteps;
  f.elements.apiKey.value = '';
  f.elements.apiKey.disabled = s.apiKeyFromEnv;
  f.elements.apiKey.placeholder = s.apiKeyFromEnv ? `Definida en ANTHROPIC_API_KEY (${s.apiKeyMasked})` : s.apiKeyMasked ? `Configurada (${s.apiKeyMasked}) · deje vacío para conservarla` : 'sk-ant-…';
  const n = (x) => x.toLocaleString('es-CO');
  $('#ai-usage').innerHTML = `<b>Uso</b> · hoy: ${n(s.usage.today.requests)} llamadas, ${n(s.usage.today.input)} tokens de entrada, ${n(s.usage.today.output)} de salida · este mes: ${n(s.usage.month.requests)} llamadas, ${n(s.usage.month.input + s.usage.month.output)} tokens`;
  $('#ai-settings-error').textContent = '';
}

$('#ai-settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = {
    enabled: f.elements.enabled.checked,
    analyzeAlerts: f.elements.analyzeAlerts.checked,
    telegramBot: f.elements.telegramBot.checked,
    model: f.elements.model.value.trim(),
    maxSteps: Number(f.elements.maxSteps.value),
  };
  if (f.elements.apiKey.value.trim()) body.apiKey = f.elements.apiKey.value.trim();
  try {
    const s = await api('PUT', '/ai/settings', body);
    loadSettings(s);
    toast('Ajustes de IA guardados');
    refresh();
  } catch (err) { $('#ai-settings-error').textContent = err.message; }
});

// ---------- detalle de máquina ----------

async function aiDrawerSummary(m) {
  const el = $('#ai-summary');
  if (!el) return;
  try {
    const s = await api('GET', `/machines/${encodeURIComponent(m.id)}/ai-scope`);
    if (state.openId !== m.id || !$('#ai-summary')) return;
    const reads = [...s.http, ...s.commands].filter((x) => x.mode === 'read').length;
    const acts = s.http.length + s.commands.length - reads;
    $('#ai-summary').innerHTML = s.enabled
      ? `<span class="tag state-online">habilitada</span> ${reads} consulta(s) de lectura · ${acts} acción(es) con aprobación${s.ssh ? ` · SSH como <code>${esc(s.ssh.user)}</code>` : ''}`
      : '<span class="tag state-offline">sin alcance</span> La IA puede ver el estado de la máquina en el hub, pero no consultarla ni actuar sobre ella.';
  } catch {}
}

$('#drawer').addEventListener('click', (e) => {
  const act = e.target.closest('[data-ai-act]')?.dataset.aiAct;
  const m = state.machines.find((x) => x.id === state.openId);
  if (!act || !m) return;
  if (act === 'chat') openAI(m);
  if (act === 'scope') openScope(m);
});

// ---------- editor de alcance ----------

let scopeMachine = null;

function commandRow(c = {}) {
  return `<div class="scope-item" data-kind="command">
    <div class="scope-grid">
      <div><label>Id</label><input data-k="id" value="${esc(c.id || '')}" placeholder="estado-nodered" maxlength="40"></div>
      <div><label>Nombre</label><input data-k="name" value="${esc(c.name || '')}" placeholder="Estado de Node-RED" maxlength="80"></div>
      <div><label>Modo</label><select data-k="mode"><option value="read" ${c.mode === 'read' ? 'selected' : ''}>Lectura (automático)</option><option value="action" ${c.mode !== 'read' ? 'selected' : ''}>Acción (con aprobación)</option></select></div>
      <div class="wide"><label>Comando</label><input data-k="command" value="${esc(c.command || '')}" placeholder="systemctl status nodered --no-pager" maxlength="500" spellcheck="false"></div>
      <div class="wide"><label>Descripción para la IA</label><input data-k="description" value="${esc(c.description || '')}" placeholder="Cuándo usarlo y qué devuelve" maxlength="500"></div>
    </div>
    <button type="button" class="btn icon small danger" data-remove-item title="Quitar">✕</button>
  </div>`;
}

function httpRow(h = {}, services = []) {
  const headers = Object.entries(h.headers || {}).map(([k, v]) => `${k}: ${v}`).join('\n');
  const opts = services.filter((s) => s.type === 'http' || s.type === 'tcp')
    .map((s) => `<option value="${esc(s.name)}" ${s.name === h.service ? 'selected' : ''}>${esc(s.name)} (${s.type})</option>`).join('');
  const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((x) => `<option ${x === (h.method || 'GET') ? 'selected' : ''}>${x}</option>`).join('');
  return `<div class="scope-item" data-kind="http">
    <div class="scope-grid">
      <div><label>Id</label><input data-k="id" value="${esc(h.id || '')}" placeholder="estado-ups" maxlength="40"></div>
      <div><label>Nombre</label><input data-k="name" value="${esc(h.name || '')}" placeholder="Estado de la UPS" maxlength="80"></div>
      <div><label>Servicio</label><select data-k="service">${opts || '<option value="">(sin servicios http/tcp)</option>'}</select></div>
      <div><label>Método</label><select data-k="method">${methods}</select></div>
      <div><label>Modo</label><select data-k="mode"><option value="read" ${h.mode === 'read' ? 'selected' : ''}>Lectura (solo GET)</option><option value="action" ${h.mode !== 'read' ? 'selected' : ''}>Acción (con aprobación)</option></select></div>
      <div class="wide"><label>Ruta</label><input data-k="path" value="${esc(h.path || '')}" placeholder="/api/states/{entidad}" maxlength="500" spellcheck="false"></div>
      <div class="wide"><label>Cabeceras secretas (una por línea)</label><textarea data-k="headers" rows="2" spellcheck="false" placeholder="Authorization: Bearer eyJ…">${esc(headers)}</textarea></div>
      <div class="wide"><label>Cuerpo (JSON, opcional)</label><textarea data-k="body" rows="2" spellcheck="false" placeholder='{"entity_id": "{entidad}"}'>${esc(h.body || '')}</textarea></div>
      <div class="wide"><label>Descripción para la IA</label><input data-k="description" value="${esc(h.description || '')}" placeholder="Qué devuelve, valores normales, para qué sirve" maxlength="500"></div>
    </div>
    <button type="button" class="btn icon small danger" data-remove-item title="Quitar">✕</button>
  </div>`;
}

async function openScope(m) {
  scopeMachine = m;
  const f = $('#scope-form');
  $('#scope-error').textContent = '';
  $('#scope-sub').textContent = `${m.name}${m.client ? ' · ' + m.client : ''} · ${m.id}`;
  try {
    const s = await api('GET', `/machines/${encodeURIComponent(m.id)}/ai-scope`);
    f.elements.enabled.checked = s.enabled;
    f.elements.context.value = s.context || '';
    const tcp = m.services.filter((x) => x.type === 'tcp');
    f.elements.sshService.innerHTML = '<option value="">(sin SSH)</option>' + tcp.map((x) => `<option value="${esc(x.name)}" ${s.ssh?.service === x.name ? 'selected' : ''}>${esc(x.name)} → puerto local ${x.localPort}</option>`).join('');
    f.elements.sshUser.value = s.ssh?.user || '';
    $('#scope-commands').innerHTML = s.commands.map((c) => commandRow(c)).join('');
    $('#scope-http').innerHTML = s.http.map((h) => httpRow(h, m.services)).join('');
    $('#scope-modal').classList.remove('hidden');
    api('GET', '/ai/ssh-key').then((k) => { $('#hub-pubkey').textContent = k.publicKey || '(no disponible)'; })
      .catch((e) => { $('#hub-pubkey').textContent = e.message; });
  } catch (err) { toast(err.message, true); }
}

$('#add-command').addEventListener('click', () => $('#scope-commands').insertAdjacentHTML('beforeend', commandRow()));
$('#add-http').addEventListener('click', () => $('#scope-http').insertAdjacentHTML('beforeend', httpRow({}, scopeMachine?.services || [])));
$('#copy-pubkey').addEventListener('click', () => copy($('#hub-pubkey').textContent));
$('#scope-form').addEventListener('click', (e) => { if (e.target.closest('[data-remove-item]')) e.target.closest('.scope-item').remove(); });

function readItems(container) {
  return $$('.scope-item', container).map((row) => {
    const o = {};
    for (const el of $$('[data-k]', row)) o[el.dataset.k] = el.value.trim();
    return o;
  });
}

$('#scope-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  $('#scope-error').textContent = '';
  try {
    const http = readItems($('#scope-http')).map((h) => {
      const headers = {};
      for (const line of (h.headers || '').split('\n').map((l) => l.trim()).filter(Boolean)) {
        const i = line.indexOf(':');
        if (i < 1) throw new Error(`cabecera inválida en "${h.id || 'consulta'}": use "Nombre: valor"`);
        headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      }
      return { ...h, headers };
    });
    const body = {
      enabled: f.elements.enabled.checked,
      context: f.elements.context.value,
      ssh: f.elements.sshService.value ? { service: f.elements.sshService.value, user: f.elements.sshUser.value.trim() } : null,
      commands: readItems($('#scope-commands')),
      http,
    };
    const s = await api('PUT', `/machines/${encodeURIComponent(scopeMachine.id)}/ai-scope`, body);
    const forced = http.filter((h, i) => h.mode === 'read' && s.http[i]?.mode === 'action').length;
    $('#scope-modal').classList.add('hidden');
    toast(forced ? `Alcance guardado (${forced} consulta(s) no GET quedaron como acción)` : 'Alcance guardado');
    refresh();
  } catch (err) { $('#scope-error').textContent = err.message; }
});
