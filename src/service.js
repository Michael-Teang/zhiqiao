'use strict';
// service.js — HTTP server and tunnel manager (CommonJS).
// Includes an OAuth 2.1 authorization server so clients that require the OAuth flow
// (ChatGPT connectors) can obtain a token, while plain bearer headers keep working.
//
// Tunnel modes:
//   stable — SSH reverse tunnel with a key-bound permanent HTTPS URL (tunnl.gg).
//            The URL survives app restarts and reboots because it is derived from
//            the local SSH key, not from the tunnel process.
//   named  — Cloudflare Named Tunnel (token + your own hostname). Fixed hostname.
//   quick  — Cloudflare Quick Tunnel. Random URL every start; kept as fallback.

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');

const { getConfig, getStableKeyDir, updateConfig } = require('./config.js');
const { handleMessage, createSession } = require('./mcp.js');
const oauth = require('./oauth.js');

function normalizeBaseUrl(value) {
  if (!value) return '';
  let s = String(value).trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  return s;
}

class Bridge extends EventEmitter {
  constructor(opts) {
    super();
    this.server = null;
    this.tunnel = null;
    this.cloudflaredPath = (opts && opts.cloudflaredPath) || '';
    this._intentionalStop = false;
    this._reconnectTimer = null;
    this._keepaliveTimer = null;
    this._tunnelReadyTimer = null;
    this.state = {
      running: false,
      port: null,
      tunnel: { state: 'stopped', url: null, error: null, mode: null, claimUrl: null },
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

    const server = http.createServer((req, res) => this._handle(req, res));

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
    this._intentionalStop = true;
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
    const configured = this._configuredUrl(cfg);
    const active = this.state.tunnel.url || configured;
    return Object.assign({}, this.state, {
      token: cfg.token,
      allowedRoots: cfg.allowedRoots,
      allowExec: cfg.allowExec,
      localUrl: this.state.port ? 'http://' + cfg.host + ':' + this.state.port + '/mcp' : null,
      publicUrl: this._mcpUrl(active),
      savedPublicUrl: this._mcpUrl(configured),
      tunnelMode: cfg.tunnelMode,
      stableTunnelUrl: cfg.stableTunnelUrl || null,
      claimUrl: this.state.tunnel.claimUrl || null
    });
  }

  _mcpUrl(base) {
    const b = normalizeBaseUrl(base);
    return b ? b + '/mcp' : null;
  }

  _configuredUrl(cfg) {
    if (cfg.tunnelMode === 'named') {
      return cfg.namedTunnelHostname ? normalizeBaseUrl(cfg.namedTunnelHostname) : '';
    }
    if (cfg.tunnelMode === 'stable') {
      return cfg.stableTunnelUrl ? normalizeBaseUrl(cfg.stableTunnelUrl) : '';
    }
    return '';
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

  findSsh() {
    const candidates = process.platform === 'win32'
      ? [
          path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe'),
          'C:\\Windows\\System32\\OpenSSH\\ssh.exe'
        ]
      : ['/usr/bin/ssh', '/usr/local/bin/ssh'];
    for (const c of candidates) {
      try { if (fs.existsSync(c)) return c; } catch (e) {}
    }
    return 'ssh';
  }

  findSshKeygen() {
    const ssh = this.findSsh();
    if (path.isAbsolute(ssh)) {
      const gen = path.join(path.dirname(ssh), process.platform === 'win32' ? 'ssh-keygen.exe' : 'ssh-keygen');
      try { if (fs.existsSync(gen)) return gen; } catch (e) {}
    }
    return 'ssh-keygen';
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
      this.state.tunnel = { state: 'error', url: null, error: '服务未启动', mode: null, claimUrl: null };
      this._emitStatus();
      return this.state.tunnel;
    }

    this._intentionalStop = false;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;

    const cfg = getConfig();
    const mode = cfg.tunnelMode || 'quick';
    if (mode === 'stable') return this._startStableTunnel(cfg);
    if (mode === 'named') return this._startNamedTunnel(cfg);
    return this._startQuickTunnel(cfg);
  }

  // ---- stable SSH tunnel (tunnl.gg, key-bound fixed URL) ----

  _stableKeyPath() {
    const dir = getStableKeyDir();
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, 'tunnl_ed25519');
  }

  _ensureStableKey() {
    const keyPath = this._stableKeyPath();
    if (fs.existsSync(keyPath)) return keyPath;

    const gen = this.findSshKeygen();
    const r = spawnSync(gen, ['-t', 'ed25519', '-f', keyPath, '-N', '', '-C', 'zhiqiao-tunnl'], {
      windowsHide: true,
      encoding: 'utf8'
    });
    if (r.error) throw new Error('生成 SSH 密钥失败: ' + r.error.message);
    if (r.status !== 0) {
      throw new Error('生成 SSH 密钥失败: ' + String(r.stderr || r.stdout || '').trim());
    }
    return keyPath;
  }

  _startStableTunnel(cfg) {
    let keyPath;
    try {
      keyPath = this._ensureStableKey();
    } catch (e) {
      this.state.tunnel = { state: 'error', url: cfg.stableTunnelUrl || null, error: e.message, mode: 'stable', claimUrl: null };
      this._emitStatus();
      return this.state.tunnel;
    }

    const saved = cfg.stableTunnelUrl ? normalizeBaseUrl(cfg.stableTunnelUrl) : null;
    this.state.tunnel = { state: 'starting', url: saved, error: null, mode: 'stable', claimUrl: null };
    this._emitStatus();

    const ssh = this.findSsh();
    const knownHosts = path.join(getStableKeyDir(), 'known_hosts');
    const host = cfg.stableTunnelHost || 'proxy.tunnl.gg';
    const args = [
      '-tt',
      '-i', keyPath,
      '-o', 'IdentitiesOnly=yes',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'UserKnownHostsFile=' + knownHosts,
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=3',
      '-o', 'TCPKeepAlive=yes',
      '-R', '80:localhost:' + this.state.port,
      'stable@' + host
    ];

    const child = spawn(ssh, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    this.tunnel = child;

    let ready = false;
    const scan = (chunk) => {
      const text = chunk.toString('utf8');

      const claim = /https:\/\/tunnl\.gg\/dashboard\/claim\/[A-Za-z0-9?=&%._\-\/]+/i.exec(text);
      if (claim && this.state.tunnel.claimUrl !== claim[0]) {
        this.state.tunnel.claimUrl = claim[0];
        this._emitStatus();
      }

      const m = /https:\/\/[a-z0-9-]+\.tunnl\.gg/i.exec(text);
      if (m && !ready) {
        const url = normalizeBaseUrl(m[0]);
        ready = true;
        clearTimeout(this._tunnelReadyTimer);
        if (cfg.stableTunnelUrl !== url) updateConfig({ stableTunnelUrl: url });
        const claimUrl = this.state.tunnel.claimUrl || null;
        this.state.tunnel = { state: 'ready', url, error: null, mode: 'stable', claimUrl };
        this._startKeepalive(url);
        this._emitStatus();
      }
    };

    child.stdout.on('data', scan);
    child.stderr.on('data', scan);

    child.on('error', (e) => {
      clearTimeout(this._tunnelReadyTimer);
      this.tunnel = null;
      this.state.tunnel = {
        state: 'error',
        url: saved,
        error: 'SSH 隧道启动失败: ' + e.message,
        mode: 'stable',
        claimUrl: null
      };
      this._emitStatus();
      this._scheduleReconnect();
    });

    child.on('exit', () => {
      clearTimeout(this._tunnelReadyTimer);
      this._stopKeepalive();
      this.tunnel = null;
      if (this._intentionalStop) {
        this.state.tunnel = { state: 'stopped', url: saved, error: null, mode: 'stable', claimUrl: null };
        this._emitStatus();
        return;
      }
      this.state.tunnel = {
        state: 'starting',
        url: saved,
        error: '隧道连接已断开，正在自动重连（地址不变）',
        mode: 'stable',
        claimUrl: null
      };
      this._emitStatus();
      this._scheduleReconnect();
    });

    this._tunnelReadyTimer = setTimeout(() => {
      if (ready) return;
      try { child.kill(); } catch (e) {}
      this.state.tunnel = {
        state: 'error',
        url: saved,
        error: 'SSH 隧道连接超时，请检查网络后重试',
        mode: 'stable',
        claimUrl: null
      };
      this._emitStatus();
    }, 35000);

    return this.state.tunnel;
  }

  // ---- Cloudflare named tunnel (fixed hostname on user's own domain) ----

  _startNamedTunnel(cfg) {
    const hostname = (cfg.namedTunnelHostname || '').trim();
    const token = (cfg.namedTunnelToken || '').trim();
    if (!hostname || !token) {
      this.state.tunnel = {
        state: 'error',
        url: hostname ? normalizeBaseUrl(hostname) : null,
        error: '请先填写 Cloudflare 隧道 Token 和固定域名',
        mode: 'named',
        claimUrl: null
      };
      this._emitStatus();
      return this.state.tunnel;
    }

    const bin = this.findCloudflared();
    if (!bin) {
      this.state.tunnel = {
        state: 'error',
        url: normalizeBaseUrl(hostname),
        error: '找不到 cloudflared 组件，请把它放到程序目录或填写路径',
        mode: 'named',
        claimUrl: null
      };
      this._emitStatus();
      return this.state.tunnel;
    }

    const base = normalizeBaseUrl(hostname);
    this.state.tunnel = { state: 'starting', url: base, error: null, mode: 'named', claimUrl: null };
    this._emitStatus();

    const child = spawn(bin, ['tunnel', '--no-autoupdate', 'run', '--token', token], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    this.tunnel = child;

    let ready = false;
    const scan = (chunk) => {
      const text = chunk.toString('utf8');
      if (!ready && /Registered tunnel connection|Connection [^\n]*registered|Registered tunnel/i.test(text)) {
        ready = true;
        clearTimeout(this._tunnelReadyTimer);
        this.state.tunnel = { state: 'ready', url: base, error: null, mode: 'named', claimUrl: null };
        this._emitStatus();
      }
    };
    child.stdout.on('data', scan);
    child.stderr.on('data', scan);

    child.on('error', (e) => {
      clearTimeout(this._tunnelReadyTimer);
      this.tunnel = null;
      this.state.tunnel = {
        state: 'error', url: base, error: 'cloudflared 启动失败: ' + e.message, mode: 'named', claimUrl: null
      };
      this._emitStatus();
      this._scheduleReconnect();
    });

    child.on('exit', () => {
      clearTimeout(this._tunnelReadyTimer);
      this.tunnel = null;
      if (this._intentionalStop) {
        this.state.tunnel = { state: 'stopped', url: base, error: null, mode: 'named', claimUrl: null };
        this._emitStatus();
        return;
      }
      this.state.tunnel = {
        state: 'starting', url: base, error: '隧道连接已断开，正在自动重连（地址不变）', mode: 'named', claimUrl: null
      };
      this._emitStatus();
      this._scheduleReconnect();
    });

    // Some cloudflared builds do not print the exact "Registered" line; if the
    // process is still alive after 15s treat it as connected.
    this._tunnelReadyTimer = setTimeout(() => {
      if (ready || !this.tunnel) return;
      ready = true;
      this.state.tunnel = { state: 'ready', url: base, error: null, mode: 'named', claimUrl: null };
      this._emitStatus();
    }, 15000);

    return this.state.tunnel;
  }

  // ---- Cloudflare quick tunnel (random URL, fallback only) ----

  _startQuickTunnel(cfg) {
    const bin = this.findCloudflared();
    if (!bin) {
      this.state.tunnel = {
        state: 'error', url: null,
        error: '找不到 cloudflared 组件，请把它放到程序目录或填写路径',
        mode: 'quick', claimUrl: null
      };
      this._emitStatus();
      return this.state.tunnel;
    }

    this.state.tunnel = { state: 'starting', url: null, error: null, mode: 'quick', claimUrl: null };
    this._emitStatus();

    const child = spawn(bin, [
      'tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:' + this.state.port
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

    this.tunnel = child;

    const self = this;
    const scan = (chunk) => {
      const text = chunk.toString('utf8');
      const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(text);
      if (m && !self.state.tunnel.url) {
        self.state.tunnel = { state: 'ready', url: m[0], error: null, mode: 'quick', claimUrl: null };
        self._emitStatus();
      }
    };

    child.stderr.on('data', scan);
    child.stdout.on('data', scan);

    child.on('error', (e) => {
      self.state.tunnel = { state: 'error', url: null, error: e.message, mode: 'quick', claimUrl: null };
      self._emitStatus();
    });

    child.on('exit', () => {
      self.tunnel = null;
      if (self.state.tunnel.state !== 'stopped') {
        self.state.tunnel = { state: 'stopped', url: null, error: null, mode: 'quick', claimUrl: null };
        self._emitStatus();
      }
    });

    return this.state.tunnel;
  }

  _scheduleReconnect() {
    if (this._intentionalStop || this._reconnectTimer) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (!this._intentionalStop && !this.tunnel) this.startTunnel();
    }, 5000);
  }

  _startKeepalive(baseUrl) {
    this._stopKeepalive();
    // tunnl.gg closes idle tunnels after 2h; a tiny health request every 5 min
    // keeps the same URL alive until the 24h connection cap, then we reconnect.
    this._keepaliveTimer = setInterval(() => {
      try {
        const req = https.get(baseUrl + '/healthz', { timeout: 10000 }, (res) => res.resume());
        req.on('error', () => {});
        req.on('timeout', () => { try { req.destroy(); } catch (e) {} });
      } catch (e) {}
    }, 5 * 60 * 1000);
    if (this._keepaliveTimer.unref) this._keepaliveTimer.unref();
  }

  _stopKeepalive() {
    if (this._keepaliveTimer) {
      clearInterval(this._keepaliveTimer);
      this._keepaliveTimer = null;
    }
  }

  stopTunnel() {
    this._intentionalStop = true;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
    clearTimeout(this._tunnelReadyTimer);
    this._tunnelReadyTimer = null;
    this._stopKeepalive();

    if (this.tunnel) {
      try { this.tunnel.kill(); } catch (e) {}
      this.tunnel = null;
    }
    const cfg = getConfig();
    const saved = this._configuredUrl(cfg) || null;
    this.state.tunnel = { state: 'stopped', url: saved, error: null, mode: cfg.tunnelMode, claimUrl: null };
    this._emitStatus();
  }

  /** Rotate the SSH key, which is the only operation that changes a stable URL. */
  rotateStableTunnel() {
    const cfg = getConfig();
    if (cfg.tunnelMode !== 'stable') return this.status();

    this.stopTunnel();

    const keyPath = this._stableKeyPath();
    const backup = keyPath + '.bak-' + Date.now();
    try {
      if (fs.existsSync(keyPath)) fs.renameSync(keyPath, backup);
      if (fs.existsSync(keyPath + '.pub')) fs.renameSync(keyPath + '.pub', backup + '.pub');
    } catch (e) {
      console.error('[tunnel] rotate key failed:', e.message);
    }

    updateConfig({ stableTunnelUrl: '' });
    this._intentionalStop = false;
    this.startTunnel();
    return this.status();
  }

  restartTunnel() {
    this.stopTunnel();
    this._intentionalStop = false;
    return this.startTunnel();
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

  async _handle(req, res) {
    const token = getConfig().token;
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
