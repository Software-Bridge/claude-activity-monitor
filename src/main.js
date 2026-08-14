'use strict';

const { app, BrowserWindow, dialog, ipcMain, screen, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./paths');
const { liveState } = require('./live-agents');
const { localPoint, dragBounds } = require('./pointer');
const { installHooks, hooksInstalled, writeShim } = require('./hooks-config');

const POLL_MS = 400;
// Faster than the state poll: this one is a cursor following a row, and anything
// slower than about a tenth of a second reads as lag rather than as hover.
const POINTER_MS = 90;
const WIDTH = 340;
const HEIGHT = 120;
// Small enough to park in a corner, large enough that the header still reads.
const MIN_WIDTH = 240;
const MIN_HEIGHT = 80;
// Far past any real display, so a bad number cannot produce a window that has to
// be resized back from off-screen.
const MAX_SIDE = 4000;
const MARGIN = 16;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Math.round(n)));
const WINDOW_STATE = path.join(DATA_DIR, 'window.json');

let win = null;
let lastPayload = '';
let lastPointer = '';

// The window auto-fits its height to its content until the moment the user drags
// an edge; from then on the height is theirs and the list scrolls inside it.
// Without this the auto-fit would simply undo every manual resize on the next
// render, a second later.
let userSized = false;
// The last height this process asked for, which is how a resize event caused by
// the auto-fit is told apart from one caused by a person. Seeded with the height
// the window opens at, so the very first event is not mistaken for a drag.
let appliedHeight = null;
// Where a grip drag began: the window's bounds and the cursor's screen position
// at pointerdown. Held for the life of the drag so every move resolves against a
// fixed reference rather than against a window that is itself moving. Null when
// no drag is in progress, which is also what makes a stray move a no-op.
let dragAnchor = null;

/**
 * The geometry the window was last left at. Position and size are validated
 * separately on purpose: a position can be stranded by a display that is no
 * longer attached, but a size the user chose is still the size they want on
 * whatever screen the window lands on.
 */
function savedBounds() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(WINDOW_STATE, 'utf8'));
  } catch {
    return {};
  }
  if (!raw || typeof raw !== 'object') return {};

  const out = {};
  const width = Number.isFinite(raw.width) ? Math.max(MIN_WIDTH, Math.round(raw.width)) : WIDTH;
  out.width = width;

  // Ignore a position left behind by a monitor that is no longer attached.
  if (Number.isFinite(raw.x) && Number.isFinite(raw.y)) {
    const onScreen = screen.getAllDisplays().some((d) => {
      const b = d.workArea;
      return raw.x >= b.x - width && raw.x <= b.x + b.width && raw.y >= b.y && raw.y <= b.y + b.height;
    });
    if (onScreen) Object.assign(out, { x: raw.x, y: raw.y });
  }

  // A height is restored only if it was the user's. An auto-fitted height belongs
  // to the content that produced it, and restoring it would open the window at
  // the size of a session list that no longer exists.
  if (raw.sized === true && Number.isFinite(raw.height)) {
    out.height = Math.max(MIN_HEIGHT, Math.round(raw.height));
    out.sized = true;
  }
  return out;
}

function defaultPosition(width = WIDTH) {
  const { workArea } = screen.getPrimaryDisplay();
  return {
    x: workArea.x + workArea.width - width - MARGIN,
    y: workArea.y + MARGIN,
  };
}

// 'moved' and 'resize' both fire continuously while dragging, so writing on each
// one would do synchronous disk I/O on the UI thread throughout the drag.
let persistTimer = null;
function persistBounds() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    if (!win || win.isDestroyed()) return;
    const [x, y] = win.getPosition();
    const [width, height] = win.getSize();
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(WINDOW_STATE, JSON.stringify({ x, y, width, height, sized: userSized }));
    } catch {
      /* geometry is a nicety, not worth surfacing */
    }
  }, 300);
}

/** Which height regime the renderer should lay itself out for. */
function sendSizing() {
  if (win && !win.isDestroyed()) win.webContents.send('sizing', userSized);
}

/**
 * A resize, from either source. Ours always lands on exactly the height we just
 * asked for; anything else is a person dragging an edge, and the first time that
 * happens the auto-fit stands down for good. Width needs no such test — nothing
 * in this process ever sets it.
 */
function onResized() {
  if (!win || win.isDestroyed()) return;
  const [, height] = win.getSize();
  if (!userSized && Math.abs(height - appliedHeight) > 1) {
    userSized = true;
    sendSizing();
  }
  persistBounds();
}

function createWindow() {
  const saved = savedBounds();
  const pos = Number.isFinite(saved.x) ? { x: saved.x, y: saved.y } : defaultPosition(saved.width);
  userSized = saved.sized === true;
  appliedHeight = saved.height || HEIGHT;

  win = new BrowserWindow({
    width: saved.width || WIDTH,
    height: appliedHeight,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    x: pos.x,
    y: pos.y,
    frame: false,
    transparent: true,
    resizable: true,
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
  win.on('moved', persistBounds);
  win.on('resize', onResized);

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
    // A restored manual height has to reach the renderer before its first
    // measurement, or it auto-fits once and undoes the size it just opened at.
    sendSizing();
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
    // Once the height is the user's, the renderer stops asking — but it is the
    // main process that owns the window, so the refusal is enforced here too.
    if (userSized) return;
    if (!Number.isFinite(height)) return;
    appliedHeight = Math.min(2000, Math.max(1, Math.round(height)));
    win.setBounds({ height: appliedHeight }, false);
  });

  /**
   * A grip drag. Unlike the auto-fit this is the user speaking, so it both sets
   * the size and puts the window into manual height for good.
   *
   * Everything is derived from an anchor taken once, at pointerdown: the window's
   * bounds and the cursor's *screen* position at that instant. Each move then
   * applies the screen-space delta to that anchor.
   *
   * This shape is load-bearing, and the obvious alternative is broken. Deriving
   * the size from the cursor's position *within the window* — which is what this
   * did first — measures against a frame the same code is moving: dragging the
   * south-west grip walks the left edge, so the origin those coordinates are
   * relative to shifts underneath the drag. Recovering from that needs the
   * current bounds, and `setBounds` is applied asynchronously by the macOS window
   * server, so `getBounds()` and the next `pointermove` disagree for a frame and
   * the error compounds into a visible jump. Windows applies it synchronously,
   * which is exactly why the fault showed on one platform and not the other.
   *
   * An anchored delta has no such loop: nothing it reads is anything it writes.
   * It also preserves where inside the grip the drag started, rather than
   * snapping the corner onto the cursor.
   */
  ipcMain.on('resize-start', (_e, req) => {
    if (!win || win.isDestroyed() || !req) return;
    if (!Number.isFinite(req.x) || !Number.isFinite(req.y)) return;
    const b = win.getBounds();
    dragAnchor = {
      corner: req.corner === 'sw' ? 'sw' : 'se',
      cursorX: req.x,
      cursorY: req.y,
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
    };
  });

  ipcMain.on('resize-end', () => {
    dragAnchor = null;
  });

  ipcMain.on('resize-to', (_e, req) => {
    if (!win || win.isDestroyed() || !req || !dragAnchor) return;

    const next = dragBounds(dragAnchor, { x: req.x, y: req.y }, {
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
      maxSide: MAX_SIDE,
    });
    if (!next) return;

    if (!userSized) {
      userSized = true;
      sendSizing();
    }
    appliedHeight = next.height;
    win.setBounds(next, false);
  });

  /**
   * Clicking a row jumps to the editor that session is running in.
   *
   * The path originates in the session's own hook payload, but it still arrives
   * over IPC, so it is checked here rather than trusted — only an absolute path
   * to a directory that presently exists is ever handed to the shell.
   *
   * `vscode://` rather than the `code` CLI on purpose: a GUI app inherits the
   * launcher's environment, not a login shell's, so `code` is routinely absent
   * from a bundled app's PATH even where it works fine in a terminal. That is
   * the same trap the hook shim exists to sidestep.
   *
   * Two limits are inherent rather than shortcuts. This lands in the right
   * *window*, not the right chat: the extension exposes `claude-vscode.focus`
   * but declares no URI handler, and the CLI has no command flag, so there is no
   * way in from outside. And a session is identified only as far as its cwd, so
   * two chats on one folder resolve alike.
   */
  ipcMain.on('reveal', (_e, cwd) => {
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return;
    try {
      if (!fs.statSync(cwd).isDirectory()) return;
    } catch {
      return; // moved or deleted since the session started
    }
    // encodeURI leaves '#' and '?' alone, and either would truncate the URL.
    const encoded = encodeURI(cwd).replace(/#/g, '%23').replace(/\?/g, '%3F');
    // vscode://file wants exactly one slash before the path. A POSIX cwd already
    // begins with one (/Users/…); a Windows cwd begins with the drive (C:/…) and
    // would otherwise fuse into vscode://fileC:/… — a URL VS Code silently drops.
    const url = 'vscode://file/' + encoded.replace(/^\/+/, '');
    Promise.resolve(shell.openExternal(url)).catch(() => {
      /* no handler registered for vscode:// — nothing useful to say about it */
    });
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
