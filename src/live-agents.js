'use strict';

/**
 * The live set is whatever is in LIVE_DIR, minus anything that has clearly died.
 */

const fs = require('fs');
const path = require('path');
const { LIVE_DIR, liveFileFor, metaPathFor, transcriptPathFor } = require('./paths');

/**
 * A killed agent never fires SubagentStop, so its file is never removed. Rather
 * than guess from start time — which cannot tell a long-running agent from a
 * dead one — we watch the subagent's own transcript, which grows while it works.
 * Silence for this long means it is gone, and we reap it. This is why the
 * display self-heals instead of drifting, and why a 40-minute agent still shows.
 */
const SILENT_FOR_MS = 10 * 60 * 1000;

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
      return Math.max(agent.startedAt, fs.statSync(transcript).mtimeMs);
    } catch {
      /* not created yet, or moved */
    }
  }
  return agent.startedAt;
}

function readLiveFiles() {
  let names;
  try {
    names = fs.readdirSync(LIVE_DIR);
  } catch {
    return []; // No directory yet: nothing has ever started.
  }

  const agents = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw = fs.readFileSync(path.join(LIVE_DIR, name), 'utf8');
      const agent = JSON.parse(raw);
      if (agent && agent.agent_id) agents.push(agent);
    } catch {
      // Being written right now, or unreadable. The next poll will see it.
    }
  }
  return agents;
}

function reap(agentId) {
  try {
    fs.unlinkSync(liveFileFor(agentId));
  } catch {
    /* already gone, or not ours to remove */
  }
  descriptions.delete(agentId);
}

function liveAgents(now = Date.now()) {
  const agents = [];

  for (const agent of readLiveFiles()) {
    if (now - lastActiveAt(agent) > SILENT_FOR_MS) {
      reap(agent.agent_id);
      continue;
    }
    agents.push({
      id: agent.agent_id,
      type: agent.agent_type || 'agent',
      description: describe(agent) || 'working…',
      cwd: agent.cwd,
      project: agent.cwd ? agent.cwd.split(/[\\/]/).filter(Boolean).pop() : null,
      startedAt: agent.startedAt,
    });
  }

  // Ties are the common case — a fan-out starts several agents in one
  // millisecond — so break them on id to keep row order stable.
  agents.sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
  return agents;
}

module.exports = { liveAgents };
