'use strict';

const os = require('os');
const path = require('path');

const DATA_DIR = path.join(os.homedir(), '.claude-agent-ui');

/**
 * One file per live subagent, created on SubagentStart and unlinked on
 * SubagentStop. There is deliberately no shared mutable file: create and unlink
 * are atomic directory operations on every platform, so concurrent subagents
 * cannot corrupt each other's state, and nothing ever needs compacting.
 */
const LIVE_DIR = path.join(DATA_DIR, 'live');

const liveFileFor = (agentId) => path.join(LIVE_DIR, `${agentId}.json`);

/**
 * Claude Code writes per-subagent files beside the session transcript.
 * `transcript_path` is <projects>/<sanitized-cwd>/<session_id>.jsonl, so
 * deriving from it avoids reimplementing the cwd-sanitizing scheme.
 */
function subagentDir(transcriptPath, sessionId) {
  if (!transcriptPath || !sessionId) return null;
  return path.join(path.dirname(transcriptPath), sessionId, 'subagents');
}

/** Holds the agent's description — it is not in the hook payload. */
function metaPathFor(transcriptPath, sessionId, agentId) {
  const dir = subagentDir(transcriptPath, sessionId);
  return dir && agentId ? path.join(dir, `agent-${agentId}.meta.json`) : null;
}

/** Grows while the agent works, so its mtime is a real liveness signal. */
function transcriptPathFor(transcriptPath, sessionId, agentId) {
  const dir = subagentDir(transcriptPath, sessionId);
  return dir && agentId ? path.join(dir, `agent-${agentId}.jsonl`) : null;
}

module.exports = { DATA_DIR, LIVE_DIR, liveFileFor, metaPathFor, transcriptPathFor };
