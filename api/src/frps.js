'use strict';
// Lectura del estado en vivo desde la API del dashboard de frps (webServer).
// Endpoints usados (frp v0.71): /api/serverinfo, /api/clients, /api/proxy/{http,https,tcp,stcp}

const CACHE_MS = 3000;

class FrpsClient {
  constructor({ apiUrl, apiUser, apiPassword }) {
    this.apiUrl = apiUrl;
    this.auth = apiPassword ? 'Basic ' + Buffer.from(`${apiUser}:${apiPassword}`).toString('base64') : null;
    this.cache = null;
    this.cacheAt = 0;
    this.inflight = null;
  }

  async get(path) {
    const headers = this.auth ? { authorization: this.auth } : {};
    const res = await fetch(this.apiUrl + path, { headers, signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`frps ${path} respondió ${res.status}`);
    return res.json();
  }

  /** Devuelve { reachable, server, clients: Map<user, client>, proxies: Map<name, proxy> } */
  async status() {
    if (this.cache && Date.now() - this.cacheAt < CACHE_MS) return this.cache;
    if (this.inflight) return this.inflight;
    this.inflight = this.#load().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  async #load() {
    let result;
    try {
      const [server, clients, http, https, tcp, stcp] = await Promise.all([
        this.get('/api/serverinfo'),
        this.get('/api/clients'),
        this.get('/api/proxy/http'),
        this.get('/api/proxy/https'),
        this.get('/api/proxy/tcp'),
        this.get('/api/proxy/stcp'),
      ]);
      const clientMap = new Map();
      for (const c of Array.isArray(clients) ? clients : []) {
        if (c.online !== false) clientMap.set(c.user, c);
      }
      const proxyMap = new Map();
      for (const list of [http, https, tcp, stcp]) {
        for (const p of list?.proxies || []) proxyMap.set(p.name, p);
      }
      result = { reachable: true, error: null, server, clients: clientMap, proxies: proxyMap };
    } catch (err) {
      const code = err.cause?.code || (err.name === 'TimeoutError' ? 'TIMEOUT' : null);
      const msg = code ? `la API de frps no responde en ${this.apiUrl} (${code})` : err.message;
      result = { reachable: false, error: msg, server: null, clients: new Map(), proxies: new Map() };
    }
    this.cache = result;
    this.cacheAt = Date.now();
    return result;
  }

  invalidate() { this.cacheAt = 0; }
}

module.exports = { FrpsClient };
