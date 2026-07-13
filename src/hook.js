#!/usr/bin/env node
'use strict';

/**
 * Claude Code hook target for SubagentStart / SubagentStop.
 *
 * Reads the hook payload as JSON on stdin. A start creates one small file named
 * after the agent; a stop deletes it. The set of live agents is therefore just
 * the contents of a directory — there is no shared file for concurrent spawns to
 * race on, and nothing to compact.
 *
 * This runs on the critical path of every subagent spawn, so it stays minimal
 * and always exits 0 — a monitor must never be able to break the thing it
 * monitors.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { LIVE_DIR, liveFileFor } = require('./paths');

// Deliberately not under DATA_DIR: an unwritable DATA_DIR is the likeliest thing
// to need reporting, and a breadcrumb we cannot write is no breadcrumb at all.
const ERROR_LOG = path.join(os.tmpdir(), 'claude-agent-ui-hook-errors.log');

const fwd = (p) => (typeof p === 'string' ? p.replace(/\\/g, '/') : p);

function main(raw) {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return; // Not JSON; nothing useful to record.
  }

  // JSON.parse("null") succeeds, as does any bare literal.
  if (!payload || typeof payload !== 'object') return;

  const { hook_event_name: event, agent_id: agentId } = payload;

  const file = liveFileFor(agentId); // null if the id is not a safe filename
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

  if (event !== 'SubagentStart') return;

  const record = JSON.stringify({
    startedAt: Date.now(),
    agent_id: agentId,
    agent_type: payload.agent_type,
    session_id: payload.session_id,
    // Forward slashes are absolute on Windows too, and unlike backslashes they
    // survive being re-parsed by a POSIX reader — which happens whenever the
    // hook and the window straddle WSL.
    cwd: fwd(payload.cwd),
    transcript_path: fwd(payload.transcript_path),
  });

  fs.mkdirSync(LIVE_DIR, { recursive: true });
  fs.writeFileSync(file, record);
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
