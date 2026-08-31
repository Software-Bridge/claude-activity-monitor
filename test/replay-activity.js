#!/usr/bin/env node
'use strict';

/**
 * Replays a captured session (see scripts/record.js) into the window.
 *
 *   node test/replay-activity.js --file=<capture>            # into a throwaway data dir
 *   node test/replay-activity.js --file=<capture> --live     # into the one the window reads
 *   node test/replay-activity.js --file=<capture> --live --speed=4 --loop
 *
 * Where `demo-activity.js` invents plausible work from a scenario, this replays
 * work that actually happened, with its real ordering and its real timing. Both
 * drive the *real* `src/hook.js` with real payloads, for the same reason: what
 * the window shows is then produced by the same code path a live session uses.
 *
 * Two things in a capture cannot be replayed as they stand, and are rewritten:
 *
 *   - `transcript_path` points into the recording machine's ~/.claude/projects.
 *     The window derives the subagent directory from it and reaps agents on its
 *     mtime, so replay rebuilds an equivalent tree under a temp root and points
 *     every payload at that instead.
 *   - Real elapsed time. A working session spends minutes between events, which
 *     is not watchable, so gaps are capped (--max-gap) and the whole timeline can
 *     be scaled (--speed). Ordering is never changed.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOOK = path.join(__dirname, '..', 'src', 'hook.js');

const DEFAULTS = {
  file: null,
  speed: 1, // divides every interval
  maxGapMs: 4_000, // the longest pause actually shown, before scaling
  live: false,
  loop: false,
  quiet: false,
  json: false,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

function fire(env, payload) {
  execFileSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    env,
    stdio: ['pipe', 'ignore', 'ignore'],
  });
}

function touch(file, what) {
  try {
    fs.appendFileSync(file, `${JSON.stringify({ t: Date.now(), what })}\n`);
  } catch {
    /* a replay must not die because a temp dir went away */
  }
}

function load(file) {
  const entries = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry && entry.payload && Number.isFinite(entry.t)) entries.push(entry);
    } catch {
      /* a torn trailing line is normal in a capture */
    }
  }
  if (!entries.length) throw new Error(`no usable events in ${file}`);
  entries.sort((a, b) => a.t - b.t);
  return entries;
}

/**
 * A transcript per recorded session and a subagents directory beside it, laid out
 * the way `src/paths.js` expects to derive one from the other. Session ids are
 * kept as captured: they already satisfy SAFE_ID, and keeping them means a replay
 * of a scrubbed capture shows exactly the ids the scrub chose.
 */
function buildWorld(entries, root) {
  const sessions = new Map();

  for (const { payload } of entries) {
    const id = payload.session_id;
    if (!id || sessions.has(id)) continue;

    const project = path.basename(payload.cwd || 'session').replace(/[^A-Za-z0-9_-]/g, '-') || 'session';
    const dir = path.join(root, 'projects', project);
    const transcript = path.join(dir, `${id}.jsonl`);
    const subagentsDir = path.join(dir, id, 'subagents');

    fs.mkdirSync(subagentsDir, { recursive: true });
    touch(transcript, 'session started');
    sessions.set(id, { id, project, cwd: payload.cwd, transcript, subagentsDir, agents: new Map() });
  }
  return sessions;
}

async function runReplay(options = {}) {
  const opts = { ...DEFAULTS, ...options };
  if (!opts.file) throw new Error('--file=<capture> is required');

  const entries = load(opts.file);
  const speed = Math.max(0.1, opts.speed);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cam-replay-'));
  const dataDir = opts.live ? null : path.join(root, 'data');
  if (dataDir) process.env.CLAUDE_AGENT_UI_DIR = dataDir;
  const env = process.env;

  const sessions = buildWorld(entries, root);
  const started = Date.now();
  let fired = 0;
  let spawns = 0;

  const log = (line) => {
    if (opts.quiet || opts.json) return;
    const t = ((Date.now() - started) / 1000).toFixed(1).padStart(6);
    console.log(`  ${t}s  ${line}`);
  };

  // The window reaps on file mtime, so a replayed session has to keep looking
  // alive between its events the way a real one does.
  const heartbeat = setInterval(() => {
    for (const session of sessions.values()) {
      touch(session.transcript, 'thinking');
      for (const agent of session.agents.values()) touch(agent.transcript, 'working');
    }
  }, 1_000);
  heartbeat.unref();

  const teardown = () => {
    clearInterval(heartbeat);
    for (const session of sessions.values()) {
      for (const agent of session.agents.values()) {
        fire(env, { hook_event_name: 'SubagentStop', session_id: session.id, agent_id: agent.id });
      }
      session.agents.clear();
      fire(env, {
        hook_event_name: 'SessionEnd',
        session_id: session.id,
        cwd: session.cwd,
        transcript_path: session.transcript,
      });
    }
    fs.rmSync(root, { recursive: true, force: true });
  };
  const onSignal = () => {
    teardown();
    process.exit(130);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  process.stdout.once('error', onSignal);

  const passes = opts.loop ? Infinity : 1;
  for (let pass = 0; pass < passes; pass++) {
    // Each pass gets its own origin. Timing is absolute against it rather than a
    // sleep per gap, so a slow hook cannot make the replay drift further behind
    // with every event — but a second pass measured against the *first* pass's
    // origin would be entirely in the past, and would replay at once.
    const origin = Date.now();
    let clock = 0; // where we are on the (compressed, scaled) timeline
    let previous = entries[0].t;

    for (const entry of entries) {
      const gap = Math.min(entry.t - previous, opts.maxGapMs);
      previous = entry.t;
      clock += gap / speed;
      await sleep(origin + clock - Date.now());

      const session = sessions.get(entry.payload.session_id);
      if (!session) continue;

      const payload = {
        ...entry.payload,
        transcript_path: session.transcript,
      };

      fire(env, payload);
      fired++;

      const event = payload.hook_event_name;
      if (event === 'SubagentStart' && payload.agent_id) {
        const transcript = path.join(session.subagentsDir, `agent-${payload.agent_id}.jsonl`);
        // Written after the event, because that is the order Claude Code writes it
        // in — the description is not in the payload, so the window sees the agent
        // for a moment before it can name it.
        fs.writeFileSync(
          path.join(session.subagentsDir, `agent-${payload.agent_id}.meta.json`),
          JSON.stringify({ description: entry.description || '' })
        );
        touch(transcript, 'spawned');
        session.agents.set(payload.agent_id, { id: payload.agent_id, transcript });
        spawns++;
        log(`${session.project}  ↳ spawned — ${entry.description || payload.agent_type || 'subagent'}`);
      } else if (event === 'SubagentStop' && payload.agent_id) {
        session.agents.delete(payload.agent_id);
        log(`${session.project}  ↳ done`);
      } else if (event === 'PreToolUse') {
        const input = payload.tool_input || {};
        const detail = input.command || input.file_path || input.pattern || input.query || '';
        log(`${session.project}  ⋯ ${payload.tool_name || 'tool'}  ${String(detail).slice(0, 60)}`);
      } else if (event === 'Stop') {
        log(`${session.project}  waiting for you`);
      }
    }
  }

  const { liveState } = require('../src/live-agents');
  const live = liveState();
  const summary = {
    file: opts.file,
    events: fired,
    sessions: sessions.size,
    agentSpawns: spawns,
    dataDir: dataDir || 'default',
    live: live.map((s) => ({
      project: s.project,
      state: s.state,
      agents: s.agents.map((a) => a.description || a.type),
    })),
  };

  teardown();
  summary.liveFilesAfterTeardown = liveState().reduce((n, s) => n + s.agents.length, 0);
  return summary;
}

function parseArgs(argv) {
  const opts = {};
  for (const arg of argv) {
    const [key, value] = arg.replace(/^--/, '').split('=');
    const camel = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (camel !== 'maxGap' && !(camel in DEFAULTS)) throw new Error(`unknown option "${arg}"`);
    opts[camel] = value === undefined ? true : /^[\d.]+$/.test(value) ? Number(value) : value;
  }
  if (opts.maxGap !== undefined) {
    opts.maxGapMs = opts.maxGap * 1000;
    delete opts.maxGap;
  }
  return opts;
}

if (require.main === module) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${err.message}\n\noptions: ${Object.keys(DEFAULTS).join(', ')}, max-gap`);
    process.exit(2);
  }
  runReplay(opts)
    .then((s) => {
      if (opts.json) console.log(JSON.stringify(s));
      else console.log(`\ndone — ${s.events} event(s), ${s.sessions} session(s), ${s.agentSpawns} subagent spawn(s)`);
    })
    .catch((err) => {
      console.error(err.stack || String(err));
      process.exit(1);
    });
}

module.exports = { runReplay, DEFAULTS };
