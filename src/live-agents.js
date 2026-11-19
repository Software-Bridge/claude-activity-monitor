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
const { leadCommand } = require('./command');

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
 * kept until it is stale enough to presume closed — at which point it is pulled
 * from the window until something happens in it again.
 *
 * This was a minute, on the reasoning that silence past a short grace meant the
 * session was idle. That reads the wrong way round. A session waiting on *you*
 * does not become less worth showing as time passes, it becomes more so, and the
 * moment an always-on-top monitor earns its place is exactly the moment you have
 * looked away for a few minutes. A minute's grace removed the signal precisely
 * when it started to matter.
 *
 * It cannot simply be infinite, though. `SessionEnd` is unreliable in the VSCode
 * extension, so a chat that was merely closed was last seen finishing its turn,
 * and would sit here forever. Nor can the two be told apart from outside:
 * transcript mtime stops advancing for a closed session and for one patiently
 * awaiting a reply alike. So this is a judgement call rather than a deduction —
 * long enough to step away and still come back to the truth, short enough that
 * closed windows clear themselves within a break rather than piling up all day.
 */
const WAITING_GRACE_MS = 30 * 60 * 1000;

/**
 * A session whose `SessionEnd` has fired is over, and gets only long enough on
 * screen to be seen going.
 *
 * The long feedback grace above exists for a session that finished its turn and
 * is waiting on *you* — it is holding a question open. An ended session is not
 * waiting for anything, so holding it for half an hour is not patience, it is
 * litter: the window fills with rows for chats that closed, including the very
 * short-lived ones a non-interactive `claude` run leaves behind.
 *
 * Acting on `SessionEnd` is safe here even though it is documented as
 * unreliable, and the reason is structural rather than optimistic. Every session
 * hook upserts, so a record removed in error is rebuilt in full by that
 * session's next event — a premature end costs a row that returns on the next
 * tool call, not a session that vanishes for good. Treating it as authoritative
 * is only unsafe where removal is permanent, and here it is not. The grace is
 * seconds rather than zero purely so an early fire cannot flicker the row.
 */
const ENDED_GRACE_MS = 15 * 1000;

/**
 * A session still marked "working" but silent this long has died without a Stop —
 * a crash, a closed terminal. Give it the same long benefit of the doubt a
 * subagent gets before dropping it.
 */
const WORKING_SILENT_MS = SILENT_FOR_MS;

/** Long past the point where a file could belong to anything still running. */
const GARBAGE_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * A healthy working session emits a tool event every few seconds. This much
 * silence at "working" is the cue to look at the transcript for a turn that died
 * on an API error — which fires no hook, so the record stays frozen at "working".
 * Kept above the noise of a slow single tool call so we do not read transcripts
 * of sessions that are simply busy.
 */
const STALL_AFTER_MS = 30 * 1000;

// The description is immutable once written, so it is worth never re-reading.
const descriptions = new Map();

/**
 * What the row shows against what was recorded. `lead` is the command with any
 * preamble skipped so the tool is visible in a narrow row; `detail` is left
 * exactly as the hook wrote it, because the hover pane shows that.
 */
function activityOf(activity) {
  if (!activity || typeof activity !== 'object') return null;
  const detail = typeof activity.detail === 'string' ? activity.detail : null;
  return { ...activity, lead: detail ? leadCommand(detail) : null };
}

// Keyed by transcript path; a frozen transcript is read once and remembered by
// its mtime, so a stalled session does not re-read the file every 400ms poll.
const apiErrorByTranscript = new Map();

/** A short badge label for the kind of API error, from the message text. */
function apiErrorLabel(text) {
  if (/safeguard|flagged/i.test(text)) return 'flagged';
  if (/rate limit/i.test(text)) return 'rate limited';
  if (/overloaded|capacity/i.test(text)) return 'overloaded';
  return 'API error';
}

/**
 * If the last assistant turn in the transcript ended in an API error, describe
 * it; otherwise null. Reads only the tail — the last assistant entry sits near
 * the end — and caches on mtime so a frozen transcript costs one read.
 */
function lastTurnApiError(transcriptPath) {
  if (typeof transcriptPath !== 'string' || !transcriptPath) return null;

  let stat;
  try {
    stat = fs.statSync(transcriptPath);
  } catch {
    return null;
  }
  const cached = apiErrorByTranscript.get(transcriptPath);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.result;

  let result = null;
  try {
    const span = Math.min(stat.size, 64 * 1024);
    const buf = Buffer.alloc(span);
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      fs.readSync(fd, buf, 0, span, stat.size - span);
    } finally {
      fs.closeSync(fd);
    }
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line || line[0] !== '{') continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue; // a torn first line from the tail window; skip it
      }
      if (o.type !== 'assistant') continue;
      // The last assistant entry decides: an API error there is a dead turn.
      if (o.isApiErrorMessage) {
        const c = o.message && o.message.content;
        const text =
          typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x.text || '').join('') : '';
        // Just the gist: the first sentence, capped, so the hover row stays short.
        const first = text.replace(/\s+/g, ' ').trim();
        const sentence = first.split('. ')[0];
        const detail = (sentence.length > 140 ? sentence.slice(0, 139) + '…' : sentence) || null;
        result = { label: apiErrorLabel(text), detail };
      }
      break;
    }
  } catch {
    result = null;
  }

  apiErrorByTranscript.set(transcriptPath, { mtimeMs: stat.mtimeMs, result });
  return result;
}

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

    // Subprocesses the session launched and left running past its turn. The record
    // stays 'waiting' (Claude itself is idle), so this keeps the long feedback
    // grace rather than the short crash window — a install can outlast 10 minutes.
    const background = Array.isArray(s.background)
      ? s.background.filter((b) => b && typeof b === 'object')
      : [];
    const hasBackground = background.length > 0;

    // Three clocks, not two: a working session may have crashed and gets the long
    // benefit of the doubt, a session awaiting your reply is held, and one that
    // announced its own end is neither of those.
    const limit = working
      ? WORKING_SILENT_MS
      : s.waiting === 'ended'
        ? ENDED_GRACE_MS
        : WAITING_GRACE_MS;
    if (!hasAgents && quietFor > limit) {
      // Idle past its grace (or a working session gone silent for good). Unlike a
      // subagent this file is ours to remove: nothing else will, and a stale one
      // would otherwise linger the full garbage day.
      discard(s.file);
      continue;
    }

    // A detached subprocess still running reads as busy, not as "your move": show
    // the row as active with a "running subprocess" line, not the waiting badge.
    const displayWorking = working || hasBackground;
    const ownActivity = s.activity && typeof s.activity === 'object' ? s.activity : null;
    const bgActivity = hasBackground
      ? {
          background: true,
          detail:
            background.length > 1
              ? `${background.length} subprocesses`
              : background[0].detail || null,
        }
      : null;

    let state = displayWorking ? 'working' : 'waiting';
    let waiting = displayWorking ? null : s.waiting || 'turn';
    let error = null;

    // A record stuck at "working" — no tool in flight, no subprocess, no agents,
    // and quiet — may be a turn that died on an API error, which fires no hook to
    // move it off "working". Confirm against the transcript before saying so, so a
    // session that is merely thinking for a while is left alone.
    if (working && !hasAgents && !hasBackground && !ownActivity && quietFor > STALL_AFTER_MS) {
      const apiErr = lastTurnApiError(s.transcript_path);
      if (apiErr) {
        state = 'stalled';
        waiting = null;
        error = apiErr;
      }
    }

    sessions.push({
      id: s.session_id,
      cwd: s.cwd,
      project: projectOf(s.cwd),
      title: s.title || null,
      state,
      waiting,
      activity: activityOf(ownActivity || bgActivity),
      error,
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
  // Working first, then stalled (a dead turn wants your attention before the
  // sessions merely waiting on you), then the rest.
  const rank = (s) => (s.state === 'working' ? 0 : s.state === 'stalled' ? 1 : 2);
  sessions.sort((a, b) => rank(a) - rank(b) || a.startedAt - b.startedAt || a.id.localeCompare(b.id));

  return sessions;
}

module.exports = { liveState };
