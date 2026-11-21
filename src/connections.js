'use strict';
// connections.js — device connection approval and history.
//
// The bridge asks this manager about every MCP request. A new client (IP + UA)
// gets a pending record and the HTTP request is held until the user approves it
// in the panel or the 3-minute window expires. Approved devices are remembered
// until the public address or SSH key changes, at which point reset() clears them.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { getConfig, getConfigDir } = require('./config.js');

const MAX_RECORDS = 200;

function now() { return Date.now(); }

function normalizeIp(value) {
  let ip = String(value || '').trim();
  if (!ip) return '';
  ip = ip.replace(/^::ffff:/i, '');
  if (ip === '::1') return '127.0.0.1';
  return ip;
}

function requestIp(req) {
  const h = req.headers || {};
  const cf = h['cf-connecting-ip'];
  if (cf) return normalizeIp(cf);
  const xff = String(h['x-forwarded-for'] || '').split(',')[0].trim();
  if (xff) return normalizeIp(xff);
  if (h['x-real-ip']) return normalizeIp(h['x-real-ip']);
  return normalizeIp(req.socket && req.socket.remoteAddress);
}

function isLocalIp(ip) {
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost' || ip === '';
}

function uaLabel(ua) {
  const s = String(ua || '');
  if (!s) return '未知客户端';
  if (/ChatGPT/i.test(s)) return 'ChatGPT';
  if (/Claude/i.test(s)) return 'Claude';
  if (/Cursor/i.test(s)) return 'Cursor';
  if (/Electron/i.test(s)) return 'Electron 客户端';
  if (/node/i.test(s)) return 'Node 客户端';
  if (/curl/i.test(s)) return 'curl';
  return s.slice(0, 60);
}

class ConnectionManager extends EventEmitter {
  constructor(opts) {
    super();
    this.timeoutMs = Number(opts && opts.timeoutMs) || Number(getConfig().approvalTimeoutMs) || 180000;
    this.file = path.join(getConfigDir(), 'connections.json');
    this.records = [];
    this.waiters = new Map(); // id -> { resolvers: [], timer }
    this.sse = new Map(); // id -> Set<ServerResponse>
    this._load();
  }

  _load() {
    try {
      if (!fs.existsSync(this.file)) return;
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!Array.isArray(raw)) return;
      this.records = raw.filter((r) => r && typeof r.id === 'string' && typeof r.clientKey === 'string')
        .slice(-MAX_RECORDS)
        .map((r) => {
          // A pending request cannot survive a process restart.
          if (r.status === 'pending') return Object.assign({}, r, { status: 'expired', updatedAt: now() });
          return r;
        });
      this._consolidate();
      this._save();
    } catch (e) {
      console.error('[connections] load failed:', e.message);
    }
  }

  /** Old versions keyed records by IP+UA; collapse those duplicates into one per client UA. */
  _consolidate() {
    const byUa = new Map();
    const out = [];
    for (const r of this.records) {
      if (r.status === 'approved' && r.userAgent) {
        const key = 'ua:' + r.userAgent;
        if (byUa.has(key)) {
          const base = byUa.get(key);
          base.requestCount = (base.requestCount || 0) + (r.requestCount || 0);
          base.toolCalls = (base.toolCalls || 0) + (r.toolCalls || 0);
          base.lastSeenAt = Math.max(base.lastSeenAt || 0, r.lastSeenAt || 0);
          base.lastTool = base.lastTool || r.lastTool;
          continue;
        }
        r.clientKey = crypto.createHash('sha256').update(key).digest('hex').slice(0, 32);
        byUa.set(key, r);
      }
      out.push(r);
    }
    this.records = out.slice(-MAX_RECORDS);
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.records, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error('[connections] save failed:', e.message);
    }
  }

  list() {
    const order = { pending: 0, approved: 1, blocked: 2, denied: 3, expired: 4 };
    return this.records.slice().sort((a, b) => {
      const d = (order[a.status] ?? 9) - (order[b.status] ?? 9);
      if (d) return d;
      return (b.lastSeenAt || b.createdAt || 0) - (a.lastSeenAt || a.createdAt || 0);
    }).map((r) => Object.assign({}, r));
  }

  pendingCount() {
    return this.records.filter((r) => r.status === 'pending').length;
  }

  get(id) {
    return this.records.find((r) => r.id === id) || null;
  }

  _info(req, clientInfo) {
    const ip = requestIp(req);
    const ua = String((req.headers && req.headers['user-agent']) || '').slice(0, 500);
    const host = String((req.headers && req.headers.host) || '').split(':')[0].toLowerCase();
    const localHost = !host || host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
    const name = (clientInfo && (clientInfo.name || clientInfo.title))
      ? String(clientInfo.name || clientInfo.title).slice(0, 80)
      : uaLabel(ua);
    // Approve per MCP client, not per edge IP. OpenAI / Cloudflare can issue
    // requests from a different egress IP for every tool call; including the
    // IP here caused a new approval prompt for every call.
    const identity = ua ? ('ua:' + ua) : ('name:' + name);
    const clientKey = crypto.createHash('sha256').update(identity).digest('hex').slice(0, 32);
    return { ip, ua, name, clientKey, local: isLocalIp(ip) && localHost };
  }

  _touch(record) {
    record.lastSeenAt = now();
    record.requestCount = (record.requestCount || 0) + 1;
    record.updatedAt = now();
  }

  _newRecord(info) {
    const t = now();
    return {
      id: 'conn_' + crypto.randomUUID(),
      clientKey: info.clientKey,
      name: info.name,
      ip: info.ip,
      userAgent: info.ua,
      local: !!info.local,
      status: 'pending',
      createdAt: t,
      updatedAt: t,
      approvedAt: null,
      lastSeenAt: t,
      expiresAt: t + this.timeoutMs,
      requestCount: 1,
      toolCalls: 0,
      lastTool: null
    };
  }

  _resolveWaiters(record, result) {
    const w = this.waiters.get(record.id);
    if (!w) return;
    clearTimeout(w.timer);
    this.waiters.delete(record.id);
    for (const resolve of w.resolvers) resolve(result);
  }

  _wait(record, resolve) {
    let w = this.waiters.get(record.id);
    if (!w) {
      const timer = setTimeout(() => {
        const rec = this.get(record.id);
        if (rec && rec.status === 'pending') {
          rec.status = 'expired';
          rec.updatedAt = now();
          this._save();
          this.emit('changed', Object.assign({}, rec));
          this._resolveWaiters(rec, {
            allowed: false,
            record: Object.assign({}, rec),
            reason: 'expired',
            message: '3 分钟内未确认，请重新发起连接'
          });
        }
      }, this.timeoutMs);
      if (timer.unref) timer.unref();
      w = { resolvers: [], timer };
      this.waiters.set(record.id, w);
    }
    w.resolvers.push(resolve);
  }

  async authorize(req, clientInfo) {
    const info = this._info(req, clientInfo);

    if (info.local) {
      let rec = this.records.find((r) => r.clientKey === info.clientKey);
      if (!rec) {
        rec = this._newRecord(info);
        rec.status = 'approved';
        rec.approvedAt = now();
        rec.expiresAt = null;
        this.records.push(rec);
      }
      rec.status = 'approved';
      rec.approvedAt = rec.approvedAt || now();
      rec.expiresAt = null;
      this._touch(rec);
      this._save();
      return { allowed: true, record: Object.assign({}, rec) };
    }

    let rec = this.records.find((r) => r.clientKey === info.clientKey);

    if (rec && rec.status === 'approved') {
      rec.ip = info.ip || rec.ip;
      if (info.name && info.name !== uaLabel(info.ua)) rec.name = info.name;
      this._touch(rec);
      this._save();
      this.emit('changed', Object.assign({}, rec));
      return { allowed: true, record: Object.assign({}, rec) };
    }

    if (rec && rec.status === 'blocked') {
      this._touch(rec);
      this._save();
      return { allowed: false, record: Object.assign({}, rec), reason: 'blocked', message: '该设备已被断开，请在连接记录中重新允许' };
    }

    // Reuse an existing pending request; otherwise a retry after expiry/denial
    // becomes a brand new "request connection" event.
    if (rec && rec.status === 'pending' && rec.expiresAt > now()) {
      this._touch(rec);
      this._save();
    } else if (rec && rec.status === 'denied' && (now() - (rec.updatedAt || 0)) < 5000) {
      return { allowed: false, record: Object.assign({}, rec), reason: 'denied', message: '连接被拒绝，请稍后重新申请' };
    } else {
      if (rec) {
        rec.name = info.name || rec.name;
        rec.ip = info.ip || rec.ip;
        rec.userAgent = info.ua || rec.userAgent;
        rec.status = 'pending';
        rec.createdAt = now();
        rec.updatedAt = now();
        rec.expiresAt = now() + this.timeoutMs;
        rec.requestCount = 1;
        rec.toolCalls = 0;
        rec.lastTool = null;
      } else {
        rec = this._newRecord(info);
        this.records.push(rec);
      }
      while (this.records.length > MAX_RECORDS) this.records.shift();
      this._save();
      this.emit('request', Object.assign({}, rec));
      this.emit('changed', Object.assign({}, rec));
    }

    return await new Promise((resolve) => {
      this._wait(rec, resolve);
    });
  }

  approve(id) {
    const rec = this.get(id);
    if (!rec) return false;
    rec.status = 'approved';
    rec.approvedAt = now();
    rec.updatedAt = now();
    rec.expiresAt = null;
    this._save();
    this.emit('changed', Object.assign({}, rec));
    this._resolveWaiters(rec, { allowed: true, record: Object.assign({}, rec) });
    return true;
  }

  deny(id) {
    const rec = this.get(id);
    if (!rec) return false;
    rec.status = 'denied';
    rec.updatedAt = now();
    rec.expiresAt = null;
    this._save();
    this.emit('changed', Object.assign({}, rec));
    this._resolveWaiters(rec, { allowed: false, record: Object.assign({}, rec), reason: 'denied', message: '连接被拒绝' });
    return true;
  }

  block(id) {
    const rec = this.get(id);
    if (!rec) return false;
    rec.status = 'blocked';
    rec.updatedAt = now();
    this._save();
    this.emit('changed', Object.assign({}, rec));
    this._resolveWaiters(rec, { allowed: false, record: Object.assign({}, rec), reason: 'blocked', message: '连接已被断开' });
    const set = this.sse.get(id);
    if (set) {
      for (const res of set) {
        try { res.destroy(); } catch (e) {}
      }
      this.sse.delete(id);
    }
    return true;
  }

  unblock(id) {
    const rec = this.get(id);
    if (!rec) return false;
    rec.status = 'approved';
    rec.approvedAt = now();
    rec.updatedAt = now();
    this._save();
    this.emit('changed', Object.assign({}, rec));
    return true;
  }

  clear() {
    this.records = [];
    for (const [, w] of this.waiters) {
      clearTimeout(w.timer);
      for (const resolve of w.resolvers) resolve({ allowed: false, record: null, reason: 'cleared', message: '连接记录已清空' });
    }
    this.waiters.clear();
    for (const [, set] of this.sse) {
      for (const res of set) { try { res.destroy(); } catch (e) {} }
    }
    this.sse.clear();
    this._save();
    this.emit('reset', '手动清空');
  }

  reset(reason) {
    this.records = [];
    for (const [, w] of this.waiters) {
      clearTimeout(w.timer);
      for (const resolve of w.resolvers) resolve({ allowed: false, record: null, reason: 'reset', message: '连接记录已刷新，请重新发起连接' });
    }
    this.waiters.clear();
    for (const [, set] of this.sse) {
      for (const res of set) { try { res.destroy(); } catch (e) {} }
    }
    this.sse.clear();
    this._save();
    this.emit('reset', reason || '连接信息已变更');
  }

  registerSse(id, res) {
    let set = this.sse.get(id);
    if (!set) { set = new Set(); this.sse.set(id, set); }
    set.add(res);
    res.once('close', () => {
      set.delete(res);
      if (!set.size) this.sse.delete(id);
    });
  }

  noteTool(id, toolName) {
    const rec = this.get(id);
    if (!rec) return;
    rec.toolCalls = (rec.toolCalls || 0) + 1;
    rec.lastTool = String(toolName || '').slice(0, 80);
    rec.lastSeenAt = now();
    rec.updatedAt = now();
    this._save();
    this.emit('changed', Object.assign({}, rec));
  }
}

module.exports = { ConnectionManager, requestIp, isLocalIp };
