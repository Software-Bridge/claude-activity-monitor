#!/usr/bin/env node
'use strict';

/**
 * Claude Code hook target for SubagentStart / SubagentStop.
 *
 * Reads the hook payload as JSON on stdin and appends a single line to the
 * event log. It deliberately does no reading, reducing, or rewriting of the
 * log: several subagents can start at the same instant, and a read-modify-write
 * of a shared file would race. A lone O_APPEND write of a short line does not.
 *
 * This runs on the critical path of every subagent spawn, so it stays minimal
 * and always exits 0 — a monitor must never be able to break the thing it
 * monitors.
 */

const fs = require('fs');
const path = require('path');
const { DATA_DIR, EVENT_LOG } = require('./paths');

function main(raw) {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return; // Not JSON; nothing useful to record.
  }

  const event = payload.hook_event_name;
  if (event !== 'SubagentStart' && event !== 'SubagentStop') return;

  const line = JSON.stringify({
    ts: Date.now(),
    event,
    agent_id: payload.agent_id,
    agent_type: payload.agent_type,
    session_id: payload.session_id,
    cwd: payload.cwd,
    transcript_path: payload.transcript_path,
  });

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.appendFileSync(EVENT_LOG, line + '\n');
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
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.appendFileSync(
        path.join(DATA_DIR, 'hook-errors.log'),
        `${new Date().toISOString()} ${err && err.stack ? err.stack : err}\n`
      );
    } catch {
      /* give up quietly */
    }
  }
  process.exit(0);
});
