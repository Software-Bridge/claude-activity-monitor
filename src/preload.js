'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('monitor', {
  onSessions: (cb) => ipcRenderer.on('sessions', (_e, sessions) => cb(sessions)),
  onConnected: (cb) => ipcRenderer.on('connected', (_e, connected) => cb(connected)),
  // Where the cursor is, polled by the main process: a background overlay gets
  // no mousemove of its own until it is clicked. See src/pointer.js.
  onPointer: (cb) => ipcRenderer.on('pointer', (_e, point) => cb(point)),
  ready: () => ipcRenderer.send('ready'),
  quit: () => ipcRenderer.send('quit'),
  connect: () => ipcRenderer.send('connect'),
  resize: (height) => ipcRenderer.send('resize', height),
});
