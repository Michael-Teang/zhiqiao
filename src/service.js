'use strict';
// service.js — HTTP server and tunnel manager (CommonJS).
// Includes an OAuth 2.1 authorization server so clients that require the OAuth flow
// (ChatGPT connectors) can obtain a token, while plain bearer headers keep working.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');

const { getConfig } = require('./config.js');
const { handleMessage, createSession } = require('./mcp.js');
const oauth = require('./oauth.js');

class Bridge extends EventEmitter {
  constructor(opts) {
    super();
    this.server = null;
    this.tunnel = null;
    this.cloudflaredPath = (opts && opts.cloudflaredPath) || '';
    this.state = {
      running: false,
      port: null,
      tunnel: { state: 'stopped', url: null, error: null },
      startedAt: null,
      requests: 0,
      toolCalls: 0,
      lastCall: null
    };
  }

  // ------------------------------------------------------------- lifecycle

  async start() {
    if (this.server) return this.status();
    const cfg = getConfig();

    const server = http.createServer((req, res) => this._handle(req, res, cfg.token));

    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(cfg.port, cfg.host, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });

    this.server = server;
    const addr = server.address();

    this.state.running = true;
    this.state.port = addr.port;
    this.state.startedAt = Date.now();
    this._emitStatus();

    if (cfg.autoStartTunnel) this.startTunnel();

    return this.status();
  }

  async stop() {
    this.stopTunnel();
    if (this.server) {
      const s = this.server;
      this.server = null;
      await new Promise((resolve) => {
        try { s.close(() => resolve()); } catch (e) { resolve(); }
      });
    }
    this.state.running = false;
    this.state.port = null;
    this.state.startedAt = null;
    this._emitStatus();
  }

  status() {
    const cfg = getConfig();
    const tunnelUrl = this.state.tunnel.url;
    return Object.assign({}, this.state, {
      token: cfg.token,
      allowedRoots: cfg.allowedRoots,
      allowExec: cfg.allowExec,
      localUrl: this.state.port ? 'http://' + cfg.host + ':' + this.state.port + '/mcp' : null,
      publicUrl: tunnelUrl ? tunnelUrl.replace(/\/$/, '') + '/mcp' : null
    });
  }

  _emitStatus() {
    this.emit('status', this.status());
  }

  // ---------------------------------------------------------------- tunnel

  findCloudflared() {
    // Windows ships cloudflared.exe; macOS and Linux ship a bare "cloudflared".
    // macOS also gets an arch-specific name so a single bundle can carry both.
    const isWin = process.platform === 'win32';
    const names = isWin
      ? ['cloudflared.exe']
      : ['cloudflared', 'cloudflared-arm64', 'cloudflared-x64', 'cloudflared-amd64'];
    if (!isWin) {
      if (process.arch === 'arm64') names.unshift('cloudflared-arm64');
      else names.unshift('cloudflared-x64', 'cloudflared-amd64');
    }

    const roots = [
      this.cloudflaredPath,
      getConfig().cloudflaredPath,
      process.resourcesPath || null,
      path.join(__dirname, '..'),
      path.join(__dirname, '..', 'assets')
    ].filter(Boolean);

    const candidates = [];
    for (const root of roots) {
      // a full path was supplied directly
      if (names.some((n) => root.endsWith(n))) {
        candidates.push(root);
        continue;
      }
      for (const n of names) candidates.push(path.join(root, n));
    }

    candidates.push(
      'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
      'C:\\Program Files\\cloudflared\\cloudflared.exe',
      '/opt/homebrew/bin/cloudflared',
      '/usr/local/bin/cloudflared',
      '/usr/bin/cloudflared',
      '/opt/local/bin/cloudflared'
    );

    for (const c of candidates) {
      try {
        if (!fs.existsSync(c)) continue;
        this._ensureExecutable(c);
        return c;
      } catch (e) {}
    }
    return null;
  }

  /** macOS/Linux need the exec bit; a zip extracted on another OS may lack it. */
  _ensureExecutable(bin) {
    if (process.platform === 'win32') return;
    try {
      fs.accessSync(bin, fs.constants.X_OK);
    } catch (e) {
      try {
        fs.chmodSync(bin, 0o755);
      } catch (err) {
        console.error('[tunnel] could not chmod ' + bin + ': ' + err.message);
      }
    }
  }

  startTunnel() {
    if (this.tunnel) return this.state.tunnel;
    if (!this.server) {
      this.state.tunnel = { state: 'error', url: null, error: '服务未启动' };
      this._emitStatus();
      return this.state.tunnel;
    }

    const bin = this.findCloudflared();
    if (!bin) {
      this.state.tunnel = {
        state: 'error', url: null,
        error: '找不到 cloudflared 组件，请把它放到程序目录或填写路径'
      };
      this._emitStatus();
      return this.state.tunnel;
    }

    this.state.tunnel = { state: 'starting', url: null, error: null };
    this._emitStatus();

    const child = spawn(bin, [
      'tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:' + this.state.port
    ], { windowsHide: true });

    this.tunnel = child;

    const self = this;
    const scan = (chunk) => {
      const text = chunk.toString('utf8');
      const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(text);
      if (m && !self.state.tunnel.url) {
        self.state.tunnel = { state: 'ready', url: m[0], error: null };
        self._emitStatus();
      }
    };

    child.stderr.on('data', scan);
    child.stdout.on('data', scan);

    child.on('error', (e) => {
      self.state.tunnel = { state: 'error', url: null, error: e.message };
      self._emitStatus();
    });

    child.on('exit', () => {
      self.tunnel = null;
      if (self.state.tunnel.state !== 'stopped') {
        self.state.tunnel = { state: 'stopped', url: null, error: null };
        self._emitStatus();
      }
    });

    return this.state.tunnel;
  }

  stopTunnel() {
    if (this.tunnel) {
      try { this.tunnel.kill(); } catch (e) {}
      this.tunnel = null;
    }
    this.state.tunnel = { state: 'stopped', url: null, error: null };
    this._emitStatus();
  }

  // ---------------------------------------------------------------- helpers

  _authorized(req, token) {
    const h = req.headers['authorization'] || '';
    const m = /^Bearer\s+(.+)$/i.exec(h);
    if (!m) return false;
    const a = Buffer.from(m[1].trim());
    const b = Buffer.from(String(token));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  async _readBody(req, limit) {
    const cap = limit || 8 * 1024 * 1024;
    return await new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > cap) { reject(new Error('body too large')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  _json(res, status, body, extra) {
    const buf = Buffer.from(JSON.stringify(body), 'utf8');
    res.writeHead(status, Object.assign({
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(buf.length),
      'cache-control': 'no-store',
      'access-control-allow-origin': '*'
    }, extra || {}));
    res.end(buf);
  }

  _html(res, status, body) {
    const buf = Buffer.from(body, 'utf8');
    res.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': String(buf.length),
      'cache-control': 'no-store'
    });
    res.end(buf);
  }

  _redirect(res, location) {
    res.writeHead(302, { location: location, 'cache-control': 'no-store' });
    res.end();
  }

  // ---------------------------------------------------------------- router

  async _handle(req, res, token) {
    const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
    const pathname = url.pathname;

    const json = (r, s, b, e) => this._json(r, s, b, e);
    const html = (r, s, b) => this._html(r, s, b);
    const redirect = (r, loc) => this._redirect(r, loc);

    // ---- CORS preflight (some clients probe first) ----
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'authorization, content-type, mcp-session-id, accept',
        'access-control-max-age': '86400'
      });
      return res.end();
    }

    // ---- public endpoints ----
    if (pathname === '/healthz') {
      return json(res, 200, { ok: true, uptime: process.uptime() });
    }

    if (oauth.handleMetadata(req, res, pathname, json) !== false) return;

    if (pathname === '/register' && req.method === 'POST') {
      let body = '';
      try { body = await this._readBody(req); } catch (e) {}
      return oauth.handleRegister(req, res, body, json);
    }

    if (pathname === '/authorize') {
      if (req.method === 'GET') {
        return oauth.handleAuthorizeGet(req, res, url, html);
      }
      if (req.method === 'POST') {
        let body = '';
        try { body = await this._readBody(req); } catch (e) {}
        const form = Object.fromEntries(new URLSearchParams(body));
        return oauth.handleAuthorizePost(req, res, form, html, redirect);
      }
      return json(res, 405, { error: 'method not allowed' });
    }

    if (pathname === '/token' && req.method === 'POST') {
      let body = '';
      try { body = await this._readBody(req); } catch (e) {}
      return oauth.handleToken(req, res, body, json);
    }

    // ---- everything below needs a bearer token ----
    if (!this._authorized(req, token)) {
      const base = oauth.baseUrl(req);
      res.writeHead(401, {
        'content-type': 'application/json',
        'www-authenticate':
          'Bearer realm="mcp", resource_metadata="' + base + '/.well-known/oauth-protected-resource"'
      });
      return res.end(JSON.stringify({ error: 'unauthorized' }));
    }

    if (pathname === '/mcp' || pathname === '/mcp/') {
      if (req.method === 'GET') {
        const sid = createSession();
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
          'mcp-session-id': sid
        });
        res.write('event: endpoint\ndata: /mcp/\n\n');
        const timer = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 25000);
        req.on('close', () => clearInterval(timer));
        return;
      }

      if (req.method !== 'POST') return json(res, 405, { error: 'use POST' });

      let payload;
      try {
        payload = JSON.parse(await this._readBody(req));
      } catch (e) {
        return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: e.message } });
      }

      const batch = Array.isArray(payload) ? payload : [payload];
      const out = [];
      for (const msg of batch) {
        const r = await handleMessage(msg, { allowedRoots: getConfig().allowedRoots });
        if (r) out.push(r);
      }

      this.state.requests++;
      const call = batch.find((m) => m && m.method === 'tools/call');
      if (call) {
        this.state.toolCalls++;
        this.state.lastCall = { tool: (call.params && call.params.name) || '?', at: Date.now() };
        this.emit('activity', this.state.lastCall);
      }

      if (!out.length) { res.writeHead(202); return res.end(); }
      return json(res, 200, Array.isArray(payload) ? out : out[0], {
        'mcp-session-id': createSession()
      });
    }

    return json(res, 404, { error: 'not found', paths: ['/mcp', '/healthz'] });
  }
}

module.exports = { Bridge };
