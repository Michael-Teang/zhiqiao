'use strict';
// preload.cjs — the only bridge between the sandboxed UI and the main process.
// Exposes a narrow, explicit API; nothing else from Node leaks into the page.

const { contextBridge, ipcRenderer } = require('electron');

const api = {
  // state
  getStatus: () => ipcRenderer.invoke('status'),
  getTools: () => ipcRenderer.invoke('tools'),
  getConfig: () => ipcRenderer.invoke('config:get'),
  updateConfig: (patch) => ipcRenderer.invoke('config:update', patch),

  // service control
  startService: () => ipcRenderer.invoke('service:start'),
  stopService: () => ipcRenderer.invoke('service:stop'),
  startTunnel: () => ipcRenderer.invoke('tunnel:start'),
  stopTunnel: () => ipcRenderer.invoke('tunnel:stop'),
  rotateTunnel: () => ipcRenderer.invoke('tunnel:rotate'),
  restartTunnel: () => ipcRenderer.invoke('tunnel:restart'),

  // token
  regenerateToken: () => ipcRenderer.invoke('token:regenerate'),

  // folders
  addRoot: () => ipcRenderer.invoke('dialog:addRoot'),
  removeRoot: (p) => ipcRenderer.invoke('root:remove', p),

  // misc
  openConfigDir: () => ipcRenderer.invoke('open:configDir'),
  openUrl: (url) => ipcRenderer.invoke('open:url', url),
  copy: (text) => ipcRenderer.invoke('clipboard:write', text),

  // events
  onStatus: (cb) => {
    const h = (_e, s) => cb(s);
    ipcRenderer.on('status', h);
    return () => ipcRenderer.removeListener('status', h);
  },
  onToast: (cb) => {
    const h = (_e, t) => cb(t);
    ipcRenderer.on('toast', h);
    return () => ipcRenderer.removeListener('toast', h);
  },
  onActivity: (cb) => {
    const h = (_e, a) => cb(a);
    ipcRenderer.on('activity', h);
    return () => ipcRenderer.removeListener('activity', h);
  }
};

contextBridge.exposeInMainWorld('bridge', api);
