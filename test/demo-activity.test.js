#!/usr/bin/env node
'use strict';

/**
 * Smoke test over the demo driver: run each scenario at speed into a throwaway
 * data directory and assert on the picture `live-agents.js` produces at the end.
 *
 * This is the only test that exercises the whole chain — hook payload in, record
 * files on disk, live state out — and it does it under concurrency the unit
 * tests cannot reach: twelve actors firing hooks at each other's directories.
 *
 * Three scenarios rather than one, because a single fixture only ever proves the
 * driver works on the fixture it was written against.
 */

const { execFileSync } = require('child_process');
const path = require('path');

const scenarios = require('./scenarios');

const DRIVER = path.join(__dirname, 'demo-activity.js');

// A full-length run is a demo, not a test. The speed multiplier keeps the event
// mix and the ordering identical and only compresses the clock.
const SPEED = 15;

function run(scenario, seed) {
  const out = execFileSync(
    process.execPath,
    [DRIVER, `--scenario=${scenario}`, `--seed=${seed}`, `--speed=${SPEED}`, '--json'],
    { encoding: 'utf8' }
  );
  return JSON.parse(out);
}

const results = [];
const check = (label, actual, expected) =>
  results.push({ label, actual, expected, ok: actual === expected });

let failed = 0;
let seed = 0;

for (const name of scenarios.names()) {
  seed++;
  console.log(`\n${name} (seed ${seed})`);
  results.length = 0;

  let s;
  try {
    s = run(name, seed);
  } catch (err) {
    console.log(`  ERROR  ${(err.stderr || err.message).toString().split('\n')[0]}`);
    failed++;
    continue;
  }

  const sessions = s.sessions;
  const agents = sessions.flatMap((x) => x.agents);

  check('three terminals are live', sessions.length, 3);

  // A synthetic section means an agent could not be matched to its session
  // record — the grouping key is broken, even though every row still shows.
  check('every terminal has a real session record', sessions.some((x) => x.synthetic), false);

  // Nine at all times: a change stops an agent and immediately spawns its
  // replacement, so the population is constant even as its members turn over.
  check('nine subagents are live', agents.length, 9);
  check('three per terminal', sessions.every((x) => x.agents.length === 3), true);

  // 'working…' is the placeholder for a description that could not be read, so
  // this is really a check that the meta file landed where paths.js looks.
  check('every subagent has its real description', agents.some((a) => a.description === 'working…'), false);

  // Terminals that are mid-turn must show what they are running; ones that have
  // handed back must show nothing rather than a stale tool.
  const working = sessions.filter((x) => x.state === 'working');
  check(
    'working terminals show a tool and a detail',
    working.every((x) => x.activity && x.activity.tool && x.activity.detail),
    true
  );
  check(
    'waiting terminals show no stale activity',
    sessions.filter((x) => x.state === 'waiting').every((x) => x.activity === null),
    true
  );

  // More than the nine it opened with: agents actually changed what they were
  // doing during the run. Deterministic, because the run is seeded.
  check('agents changed task during the run', s.agentSpawns > 9, true);
  check('every stopped agent left', s.agentStops, s.agentSpawns - 9);

  check('teardown leaves nothing live', s.liveFilesAfterTeardown, 0);

  for (const r of results) {
    if (!r.ok) failed++;
    const detail = r.ok ? '' : `  (got ${JSON.stringify(r.actual)}, want ${JSON.stringify(r.expected)})`;
    console.log(`  ${r.ok ? 'ok  ' : 'FAIL'}  ${r.label}${detail}`);
  }
}

console.log(failed ? `\n${failed} failing` : '\nall passing');
process.exit(failed ? 1 : 0);
