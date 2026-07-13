'use strict';

const os = require('os');
const path = require('path');

/**
 * The hook and the window are separate processes and need not share a home
 * directory — under WSL, a devcontainer, or a snap/flatpak Electron, they
 * resolve different ones and the window silently stays empty forever. The
 * override is the escape hatch for those setups.
 */
const DATA_DIR =
  process.env.CLAUDE_AGENT_UI_DIR || path.join(os.homedir(), '.claude-agent-ui');

/**
 * One file per live subagent, created on SubagentStart and unlinked on
 * SubagentStop. There is deliberately no shared mutable file: create and unlink
 * are atomic directory operations on every platform, so concurrent subagents
 * cannot corrupt each other's state, and nothing ever needs compacting.
 */
const LIVE_DIR = path.join(DATA_DIR, 'live');

/**
 * Ids reach path.join from a hook payload and from file contents. path.join
 * normalizes "..", so an id may not contain a separator — and on Windows that
 * means backslash as well as forward slash, which makes the traversal surface
 * larger there than a POSIX-only check would catch. Real ids are hex or UUIDs.
 */
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const safe = (id) => typeof id === 'string' && SAFE_ID.test(id);

const liveFileFor = (agentId) =>
  safe(agentId) ? path.join(LIVE_DIR, `${agentId}.json`) : null;

/**
 * Claude Code keeps a subagent's files in a directory named after the session,
 * sitting beside the session transcript — so the directory is the transcript's
 * own name without its extension. Deriving it from `transcript_path` this way
 * avoids reimplementing the undocumented cwd-sanitizing scheme (which turns
 * C:\Users\me\dev\proj into c--Users-me-dev-proj).
 */
function subagentDir(transcriptPath) {
  if (typeof transcriptPath !== 'string' || !transcriptPath) return null;

  // A record written on Windows and read on POSIX (or vice versa) would be
  // re-parsed by the wrong path module: dirname() of a Windows path is "." on
  // POSIX, which yields a relative path that then resolves against whatever cwd
  // this process happens to have. Refuse rather than silently stat the wrong file.
  if (!path.isAbsolute(transcriptPath)) return null;

  const dir = path.dirname(transcriptPath);
  const session = path.basename(transcriptPath, path.extname(transcriptPath));
  if (!session) return null;

  return path.join(dir, session, 'subagents');
}

/** Holds the agent's description — it is not in the hook payload. */
function metaPathFor(transcriptPath, agentId) {
  const dir = subagentDir(transcriptPath);
  return dir && safe(agentId) ? path.join(dir, `agent-${agentId}.meta.json`) : null;
}

/** Grows while the agent works, so its mtime is a real liveness signal. */
function transcriptPathFor(transcriptPath, agentId) {
  const dir = subagentDir(transcriptPath);
  return dir && safe(agentId) ? path.join(dir, `agent-${agentId}.jsonl`) : null;
}

module.exports = { DATA_DIR, LIVE_DIR, liveFileFor, subagentDir, metaPathFor, transcriptPathFor };
