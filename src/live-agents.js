'use strict';

/**
 * Reduces the append-only event log to the set of subagents that are live now.
 */

const fs = require('fs');
const { EVENT_LOG, metaPathFor } = require('./paths');

/**
 * An agent that started but never stopped is not necessarily running: it may
 * have been killed, or Claude Code may have exited before firing SubagentStop.
 * Tracking a set of ids (rather than a counter) means we can simply drop these,
 * so the display self-heals instead of drifting permanently out of sync.
 */
const STALE_AFTER_MS = 30 * 60 * 1000;

const COMPACT_ABOVE_BYTES = 2 * 1024 * 1024;

function readEvents() {
  let raw;
  try {
    raw = fs.readFileSync(EVENT_LOG, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }

  const events = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // A torn line from a concurrent append; the next read will see it whole.
    }
  }
  return events;
}

/** The description lives beside the subagent transcript, never in the hook payload. */
function describe(agent) {
  const metaPath = metaPathFor(agent.transcript_path, agent.session_id, agent.agent_id);
  if (!metaPath) return null;
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    return meta.description || null;
  } catch {
    // Written moments after SubagentStart fires, so a miss here just means
    // "not yet" — the next poll picks it up.
    return null;
  }
}

/** The surviving SubagentStart events, exactly as they were written. */
function liveStartEvents(now = Date.now()) {
  const live = new Map();

  for (const ev of readEvents()) {
    if (!ev.agent_id) continue;
    if (ev.event === 'SubagentStart') {
      live.set(ev.agent_id, ev);
    } else if (ev.event === 'SubagentStop') {
      live.delete(ev.agent_id);
    }
  }

  return [...live.values()].filter((ev) => now - ev.ts <= STALE_AFTER_MS);
}

function liveAgents(now = Date.now()) {
  const agents = [];
  for (const agent of liveStartEvents(now)) {
    agents.push({
      id: agent.agent_id,
      type: agent.agent_type || 'agent',
      description: describe(agent) || 'working…',
      cwd: agent.cwd,
      project: agent.cwd ? agent.cwd.split(/[\\/]/).filter(Boolean).pop() : null,
      startedAt: agent.ts,
    });
  }

  agents.sort((a, b) => a.startedAt - b.startedAt);
  return agents;
}

/**
 * The log grows forever otherwise. Safe only at startup, when this process is
 * the sole writer we know of; mid-session compaction would race the hooks.
 */
function compactIfLarge() {
  try {
    if (fs.statSync(EVENT_LOG).size < COMPACT_ABOVE_BYTES) return;
  } catch {
    return;
  }
  // Keep the start events verbatim. Rebuilding them from the reduced view would
  // drop session_id and transcript_path, and without those the description can
  // never be resolved again — a survivor would read "working…" forever.
  const kept = liveStartEvents()
    .map((ev) => JSON.stringify(ev))
    .join('\n');
  fs.writeFileSync(EVENT_LOG, kept ? kept + '\n' : '');
}

module.exports = { liveAgents, compactIfLarge, EVENT_LOG };
