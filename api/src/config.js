'use strict';
// Configuración por variables de entorno. Ver .env.example en la raíz.

const path = require('node:path');

const env = process.env;

function int(name, def) {
  const v = env[name];
  if (v === undefined || v === '') return def;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`${name} debe ser un número`);
  return n;
}

const config = {
  // Panel + API de administración
  host: env.HOST || '0.0.0.0',
  port: int('PORT', 8080),
  adminToken: env.ADMIN_TOKEN || '',
  // Cookie de sesión con Secure (solo HTTPS). Detrás de un proxy HTTPS se activa sola con X-Forwarded-Proto.
  cookieSecure: env.COOKIE_SECURE === '1',

  // Endpoint que consulta frps (server plugin). Nunca debe quedar expuesto a Internet.
  pluginHost: env.PLUGIN_HOST || '127.0.0.1',
  pluginPort: int('PLUGIN_PORT', 9000),

  dbPath: env.DB_PATH || './data/hub.db',

  // Alertas: cada cuánto se revisa el estado y zona horaria de los mensajes
  alertCheckSeconds: int('ALERT_CHECK_SECONDS', 15),
  timezone: env.TZ_ALERTS || 'America/Bogota',
  telegramApiBase: (env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/$/, ''),

  // IA (Claude API). La clave y el modelo también se pueden configurar desde el panel; la variable tiene prioridad.
  ai: {
    envApiKey: env.ANTHROPIC_API_KEY || '',
    baseUrl: (env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, ''),
    model: env.AI_MODEL || '',
    // Clave SSH con la que el hub ejecuta los comandos de la lista blanca (se crea sola)
    sshKeyPath: env.AI_SSH_KEY || path.join(path.dirname(path.resolve(env.DB_PATH || './data/hub.db')), 'ia_ssh_ed25519'),
    // Dirección desde la que el hub alcanza a frps (corren en el mismo servidor)
    frpsLocalAddr: env.FRPS_LOCAL_ADDR || '127.0.0.1',
  },

  frps: {
    // Dirección con la que las máquinas llegan a frps (IP pública, dominio o IP de ZeroTier/LAN)
    publicAddr: env.FRPS_PUBLIC_ADDR || '127.0.0.1',
    bindPort: int('FRPS_BIND_PORT', 7000),
    // Token global de frps (auth.token). Opcional: la autenticación real es por máquina.
    authToken: env.FRP_AUTH_TOKEN || '',
    subdomainHost: env.FRPS_SUBDOMAIN_HOST || 'tuneles.local',
    vhostHttpPort: int('FRPS_VHOST_HTTP_PORT', 80),
    vhostHttpsPort: int('FRPS_VHOST_HTTPS_PORT', 443),
    // Puertos que ve el visitante, si frps queda detrás de otro proxy (p. ej. Nginx con ssl_preread en el 443)
    publicHttpPort: int('PUBLIC_HTTP_PORT', int('FRPS_VHOST_HTTP_PORT', 80)),
    publicHttpsPort: int('PUBLIC_HTTPS_PORT', int('FRPS_VHOST_HTTPS_PORT', 443)),
    tcpPortMin: int('FRPS_TCP_PORT_MIN', 20000),
    tcpPortMax: int('FRPS_TCP_PORT_MAX', 20100),
    // API del dashboard de frps (webServer) para leer el estado en vivo
    apiUrl: (env.FRPS_API_URL || 'http://127.0.0.1:7500').replace(/\/$/, ''),
    apiUser: env.FRPS_API_USER || 'admin',
    apiPassword: env.FRPS_API_PASSWORD || '',
  },
};

function validate() {
  const errors = [];
  if (config.adminToken.length < 16) errors.push('ADMIN_TOKEN es obligatorio y debe tener al menos 16 caracteres');
  if (config.frps.tcpPortMin > config.frps.tcpPortMax) errors.push('FRPS_TCP_PORT_MIN no puede ser mayor que FRPS_TCP_PORT_MAX');
  return errors;
}

module.exports = { config, validate };
