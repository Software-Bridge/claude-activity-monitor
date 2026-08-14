'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('monitor', {
  onSessions: (cb) => ipcRenderer.on('sessions', (_e, sessions) => cb(sessions)),
  onConnected: (cb) => ipcRenderer.on('connected', (_e, connected) => cb(connected)),
  // Where the cursor is, polled by the main process: a background overlay gets
  // no mousemove of its own until it is clicked. See src/pointer.js.
  onPointer: (cb) => ipcRenderer.on('pointer', (_e, point) => cb(point)),
  // True once the window's height is the user's rather than the content's, which
  // changes how the card lays itself out. See main.js.
  onSizing: (cb) => ipcRenderer.on('sizing', (_e, sized) => cb(sized)),
  ready: () => ipcRenderer.send('ready'),
  quit: () => ipcRenderer.send('quit'),
  connect: () => ipcRenderer.send('connect'),
  resize: (height) => ipcRenderer.send('resize', height),
  // A grip drag: a size the user is choosing, not one the content implies.
  // Positions are the cursor's on *screen*, not inside the window — the window
  // moves during the drag, so window-relative coordinates would be measured
  // against a shifting origin. See the anchor logic in main.js.
  resizeStart: (corner, x, y) => ipcRenderer.send('resize-start', { corner, x, y }),
  resizeTo: (x, y) => ipcRenderer.send('resize-to', { x, y }),
  resizeEnd: () => ipcRenderer.send('resize-end'),
  // Jump to the editor window a session is running in.
  reveal: (cwd) => ipcRenderer.send('reveal', cwd),
});
