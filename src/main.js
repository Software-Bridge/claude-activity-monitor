'use strict';

const { app, BrowserWindow, dialog, ipcMain, screen, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./paths');
const { liveState } = require('./live-agents');
const { localPoint } = require('./pointer');
const { installHooks, hooksInstalled, writeShim } = require('./hooks-config');

const POLL_MS = 400;
// Faster than the state poll: this one is a cursor following a row, and anything
// slower than about a tenth of a second reads as lag rather than as hover.
const POINTER_MS = 90;
const WIDTH = 340;
const MARGIN = 16;
const WINDOW_STATE = path.join(DATA_DIR, 'window.json');

let win = null;
let lastPayload = '';
let lastPointer = '';

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

// 'moved' fires continuously while dragging, so writing on each one would do
// synchronous disk I/O on the UI thread throughout the drag.
let persistTimer = null;
function persistPosition() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    if (!win || win.isDestroyed()) return;
    const [x, y] = win.getPosition();
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(WINDOW_STATE, JSON.stringify({ x, y }));
    } catch {
      /* position is a nicety, not worth surfacing */
    }
  }, 300);
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
    if (/^https?:$/.test(new URL(url).protocol)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function push(force = false) {
  if (!win || win.isDestroyed()) return;

  let sessions;
  try {
    sessions = liveState();
  } catch {
    // This runs 2.5x a second against files other processes are writing. A
    // transient read error (antivirus lock, sharing violation) must not take the
    // window down — skip this tick.
    return;
  }

  const payload = JSON.stringify(sessions);
  if (!force && payload === lastPayload) return;
  lastPayload = payload;
  win.webContents.send('sessions', sessions);
}

/**
 * The cursor, pushed to the renderer so it can show the hover box without the
 * window ever taking focus. Sent only when it actually moves, and once when it
 * leaves — an idle cursor costs nothing beyond the poll itself, and the poll is
 * two synchronous geometry reads.
 */
function pushPointer() {
  if (!win || win.isDestroyed() || !win.isVisible()) return;

  let point = null;
  try {
    point = localPoint(win.getContentBounds(), screen.getCursorScreenPoint());
  } catch {
    // Both can throw while a display is being reconfigured. A dropped frame of
    // hover is not worth a crash in a window that has to stay up.
    return;
  }

  const key = point ? `${Math.round(point.x)},${Math.round(point.y)}` : '';
  if (key === lastPointer) return;
  lastPointer = key;

  win.webContents.send('pointer', point);
}

// Two overlays would sit on top of each other and fight over the saved position.
if (!app.requestSingleInstanceLock()) app.quit();

function sendStatus() {
  if (win && !win.isDestroyed()) win.webContents.send('connected', hooksInstalled());
}

app.whenReady().then(() => {
  // The app binary moves — a user drags it out of Downloads, an installer
  // replaces it on update — so the shim is rewritten from wherever we are now.
  // Doing it on every launch is what makes the wiring self-healing.
  if (hooksInstalled()) {
    try {
      writeShim();
    } catch {
      /* the existing shim may still be fine; not worth failing to start over */
    }
  }

  // Registered before the window exists, so the renderer's 'ready' cannot race
  // the handler into place.
  ipcMain.on('ready', () => {
    push(true);
    sendStatus();
  });
  ipcMain.on('quit', () => app.quit());

  // Editing the user's global Claude Code config is not something to do behind
  // their back, so it happens only when they ask for it in the window.
  ipcMain.on('connect', () => {
    try {
      installHooks();
    } catch (err) {
      dialog.showErrorBox('Could not connect to Claude Code', err.message);
    }
    sendStatus();
  });
  ipcMain.on('resize', (_e, height) => {
    if (!win || win.isDestroyed()) return;
    if (!Number.isFinite(height)) return;
    win.setBounds({ height: Math.min(2000, Math.max(1, Math.round(height))) }, false);
  });

  createWindow();

  // Polling rather than fs.watch: watch semantics differ across Windows and
  // macOS, and this also picks up the meta.json description that lands a beat
  // after SubagentStart fires.
  const timer = setInterval(() => push(), POLL_MS);
  const pointerTimer = setInterval(pushPointer, POINTER_MS);
  app.on('before-quit', () => {
    clearInterval(timer);
    clearInterval(pointerTimer);
  });
});

app.on('window-all-closed', () => app.quit());

// A corner overlay has no dock presence on macOS.
if (process.platform === 'darwin' && app.dock) app.dock.hide();
