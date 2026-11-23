'use strict';
// Pruebas unitarias del transporte de las máquinas hacia frps (tcp / websocket / wss).
// Uso:  node --test test/unidad/*.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const SRC = path.join(__dirname, '..', '..', 'api', 'src');
const M = require(path.join(SRC, 'machines.js'));
const I = require(path.join(SRC, 'installers.js'));

const machine = { id: 'cliente-equipo', name: 'Equipo', client: 'Cliente' };
const services = [{ name: 'web', type: 'http', local_ip: '127.0.0.1', local_port: 1880, subdomain: 'web-cliente-equipo' }];
const base = { publicAddr: 'frp.ejemplo.com', bindPort: 7000, authToken: '', subdomainHost: 'clientes.ejemplo.com' };
const token = 'TokenDePrueba_0123456789abcdefghijklmnop';

/** Carga config.js con un entorno propio (el módulo lee process.env al cargarse). */
function loadConfig(vars) {
  const file = path.join(SRC, 'config.js');
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) if (k.startsWith('FRPS_')) delete process.env[k];
  Object.assign(process.env, { ADMIN_TOKEN: 'x'.repeat(20) }, vars);
  delete require.cache[require.resolve(file)];
  try { return require(file); } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    delete require.cache[require.resolve(file)];
  }
}

const line = (toml, key) => toml.split('\n').find((l) => l.startsWith(key + ' ='));

test('por defecto: tcp directo al bindPort, sin transport.protocol', () => {
  const toml = M.frpcToml(machine, services, base, token);
  assert.equal(line(toml, 'serverAddr'), 'serverAddr = "frp.ejemplo.com"');
  assert.equal(line(toml, 'serverPort'), 'serverPort = 7000');
  assert.equal(line(toml, 'transport.protocol'), undefined);
});

test('wss: puerto de cliente 443 y transport.protocol = "wss"', () => {
  const frps = { ...base, clientTransport: 'wss', clientPort: 443 };
  const toml = M.frpcToml(machine, services, frps, token);
  assert.equal(line(toml, 'serverPort'), 'serverPort = 443');
  assert.equal(line(toml, 'transport.protocol'), 'transport.protocol = "wss"');
  // los latidos se conservan: el hub los usa para expulsar máquinas
  assert.equal(line(toml, 'transport.heartbeatInterval'), 'transport.heartbeatInterval = 15');
});

test('websocket sin TLS: usa el bindPort salvo que se indique otro puerto', () => {
  const toml = M.frpcToml(machine, services, { ...base, clientTransport: 'websocket', clientPort: 7000 }, token);
  assert.equal(line(toml, 'serverPort'), 'serverPort = 7000');
  assert.equal(line(toml, 'transport.protocol'), 'transport.protocol = "websocket"');
});

test('con otra dirección (LAN/ZeroTier) la máquina va directo: tcp al bindPort', () => {
  const frps = { ...base, clientTransport: 'wss', clientPort: 443 };
  const toml = M.frpcToml(machine, services, frps, token, { serverAddr: '192.168.2.37' });
  assert.equal(line(toml, 'serverAddr'), 'serverAddr = "192.168.2.37"');
  assert.equal(line(toml, 'serverPort'), 'serverPort = 7000');
  assert.equal(line(toml, 'transport.protocol'), undefined);
});

test('clientEndpoint: etiqueta legible para los mensajes de los instaladores', () => {
  const frps = { ...base, clientTransport: 'wss', clientPort: 443 };
  assert.equal(M.clientEndpoint(frps).label, 'wss://frp.ejemplo.com:443');
  assert.equal(M.clientEndpoint(frps, '10.147.19.123').label, '10.147.19.123:7000');
  assert.equal(M.clientEndpoint(base).label, 'frp.ejemplo.com:7000');
});

test('instaladores Linux y Windows: llevan wss y lo anuncian', () => {
  const frps = { ...base, clientTransport: 'wss', clientPort: 443 };
  const sh = I.PLATFORMS.linux.build(machine, services, frps, token, frps.publicAddr);
  assert.match(sh, /^SERVER="wss:\/\/frp\.ejemplo\.com:443"$/m);
  assert.match(sh, /^transport\.protocol = "wss"$/m);
  const ps = I.PLATFORMS.windows.build(machine, services, frps, token, frps.publicAddr);
  assert.match(ps, /^\$Server\s+= "wss:\/\/frp\.ejemplo\.com:443"$/m);
  assert.match(ps, /^transport\.protocol = "wss"$/m);
});

test('config: wss toma el 443 por defecto; tcp conserva el bindPort', () => {
  assert.deepEqual(
    (({ clientTransport, clientPort }) => ({ clientTransport, clientPort }))(loadConfig({ FRPS_CLIENT_TRANSPORT: 'WSS' }).config.frps),
    { clientTransport: 'wss', clientPort: 443 });
  const tcp = loadConfig({ FRPS_BIND_PORT: '7100' }).config.frps;
  assert.equal(tcp.clientTransport, 'tcp');
  assert.equal(tcp.clientPort, 7100);
  assert.equal(loadConfig({ FRPS_CLIENT_TRANSPORT: 'wss', FRPS_CLIENT_PORT: '8443' }).config.frps.clientPort, 8443);
});

test('config: rechaza transportes y puertos inválidos', () => {
  assert.ok(loadConfig({ FRPS_CLIENT_TRANSPORT: 'quic' }).validate().some((e) => e.includes('FRPS_CLIENT_TRANSPORT')));
  assert.ok(loadConfig({ FRPS_CLIENT_PORT: '70000' }).validate().some((e) => e.includes('FRPS_CLIENT_PORT')));
  assert.deepEqual(loadConfig({ FRPS_CLIENT_TRANSPORT: 'wss' }).validate(), []);
});
