'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('monitor', {
  onSessions: (cb) => ipcRenderer.on('sessions', (_e, sessions) => cb(sessions)),
  onConnected: (cb) => ipcRenderer.on('connected', (_e, connected) => cb(connected)),
  ready: () => ipcRenderer.send('ready'),
  quit: () => ipcRenderer.send('quit'),
  connect: () => ipcRenderer.send('connect'),
  resize: (height) => ipcRenderer.send('resize', height),
});
