#!/usr/bin/env node
'use strict';

/**
 * The hover box, driven through the real renderer.
 *
 * There is no DOM here otherwise, so this runs the actual `src/index.html` in a
 * hidden Electron window with the actual preload, and feeds it sessions over the
 * same IPC channel the main process uses. Hovering is synthesised as a mousemove
 * at a point, which is exactly what the renderer resolves against — it looks up
 * what is under the cursor by coordinate rather than by tracking enter/leave —
 * so a scripted point is an honest stand-in for a real one.
 *
 * The cases that matter are the ones a static screenshot cannot show: the box
 * following live data while the cursor sits still, and following the *place*
 * rather than the element when the row underneath is replaced.
 */

const path = require('path');
const electron = require('electron');

// `electron` resolves to a path string under plain Node — and also under
// Electron itself when ELECTRON_RUN_AS_NODE leaks in from VSCode's terminal,
// which is the trap the README warns about. Either way, re-exec properly.
if (typeof electron === 'string') {
  const { spawnSync } = require('child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const run = spawnSync(electron, [__filename], { stdio: 'inherit', env });
  process.exit(run.status === null ? 1 : run.status);
}

const { app, BrowserWindow, ipcMain } = electron;

const SRC = path.join(__dirname, '..', 'src');
const now = Date.now();

// ------------------------------------------------------------ fixtures ----

const LONG_COMMAND = 'npm run flip -- --stack=7 --griddle=190 --syrup=rationed --raccoon=ejected';

const agent = (id, description, offset = 0) => ({
  id,
  type: 'Explore',
  description,
  cwd: '/Users/demo/dev/orbital-diner',
  project: 'orbital-diner',
  startedAt: now - offset,
  session_id: 'sess-1',
});

const session = (activity, agents) => ({
  id: 'sess-1',
  cwd: '/Users/demo/dev/orbital-diner',
  project: 'orbital-diner',
  title: null,
  state: 'working',
  waiting: null,
  activity,
  startedAt: now - 90_000,
  agents,
});

const FIRST = [
  session({ tool: 'Bash', detail: LONG_COMMAND }, [
    agent('a1', 'Work out why pancake #7 keeps coming out square', 64_000),
    agent('a2', 'Chase the raccoon out of the walk-in freezer', 12_000),
  ]),
];

// The same session a moment later: different tool, and the first agent has
// finished and been replaced by another in the same position.
const SECOND = [
  session({ tool: 'Grep', detail: 'syrup' }, [
    agent('a3', 'Audit the syrup ration before the rush', 1_000),
    agent('a2', 'Chase the raccoon out of the walk-in freezer', 14_000),
  ]),
];

// --------------------------------------------------------------- cases ----

const results = [];
const check = (label, actual, expected) =>
  results.push({ label, actual, expected, ok: actual === expected });

async function run(win) {
  const js = (code) => win.webContents.executeJavaScript(code);
  const settle = () => new Promise((r) => setTimeout(r, 60));

  const push = async (payload) => {
    win.webContents.send('sessions', payload);
    await settle();
  };

  // Hovering is a cursor position pushed from the main process — the renderer
  // never sees a mousemove of its own — so a test hover is that same message.
  const point = async (p) => {
    win.webContents.send('pointer', p);
    await settle();
  };

  const centreOf = (key) =>
    js(`(() => {
      const el = document.querySelector('[data-key="${key}"]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);

  const hoverRow = async (key) => {
    const at = await centreOf(key);
    if (!at) return false;
    await point(at);
    return true;
  };

  const box = () =>
    js(`(() => {
      const d = document.getElementById('detail');
      return { shown: !d.hidden, text: d.textContent, hovered: (document.querySelector('.hovered') || {}).dataset?.key || null };
    })()`);

  await push(FIRST);

  // The premise: the activity line really is too narrow to read in full.
  const elided = await js(`(() => {
    const el = document.querySelector('[data-key="act:sess-1"]');
    return el.scrollWidth > el.clientWidth;
  })()`);
  check('the activity line is clipped in the row', elided, true);

  check('nothing is shown before the cursor arrives', (await box()).shown, false);

  // 1. Hovering the clipped line shows the whole thing.
  await hoverRow('act:sess-1');
  let b = await box();
  check('hovering the activity opens the box', b.shown, true);
  check('the box holds the full command', b.text.includes(LONG_COMMAND), true);
  check('the box names the session', b.text.includes('orbital-diner'), true);
  check('the box carries the full path', b.text.includes('/Users/demo/dev/orbital-diner'), true);
  check('the hovered row is marked', b.hovered, 'act:sess-1');

  // The pane is meant to read as its own surface. Asserted as "not the card's
  // colour" rather than as a literal value, so the palette can be retuned
  // without editing a test, but cannot collapse back into the card unnoticed.
  const surfaces = await js(`(() => {
    const g = (el, p) => getComputedStyle(el).getPropertyValue(p);
    return {
      pane: g(document.getElementById('detail'), 'background-color'),
      card: g(document.getElementById('card'), 'background-color'),
      row: g(document.querySelector('.hovered'), 'background-color'),
    };
  })()`);
  check('the pane is not the card colour', surfaces.pane !== surfaces.card, true);
  check('the hovered row is tinted too', surfaces.row !== surfaces.card, true);

  // 2. The data changes under a cursor that has not moved.
  await push(SECOND);
  b = await box();
  check('the box stays open across a push', b.shown, true);
  check('it drops the command that finished', b.text.includes(LONG_COMMAND), false);
  check('it shows the tool now running', b.text.includes('Grep') && b.text.includes('syrup'), true);

  // 3. An agent row hands the box to whatever replaces it.
  await push(FIRST);
  await hoverRow('a:a1');
  b = await box();
  check('hovering an agent describes that agent', b.text.includes('pancake #7'), true);
  check('an agent box names its type', b.text.includes('Explore'), true);

  await push(SECOND);
  b = await box();
  check('a replaced agent hands over rather than closing', b.shown, true);
  check('the box follows the point to the new agent', b.text.includes('Audit the syrup ration'), true);
  check('and lets go of the one that finished', b.text.includes('pancake #7'), false);

  // 4. Off the rows, and off the window.
  const header = await js(`(() => {
    const r = document.querySelector('header').getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  await point(header);
  check('the header is not a hover target', (await box()).shown, false);

  await hoverRow('s:sess-1');
  check('hovering the heading opens it again', (await box()).shown, true);

  // What the poll sends the moment the cursor moves off the window.
  await point(null);
  check('a cursor that has left the window closes it', (await box()).shown, false);
}

// ---------------------------------------------------------------- boot ----

app.whenReady().then(async () => {
  if (process.platform === 'darwin' && app.dock) app.dock.hide();

  // The window the renderer asks to be resized to; the box growing the card has
  // to reach the main process or it would be drawn outside the window.
  // Honoured, not just recorded: the renderer resolves hovers with
  // elementFromPoint, and a point below the viewport is nothing at all — so a
  // window left at its opening height would put every agent row out of reach.
  const heights = [];
  ipcMain.on('resize', (_e, height) => {
    heights.push(height);
    if (win && !win.isDestroyed()) win.setContentSize(340, Math.max(1, Math.round(height)));
  });
  ipcMain.on('ready', () => {});

  const win = new BrowserWindow({
    width: 340,
    height: 120,
    show: false,
    webPreferences: {
      preload: path.join(SRC, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  let failed = 0;
  try {
    await win.loadFile(path.join(SRC, 'index.html'));
    await run(win);

    // Asserted last, over the whole run: opening the box has to have asked for
    // more window than the rows alone needed.
    check('the box asks the window to grow', Math.max(...heights) > Math.min(...heights), true);
  } catch (err) {
    console.log(`  ERROR  ${(err && err.message) || err}`);
    failed++;
  }

  for (const r of results) {
    if (!r.ok) failed++;
    const detail = r.ok ? '' : `  (got ${JSON.stringify(r.actual)}, want ${JSON.stringify(r.expected)})`;
    console.log(`  ${r.ok ? 'ok  ' : 'FAIL'}  ${r.label}${detail}`);
  }
  console.log(failed ? `\n${failed} failing` : '\nall passing');

  app.exit(failed ? 1 : 0);
});
