#!/usr/bin/env node
'use strict';

/**
 * Registers (or removes) the hooks that feed the monitor, for people running
 * from source. A packaged app does the same thing from its own window, since
 * there is no npm there to run this with.
 *
 * Usage:  node scripts/install-hooks.js [--remove]
 */

const { installHooks, removeHooks } = require('../src/hooks-config');

try {
  if (process.argv.includes('--remove')) {
    const { settings } = removeHooks();
    console.log(`Removed the agent-monitor hooks from ${settings}`);
  } else {
    const { settings, shim, command } = installHooks();
    console.log(`Installed SubagentStart and SubagentStop hooks in ${settings}`);
    console.log(`  ${command}`);
    console.log(`\nThe shim at ${shim} is rewritten each time the app starts, so it`);
    console.log('keeps working if node or the app moves.');
    console.log('\nOpen /hooks in Claude Code (or restart it) to pick up the change.');
  }
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
