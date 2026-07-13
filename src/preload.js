'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('monitor', {
  onAgents: (cb) => ipcRenderer.on('agents', (_e, agents) => cb(agents)),
  onConnected: (cb) => ipcRenderer.on('connected', (_e, connected) => cb(connected)),
  ready: () => ipcRenderer.send('ready'),
  quit: () => ipcRenderer.send('quit'),
  connect: () => ipcRenderer.send('connect'),
  resize: (height) => ipcRenderer.send('resize', height),
});
