#!/usr/bin/env node
'use strict';

/**
 * Getting the tool name into a forty-character row. Pure, so it is tested here
 * rather than through a window — the same reason `pointer.test.js` exists.
 *
 * Every "real" case below is a command taken verbatim from a capture of actual
 * sessions, because the whole problem is shaped by what people's commands
 * actually look like rather than by what one imagines them to look like.
 */

const { leadCommand } = require('../src/command');

const results = [];
const check = (label, actual, expected) =>
  results.push({ label, actual: JSON.stringify(actual), expected: JSON.stringify(expected) });

// The point of the exercise: the tool is past the visible width, behind a cd.
check(
  'a cd preamble is skipped',
  leadCommand('cd ~/dev/own/claude-activity-monitor && node scripts/record.js status'),
  '… node scripts/record.js status',
);
check(
  'a heredoc behind a cd still leads with the tool',
  leadCommand("cd ~/dev/pacvolt/ConfigTool && python3 - <<'PY'"),
  "… python3 - <<'PY'",
);

// Assignments are the other common preamble, and the one that overruns a row on
// its own: a scratchpad path is well over eighty characters before any command.
check(
  'a variable assignment is skipped',
  leadCommand('SP=/private/tmp/claude-501/-Users-x-dev-y/127342a7/scratchpad\nnode $SP/x.js'),
  '… node $SP/x.js',
);
check(
  'a quoted assignment with spaces is skipped',
  leadCommand('APP="dist/mac-arm64/Claude Activity Monitor.app" && ls "$APP"'),
  '… ls "$APP"',
);
check('an export is skipped', leadCommand('export FOO=bar && make all'), '… make all');

// This repo's own build and test commands.
check(
  'env and its options are skipped',
  leadCommand('env -u ELECTRON_RUN_AS_NODE npm run pack'),
  '… npm run pack',
);
check('a bare wrapper is skipped', leadCommand('sudo systemctl restart nginx'), '… systemctl restart nginx');

// Several preambles stack in real commands, and must come off one after another.
check(
  'stacked preambles all come off',
  leadCommand('cd /tmp && FOO=1 env -u BAR npm test'),
  '… npm test',
);

// A command that already leads with its tool must be left completely alone —
// an ellipsis there would claim something was dropped when nothing was.
check('an ordinary command is untouched', leadCommand('npm test'), 'npm test');
check(
  'a grep with flags is untouched',
  leadCommand('grep -n "state-dot" src/index.html | head -20'),
  'grep -n "state-dot" src/index.html | head -20',
);
check(
  'a leading tool with a cd later is untouched',
  leadCommand('ls ~/.claude/ 2>&1; echo hi'),
  'ls ~/.claude/ 2>&1; echo hi',
);

// The dangerous case: `cd` with nothing after it IS the command. Eating it would
// leave the row empty, which is worse than the problem being solved.
check('a bare cd is the command, and survives', leadCommand('cd ~/somewhere'), 'cd ~/somewhere');
check('an assignment alone survives', leadCommand('FOO=bar'), 'FOO=bar');

// Whitespace is collapsed for display, since a row is one line either way.
check('newlines collapse to spaces', leadCommand('npm test\n  --watch'), 'npm test --watch');

// Same contract as the other pure helpers: anything unusable is null, so the
// caller has one case rather than three.
check('a non-string is null', leadCommand(null), null);
check('a number is null', leadCommand(42), null);
check('an empty string is null', leadCommand(''), null);
check('whitespace only is null', leadCommand('   \n  '), null);

let failed = 0;
for (const r of results) {
  const ok = r.actual === r.expected;
  if (!ok) failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${r.label}${ok ? '' : `  (got ${r.actual}, want ${r.expected})`}`);
}
console.log(failed ? `\n${failed} failing` : '\nall passing');
process.exit(failed ? 1 : 0);
