'use strict';
// tools.js — the operations the AI can call (CommonJS).

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const dns = require('node:dns');
const { spawn, spawnSync } = require('node:child_process');
const { getConfig } = require('./config.js');
const { assertAllowed, clip } = require('./pathsafe.js');

const TOOLS = [];
let memoryStore = null;

function tool(name, description, inputSchema, handler, category) {
  TOOLS.push({ name, description, inputSchema, handler, category: category || '基础' });
}

function setMemoryStore(store) {
  memoryStore = store;
}

function isWin() {
  return process.platform === 'win32';
}

function runSync(file, args, opts) {
  const r = spawnSync(file, args, Object.assign({
    windowsHide: true,
    encoding: 'utf8',
    maxBuffer: 12 * 1024 * 1024,
    timeout: 30000
  }, opts || {}));
  if (r.error) throw new Error(r.error.message);
  if (r.status !== 0) throw new Error(String(r.stderr || r.stdout || 'command failed').trim());
  return String(r.stdout || '');
}

function requireMemory() {
  if (!getConfig().memoryEnabled) throw new Error('memory is disabled in settings');
  if (!memoryStore) throw new Error('memory store is not initialized');
  return memoryStore;
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

// -------------------------------------------------------------- file pack

tool(
  'hash_file',
  'Compute a cryptographic hash for a file inside the allowed roots.',
  {
    type: 'object',
    properties: {
      path: { type: 'string' },
      algorithm: { type: 'string', description: 'sha256 (default), sha1, sha512 or md5.' }
    },
    required: ['path']
  },
  async (a) => {
    const abs = assertAllowed(a.path, { mustExist: true });
    const algo = String(a.algorithm || 'sha256').toLowerCase();
    if (!['sha256', 'sha1', 'sha512', 'md5'].includes(algo)) throw new Error('unsupported algorithm');
    const st = await fsp.stat(abs);
    if (st.isDirectory()) throw new Error('that path is a directory');
    const h = crypto.createHash(algo);
    await new Promise((resolve, reject) => {
      const s = fs.createReadStream(abs);
      s.on('data', (d) => h.update(d));
      s.on('end', resolve);
      s.on('error', reject);
    });
    return JSON.stringify({ path: abs, size: st.size, algorithm: algo, hash: h.digest('hex') }, null, 2);
  },
  '文件增强'
);

tool(
  'find_files',
  'Find files by name (supports * wildcards) inside an allowed directory.',
  {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory to search.' },
      pattern: { type: 'string', description: 'Name pattern, e.g. "*.log" or "report".' },
      limit: { type: 'number', description: 'Max results (default 100).' }
    },
    required: ['path', 'pattern']
  },
  async (a) => {
    const root = assertAllowed(a.path, { mustExist: true });
    const pat = String(a.pattern || '*');
    const re = new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i');
    const cap = Math.min(Math.max(Number(a.limit) || 100, 1), 500);
    const hits = [];
    const walk = async (dir, depth) => {
      if (hits.length >= cap || depth > 8) return;
      let items;
      try { items = await fsp.readdir(dir, { withFileTypes: true }); } catch (e) { return; }
      for (const it of items) {
        if (hits.length >= cap) return;
        if (it.name === 'node_modules' || it.name === '.git') continue;
        const full = path.join(dir, it.name);
        if (it.isDirectory()) { await walk(full, depth + 1); continue; }
        if (re.test(it.name)) hits.push(path.relative(root, full));
      }
    };
    await walk(root, 0);
    return hits.length ? hits.join('\n') : 'no matches';
  },
  '文件增强'
);

// ------------------------------------------------------------- system pack

tool(
  'list_processes',
  'List running processes with PID, name, CPU, memory and window title.',
  {
    type: 'object',
    properties: { limit: { type: 'number', description: 'Max rows (default 60).' } }
  },
  async (a) => {
    const limit = Math.min(Math.max(Number(a.limit) || 60, 1), 200);
    if (isWin()) {
      const script = `Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First ${limit} Id,ProcessName,CPU,WorkingSet64,MainWindowTitle | ConvertTo-Json -Compress`;
      return clip(runSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]));
    }
    return clip(runSync('ps', ['-axo', 'pid,comm,%cpu,rss,args']));
  },
  '系统运维'
);

tool(
  'kill_process',
  'Terminate a process by PID. Respects the command-execution switch.',
  {
    type: 'object',
    properties: {
      pid: { type: 'number' },
      signal: { type: 'string', description: 'SIGTERM (default) or SIGKILL.' }
    },
    required: ['pid']
  },
  async (a) => {
    if (!getConfig().allowExec) throw new Error('command execution is disabled (allowExec=false)');
    const pid = Number(a.pid);
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('invalid pid');
    if (pid === process.pid) throw new Error('refusing to kill the bridge process itself');
    process.kill(pid, String(a.signal || 'SIGTERM').toUpperCase());
    return 'sent ' + String(a.signal || 'SIGTERM').toUpperCase() + ' to pid ' + pid;
  },
  '系统运维'
);

tool(
  'network_info',
  'Show hostname, local network interfaces and DNS servers.',
  { type: 'object', properties: {} },
  async () => {
    const interfaces = {};
    const nets = os.networkInterfaces();
    for (const [name, list] of Object.entries(nets)) {
      interfaces[name] = (list || []).map((x) => ({
        address: x.address,
        family: x.family,
        internal: x.internal,
        mac: x.mac
      }));
    }
    return JSON.stringify({
      hostname: os.hostname(),
      platform: process.platform,
      interfaces,
      dnsServers: dns.getServers()
    }, null, 2);
  },
  '系统运维'
);

tool(
  'disk_usage',
  'Show used/free space for the allowed folders.',
  { type: 'object', properties: {} },
  async () => {
    const rows = [];
    for (const root of getConfig().allowedRoots.slice(0, 8)) {
      try {
        const st = await fsp.statfs(root);
        const block = Number(st.bsize) || 0;
        const total = Number(st.blocks) * block;
        const free = Number(st.bavail) * block;
        rows.push({ path: root, totalBytes: total, freeBytes: free, usedBytes: total - free });
      } catch (e) {
        rows.push({ path: root, error: e.message });
      }
    }
    return JSON.stringify(rows, null, 2);
  },
  '系统运维'
);

// ------------------------------------------------------------ desktop pack

tool(
  'clipboard_get',
  'Read the current system clipboard text.',
  { type: 'object', properties: {} },
  async () => {
    if (!getConfig().allowDesktopTools) throw new Error('desktop tools are disabled');
    if (isWin()) return clip(runSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-Clipboard -Raw']));
    if (process.platform === 'darwin') return clip(runSync('pbpaste', []));
    return clip(runSync('sh', ['-c', 'xclip -selection clipboard -o 2>/dev/null || xsel --clipboard --output 2>/dev/null || true']));
  },
  '桌面辅助'
);

tool(
  'clipboard_set',
  'Replace the system clipboard text.',
  { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  async (a) => {
    if (!getConfig().allowDesktopTools) throw new Error('desktop tools are disabled');
    const text = String(a.text || '').slice(0, 100000);
    if (isWin()) {
      runSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[Console]::In.ReadToEnd() | Set-Clipboard'], { input: text });
    } else if (process.platform === 'darwin') {
      runSync('pbcopy', [], { input: text });
    } else {
      runSync('sh', ['-c', 'xclip -selection clipboard 2>/dev/null || xsel --clipboard --input 2>/dev/null || true'], { input: text });
    }
    return 'clipboard updated (' + text.length + ' chars)';
  },
  '桌面辅助'
);

tool(
  'screenshot',
  'Capture the whole screen and return it as an image to the AI.',
  {
    type: 'object',
    properties: { saveTo: { type: 'string', description: 'Optional path inside allowed roots.' } }
  },
  async (a) => {
    if (!getConfig().allowDesktopTools) throw new Error('desktop tools are disabled');
    if (!getConfig().allowExec) throw new Error('command execution is disabled (allowExec=false)');
    const roots = getConfig().allowedRoots;
    const dir = a.saveTo ? assertAllowed(a.saveTo) : path.join(roots[0] || os.tmpdir(), '.zhiqiao-screenshots');
    await fsp.mkdir(dir, { recursive: true });
    const out = path.join(dir, 'screenshot-' + new Date().toISOString().replace(/[:.]/g, '-') + '.png');
    if (isWin()) {
      const psOut = out.replace(/'/g, "''");
      const script = [
        'Add-Type -AssemblyName System.Windows.Forms,System.Drawing',
        '$r=[System.Windows.Forms.SystemInformation]::VirtualScreen',
        '$b=New-Object System.Drawing.Bitmap $r.Width,$r.Height',
        '$g=[System.Drawing.Graphics]::FromImage($b)',
        '$g.CopyFromScreen($r.Left,$r.Top,0,0,$b.Size)',
        "$b.Save('" + psOut + "',[System.Drawing.Imaging.ImageFormat]::Png)",
        '$g.Dispose();$b.Dispose()',
        "Write-Output '" + psOut + "'"
      ].join('; ');
      runSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 30000 });
    } else if (process.platform === 'darwin') {
      runSync('screencapture', ['-x', out], { timeout: 30000 });
    } else {
      runSync('sh', ['-c', 'gnome-screenshot -f "$1" 2>/dev/null || import -window root "$1" 2>/dev/null || true', '--', out], { timeout: 30000 });
    }
    const st = await fsp.stat(out);
    if (st.size > 3 * 1024 * 1024) return 'screenshot saved to ' + out + ' (' + st.size + ' bytes, too large to inline)';
    const b64 = (await fsp.readFile(out)).toString('base64');
    return {
      __mcpContent: [
        { type: 'text', text: 'screenshot saved to ' + out + ' (' + st.size + ' bytes)' },
        { type: 'image', data: b64, mimeType: 'image/png' }
      ]
    };
  },
  '桌面辅助'
);

// --------------------------------------------------------------- memory pack

tool(
  'memory_save',
  'Save a concise handoff memory after each user request and before your final answer: what the user asked, what was done, key facts, paths, decisions and next steps. The next AI can read it with memory_search.',
  {
    type: 'object',
    properties: {
      title: { type: 'string' },
      summary: { type: 'string' },
      content: { type: 'string', description: 'Full notes. Markdown is fine.' },
      tags: { type: 'array', items: { type: 'string' } },
      id: { type: 'string', description: 'Optional existing memory id to update.' }
    },
    required: ['title', 'content']
  },
  async (a, ctx) => {
    const rec = requireMemory().save({
      id: a.id,
      title: a.title,
      summary: a.summary,
      content: a.content,
      tags: a.tags,
      source: {
        clientName: ctx && ctx.clientName,
        ip: ctx && ctx.clientIp,
        sessionId: ctx && ctx.sessionId
      }
    });
    return 'memory saved: ' + rec.id + '\n' + rec.title;
  },
  '记忆'
);

tool(
  'memory_search',
  'Search saved handoff memories. Use this at the start of a task to recover context from previous AIs.',
  {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Keyword; empty returns newest memories.' },
      limit: { type: 'number' }
    }
  },
  async (a) => {
    const rows = requireMemory().list(a.query, a.limit || 10);
    if (!rows.length) return 'no memories found';
    return rows.map((r) => [
      '[' + r.id + '] ' + r.title,
      'tags: ' + (r.tags.join(', ') || '-'),
      'updated: ' + new Date(r.updatedAt).toISOString(),
      'source: ' + (r.source.clientName || 'unknown'),
      'summary: ' + (r.summary || '')
    ].join('\n')).join('\n\n');
  },
  '记忆'
);

tool(
  'memory_get',
  'Read one saved memory in full by id.',
  { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  async (a) => {
    const rec = requireMemory().get(a.id);
    if (!rec) throw new Error('memory not found: ' + a.id);
    return JSON.stringify(rec, null, 2);
  },
  '记忆'
);

tool(
  'memory_list',
  'List recent saved memories (summary only).',
  { type: 'object', properties: { limit: { type: 'number' } } },
  async (a) => {
    const rows = requireMemory().list('', a.limit || 20);
    if (!rows.length) return 'no memories';
    return rows.map((r) => '[' + r.id + '] ' + r.title + ' — ' + (r.summary || '')).join('\n');
  },
  '记忆'
);

tool(
  'memory_delete',
  'Delete one saved memory by id.',
  { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  async (a) => {
    const ok = requireMemory().remove(a.id);
    return ok ? 'deleted ' + a.id : 'memory not found: ' + a.id;
  },
  '记忆'
);

tool(
  'memory_stats',
  'Show how many memories are stored and where.',
  { type: 'object', properties: {} },
  async () => JSON.stringify(requireMemory().stats(), null, 2),
  '记忆'
);

function toolIndex() {
  return new Map(TOOLS.map((t) => [t.name, t]));
}

function toolCatalog() {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    category: t.category || '基础'
  }));
}

module.exports = { tools: TOOLS, toolIndex, toolCatalog, setMemoryStore };
