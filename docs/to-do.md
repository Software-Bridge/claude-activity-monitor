# To do

Known gaps and follow-up work, as of v0.2.0. Nothing here is blocking — the app
is working and packaged for Windows — but each item is a real hole rather than a
speculative nice-to-have.

Ordered roughly by value.

## Test coverage

`npm test` now covers hook registration and one end-to-end demo run per scenario
(`test/demo-activity.test.js`). The registration gaps that matter:

- **Claiming someone else's hook.** `ours()` refuses to claim a bare
  `src/hook.js` unless the command also mentions the project, because a false
  positive here *deletes another tool's configuration* — the most destructive
  failure the code has. Only the true branch is exercised; there is no fixture
  for a foreign hook that mentions `src/hook.js` without the project name. This
  is the most worthwhile test to add.
- **The shim itself.** Nothing asserts that `writeShim()` creates the file, that
  its contents carry `ELECTRON_RUN_AS_NODE` and the exits-0-if-the-binary-is-gone
  guard, or that `removeHooks()` unlinks it. Verified by hand, not locked down.
- **The written entry.** `shell` and `command` are never checked for
  correctness, only that they round-trip through `ours()` — which stays
  self-consistent even if both were wrong.
- **`load()` error paths.** A malformed or non-object `settings.json` should
  refuse to run rather than clobber; untested.

`live-agents.js` is now exercised, but only through the demo driver — one
happy-path shape (three sessions, nine agents, all of them young). Its reaping
rules are still untested, and they hold the subtlest behaviour in the codebase:
an agent hidden for silence but not deleted, a session reaped on the short
waiting grace versus the long working one, and the unknown-liveness case where
silence must not count against an agent at all. All of it is reachable directly
— the module is pure and already takes an injectable `now` — so those want unit
tests rather than more demo scenarios.

## Packaging and release

- **macOS build.** Now exercised: `npm run dist` on a Mac produces both DMGs
  (arm64 + x64) at v0.2.0, and the packaged app launches and runs with no Dock
  icon as configured. It still genuinely cannot be cross-built from Windows —
  DMG creation needs `hdiutil` and a real keychain — so each release needs a Mac.
- **Code signing.** Both platforms ship unsigned, so Windows SmartScreen and
  macOS Gatekeeper warn on first run. macOS is the worse experience: Gatekeeper
  reports a downloaded unsigned app as "damaged", which is a bad look for a tool
  that edits your Claude Code config. Fixing it means an Apple Developer account
  (~$99/yr) and a Windows cloud-signing certificate. Worth doing when the project
  has users, not before. The build config already leaves the hooks for it.
- **Auto-update.** Deliberately skipped. macOS auto-update requires a signed
  app, so it is blocked behind signing anyway. A "check GitHub Releases and open
  the page" prompt is a cheap interim step with no signing prerequisite.
- **No release has been cut.** The Windows installer builds but has never been
  published.

## Correctness details

Small, each with a known blast radius:

- **A hidden subagent does not protect its session.** `agentSessionIds` is built
  from *visible* agents, so a session whose only agent has gone quiet past
  `SILENT_FOR_MS` can be reaped in the same tick, taking both rows away
  together. Arguably correct, but it is an interaction nobody chose.
- **Windows reserved device names.** `CON`, `NUL`, `PRN`, `COM1`… are pure
  alphanumerics and pass `SAFE_ID`, so an `agent_id` of `nul` resolves to the
  device rather than a file. Real ids are hex, so this is theoretical; the
  failure is a write that vanishes, not an escape.
- **`subagentDir` does not validate the session segment.** `basename()` cannot
  return a separator, so there is no arbitrary traversal, but it can return
  `..` — a one-level escape if `transcript_path` is attacker-controlled.
  Read-only downstream, and the id in the leaf is still constrained. Rejecting
  `.` and `..` next to the existing empty-name check would close it.
- **`syntheticSession` start time.** Taken from the first agent seen for that id
  and never revised, so the section sorts by first-seen rather than earliest.

## Decided against

Recorded so they are not re-litigated:

- **Docker.** A container cannot give an always-on-top overlay on Windows or
  macOS — there is no native X server, and even with VcXsrv/XQuartz the window
  lives inside the X server rather than pinned to the desktop, which is the
  entire point of the app. The hook must run on the host regardless, since
  Claude Code spawns it; routing it through `docker exec` would put container
  startup on the critical path of every subagent spawn. A read-only web viewer
  container (mount the data dir, serve the UI over HTTP) is the one variant that
  would work, if a browser tab on a second monitor ever seems worth it.
- **Windows portable target.** A portable Electron exe self-extracts to a temp
  directory on each run, so `process.execPath` points somewhere that ceases to
  exist — the shim would be stale by construction.
- **Mac App Store.** The MAS build is sandboxed, cannot write to
  `~/.claude/settings.json` outside its container, and strips
  `ELECTRON_RUN_AS_NODE`, which kills the hook interpreter outright.

## Notes for whoever picks this up

Two environment traps cost real time and will again:

- `ELECTRON_RUN_AS_NODE=1` leaks in from VSCode's terminal and extension host,
  which makes Electron boot as plain Node and exit instantly with no output.
- Hooks inherit the `PATH` of whatever shell Claude Code spawns, which may not be
  the one that can see `node`.

Both are covered in the README's troubleshooting section.

And do not trust the documented hook payload shapes — dump a real one and look.
`SubagentStart` carries no description, `TaskCreated`/`TaskCompleted` never fire
for Agent-tool subagents, and `subagentStatusLine` never fires in the VSCode
extension at all. All three were discovered the hard way.
