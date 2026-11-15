'use strict';
// tools.js — the operations the AI can call (CommonJS).

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { getConfig } = require('./config.js');
const { assertAllowed, clip } = require('./pathsafe.js');

const TOOLS = [];

function tool(name, description, inputSchema, handler) {
  TOOLS.push({ name, description, inputSchema, handler });
}

// ---------------------------------------------------------------- filesystem

tool(
  'read_file',
  'Read a UTF-8 text file. Returns the content, or an error if it is binary or too large.',
  {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute path, or relative to an allowed root.' },
      maxBytes: { type: 'number', description: 'Optional cap on bytes returned.' }
    },
    required: ['path']
  },
  async (a) => {
    const abs = assertAllowed(a.path, { mustExist: true });
    const st = await fsp.stat(abs);
    if (st.isDirectory()) throw new Error('that path is a directory; use list_dir');
    const cap = Math.min(Number(a.maxBytes) || getConfig().maxOutputBytes, getConfig().maxOutputBytes);
    const fd = await fsp.open(abs, 'r');
    try {
      const len = Math.min(st.size, cap);
      const buf = Buffer.alloc(len);
      await fd.read(buf, 0, len, 0);
      if (buf.subarray(0, 8192).includes(0)) {
        throw new Error('refusing to return binary data (' + st.size + ' bytes)');
      }
      const text = buf.toString('utf8');
      return st.size > len
        ? text + '\n\n[truncated: file is ' + st.size + ' bytes, showed ' + len + ']'
        : text;
    } finally {
      await fd.close();
    }
  }
);

tool(
  'write_file',
  'Write text to a file, creating parent directories as needed. Overwrites by default.',
  {
    type: 'object',
    properties: {
      path: { type: 'string' },
      content: { type: 'string' },
      append: { type: 'boolean', description: 'Append instead of overwrite.' }
    },
    required: ['path', 'content']
  },
  async (a) => {
    const abs = assertAllowed(a.path);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    if (a.append) await fsp.appendFile(abs, String(a.content), 'utf8');
    else await fsp.writeFile(abs, String(a.content), 'utf8');
    const st = await fsp.stat(abs);
    return (a.append ? 'appended to ' : 'wrote ') + abs + ' (' + st.size + ' bytes)';
  }
);

tool(
  'list_dir',
  'List the entries of a directory with type and size.',
  {
    type: 'object',
    properties: {
      path: { type: 'string' },
      recursive: { type: 'boolean', description: 'Walk subdirectories (depth 3).' }
    },
    required: ['path']
  },
  async (a) => {
    const abs = assertAllowed(a.path, { mustExist: true });
    const lines = [];
    const walk = async (dir, depth) => {
      if (depth > 3) return;
      const items = await fsp.readdir(dir, { withFileTypes: true });
      items.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
      for (const it of items) {
        const full = path.join(dir, it.name);
        const rel = path.relative(abs, full) || it.name;
        if (it.isDirectory()) {
          lines.push('[dir ] ' + rel + '/');
          if (a.recursive) await walk(full, depth + 1);
        } else {
          let size = 0;
          try { size = (await fsp.stat(full)).size; } catch (e) {}
          lines.push('[file] ' + rel + '  ' + size + ' bytes');
        }
      }
    };
    await walk(abs, 0);
    return lines.join('\n') || '(empty)';
  }
);

tool(
  'search_files',
  'Search file contents with a regular expression. Skips binaries and node_modules.',
  {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'JavaScript regular expression.' },
      path: { type: 'string', description: 'Directory to search.' },
      glob: { type: 'string', description: 'Only files whose name matches, e.g. "*.js".' },
      limit: { type: 'number', description: 'Max matching lines (default 100).' }
    },
    required: ['pattern', 'path']
  },
  async (a) => {
    const root = assertAllowed(a.path, { mustExist: true });
    let re;
    try { re = new RegExp(a.pattern, 'g'); } catch (e) { throw new Error('bad regex: ' + e.message); }
    const cap = Math.min(Number(a.limit) || 100, 500);
    const nameRe = a.glob
      ? new RegExp('^' + a.glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$')
      : null;
    const hits = [];

    const walk = async (dir) => {
      if (hits.length >= cap) return;
      let items;
      try { items = await fsp.readdir(dir, { withFileTypes: true }); } catch (e) { return; }
      for (const it of items) {
        if (hits.length >= cap) return;
        if (it.name === 'node_modules' || it.name === '.git') continue;
        const full = path.join(dir, it.name);
        if (it.isDirectory()) { await walk(full); continue; }
        if (nameRe && !nameRe.test(it.name)) continue;
        let buf;
        try {
          const st = await fsp.stat(full);
          if (st.size > 2000000) continue;
          buf = await fsp.readFile(full);
        } catch (e) { continue; }
        if (buf.subarray(0, 8192).includes(0)) continue;
        const lines = buf.toString('utf8').split('\n');
        for (let i = 0; i < lines.length && hits.length < cap; i++) {
          re.lastIndex = 0;
          if (re.test(lines[i])) {
            hits.push(path.relative(root, full) + ':' + (i + 1) + ': ' + lines[i].slice(0, 240));
          }
        }
      }
    };
    await walk(root);
    return hits.length ? hits.join('\n') : 'no matches';
  }
);

tool(
  'file_info',
  'Stat a path: type, size, timestamps.',
  { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  async (a) => {
    const abs = assertAllowed(a.path, { mustExist: true });
    const st = await fsp.stat(abs);
    return JSON.stringify({
      path: abs,
      type: st.isDirectory() ? 'directory' : st.isFile() ? 'file' : 'other',
      size: st.size,
      created: st.birthtime.toISOString(),
      modified: st.mtime.toISOString()
    }, null, 2);
  }
);

// ------------------------------------------------------------------- shell

function isDenied(cmd) {
  const lower = String(cmd).toLowerCase();
  return (getConfig().execDeniedPatterns || []).some((pat) => lower.includes(String(pat).toLowerCase()));
}

tool(
  'run_command',
  'Run a shell command and return stdout, stderr and the exit code. Disabled unless allowExec is true.',
  {
    type: 'object',
    properties: {
      command: { type: 'string' },
      cwd: { type: 'string', description: 'Working directory (must be inside an allowed root).' },
      timeoutMs: { type: 'number' }
    },
    required: ['command']
  },
  async (a) => {
    const cfg = getConfig();
    if (!cfg.allowExec) throw new Error('command execution is disabled (allowExec=false)');
    if (isDenied(a.command)) throw new Error('that command is on the deny list');

    const dir = a.cwd ? assertAllowed(a.cwd) : cfg.allowedRoots[0];
    const timeout = Math.min(Number(a.timeoutMs) || cfg.execTimeoutMs, 300000);
    const isWin = process.platform === 'win32';
    const shell = isWin ? 'powershell.exe' : '/bin/sh';
    const args = isWin
      ? ['-NoProfile', '-NonInteractive', '-Command', String(a.command)]
      : ['-c', String(a.command)];

    return await new Promise((resolve) => {
      const child = spawn(shell, args, { cwd: dir, windowsHide: true });
      let out = '';
      let err = '';
      let killed = false;

      const timer = setTimeout(() => {
        killed = true;
        try { child.kill('SIGKILL'); } catch (e) {}
      }, timeout);

      child.stdout.on('data', (d) => { out += d.toString('utf8'); });
      child.stderr.on('data', (d) => { err += d.toString('utf8'); });

      child.on('error', (e) => {
        clearTimeout(timer);
        resolve('spawn failed: ' + e.message);
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        const parts = [];
        if (out) parts.push('--- stdout ---\n' + clip(out));
        if (err) parts.push('--- stderr ---\n' + clip(err));
        parts.push('--- exit code: ' + code + (killed ? ' (timed out)' : '') + ' ---');
        resolve(parts.join('\n'));
      });
    });
  }
);

// ------------------------------------------------------------------ system

tool(
  'system_info',
  'Basic facts about the machine running this bridge.',
  { type: 'object', properties: {} },
  async () => JSON.stringify({
    hostname: os.hostname(),
    platform: process.platform,
    release: os.release(),
    arch: os.arch(),
    cpus: os.cpus().length,
    totalMemMB: Math.round(os.totalmem() / 1048576),
    freeMemMB: Math.round(os.freemem() / 1048576),
    uptimeHours: Math.round(os.uptime() / 3600),
    cwd: process.cwd(),
    allowedRoots: getConfig().allowedRoots
  }, null, 2)
);

tool(
  'make_dir',
  'Create a directory and any missing parents.',
  { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  async (a) => {
    const abs = assertAllowed(a.path);
    await fsp.mkdir(abs, { recursive: true });
    return 'created ' + abs;
  }
);

tool(
  'move_path',
  'Move or rename a file or directory.',
  {
    type: 'object',
    properties: { from: { type: 'string' }, to: { type: 'string' } },
    required: ['from', 'to']
  },
  async (a) => {
    const from = assertAllowed(a.from, { mustExist: true });
    const to = assertAllowed(a.to);
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.rename(from, to);
    return from + ' -> ' + to;
  }
);

tool(
  'delete_path',
  'Delete a file, or a directory when recursive is true.',
  {
    type: 'object',
    properties: { path: { type: 'string' }, recursive: { type: 'boolean' } },
    required: ['path']
  },
  async (a) => {
    const abs = assertAllowed(a.path, { mustExist: true });
    const st = await fsp.stat(abs);
    if (st.isDirectory()) {
      if (!a.recursive) throw new Error('that is a directory; pass recursive=true to remove it');
      await fsp.rm(abs, { recursive: true, force: true });
      return 'removed directory ' + abs;
    }
    await fsp.unlink(abs);
    return 'removed ' + abs;
  }
);

function toolIndex() {
  return new Map(TOOLS.map((t) => [t.name, t]));
}

function toolCatalog() {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema
  }));
}

module.exports = { tools: TOOLS, toolIndex, toolCatalog };
