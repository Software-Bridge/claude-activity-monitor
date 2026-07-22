# Claude Activity Monitor — lessons

Working notes on why this tool is built the way it is. Most of what follows was learned the
expensive way: by watching a hook that looked correct silently never fire, or a state machine that
was right on paper describe the wrong thing on screen.

Companion to [to-do.md](to-do.md): that one is *what is left* — known gaps, untested paths, and
decisions recorded so they are not re-litigated. This one is *why it ended up like this*.

## What the tool is for

A higher-level, hierarchical view of Claude Code activity: one section per chat window, each
showing that session's own state and the subagents it has spawned. Claude Code's built-ins
(`/tasks`, `claude agents`, `/workflows`, `statusLine`, `subagentStatusLine`) are all terminal-bound
and all scoped to a single session. The gap this fills is *across* sessions — which is the whole
point for the intended audience (see below), who run several projects in parallel.

## Claude Code hook reality

The single most important thing to internalise: **the hook set that fires depends on the surface
Claude Code is running on.** The VSCode extension is not the terminal CLI. Assuming parity will
produce a monitor that is silently, permanently blank in exactly one of them.

| Hook | VSCode extension | Terminal CLI | Notes |
| --- | --- | --- | --- |
| `SessionStart` | fires | fires | `/clear` reports `source: "startup"` instead of `"clear"` in the extension |
| `SessionEnd` | fires, unreliably | fires | Known to fire early in the extension — do not treat as authoritative |
| `UserPromptSubmit` | fires | fires | |
| `PreToolUse` / `PostToolUse` | fires | fires | Carries `tool_name` + `tool_input` |
| `Stop` | fires | fires | End of the main agent's turn |
| `Notification` | **never fires** | fires | The big one. Carries `notification_type` (`permission_prompt`, `idle_prompt`, …) |
| `SubagentStart` / `SubagentStop` | fires | fires | Carries `agent_id`, `agent_type`, and the **parent** `session_id` |
| `TaskCreated` / `TaskCompleted` | never fires | never fires | Never fire for Agent-tool subagents at all |
| `subagentStatusLine` | never fires | n/a | Richest data model available, and unusable in the extension |

Two consequences worth spelling out:

**Awaiting feedback is inferred, not observed.** `Notification` is the natural signal for "Claude
wants something from you", and it never fires in the extension. So the state is derived from `Stop`
instead: the turn ended, therefore it is your move. The cost is that a session parked on a
*permission prompt* is indistinguishable from one that simply finished — in the extension. In the
terminal CLI, where `Notification` does fire, `notification_type` sharpens the badge to
**needs permission**. Registering the hook is free either way, so it is registered regardless.

**Subagents sharing the parent `session_id` is a feature here.** It is logged upstream as a
limitation (you cannot tell *which* subagent triggered a given `PreToolUse`), but for grouping it is
exactly what is needed: every subagent already knows which chat window it belongs to, with no
correlation work required.

## Design decisions that fall out of the above

**Subagent records are immutable; session records are mutable.** Subagents start in parallel and
their hooks run as separate concurrent processes, so a shared mutable file would race — hence one
file per agent, created on start and unlinked on stop, where create and unlink are atomic directory
operations everywhere. A session is the opposite: one chat window drives its own hooks strictly in
sequence, and its state genuinely changes over its life (working → awaiting feedback → idle). So it
gets one mutable record, read-modify-written by each event, with a pid-suffixed temp file and an
atomic rename so a reader never sees a torn write.

**No hook ever deletes a session file.** The event that ought to (`SessionEnd`) is the least
trustworthy one on the list. So every terminal state merely starts an idle clock, and the *window*
does all reaping. This makes removal robust to a hook that fires early, late, or never.

**Reaping runs on per-state clocks.** A session awaiting feedback gets a short grace (one minute);
a session still marked working gets the long silence window (ten minutes) before it is presumed
crashed. A session with live subagents is never reaped — its children are proof of life.

**Liveness comes from transcript mtime, not a timeout.** A killed agent never fires its stop hook,
and start time cannot distinguish a long-running agent from a dead one. The subagent's own
transcript grows while it works, so its mtime is a real signal. Crucially the code distinguishes
*observed* silence from *unobservable* silence: if the transcript directory cannot even be located
(over-long Windows path, a record written across a WSL boundary), silence proves nothing and the row
is left alone. Treating that as death would regress to the dumb timeout this exists to replace.

## Build and run prerequisites

- **Node >= 22.12 is required**, not the 18+ the README long claimed. Electron 43's installer
  depends on `@electron/get`, which is ESM-only; under Node 18 the postinstall fails and silently
  leaves `node_modules/electron` without its platform binary. The failure mode is confusing:
  `npm install` reports success, and only `electron -v` reveals the missing runtime.
- **`ELECTRON_RUN_AS_NODE=1` is set inside VSCode terminals and the extension host.** It makes
  Electron boot as plain Node, so `npm start` dies on `Cannot read properties of undefined (reading
  'whenReady')`. Launch with `env -u ELECTRON_RUN_AS_NODE npm start`. The installed `.app` is
  unaffected, since it does not inherit the shell environment.
- Copying `node_modules` between platforms does not work — the Electron binary is platform-specific
  and must be downloaded by its own postinstall.

## The shim, and its one sharp edge

Claude Code is pointed at a small shim script in the data directory, never at the app binary
directly. The binary moves (dragged out of Downloads, replaced by an installer), and a path written
into `settings.json` once at install time goes stale; the shim's own path never changes, and the app
rewrites the shim's *contents* on every launch, so the wiring self-heals. A shim script also
sidesteps the fact that no single command string sets an environment variable in both a POSIX shell
and `cmd.exe`.

**The sharp edge:** the shim contains *absolute paths* to the runtime and to `hook.js`. Move or
rename the checkout and those paths dangle — and because the shim is deliberately written to
`exit 0` when the runtime is missing (so a deleted app degrades to a harmless no-op rather than an
error on every spawn), **hooks stop firing completely silently.** There is no error anywhere. After
moving the checkout, relaunch the app or re-run `npm run install-hooks` to rewrite the shim.

## Naming: two categories, do not conflate them

When renaming the project, references split into two groups that must be treated differently.

**Category A — repo/package identity.** The README title, the Releases URL, `package.json`'s `name`
and `repository.url`. These are free to change; nothing at runtime reads them.

**Category B — runtime identity.** The `~/.claude-agent-ui` data directory, the
`CLAUDE_AGENT_UI_DIR` environment override, and the hook error-log filename.

Ownership detection *used* to sit in Category B, and was its sharpest edge — worth recording as a
lesson in its own right. `hooks-config.js` recognised its own entries in `settings.json` by looking
for the substring `claude-agent-ui` in the hook command. That substring was only ever present by
accident: it came from the default data directory. So anyone who relocated `CLAUDE_AGENT_UI_DIR` —
precisely the WSL, devcontainer and snap/flatpak users the override exists for — made the code stop
recognising its own hooks. Installing appended a duplicate every time instead of replacing,
`hooksInstalled()` never returned true so the window sat on "Not connected" forever, and
uninstalling silently left everything behind. It now matches on the **shim path** instead. The
pre-shim v0.1 command is the one case still keyed to the project name, because a bare `src/hook.js`
is too generic to claim on its own and a false positive there would delete another tool's hook.

What remains coupled to the name is the *default* location: the recognised set deliberately includes
the shim under `~/.claude-agent-ui`, so that relocating the data directory after installing still
finds the old entry. Renaming the data directory would therefore still be a migration — the old
default has to stay in the recognised set, both environment variable names accepted, and the
existing directory adopted once.

The general lesson: **never derive identity from a string that is only incidentally there.** The
project name appeared in that path by default, not by design, and the code mistook a coincidence for
a contract.

The current position: **Category B is deliberately left alone.** It is invisible to users — the app
already presents itself as Claude Activity Monitor — so the churn would buy nothing but risk.

## Performance tradeoff

Showing the live tool/action line requires `PreToolUse` and `PostToolUse`, which means the hook runs
on *every tool call in every tracked session*, and `PreToolUse` runs before the tool does. With the
shim pointing at the app's bundled Electron-as-Node runtime, that is roughly 150–300 ms per call.
For the intended audience — several sessions in parallel — this is the most likely thing to become
annoying. Pointing the shim at a plain `node` binary when one is available would cut it
substantially, at the cost of the "no Node required on the machine" property the bundled runtime
provides.

## Audience, and what 1.0 means

Target: individual developers and small teams of power users, largely outside a corporate IT
structure, typically running several exploratory projects in parallel. That audience shapes the
release bar:

- **Code signing and notarization are *not* a 1.0 blocker.** This audience will right-click → Open
  without complaint. The cost (Apple Developer membership, notarization plumbing, a Windows
  Authenticode certificate) is not yet justified.
- Higher priority for 1.0, in order: **hook latency**, **verified Windows behaviour**, then the
  `hook.js` robustness edges below.

## Open questions

**Windows shows chat-level activity but no subagent activity.** Observed over a day of soak testing:
sessions appear and update correctly, but no agent rows ever appear, even against deliberately broad
and complex prompts.

What this *rules out*: the shim, the PowerShell invocation, and the whole hook delivery path work —
otherwise the session rows would not appear either. That narrows it to two candidates:

1. **No subagents were actually spawned.** Claude Code only spawns them via the Agent/Task tool, and
   a hard or broad problem does not compel delegation — it will often just do the work in the main
   loop. This is the leading hypothesis precisely because it is so easy to mistake for a bug.
2. **`SubagentStart` does not fire on that platform or version.**

To distinguish them, in order of cost: force a subagent explicitly (ask for an Explore/Plan agent by
name) and watch whether `%USERPROFILE%\.claude-agent-ui\live\` receives a file; check
`%TEMP%\claude-agent-ui-hook-errors.log` for breadcrumbs; and if needed dump raw payloads by
registering a `SubagentStart` hook that appends stdin to a file.

**Residual `hook.js` robustness edges** (all pre-existing, none introduced by session tracking):

- A *hung* — as opposed to failed — synchronous `fs` call on a bad data directory (stale NFS/FUSE
  mount) parks the event loop, so the 5-second self-kill timer never runs and the process is
  eventually killed by Claude Code's hook timeout with a non-zero exit. The timer defends against an
  idle loop, not a blocked one.
- A module-load failure (`paths.js` missing from `app.asar.unpacked`, a syntax error) exits non-zero
  before any handler is in scope.
- `os.homedir()` / `os.tmpdir()` run at module load, outside every `try`.
- There is no global `uncaughtException` handler as a last net.

## Planned

**Automated smoke tests**, serving double duty as cross-platform validation and as a demo of the
tool. This is end-to-end validation across platforms, distinct from the unit-level gaps tracked
under *Test coverage* in [to-do.md](to-do.md). The Windows finding above is the motivating case: a
smoke test that *explicitly forces* subagent spawns would have answered in seconds what a day of
organic soak testing left ambiguous.
Worth covering: a session appearing on `SessionStart`, the tool line updating on `PreToolUse`, a
forced subagent appearing and then clearing on `SubagentStop`, the flip to awaiting-feedback on
`Stop`, and the idle reap after the grace period.
