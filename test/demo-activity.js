#!/usr/bin/env node
'use strict';

/**
 * Demonstration driver: three chat terminals, three subagents each, all of them
 * changing what they are doing at random over about thirty seconds.
 *
 * It is a demo and a smoke test at once, which is why it drives the *real*
 * `src/hook.js` as a child process with real hook payloads rather than writing
 * the record files itself. Everything downstream of stdin is then exercised for
 * free — payload parsing, the atomic write, the session read-modify-write, the
 * subagent create/unlink — and what the window renders is the same picture a
 * live Claude Code session would produce.
 *
 * The parts Claude Code itself owns are faked, because the hook only ever sees
 * their paths: a session transcript per terminal and, beside it, a subagents
 * directory holding each agent's `.meta.json` (where the description lives) and
 * `.jsonl` (whose mtime is the liveness signal `live-agents.js` reaps on). Both
 * are appended to as the demo runs, so agents stay visibly alive for the right
 * reason rather than because thirty seconds is too short to reap them.
 *
 *   node test/demo-activity.js                    # 30s, into a throwaway data dir
 *   node test/demo-activity.js --live             # into the real one, so the window shows it
 *   node test/demo-activity.js --scenario=heist --seed=7
 *   node test/demo-activity.js --speed=10 --json  # what the smoke test runs
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scenarios = require('./scenarios');

const HOOK = path.join(__dirname, '..', 'src', 'hook.js');

const DEFAULTS = {
  scenario: 'space-diner',
  seed: 1,
  durationMs: 30_000,
  tickMs: 1_000, // how often a busy actor touches its transcript
  beatMs: 5_000, // how often each actor rolls to change what it is doing
  changeChance: 0.25,
  speed: 1, // divides every duration above; the smoke test runs this hot
  live: false, // write to the real data directory instead of a throwaway one
  keep: false, // leave the records behind instead of tearing down
  json: false,
  quiet: false,
};

// ------------------------------------------------------------ plumbing ----

/**
 * Seeded so a demo is reproducible: "it looked wrong on seed 12" has to be
 * something you can hand to someone else and see the same thing.
 */
function rngFrom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

/** A different member of `pool` than `current`, so a change is always visible. */
function pickOther(rng, pool, current) {
  const others = pool.filter((x) => x !== current);
  const from = others.length ? others : pool;
  return from[Math.floor(rng() * from.length)];
}

/**
 * One hook invocation, exactly as Claude Code makes it: payload on stdin, event
 * name inside it. Synchronous on purpose — the ordering of a session's events is
 * the thing the session record depends on, and a demo that raced its own hooks
 * would be testing something nobody ships.
 */
function fire(env, event, payload) {
  execFileSync(process.execPath, [HOOK], {
    input: JSON.stringify({ hook_event_name: event, ...payload }),
    env,
    stdio: ['pipe', 'ignore', 'ignore'],
  });
}

// -------------------------------------------------------------- actors ----

/**
 * The transcript files Claude Code would be writing. Appending a line is what
 * makes `lastActiveAt` and `sessionLastActive` see a live mtime; the content is
 * never read by anything, so one JSON line per touch is enough.
 */
function touch(file, what) {
  try {
    fs.appendFileSync(file, `${JSON.stringify({ t: Date.now(), what })}\n`);
  } catch {
    /* a demo must not die because a temp dir went away */
  }
}

function buildWorld(scenario, opts, root) {
  const projectsRoot = path.join(root, 'projects');

  return scenario.terminals.slice(0, 3).map((terminal, i) => {
    // Ids have to satisfy SAFE_ID in src/paths.js — alphanumerics, dash, underscore.
    const sessionId = `demo-${opts.seed}-${i + 1}`;
    const dir = path.join(projectsRoot, terminal.project.replace(/[^A-Za-z0-9_-]/g, '-'));
    const transcript = path.join(dir, `${sessionId}.jsonl`);

    // Beside the transcript, named after it: this is the layout paths.js derives
    // the subagent directory from, so getting it wrong here means no descriptions.
    const subagentsDir = path.join(dir, sessionId, 'subagents');
    fs.mkdirSync(subagentsDir, { recursive: true });
    touch(transcript, 'session started');

    return {
      label: terminal.project,
      terminal,
      sessionId,
      transcript,
      subagentsDir,
      state: 'working',
      prompt: null,
      tool: null,
      agents: [],
    };
  });
}

function base(session) {
  return {
    session_id: session.sessionId,
    cwd: session.terminal.cwd,
    transcript_path: session.transcript,
  };
}

function startAgent(ctx, session, description) {
  const n = ++ctx.spawns;
  const agentId = `demoagent${n}`;
  const type = ['Explore', 'general-purpose', 'Plan'][n % 3];

  // Claude Code writes the meta file a moment *after* SubagentStart fires — the
  // description is not in the payload — so write it the same way round here.
  fire(ctx.env, 'SubagentStart', {
    ...base(session),
    agent_id: agentId,
    agent_type: type,
  });
  fs.writeFileSync(
    path.join(session.subagentsDir, `agent-${agentId}.meta.json`),
    JSON.stringify({ description })
  );

  const agent = {
    id: agentId,
    type,
    description,
    transcript: path.join(session.subagentsDir, `agent-${agentId}.jsonl`),
  };
  touch(agent.transcript, 'spawned');
  session.agents.push(agent);
  ctx.log(session.label, `↳ ${type} spawned — ${description}`);
  return agent;
}

function stopAgent(ctx, session, agent) {
  fire(ctx.env, 'SubagentStop', { ...base(session), agent_id: agent.id });
  session.agents = session.agents.filter((a) => a !== agent);
  ctx.spawnsStopped++;
}

function submitPrompt(ctx, session, prompt) {
  session.prompt = prompt;
  session.state = 'working';
  fire(ctx.env, 'UserPromptSubmit', { ...base(session), prompt });
  ctx.log(session.label, `you: ${prompt}`);
  runTool(ctx, session, pickOther(ctx.rng, session.terminal.tools, session.tool));
}

function runTool(ctx, session, tool) {
  // PostToolUse first when something was already in flight: the session record
  // holds one activity at a time, and the window should never show a tool the
  // terminal has moved on from.
  if (session.tool) fire(ctx.env, 'PostToolUse', { ...base(session), tool_name: session.tool.tool });

  session.tool = tool;
  fire(ctx.env, 'PreToolUse', {
    ...base(session),
    tool_name: tool.tool,
    tool_input: toolInput(tool),
  });
  ctx.log(session.label, `⋯ ${tool.tool}  ${tool.detail}`);
}

/**
 * Shaped per tool the way the real payloads are, so `toolDetail()` in the hook
 * has to pick the right field rather than always finding one called `detail`.
 */
function toolInput(tool) {
  switch (tool.tool) {
    case 'Bash':
      return { command: tool.detail };
    case 'Read':
    case 'Edit':
    case 'Write':
      return { file_path: `/Users/demo/${tool.detail}` };
    case 'Grep':
      return { pattern: tool.detail };
    case 'WebSearch':
      return { query: tool.detail };
    case 'WebFetch':
      return { url: tool.detail };
    default:
      return { description: tool.detail };
  }
}

function finishTurn(ctx, session) {
  if (session.tool) {
    fire(ctx.env, 'PostToolUse', { ...base(session), tool_name: session.tool.tool });
    session.tool = null;
  }
  session.state = 'waiting';
  fire(ctx.env, 'Stop', base(session));
  ctx.log(session.label, 'waiting for you');
}

// ------------------------------------------------------------- the run ----

/**
 * One roll for one terminal. A waiting terminal can only be woken by a new
 * prompt; a working one either switches tool or hands back to the user.
 */
function changeSession(ctx, session) {
  if (session.state === 'waiting') {
    submitPrompt(ctx, session, pickOther(ctx.rng, session.terminal.prompts, session.prompt));
    return;
  }
  if (ctx.rng() < 0.25) {
    finishTurn(ctx, session);
    return;
  }
  runTool(ctx, session, pickOther(ctx.rng, session.terminal.tools, session.tool));
}

/**
 * An agent "doing something different" is a stop and a fresh spawn — that is
 * what a subagent finishing and another starting looks like on the wire, and it
 * is the pair of events most worth exercising repeatedly.
 */
function changeAgent(ctx, session, agent) {
  // Avoid every description already on screen in this terminal, not just this
  // agent's: two rows reading the same thing looks like a bug in the window.
  const live = new Set(session.agents.map((a) => a.description));
  const free = session.terminal.agents.filter((d) => !live.has(d));
  const next = free.length
    ? free[Math.floor(ctx.rng() * free.length)]
    : pickOther(ctx.rng, session.terminal.agents, agent.description);
  stopAgent(ctx, session, agent);
  ctx.log(session.label, `↳ ${agent.type} done — ${agent.description}`);
  startAgent(ctx, session, next);
}

async function runDemo(options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const scenario = scenarios.load(opts.scenario);
  const rng = rngFrom(opts.seed);

  const speed = Math.max(1, opts.speed);
  const durationMs = Math.round(opts.durationMs / speed);
  const tickMs = Math.max(50, Math.round(opts.tickMs / speed));
  const beatMs = Math.max(tickMs, Math.round(opts.beatMs / speed));

  // Fake Claude Code state (transcripts) lives beside the data directory the
  // hook writes to, so one rm at the end removes both.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cam-demo-'));
  const dataDir = opts.live ? null : path.join(root, 'data');

  // Set on this process, not just on the hooks' environment: `paths.js` resolves
  // the data directory once at require time, and the summary below reads the
  // live state from *this* process. One run per process, therefore — which is
  // why the smoke test spawns a child per scenario rather than looping in one.
  if (dataDir) process.env.CLAUDE_AGENT_UI_DIR = dataDir;
  const env = process.env;

  const started = Date.now();
  const ctx = {
    env,
    rng,
    spawns: 0,
    spawnsStopped: 0,
    log(label, line) {
      if (opts.quiet || opts.json) return;
      const t = ((Date.now() - started) / 1000).toFixed(1).padStart(5);
      console.log(`  ${t}s  ${label.padEnd(16)}  ${line}`);
    },
  };

  if (!opts.quiet && !opts.json) {
    console.log(`\n${scenario.name} — ${scenario.blurb}`);
    console.log(
      `  seed ${opts.seed}, ${Math.round(durationMs / 1000)}s, ` +
        `${Math.round(opts.changeChance * 100)}% chance of a change every ${beatMs / 1000}s`
    );
    console.log(`  data: ${dataDir || 'the real data directory'}\n`);
  }

  const sessions = buildWorld(scenario, opts, root);

  // A demo gets interrupted: Ctrl-C, or a pipe closing because the reader was a
  // `head`. Without this the records stay in the *real* data directory with no
  // hook left to remove them, and the window carries nine phantom agents until
  // the reaper eventually gets to them.
  const teardown = () => {
    for (const session of sessions) {
      for (const agent of [...session.agents]) stopAgent(ctx, session, agent);
      fire(env, 'SessionEnd', base(session));
    }
    fs.rmSync(root, { recursive: true, force: true });
  };
  const onSignal = () => {
    if (!opts.keep) teardown();
    process.exit(130);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  // Node turns a closed stdout into an EPIPE on the stream rather than a signal,
  // and an unhandled one would take the process down mid-run — piping the demo
  // into `head` is exactly how that happens.
  process.stdout.once('error', onSignal);

  for (const session of sessions) {
    fire(env, 'SessionStart', base(session));
    submitPrompt(ctx, session, session.terminal.prompts[0]);
    // Three subagents per terminal, from the front of its pool so the opening
    // frame of the demo is the same every time regardless of seed.
    for (let i = 0; i < 3; i++) startAgent(ctx, session, session.terminal.agents[i]);
  }

  // Tracked as a deadline rather than a modulo of the tick: under --speed the two
  // intervals round independently and need not divide each other any more.
  let nextBeat = beatMs;

  for (let elapsed = tickMs; elapsed <= durationMs; elapsed += tickMs) {
    await sleep(started + elapsed - Date.now());

    for (const session of sessions) {
      if (session.state === 'working') touch(session.transcript, 'thinking');
      for (const agent of session.agents) touch(agent.transcript, 'working');
    }

    if (elapsed < nextBeat) continue;
    nextBeat += beatMs;

    // Roll for every actor independently: three terminals plus their nine
    // agents, each with its own 25% chance of doing something else.
    for (const session of sessions) {
      if (rng() < opts.changeChance) changeSession(ctx, session);
      for (const agent of [...session.agents]) {
        if (rng() < opts.changeChance) changeAgent(ctx, session, agent);
      }
    }
  }

  // Read the picture the window would draw, from this process, before any
  // teardown removes it. Requiring it late matters: live-agents.js resolves the
  // data directory at require time from the environment set above.
  const { liveState } = require('../src/live-agents');
  const live = liveState();

  const summary = {
    scenario: scenario.name,
    seed: opts.seed,
    durationMs,
    dataDir: dataDir || 'default',
    agentSpawns: ctx.spawns,
    agentStops: ctx.spawnsStopped,
    sessions: live.map((s) => ({
      id: s.id,
      project: s.project,
      state: s.state,
      waiting: s.waiting,
      synthetic: Boolean(s.synthetic),
      activity: s.activity,
      agents: s.agents.map((a) => ({ type: a.type, description: a.description })),
    })),
  };

  if (!opts.keep) {
    teardown();
    summary.liveFilesAfterTeardown = liveState().reduce((n, s) => n + s.agents.length, 0);
  }

  return summary;
}

// ----------------------------------------------------------------- cli ----

function parseArgs(argv) {
  const opts = {};
  for (const arg of argv) {
    const [key, value] = arg.replace(/^--/, '').split('=');
    const camel = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    // `--duration=30` is the friendly spelling of durationMs; everything else
    // names its option exactly, so a typo is an error rather than a silent default.
    if (camel !== 'duration' && !(camel in DEFAULTS)) throw new Error(`unknown option "${arg}"`);
    opts[camel] = value === undefined ? true : /^[\d.]+$/.test(value) ? Number(value) : value;
  }
  if (opts.duration) {
    opts.durationMs = opts.duration * 1000;
    delete opts.duration;
  }
  return opts;
}

if (require.main === module) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${err.message}\n\noptions: ${Object.keys(DEFAULTS).join(', ')}`);
    console.error(`scenarios: ${scenarios.names().join(', ')}`);
    process.exit(2);
  }

  runDemo(opts)
    .then((summary) => {
      if (opts.json) console.log(JSON.stringify(summary));
      else console.log(`\ndone — ${summary.agentSpawns} agents spawned, ${summary.agentStops} stopped`);
    })
    .catch((err) => {
      console.error(err.stack || String(err));
      process.exit(1);
    });
}

module.exports = { runDemo, DEFAULTS };
