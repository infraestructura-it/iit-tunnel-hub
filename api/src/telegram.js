'use strict';
// Bot de Telegram: el mismo bot y chat configurados en Alertas. Solo responde a ese chat.
// Long polling (solo conexiones salientes): funciona detrás de NAT, sin webhook ni puertos abiertos.
//
//  /estado      resumen de máquinas (sin IA)
//  /pendientes  acciones de IA esperando aprobación, con botones
//  /nuevo       empieza una conversación nueva con la IA
//  texto libre  pregunta a la IA

const { loadSettings } = require('./alerts');

const HELP = [
  '🤖 Asistente IIT Tunnel Hub',
  '',
  'Escriba su pregunta en lenguaje natural, por ejemplo:',
  '• ¿Qué máquinas están caídas?',
  '• ¿Cómo está la UPS de Clínica Norte?',
  '',
  '/estado — resumen de máquinas',
  '/pendientes — acciones esperando aprobación',
  '/nuevo — empezar una conversación nueva',
].join('\n');

class TelegramBot {
  constructor({ store, ai, frps, apiBase, log = console }) {
    this.store = store;
    this.ai = ai;
    this.frps = frps;
    this.apiBase = apiBase.replace(/\/$/, '');
    this.log = log;
    this.offset = 0;
    this.stopped = false;
    this.warnedChats = new Set();

    // Acciones propuestas desde Telegram: se envían con botones al chat
    ai.on('actionCreated', (action, conv) => {
      if (conv.channel !== 'telegram') return;
      const chatId = conv.id.replace(/^tg:/, '');
      this.#sendAction(chatId, action).catch((e) => this.log.error('telegram:', e.message));
    });
  }

  #conf() {
    const a = loadSettings(this.store).telegram;
    const ai = this.ai.settings();
    return { token: a.botToken, chatId: String(a.chatId || ''), enabled: !!(a.botToken && a.chatId && ai.telegramBot) };
  }

  async #api(method, body, timeoutMs = 15000) {
    const { token } = this.#conf();
    const res = await fetch(`${this.apiBase}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) throw new Error(`${method}: ${data.description || `HTTP ${res.status}`}`);
    return data.result;
  }

  async send(chatId, text, extra = {}) {
    const chunks = [];
    for (let t = String(text); t.length; t = t.slice(3900)) chunks.push(t.slice(0, 3900));
    let last;
    for (const [i, c] of chunks.entries()) {
      last = await this.#api('sendMessage', { chat_id: chatId, text: c, disable_web_page_preview: true, ...(i === chunks.length - 1 ? extra : {}) });
    }
    return last;
  }

  async #sendAction(chatId, a) {
    await this.send(chatId, `⚠️ Acción #${a.id} pendiente de aprobación\n${a.summary}${a.reason ? `\nMotivo: ${a.reason}` : ''}`, {
      reply_markup: { inline_keyboard: [[{ text: '✅ Aprobar', callback_data: `ap:${a.id}` }, { text: '❌ Rechazar', callback_data: `re:${a.id}` }]] },
    });
  }

  start() {
    const loop = async () => {
      while (!this.stopped) {
        const c = this.#conf();
        if (!c.enabled) { await sleep(5000); continue; }
        try {
          const updates = await this.#api('getUpdates', { offset: this.offset, timeout: 25, allowed_updates: ['message', 'callback_query'] }, 35000);
          for (const u of updates) {
            this.offset = u.update_id + 1;
            await this.#handle(u, c).catch((e) => this.log.error('telegram:', e.message));
          }
        } catch (e) {
          this.log.error('telegram:', e.message);
          await sleep(5000);
        }
      }
    };
    loop();
  }

  stop() { this.stopped = true; }

  async #handle(u, conf) {
    const msg = u.message || u.callback_query?.message;
    const chatId = String(msg?.chat?.id ?? '');
    if (!chatId) return;
    if (chatId !== conf.chatId) {
      if (!this.warnedChats.has(chatId)) {
        this.warnedChats.add(chatId);
        this.store.event(null, 'telegram_no_autorizado', `chat ${chatId}`, 3600);
      }
      return;
    }

    if (u.callback_query) {
      const [op, id] = String(u.callback_query.data || '').split(':');
      await this.#api('answerCallbackQuery', { callback_query_id: u.callback_query.id }).catch(() => {});
      // quitar los botones del mensaje original
      await this.#api('editMessageReplyMarkup', { chat_id: chatId, message_id: msg.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
      try {
        if (op === 'ap') {
          await this.send(chatId, `⏳ Ejecutando acción #${id}…`);
          const r = await this.ai.approve(Number(id), 'telegram');
          await this.send(chatId, `${r.action.status === 'ejecutada' ? '✅' : '❌'} Acción #${id} ${r.action.status}.${r.reply ? `\n\n${r.reply}` : ''}`);
        } else if (op === 're') {
          await this.ai.reject(Number(id), 'telegram');
          await this.send(chatId, `🚫 Acción #${id} rechazada.`);
        }
      } catch (e) {
        await this.send(chatId, `No se pudo: ${e.message}`);
      }
      return;
    }

    const text = String(u.message.text || '').trim();
    if (!text) return;
    const cmd = text.split(/\s|@/)[0].toLowerCase();
    if (cmd === '/start' || cmd === '/ayuda' || cmd === '/help') return this.send(chatId, HELP);
    if (cmd === '/estado') return this.send(chatId, await this.#summary());
    if (cmd === '/nuevo') { this.ai.reset(`tg:${chatId}`); return this.send(chatId, '🆕 Conversación nueva.'); }
    if (cmd === '/pendientes') {
      const p = this.ai.pending();
      if (!p.length) return this.send(chatId, 'No hay acciones pendientes.');
      for (const a of p.slice(0, 10)) await this.#sendAction(chatId, a);
      return;
    }

    await this.#api('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
    try {
      const r = await this.ai.chat(`tg:${chatId}`, { channel: 'telegram' }, text);
      await this.send(chatId, r.reply);
    } catch (e) {
      await this.send(chatId, `⚠️ ${e.message}`);
    }
  }

  async #summary() {
    const status = await this.frps.status();
    if (!status.reachable) return '⚠️ El servidor frps no responde.';
    const ms = this.store.listMachines();
    if (!ms.length) return 'No hay máquinas registradas.';
    const lines = ms.map((m) => {
      const icon = !m.enabled ? '⏸' : status.clients.has(m.id) ? '🟢' : '🔴';
      return `${icon} ${m.name}${m.client ? ` · ${m.client}` : ''}`;
    });
    const on = ms.filter((m) => status.clients.has(m.id)).length;
    return `${on}/${ms.length} en línea\n\n${lines.join('\n')}`;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { TelegramBot };
