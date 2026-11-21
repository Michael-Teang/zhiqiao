'use strict';
// memory.js — persistent handoff memory shared by all AI clients.
//
// A client can call memory_save before it finishes; the next AI can call
// memory_search / memory_get to read the same notes. Records live in the app
// data directory so they survive app restarts.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { getConfig, getConfigDir } = require('./config.js');

const MAX_RECORDS = 500;
const MAX_CONTENT = 200000;

function now() { return Date.now(); }

class MemoryStore extends EventEmitter {
  constructor() {
    super();
    this.file = path.join(getConfigDir(), 'memory.json');
    this.records = [];
    this._load();
  }

  _load() {
    try {
      if (!fs.existsSync(this.file)) return;
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(raw)) this.records = raw.filter((r) => r && r.id && r.title).slice(-MAX_RECORDS);
    } catch (e) {
      console.error('[memory] load failed:', e.message);
    }
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.records, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error('[memory] save failed:', e.message);
    }
  }

  list(query, limit) {
    const q = String(query || '').trim().toLowerCase();
    const cap = Math.min(Math.max(Number(limit) || 20, 1), 100);
    let rows = this.records.slice();
    if (q) {
      rows = rows.filter((r) => {
        const hay = [r.title, r.summary, r.content, ...(r.tags || [])].join('\n').toLowerCase();
        return hay.indexOf(q) >= 0;
      });
    }
    return rows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, cap).map((r) => ({
      id: r.id,
      title: r.title,
      summary: r.summary,
      tags: r.tags || [],
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      source: r.source || {},
      chars: String(r.content || '').length
    }));
  }

  get(id) {
    const r = this.records.find((x) => x.id === id);
    return r ? Object.assign({}, r) : null;
  }

  save(input) {
    const title = String((input && input.title) || '').trim().slice(0, 160);
    if (!title) throw new Error('title is required');
    const content = String((input && input.content) || '').slice(0, MAX_CONTENT);
    const summary = String((input && input.summary) || content.slice(0, 500)).slice(0, 2000);
    const tags = Array.isArray(input && input.tags)
      ? input.tags.map((x) => String(x).trim()).filter(Boolean).slice(0, 20)
      : [];
    const source = (input && input.source && typeof input.source === 'object') ? input.source : {};
    const existing = input && input.id ? this.records.find((x) => x.id === input.id) : null;
    const t = now();
    let rec;
    if (existing) {
      rec = existing;
      rec.title = title;
      rec.summary = summary;
      rec.content = content;
      rec.tags = tags;
      rec.source = source;
      rec.updatedAt = t;
    } else {
      rec = {
        id: 'mem_' + crypto.randomUUID(),
        title,
        summary,
        content,
        tags,
        source,
        createdAt: t,
        updatedAt: t
      };
      this.records.push(rec);
    }
    while (this.records.length > MAX_RECORDS) this.records.shift();
    this._save();
    this.emit('changed', this.list('', 50));
    return Object.assign({}, rec);
  }

  remove(id) {
    const i = this.records.findIndex((x) => x.id === id);
    if (i < 0) return false;
    this.records.splice(i, 1);
    this._save();
    this.emit('changed', this.list('', 50));
    return true;
  }

  clear() {
    this.records = [];
    this._save();
    this.emit('changed', []);
  }

  stats() {
    return { count: this.records.length, max: MAX_RECORDS, file: this.file };
  }
}

module.exports = { MemoryStore };
