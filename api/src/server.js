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
const { PLATFORMS } = require('./installers');
const A = require('./alerts');

const VERSION = '1.0.0';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// ---------- utilidades HTTP ----------

function send(res, status, data, headers = {}) {
  const isText = typeof data === 'string';
  const body = isText ? data : JSON.stringify(data);
  res.writeHead(status, {
    'content-type': isText ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
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

function serviceView(s, machineId, status) {
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
    status: proxy ? proxy.status : 'sin_registro',
    connections: proxy?.curConns ?? 0,
    trafficInToday: proxy?.todayTrafficIn ?? 0,
    trafficOutToday: proxy?.todayTrafficOut ?? 0,
  };
}

function machineView(m, services, status) {
  const live = status.clients.get(m.id);
  return {
    id: m.id,
    name: m.name,
    client: m.client,
    description: m.description,
    enabled: !!m.enabled,
    alerts: !!m.alerts,
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
    services: services.map((s) => serviceView(s, m.id, status)),
  };
}

// ---------- rutas de la API ----------

function createApi(store, frps, monitor) {
  const routes = [];
  const route = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handler });
  };

  const mustMachine = (id) => {
    const m = store.getMachine(id);
    if (!m) throw new M.HttpError(404, `no existe la máquina "${id}"`);
    return m;
  };

  route('GET', '/api/health', async () => [200, { ok: true, version: VERSION }]);

  route('GET', '/api/summary', async () => {
    const status = await frps.status();
    const machines = store.listMachines();
    const services = store.listServices();
    return [200, {
      machines: machines.length,
      enabled: machines.filter((m) => m.enabled).length,
      online: machines.filter((m) => status.clients.has(m.id)).length,
      services: services.length,
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
  });

  route('GET', '/api/machines', async () => {
    const status = await frps.status();
    const byMachine = new Map();
    for (const s of store.listServices()) {
      if (!byMachine.has(s.machine_id)) byMachine.set(s.machine_id, []);
      byMachine.get(s.machine_id).push(s);
    }
    return [200, store.listMachines().map((m) => machineView(m, byMachine.get(m.id) || [], status))];
  });

  route('POST', '/api/machines', async (req) => {
    const body = await readJson(req);
    const token = M.newToken();
    const created = store.transaction(() => {
      const data = M.normalizeMachine(body, store);
      store.createMachine({ ...data, tokenHash: M.hashToken(token) });
      for (const s of Array.isArray(body.services) ? body.services : []) {
        store.createService(data.id, M.normalizeService(s, data.id, store, config.frps));
      }
      return data.id;
    });
    const m = store.getMachine(created);
    const services = store.servicesOf(created);
    store.event(created, 'registrada', m.name, 0);
    return [201, {
      machine: machineView(m, services, await frps.status()),
      token,
      frpcToml: M.frpcToml(m, services, config.frps, token),
      note: 'Guarde el token: no se vuelve a mostrar. Si lo pierde, use rotate-token.',
    }];
  });

  route('GET', '/api/machines/:id', async (_req, p) => {
    const m = mustMachine(p.id);
    return [200, machineView(m, store.servicesOf(m.id), await frps.status())];
  });

  route('PATCH', '/api/machines/:id', async (req, p) => {
    mustMachine(p.id);
    const body = await readJson(req);
    const fields = {};
    if (body.name !== undefined) {
      fields.name = String(body.name).trim().slice(0, 80);
      if (!fields.name) throw M.bad('name no puede quedar vacío');
    }
    if (body.client !== undefined) fields.client = String(body.client).trim().slice(0, 80);
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
    if (fields.enabled !== undefined) store.event(p.id, fields.enabled ? 'habilitada' : 'deshabilitada', '', 0);
    if (fields.alerts !== undefined) store.event(p.id, fields.alerts ? 'alertas_activadas' : 'alertas_desactivadas', '', 0);
    return [200, machineView(m, store.servicesOf(m.id), await frps.status())];
  });

  route('DELETE', '/api/machines/:id', async (_req, p) => {
    mustMachine(p.id);
    store.deleteMachine(p.id);
    store.event(p.id, 'eliminada', '', 0);
    return [200, { deleted: p.id }];
  });

  route('POST', '/api/machines/:id/rotate-token', async (_req, p) => {
    const m = mustMachine(p.id);
    const token = M.newToken();
    store.setTokenHash(m.id, M.hashToken(token));
    store.event(m.id, 'token_rotado', 'el token anterior deja de funcionar en el próximo login', 0);
    return [200, { token, frpcToml: M.frpcToml(m, store.servicesOf(m.id), config.frps, token) }];
  });

  route('GET', '/api/machines/:id/frpc.toml', async (_req, p) => {
    const m = mustMachine(p.id);
    const toml = M.frpcToml(m, store.servicesOf(m.id), config.frps, null);
    return [200, toml, { 'content-type': 'application/toml; charset=utf-8', 'content-disposition': `attachment; filename="frpc-${m.id}.toml"` }];
  });

  // Instalador autocontenido. Requiere el token vigente de la máquina (el hub no lo guarda en claro).
  route('POST', '/api/machines/:id/installer', async (req, p) => {
    const m = mustMachine(p.id);
    const body = await readJson(req);
    const platform = String(body.platform || '');
    if (platform !== 'toml' && !PLATFORMS[platform]) throw M.bad('platform debe ser linux, windows o toml');
    if (!M.tokenMatches(body.token, m.token_hash)) throw new M.HttpError(403, 'el token no corresponde a esta máquina (rótelo si lo perdió)');
    const serverAddr = M.normalizeServerAddr(body.serverAddr, config.frps.publicAddr);
    const services = store.servicesOf(m.id);
    if (platform === 'toml') {
      return [200, M.frpcToml(m, services, config.frps, body.token, { serverAddr }), {
        'content-type': 'application/toml; charset=utf-8',
        'content-disposition': `attachment; filename="frpc-${m.id}.toml"`,
      }];
    }
    const P = PLATFORMS[platform];
    store.event(m.id, 'instalador_generado', `${platform} · servidor ${serverAddr}`, 0);
    return [200, P.build(m, services, config.frps, body.token, serverAddr), {
      'content-type': P.type,
      'content-disposition': `attachment; filename="instalar-${m.id}.${P.ext}"`,
    }];
  });

  route('POST', '/api/machines/:id/services', async (req, p) => {
    const m = mustMachine(p.id);
    const body = await readJson(req);
    const s = store.createService(m.id, M.normalizeService(body, m.id, store, config.frps));
    store.event(m.id, 'servicio_agregado', `${s.name} (${s.type})`, 0);
    return [201, serviceView(s, m.id, await frps.status())];
  });

  route('DELETE', '/api/machines/:id/services/:name', async (_req, p) => {
    mustMachine(p.id);
    if (!store.deleteService(p.id, p.name)) throw new M.HttpError(404, `no existe el servicio "${p.name}"`);
    store.event(p.id, 'servicio_eliminado', p.name, 0);
    return [200, { deleted: p.name }];
  });

  route('GET', '/api/alerts/settings', async () => [200, A.publicSettings(A.loadSettings(store))]);

  route('PUT', '/api/alerts/settings', async (req) => {
    const body = await readJson(req);
    const s = A.updateSettings(store, body, M.bad);
    store.event(null, 'alertas_configuradas', `gracia ${s.graceSeconds} s · Telegram ${s.telegram.botToken && s.telegram.chatId ? 'sí' : 'no'} · webhooks ${s.webhooks.length}`, 0);
    return [200, A.publicSettings(s)];
  });

  route('POST', '/api/alerts/test', async () => {
    const results = await monitor.notify({ type: 'test', at: Math.floor(Date.now() / 1000) });
    if (results.length === 0) throw M.bad('no hay canales configurados (Telegram o webhooks)');
    return [200, { results }];
  });

  route('GET', '/api/events', async (req) => {
    const u = new URL(req.url, 'http://x');
    const limit = Number(u.searchParams.get('limit')) || 100;
    const machineId = u.searchParams.get('machine') || undefined;
    return [200, store.events({ machineId, limit })];
  });

  return async function handleApi(req, res, pathname) {
    if (!isAdmin(req)) return send(res, 401, { error: 'no autorizado: envíe Authorization: Bearer <ADMIN_TOKEN>' });
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const match = r.re.exec(pathname);
      if (!match) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(match[i + 1]); });
      const [status, data, headers] = await r.handler(req, params);
      return send(res, status, data, headers);
    }
    const exists = routes.some((r) => r.re.test(pathname));
    return send(res, exists ? 405 : 404, { error: exists ? 'método no permitido' : 'ruta no encontrada' });
  };
}

function errorResponse(res, err) {
  if (err instanceof M.HttpError) return send(res, err.status, { error: err.message });
  if (err?.code === 'ERR_SQLITE_ERROR' && /UNIQUE/.test(err.message)) return send(res, 409, { error: 'conflicto: el valor ya está en uso' });
  console.error(err);
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
  const monitor = new A.AlertMonitor(store, frps, { intervalSeconds: config.alertCheckSeconds, timezone: config.timezone });
  const api = createApi(store, frps, monitor);
  const plugin = createPluginHandler(store, frps);

  const app = http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://x');
    try {
      if (pathname.startsWith('/api/')) return await api(req, res, pathname);
      if (req.method === 'GET') return serveStatic(req, res, pathname);
      return send(res, 405, { error: 'método no permitido' });
    } catch (err) {
      return errorResponse(res, err);
    }
  });

  const pluginServer = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (req.method !== 'POST' || u.pathname !== '/frp/handler') return send(res, 404, { error: 'no encontrado' });
    try {
      const body = await readJson(req, 256 * 1024);
      const op = u.searchParams.get('op') || body.op;
      return send(res, 200, plugin(op, body));
    } catch (err) {
      console.error('plugin:', err.message);
      // Ante un error interno se rechaza: es preferible negar el acceso que abrirlo por fallo.
      return send(res, 200, { reject: true, reject_reason: 'error interno del hub' });
    }
  });

  app.listen(config.port, config.host, () => console.log(`Panel y API en http://${config.host}:${config.port}`));
  pluginServer.listen(config.pluginPort, config.pluginHost, () => console.log(`Plugin frps en http://${config.pluginHost}:${config.pluginPort}/frp/handler`));

  monitor.start();
  console.log(`Alertas: revisión cada ${config.alertCheckSeconds} s`);

  const shutdown = () => { monitor.stop(); app.close(); pluginServer.close(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) main();

module.exports = { createApi };
