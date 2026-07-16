'use strict';

/**
 * The live picture is a set of Claude Code sessions, each with its own state and
 * whatever subagents it has spawned. Subagents come from LIVE_DIR (one file each,
 * created and unlinked by their own hooks); sessions come from SESSIONS_DIR (one
 * mutable file each, rewritten by the session's hooks). This module reads both
 * and stitches them together by session_id.
 */

const fs = require('fs');
const path = require('path');
const {
  LIVE_DIR,
  SESSIONS_DIR,
  subagentDir,
  metaPathFor,
  transcriptPathFor,
} = require('./paths');

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

/**
 * A session that has finished its turn is "awaiting feedback": shown, badged, and
 * kept for a short grace period so a reply that lands quickly slots it straight
 * back to working. Sit silent past the grace and it is "completely idle" — pulled
 * from the window until something happens in it again.
 */
const WAITING_GRACE_MS = 60 * 1000;

/**
 * A session still marked "working" but silent this long has died without a Stop —
 * a crash, a closed terminal. Give it the same long benefit of the doubt a
 * subagent gets before dropping it.
 */
const WORKING_SILENT_MS = SILENT_FOR_MS;

/** Long past the point where a file could belong to anything still running. */
const GARBAGE_AFTER_MS = 24 * 60 * 60 * 1000;

// The description is immutable once written, so it is worth never re-reading.
const descriptions = new Map();

function projectOf(cwd) {
  return cwd ? cwd.split(/[\\/]/).filter(Boolean).pop() : null;
}

function describe(agent) {
  const cached = descriptions.get(agent.agent_id);
  if (cached) return cached;

  const metaPath = metaPathFor(agent.transcript_path, agent.agent_id);
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

/**
 * When the agent last showed signs of life, and whether we could tell at all.
 *
 * The distinction matters: if we cannot even find the directory Claude Code
 * keeps the subagent's files in — an overlong path on Windows, a record written
 * on the other side of a WSL boundary, a moved projects directory — then we have
 * no liveness signal, and silence tells us nothing. Treating that as death would
 * quietly turn this back into the dumb start-time timeout it exists to replace,
 * and hide agents that are running perfectly well.
 */
function lastActiveAt(agent) {
  const dir = subagentDir(agent.transcript_path);
  const transcript = transcriptPathFor(agent.transcript_path, agent.agent_id);

  if (transcript) {
    try {
      // Clamped so a coarse or backdated mtime can never age an agent past its
      // own start time and reap it on the first poll.
      return { at: Math.max(agent.startedAt, fs.statSync(transcript).mtimeMs), known: true };
    } catch {
      /* no transcript yet — fall through */
    }
  }

  // The directory is there but this agent has written nothing into it: it is
  // either seconds old or it died before its first message. Start time is then a
  // fair proxy, and the silence window will decide between those two.
  if (dir && fs.existsSync(dir)) return { at: agent.startedAt, known: true };

  return { at: agent.startedAt, known: false };
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

function readRecords(dir, now) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return []; // No directory yet: nothing has ever started.
  }

  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);

    let record;
    try {
      record = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      // Mid-write, or truncated by a killed hook. Retry next poll; only sweep it
      // once it is far too old to be a file anyone is still writing.
      discardIfGarbage(file, now);
      continue;
    }

    if (!record || typeof record !== 'object') {
      discardIfGarbage(file, now);
      continue;
    }
    record.file = file;
    out.push(record);
  }
  return out;
}

/** The live subagents, keyed for grouping under the session that spawned them. */
function readAgents(now) {
  const agents = [];
  const seen = new Set();

  for (const agent of readRecords(LIVE_DIR, now)) {
    // A record without these cannot be aged, and NaN comparisons fail open —
    // which would make it an immortal row. Treat it as garbage, not as an agent.
    if (!agent.agent_id || !Number.isFinite(agent.startedAt)) {
      discardIfGarbage(agent.file, now);
      continue;
    }
    seen.add(agent.agent_id);

    const { at, known } = lastActiveAt(agent);
    const quietFor = now - at;

    if (quietFor > GARBAGE_AFTER_MS) {
      discard(agent.file); // Certainly dead: nothing runs for a day in silence.
      continue;
    }
    // Only silence we can actually observe counts against an agent.
    if (known && quietFor > SILENT_FOR_MS) continue; // Hidden, but it can come back.

    agents.push({
      id: agent.agent_id,
      type: agent.agent_type || 'agent',
      description: describe(agent) || 'working…',
      cwd: agent.cwd,
      project: projectOf(agent.cwd),
      startedAt: agent.startedAt,
      session_id: agent.session_id || null,
    });
  }

  // Agents that stopped cleanly never pass through here again, so prune against
  // what is actually on disk rather than leaking a description per agent spawned.
  for (const id of descriptions.keys()) {
    if (!seen.has(id)) descriptions.delete(id);
  }

  return agents;
}

/** A session's transcript grows while it works, so its mtime is real liveness. */
function sessionLastActive(s) {
  let at = Number.isFinite(s.updatedAt) ? s.updatedAt : s.startedAt || 0;
  if (typeof s.transcript_path === 'string' && path.isAbsolute(s.transcript_path)) {
    try {
      at = Math.max(at, fs.statSync(s.transcript_path).mtimeMs);
    } catch {
      /* transcript gone or not there yet — the hook timestamp stands */
    }
  }
  return at;
}

/**
 * The live sessions, each reaped on its own clock: a working session gets the
 * long dead-crash window, a waiting one only the short feedback grace. A session
 * with live agents is never reaped — its own children are proof it is alive.
 */
function readSessions(now, agentSessionIds) {
  const sessions = [];

  for (const s of readRecords(SESSIONS_DIR, now)) {
    if (!s.session_id || !Number.isFinite(s.startedAt)) {
      discardIfGarbage(s.file, now);
      continue;
    }

    const at = sessionLastActive(s);
    const quietFor = now - at;
    const working = s.state === 'working';
    const hasAgents = agentSessionIds.has(s.session_id);

    const limit = working ? WORKING_SILENT_MS : WAITING_GRACE_MS;
    if (!hasAgents && quietFor > limit) {
      // Idle past its grace (or a working session gone silent for good). Unlike a
      // subagent this file is ours to remove: nothing else will, and a stale one
      // would otherwise linger the full garbage day.
      discard(s.file);
      continue;
    }

    sessions.push({
      id: s.session_id,
      cwd: s.cwd,
      project: projectOf(s.cwd),
      title: s.title || null,
      state: working ? 'working' : 'waiting',
      waiting: working ? null : s.waiting || 'turn',
      activity: s.activity && typeof s.activity === 'object' ? s.activity : null,
      startedAt: s.startedAt,
      agents: [],
    });
  }

  return sessions;
}

/**
 * Subagents can outlive — or precede — a session record: the session hooks may
 * not be installed, or the file may have been reaped while a long agent runs on.
 * Rather than drop the agent, stand up a minimal section for it so it still shows.
 */
function syntheticSession(agent) {
  return {
    id: agent.session_id || `agent:${agent.id}`,
    cwd: agent.cwd,
    project: agent.project,
    title: null,
    state: 'working',
    waiting: null,
    activity: null,
    startedAt: agent.startedAt,
    agents: [],
    synthetic: true,
  };
}

function liveState(now = Date.now()) {
  const agents = readAgents(now);
  const agentSessionIds = new Set(agents.map((a) => a.session_id).filter(Boolean));

  const byId = new Map();
  for (const session of readSessions(now, agentSessionIds)) byId.set(session.id, session);

  for (const agent of agents) {
    let session = agent.session_id && byId.get(agent.session_id);
    if (!session) {
      session = syntheticSession(agent);
      byId.set(session.id, session);
    }
    session.agents.push(agent);
  }

  const sessions = [...byId.values()];

  // Oldest agent first within a section — a fan-out that starts several in one
  // millisecond breaks the tie on id so the order never jitters.
  for (const session of sessions) {
    session.agents.sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
  }

  // Busiest sections first: working above waiting, then oldest session first.
  const rank = (s) => (s.state === 'working' ? 0 : 1);
  sessions.sort((a, b) => rank(a) - rank(b) || a.startedAt - b.startedAt || a.id.localeCompare(b.id));

  return sessions;
}

module.exports = { liveState };
