# claude-agent-ui

A small always-on-top window showing which Claude Code subagents are running right now.

Claude Code has no floating agent view — `/tasks`, `claude agents`, `/workflows`, `statusLine`
and `subagentStatusLine` are all terminal-bound. This is a frameless card you park in a corner
of the screen, driven by Claude Code hooks.

```
┌──────────────────────────────┐
│ ● 2 agents running        ×  │
├──────────────────────────────┤
│ │ Audit the payment module   │
│ │ Explore  my-api      1m 4s │
│ │ Find the flaky test        │
│ │ Plan     my-api         12s│
└──────────────────────────────┘
```

Works on Windows 10/11 and macOS.

## Install

Requires [Node.js](https://nodejs.org) 18+.

```sh
npm install
npm run install-hooks
```

`install-hooks` merges `SubagentStart` and `SubagentStop` hooks into your global
`~/.claude/settings.json`, leaving any hooks you already have untouched. Open `/hooks` in
Claude Code (or restart it) to pick up the change.

Then run the window:

```sh
npm start
```

Drag it by its header; it remembers where you put it. Click `×` to quit.

To remove the hooks again:

```sh
npm run uninstall-hooks
```

## How it works

```
SubagentStart/Stop hook fires
  └─> src/hook.js appends one line to ~/.claude-agent-ui/events.jsonl
        └─> the window reduces that log to the set of live agents, and re-renders
```

Three details are load-bearing:

**It tracks a set of agent ids, never a counter.** A killed agent can fire `SubagentStart`
with no matching `SubagentStop`. A counter would drift permanently out of sync the first time
that happened; a set lets stale entries simply expire (after 30 minutes), so the display
self-heals.

**The log is append-only.** Subagents start in parallel and their hooks run concurrently. A
read-modify-write of a shared state file would race; a lone append of a short line does not.
The window does the reducing, so the hook stays on the fast path — it runs inside every
subagent spawn, and a monitor must never break the thing it monitors.

**The description does not come from the hook.** `SubagentStart` carries only `agent_id`,
`agent_type`, `session_id`, `cwd`, `prompt_id` and `transcript_path` — there is no task
description in it. The description lives in a sidecar Claude Code writes next to the subagent
transcript:

```
<projects>/<sanitized-cwd>/<session_id>/subagents/agent-<agent_id>.meta.json
  { "agentType": "Explore", "description": "Audit the payment module", ... }
```

Because it is keyed by `agent_id`, descriptions resolve exactly even when several agents of
the same type start in the same instant. The file lands a moment after the hook fires, so the
window fills it in on a later poll and shows `working…` until then.

Two things that look like they should work, but don't: `TaskCreated` / `TaskCompleted` never
fire for Agent-tool subagents, and `subagentStatusLine` — whose `tasks[]` is otherwise the
richest data model available — never fires in the VSCode extension.

Verified against Claude Code v2.1.207. If a future version changes these payloads, dump one
and look:

```jsonc
// in ~/.claude/settings.json
"SubagentStart": [{ "matcher": "", "hooks": [{ "type": "command", "shell": "bash",
  "command": "{ cat; echo; } >> ~/subagent-payload.jsonl" }] }]
```

## Troubleshooting

**Nothing appears in the window.** Check that `~/.claude-agent-ui/events.jsonl` is being
written. Hooks inherit the `PATH` of the shell Claude Code spawns, which may not be the one
that can see `node` — a Claude Code session started *before* you installed Node will not find
it. The installer pins the absolute path of the Node binary it ran under to avoid this; if you
later move or upgrade Node, re-run `npm run install-hooks`.

**`TypeError: Cannot read properties of undefined (reading 'whenReady')`.** Something in your
environment has set `ELECTRON_RUN_AS_NODE=1` (VSCode's integrated terminal and extension host
both do), which makes Electron boot as plain Node. Clear it and start again:

```sh
# PowerShell
Remove-Item Env:ELECTRON_RUN_AS_NODE; npm start

# bash
env -u ELECTRON_RUN_AS_NODE npm start
```

## License

MIT
