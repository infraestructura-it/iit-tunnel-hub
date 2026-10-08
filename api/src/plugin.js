'use strict';
// Server plugin de frps: frps consulta este endpoint antes de aceptar logins, proxies y conexiones.
// Documentación: https://gofrp.org/en/docs/features/common/server-plugin/

const { tokenMatches } = require('./machines');

const allow = () => ({ reject: false, unchange: true });
const deny = (reason) => ({ reject: true, reject_reason: reason });

// Usuario imposible (los ids no admiten "!"): con allowUsers vacío frps dejaría entrar al propio dueño
const NOBODY = '!nadie';
const { browserKind } = require('./remote');

const HUB_USER = '_hub'; // frpc interno del hub (ver hubfrpc.js); los ids de máquina no admiten "_"

function createPluginHandler(store, frpsStatus, { hub = null } = {}) {
  // Máquinas a las que se les pidió reconectarse para aplicar cambios (accesos, clave stcp).
  // Se rechaza su próximo latido: frpc cierra la sesión, vuelve a entrar y frps vuelve a preguntar NewProxy.
  const reloadPending = new Set();

  function login(c) {
    const id = c.user;
    const from = c.client_address || '?';
    if (id === HUB_USER) {
      // Solo el frpc que lanzó este hub, desde el propio servidor
      if (hub && hub.tokenMatches(c.metas?.token)) { hub.lastLoginAt = Math.floor(Date.now() / 1000); return allow(); }
      store.event(null, 'login_rechazado', `usuario interno del hub con token inválido desde ${from}`);
      return deny('token inválido');
    }
    if (!id) {
      store.event(null, 'login_rechazado', `sin usuario desde ${from}`);
      return deny('frpc debe definir "user" con el id de la máquina');
    }
    const m = store.getMachine(id);
    if (!m) {
      store.event(null, 'login_rechazado', `máquina desconocida "${id}" desde ${from}`);
      return deny('máquina no registrada');
    }
    if (!m.enabled) {
      store.event(id, 'login_rechazado', `máquina deshabilitada, intento desde ${from}`);
      return deny('máquina deshabilitada');
    }
    if (!tokenMatches(c.metas?.token, m.token_hash)) {
      store.event(id, 'login_rechazado', `token inválido desde ${from}`);
      return deny('token inválido');
    }
    reloadPending.delete(id); // sesión nueva: ya registrará sus servicios con la configuración vigente
    store.recordLogin(id, c);
    store.event(id, 'conectada', `${c.hostname || '?'} · ${c.os || '?'}/${c.arch || '?'} · frpc ${c.version || '?'} · ${from}`, 0);
    frpsStatus.invalidate();
    return allow();
  }

  function newProxy(c) {
    const id = c.user?.user;
    if (id === HUB_USER) return deny('el frpc del hub solo visita servicios, no publica');
    const m = id ? store.getMachine(id) : null;
    if (!m || !m.enabled) return deny('máquina no autorizada');

    // frps antepone el usuario: "maquina.servicio"
    const full = c.proxy_name || '';
    const svcName = full.startsWith(id + '.') ? full.slice(id.length + 1) : full;
    const s = store.getService(id, svcName);
    const reject = (why) => {
      store.event(id, 'servicio_rechazado', `${svcName}: ${why}`);
      return deny(why);
    };

    // Equipo SNMP de la red local de la sede: sudp "snmp-<id>" que solo puede visitar el frpc del hub
    const snmp = /^snmp-(\d+)-r(\d+)$/.exec(svcName);
    if (snmp) {
      const d = store.getSnmp(Number(snmp[1]));
      if (!d || d.machine_id !== id) return reject(`el equipo SNMP "${svcName}" no está registrado para esta máquina`);
      if (Number(snmp[2]) !== d.rev) return reject(`${svcName} es una configuración anterior del equipo SNMP "${d.name}": aplique el archivo de accesos nuevo`);
      if (c.proxy_type !== 'sudp') return reject(`${svcName} debe ser de tipo sudp`);
      if (!d.enabled) return reject(`el equipo SNMP "${d.name}" está deshabilitado`);
      store.event(id, 'servicio_activo', `${svcName} (SNMP ${d.name} → ${d.host}:${d.port})`, 0);
      frpsStatus.invalidate();
      return { reject: false, unchange: false, content: { ...c, sk: d.secret, allow_users: [HUB_USER] } };
    }

    if (!s) return reject(`el servicio "${svcName}" no está registrado para esta máquina`);
    if (c.proxy_type !== s.type) return reject(`tipo "${c.proxy_type}" no coincide con el registrado (${s.type})`);
    if (Array.isArray(c.custom_domains) && c.custom_domains.length) return reject('customDomains no está permitido; use el subdominio asignado');
    if (s.type === 'stcp') {
      // Servicio privado: el hub fija la clave y quiénes pueden visitarlo; lo que traiga frpc se descarta
      const visitors = store.accessForService(s.id).map((a) => a.visitor_id);
      store.event(id, 'servicio_activo', `${svcName} (privado · ${visitors.length} acceso${visitors.length === 1 ? '' : 's'})`, 0);
      frpsStatus.invalidate();
      // El hub entra como visitante a los SSH/VNC para las sesiones desde el navegador (remote.js)
      const allow = browserKind(s) ? [...visitors, HUB_USER] : visitors;
      return { reject: false, unchange: false, content: { ...c, sk: s.secret, allow_users: allow.length ? allow : [NOBODY] } };
    }
    if (s.type === 'tcp') {
      if (Number(c.remote_port) !== s.remote_port) return reject(`remotePort debe ser ${s.remote_port}`);
    } else if ((c.subdomain || '') !== s.subdomain) {
      return reject(`subdomain debe ser "${s.subdomain}"`);
    }

    store.event(id, 'servicio_activo', svcName, 0);
    frpsStatus.invalidate();
    return allow();
  }

  function closeProxy(c) {
    const id = c.user?.user;
    if (id && store.getMachine(id)) {
      const full = c.proxy_name || '';
      store.event(id, 'servicio_cerrado', full.startsWith(id + '.') ? full.slice(id.length + 1) : full, 0);
    }
    frpsStatus.invalidate();
    return allow();
  }

  const authorized = (c) => {
    const id = c.user?.user;
    if (id === HUB_USER) return { id: HUB_USER, enabled: 1 };
    const m = id ? store.getMachine(id) : null;
    return m && m.enabled ? m : null;
  };

  // Cada conexión entrante de un visitante (tcp, https). Deshabilitar corta el tráfico al instante.
  function newUserConn(c) {
    if (authorized(c)) return allow();
    const id = c.user?.user;
    if (id && store.getMachine(id)) store.event(id, 'conexion_rechazada', `máquina deshabilitada · ${c.remote_addr || '?'}`);
    return deny('máquina deshabilitada o eliminada');
  }

  // Cada conexión de trabajo que abre frpc. Cubre el tipo http, que no pasa por NewUserConn.
  function newWorkConn(c) {
    return authorized(c) ? allow() : deny('máquina deshabilitada o eliminada');
  }

  // Latido de frpc: si la máquina fue deshabilitada o eliminada, se rechaza y frpc cierra la sesión.
  // También se rechaza una vez cuando el hub pidió reconexión: frpc vuelve a entrar solo en segundos.
  function ping(c) {
    const m = authorized(c);
    if (!m) return deny('máquina deshabilitada o eliminada');
    if (m.id !== HUB_USER && reloadPending.delete(m.id)) {
      store.event(m.id, 'reconexion', 'el hub pidió reconectar para aplicar cambios de acceso', 0);
      return deny('el hub pidió reconectar para aplicar cambios de acceso');
    }
    return allow();
  }

  const ops = { Login: login, NewProxy: newProxy, CloseProxy: closeProxy, NewUserConn: newUserConn, NewWorkConn: newWorkConn, Ping: ping };

  function handle(op, body) {
    const fn = ops[op];
    if (!fn) return allow();
    return fn(body?.content || {});
  }
  /** Pide a una máquina que se reconecte en su próximo latido (máx. ~15 s). */
  handle.requestReload = (machineId) => { if (machineId) reloadPending.add(machineId); };
  handle.reloadPending = reloadPending;
  return handle;
}

module.exports = { createPluginHandler, HUB_USER };
