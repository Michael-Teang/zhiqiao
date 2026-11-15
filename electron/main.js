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
    height: 720,
    minWidth: 820,
    minHeight: 600,
    title: '智桥-zhiqiao',
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
    if (cfg && cfg.startMinimized) return;
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
        if (s.publicUrl) {
          clipboard.writeText(s.publicUrl);
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

  ipcMain.handle('config:get', () => {
    const c = getConfig();
    return {
      allowedRoots: c.allowedRoots,
      allowExec: c.allowExec,
      autoStartTunnel: c.autoStartTunnel,
      startMinimized: c.startMinimized,
      port: c.port,
      token: c.token,
      cloudflaredPath: c.cloudflaredPath,
      configDir: getConfigDir()
    };
  });

  ipcMain.handle('config:update', (e, patch) => {
    const next = updateConfig(patch);
    sendToUi('status', bridge.status());
    return {
      allowedRoots: next.allowedRoots,
      allowExec: next.allowExec,
      autoStartTunnel: next.autoStartTunnel,
      startMinimized: next.startMinimized,
      port: next.port,
      token: next.token,
      cloudflaredPath: next.cloudflaredPath,
      configDir: getConfigDir()
    };
  });

  ipcMain.handle('service:start', async () => { await bridge.start(); return bridge.status(); });
  ipcMain.handle('service:stop', async () => { await bridge.stop(); return bridge.status(); });
  ipcMain.handle('tunnel:start', () => { bridge.startTunnel(); return bridge.status(); });
  ipcMain.handle('tunnel:stop', () => { bridge.stopTunnel(); return bridge.status(); });

  ipcMain.handle('token:regenerate', () => {
    const next = updateConfig({ token: crypto.randomBytes(24).toString('base64url') });
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
    loadConfig();

    bridge = new Bridge({ cloudflaredPath: resourcePath('cloudflared.exe') || '' });
    bridge.on('status', (s) => sendToUi('status', s));
    bridge.on('activity', (a) => sendToUi('activity', a));

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
