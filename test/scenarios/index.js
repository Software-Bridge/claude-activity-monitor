'use strict';

/**
 * Scenario templates for the demo driver. A scenario is pure data — three
 * terminals, each with a project, a pool of prompts, a pool of tool calls and a
 * pool of subagent descriptions — so a new demo is a new file here and nothing
 * else. The driver picks from the pools; it never invents text of its own.
 */

const fs = require('fs');
const path = require('path');

const DIR = __dirname;

function names() {
  return fs
    .readdirSync(DIR)
    .filter((f) => f.endsWith('.js') && f !== 'index.js')
    .map((f) => path.basename(f, '.js'))
    .sort();
}

/**
 * Validated on load rather than at first use: a malformed scenario would
 * otherwise surface thirty seconds into a demo as an undefined in the window.
 */
function load(name) {
  if (!/^[a-z0-9-]+$/.test(name) || !names().includes(name)) {
    throw new Error(`unknown scenario "${name}" (have: ${names().join(', ')})`);
  }

  const scenario = require(path.join(DIR, `${name}.js`));
  const terminals = scenario.terminals || [];

  // Three is the point of the exercise: fewer does not exercise the grouping,
  // and each terminal needs alternatives to switch between or nothing changes.
  if (terminals.length < 3) throw new Error(`${name}: needs at least 3 terminals`);
  for (const t of terminals) {
    for (const pool of ['prompts', 'tools', 'agents']) {
      if (!Array.isArray(t[pool]) || t[pool].length < 3) {
        throw new Error(`${name}/${t.project}: needs at least 3 ${pool}`);
      }
    }
    if (!t.project || !t.cwd) throw new Error(`${name}: a terminal is missing project or cwd`);
  }

  return scenario;
}

module.exports = { names, load, DIR };
