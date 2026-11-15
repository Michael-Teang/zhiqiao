'use strict';
// pathsafe.js — resolve a caller-supplied path and prove it stays inside an allowed
// root. Blocks ../ escapes and symlink tricks.

const fs = require('node:fs');
const path = require('node:path');
const { getConfig } = require('./config.js');

class PathError extends Error {}

function assertAllowed(p, opts) {
  const mustExist = opts && opts.mustExist;
  if (typeof p !== 'string' || !p.trim()) {
    throw new PathError('path is required');
  }

  const abs = path.resolve(p);

  // realpath the deepest existing ancestor so symlinks cannot escape
  let probe = abs;
  const tail = [];
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    tail.unshift(path.basename(probe));
    probe = parent;
  }

  let real;
  try {
    real = fs.realpathSync.native(probe);
  } catch {
    real = probe;
  }
  const resolved = tail.length ? path.join(real, ...tail) : real;

  const roots = getConfig().allowedRoots;
  const ok = roots.some((root) => {
    const rel = path.relative(root, resolved);
    return rel === '' || (rel.indexOf('..') !== 0 && !path.isAbsolute(rel));
  });

  if (!ok) {
    throw new PathError(
      'path escapes the allowed roots: ' + resolved + '\nallowed: ' + roots.join(', ')
    );
  }

  if (mustExist && !fs.existsSync(resolved)) {
    throw new PathError('not found: ' + resolved);
  }

  return resolved;
}

function clip(text) {
  const s = typeof text === 'string' ? text : String(text);
  const cap = getConfig().maxOutputBytes;
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= cap) return s;
  const head = buf.subarray(0, cap).toString('utf8');
  return head + '\n\n[truncated: ' + (buf.length - cap) + ' more bytes]';
}

module.exports = { PathError, assertAllowed, clip };
