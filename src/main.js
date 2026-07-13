'use strict';

const { app, BrowserWindow, ipcMain, screen, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { DATA_DIR, EVENT_LOG } = require('./paths');
const { liveAgents, compactIfLarge } = require('./live-agents');

const POLL_MS = 400;
const WIDTH = 340;
const MARGIN = 16;
const WINDOW_STATE = path.join(DATA_DIR, 'window.json');

let win = null;
let lastPayload = '';

function savedPosition() {
  try {
    const { x, y } = JSON.parse(fs.readFileSync(WINDOW_STATE, 'utf8'));
    // Ignore a position left behind by a monitor that is no longer attached.
    const onScreen = screen.getAllDisplays().some((d) => {
      const b = d.workArea;
      return x >= b.x - WIDTH && x <= b.x + b.width && y >= b.y && y <= b.y + b.height;
    });
    if (onScreen && Number.isFinite(x) && Number.isFinite(y)) return { x, y };
  } catch {
    /* fall through to the default corner */
  }
  return null;
}

function defaultPosition() {
  const { workArea } = screen.getPrimaryDisplay();
  return {
    x: workArea.x + workArea.width - WIDTH - MARGIN,
    y: workArea.y + MARGIN,
  };
}

function persistPosition() {
  if (!win) return;
  const [x, y] = win.getPosition();
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(WINDOW_STATE, JSON.stringify({ x, y }));
  } catch {
    /* position is a nicety, not worth surfacing */
  }
}

function createWindow() {
  const pos = savedPosition() || defaultPosition();

  win = new BrowserWindow({
    width: WIDTH,
    height: 120,
    x: pos.x,
    y: pos.y,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    fullscreenable: false,
    maximizable: false,
    minimizable: false,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Float above full-screen apps and other always-on-top windows too.
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, 'index.html'));

  win.once('ready-to-show', () => win.show());
  win.on('moved', persistPosition);

  // Keep links from opening inside the overlay.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

function push(force = false) {
  if (!win || win.isDestroyed()) return;
  const agents = liveAgents();
  const payload = JSON.stringify(agents);
  if (!force && payload === lastPayload) return;
  lastPayload = payload;
  win.webContents.send('agents', agents);
}

app.whenReady().then(() => {
  try {
    compactIfLarge();
  } catch {
    /* non-fatal */
  }

  createWindow();

  // Polling rather than fs.watch: watch semantics differ across Windows and
  // macOS, and this also picks up the meta.json description that lands a beat
  // after SubagentStart fires.
  const timer = setInterval(() => push(), POLL_MS);

  ipcMain.on('ready', () => push(true));
  ipcMain.on('quit', () => app.quit());
  ipcMain.on('resize', (_e, height) => {
    if (win && !win.isDestroyed()) {
      win.setBounds({ height: Math.max(1, Math.round(height)) }, false);
    }
  });

  app.on('before-quit', () => clearInterval(timer));
});

app.on('window-all-closed', () => app.quit());

// A corner overlay has no dock presence on macOS.
if (process.platform === 'darwin' && app.dock) app.dock.hide();

module.exports = { EVENT_LOG };
