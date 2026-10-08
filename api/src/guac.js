'use strict';
// Protocolo de Guacamole (lado servidor) para el escritorio remoto en el navegador.
//
//   navegador (guacamole-common-js) ──WebSocket "guacamole"──▶ hub ──TCP──▶ guacd ──RDP──▶ 127.0.0.1:<visitante> ──▶ Windows
//
// Una instrucción es "LARGO.VALOR,LARGO.VALOR,…;" con LARGO en puntos de código Unicode.
// El hub hace el saludo con guacd (select → args → size/audio/video/image/timezone → connect → ready)
// con los parámetros RDP que fija el hub (destino, credenciales), y desde ahí solo reenvía instrucciones completas.

const net = require('node:net');
const { StringDecoder } = require('node:string_decoder');

/** Códigos de estado de Guacamole que usa el hub. */
const STATUS = { SERVER_ERROR: 512, UPSTREAM_TIMEOUT: 514, UPSTREAM_ERROR: 515, UPSTREAM_NOT_FOUND: 519, UPSTREAM_UNAVAILABLE: 520, CLIENT_BAD_REQUEST: 768, CLIENT_UNAUTHORIZED: 769 };

const elem = (v) => { const s = String(v ?? ''); return `${[...s].length}.${s}`; };
/** Arma una instrucción: encode('size', 1024, 768, 96) → "4.size,4.1024,3.768,2.96;" */
const encode = (opcode, ...args) => [opcode, ...args].map(elem).join(',') + ';';

/**
 * Separa un flujo de texto en instrucciones completas. Devuelve { done: [texto, …], parsed: [[opcode, …args], …] }
 * y guarda el resto incompleto para la siguiente llamada.
 */
class GuacParser {
  constructor({ maxBuffer = 8 * 1024 * 1024 } = {}) { this.buf = ''; this.maxBuffer = maxBuffer; }

  push(text, { parse = false } = {}) {
    this.buf += text;
    const done = []; const parsed = [];
    let start = 0;
    const b = this.buf;
    outer: for (;;) {
      let i = start; const els = [];
      for (;;) {
        const dot = b.indexOf('.', i);
        if (dot === -1) break outer;
        const lenStr = b.slice(i, dot);
        if (!/^\d{1,9}$/.test(lenStr)) throw new Error('instrucción de Guacamole mal formada');
        // LARGO cuenta puntos de código: cada par sustituto ocupa 2 unidades UTF-16
        let end = dot + 1; let need = Number(lenStr);
        while (need > 0) {
          const to = end + need;
          if (to > b.length) break outer;
          let extra = 0;
          for (let k = end; k < to; k++) { const c = b.charCodeAt(k); if (c >= 0xd800 && c <= 0xdbff) extra++; }
          end = to; need = extra;
        }
        if (end >= b.length) break outer; // falta el terminador
        if (parse) els.push(b.slice(dot + 1, end));
        const term = b[end];
        if (term === ';') { done.push(b.slice(start, end + 1)); if (parse) parsed.push(els); start = end + 1; break; }
        if (term !== ',') throw new Error('instrucción de Guacamole mal formada');
        i = end + 1;
      }
    }
    this.buf = b.slice(start);
    if (this.buf.length > this.maxBuffer) throw new Error('instrucción de Guacamole demasiado grande');
    return { done, parsed };
  }
}

/** Distribuciones de teclado de guacd que se ofrecen en el panel (la del equipo Windows). */
const LAYOUTS = ['es-latam-qwerty', 'es-es-qwerty', 'en-us-qwerty', 'pt-br-qwerty', 'fr-fr-azerty', 'de-de-qwertz', 'it-it-qwerty', 'failsafe'];

/** Valores de los parámetros RDP de guacd (los que no aparecen quedan vacíos = valor por defecto de guacd). */
function rdpParams({ host, port, username = '', password = '', domain = '', layout = 'es-latam-qwerty', timezone = '' }) {
  return {
    hostname: host,
    port: String(port),
    username, password, domain,
    // El túnel frp ya autentica a la máquina; el certificado RDP suele ser autofirmado
    security: 'any',
    'ignore-cert': 'true',
    'server-layout': LAYOUTS.includes(layout) ? layout : 'es-latam-qwerty',
    timezone,
    'resize-method': 'display-update',
    'enable-wallpaper': 'false',
    'enable-theming': 'true',
    'enable-font-smoothing': 'true',
    'enable-full-window-drag': 'false',
    'enable-desktop-composition': 'false',
    'enable-menu-animations': 'false',
    'disable-audio': 'false',
    'normalize-clipboard': 'windows',
    // Sin unidades, impresión, SFTP ni grabación: nada del equipo sale por el hub salvo pantalla, audio y portapapeles
    'enable-drive': 'false',
    'enable-printing': 'false',
    'enable-sftp': 'false',
  };
}

/**
 * Abre una conexión con guacd y hace el saludo. Resuelve { sock, decoder, parser, id, rest } con la conexión lista
 * para reenviar (rest = instrucciones que guacd ya mandó después de "ready").
 */
function guacdConnect({ host, port, params, size, audio = [], image = ['image/png', 'image/jpeg', 'image/webp'], timezone = '', timeoutMs = 15000 }) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    const decoder = new StringDecoder('utf8');
    const parser = new GuacParser();
    let stage = 'args';
    const timer = setTimeout(() => fail(Object.assign(new Error(stage === 'args' ? 'guacd no respondió' : 'el equipo no respondió a tiempo'), { status: STATUS.UPSTREAM_TIMEOUT })), timeoutMs);
    const fail = (e) => { clearTimeout(timer); sock.destroy(); reject(e); };
    sock.setNoDelay(true);
    sock.on('connect', () => sock.write(encode('select', 'rdp')));
    sock.on('error', (e) => fail(Object.assign(new Error(e.code === 'ECONNREFUSED' ? `guacd no está corriendo en ${host}:${port}` : `guacd: ${e.message}`), { status: STATUS.UPSTREAM_UNAVAILABLE, guacd: true })));
    sock.on('close', () => fail(Object.assign(new Error('guacd cerró la conexión durante el saludo'), { status: STATUS.UPSTREAM_ERROR })));
    sock.on('data', function onData(chunk) {
      let r;
      try { r = parser.push(decoder.write(chunk), { parse: true }); } catch (e) { return fail(e); }
      for (let n = 0; n < r.parsed.length; n++) {
        const [op, ...args] = r.parsed[n];
        if (op === 'error') return fail(Object.assign(new Error(args[0] || 'error de guacd'), { status: Number(args[1]) || STATUS.SERVER_ERROR }));
        if (stage === 'args' && op === 'args') {
          // El primer argumento puede ser la versión del protocolo (VERSION_1_x_0): se responde la misma
          const values = args.map((name) => (/^VERSION_/.test(name) ? name : params[name] ?? ''));
          sock.write(encode('size', size.width, size.height, size.dpi));
          sock.write(encode('audio', ...audio));
          sock.write(encode('video'));
          sock.write(encode('image', ...image));
          if (timezone && args.some((a) => /^VERSION_1_[1-9]/.test(a))) sock.write(encode('timezone', timezone));
          sock.write(encode('connect', ...values));
          stage = 'ready';
        } else if (stage === 'ready' && op === 'ready') {
          clearTimeout(timer);
          sock.removeAllListeners('data'); sock.removeAllListeners('close'); sock.removeAllListeners('error');
          sock.on('error', () => {});
          return resolve({ sock, decoder, parser, id: args[0] || '', rest: r.done.slice(n + 1).join('') });
        }
      }
    });
  });
}

module.exports = { GuacParser, encode, guacdConnect, rdpParams, LAYOUTS, STATUS };
