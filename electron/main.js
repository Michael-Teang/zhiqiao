'use strict';
// main.js — Electron entry point (CommonJS). Owns app lifecycle, tray and IPC.

const { app, BrowserWindow, Tray, Menu, nativeImage, shell, dialog, ipcMain, clipboard, nativeTheme } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const { initConfigDir, getConfig, updateConfig, getConfigDir, loadConfig } = require('../src/config.js');
const { Bridge } = require('../src/service.js');
const { toolCatalog } = require('../src/tools.js');

let win = null;
let tray = null;
let bridge = null;
let quitting = false;
let startedAtLogin = process.argv.includes('--hidden');

// ---------------------------------------------------------------- helpers

function resourcePath(name) {
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, name) : null,
    path.join(__dirname, '..', name),
    path.join(__dirname, '..', 'assets', name)
  ].filter(Boolean);

  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch (e) {}
  }
  return null;
}

function sendToUi(channel, payload) {
  if (win && !win.isDestroyed()) {
    try { win.webContents.send(channel, payload); } catch (e) {}
  }
}

function configView(c) {
  return {
    allowedRoots: c.allowedRoots,
    allowExec: c.allowExec,
    autoStartTunnel: c.autoStartTunnel,
    startMinimized: c.startMinimized,
    launchAtLogin: c.launchAtLogin,
    approvalTimeoutMs: c.approvalTimeoutMs,
    addressHistory: c.addressHistory || [],
    memoryEnabled: c.memoryEnabled,
    autoMemory: c.autoMemory,
    autoMemoryIdleMs: c.autoMemoryIdleMs,
    allowDesktopTools: c.allowDesktopTools,
    tunnelMode: c.tunnelMode,
    stableTunnelUrl: c.stableTunnelUrl,
    namedTunnelHostname: c.namedTunnelHostname,
    namedTunnelToken: c.namedTunnelToken,
    port: c.port,
    token: c.token,
    cloudflaredPath: c.cloudflaredPath,
    configDir: getConfigDir()
  };
}

function applyLoginItem(cfg) {
  try {
    if (process.platform === 'win32' || process.platform === 'darwin') {
      app.setLoginItemSettings({
        openAtLogin: !!cfg.launchAtLogin,
        openAsHidden: true,
        path: process.execPath,
        args: ['--hidden'],
        name: 'zhiqiao'
      });
    }
  } catch (e) {
    console.error('[login] setLoginItemSettings failed:', e.message);
  }
}

// ----------------------------------------------------------------- window

function createWindow() {
  if (win && !win.isDestroyed()) {
    win.show();
    win.focus();
    return;
  }

  const iconPath = resourcePath('icon.png');
  win = new BrowserWindow({
    width: 980,
    height: 760,
    minWidth: 820,
    minHeight: 620,
    title: '智桥-zhiqiao 1.3.0',
    icon: iconPath || undefined,
    backgroundColor: '#0e0e12',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  win.loadFile(path.join(__dirname, '..', 'ui', 'index.html'));

  win.once('ready-to-show', () => {
    let cfg = null;
    try { cfg = getConfig(); } catch (e) {}
    if (startedAtLogin || (cfg && cfg.startMinimized)) return;
    win.show();
  });

  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// ------------------------------------------------------------------ tray

function buildTray() {
  // A dedicated small PNG renders sharper in the notification area than downscaling
  // the full-size window icon.
  let img = nativeImage.createEmpty();
  for (const name of ['tray.png', 'icon.png']) {
    const p = resourcePath(name);
    if (!p) continue;
    try {
      const loaded = nativeImage.createFromPath(p);
      if (!loaded.isEmpty()) {
        // macOS menu bar wants ~18pt; Windows notification area wants 16px
        img = process.platform === 'darwin'
          ? loaded.resize({ width: 18, height: 18 })
          : (name === 'icon.png' ? loaded.resize({ width: 16, height: 16 }) : loaded);
        break;
      }
    } catch (e) {}
  }

  try {
    tray = new Tray(img);
  } catch (e) {
    return;
  }

  const menu = Menu.buildFromTemplate([
    { label: '打开控制面板', click: () => createWindow() },
    { type: 'separator' },
    {
      label: '复制公网地址',
      click: () => {
        const s = bridge.status();
        const url = (s.tunnel && s.tunnel.state === 'ready') ? s.publicUrl : (s.fallbackUrl || s.publicUrl);
        if (url) {
          clipboard.writeText(url);
          sendToUi('toast', { kind: 'ok', text: '公网地址已复制' });
        } else {
          sendToUi('toast', { kind: 'warn', text: '隧道未启动' });
        }
      }
    },
    {
      label: '复制连接配置',
      click: () => {
        const s = bridge.status();
        const url = s.publicUrl || s.localUrl;
        if (!url) return sendToUi('toast', { kind: 'warn', text: '服务未启动' });
        const cfg = {
          mcpServers: {
            'my-computer': {
              type: 'http',
              url: url,
              headers: { Authorization: 'Bearer ' + s.token }
            }
          }
        };
        clipboard.writeText(JSON.stringify(cfg, null, 2));
        sendToUi('toast', { kind: 'ok', text: '连接配置已复制' });
      }
    },
    {
      label: '更换公网地址',
      click: async () => {
        const s = bridge.status();
        if (s.tunnelMode !== 'stable') {
          return sendToUi('toast', { kind: 'warn', text: '仅固定地址模式支持更换地址' });
        }
        const r = await dialog.showMessageBox({
          type: 'warning',
          buttons: ['取消', '更换地址'],
          defaultId: 0,
          cancelId: 0,
          title: '更换公网地址',
          message: '更换后公网地址会变化，ChatGPT / Claude 里需要重新填一次。',
          detail: '更换会生成新的 SSH 密钥。生成后必须立即点击「注册固定地址」，把新密钥绑定到 tunnl.gg 免费账号，否则固定地址会一直显示「正在获取地址」。只有你主动确认才会更换。'
        });
        if (r.response === 1) {
          bridge.rotateStableTunnel();
          sendToUi('toast', { kind: 'warn', text: '正在生成新的固定地址…' });
        }
      }
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => { quitting = true; app.quit(); }
    }
  ]);

  tray.setToolTip('智桥-zhiqiao');
  tray.setContextMenu(menu);
  tray.on('double-click', () => createWindow());
}

// ------------------------------------------------------------------- IPC

function registerIpc() {
  ipcMain.handle('status', () => bridge.status());
  ipcMain.handle('tools', () => toolCatalog());

  ipcMain.handle('config:get', () => configView(getConfig()));

  ipcMain.handle('config:update', (e, patch) => {
    const before = getConfig();
    const next = updateConfig(patch);

    if (Object.prototype.hasOwnProperty.call(patch || {}, 'launchAtLogin')) {
      applyLoginItem(next);
    }

    const modeChanged = patch && patch.tunnelMode && patch.tunnelMode !== before.tunnelMode;
    if (modeChanged) {
      bridge.connections.reset('隧道模式已变更');
      bridge.stopTunnel();
      if (next.autoStartTunnel) setTimeout(() => bridge.startTunnel(), 120);
    } else if (patch && Object.prototype.hasOwnProperty.call(patch, 'namedTunnelHostname') && patch.namedTunnelHostname !== before.namedTunnelHostname) {
      bridge.connections.reset('固定域名已变更');
    }
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'approvalTimeoutMs')) {
      bridge.connections.timeoutMs = Number(next.approvalTimeoutMs) || 180000;
    }

    sendToUi('status', bridge.status());
    return configView(next);
  });

  ipcMain.handle('connections:list', () => bridge.connections.list());
  ipcMain.handle('connections:pending', () => bridge.connections.pendingCount());
  ipcMain.handle('connections:approve', (e, id) => bridge.connections.approve(id));
  ipcMain.handle('connections:deny', (e, id) => bridge.connections.deny(id));
  ipcMain.handle('connections:block', (e, id) => bridge.connections.block(id));
  ipcMain.handle('connections:unblock', (e, id) => bridge.connections.unblock(id));
  ipcMain.handle('connections:clear', () => { bridge.connections.clear(); return bridge.connections.list(); });

  ipcMain.handle('memory:list', (e, query, limit) => bridge.memory.list(query, limit));
  ipcMain.handle('memory:get', (e, id) => bridge.memory.get(id));
  ipcMain.handle('memory:delete', (e, id) => bridge.memory.remove(id));
  ipcMain.handle('memory:clear', () => { bridge.memory.clear(); return bridge.memory.list('', 50); });
  ipcMain.handle('memory:stats', () => bridge.memory.stats());

  ipcMain.handle('service:start', async () => { await bridge.start(); return bridge.status(); });
  ipcMain.handle('service:stop', async () => { await bridge.stop(); return bridge.status(); });
  ipcMain.handle('tunnel:start', () => { bridge.startTunnel(); return bridge.status(); });
  ipcMain.handle('tunnel:stop', () => { bridge.stopTunnel(); return bridge.status(); });
  ipcMain.handle('tunnel:rotate', () => bridge.rotateStableTunnel());
  ipcMain.handle('tunnel:restart', () => bridge.restartTunnel());
  ipcMain.handle('tunnel:claim', async () => await bridge.getClaimLink());

  ipcMain.handle('token:regenerate', () => {
    const next = updateConfig({ token: crypto.randomBytes(24).toString('base64url') });
    bridge.connections.reset('访问令牌已更换');
    return { token: next.token };
  });

  ipcMain.handle('dialog:addRoot', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: '选择允许 AI 访问的文件夹',
      properties: ['openDirectory', 'multiSelections']
    });
    if (r.canceled || !r.filePaths.length) return null;
    const cfg = getConfig();
    const merged = Array.from(new Set(cfg.allowedRoots.concat(r.filePaths)));
    updateConfig({ allowedRoots: merged });
    return merged;
  });

  ipcMain.handle('root:remove', (e, p) => {
    const cfg = getConfig();
    const next = cfg.allowedRoots.filter((x) => x !== p);
    updateConfig({ allowedRoots: next.length ? next : cfg.allowedRoots });
    return getConfig().allowedRoots;
  });

  ipcMain.handle('open:configDir', () => { shell.openPath(getConfigDir()); return true; });

  ipcMain.handle('open:url', (e, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url);
    return true;
  });

  ipcMain.handle('clipboard:write', (e, text) => {
    clipboard.writeText(String(text == null ? '' : text));
    return true;
  });
}

// ------------------------------------------------------------ app events

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => createWindow());

  app.whenReady().then(async () => {
    // dark window chrome so the title bar matches the panel
    nativeTheme.themeSource = 'dark';
    initConfigDir(app.getPath('userData'));
    const cfg = loadConfig();
    applyLoginItem(cfg);
    try {
      if (app.getLoginItemSettings().wasOpenedAtLogin) startedAtLogin = true;
    } catch (e) {}

    bridge = new Bridge({ cloudflaredPath: resourcePath('cloudflared.exe') || '' });
    bridge.on('status', (s) => sendToUi('status', s));
    bridge.on('activity', (a) => sendToUi('activity', a));
    bridge.on('connection', (payload) => {
      sendToUi('connection', payload);
      if (payload && payload.type === 'request') {
        if (win && !win.isDestroyed() && !win.isVisible()) win.show();
        sendToUi('toast', {
          kind: 'warn',
          text: '有新的设备请求连接：' + ((payload.record && payload.record.name) || '未知设备')
        });
      }
    });
    bridge.on('memory', (list) => {
      sendToUi('memory', list);
      sendToUi('status', bridge.status());
    });

    registerIpc();
    buildTray();
    createWindow();

    try {
      await bridge.start();
    } catch (e) {
      sendToUi('toast', { kind: 'bad', text: '服务启动失败: ' + e.message });
    }

    app.on('activate', () => createWindow());
  });

  app.on('before-quit', async () => {
    quitting = true;
    if (bridge) await bridge.stop();
  });

  app.on('window-all-closed', () => {
    // keep running in tray
  });
}
