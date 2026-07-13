'use strict';

const os = require('os');
const path = require('path');

const DATA_DIR = path.join(os.homedir(), '.claude-agent-ui');
const EVENT_LOG = path.join(DATA_DIR, 'events.jsonl');

/**
 * Locate the sidecar metadata Claude Code writes for a subagent.
 *
 * `transcript_path` is <projects>/<sanitized-cwd>/<session_id>.jsonl, and the
 * subagent files live in a directory named after the session beside it. Deriving
 * the path this way avoids reimplementing Claude Code's cwd-sanitizing scheme.
 */
function metaPathFor(transcriptPath, sessionId, agentId) {
  if (!transcriptPath || !sessionId || !agentId) return null;
  return path.join(
    path.dirname(transcriptPath),
    sessionId,
    'subagents',
    `agent-${agentId}.meta.json`
  );
}

module.exports = { DATA_DIR, EVENT_LOG, metaPathFor };
