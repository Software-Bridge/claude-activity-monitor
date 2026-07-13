'use strict';

/**
 * The live set is whatever is in LIVE_DIR, minus anything that has gone quiet.
 */

const fs = require('fs');
const path = require('path');
const { LIVE_DIR, metaPathFor, transcriptPathFor } = require('./paths');

/**
 * A killed agent never fires SubagentStop, so its file is never removed. Rather
 * than guess from start time — which cannot tell a long-running agent from a
 * dead one — we watch the subagent's own transcript, which grows while it works.
 *
 * Silence only *hides* a row; it never deletes the file. An agent blocked in one
 * slow tool call is silent but alive, and deleting its file would remove it from
 * the window for good. Hiding instead means it reappears the moment it writes
 * again — quiet is a display state, not a death certificate.
 */
const SILENT_FOR_MS = 10 * 60 * 1000;

/** Long past the point where a file could belong to anything still running. */
const GARBAGE_AFTER_MS = 24 * 60 * 60 * 1000;

// The description is immutable once written, so it is worth never re-reading.
const descriptions = new Map();

function describe(agent) {
  const cached = descriptions.get(agent.agent_id);
  if (cached) return cached;

  const metaPath = metaPathFor(agent.transcript_path, agent.session_id, agent.agent_id);
  if (!metaPath) return null;

  try {
    const { description } = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    if (description) descriptions.set(agent.agent_id, description);
    return description || null;
  } catch {
    // Written a moment after SubagentStart fires, so a miss here just means
    // "not yet" — a later poll picks it up.
    return null;
  }
}

/** When the agent last wrote to its transcript; falls back to its start time. */
function lastActiveAt(agent) {
  const transcript = transcriptPathFor(agent.transcript_path, agent.session_id, agent.agent_id);
  if (transcript) {
    try {
      // Clamped so a coarse or backdated mtime can never age an agent past its
      // own start time and reap it on the first poll.
      return Math.max(agent.startedAt, fs.statSync(transcript).mtimeMs);
    } catch {
      /* not created yet, or moved */
    }
  }
  return agent.startedAt;
}

function discard(file) {
  try {
    fs.unlinkSync(file);
  } catch {
    /* already gone, or held open by something else */
  }
}

/** Files we cannot make sense of, once they are old enough to be certain. */
function discardIfGarbage(file, now) {
  try {
    if (now - fs.statSync(file).mtimeMs > GARBAGE_AFTER_MS) discard(file);
  } catch {
    /* nothing to do */
  }
}

function readLiveFiles(now) {
  let names;
  try {
    names = fs.readdirSync(LIVE_DIR);
  } catch {
    return []; // No directory yet: nothing has ever started.
  }

  const agents = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(LIVE_DIR, name);

    let agent;
    try {
      agent = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      // Mid-write, or truncated by a killed hook. Retry next poll; only sweep it
      // once it is far too old to be a file anyone is still writing.
      discardIfGarbage(file, now);
      continue;
    }

    // A record without these cannot be aged, and NaN comparisons fail open —
    // which would make it an immortal row. Treat it as garbage, not as an agent.
    if (!agent || !agent.agent_id || !Number.isFinite(agent.startedAt)) {
      discardIfGarbage(file, now);
      continue;
    }

    agent.file = file;
    agents.push(agent);
  }
  return agents;
}

function liveAgents(now = Date.now()) {
  const agents = [];
  const seen = new Set();

  for (const agent of readLiveFiles(now)) {
    seen.add(agent.agent_id);

    const quietFor = now - lastActiveAt(agent);
    if (quietFor > GARBAGE_AFTER_MS) {
      discard(agent.file); // Certainly dead: nothing runs for a day in silence.
      continue;
    }
    if (quietFor > SILENT_FOR_MS) continue; // Hidden, but it can come back.

    agents.push({
      id: agent.agent_id,
      type: agent.agent_type || 'agent',
      description: describe(agent) || 'working…',
      cwd: agent.cwd,
      project: agent.cwd ? agent.cwd.split(/[\\/]/).filter(Boolean).pop() : null,
      startedAt: agent.startedAt,
    });
  }

  // Agents that stopped cleanly never pass through here again, so prune against
  // what is actually on disk rather than leaking a description per agent spawned.
  for (const id of descriptions.keys()) {
    if (!seen.has(id)) descriptions.delete(id);
  }

  // Ties are the common case — a fan-out starts several agents in one
  // millisecond — so break them on id to keep row order stable.
  agents.sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
  return agents;
}

module.exports = { liveAgents };
