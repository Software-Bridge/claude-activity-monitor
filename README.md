# claude-activity-monitor

A small always-on-top window showing what your Claude Code sessions are doing right now —
each chat window, what it is working on, and the subagents it has spawned.

Claude Code has no floating activity view — `/tasks`, `claude agents`, `/workflows`, `statusLine`
and `subagentStatusLine` are all terminal-bound. This is a frameless card you park in a corner
of the screen, driven by Claude Code hooks.

```
┌──────────────────────────────────────────┐
│ ● Claude Activity Monitor    1 active  × │
├──────────────────────────────────────────┤
│  my-api                        2m  WORKING│
│  ⋯ Bash  npm test                         │
│  │ Audit the payment module               │
│  │ Explore                           1m 4s│
├──────────────────────────────────────────┤
│  docs-site                    45s  WAITING│
│    waiting for you                        │
└──────────────────────────────────────────┘
```

Each section is one chat window. A session that has finished its turn is badged **waiting for
you** and held until you deal with it; leave it half an hour and it drops off as closed. A session actively
working shows the tool it is running and any subagents beneath it.

Rows are narrow, so anything too long to fit is cut off. Point at a row — no clicking, and the
window never takes focus — and a pane opens along the bottom with the whole of it: the full path,
the full command, every subagent description. It keeps up with the work while you read: a session
you are pointing at updates in place as its tool changes, and a subagent that finishes hands the
pane to whatever takes its slot.

Works on Windows 10/11 and macOS.

## Install

Grab the installer from [Releases](https://github.com/Software-Bridge/claude-activity-monitor/releases),
run the app, and press **Connect** — that registers the hooks. Then restart Claude Code (or run
`/hooks`) so it picks them up. No Node.js required: the app carries its own.

Drag the window by its header, and resize it from the grip in either bottom corner — useful if the
default card is small to read at your viewing distance. Both corners are there because whichever edge
of the screen you park the card against, one of them is facing away from it. Each holds the opposite
edge still: drag the right grip and the left edge stays put, drag the left grip and the right edge
does. It remembers both where you put it and how big you made it.

Until you resize it, the window's height follows its contents, growing and shrinking as sessions come
and go. Dragging the grip hands the height to you for good: the card then stays the size you left it
and the list scrolls inside. Click `×` to quit.

The builds are not code-signed yet, so the OS will warn you the first time:

- **Windows** — SmartScreen shows "Windows protected your PC": *More info* → *Run anyway*.
- **macOS** — Gatekeeper refuses a downloaded app: right-click the app → *Open* → *Open*.

## Running from source

Requires [Node.js](https://nodejs.org) 22.12+ — Electron 43's installer depends on an ESM-only
package, and under older Node its postinstall fails quietly, leaving `node_modules/electron` without
its platform binary while `npm install` still reports success.

```sh
npm install
npm run install-hooks   # or just press Connect in the window
npm start
```

`install-hooks` merges the session hooks (`SessionStart`, `SessionEnd`, `UserPromptSubmit`,
`PreToolUse`, `PostToolUse`, `Stop`, `Notification`) and the subagent hooks (`SubagentStart`,
`SubagentStop`) into your global `~/.claude/settings.json`, leaving any hooks you already have
untouched. To remove them again:

```sh
npm run uninstall-hooks
```

## Demo, and the smoke test

`npm run demo` fills the window for thirty seconds with three make-believe chat terminals, three
subagents each, all of them switching tasks at random — enough to see the layout, the badges and
the reaping behave without waiting for real work to happen. It drives the real `src/hook.js` with
real hook payloads, so what you see is what a live session produces.

```sh
npm run demo                                    # 30s, into the running window
node test/demo-activity.js --scenario=heist     # a different set of make-believe work
node test/demo-activity.js --seed=7 --speed=4   # reproducible, and four times faster
```

Scenarios are pure data in [test/scenarios/](test/scenarios/) — three terminals, each with a pool
of prompts, tool calls and subagent descriptions. Adding one is adding a file. Without `--live` the
run goes to a throwaway data directory instead of the one the window reads, which is how the test
uses it:

```sh
npm test
```

That runs every scenario at speed and asserts on the picture `live-agents.js` ends up with — three
sessions, nine subagents grouped under the right ones, descriptions resolved from disk, no stale
activity on a terminal that has handed back, and nothing left live after teardown. It is the only
test that covers the whole chain, and the only one that runs twelve actors at each other
concurrently.

## Recording a real session

A scenario is invented work. A *capture* is work that actually happened — your own
sessions, with their real ordering and real timing — replayed later as a demo.

```sh
npm run record start          # begin capturing
npm run record status         # what has been captured so far
npm run record stop <name>    # seal it and put it away
```

The switch is the existence of `~/.claude-agent-ui/recording.jsonl`: `src/hook.js`
appends to it when it is there and does nothing when it is not. So a capture starts
and stops mid-session, with no restart of Claude Code, no environment variable and
no change to `settings.json`. When nobody is recording the cost is one `existsSync`
per event, and the whole thing is wrapped so that a failure to record can never fail
the hook — a monitor must not break what it monitors, and a recorder must not break
the monitor.

`stop` **seals** the capture, and has to run while the session's files are still
around. `SubagentStart` carries no description — the window reads it from the
`meta.json` Claude Code writes beside the transcript — so sealing resolves each one
from disk and writes it into the recording. After that the recording stands alone.

Sealed captures land in `~/.claude-agent-ui/recordings/`, deliberately outside this
repo: one carries the real working directories, file names and prompt text of
whatever you were doing. Scrub before committing anything derived from one.

Replaying drives the same `src/hook.js` the demo does:

```sh
node test/replay-activity.js --file=<capture> --live
node test/replay-activity.js --file=<capture> --live --speed=4 --loop --max-gap=2
```

Two things in a capture cannot be replayed as they stand. `transcript_path` points
into the recording machine's `~/.claude/projects`, so the replay rebuilds an
equivalent tree under a temp root and repoints every payload at it — otherwise
descriptions never resolve and every agent is reaped as silent. And real elapsed
time is not watchable: a working session spends minutes between events, so gaps are
capped by `--max-gap` and the timeline scaled by `--speed`. Ordering is never
changed.

`npm test` covers the round trip: run the demo with recording on, seal it, replay
it, and assert the window ends up with the same picture — same sessions, same
subagents, same descriptions.

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
SubagentStart/Stop        ->  src/hook.js writes/deletes ~/.claude-agent-ui/live/<agent_id>.json
SessionStart, prompts,    ->  src/hook.js rewrites ~/.claude-agent-ui/sessions/<session_id>.json
  tool calls, Stop, …          with the session's latest state
                               └─> the window lists both directories every 400ms, groups the
                                   agents under their session by session_id, and re-renders
```

Subagents and sessions are stored differently on purpose. **A subagent file is immutable — one
create, one unlink** — because subagents start in parallel and a shared mutable file would race.
**A session file is mutable**, rewritten by each of its hooks in turn, because a single chat
window drives its own hooks in sequence; there is no concurrency within a session to race on, and
its state genuinely changes over its life (working → awaiting feedback → idle).

Clicking a session brings its editor window to the front, via a `vscode://file/<cwd>` URL. This
lands on the right *window*, not the right chat — the extension exposes no way in for that — and
two chats on one folder resolve alike. On Windows the first click prompts for permission to open
the protocol; approve it with *always allow* and later clicks are silent.

Removing a session is left entirely to the window, never to a hook: `SessionEnd` fires
unreliably in the VSCode extension (sometimes early, sometimes not at all), so instead every
terminal state just starts an idle clock, and the window reaps a session once it has been silent
past its grace. Three clocks, by state: fifteen seconds once `SessionEnd` has fired, thirty
minutes while awaiting feedback, ten while nominally working (a crash).

The awaiting-feedback grace is long on purpose. A session waiting on you does not get less worth
showing as it waits, and the point at which a floating monitor earns its place is exactly the point
you have looked away for a few minutes. It is finite only because a chat you simply *closed* was
last seen finishing its turn, and nothing from outside can tell that apart from one still waiting.

Because `Notification` never fires in the VSCode extension, "awaiting feedback" there means
*Claude finished its turn and it is your move* (from `Stop`), not specifically *a permission
prompt is open*. In the terminal CLI, where `Notification` does fire, the badge sharpens to
distinguish **needs permission** from a plain wait.

Four details are load-bearing for the subagent rows:

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

**Clicking a session does nothing the first time (Windows).** The first click hands a
`vscode://file/…` URL to the OS, and Windows asks permission to open it — the editor comes
forward only after you approve. Tick the *always allow* box in that prompt so it sticks;
otherwise every reveal waits on the dialog.

**A code change to the app isn't taking effect.** The window holds a single-instance lock, so a
fresh `npm start` while one is already running quietly exits and leaves the *old* build up. Fully
quit the running instance first (its `×`, or kill every `electron` process) before relaunching.

## Notes

Design decisions, the hook-availability matrix (which hooks fire in the VSCode extension versus the
terminal CLI, and which silently never do), prerequisites, naming pitfalls and open questions live
in [docs/claude-monitor-lessons.md](docs/claude-monitor-lessons.md).

## License

MIT
