# claude-agent-ui

A small always-on-top window showing which Claude Code subagents are running right now.

Claude Code has no floating agent view — `/tasks`, `claude agents`, `/workflows`, `statusLine`
and `subagentStatusLine` are all terminal-bound. This is a frameless card you park in a corner
of the screen, driven by Claude Code hooks.

```
┌────────────────────────────────────────┐
│ ● Claude Agent Monitor     2 agents  × │
├────────────────────────────────────────┤
│  │ Audit the payment module            │
│  │ Explore  my-api               1m 4s │
│  │ Find the flaky test                 │
│  │ Plan     my-api                 12s │
└────────────────────────────────────────┘
```

Works on Windows 10/11 and macOS.

## Install

Grab the installer from [Releases](https://github.com/Software-Bridge/claude-agent-ui/releases),
run the app, and press **Connect** — that registers the hooks. Then restart Claude Code (or run
`/hooks`) so it picks them up. No Node.js required: the app carries its own.

Drag the window by its header; it remembers where you put it. Click `×` to quit.

The builds are not code-signed yet, so the OS will warn you the first time:

- **Windows** — SmartScreen shows "Windows protected your PC": *More info* → *Run anyway*.
- **macOS** — Gatekeeper refuses a downloaded app: right-click the app → *Open* → *Open*.

## Running from source

Requires [Node.js](https://nodejs.org) 18+.

```sh
npm install
npm run install-hooks   # or just press Connect in the window
npm start
```

`install-hooks` merges `SubagentStart` and `SubagentStop` hooks into your global
`~/.claude/settings.json`, leaving any hooks you already have untouched. To remove them again:

```sh
npm run uninstall-hooks
```

## Building

```sh
npm run pack   # unpacked app in dist/, for a quick smoke test
npm run dist   # installers
```

macOS builds must be made on macOS (`hdiutil`, and signing needs a real keychain). On Windows,
electron-builder has to extract a signing toolchain that contains symlinks, which the OS only
permits for administrators — so the *first* build needs an elevated shell or Developer Mode
enabled. Once its cache is populated, ordinary builds work.

Two targets are deliberately absent, because both are quietly fatal to the way the hook runs:

- **A Windows `portable` exe** self-extracts to a temp directory on each run, so the path it
  reports for itself stops existing the moment it closes — the shim below would be written stale
  by construction.
- **A Mac App Store build** is sandboxed and strips `ELECTRON_RUN_AS_NODE`, which is exactly how
  the app runs its own hook. It also could not write to `~/.claude/settings.json`.

## How it works

```
SubagentStart  ->  src/hook.js writes ~/.claude-agent-ui/live/<agent_id>.json
SubagentStop   ->  src/hook.js deletes it
                     └─> the window lists that directory every 400ms and re-renders
```

Four details are load-bearing:

**The live set is a directory, not a counter and not a log.** A counter would drift
permanently out of sync the first time an agent was killed without firing `SubagentStop`.
A shared state file would race, because subagents start in parallel and their hooks run as
separate, concurrent processes. One file per agent avoids both: create and unlink are atomic
directory operations on every platform, so there is nothing for concurrent spawns to corrupt,
and nothing that ever needs compacting. It is also naturally idempotent — a duplicate start
rewrites the same file, a duplicate stop is a no-op, and a stop that somehow overtakes its own
start cannot strand a ghost row.

**The hook never fails.** It runs inside every subagent spawn, so it swallows every error,
guards against stdin that never closes, and always exits 0. A monitor must not be able to
break the thing it monitors.

**Liveness comes from the transcript, not a timeout.** A killed agent leaves its file behind.
Rather than guess from start time — which cannot tell a long-running agent from a dead one —
the window watches the mtime of the subagent's own transcript, which grows while it works.
Ten minutes of silence means it is gone. So a 40-minute agent still shows, and a crashed one
disappears without needing a Claude Code restart.

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

**Nothing appears in the window.** Check whether `~/.claude-agent-ui/live/` fills up while an
agent runs. If it stays empty, the hook is not running: hooks inherit the `PATH` of the shell
Claude Code spawns, which may not be the one that can see `node` — a Claude Code session
started *before* you installed Node will not find it. The installer pins the absolute path of
the Node binary it ran under to avoid this; if you later move or upgrade Node, re-run
`npm run install-hooks`. Any hook crash is recorded in
`<tmp>/claude-agent-ui-hook-errors.log`.

**The window stays empty under WSL, a devcontainer, or a snap/flatpak Electron.** The hook and
the window are separate processes, and in those setups they resolve different home
directories — so the hook writes somewhere the window never looks. Point both at the same
place with `CLAUDE_AGENT_UI_DIR`.

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
