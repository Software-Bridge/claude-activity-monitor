#!/usr/bin/env node
'use strict';

/**
 * Round-trip over the capture machinery: run a demo with recording switched on,
 * seal the capture, replay it, and assert the window ends up with the same
 * picture the original run produced.
 *
 * The point is that all three legs go through the real `src/hook.js` — the demo
 * writes real payloads, the hook tees them, and the replay feeds the same
 * payloads back in. If the tee ever drops an event kind, or the replay stops
 * rebuilding the subagent tree the descriptions are read from, the second
 * picture stops matching the first and this fails.
 *
 * Recording is switched on by creating the destination file, which is why this
 * can set up a capture for a child process it does not otherwise control.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEMO = path.join(__dirname, 'demo-activity.js');
const REPLAY = path.join(__dirname, 'replay-activity.js');
const RECORD = path.join(__dirname, '..', 'scripts', 'record.js');

const SPEED = 15;
const SCENARIO = 'space-diner';

const results = [];
const check = (label, actual, expected) =>
  results.push({ label, actual, expected, ok: JSON.stringify(actual) === JSON.stringify(expected) });

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cam-record-test-'));
const captureDir = path.join(root, 'capture');
const replayDir = path.join(root, 'replay');
fs.mkdirSync(captureDir, { recursive: true });

let failed = 0;
try {
  // ---- capture -----------------------------------------------------------
  // --live means "use the data directory the environment names", which here is a
  // throwaway of our own rather than the user's.
  // TMPDIR too: the demo builds its fake Claude Code tree under os.tmpdir(), and
  // --keep leaves it behind. Pointing it inside our own root means this test's
  // cleanup removes that as well.
  const captureEnv = {
    ...process.env,
    CLAUDE_AGENT_UI_DIR: captureDir,
    TMPDIR: root,
    TEMP: root,
    TMP: root,
  };
  execFileSync(process.execPath, [RECORD, 'start'], { env: captureEnv, encoding: 'utf8' });

  const demo = JSON.parse(
    execFileSync(
      process.execPath,
      // --keep for two reasons, both of which a real capture gets for free:
      // the subagent meta files have to still exist when the capture is sealed,
      // and without it the capture's last events are the demo tearing itself
      // down, so a faithful replay would end on an empty window.
      [DEMO, `--scenario=${SCENARIO}`, '--seed=3', `--speed=${SPEED}`, '--live', '--keep', '--json'],
      { env: captureEnv, encoding: 'utf8' }
    )
  );

  const sealed = execFileSync(process.execPath, [RECORD, 'stop', 'test'], {
    env: captureEnv,
    encoding: 'utf8',
  });
  const capture = sealed.match(/to (\S+\.jsonl)/);
  check('the capture was sealed to a file', Boolean(capture), true);

  const file = capture[1].replace(/^~/, process.env.HOME || '~');
  const events = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

  const kinds = new Set(events.map((e) => e.payload.hook_event_name));
  check('the tee captured session events', kinds.has('PreToolUse'), true);
  check('the tee captured subagent starts', kinds.has('SubagentStart'), true);
  check('the tee captured subagent stops', kinds.has('SubagentStop'), true);

  // Sealing is the only chance to resolve these — the payload never carries them.
  const starts = events.filter((e) => e.payload.hook_event_name === 'SubagentStart');
  check('every captured spawn was sealed with its description', starts.every((e) => e.description), true);
  check('as many spawns as the demo reported', starts.length, demo.agentSpawns);

  // ---- replay ------------------------------------------------------------
  const replay = JSON.parse(
    execFileSync(
      process.execPath,
      [REPLAY, `--file=${file}`, '--live', `--speed=${SPEED * 4}`, '--max-gap=1', '--json'],
      { env: { ...process.env, CLAUDE_AGENT_UI_DIR: replayDir }, encoding: 'utf8' }
    )
  );

  check('every captured event was replayed', replay.events, events.length);
  check('the replay rebuilt every session', replay.sessions, demo.sessions.length);
  check('the replay spawned the same subagents', replay.agentSpawns, demo.agentSpawns);

  // The picture at the end, which is the thing a demo is for. Descriptions are
  // the sharp end: they are read from a meta file the replay has to write itself.
  const asPicture = (list) =>
    list
      .map((s) => ({ state: s.state, agents: [...(s.agents || [])].map((a) => a.description || a.type || a).sort() }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

  check('the replayed window matches the captured one', asPicture(replay.live), asPicture(demo.sessions));
  check('no description was lost in the round trip',
    replay.live.flatMap((s) => s.agents).some((d) => !d || d === 'working…'), false);

  check('teardown leaves nothing live', replay.liveFilesAfterTeardown, 0);
} catch (err) {
  console.log(`  ERROR  ${(err.stderr || err.message).toString().split('\n').slice(0, 3).join(' | ')}`);
  failed++;
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('\ncapture and replay');
for (const r of results) {
  if (!r.ok) failed++;
  const detail = r.ok ? '' : `  (got ${JSON.stringify(r.actual)}, want ${JSON.stringify(r.expected)})`;
  console.log(`  ${r.ok ? 'ok  ' : 'FAIL'}  ${r.label}${detail}`);
}
console.log(failed ? `\n${failed} failing` : '\nall passing');
process.exit(failed ? 1 : 0);
