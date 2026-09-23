'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ticker', {
  init: () => ipcRenderer.invoke('init'),
  getBounds: () => ipcRenderer.invoke('get-bounds'),
  move: (y) => ipcRenderer.send('move', y),
  moveEnd: () => ipcRenderer.send('move-end'),
  currentItem: (link) => ipcRenderer.send('current-item', link),
  openLink: (url) => ipcRenderer.send('open-link', url),
  showMenu: () => ipcRenderer.send('context-menu'),
  onConfig: (cb) => ipcRenderer.on('config', (_e, d) => cb(d)),
  onLayout: (cb) => ipcRenderer.on('layout', (_e, d) => cb(d)),
  onNews: (cb) => ipcRenderer.on('news', (_e, d) => cb(d)),
  onCommand: (cb) => ipcRenderer.on('command', (_e, d) => cb(d)),
});
