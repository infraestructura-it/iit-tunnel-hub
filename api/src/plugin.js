'use strict';
// Server plugin de frps: frps consulta este endpoint antes de aceptar logins, proxies y conexiones.
// Documentación: https://gofrp.org/en/docs/features/common/server-plugin/

const { tokenMatches } = require('./machines');

const allow = () => ({ reject: false, unchange: true });
const deny = (reason) => ({ reject: true, reject_reason: reason });

function createPluginHandler(store, frpsStatus) {
  function login(c) {
    const id = c.user;
    const from = c.client_address || '?';
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
    store.recordLogin(id, c);
    store.event(id, 'conectada', `${c.hostname || '?'} · ${c.os || '?'}/${c.arch || '?'} · frpc ${c.version || '?'} · ${from}`, 0);
    frpsStatus.invalidate();
    return allow();
  }

  function newProxy(c) {
    const id = c.user?.user;
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

    if (!s) return reject(`el servicio "${svcName}" no está registrado para esta máquina`);
    if (c.proxy_type !== s.type) return reject(`tipo "${c.proxy_type}" no coincide con el registrado (${s.type})`);
    if (Array.isArray(c.custom_domains) && c.custom_domains.length) return reject('customDomains no está permitido; use el subdominio asignado');
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
  function ping(c) {
    return authorized(c) ? allow() : deny('máquina deshabilitada o eliminada');
  }

  const ops = { Login: login, NewProxy: newProxy, CloseProxy: closeProxy, NewUserConn: newUserConn, NewWorkConn: newWorkConn, Ping: ping };

  return function handle(op, body) {
    const fn = ops[op];
    if (!fn) return allow();
    return fn(body?.content || {});
  };
}

module.exports = { createPluginHandler };
