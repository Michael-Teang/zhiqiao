'use strict';
// config.js — desktop edition (CommonJS). Config lives in the Electron userData
// folder so it survives updates and never ships with a baked-in token.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

let cfgDir = '';
let cached = null;

function initConfigDir(userDataPath) {
  cfgDir = path.join(userDataPath, 'config');
  fs.mkdirSync(cfgDir, { recursive: true });
}

function getConfigDir() {
  return cfgDir;
}

function getStableKeyDir() {
  return path.join(path.dirname(cfgDir), 'ssh');
}

function defaultRoots() {
  const home = os.homedir();
  const out = [];
  for (const name of ['Desktop', 'Documents', 'Downloads']) {
    const p = path.join(home, name);
    if (fs.existsSync(p)) out.push(p);
  }
  if (!out.length) out.push(home);
  return out;
}

const DEFAULTS = {
  configVersion: 3,
  port: 8765,
  host: '127.0.0.1',
  token: '',
  allowedRoots: [],
  allowExec: true,
  autoStartTunnel: true,
  startMinimized: false,
  launchAtLogin: true,
  approvalTimeoutMs: 180000,
  addressHistory: [],
  memoryEnabled: true,
  autoMemory: true,
  autoMemoryIdleMs: 60000,
  allowDesktopTools: true,
  tunnelMode: 'stable',
  stableTunnelUrl: '',
  stableTunnelHost: 'proxy.tunnl.gg',
  namedTunnelHostname: '',
  namedTunnelToken: '',
  execDeniedPatterns: [
    'format ', 'diskpart', 'bcdedit', 'cipher /w',
    'rm -rf /', 'mkfs', 'dd if=', 'shutdown', 'Restart-Computer',
    'Remove-Item -Recurse -Force C:\\', 'rd /s /q C:\\'
  ],
  execTimeoutMs: 60000,
  maxOutputBytes: 200000,
  cloudflaredPath: ''
};

function saveConfig(cfg) {
  const p = path.join(cfgDir, 'config.json');
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2), 'utf8');
  cached = cfg;
  return cfg;
}

function loadConfig() {
  const p = path.join(cfgDir, 'config.json');
  let fileCfg = {};
  if (fs.existsSync(p)) {
    try {
      fileCfg = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (e) {
      console.error('[config] bad config.json:', e.message);
    }
  }

  const cfg = Object.assign({}, DEFAULTS, fileCfg);
  let dirty = false;

  // v1 -> v2: switch from volatile quick tunnels to a key-bound stable address,
  // and make the app reconnect that same address at login.
  if (Number(fileCfg.configVersion || 1) < 2) {
    cfg.configVersion = 2;
    cfg.tunnelMode = 'stable';
    cfg.autoStartTunnel = true;
    cfg.launchAtLogin = true;
    dirty = true;
  }

  // v2 -> v3: connection approval, memory library and address history.
  if (Number(cfg.configVersion || 2) < 3) {
    cfg.configVersion = 3;
    if (!Array.isArray(cfg.addressHistory)) cfg.addressHistory = [];
    if (!Number(cfg.approvalTimeoutMs) || cfg.approvalTimeoutMs < 30000) cfg.approvalTimeoutMs = 180000;
    if (typeof cfg.memoryEnabled !== 'boolean') cfg.memoryEnabled = true;
    if (typeof cfg.allowDesktopTools !== 'boolean') cfg.allowDesktopTools = true;
    dirty = true;
  }

  if (!Array.isArray(cfg.addressHistory)) cfg.addressHistory = [];
  cfg.addressHistory = cfg.addressHistory
    .filter((x) => x && typeof x.url === 'string' && /^https?:\/\//i.test(x.url))
    .map((x) => ({
      url: String(x.url).replace(/\/+$/, ''),
      mode: x.mode === 'quick' ? 'quick' : (x.mode === 'named' ? 'named' : 'stable'),
      label: typeof x.label === 'string' ? x.label.slice(0, 80) : '',
      createdAt: Number(x.createdAt) || Date.now(),
      lastSeenAt: Number(x.lastSeenAt) || Number(x.createdAt) || Date.now()
    }))
    .filter((x, i, a) => a.findIndex((y) => y.url === x.url) === i);
  let _quickSeen = 0;
  cfg.addressHistory = cfg.addressHistory.filter((x) => x.mode !== 'quick' || _quickSeen++ < 3).slice(0, 30);

  if (cfg.stableTunnelUrl && !cfg.addressHistory.some((x) => x.url === cfg.stableTunnelUrl)) {
    cfg.addressHistory.unshift({
      url: cfg.stableTunnelUrl,
      mode: 'stable',
      label: '固定地址',
      createdAt: Date.now(),
      lastSeenAt: Date.now()
    });
    cfg.addressHistory = cfg.addressHistory.slice(0, 30);
    dirty = true;
  }

  if (!Array.isArray(cfg.allowedRoots) || !cfg.allowedRoots.length) {
    cfg.allowedRoots = defaultRoots();
  }
  cfg.allowedRoots = cfg.allowedRoots
    .filter((x) => typeof x === 'string' && x.trim())
    .map((x) => path.resolve(x))
    .filter((x, i, a) => a.indexOf(x) === i);

  if (!cfg.token) {
    cfg.token = crypto.randomBytes(24).toString('base64url');
    dirty = true;
  }

  if (dirty) saveConfig(cfg);

  cached = cfg;
  return cfg;
}

function getConfig() {
  return cached || loadConfig();
}

function updateConfig(patch) {
  const cfg = Object.assign({}, getConfig(), patch);
  if (!Array.isArray(cfg.allowedRoots) || !cfg.allowedRoots.length) {
    cfg.allowedRoots = defaultRoots();
  }
  cfg.allowedRoots = cfg.allowedRoots
    .filter((x) => typeof x === 'string' && x.trim())
    .map((x) => path.resolve(x));
  return saveConfig(cfg);
}

module.exports = {
  initConfigDir,
  getConfigDir,
  getStableKeyDir,
  loadConfig,
  getConfig,
  saveConfig,
  updateConfig,
  defaultRoots
};
