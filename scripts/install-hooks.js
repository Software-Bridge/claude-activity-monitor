#!/usr/bin/env node
'use strict';

/**
 * Registers (or removes) the SubagentStart / SubagentStop hooks that feed the
 * monitor, in ~/.claude/settings.json. Merges into the existing config so any
 * hooks you already have are preserved.
 *
 * Usage:  node scripts/install-hooks.js [--remove]
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const EVENTS = ['SubagentStart', 'SubagentStop'];
const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');

// Forward slashes work in both PowerShell and bash, and sidestep the backslash
// escaping that a Windows path would otherwise need inside a shell command.
const fwd = (p) => p.replace(/\\/g, '/');

const HOOK = fwd(path.join(__dirname, '..', 'src', 'hook.js'));

// Hooks inherit the PATH of whatever shell Claude Code spawns, which is not
// necessarily the one that can see `node` — a fresh Node install in particular
// is invisible to already-running sessions. Pin the interpreter we are running
// under instead of hoping `node` resolves.
const NODE = fwd(process.execPath);
const COMMAND = `"${NODE}" "${HOOK}"`;

// Match on our actual script path, not merely the project name: a bare
// "claude-agent-ui" substring could capture an unrelated hook and delete it.
const isOurs = (entry) =>
  (entry.hooks || []).some(
    (h) => typeof h.command === 'string' && h.command.includes('claude-agent-ui/src/hook.js')
  );

function load() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new Error(
      `Could not parse ${SETTINGS}. Fix the JSON before running this.\n  ${err.message}`
    );
  }
}

/**
 * Write via a temp file and rename. This is the user's global Claude Code
 * config: a truncated write here would break far more than this monitor.
 */
function save(settings) {
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  const tmp = `${SETTINGS}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  fs.renameSync(tmp, SETTINGS);
}

function main() {
  const remove = process.argv.includes('--remove');
  const settings = load();
  settings.hooks = settings.hooks || {};

  for (const event of EVENTS) {
    const existing = settings.hooks[event] || [];
    const others = existing.filter((entry) => !isOurs(entry));

    if (remove) {
      if (others.length) settings.hooks[event] = others;
      else delete settings.hooks[event];
      continue;
    }

    settings.hooks[event] = [
      ...others,
      { matcher: '', hooks: [{ type: 'command', command: COMMAND }] },
    ];
  }

  save(settings);

  if (remove) {
    console.log(`Removed the agent-monitor hooks from ${SETTINGS}`);
    return;
  }
  console.log(`Installed ${EVENTS.join(' and ')} hooks in ${SETTINGS}`);
  console.log(`  ${COMMAND}`);
  console.log('\nOpen /hooks in Claude Code (or restart it) to pick up the change.');
}

try {
  main();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
