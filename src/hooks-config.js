'use strict';

/**
 * Registers the SubagentStart / SubagentStop hooks in ~/.claude/settings.json.
 *
 * Claude Code is told to run a shim in our own data directory, never the app
 * binary directly. Two reasons:
 *
 *   - The binary moves. A user drags the .app out of Downloads; an installer
 *     replaces it on update. A path written into settings.json once, at install
 *     time, goes stale. The shim's path never changes, and the app rewrites the
 *     shim's *contents* on every launch, so the wiring heals itself.
 *   - Running Electron as a Node interpreter needs an environment variable set,
 *     and there is no way to write `VAR=value cmd` that works in both a POSIX
 *     shell and cmd.exe. A script file sidesteps the shell entirely.
 *
 * The shim exits 0 if the binary is missing, so an app that gets deleted without
 * being uninstalled leaves a harmless no-op behind rather than an error on every
 * subagent spawn.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DATA_DIR } = require('./paths');

const EVENTS = ['SubagentStart', 'SubagentStop'];
const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const WINDOWS = process.platform === 'win32';

const SHIM = path.join(DATA_DIR, WINDOWS ? 'hook.cmd' : 'hook.sh');

// Claude Code picks a shell based on what it finds on the machine. Pinning it
// removes the guesswork: a bare quoted path is a command in bash but merely a
// string in PowerShell, so no single command string works in both.
const SHELL = WINDOWS ? 'powershell' : 'bash';
const COMMAND = WINDOWS ? `& "${SHIM}"` : `"${SHIM}"`;

function writeFileAtomic(file, contents, mode) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, contents, mode ? { mode } : undefined);
  fs.renameSync(tmp, file); // A hook may be executing the old one right now.
}

/**
 * Point the shim at whatever is running us. Under Electron that is the app
 * binary, which carries its own Node and so needs no Node on the machine;
 * under the plain-node CLI it is just node.
 */
function writeShim() {
  const runtime = process.execPath;
  const asNode = Boolean(process.versions.electron);

  // Packaged code is read from app.asar, but the hook is spawned as a file by
  // another process, so it has to be one that exists on disk.
  const hook = path.join(__dirname, 'hook.js').replace('app.asar', 'app.asar.unpacked');

  const script = WINDOWS
    ? [
        '@echo off',
        `if not exist "${runtime}" exit /b 0`,
        ...(asNode ? ['set ELECTRON_RUN_AS_NODE=1'] : []),
        `"${runtime}" "${hook}"`,
        '',
      ].join('\r\n')
    : [
        '#!/bin/sh',
        `[ -x "${runtime}" ] || exit 0`,
        `${asNode ? 'ELECTRON_RUN_AS_NODE=1 ' : ''}exec "${runtime}" "${hook}"`,
        '',
      ].join('\n');

  fs.mkdirSync(DATA_DIR, { recursive: true });
  writeFileAtomic(SHIM, script, WINDOWS ? undefined : 0o755);
  return SHIM;
}

function load() {
  try {
    const settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      throw new Error('settings.json is not a JSON object');
    }
    return settings;
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new Error(`Could not read ${SETTINGS}. Fix it before running this.\n  ${err.message}`);
  }
}

/**
 * Recognise our own entries — including ones written by older versions, which
 * invoked src/hook.js directly rather than through a shim. Missing these would
 * leave a duplicate hook behind on upgrade, or fail to remove one on uninstall.
 */
const ours = (command) =>
  typeof command === 'string' &&
  command.includes('claude-agent-ui') &&
  ['hook.cmd', 'hook.sh', 'hook.js'].some((name) => command.includes(name));

const isOurs = (entry) => (entry.hooks || []).some((h) => ours(h.command));

function apply(remove) {
  const settings = load();
  settings.hooks = settings.hooks || {};

  for (const event of EVENTS) {
    const others = (settings.hooks[event] || []).filter((entry) => !isOurs(entry));

    if (remove) {
      if (others.length) settings.hooks[event] = others;
      else delete settings.hooks[event];
      continue;
    }

    settings.hooks[event] = [
      ...others,
      { matcher: '', hooks: [{ type: 'command', shell: SHELL, command: COMMAND }] },
    ];
  }

  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  writeFileAtomic(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
}

function installHooks() {
  writeShim();
  apply(false);
  return { settings: SETTINGS, shim: SHIM, command: COMMAND };
}

function removeHooks() {
  apply(true);
  try {
    fs.unlinkSync(SHIM);
  } catch {
    /* already gone */
  }
  return { settings: SETTINGS };
}

function hooksInstalled() {
  try {
    const settings = load();
    return EVENTS.every((e) => (settings.hooks?.[e] || []).some(isOurs));
  } catch {
    return false;
  }
}

module.exports = { installHooks, removeHooks, hooksInstalled, writeShim, SHIM, SETTINGS };
