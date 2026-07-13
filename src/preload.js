'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('monitor', {
  onAgents: (cb) => ipcRenderer.on('agents', (_e, agents) => cb(agents)),
  ready: () => ipcRenderer.send('ready'),
  quit: () => ipcRenderer.send('quit'),
  resize: (height) => ipcRenderer.send('resize', height),
});
