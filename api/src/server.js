'use strict';
// IIT Tunnel Hub — API de registro y monitoreo de máquinas conectadas por frp.
// Dos servidores HTTP:
//   1. Panel + API de administración (PORT, protegido con ADMIN_TOKEN)
//   2. Server plugin para frps (PLUGIN_PORT, solo red interna)

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { config, validate } = require('./config');
const { open } = require('./db');
const { FrpsClient } = require('./frps');
const { createPluginHandler } = require('./plugin');
const M = require('./machines');
const { PLATFORMS, ACCESS_PLATFORMS, howToConnect } = require('./installers');
const A = require('./alerts');
const { AIService, AIError, viewMessages } = require('./ai');
const SC = require('./ai-scope');
const { TelegramBot } = require('./telegram');
const AU = require('./auth');
const { BackupService } = require('./backup');
const ST = require('./status');
const { HubFrpc } = require('./hubfrpc');
const { SnmpMonitor } = require('./snmp-monitor');
const SD = require('./snmp-devices');
const { PROFILES: SNMP_PROFILES } = require('./snmp-profiles');
const { requestContext } = require('./context');
const E = require('./enroll');
const WS = require('./ws');
const { RemoteService, browserKind, KINDS: REMOTE_KINDS } = require('./remote');

const VERSION = '1.1.0';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// ---------- utilidades HTTP ----------

// Contadores desde el arranque, para la página de estado
const stats = {
  startedAt: Date.now(),
  plugin: { calls: 0, rejects: 0, errors: 0, byOp: {}, lastAt: null },
  api: { requests: 0, errors: 0, lastError: null },
};

function send(res, status, data, headers = {}) {
  const isBin = Buffer.isBuffer(data);
  const isText = typeof data === 'string';
  const body = isText || isBin ? data : JSON.stringify(data);
  res.writeHead(status, {
    'content-type': isBin ? 'application/octet-stream' : isText ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new M.HttpError(413, 'cuerpo demasiado grande')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error();
        resolve(v);
      } catch { reject(M.bad('JSON inválido')); }
    });
    req.on('error', reject);
  });
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function isAdmin(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  return token.length > 0 && safeEqual(token, config.adminToken);
}

// ---------- estáticos del panel ----------

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 404, { error: 'no encontrado' });
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: 'no encontrado' });
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    });
    res.end(data);
  });
}

// ---------- vistas ----------

// Índice de accesos a servicios privados: por servicio (quién entra) y por visitante (a qué entra)
function accessIndex(list) {
  const byService = new Map();
  const byVisitor = new Map();
  for (const a of list) {
    if (!byService.has(a.service_id)) byService.set(a.service_id, []);
    byService.get(a.service_id).push(a);
    if (!byVisitor.has(a.visitor_id)) byVisitor.set(a.visitor_id, []);
    byVisitor.get(a.visitor_id).push(a);
  }
  return { byService, byVisitor };
}
const NO_ACCESS = { byService: new Map(), byVisitor: new Map() };

function accessView(a, status) {
  const h = howToConnect(a);
  return {
    id: a.id,
    machine: a.owner_id,
    service: a.service,
    visitor: a.visitor_id,
    bindPort: a.bind_port,
    remotePort: a.local_port,
    kind: h.kind,
    connect: h.cmd,
    serviceOnline: status.proxies.get(`${a.owner_id}.${a.service}`)?.status === 'online',
    visitorOnline: status.clients.has(a.visitor_id),
    createdAt: a.created_at,
  };
}

function serviceView(s, machineId, status, access = NO_ACCESS) {
  const proxy = status.proxies.get(`${machineId}.${s.name}`);
  return {
    name: s.name,
    type: s.type,
    localIp: s.local_ip,
    localPort: s.local_port,
    subdomain: s.subdomain,
    remotePort: s.remote_port,
    tlsMode: s.tls_mode,
    publicUrl: M.publicUrl(s, config.frps),
    private: s.type === 'stcp',
    remote: browserKind(s),
    access: s.type === 'stcp' ? (access.byService.get(s.id) || []).map((a) => accessView(a, status)) : undefined,
    status: proxy ? proxy.status : 'sin_registro',
    connections: proxy?.curConns ?? 0,
    trafficInToday: proxy?.todayTrafficIn ?? 0,
    trafficOutToday: proxy?.todayTrafficOut ?? 0,
  };
}

/** Vista para el rol cliente: estado y servicios, sin datos internos de IIT (IA, accesos privados). */
function clientMachineView(v) {
  return {
    id: v.id, name: v.name, client: v.client, description: v.description, enabled: v.enabled, online: v.online,
    stateSince: v.stateSince, connection: v.connection, lastLogin: v.lastLogin, createdAt: v.createdAt,
    services: v.services.map((s) => ({
      name: s.name, type: s.type, private: s.private, publicUrl: s.publicUrl, localPort: s.localPort, status: s.status,
      trafficInToday: s.trafficInToday, trafficOutToday: s.trafficOutToday,
    })),
    visits: [],
  };
}

function machineView(m, services, status, access = NO_ACCESS) {
  const live = status.clients.get(m.id);
  return {
    id: m.id,
    name: m.name,
    client: m.client,
    clientId: m.client_id ?? null,
    description: m.description,
    enabled: !!m.enabled,
    alerts: !!m.alerts,
    ai: (() => { try { return !!JSON.parse(m.ai_scope || '{}').enabled; } catch { return false; } })(),
    online: !!live,
    stateSince: m.state_since || null,
    connection: live ? {
      clientIp: live.clientIP,
      hostname: live.hostname,
      version: live.version,
      connectedSince: live.lastConnectedAt || live.firstConnectedAt || null,
    } : null,
    lastLogin: m.last_login_at ? {
      at: m.last_login_at,
      address: m.last_client_address,
      hostname: m.last_hostname,
      os: m.last_os,
      arch: m.last_arch,
      version: m.last_version,
    } : null,
    createdAt: m.created_at,
    updatedAt: m.updated_at,
    services: services.map((s) => serviceView(s, m.id, status, access)),
    visits: (access.byVisitor.get(m.id) || []).map((a) => accessView(a, status)),
  };
}

// ---------- permisos ----------

/** Alcance de un usuario: admin ve todo; técnico, sus clientes asignados; cliente, el suyo. */
function accessFor(store, u, via) {
  const clientIds = u.role === 'admin' ? null
    : new Set(u.role === 'tecnico' ? store.userClientIds(u.id) : (u.client_id ? [u.client_id] : []));
  return new AU.Access({ user: u, role: u.role, clientIds, via });
}

// ---------- rutas de la API ----------

function createApi(store, frps, monitor, ai, plugin, extra = {}) {
  const { backups, bot = {}, pluginListening = () => true, snmp = null, hub = null, remote = null } = extra;
  const routes = [];
  /**
   * perm: 'public' (sin sesión) · 'session' (cualquier usuario, incluso con cambio de contraseña pendiente)
   *       'any' (cualquier rol) · 'staff' (admin y técnico, por defecto) · 'admin'
   */
  const route = (method, pattern, handler, perm = 'staff') => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handler, perm });
  };

  /** Máquina visible para quien pregunta (404 si no la ve) y, si write, que pueda operarla (403). */
  const mustMachine = (id, ctx, { write = true } = {}) => {
    const m = store.getMachine(id);
    if (!m || !ctx.canSee(m)) throw new M.HttpError(404, `no existe la máquina "${id}"`);
    if (write && !ctx.canWrite(m)) throw new M.HttpError(403, 'su usuario solo puede consultar esta máquina');
    return m;
  };
  const visibleMachines = (ctx) => store.listMachines().filter((m) => ctx.canSee(m));
  const visibleIds = (ctx) => new Set(visibleMachines(ctx).map((m) => m.id));

  const access = () => accessIndex(store.listAccess());
  const shape = (ctx, v) => (ctx.role === 'cliente' ? clientMachineView(v) : v);
  const view = async (m, ctx) => shape(ctx, machineView(m, store.servicesOf(m.id), await frps.status(), access()));

  /** Resuelve el cliente de una máquina: por clientId o por nombre. El admin crea clientes nuevos al vuelo. */
  const resolveClient = (body, ctx) => {
    if (body.clientId !== undefined && body.clientId !== null && body.clientId !== '') {
      const c = store.getClient(String(body.clientId));
      if (!c || !ctx.canUseClient(c.id)) throw new M.HttpError(404, `no existe el cliente "${body.clientId}"`);
      return c;
    }
    const name = String(body.client ?? '').trim().slice(0, 80);
    if (!name) {
      if (!ctx.isAdmin) throw M.bad('elija el cliente de la máquina');
      return null;
    }
    const c = store.clientByName(name);
    if (c) {
      if (!ctx.canUseClient(c.id)) throw new M.HttpError(403, `no tiene asignado el cliente "${name}"`);
      return c;
    }
    if (!ctx.isAdmin) throw new M.HttpError(403, `el cliente "${name}" no existe o no lo tiene asignado`);
    const nc = store.createClient(name);
    store.event(null, 'cliente_creado', nc.name, 0);
    return nc;
  };
  // Las máquinas dueñas de servicios privados se reconectan para que frps tome la clave y los visitantes nuevos
  const reload = (ids) => { for (const id of new Set(ids)) plugin?.requestReload(id); };

  // Público, para monitores externos (Uptime Kuma, etc.): 503 si la base no escribe o frps no responde
  route('GET', '/api/health', async () => {
    const h = await ST.health({ store, frps, backups, version: VERSION });
    return [h.code, h.body];
  }, 'public');

  // ---------- estado del hub y respaldos (administrador) ----------

  route('GET', '/api/status', async () => [200, await ST.gather({
    config, store, frps, monitor, bot, ai, backups, stats, version: VERSION, pluginListening, hub, snmp,
  })], 'admin');

  route('GET', '/api/backups', async () => [200, {
    settings: backups.settings(), state: backups.state(), encrypted: !!config.backupKey,
    dir: path.resolve(config.backupDir), nextAt: backups.nextAt() ? Math.floor(backups.nextAt() / 1000) : null, list: backups.list(),
  }], 'admin');
  route('PUT', '/api/backups/settings', async (req) => {
    const s = backups.updateSettings(await readJson(req), M.bad);
    store.event(null, 'respaldos_configurados', `${s.enabled ? `diario a las ${String(s.hour).padStart(2, '0')}:00` : 'apagados'} · conservar ${s.keep}`, 0);
    return [200, s];
  }, 'admin');
  route('POST', '/api/backups', async () => {
    const r = await backups.run('manual');
    if (!r.ok) throw new M.HttpError(500, `el respaldo falló: ${r.error}`);
    return [201, r];
  }, 'admin');
  route('GET', '/api/backups/:name', async (_req, p) => {
    const f = backups.file(p.name);
    if (!f) throw new M.HttpError(404, 'no existe ese respaldo');
    store.event(null, 'respaldo_descargado', p.name, 0);
    return [200, fs.readFileSync(f), { 'content-disposition': `attachment; filename="${p.name}"` }];
  }, 'admin');
  route('DELETE', '/api/backups/:name', async (_req, p) => {
    if (!backups.remove(p.name)) throw new M.HttpError(404, 'no existe ese respaldo');
    store.event(null, 'respaldo_eliminado', p.name, 0);
    return [200, { deleted: p.name }];
  }, 'admin');

  route('GET', '/api/summary', async (_req, _p, ctx) => {
    const status = await frps.status();
    const machines = visibleMachines(ctx);
    const ids = new Set(machines.map((m) => m.id));
    const services = store.listServices().filter((s) => ids.has(s.machine_id));
    const base = {
      machines: machines.length,
      enabled: machines.filter((m) => m.enabled).length,
      online: machines.filter((m) => status.clients.has(m.id)).length,
      services: services.length,
    };
    if (ctx.role === 'cliente') {
      return [200, { ...base, frps: { reachable: status.reachable, version: status.server?.version ?? null, subdomainHost: config.frps.subdomainHost } }];
    }
    return [200, {
      ...base,
      ai: (() => { const a = ai.settings(); return { enabled: a.enabled, ready: ai.ready(), pending: ai.pending().filter((x) => ids.has(x.machine_id)).length }; })(),
      alerts: (() => { const a = A.loadSettings(store); return { telegram: !!(a.telegram.botToken && a.telegram.chatId), webhooks: a.webhooks.length, graceSeconds: a.graceSeconds }; })(),
      frps: {
        reachable: status.reachable,
        error: status.error,
        version: status.server?.version ?? null,
        clientCounts: status.server?.clientCounts ?? null,
        totalTrafficIn: status.server?.totalTrafficIn ?? null,
        totalTrafficOut: status.server?.totalTrafficOut ?? null,
        publicAddr: config.frps.publicAddr,
        bindPort: config.frps.bindPort,
        subdomainHost: config.frps.subdomainHost,
        tcpPortRange: [config.frps.tcpPortMin, config.frps.tcpPortMax],
      },
    }];
  }, 'any');

  route('GET', '/api/machines', async (_req, _p, ctx) => {
    const status = await frps.status();
    const byMachine = new Map();
    for (const s of store.listServices()) {
      if (!byMachine.has(s.machine_id)) byMachine.set(s.machine_id, []);
      byMachine.get(s.machine_id).push(s);
    }
    const idx = access();
    return [200, visibleMachines(ctx).map((m) => shape(ctx, machineView(m, byMachine.get(m.id) || [], status, idx)))];
  }, 'any');

  route('POST', '/api/machines', async (req, _p, ctx) => {
    const body = await readJson(req);
    const token = M.newToken();
    const created = store.transaction(() => {
      const client = resolveClient(body, ctx);
      const data = M.normalizeMachine({ ...body, client: client ? client.name : '' }, store);
      store.createMachine({ ...data, clientId: client ? client.id : null, tokenHash: M.hashToken(token) });
      for (const s of Array.isArray(body.services) ? body.services : []) {
        store.createService(data.id, M.normalizeService(s, data.id, store, config.frps));
      }
      return data.id;
    });
    const m = store.getMachine(created);
    const services = store.servicesOf(created);
    store.event(created, 'registrada', m.name, 0);
    if (services.some(browserKind)) hub?.sync();
    return [201, {
      machine: machineView(m, services, await frps.status(), access()),
      token,
      frpcToml: M.frpcToml(m, services, config.frps, token),
      note: 'Guarde el token: no se vuelve a mostrar. Si lo pierde, use rotate-token.',
    }];
  });

  route('GET', '/api/machines/:id', async (_req, p, ctx) => {
    return [200, await view(mustMachine(p.id, ctx, { write: false }), ctx)];
  }, 'any');

  route('PATCH', '/api/machines/:id', async (req, p, ctx) => {
    mustMachine(p.id, ctx);
    const body = await readJson(req);
    const fields = {};
    if (body.name !== undefined) {
      fields.name = String(body.name).trim().slice(0, 80);
      if (!fields.name) throw M.bad('name no puede quedar vacío');
    }
    if (body.client !== undefined || body.clientId !== undefined) {
      const c = resolveClient(body, ctx);
      fields.client = c ? c.name : '';
      fields.client_id = c ? c.id : null;
    }
    if (body.description !== undefined) fields.description = String(body.description).trim().slice(0, 500);
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') throw M.bad('enabled debe ser true o false');
      fields.enabled = body.enabled ? 1 : 0;
    }
    if (body.alerts !== undefined) {
      if (typeof body.alerts !== 'boolean') throw M.bad('alerts debe ser true o false');
      fields.alerts = body.alerts ? 1 : 0;
    }
    const m = store.updateMachine(p.id, fields);
    if (fields.enabled !== undefined) { store.event(p.id, fields.enabled ? 'habilitada' : 'deshabilitada', '', 0); hub?.sync(); }
    if (fields.alerts !== undefined) store.event(p.id, fields.alerts ? 'alertas_activadas' : 'alertas_desactivadas', '', 0);
    if (fields.client_id !== undefined) store.event(p.id, 'cliente_cambiado', fields.client || 'sin cliente', 0);
    return [200, await view(m, ctx)];
  });

  route('DELETE', '/api/machines/:id', async (_req, p, ctx) => {
    mustMachine(p.id, ctx);
    // Si era visitante de servicios privados, sus dueños se reconectan para retirarla de allowUsers
    const owners = store.accessOfVisitor(p.id).map((a) => a.owner_id);
    const hadSnmp = store.snmpOf(p.id);
    store.deleteMachine(p.id);
    reload(owners);
    if (hadSnmp.length) { for (const d of hadSnmp) snmp?.forget(d.id); } // sus equipos SNMP se borran en cascada
    hub?.sync(); // y sus visitantes del hub (SNMP y sesiones remotas)
    store.event(p.id, 'eliminada', '', 0);
    return [200, { deleted: p.id }];
  });

  route('POST', '/api/machines/:id/rotate-token', async (_req, p, ctx) => {
    const m = mustMachine(p.id, ctx);
    const token = M.newToken();
    store.setTokenHash(m.id, M.hashToken(token));
    store.event(m.id, 'token_rotado', 'el token anterior deja de funcionar en el próximo login', 0);
    return [200, { token, frpcToml: M.frpcToml(m, store.servicesOf(m.id), config.frps, token) }];
  });

  route('GET', '/api/machines/:id/frpc.toml', async (_req, p, ctx) => {
    const m = mustMachine(p.id, ctx);
    const toml = M.frpcToml(m, store.servicesOf(m.id), config.frps, null);
    return [200, toml, { 'content-type': 'application/toml; charset=utf-8', 'content-disposition': `attachment; filename="frpc-${m.id}.toml"` }];
  });

  // Instalador autocontenido. Requiere el token vigente de la máquina (el hub no lo guarda en claro).
  route('POST', '/api/machines/:id/installer', async (req, p, ctx) => {
    const m = mustMachine(p.id, ctx);
    const body = await readJson(req);
    const platform = String(body.platform || '');
    if (platform !== 'toml' && !PLATFORMS[platform]) throw M.bad('platform debe ser linux, windows o toml');
    if (!M.tokenMatches(body.token, m.token_hash)) throw new M.HttpError(403, 'el token no corresponde a esta máquina (rótelo si lo perdió)');
    const { serverAddr } = E.effectiveServerAddr(M.normalizeServerAddr(body.serverAddr, config.frps.publicAddr), E.baseUrl(req, config));
    const services = store.servicesOf(m.id);
    if (platform === 'toml') {
      return [200, M.frpcToml(m, services, config.frps, body.token, { serverAddr }), {
        'content-type': 'application/toml; charset=utf-8',
        'content-disposition': `attachment; filename="frpc-${m.id}.toml"`,
      }];
    }
    const P = PLATFORMS[platform];
    store.event(m.id, 'instalador_generado', `${platform} · servidor ${serverAddr}`, 0);
    const grants = store.accessOfVisitor(m.id);
    const snmp = store.snmpOf(m.id);
    return [200, P.build(m, services, config.frps, body.token, serverAddr, grants.length || snmp.length ? M.accessToml(m, grants, snmp) : ''), {
      'content-type': P.type,
      'content-disposition': `attachment; filename="instalar-${m.id}.${P.ext}"`,
    }];
  });

  route('POST', '/api/machines/:id/services', async (req, p, ctx) => {
    const m = mustMachine(p.id, ctx);
    const body = await readJson(req);
    const s = store.createService(m.id, M.normalizeService(body, m.id, store, config.frps));
    store.event(m.id, 'servicio_agregado', `${s.name} (${s.type === 'stcp' ? 'privado' : s.type})`, 0);
    if (browserKind(s)) hub?.sync();
    return [201, serviceView(s, m.id, await frps.status(), access())];
  });

  route('DELETE', '/api/machines/:id/services/:name', async (_req, p, ctx) => {
    mustMachine(p.id, ctx);
    const s = store.getService(p.id, p.name);
    if (!s || !store.deleteService(p.id, p.name)) throw new M.HttpError(404, `no existe el servicio "${p.name}"`);
    store.event(p.id, 'servicio_eliminado', p.name, 0);
    if (s.type === 'stcp') reload([p.id]); // frps retira el servicio privado y nadie más entra
    if (browserKind(s)) hub?.sync();
    return [200, { deleted: p.name }];
  });

  // ---------- sesiones remotas desde el navegador (VNC, SSH y RDP) ----------

  // Ticket de un solo uso (60 s) para abrir el WebSocket de la sesión: el navegador no puede mandar
  // cabeceras en un WebSocket y así tampoco depende de la cookie (sirve también con el token de API).
  route('POST', '/api/machines/:id/remote', async (req, p, ctx) => {
    const m = mustMachine(p.id, ctx);
    if (!remote) throw new M.HttpError(503, 'las sesiones remotas no están disponibles');
    const body = await readJson(req);
    const s = store.getService(m.id, String(body.service || ''));
    if (!s) throw new M.HttpError(404, `no existe el servicio "${body.service}"`);
    const kind = browserKind(s);
    if (!kind) throw M.bad(`"${s.name}" no admite sesión desde el navegador (solo servicios privados SSH, VNC o RDP)`);
    if (!m.enabled) throw new M.HttpError(409, 'la máquina está deshabilitada');
    let rdp = null;
    if (kind === 'rdp') {
      if (!(await remote.guacdReachable())) {
        const g = remote.config.guacd;
        throw new M.HttpError(503, `el escritorio remoto necesita guacd y no responde en ${g.host}:${g.port}. Inícielo junto al hub (ver README, "Escritorio remoto")`);
      }
      // Primero el navegador pregunta el tipo; las credenciales llegan en la segunda llamada y viajan con el ticket
      if (!body.credentials || typeof body.credentials !== 'object') {
        return [200, { needCredentials: true, kind, label: REMOTE_KINDS[kind], machine: { id: m.id, name: m.name }, service: s.name }];
      }
      const c = body.credentials;
      const str = (v, max) => String(v ?? '').slice(0, max);
      rdp = { username: str(c.username, 128).trim(), password: str(c.password, 256), domain: str(c.domain, 128).trim(), layout: str(c.layout, 32) };
      if (/[\x00-\x1f]/.test(rdp.username + rdp.domain)) throw M.bad('usuario o dominio no válidos');
    }
    const ticket = remote.createTicket({ machineId: m.id, service: s, actor: ctx.actor, rdp });
    return [201, { ticket, kind, label: REMOTE_KINDS[kind], machine: { id: m.id, name: m.name }, service: s.name, ws: '/api/remote/ws' }];
  });

  route('GET', '/api/remote/sessions', async () => [200, remote ? remote.active() : []], 'admin');

  route('DELETE', '/api/machines/:id/services/:name/hostkey', async (_req, p, ctx) => {
    mustMachine(p.id, ctx);
    if (!remote?.forgetHostKey(p.id, p.name)) throw new M.HttpError(404, 'no hay huella guardada para ese servicio');
    store.event(p.id, 'huella_ssh_olvidada', p.name, 0);
    return [200, { forgotten: p.name }];
  }, 'admin');

  // ---------- servicios privados (stcp) y sus accesos ----------

  const mustStcp = (machineId, name) => {
    const s = store.getService(machineId, name);
    if (!s) throw new M.HttpError(404, `no existe el servicio "${name}"`);
    if (s.type !== 'stcp') throw M.bad(`el servicio "${name}" no es privado (stcp)`);
    return s;
  };
  /** Acceso visible si se ve el dueño o el visitante; para cambiarlo hay que poder operar el dueño. */
  const mustAccess = (id, ctx, { write = true } = {}) => {
    const a = store.getAccess(id);
    const owner = a && store.getMachine(a.owner_id);
    const visitor = a && store.getMachine(a.visitor_id);
    if (!a || !(ctx.canSee(owner) || ctx.canSee(visitor))) throw new M.HttpError(404, 'no existe ese acceso');
    if (write && !ctx.canWrite(owner)) throw new M.HttpError(403, 'no puede cambiar accesos de servicios de otro cliente');
    return a;
  };

  route('POST', '/api/machines/:id/services/:name/rotate-secret', async (_req, p, ctx) => {
    mustMachine(p.id, ctx);
    const s = mustStcp(p.id, p.name);
    store.setServiceSecret(s.id, M.newSecret());
    if (browserKind(s)) hub?.sync();
    const visitors = store.accessForService(s.id).map((a) => a.visitor_id);
    store.event(p.id, 'clave_rotada', `${p.name}: los visitantes deben actualizar su archivo de accesos${visitors.length ? ' (' + visitors.join(', ') + ')' : ''}`, 0);
    reload([p.id]);
    return [200, { rotated: p.name, visitors }];
  });

  route('GET', '/api/access', async (_req, _p, ctx) => {
    const status = await frps.status();
    const ids = visibleIds(ctx);
    return [200, store.listAccess().filter((a) => ids.has(a.owner_id) || ids.has(a.visitor_id)).map((a) => accessView(a, status))];
  });

  route('POST', '/api/access', async (req, _p, ctx) => {
    const body = await readJson(req);
    // El técnico debe poder operar las dos máquinas: la del servicio y la que entra
    mustMachine(String(body.machine || ''), ctx);
    mustMachine(String(body.visitor || ''), ctx);
    const r = M.normalizeAccess(body, store);
    const a = store.createAccess(r.svc.id, r.visitor.id, r.bindPort);
    store.event(r.owner.id, 'acceso_otorgado', `${r.svc.name} → ${r.visitor.id} (puerto ${r.bindPort})`, 0);
    store.event(r.visitor.id, 'acceso_otorgado', `${r.owner.id}/${r.svc.name} en 127.0.0.1:${r.bindPort}`, 0);
    reload([r.owner.id]);
    return [201, accessView(a, await frps.status())];
  });

  route('DELETE', '/api/access/:id', async (_req, p, ctx) => {
    const a = mustAccess(p.id, ctx);
    store.deleteAccess(a.id);
    store.event(a.owner_id, 'acceso_revocado', `${a.service} → ${a.visitor_id}`, 0);
    store.event(a.visitor_id, 'acceso_revocado', `${a.owner_id}/${a.service}`, 0);
    reload([a.owner_id]);
    return [200, { deleted: a.id }];
  });

  // Archivo de accesos de una máquina visitante (no lleva el token de la máquina)
  route('GET', '/api/machines/:id/accesos.toml', async (_req, p, ctx) => {
    const m = mustMachine(p.id, ctx);
    return [200, M.accessToml(m, store.accessOfVisitor(m.id), store.snmpOf(m.id)), {
      'content-type': 'application/toml; charset=utf-8',
      'content-disposition': `attachment; filename="${M.accessFileName(m.id)}"`,
    }];
  });

  route('GET', '/api/machines/:id/accesos/:platform', async (_req, p, ctx) => {
    const m = mustMachine(p.id, ctx);
    const P = ACCESS_PLATFORMS[p.platform];
    if (!P) throw M.bad('platform debe ser linux o windows');
    const grants = store.accessOfVisitor(m.id);
    const snmp = store.snmpOf(m.id);
    store.event(m.id, 'accesos_descargados', `${p.platform} · ${grants.length} acceso${grants.length === 1 ? '' : 's'}${snmp.length ? ` · ${snmp.length} SNMP` : ''}`, 0);
    return [200, P.build(m, grants, M.accessToml(m, grants, snmp), snmp), {
      'content-type': P.type,
      'content-disposition': `attachment; filename="accesos-${m.id}.${P.ext}"`,
    }];
  });

  // ---------- equipos SNMP de la red local de cada sede ----------

  const mustSnmp = (id, ctx, { write = true } = {}) => {
    const d = store.getSnmp(Number(id));
    if (!d || !ctx.canSee(store.getMachine(d.machine_id))) throw new M.HttpError(404, 'no existe ese equipo SNMP');
    if (write) mustMachine(d.machine_id, ctx);
    return d;
  };
  const snmpView = async (d, ctx) => SD.snmpView(d, await frps.status(), { client: ctx.role === 'cliente' });
  const hubSync = () => hub?.sync();

  route('GET', '/api/snmp/profiles', async () => [200, Object.values(SNMP_PROFILES).map((p) => ({
    id: p.id, label: p.label, thresholds: p.thresholds, meta: p.meta,
  }))], 'any');

  route('GET', '/api/snmp/devices', async (req, _p, ctx) => {
    const machine = new URL(req.url, 'http://x').searchParams.get('machine');
    if (machine) mustMachine(machine, ctx, { write: false });
    const ids = visibleIds(ctx);
    const status = await frps.status();
    const list = (machine ? store.snmpOf(machine) : store.listSnmp()).filter((d) => ids.has(d.machine_id));
    return [200, list.map((d) => SD.snmpView(d, status, { client: ctx.role === 'cliente' }))];
  }, 'any');

  route('GET', '/api/snmp/devices/:id', async (_req, p, ctx) => [200, await snmpView(mustSnmp(p.id, ctx, { write: false }), ctx)], 'any');

  route('POST', '/api/snmp/devices', async (req, _p, ctx) => {
    const body = await readJson(req);
    const m = mustMachine(String(body.machine || ''), ctx);
    const data = SD.normalizeSnmp(body, null, M.bad);
    const used = store.usedSnmpPorts();
    let port = config.snmpPortBase;
    while (used.has(port)) port++;
    const d = store.createSnmp({ ...data, machine_id: m.id, secret: M.newSecret(), bind_port: port });
    store.event(m.id, 'snmp_agregado', `${d.name} (${d.host}:${d.port}, v${d.version})`, 0);
    hubSync();
    return [201, await snmpView(d, ctx)];
  });

  route('PATCH', '/api/snmp/devices/:id', async (req, p, ctx) => {
    const cur = mustSnmp(p.id, ctx);
    const data = SD.normalizeSnmp(await readJson(req), cur, M.bad);
    // Cambiar IP o puerto exige aplicar el archivo nuevo en la sede (el nombre del servicio cambia)
    if ((data.host && data.host !== cur.host) || (data.port && data.port !== cur.port)) data.rev = cur.rev + 1;
    const d = store.updateSnmp(cur.id, { ...data, ...(data.profile && data.profile !== cur.profile ? { detected: null } : {}) });
    snmp?.forget(d.id);
    store.event(d.machine_id, 'snmp_modificado', `${d.name}${data.rev ? ' · cambió la dirección: aplique los accesos en la sede' : ''}`, 0);
    hubSync();
    if (data.rev || data.enabled !== undefined) reload([d.machine_id]);
    return [200, await snmpView(d, ctx)];
  });

  route('DELETE', '/api/snmp/devices/:id', async (_req, p, ctx) => {
    const d = mustSnmp(p.id, ctx);
    store.deleteSnmp(d.id);
    snmp?.forget(d.id);
    store.event(d.machine_id, 'snmp_eliminado', d.name, 0);
    hubSync();
    reload([d.machine_id]);
    return [200, { deleted: d.id }];
  });

  route('POST', '/api/snmp/devices/:id/poll', async (_req, p, ctx) => {
    const d = mustSnmp(p.id, ctx);
    const r = await snmp.pollNow(d.id);
    return [200, { result: r, device: await snmpView(store.getSnmp(d.id), ctx) }];
  });

  route('GET', '/api/snmp/devices/:id/walk', async (req, p, ctx) => {
    const d = mustSnmp(p.id, ctx);
    const oid = new URL(req.url, 'http://x').searchParams.get('oid') || '1.3.6.1.2.1.1';
    try {
      const vbs = await snmp.walk(d.id, oid, 500);
      const { display } = require('./snmp');
      return [200, vbs.map((vb) => ({ oid: vb.oid, type: vb.type, value: display(vb) }))];
    } catch (e) {
      if (e.status) throw new M.HttpError(e.status, e.message);
      throw new M.HttpError(502, `el equipo no respondió el recorrido: ${e.message}`);
    }
  });

  route('GET', '/api/snmp/devices/:id/history', async (req, p, ctx) => {
    const d = mustSnmp(p.id, ctx, { write: false });
    const u = new URL(req.url, 'http://x');
    const range = { '6h': 6 * 3600, '24h': 86400, '7d': 7 * 86400, '30d': 30 * 86400 }[u.searchParams.get('range') || '24h'];
    if (!range) throw M.bad('range debe ser 6h, 24h, 7d o 30d');
    const metrics = (u.searchParams.get('metric') || '').split(',').filter(Boolean).slice(0, 8);
    const from = Math.floor(Date.now() / 1000) - range;
    const bucket = Math.max(300, Math.ceil(range / 300 / 300) * 300); // máx. ~300 puntos por serie
    const series = {};
    for (const m of metrics) {
      const pts = store.samples(d.id, m, from);
      const agg = new Map();
      for (const s of pts) {
        const b = Math.floor(s.ts / bucket) * bucket;
        const a = agg.get(b) || { sum: 0, n: 0, max: -Infinity };
        a.sum += s.value; a.n++; a.max = Math.max(a.max, s.value);
        agg.set(b, a);
      }
      series[m] = [...agg.entries()].map(([ts, a]) => [ts, Math.round((a.sum / a.n) * 100) / 100, a.max]);
    }
    return [200, { from, to: from + range, bucket, series, available: store.sampleMetrics(d.id) }];
  }, 'any');

  route('GET', '/api/access/:id/rdp', async (req, p, ctx) => {
    const a = mustAccess(p.id, ctx, { write: false });
    mustMachine(a.visitor_id, ctx, { write: false });
    const user = (new URL(req.url, 'http://x').searchParams.get('user') || '').replace(/[^\w.@\\-]/g, '').slice(0, 64);
    return [200, M.rdpFile(a, user), {
      'content-type': 'application/x-rdp; charset=utf-8',
      'content-disposition': `attachment; filename="${a.owner_id}-${a.service}.rdp"`,
    }];
  });

  route('GET', '/api/alerts/settings', async () => [200, A.publicSettings(A.loadSettings(store))], 'admin');

  route('PUT', '/api/alerts/settings', async (req, _p, ctx) => {
    const body = await readJson(req);
    const s = A.updateSettings(store, body, M.bad);
    store.event(null, 'alertas_configuradas', `gracia ${s.graceSeconds} s · Telegram ${s.telegram.botToken && s.telegram.chatId ? 'sí' : 'no'} · webhooks ${s.webhooks.length}`, 0);
    return [200, A.publicSettings(s)];
  }, 'admin');

  route('POST', '/api/alerts/test', async (_req, _p, ctx) => {
    const results = await monitor.notify({ type: 'test', at: Math.floor(Date.now() / 1000) });
    if (results.length === 0) throw M.bad('no hay canales configurados (Telegram o webhooks)');
    return [200, { results }];
  }, 'admin');

  // ---------- IA ----------

  // Conversaciones del panel: "general" (una por usuario) o "m-<maquina>" (compartida por quienes operan la máquina)
  const panelConv = (cid, ctx) => {
    if (cid === 'general') return { id: ctx.user ? `panel:general:u:${ctx.user.id}` : 'panel:general', machineId: null };
    const m = /^m-(.+)$/.exec(cid);
    if (m) { mustMachine(m[1], ctx); return { id: `panel:m:${m[1]}`, machineId: m[1] }; }
    throw new M.HttpError(404, 'conversación no encontrada');
  };
  /** ¿Puede esta persona leer la conversación? (para no devolver chats ajenos al aprobar acciones) */
  const convVisible = (convId, ctx) => {
    if (convId === `panel:general:u:${ctx.user?.id}`) return true;
    if (convId === 'panel:general') return ctx.via === 'token';
    const m = /^panel:m:(.+)$/.exec(convId);
    if (m) return ctx.canWrite(store.getMachine(m[1]));
    return ctx.isAdmin;
  };
  // La IA de una conversación general solo ve las máquinas de su dueño
  ai.allowFor = (conv) => {
    const m = /^panel:general:u:(\d+)$/.exec(conv.id || '');
    if (!m) return null;
    const u = store.getUser(Number(m[1]));
    if (!u || !u.enabled) return () => false;
    const a = accessFor(store, u, 'sesion');
    return (machine) => a.canWrite(machine);
  };
  const mustAction = (id, ctx) => {
    const a = store.getAction(Number(id));
    if (!a || !ctx.canSee(store.getMachine(a.machine_id))) throw new M.HttpError(404, 'no existe la acción');
    if (!ctx.canWrite(store.getMachine(a.machine_id))) throw new M.HttpError(403, 'no puede decidir acciones de esta máquina');
    return a;
  };
  const decided = (r, ctx) => (convVisible(r.action.conversation_id, ctx)
    ? { ...r, ...convView(r.action.conversation_id) }
    : { action: r.action, reply: null, messages: [], actions: [] });
  const convView = (id) => {
    const c = store.getConversation(id);
    return { messages: c ? viewMessages(c.messages) : [], actions: store.conversationActions(id) };
  };

  route('GET', '/api/ai/settings', async () => [200, ai.publicSettings()], 'admin');
  route('PUT', '/api/ai/settings', async (req, _p, ctx) => {
    const r = ai.updateSettings(await readJson(req));
    store.event(null, 'ia_configurada', `${r.enabled ? 'activa' : 'inactiva'} · ${r.model} · diagnóstico ${r.analyzeAlerts ? 'sí' : 'no'} · Telegram ${r.telegramBot ? 'sí' : 'no'}`, 0);
    return [200, r];
  }, 'admin');
  route('GET', '/api/ai/ssh-key', async (_req, _p, ctx) => [200, { publicKey: await ai.publicKey() }]);

  route('GET', '/api/machines/:id/ai-scope', async (_req, p, ctx) => {
    mustMachine(p.id, ctx);
    return [200, SC.scopeForPanel(store.getScope(p.id))];
  });
  route('PUT', '/api/machines/:id/ai-scope', async (req, p, ctx) => {
    mustMachine(p.id, ctx);
    const scope = SC.normalizeScope(await readJson(req, 128 * 1024), store.servicesOf(p.id), store.getScope(p.id), M.bad);
    store.setScope(p.id, scope);
    store.event(p.id, 'ia_alcance', `${scope.enabled ? 'habilitada' : 'deshabilitada'} · ${scope.http.length} consultas · ${scope.commands.length} comandos`, 0);
    return [200, SC.scopeForPanel(scope)];
  });

  route('GET', '/api/ai/conversations/:cid', async (_req, p, ctx) => [200, convView(panelConv(p.cid, ctx).id)]);
  route('DELETE', '/api/ai/conversations/:cid', async (_req, p, ctx) => { ai.reset(panelConv(p.cid, ctx).id); return [200, { ok: true }]; });
  route('POST', '/api/ai/conversations/:cid/messages', async (req, p, ctx) => {
    const c = panelConv(p.cid, ctx);
    const body = await readJson(req);
    const r = await ai.chat(c.id, { machineId: c.machineId, channel: 'panel' }, body.text);
    return [200, { reply: r.reply, ...convView(c.id) }];
  });

  route('GET', '/api/ai/actions', async (_req, _p, ctx) => [200, ai.pending().filter((a) => ctx.canWrite(store.getMachine(a.machine_id)))]);
  route('POST', '/api/ai/actions/:id/approve', async (_req, p, ctx) => {
    mustAction(p.id, ctx);
    return [200, decided(await ai.approve(Number(p.id), ctx.actor), ctx)];
  });
  route('POST', '/api/ai/actions/:id/reject', async (_req, p, ctx) => {
    mustAction(p.id, ctx);
    return [200, decided(await ai.reject(Number(p.id), ctx.actor), ctx)];
  });

  route('GET', '/api/events', async (req, _p, ctx) => {
    const u = new URL(req.url, 'http://x');
    const limit = Number(u.searchParams.get('limit')) || 100;
    const machineId = u.searchParams.get('machine') || undefined;
    if (machineId) mustMachine(machineId, ctx, { write: false });
    if (ctx.clientIds === null) return [200, store.events({ machineId, limit })];
    const ids = visibleIds(ctx);
    return [200, store.events({ machineId, limit, visible: (id) => ids.has(id) })];
  }, 'any');

  // ---------- sesión y cuenta propia ----------

  const secureCookie = (req) => config.cookieSecure || req.headers['x-forwarded-proto'] === 'https';
  const clientIp = (req) => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
  const ipFails = new Map(); // ip → [marcas de tiempo de intentos fallidos]
  const ipBlocked = (ip) => {
    const since = Date.now() - 15 * 60 * 1000;
    const list = (ipFails.get(ip) || []).filter((x) => x > since);
    ipFails.set(ip, list);
    return list.length >= 20;
  };

  async function startSession(req, user) {
    const token = AU.newSessionToken();
    store.createSession(AU.hashSession(token), user.id, { ip: clientIp(req), userAgent: req.headers['user-agent'] || '', hours: AU.SESSION_HOURS });
    store.updateUser(user.id, { failed_count: 0, locked_until: null, last_login_at: Math.floor(Date.now() / 1000) });
    return { 'set-cookie': AU.sessionCookie(token, { secure: secureCookie(req) }) };
  }

  route('GET', '/api/auth/state', async () => [200, { needsSetup: store.countUsers() === 0 }], 'public');

  // Primer administrador: solo mientras no haya usuarios y con el ADMIN_TOKEN del servidor
  route('POST', '/api/auth/setup', async (req) => {
    const body = await readJson(req);
    if (store.countUsers() > 0) throw new M.HttpError(409, 'ya hay usuarios: inicie sesión');
    if (!body.adminToken || !safeEqual(body.adminToken, config.adminToken)) throw new M.HttpError(403, 'el token de administración no es correcto');
    const u = await newUser({ username: body.username, name: body.name, role: 'admin', password: body.password }, { mustChange: false });
    requestContext.getStore().actor = u.username;
    store.event(null, 'usuario_creado', `${u.username} (administrador inicial)`, 0);
    return [201, { user: userView(u) }, await startSession(req, u)];
  }, 'public');

  route('POST', '/api/auth/login', async (req) => {
    const body = await readJson(req);
    const ip = clientIp(req);
    const username = String(body.username || '').trim().toLowerCase();
    const generic = new M.HttpError(401, 'usuario o contraseña incorrectos');
    if (ipBlocked(ip)) throw new M.HttpError(429, 'demasiados intentos desde esta dirección; espere 15 minutos');
    const u = store.userByName(username);
    const nowS = Math.floor(Date.now() / 1000);
    const ok = await AU.verifyPassword(String(body.password || ''), u?.password_hash);
    const fail = (reason) => {
      ipFails.set(ip, [...(ipFails.get(ip) || []), Date.now()]);
      if (u) {
        const n = u.failed_count + 1;
        store.updateUser(u.id, { failed_count: n, locked_until: n >= AU.MAX_FAILS ? nowS + AU.LOCK_MINUTES * 60 : u.locked_until });
        requestContext.getStore().actor = u.username;
        store.event(null, 'login_fallido', `${u.username} · ${reason} · ${ip}`, 0);
      } else {
        store.event(null, 'login_fallido', `usuario desconocido "${username.slice(0, 40)}" · ${ip}`, 60);
      }
    };
    if (u && u.locked_until && u.locked_until > nowS) {
      throw new M.HttpError(423, `usuario bloqueado por intentos fallidos; intente en ${Math.ceil((u.locked_until - nowS) / 60)} min`);
    }
    if (!u || !ok) { fail('contraseña incorrecta'); throw generic; }
    if (!u.enabled) { fail('usuario deshabilitado'); throw generic; }
    if (u.totp_enabled) {
      if (!body.code) return [401, { error: 'ingrese el código de su app de autenticación', needCode: true }];
      const step = AU.verifyTotp(u.totp_secret, body.code, u.totp_last_step);
      if (!step) { fail('código 2FA incorrecto'); throw new M.HttpError(401, 'código incorrecto o vencido'); }
      store.updateUser(u.id, { totp_last_step: step });
    }
    requestContext.getStore().actor = u.username;
    store.event(null, 'sesion_iniciada', `${u.username} · ${ip}`, 0);
    return [200, { user: userView(store.getUser(u.id)) }, await startSession(req, u)];
  }, 'public');

  route('POST', '/api/auth/logout', async (req, _p, ctx) => {
    if (ctx.sessionId) store.deleteSession(ctx.sessionId);
    return [200, { ok: true }, { 'set-cookie': AU.sessionCookie('', { secure: secureCookie(req), maxAge: 0 }) }];
  }, 'session');

  route('GET', '/api/auth/me', async (_req, _p, ctx) => [200, {
    user: ctx.user ? userView(ctx.user) : { username: 'token-api', name: 'Token de administración', role: 'admin', via: 'token' },
    clients: (ctx.clientIds === null ? store.listClients() : store.listClients().filter((c) => ctx.clientIds.has(c.id))).map((c) => ({ id: c.id, name: c.name })),
  }], 'session');

  const mustSessionUser = (ctx) => {
    if (!ctx.user) throw M.bad('el token de administración no tiene cuenta: inicie sesión con un usuario');
    return store.getUser(ctx.user.id);
  };

  route('POST', '/api/auth/password', async (req, _p, ctx) => {
    const u = mustSessionUser(ctx);
    const body = await readJson(req);
    if (!(await AU.verifyPassword(String(body.current || ''), u.password_hash))) throw new M.HttpError(403, 'la contraseña actual no es correcta');
    const pw = AU.checkPasswordPolicy(body.password, M.bad);
    if (pw === body.current) throw M.bad('la contraseña nueva debe ser distinta a la actual');
    store.updateUser(u.id, { password_hash: await AU.hashPassword(pw), must_change: 0 });
    store.deleteUserSessions(u.id, ctx.sessionId); // cierra sus otras sesiones
    store.event(null, 'contrasena_cambiada', u.username, 0);
    return [200, { user: userView(store.getUser(u.id)) }];
  }, 'session');

  route('POST', '/api/auth/totp/setup', async (_req, _p, ctx) => {
    const u = mustSessionUser(ctx);
    if (u.totp_enabled) throw new M.HttpError(409, 'el segundo factor ya está activo');
    const secret = AU.newTotpSecret();
    store.updateUser(u.id, { totp_secret: secret, totp_enabled: 0 });
    return [200, { secret, uri: AU.totpUri(secret, u.username) }];
  }, 'session');

  route('POST', '/api/auth/totp/enable', async (req, _p, ctx) => {
    const u = mustSessionUser(ctx);
    const body = await readJson(req);
    if (u.totp_enabled) throw new M.HttpError(409, 'el segundo factor ya está activo');
    const step = AU.verifyTotp(u.totp_secret, body.code, 0);
    if (!u.totp_secret || !step) throw M.bad('el código no coincide: revise la hora del teléfono y vuelva a intentar');
    store.updateUser(u.id, { totp_enabled: 1, totp_last_step: step });
    store.event(null, '2fa_activado', u.username, 0);
    return [200, { user: userView(store.getUser(u.id)) }];
  }, 'session');

  route('POST', '/api/auth/totp/disable', async (req, _p, ctx) => {
    const u = mustSessionUser(ctx);
    const body = await readJson(req);
    if (!(await AU.verifyPassword(String(body.password || ''), u.password_hash))) throw new M.HttpError(403, 'la contraseña no es correcta');
    store.updateUser(u.id, { totp_enabled: 0, totp_secret: null, totp_last_step: 0 });
    store.event(null, '2fa_desactivado', u.username, 0);
    return [200, { user: userView(store.getUser(u.id)) }];
  }, 'session');

  // ---------- usuarios y clientes (administrador) ----------

  const userView = (u) => ({
    id: u.id, username: u.username, name: u.name, role: u.role, roleLabel: AU.ROLE_LABEL[u.role],
    client: u.client_id, clients: u.role === 'tecnico' ? store.userClientIds(u.id) : [],
    enabled: !!u.enabled, mustChangePassword: !!u.must_change, totp: !!u.totp_enabled,
    locked: !!(u.locked_until && u.locked_until > Math.floor(Date.now() / 1000)),
    createdAt: u.created_at, lastLoginAt: u.last_login_at,
  });

  /** Valida rol y clientes de un usuario. */
  const roleFields = (body, current = null) => {
    const role = body.role !== undefined ? String(body.role) : current?.role;
    if (!AU.ROLES.includes(role)) throw M.bad('role debe ser admin, tecnico o cliente');
    let clientId = null; let clients = [];
    if (role === 'cliente') {
      clientId = body.client !== undefined ? String(body.client || '') : current?.client_id;
      if (!clientId || !store.getClient(clientId)) throw M.bad('un usuario cliente debe tener un cliente válido');
    }
    if (role === 'tecnico') {
      clients = body.clients !== undefined ? body.clients : (current ? store.userClientIds(current.id) : []);
      if (!Array.isArray(clients)) throw M.bad('clients debe ser una lista de ids de cliente');
      for (const c of clients) if (!store.getClient(String(c))) throw M.bad(`no existe el cliente "${c}"`);
      clients = clients.map(String);
    }
    return { role, clientId, clients };
  };

  async function newUser(body, { mustChange = true } = {}) {
    const username = String(body.username || '').trim().toLowerCase();
    if (!AU.USERNAME_RE.test(username)) throw M.bad('el usuario admite a-z, 0-9, punto, guion y guion bajo (2 a 32 caracteres)');
    if (store.userByName(username)) throw new M.HttpError(409, `ya existe el usuario "${username}"`);
    const name = String(body.name || '').trim().slice(0, 80);
    const r = roleFields(body);
    const password = AU.checkPasswordPolicy(body.password, M.bad);
    const u = store.createUser({ username, name, role: r.role, clientId: r.clientId, passwordHash: await AU.hashPassword(password), mustChange });
    if (r.role === 'tecnico') store.setUserClients(u.id, r.clients);
    return u;
  }

  route('GET', '/api/users', async () => [200, store.listUsers().map(userView)], 'admin');

  route('POST', '/api/users', async (req) => {
    const body = await readJson(req);
    const generated = !body.password;
    if (generated) body.password = AU.tempPassword();
    const u = await newUser(body);
    store.event(null, 'usuario_creado', `${u.username} · ${AU.ROLE_LABEL[u.role]}`, 0);
    return [201, { user: userView(u), tempPassword: generated ? body.password : undefined }];
  }, 'admin');

  route('PATCH', '/api/users/:id', async (req, p, ctx) => {
    const u = store.getUser(p.id);
    if (!u) throw new M.HttpError(404, 'no existe el usuario');
    const body = await readJson(req);
    const self = ctx.user?.id === u.id;
    const fields = {};
    if (body.name !== undefined) fields.name = String(body.name).trim().slice(0, 80);
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') throw M.bad('enabled debe ser true o false');
      if (self && !body.enabled) throw M.bad('no puede deshabilitar su propio usuario');
      fields.enabled = body.enabled ? 1 : 0;
      if (body.enabled) { fields.failed_count = 0; fields.locked_until = null; }
    }
    if (body.role !== undefined || body.client !== undefined || body.clients !== undefined) {
      const r = roleFields(body, u);
      if (self && r.role !== 'admin') throw M.bad('no puede quitarse a sí mismo el rol de administrador');
      fields.role = r.role;
      fields.client_id = r.clientId;
      if (r.role === 'tecnico') store.setUserClients(u.id, r.clients); else store.setUserClients(u.id, []);
    }
    if (u.role === 'admin' && (fields.role && fields.role !== 'admin' || fields.enabled === 0) && store.countAdmins(u.id) === 0) {
      throw M.bad('debe quedar al menos un administrador habilitado');
    }
    let tempPassword;
    if (body.resetPassword) {
      tempPassword = AU.tempPassword();
      fields.password_hash = await AU.hashPassword(tempPassword);
      fields.must_change = 1; fields.failed_count = 0; fields.locked_until = null;
    }
    if (body.resetTotp) { fields.totp_enabled = 0; fields.totp_secret = null; fields.totp_last_step = 0; }
    const updated = store.updateUser(u.id, fields);
    // Cambios de permisos o credenciales: se cierran sus sesiones abiertas
    if (fields.enabled === 0 || fields.role !== undefined || body.resetPassword) store.deleteUserSessions(u.id, self ? ctx.sessionId : '');
    const what = [fields.enabled !== undefined && (fields.enabled ? 'habilitado' : 'deshabilitado'), fields.role && `rol ${AU.ROLE_LABEL[fields.role]}`,
      body.resetPassword && 'contraseña restablecida', body.resetTotp && '2FA restablecido'].filter(Boolean).join(' · ');
    store.event(null, 'usuario_modificado', `${u.username}${what ? ' · ' + what : ''}`, 0);
    return [200, { user: userView(updated), tempPassword }];
  }, 'admin');

  route('DELETE', '/api/users/:id', async (_req, p, ctx) => {
    const u = store.getUser(p.id);
    if (!u) throw new M.HttpError(404, 'no existe el usuario');
    if (ctx.user?.id === u.id) throw M.bad('no puede eliminar su propio usuario');
    if (u.role === 'admin' && store.countAdmins(u.id) === 0) throw M.bad('debe quedar al menos un administrador habilitado');
    store.deleteUser(u.id);
    store.event(null, 'usuario_eliminado', u.username, 0);
    return [200, { deleted: u.id }];
  }, 'admin');

  route('GET', '/api/clients', async (_req, _p, ctx) => [200, store.listClients().filter((c) => ctx.canUseClient(c.id))], 'any');

  route('POST', '/api/clients', async (req) => {
    const name = String((await readJson(req)).name || '').trim().slice(0, 80);
    if (!name) throw M.bad('el nombre del cliente es obligatorio');
    if (store.clientByName(name)) throw new M.HttpError(409, `ya existe el cliente "${name}"`);
    const c = store.createClient(name);
    store.event(null, 'cliente_creado', c.name, 0);
    return [201, c];
  }, 'admin');

  route('PATCH', '/api/clients/:id', async (req, p) => {
    const c = store.getClient(p.id);
    if (!c) throw new M.HttpError(404, 'no existe el cliente');
    const name = String((await readJson(req)).name || '').trim().slice(0, 80);
    if (!name) throw M.bad('el nombre del cliente es obligatorio');
    const other = store.clientByName(name);
    if (other && other.id !== c.id) throw new M.HttpError(409, `ya existe el cliente "${name}"`);
    store.event(null, 'cliente_renombrado', `${c.name} → ${name}`, 0);
    return [200, store.renameClient(c.id, name)];
  }, 'admin');

  route('DELETE', '/api/clients/:id', async (_req, p) => {
    const c = store.listClients().find((x) => x.id === p.id);
    if (!c) throw new M.HttpError(404, 'no existe el cliente');
    if (c.machines > 0) throw new M.HttpError(409, `el cliente tiene ${c.machines} máquina(s): muévalas o elimínelas primero`);
    store.deleteClient(c.id);
    store.event(null, 'cliente_eliminado', c.name, 0);
    return [200, { deleted: c.id }];
  }, 'admin');

  // ---------- instalación con código de un solo uso ----------

  const enrollFails = new Map(); // ip → intentos con códigos inexistentes (15 min)
  const enrollBlocked = (ip) => {
    const since = Date.now() - 15 * 60 * 1000;
    const list = (enrollFails.get(ip) || []).filter((x) => x > since);
    enrollFails.set(ip, list);
    return list.length >= 10;
  };
  const enrollFail = (ip) => enrollFails.set(ip, [...(enrollFails.get(ip) || []), Date.now()]);
  const enrollStatus = (e) => (e.revoked_at ? 'revocado' : e.used_at ? 'usado' : e.expires_at <= Math.floor(Date.now() / 1000) ? 'vencido' : 'vigente');
  const enrollView = (e) => ({
    id: e.id, hint: e.hint, mode: e.machine_id ? 'maquina' : 'nueva',
    machine: e.machine_id, client: e.client_id ? (store.getClient(e.client_id)?.name ?? null) : null, clientId: e.client_id,
    serverAddr: e.server_addr, createdBy: e.created_by, createdAt: e.created_at, expiresAt: e.expires_at,
    status: enrollStatus(e), usedAt: e.used_at, usedIp: e.used_ip, usedHost: e.used_host, usedMachine: e.used_machine,
    services: (() => { try { return JSON.parse(e.services || '[]'); } catch { return []; } })(), visitor: e.visitor_id || null,
  });
  /** Busca un código vigente. Devuelve { e } o { error } con un mensaje para mostrar en el equipo. */
  const findEnrollment = (raw, ip) => {
    const norm = E.normalizeCode(raw);
    const e = norm && store.enrollmentByHash(E.hashCode(norm));
    if (!e) { enrollFail(ip); return { error: 'el código no existe: revise que lo copió completo' }; }
    const st = enrollStatus(e);
    if (st === 'usado') return { error: 'ese código ya se usó: genere uno nuevo en el panel' };
    if (st === 'vencido') return { error: 'el código venció: genere uno nuevo en el panel' };
    if (st === 'revocado') return { error: 'el código fue revocado en el panel' };
    return { e, norm };
  };

  route('POST', '/api/enrollments', async (req, _p, ctx) => {
    const body = await readJson(req);
    let machineId = null; let clientId = null;
    if (body.machine) {
      machineId = mustMachine(String(body.machine), ctx).id;
    } else if (body.client) {
      const c = store.getClient(String(body.client)) || store.clientByName(String(body.client));
      if (!c) throw new M.HttpError(404, 'no existe ese cliente');
      clientId = c.id;
    }
    // Máquina nueva: servicios a crear al canjear (se validan ya) y visitante opcional para los privados
    let services = []; let visitorId = null;
    if (!machineId && body.services !== undefined) {
      if (!Array.isArray(body.services) || body.services.length > 10) throw M.bad('services debe ser una lista de hasta 10 servicios');
      const names = new Set();
      services = body.services.map((x) => {
        const v = M.normalizeService(x || {}, 'validacion-codigo', store, config.frps);
        if (names.has(v.name)) throw M.bad(`servicio repetido: ${v.name}`);
        names.add(v.name);
        return { name: v.name, type: v.type, localIp: v.localIp, localPort: v.localPort, ...(v.tlsMode ? { tlsMode: v.tlsMode } : {}) };
      });
      if (body.visitor && services.some((x) => x.type === 'stcp')) visitorId = mustMachine(String(body.visitor), ctx).id;
    }
    const minutes = Math.min(Math.max(Math.round(Number(body.minutes) || E.MINUTES.def), E.MINUTES.min), E.MINUTES.max);
    const base = E.baseUrl(req, config);
    if (!base) throw M.bad('no se pudo determinar la URL del hub: defina HUB_PUBLIC_URL');
    const { serverAddr, adjusted } = E.effectiveServerAddr(M.normalizeServerAddr(body.serverAddr, config.frps.publicAddr), base);
    const code = E.newCode();
    const norm = E.normalizeCode(code);
    const e = store.createEnrollment({
      codeHash: E.hashCode(norm), hint: E.hintOf(norm), machineId, clientId, serverAddr, services, visitorId,
      createdBy: ctx.actor, expiresAt: Math.floor(Date.now() / 1000) + minutes * 60,
    });
    const target = machineId ? 'reinstalar esta máquina'
      : `máquina nueva${clientId ? ' de ' + store.getClient(clientId).name : ' sin cliente'}${services.length ? ' con ' + services.map((x) => x.name).join(', ') : ''}${visitorId ? ' (acceso desde ' + visitorId + ')' : ''}`;
    store.event(machineId, 'codigo_generado', `${target} · …${e.hint} · vence en ${minutes} min · servidor ${serverAddr}`, 0);
    return [201, { enrollment: enrollView(e), code, base, loopback: E.isLoopback(base), serverAdjusted: adjusted, commands: E.commands(base, code) }];
  }, 'admin');

  route('GET', '/api/enrollments', async () => [200, store.listEnrollments().map(enrollView)], 'admin');

  route('DELETE', '/api/enrollments/:id', async (_req, p) => {
    const e = store.getEnrollment(p.id);
    if (!e) throw new M.HttpError(404, 'no existe ese código');
    if (!store.revokeEnrollment(e.id)) throw new M.HttpError(409, `el código ya está ${enrollStatus(e)}`);
    store.event(e.machine_id, 'codigo_revocado', `…${e.hint}`, 0);
    return [200, enrollView(store.getEnrollment(e.id))];
  }, 'admin');

  // Arranque que se pega en el equipo: no lleva secretos, solo el código (que la persona ya tiene)
  route('GET', '/i/:code/:platform', async (req, p) => {
    if (!E.PLATFORMS.includes(p.platform)) throw new M.HttpError(404, 'plataforma no soportada (windows o linux)');
    const ip = clientIp(req);
    const headers = { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' };
    if (enrollBlocked(ip)) return [200, E.errorBootstrap(p.platform, 'Demasiados intentos desde esta direccion: espere 15 minutos.'), headers];
    const r = findEnrollment(p.code, ip);
    if (r.error) return [200, E.errorBootstrap(p.platform, 'Codigo invalido, vencido o ya usado: genere uno nuevo en el panel.'), headers];
    const code = `${r.norm.slice(0, 4)}-${r.norm.slice(4, 8)}-${r.norm.slice(8)}`;
    const base = E.baseUrl(req, config);
    if (!base) throw M.bad('no se pudo determinar la URL del hub');
    return [200, p.platform === 'windows' ? E.windowsBootstrap(base, code) : E.linuxBootstrap(base, code), headers];
  }, 'public');

  // Canje: el equipo recibe el instalador con un token nuevo. Una sola vez por código.
  route('POST', '/api/enroll', async (req) => {
    const ip = clientIp(req);
    if (enrollBlocked(ip)) throw new M.HttpError(429, 'demasiados intentos desde esta dirección; espere 15 minutos');
    const body = await readJson(req, 4096);
    const platform = String(body.platform || '');
    if (!PLATFORMS[platform]) throw M.bad('platform debe ser windows o linux');
    const host = E.cleanHost(body.hostname);
    requestContext.getStore().actor = `instalador (${host})`;
    const r = findEnrollment(body.code, ip);
    if (r.error) {
      store.event(null, 'codigo_rechazado', `${r.error} · ${host} · ${ip}`, 60);
      throw new M.HttpError(/no existe/.test(r.error) ? 404 : 410, r.error);
    }
    const e = r.e;
    if (e.machine_id) {
      const m0 = store.getMachine(e.machine_id);
      if (!m0) throw new M.HttpError(404, 'la máquina del código ya no existe');
      if (!m0.enabled) throw new M.HttpError(409, 'la máquina está deshabilitada en el panel: habilítela y vuelva a intentar');
    }
    const token = M.newToken();
    const granted = []; // accesos creados para el visitante (máquina nueva)
    const machineId = store.transaction(() => {
      if (!store.useEnrollment(e.id, { ip, host })) throw new M.HttpError(410, 'ese código ya se usó: genere uno nuevo en el panel');
      let id = e.machine_id;
      if (id) {
        store.setTokenHash(id, M.hashToken(token));
      } else {
        const client = e.client_id ? store.getClient(e.client_id) : null;
        const data = M.normalizeMachine({ name: host, client: client ? client.name : '' }, store);
        store.createMachine({ ...data, clientId: client ? client.id : null, tokenHash: M.hashToken(token) });
        id = data.id;
        let wanted = [];
        try { wanted = JSON.parse(e.services || '[]'); } catch {}
        for (const sv of wanted) store.createService(id, M.normalizeService(sv, id, store, config.frps));
        if (e.visitor_id && store.getMachine(e.visitor_id)) {
          for (const sv of wanted.filter((x) => x.type === 'stcp')) {
            const a = M.normalizeAccess({ machine: id, service: sv.name, visitor: e.visitor_id }, store);
            store.createAccess(a.svc.id, a.visitor.id, a.bindPort);
            granted.push(`${id}/${sv.name} en 127.0.0.1:${a.bindPort}`);
          }
        }
      }
      store.setEnrollmentMachine(e.id, id);
      return id;
    });
    const m = store.getMachine(machineId);
    if (store.servicesOf(m.id).some(browserKind)) hub?.sync();
    if (!e.machine_id) {
      const svcs = store.servicesOf(m.id);
      store.event(m.id, 'registrada', `${m.name} (instalación con código …${e.hint})${svcs.length ? ' · servicios: ' + svcs.map((x) => x.name).join(', ') : ''}`, 0);
      for (const g of granted) store.event(e.visitor_id, 'acceso_otorgado', `${g} · aplique su archivo de accesos`, 0);
    }
    store.event(m.id, 'codigo_canjeado', `…${e.hint} · ${platform} · ${host} · ${ip} · servidor ${e.server_addr}`, 0);
    const P = PLATFORMS[platform];
    const grants = store.accessOfVisitor(m.id);
    const snmpDevs = store.snmpOf(m.id);
    const text = P.build(m, store.servicesOf(m.id), config.frps, token, e.server_addr, grants.length || snmpDevs.length ? M.accessToml(m, grants, snmpDevs) : '');
    return [200, text, { 'content-type': 'text/plain; charset=utf-8' }];
  }, 'public');

  /** Identifica a quien llama: token de API (Bearer) o cookie de sesión. Devuelve null si no hay credencial válida. */
  function authenticate(req) {
    if (isAdmin(req)) return new AU.Access({ role: 'admin', via: 'token' });
    const token = AU.parseCookies(req.headers.cookie)[AU.COOKIE];
    if (!token) return null;
    const sid = AU.hashSession(token);
    const s = store.getSession(sid);
    const u = s && store.getUser(s.user_id);
    if (!u || !u.enabled) return null;
    const a = accessFor(store, u, 'sesion');
    a.sessionId = sid;
    return a;
  }

  return async function handleApi(req, res, pathname) {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const match = r.re.exec(pathname);
      if (!match) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(match[i + 1]); });

      const ctx = r.perm === 'public' ? null : authenticate(req);
      if (r.perm !== 'public') {
        if (!ctx) return send(res, 401, { error: 'no autorizado: inicie sesión' });
        // Con sesión de navegador, las peticiones que cambian algo deben venir del panel (protección CSRF)
        if (ctx.via === 'sesion' && req.method !== 'GET' && req.headers['x-requested-with'] !== 'iit-panel') {
          return send(res, 403, { error: 'petición rechazada: falta la cabecera X-Requested-With' });
        }
        if (ctx.user?.must_change && r.perm !== 'session') return send(res, 403, { error: 'debe cambiar su contraseña antes de continuar', mustChangePassword: true });
        if (r.perm === 'admin' && !ctx.isAdmin) return send(res, 403, { error: 'solo un administrador puede hacer esto' });
        if (r.perm === 'staff' && !ctx.isStaff) return send(res, 403, { error: 'su usuario solo puede consultar' });
      }
      const [status, data, headers] = await requestContext.run({ actor: ctx ? ctx.actor : null }, () => r.handler(req, params, ctx));
      return send(res, status, data, headers);
    }
    const exists = routes.some((r) => r.re.test(pathname));
    return send(res, exists ? 405 : 404, { error: exists ? 'método no permitido' : 'ruta no encontrada' });
  };
}

function errorResponse(res, err) {
  if (err instanceof M.HttpError || err instanceof AIError) return send(res, err.status, { error: err.message });
  if (err?.code === 'ERR_SQLITE_ERROR' && /UNIQUE/.test(err.message)) return send(res, 409, { error: 'conflicto: el valor ya está en uso' });
  console.error(err);
  stats.api.errors++;
  stats.api.lastError = { at: Math.floor(Date.now() / 1000), message: String(err?.message || err).slice(0, 200) };
  return send(res, 500, { error: 'error interno' });
}

// ---------- arranque ----------

function main() {
  const errors = validate();
  if (errors.length) {
    for (const e of errors) console.error('Configuración: ' + e);
    process.exit(1);
  }

  const store = open(config.dbPath);
  const frps = new FrpsClient(config.frps);
  const monitor = new A.AlertMonitor(store, frps, { intervalSeconds: config.alertCheckSeconds, timezone: config.timezone, telegramBase: config.telegramApiBase });
  const ai = new AIService({ store, frps, config, machineView });
  monitor.ai = ai;
  const bot = new TelegramBot({ store, ai, frps, apiBase: config.telegramApiBase });
  // frpc interno del hub: visita los servicios privados que el hub consulta (SNMP por sudp)
  const remote = new RemoteService({ store, config, frps });
  const hubFrpc = new HubFrpc({
    config, root: path.join(__dirname, '..', '..'),
    visitors: () => [
      ...store.listSnmp().filter((d) => d.enabled).map((d) => ({
        name: `snmp-${d.id}`, type: 'sudp', serverUser: d.machine_id, serverName: M.snmpProxyName(d), secretKey: d.secret, bindPort: d.bind_port,
      })),
      ...remote.visitors(),
    ],
  });
  const plugin = createPluginHandler(store, frps, { hub: hubFrpc });
  // Una sola vez: los SSH/VNC ya publicados deben volver a registrarse para admitir al hub como visitante
  if (!store.getSetting('remoto_hub_visitante')) {
    for (const id of new Set(store.listServices().filter(browserKind).map((s) => s.machine_id))) plugin.requestReload(id);
    store.putSetting('remoto_hub_visitante', true);
    store.putSetting('remoto_hub_visitante_rdp', true);
  }
  // Igual para los RDP ya publicados cuando llegó el escritorio remoto en el navegador
  if (!store.getSetting('remoto_hub_visitante_rdp')) {
    for (const id of new Set(store.listServices().filter((s) => browserKind(s) === 'rdp').map((s) => s.machine_id))) plugin.requestReload(id);
    store.putSetting('remoto_hub_visitante_rdp', true);
  }
  const snmpMon = new SnmpMonitor({
    store, frps, hub: hubFrpc, notify: (a) => monitor.notify(a), graceSeconds: () => A.loadSettings(store).graceSeconds,
  });
  const backups = new BackupService({
    store, dbPath: config.dbPath, dir: config.backupDir, key: config.backupKey, timezone: config.timezone,
    notify: (alert) => monitor.notify(alert),
  });
  let pluginUp = false;
  const api = createApi(store, frps, monitor, ai, plugin, { backups, bot, pluginListening: () => pluginUp, snmp: snmpMon, hub: hubFrpc, remote });

  const app = http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://x');
    try {
      if (pathname.startsWith('/api/') || pathname.startsWith('/i/')) { stats.api.requests++; return await api(req, res, pathname); }
      if (req.method === 'GET') return serveStatic(req, res, pathname);
      return send(res, 405, { error: 'método no permitido' });
    } catch (err) {
      return errorResponse(res, err);
    }
  });

  // WebSocket de las sesiones remotas: /api/remote/ws?t=<ticket>
  app.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    const u = new URL(req.url, 'http://x');
    if (u.pathname !== '/api/remote/ws') return WS.reject(socket, 404, 'Not Found');
    // Solo desde el propio panel: el Origin del navegador debe ser el mismo host
    const origin = req.headers.origin;
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    if (origin) { let oh = ''; try { oh = new URL(origin).host; } catch {} if (oh !== host) return WS.reject(socket, 403, 'Forbidden'); }
    const t = remote.takeTicket(u.searchParams.get('t'));
    if (!t) return WS.reject(socket, 403, 'Forbidden');
    if (head?.length) socket.unshift(head);
    const ws = WS.accept(req, socket, { protocols: t.kind === 'rdp' ? ['guacamole'] : ['binary'] });
    if (!ws) return;
    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
    remote.attach(ws, t, { ip, query: u.search.slice(1), run: (fn) => requestContext.run({ actor: t.actor }, fn) });
  });

  const pluginServer = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (req.method !== 'POST' || u.pathname !== '/frp/handler') return send(res, 404, { error: 'no encontrado' });
    try {
      const body = await readJson(req, 256 * 1024);
      const op = u.searchParams.get('op') || body.op;
      const r = plugin(op, body);
      stats.plugin.calls++;
      stats.plugin.byOp[op] = (stats.plugin.byOp[op] || 0) + 1;
      stats.plugin.lastAt = Math.floor(Date.now() / 1000);
      if (r.reject) stats.plugin.rejects++;
      return send(res, 200, r);
    } catch (err) {
      console.error('plugin:', err.message);
      stats.plugin.errors++;
      // Ante un error interno se rechaza: es preferible negar el acceso que abrirlo por fallo.
      return send(res, 200, { reject: true, reject_reason: 'error interno del hub' });
    }
  });

  app.listen(config.port, config.host, () => console.log(`Panel y API en http://${config.host}:${config.port}`));
  pluginServer.listen(config.pluginPort, config.pluginHost, () => {
    pluginUp = true;
    console.log(`Plugin frps en http://${config.pluginHost}:${config.pluginPort}/frp/handler`);
    hubFrpc.start(); // necesita el plugin escuchando para poder entrar a frps
    console.log(hubFrpc.bin ? `frpc del hub: ${hubFrpc.bin}` : `frpc del hub: ${hubFrpc.lastError}`);
  });
  pluginServer.on('error', (e) => { pluginUp = false; console.error('plugin:', e.message); });
  pluginServer.on('close', () => { pluginUp = false; });

  monitor.start();
  bot.start();
  backups.start();
  snmpMon.start();
  console.log(`Alertas: revisión cada ${config.alertCheckSeconds} s`);
  console.log(`Respaldos en ${path.resolve(config.backupDir)}${config.backupKey ? ' (cifrados)' : ''}`);

  const shutdown = () => { monitor.stop(); bot.stop(); backups.stop(); snmpMon.stop(); hubFrpc.stop(); app.close(); pluginServer.close(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) main();

module.exports = { createApi };
