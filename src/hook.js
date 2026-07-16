#!/usr/bin/env node
'use strict';

/**
 * Claude Code hook target.
 *
 * Two kinds of thing are tracked, each as one small JSON file per entity:
 *
 *   - Subagents (SubagentStart / SubagentStop) — a start creates a file named
 *     after the agent, a stop deletes it. The live set is just the directory,
 *     with nothing for concurrent spawns to race on.
 *   - Sessions (SessionStart, UserPromptSubmit, Pre/PostToolUse, Stop,
 *     Notification, SessionEnd) — the chat window itself. Its record is mutable:
 *     each event rewrites it with the latest state. Safe because one session
 *     drives its own hooks in sequence.
 *
 * This runs on the critical path of every subagent spawn *and* every tool call,
 * so it stays minimal and always exits 0 — a monitor must never be able to break
 * the thing it monitors.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { LIVE_DIR, SESSIONS_DIR, liveFileFor, sessionFileFor } = require('./paths');

// Deliberately not under DATA_DIR: an unwritable DATA_DIR is the likeliest thing
// to need reporting, and a breadcrumb we cannot write is no breadcrumb at all.
const ERROR_LOG = path.join(os.tmpdir(), 'claude-agent-ui-hook-errors.log');

const fwd = (p) => (typeof p === 'string' ? p.replace(/\\/g, '/') : p);

// A write another hook may be reading right now: rename is atomic, a partial
// write is not. The pid keeps concurrent writers to the same file from colliding
// on the temp name.
function writeAtomic(file, contents) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, file);
}

// One short, human-facing line describing the tool call in flight. Pulled from
// whichever field a given tool actually carries; unknown tools just show their
// name. Trimmed hard because it has to fit one narrow row.
function toolDetail(input) {
  if (!input || typeof input !== 'object') return null;
  const base = (p) => (typeof p === 'string' ? p.split(/[\\/]/).filter(Boolean).pop() : null);
  const raw =
    input.command ||
    base(input.file_path) ||
    base(input.path) ||
    input.pattern ||
    input.query ||
    input.url ||
    input.description ||
    null;
  if (typeof raw !== 'string') return null;
  const one = raw.replace(/\s+/g, ' ').trim();
  return one.length > 80 ? one.slice(0, 79) + '…' : one || null;
}

// Read-modify-write the session record so one event's fields (the description of
// the tool in flight, say) don't clobber another's (the start time). A missing
// or unparseable file just means "start fresh".
function updateSession(sessionId, payload, patch) {
  const file = sessionFileFor(sessionId);
  if (!file) return;

  let prev = {};
  try {
    prev = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
  } catch {
    /* new session, or a torn read we can safely overwrite */
  }

  const now = Date.now();
  const next = {
    ...prev,
    session_id: sessionId,
    startedAt: Number.isFinite(prev.startedAt) ? prev.startedAt : now,
    updatedAt: now,
    // Later events carry fresher paths; earlier values are a fine fallback.
    cwd: fwd(payload.cwd) || prev.cwd,
    transcript_path: fwd(payload.transcript_path) || prev.transcript_path,
    title: payload.session_title || prev.title || null,
    ...patch,
  };

  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  writeAtomic(file, JSON.stringify(next));
}

function handleSubagent(event, payload) {
  const file = liveFileFor(payload.agent_id); // null if the id is not a safe filename
  if (!file) return;

  if (event === 'SubagentStop') {
    try {
      fs.unlinkSync(file);
    } catch (err) {
      // Already gone is the happy path. A Windows sharing violation (the window
      // reads this directory 2.5x a second, and antivirus scans it) is transient
      // and not worth failing over — the reaper sweeps the file either way.
      if (!['ENOENT', 'EPERM', 'EBUSY'].includes(err.code)) throw err;
    }
    return;
  }

  const record = JSON.stringify({
    startedAt: Date.now(),
    agent_id: payload.agent_id,
    agent_type: payload.agent_type,
    session_id: payload.session_id,
    // Forward slashes are absolute on Windows too, and unlike backslashes they
    // survive being re-parsed by a POSIX reader — which happens whenever the
    // hook and the window straddle WSL.
    cwd: fwd(payload.cwd),
    transcript_path: fwd(payload.transcript_path),
  });

  fs.mkdirSync(LIVE_DIR, { recursive: true });
  writeAtomic(file, record);
}

// A session's state is inferred from which hook last fired for it. Removal is
// left to the reader: no event here deletes a session file, because the events
// that would (SessionEnd) are the least reliable — so every terminal state just
// starts the idle clock and the window reaps once it actually runs down.
function handleSession(event, payload) {
  const sid = payload.session_id;
  if (!sid) return;

  switch (event) {
    case 'SessionStart':
      updateSession(sid, payload, {}); // upsert; state falls to 'waiting' if new
      break;
    case 'UserPromptSubmit':
      updateSession(sid, payload, { state: 'working', waiting: null, activity: null });
      break;
    case 'PreToolUse':
      updateSession(sid, payload, {
        state: 'working',
        waiting: null,
        activity: { tool: payload.tool_name || 'tool', detail: toolDetail(payload.tool_input) },
      });
      break;
    case 'PostToolUse':
      updateSession(sid, payload, { state: 'working', waiting: null, activity: null });
      break;
    case 'Stop':
      updateSession(sid, payload, { state: 'waiting', waiting: 'turn', activity: null });
      break;
    case 'Notification': {
      // Never fires in the VSCode extension; a bonus signal in the terminal CLI.
      const t = payload.notification_type;
      const waiting = t === 'permission_prompt' ? 'permission' : t === 'idle_prompt' ? 'idle' : 'turn';
      updateSession(sid, payload, { state: 'waiting', waiting, activity: null });
      break;
    }
    case 'SessionEnd':
      updateSession(sid, payload, { state: 'waiting', waiting: 'ended', activity: null });
      break;
    default:
      break;
  }
}

function main(raw) {
  let payload;
  try {
    // Some shells hand us a UTF-8 BOM, which JSON.parse rejects outright.
    payload = JSON.parse(raw.replace(/^﻿/, ''));
  } catch {
    return; // Not JSON; nothing useful to record.
  }

  // JSON.parse("null") succeeds, as does any bare literal.
  if (!payload || typeof payload !== 'object') return;

  const event = payload.hook_event_name;

  if (event === 'SubagentStart' || event === 'SubagentStop') {
    handleSubagent(event, payload);
  } else {
    handleSession(event, payload);
  }
}

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  stdin += chunk;
});

process.stdin.on('end', () => {
  try {
    main(stdin);
  } catch (err) {
    // Never fail the spawn we are observing. Leave a breadcrumb and move on.
    try {
      fs.appendFileSync(
        ERROR_LOG,
        `${new Date().toISOString()} ${err && err.stack ? err.stack : err}\n`
      );
    } catch {
      /* give up quietly */
    }
  }
  process.exit(0);
});

// An unhandled 'error' on stdin is rethrown as an uncaught exception, which would
// exit non-zero and surface as a hook failure. The payload is unreadable by then,
// so there is nothing to salvage — just leave quietly.
process.stdin.on('error', () => process.exit(0));

// If stdin is never closed, 'end' never fires and this process would sit on the
// critical path of a subagent spawn until Claude Code's hook timeout killed it.
setTimeout(() => process.exit(0), 5000).unref();
