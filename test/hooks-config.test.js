#!/usr/bin/env node
'use strict';

/**
 * Hook registration has to survive being run repeatedly, must never claim
 * another tool's hooks, and must recognise its own across an upgrade or a
 * relocated data directory.
 *
 * Each case runs in a child process pointed at a throwaway home directory, so
 * the real ~/.claude/settings.json is never touched. The relocated case
 * deliberately uses a path with no trace of the project name in it: ownership
 * used to be inferred from that substring, so a data directory somewhere else
 * quietly stopped recognising its own hooks — installing duplicated them and
 * uninstalling left them behind.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG = path.join(__dirname, '..', 'src', 'hooks-config.js');
const STRANGER = 'echo some-other-tool';
const LEGACY = '"C:/Program Files/nodejs/node.exe" "C:/dev/claude-agent-ui/src/hook.js"';

// ---------------------------------------------------------------- child ----

function runCase() {
  const h = require(CONFIG);
  const settings = path.join(os.homedir(), '.claude', 'settings.json');
  const read = () => JSON.parse(fs.readFileSync(settings, 'utf8'));
  const entries = (event) => (read().hooks[event] || []).length;
  const raw = () => JSON.stringify(read());

  const results = [];
  const check = (label, actual, expected) =>
    results.push({ label, actual, expected, ok: actual === expected });

  // A pre-existing third-party hook, and one written by an older version.
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(
    settings,
    JSON.stringify({
      hooks: {
        SubagentStart: [
          { matcher: '', hooks: [{ type: 'command', command: STRANGER }] },
          { matcher: '', hooks: [{ type: 'command', command: LEGACY }] },
        ],
      },
    })
  );

  h.installHooks();
  check('recognises itself after install', h.hooksInstalled(), true);
  check('leaves a third-party hook alone', raw().includes('some-other-tool'), true);
  check('replaces a pre-shim entry', raw().includes('src/hook.js'), false);
  check('one entry per event', entries('SubagentStart'), 2); // stranger + ours

  h.installHooks();
  h.installHooks();
  check('installing again does not duplicate', entries('SubagentStart'), 2);
  check('installing again does not duplicate (session)', entries('SessionStart'), 1);

  h.removeHooks();
  check('gone after uninstall', h.hooksInstalled(), false);
  check('third-party hook still there', raw().includes('some-other-tool'), true);
  check('removes only its own entry', entries('SubagentStart'), 1);
  check('drops the event it introduced', 'SessionStart' in read().hooks, false);

  process.stdout.write(JSON.stringify(results));
}

// --------------------------------------------------------------- parent ----

function runCases() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cam-test-'));
  const cases = [
    { name: 'default data directory', dir: null },
    // Must not contain the project name: that is the regression.
    { name: 'relocated data directory', dir: path.join(root, 'relocated', 'data') },
  ];

  let failed = 0;
  for (const { name, dir } of cases) {
    const home = fs.mkdtempSync(path.join(root, 'home-'));
    const env = { ...process.env, HOME: home, USERPROFILE: home, __CAM_TEST_CHILD: '1' };
    if (dir) env.CLAUDE_AGENT_UI_DIR = dir;
    else delete env.CLAUDE_AGENT_UI_DIR;

    console.log(`\n${name}`);
    let results;
    try {
      results = JSON.parse(execFileSync(process.execPath, [__filename], { env, encoding: 'utf8' }));
    } catch (err) {
      console.log(`  ERROR  ${err.message.split('\n')[0]}`);
      failed++;
      continue;
    }

    for (const r of results) {
      if (!r.ok) failed++;
      const detail = r.ok ? '' : `  (got ${r.actual}, want ${r.expected})`;
      console.log(`  ${r.ok ? 'ok  ' : 'FAIL'}  ${r.label}${detail}`);
    }
  }

  fs.rmSync(root, { recursive: true, force: true });
  console.log(failed ? `\n${failed} failing` : '\nall passing');
  process.exit(failed ? 1 : 0);
}

if (process.env.__CAM_TEST_CHILD) runCase();
else runCases();
