#!/usr/bin/env node
'use strict';

/**
 * Capture control for turning a real session into a replayable demo.
 *
 *   node scripts/record.js start        # begin capturing
 *   node scripts/record.js status       # how much has been captured
 *   node scripts/record.js stop [name]  # seal the capture and put it away
 *
 * The switch is the *existence* of the capture file, which is why starting is
 * creating it and stopping is moving it away: `src/hook.js` needs no restart, no
 * environment variable and no change to settings.json to notice either.
 *
 * Sealing is the part that has to happen while the session is still around.
 * `SubagentStart` carries no description — the window reads it from the
 * `meta.json` Claude Code writes beside the transcript — so a capture on its own
 * replays as a row of unlabelled agents. `stop` resolves each one from disk and
 * writes it into the recording, after which the recording stands alone.
 *
 * Captures land in ~/.claude-agent-ui/recordings/, deliberately outside this
 * repo: one carries the real cwds, file names and prompt text of whatever was
 * being worked on. Scrub before committing anything derived from it.
 */

const fs = require('fs');
const path = require('path');

const { RECORDING_FILE, RECORDINGS_DIR, metaPathFor } = require('../src/paths');

const rel = (p) => p.replace(process.env.HOME || '~', '~');

function start() {
  if (fs.existsSync(RECORDING_FILE)) {
    const n = countLines(RECORDING_FILE);
    console.log(`already recording — ${n} event(s) so far in ${rel(RECORDING_FILE)}`);
    return;
  }
  fs.mkdirSync(path.dirname(RECORDING_FILE), { recursive: true });
  fs.writeFileSync(RECORDING_FILE, '');
  console.log(`recording to ${rel(RECORDING_FILE)}`);
  console.log('every hook event from every session is being captured — stop when done.');
}

function countLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

/** Lines are appended by concurrent hook processes; a torn last line is normal. */
function readLines(file) {
  const out = [];
  let dropped = 0;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry && typeof entry === 'object' && entry.payload) out.push(entry);
      else dropped++;
    } catch {
      dropped++;
    }
  }
  return { entries: out, dropped };
}

function status() {
  if (!fs.existsSync(RECORDING_FILE)) {
    console.log('not recording.');
    const sealed = fs.existsSync(RECORDINGS_DIR) ? fs.readdirSync(RECORDINGS_DIR) : [];
    if (sealed.length) console.log(`sealed captures in ${rel(RECORDINGS_DIR)}:\n  ${sealed.join('\n  ')}`);
    return;
  }
  const { entries } = readLines(RECORDING_FILE);
  const sessions = new Set();
  const events = {};
  for (const e of entries) {
    if (e.payload.session_id) sessions.add(e.payload.session_id);
    const name = e.payload.hook_event_name || '?';
    events[name] = (events[name] || 0) + 1;
  }
  const span = entries.length ? (entries[entries.length - 1].t - entries[0].t) / 1000 : 0;
  console.log(`recording — ${entries.length} event(s) over ${span.toFixed(0)}s, ${sessions.size} session(s)`);
  for (const [name, n] of Object.entries(events).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(5)}  ${name}`);
  }
}

/**
 * Resolve each subagent's description from the meta file the window reads it
 * from. Best effort by design: a subagent whose session has since been cleaned
 * up replays as its agent type alone, which is a worse demo but still a valid
 * one.
 */
function seal(entries) {
  const descriptions = new Map();
  let found = 0;
  let missing = 0;

  for (const { payload } of entries) {
    if (payload.hook_event_name !== 'SubagentStart') continue;
    const key = payload.agent_id;
    if (!key || descriptions.has(key)) continue;

    const meta = metaPathFor(payload.transcript_path, key);
    let description = null;
    try {
      description = JSON.parse(fs.readFileSync(meta, 'utf8')).description || null;
    } catch {
      /* the session's files are gone, or it never got one */
    }
    descriptions.set(key, description);
    if (description) found++;
    else missing++;
  }

  for (const entry of entries) {
    const d = descriptions.get(entry.payload.agent_id);
    if (d) entry.description = d;
  }
  return { found, missing };
}

function stop(name) {
  if (!fs.existsSync(RECORDING_FILE)) {
    console.error('not recording.');
    process.exitCode = 1;
    return;
  }

  const { entries, dropped } = readLines(RECORDING_FILE);
  if (!entries.length) {
    fs.unlinkSync(RECORDING_FILE);
    console.log('nothing was captured; removed the empty recording.');
    return;
  }

  const { found, missing } = seal(entries);

  const stamp = new Date(entries[0].t).toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const safe = (name || 'session').replace(/[^A-Za-z0-9_-]/g, '-');
  const out = path.join(RECORDINGS_DIR, `${stamp}-${safe}.jsonl`);

  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
  fs.writeFileSync(out, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  fs.unlinkSync(RECORDING_FILE);

  const span = (entries[entries.length - 1].t - entries[0].t) / 1000;
  console.log(`sealed ${entries.length} event(s) over ${span.toFixed(0)}s to ${rel(out)}`);
  console.log(`  subagent descriptions resolved: ${found}${missing ? `, unresolved: ${missing}` : ''}`);
  if (dropped) console.log(`  unreadable lines skipped: ${dropped}`);
  console.log('  replay it with:  node test/replay-activity.js --file=<path> --live');
}

const [command, name] = process.argv.slice(2);
if (command === 'start') start();
else if (command === 'stop') stop(name);
else if (command === 'status') status();
else {
  console.error('usage: record.js start | status | stop [name]');
  process.exit(2);
}
