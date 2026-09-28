# harness — the multi-harness port

The server speaks ONLY this port ([docs/api/overview.md](../docs/api/overview.md), "harness port").
Seven verbs, nothing else:

| Verb | Signature | Purpose |
|---|---|---|
| `spawn` | `(cwd, prompt, opts?) → HarnessRef` | birth an agent session |
| `send` | `(ref, text)` | type into a session, with **verified** submission |
| `alive` | `(ref) → bool` | liveness — throws when it cannot tell |
| `resumable` | `(ref, opts?) → bool` | introspection: would `resume` restore memory? |
| `resume` | `(ref, opts?) → HarnessRef` | reincarnate a dead session with memory when possible |
| `kill` | `(ref)` | end a session for good — idempotent, dead ref is a no-op |
| `onTurnEnd` | `(ref, hook, opts?) → unsubscribe()` | turn-boundary detection, push not poll |

`opts` is ONE bag across `spawn`, `resumable`, `resume`, `onTurnEnd` and
`runCommand`/`status`/`brief`: `stateDir`, `callbackUrl`, `extraArgs`, `model`, `effort`,
`allowRoot`, `permissionMode`, `installHooks`, `session`, `window`. `model` and `effort`
are TYPED options (see "Typed options" below). All verbs may be async. Zero dependencies —
plain Node (>= 18; uses `node:test`, `fetch`). Beyond the seven, a harness MAY
expose **optional capability verbs** — see below. This README is the one place
their contract is written down; `port.js` points here.

## Adapter family, profile, derived profile

A harness is an **adapter family** plus a **profile**.

- An **adapter family** implements the verbs once for one kind of backend. The
  families are kernel and few: `tmux` (`tmux-adapter.js`, a TUI in a tmux pane),
  `acp` (an Agent Client Protocol session, `acp-adapter.js`) and `fake` (tests).
- A **profile** is the facts about ONE CLI: its launch lines, the screens a
  launch walks through, its typed-option flags, its permission modes, what it
  needs on the machine, how it is installed, how its first-run screens are
  diagnosed. `claude-tmux.js` and `codex-tmux.js` are JS profiles of the tmux
  family, and each exports its `profile` object.
- A **derived profile** is JSON a plugin contributes (`plugins/<id>/plugin.json`,
  `contributes.profiles`). It `extends` a JS profile and overlays only DATA:
  `env`, `contextWindows`, `requirements`, `installHint`. Behaviour stays in JS.
  `plugins/deepseek/plugin.json` points claude's TUI at DeepSeek's
  Anthropic-compatible API:

  ```json
  { "name": "deepseek", "extends": "claude",
    "env": { "ANTHROPIC_BASE_URL": "https://api.deepseek.com/anthropic",
             "ANTHROPIC_AUTH_TOKEN": "${DEEPSEEK_API_KEY}", "ANTHROPIC_MODEL": "deepseek-chat" },
    "contextWindows": { "deepseek": 128000 } }
  ```

  `{"adapter": "acp", "command": …, "args": […], "env": {…}}` builds an acp
  harness instead; no `extends` needed.

`profiles.js` does the work: `resolveProfile(json, bases)` merges one (an
unknown `extends`, an unknown field or a literal secret throws);
`loadProfiles({profiles, stateDir, log})` takes `contributions(catalog).profiles`
(`server/manifests.js`), registers each through `registerHarness`, and records a
failure (`[{name, plugin, ok, error?}]`) instead of throwing. A shipped plugin
declares a built-in as `{"name": "claude", "builtin": true}`, so it is listed
with its plugin. The server calls `loadProfiles` once at boot; `bc-axi` calls it
the first time a verb needs a harness.

The port lists what is registered: `listHarnesses() → [{name, adapter, plugin?}]`
(sorted; the fake only under `BC_FAKE_STATE` or `BC_LIST_FAKE`), and
`defaultHarness()` is the one place the default's name lives (a workspace's
`config.json` `harness` overrides it). The core reads a profile's data through
the optional verb `profileInfo()` and reaches its behaviour through
`port.profileOf(name)`: `handRunLine(mode, {root})`, `setupScreens(mode)`,
`rootBlock()`, `diagnose(text, ctx)`, `detectSelf(env)`, `skillsDir(home)`,
`installWorkspace(ws, env)`, `refreshWorkspace(ws)` and
`permissions.describe(request)`. Nothing in `server/` or `cli/` names a CLI
(`test/no-cli-names.test.js`).

### Env and secrets

A profile's `env` value is either exactly `${NAME}` (a reference) or a literal
without `${`. A key whose name ends in `KEY`, `TOKEN`, `SECRET` or `PASSWORD`
must be a reference — a manifest may be committed, a secret may not. At every
launch (spawn AND resume) the tmux adapter expands the references from the
server's environment, then `<ws>/.bridge-commander/secrets.env` (`KEY=value`
lines), writes the values to `<stateDir>/<key>.env` with mode `0600`, and launches

```sh
( set -a; . '<stateDir>/<key>.env'; set +a; exec env <launch line> )
```

The subshell keeps the values out of the pane's own shell; `exec env` keeps the
CLI the pane's foreground command, so `alive` still reads it. A missing
reference fails the spawn before any pane exists, naming the variable. The value
never rides argv, the launch line typed into tmux, or `<key>.spawn-args`, which
records only the `${NAME}` templates; a resume re-expands them, so a rotated key
lands on the next launch. A profile without `env` launches bare and removes a
stale env file.

### Typed options

`opts.model` and `opts.effort` go to `profile.modelArgs({model, effort}) → argv`:
claude spells `--model` / `--effort`, codex `-m <model>` / `-c model_reasoning_effort=<effort>`.
`profileInfo().options` lists the ones a profile honors. The CALLER (the server)
passes only those — `port.splitOptions(impl, wanted) → {opts, ignored}` — and lands a
card or board timeline warning for the rest: `"<harness> does not support
<opt>; started without it"`. Options are best-effort; a VERB a harness cannot
honor still throws. Both are recorded in `<key>.spawn-args`, so a resume
replays them.

## Binding: the plumbing is bound once

`stateDir` and `callbackUrl` are plumbing, not choices: a board has one of
each. The server binds them once and never passes them again:

```js
const port = require('./harness/port.js');
const env = { stateDir: '<ws>/.bridge-commander/harness', callbackUrl: 'http://127.0.0.1:<port>/api/turn-end' };
port.harnessFor(ref, env).resume(ref, { permissionMode: 'auto' }); // stateDir + callbackUrl added
port.getHarness('claude', env).spawn(cwd, brief, { session, window });
```

A bound instance adds both to the opts of every verb that takes opts (the
binding wins over a caller's), passes every other verb through untouched, and
keeps the optional-verb set of its implementation. A binding without `stateDir`
throws — that is the point: an unbound caller that forgot it lands in the global
last-resort dir, shared by every board on the machine. `getHarness(name)` and
`harnessFor(ref)` without an env still return the raw implementation, for tests
and embedders (`smoke.js`) that pass opts themselves.

The port also exports `keyOf(ref)` — the state key (`session` or
`session:window`) every per-agent file and turn-end event carries — and
`isSpawnableSession(name)`, the `bc-<id>` rule `spawn` enforces. Nothing outside
the harness builds either.

## Optional capability verbs (pane viewing, slash commands, session status, window adoption, brief, pane pids, interrupt)

Optional verbs are features not every harness can honor, so `port.js` never
validates them — adding one to the required list would force every harness
(the `fake` included) to implement it and break validation. The server
capability-checks at the call site (`typeof impl.openPane === 'function'`)
and degrades gracefully when the verb is absent (the pane endpoints answer
`unsupported`).

**The inventory lives in one place:** [`docs/api/overview.md`](../docs/api/overview.md), which
lists every optional verb with its signature and the endpoint it serves — `openPane`,
`paneSnapshot`, `paneInput`, `commands`, `runCommand`, `status`, `adoptWindow`, `brief`, `panePids`, `interrupt`. Add a verb
there; what follows is how to implement them, not what they are.

`brief(ref, opts?)` names the file the brief was persisted to at spawn
(`<stateDir>/<key>.prompt` for the tmux adapters and the fake) — or `null` when
there is none — so the server can attach it to the card without building a
harness path itself. It reads `opts.stateDir` like `status`; a bound instance
supplies it.

`panePids(ref | session)` answers `[{ window, pid }]` for EVERY pane of the
session — all its windows, not only the ref's — so the load panel
(`server/sysload.js`) can attribute a lieutenant's worker windows to their own
cards. The tmux adapters read `list-panes -s` on the exact-match `=<session>:`
target, like every other tmux call here; `[]` when tmux or the session is gone.
The fake has no processes and does not offer it: its agents have no load rows.

`interrupt(ref)` stops the running turn and leaves the session alive. The tmux
adapters send the profile's `interruptKeys` (default `['Escape']`) to the pane
and throw when the pane is gone; acp calls the host's `cancel`, which sends
`session/cancel`. It is not `kill`: nothing ends, and the next `send` is a new
turn. The fake logs an `interrupt` line to `<key>.pane.jsonl`.

`runCommand(ref, line, opts?)` and `status(ref, opts?)` take the same `opts` bag;
`stateDir` matters there, because codex resolves its thread-id from the
`.session-id` file in it. `status` is `null`, never a throw, when nothing is
readable. Pass-through commands (`/compact`, claude's `/autocompact`) type the
LITERAL line through `send`; everything the shared dispatch does
(`agent-status.js` `runSlashCommand`) is the same for every harness, the fake
included.

`openPane` takes `{onFrame, intervalMs?, lines?, burstMs?, burstWindowMs?}`: `intervalMs`
defaults to ~1000, `lines` (scrollback depth) to ~200. A frame is a string that MAY carry ANSI
SGR escapes (colors/bold); identical frames are skipped, and `close()` releases the feed.

`paneInput` also **bursts** the open feed for that pane: a 1s poll makes typing
feel dead, so a keystroke drops the interval to `burstMs` (~120) for
`burstWindowMs` (~1500) and it falls back on its own. The burst is registered on
the feed object itself, so it cannot outlive the feed — closing the pane, or
typing into one nobody is watching, leaves nothing behind.

The poll is a self-rescheduling `setTimeout`, so captures are strictly
sequential and can never stack. Each hop's delay is measured from when the
previous one STARTED, not when it finished, which keeps the period at
`max(interval, capture)` — schedule from the end instead and a 60ms tmux turns
the advertised 120ms burst into 180ms and the 1s baseline into 1.06s.

Neither `paneInput` nor `sendLiteral` needs a pattern for `text`: `tmux.js`
passes `--` before every operand, so a payload beginning with `-` is typed
rather than parsed as flags. That guard is not cosmetic — without it
`{text:'-t=<other-session>:'}` retargets `send-keys` at a pane the caller was
never authorised to touch (`harness/test/tmux-literal.test.js` pins it against
real tmux). `text` is capped at `PANE_INPUT_MAX` (16 KB less 512 bytes, counted
in UTF-8 BYTES) so one call cannot paste a whole file into a live agent's pane —
and, more sharply, cannot hand tmux more than tmux takes: a single-line
`send-keys` is one imsg, so target + text must stay under ~16343 bytes.

A harness may offer `paneInput` even where its `send` throws: those are
different capabilities. `send` needs a COMPOSER for a brief to land in;
`paneInput` assumes nothing about what the pane runs, which is exactly how you
answer a prompt, quit a pager, or Ctrl-C a stuck script.

The claude implementation polls `capture-pane -e` — deliberately **rendered
frames, not a `pipe-pane` byte stream**: the target is a full-screen TUI that
repaints in place, so raw pty bytes would need a client-side terminal emulator
(a dependency we won't add), while `capture-pane` returns the already-composed
screen and keeps the client a plain `<pre>`. When the pane disappears it emits
a final `\n[pane gone]` frame and stops. The fake emits deterministic counter
frames (file-backed mode logs open/close to `<key>.pane.jsonl` for
cross-process refcount assertions); `BC_FAKE_NO_PANE=1` hides both verbs to
test capability-absent degradation, `BC_FAKE_PANE_MS` overrides its default
frame interval.

## HarnessRef

A plain JSON-serializable object — it is persisted in board state and must
survive a server restart:

```json
{ "harness": "claude", "session": "bc-a1b2c3", "cwd": "/abs/worktree", "resumeId": "<uuid>" }
```

`window` and `resumeId` are either absent or non-empty strings — never an
`undefined` key. Every harness builds its refs the same way (`makeRef` in
`tmux-adapter.js`; the fake follows the rule): a ref is born with `resumeId`
only when the harness knows it at birth (claude), and `resume` without a
recoverable id returns a ref without one — the next turn-end delivers it.

`session` is the tmux session name (`bc-*` — predictable, so `tmux attach -t bc-a1b2c3`
is the captain's escape hatch). `resumeId` is the harness-native conversation id.

An optional `window` pins the ref to one named WINDOW of that session, for
agents that cohabit it: a lieutenant in `lt` and its workers in `w-<card-id>`.
Granularity is not cosmetic — a session-granular ref kills the whole session
(every sibling window with it) and reads its liveness off whichever window has
focus, so an agent with siblings must always carry its window.

## Files

- `port.js` — the contract: `getHarness(name, env?)`, `registerHarness(name, impl, meta?)`, `harnessFor(ref, env?)`,
  `isHarnessRef(ref)`, `keyOf(ref)`, `isSpawnableSession(name)`, `listHarnesses()`, `defaultHarness()`,
  `profileInfo(name)`, `profileOf(name)`, `splitOptions(impl, wanted)`
- `profiles.js` — derived profiles: `resolveProfile`, `loadProfiles`, `expandEnv`
- `tmux-adapter.js` — `tmuxAdapter(profile)`: the ONE implementation of every verb over tmux
- `claude-tmux.js` — the claude profile (launch line, permission modes, screens,
  hooks, `/output-style`, typed options, context windows)
- `claude-onboard.js` — what the claude profile tells a stranger on the first run
  (hand-run line, install hint, root block, pane diagnosis); `cli/firstrun.js` frames it
- `codex-tmux.js` — the OpenAI Codex CLI profile (launch flags, screens)
- `tmux-session.js` — session/window/pane plumbing under the adapter
  (pane lifecycle, naming, launch-and-settle, turn-end tail, pane viewing)
- `tmux.js` — tmux primitives (composer state, ghost-text stripping, verified submit)
- `turnend-relay.js` — the ONE turn-end relay: `normalize(harness, raw) → TurnEndEvent`,
  record, POST
- `turnend-hook.js` / `codex-notify.js` — the entry points claude's Stop hook and
  codex's notify run; thin wrappers around the relay, kept at these paths because
  installed hooks and live launch lines name them
- `permission-hook.js` — the PermissionRequest-hook relay: holds claude's
  permission prompt open on the board's `/api/permission` until the captain
  answers (installed hooks name this path too)
- `claude-settings.js` — the one writer of `.claude/settings.local.json`
  (Stop and PermissionRequest hooks, statusLine, outputStyle, git exclude),
  shared with `bc-axi`
- `statusline.js` — claude's statusLine command (context-window sidecar)
- `agent-status.js` — status readers and the shared slash-command dispatch
- `util.js` — small shared helpers (tmuxSession, readStdin, findWorkspace, …)
- `fake.js` — in-memory implementation for unit-testing server code; set
  `BC_FAKE_STATE=<dir>` for file-backed mode (cross-process: spawn writes a
  `<session>.json` marker, sends append to `<session>.sends.jsonl`, and a
  marker on disk counts as a live session). `BC_FAKE_SPAWN_MS` holds `spawn`
  open so the seconds a real one blocks for are visible to a test — the window
  `/reset` spends with its lieutenant down. `BC_FAKE_TURNEND_POST=1` makes it
  POST its turn ends to `opts.callbackUrl`, like a real relay
- `smoke.js` — real end-to-end smoke, `node harness/smoke.js [claude|codex] [--resume]`
- `test/` — unit tests (`node --test harness/test/*.test.js`); `conformance.test.js`
  runs one suite against every tmux harness `listHarnesses()` names (a JSON-derived
  one included) and the fake; `profiles.test.js` pins the merge and the secret rule

## The tmux adapter

`tmuxAdapter(profile)` implements the verbs once. A profile holds only facts
about its CLI:

| Field | claude | codex |
|---|---|---|
| `launch(ctx)` / `resumeLaunch(id, ctx)` | `claude --permission-mode <mode> --session-id <uuid>` (bypass: `--dangerously-skip-permissions`) / `--resume <id>` | `codex --dangerously-bypass-… -c notify=[…]` / `codex resume <id> …` (ignores `permissionMode`) |
| `settle` | trust (walked off a preselected "No"), resume picker, ready, fatal screens | trust, ready, fatal screens |
| `idAtBirth()` | a fresh uuid | none — the first turn-end delivers the thread-id |
| `prepare(cwd, key, ctx)` | install the Stop and PermissionRequest hooks | — (the relay rides the launch line) |
| `status(ref, ctx)` | transcript / statusline sidecar | rollout log |
| extra commands | `/autocompact` (pass-through), `/output-style` (emulated) | — |
| `modelArgs` | `--model`, `--effort` | `-m`, `-c model_reasoning_effort=…` |
| `permissions.modes` | `auto` `default` `acceptEdits` `bypass` | none (keeps its bypass flags) |
| `requirements` | `claude` on PATH, tmux, root refuses bypass | `codex` on PATH, tmux |
| `contextWindows` | `fable` 1M, `opus`/`sonnet`/`haiku` 200k | — (the rollout carries the window) |

Both `spawn` and `resume` end with `verifyLive`: returning is a claim that a
session is there, and a settle can match a modal's own wording.

## TurnEndEvent

Both relays write, and POST, the same event:

```json
{ "ts": "…", "session": "<key>", "harness": "claude|codex", "event": "turn-end",
  "session_id": "<resume id>", "cwd": "/abs", "tmux_session": "bc-…", "text": "last words…" }
```

`session` is the state key (`session` or `session:window`), `tmux_session` the
pane's own session (`''` outside tmux) for the server's attribution, and `text`
what the agent last said — trimmed, at most 300 characters, absent when it said
nothing. The server's worker-stall alert quotes it.

## The claude profile

- **spawn** — `tmux new-session -d -s bc-<id> -c <cwd>`, then launches
  `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1 claude --permission-mode <mode> --session-id <uuid>`
  (bare — no prompt on the command line). `<mode>` is `opts.permissionMode`
  (`auto` when absent; `default`, `acceptEdits` also pass through). `bypass`
  is the old launch: `claude --dangerously-skip-permissions`, with the
  `IS_SANDBOX=1` prefix when `opts.allowRoot` is set and we run as uid 0. No
  other mode needs that prefix: claude only refuses the bypass launch as root.
  The uuid is generated up front, so
  `resumeId` is known deterministically at birth. A fresh cwd shows claude's
  folder-trust dialog in every permission mode; spawn detects and auto-accepts it
  (claude 2.1.282 preselects "No, exit" there, so the settle presses Down
  first whenever the cursor sits on a "No" — `SETTLE.declineRe`),
  waits for the main UI, and only THEN types the prompt into the composer with
  the same verified-submit machinery `send()` uses — the prompt is persisted to
  `<stateDir>/<key>.prompt` (source of truth) but never rides in argv, so
  `ps`/`pgrep -f` on the launched process never shows it.
  `opts.installHooks: false` skips the per-spawn hook install (spawn and
  resume both honor it) — for sessions born into a cwd that already carries a
  workspace-level hook, which a per-spawn install would clobber (one bc entry
  per settings file). `bc-axi init` installs that workspace-level hook through
  the same `claude-settings.js`.
- **send** — text is typed ONCE (single-line via `send-keys -l`; multi-line via a
  bracketed paste so embedded newlines don't submit mid-text), then Enter is sent
  and verified: the composer's cursor line is captured with ANSI styling, dim
  ghost text and box borders are stripped, and if real text is still sitting
  there, Enter is retried (never the text — a retype would duplicate it).
  A positively-confirmed swallow throws.
- **alive** — tmux session exists AND the pane is not sitting back at a bare
  shell (claude exiting returns the pane to bash). Read STRICTLY: `false` is only
  ever tmux's own word that the session/window is not there (or that no server is
  running on the socket); a tmux that could not be READ at all throws with the
  reason instead of passing for absence, because the board drops worker records
  on this answer.
- **kill** — `tmux kill-session` on the ref's session (missing session = no-op).
  Harness state files stay behind on purpose: a later `resume(ref)` can still
  reincarnate the conversation if the kill was premature.
- **resume** — kills the dead session's leftovers and relaunches
  `claude --resume <resumeId>` in a fresh tmux session under the same name.
  `--resume` keeps the SAME session id (no fork by default), so refs stay valid
  across any number of death/resume cycles. The Stop hook also records the live
  session id to `<stateDir>/<session>.session-id`, which resume prefers over the
  ref (ground truth wins). Without any id: fresh session, memory lost. The
  spawn's launch facts are REPLAYED from `<session>.spawn-args`, not rebuilt:
  its extra flags (`opts.extraArgs` wins when the caller passes them), its
  permission mode (`opts.permissionMode` wins; a record from before modes
  existed resumes in `auto`), and its `allowRoot` consent, without which a
  bypass resume as uid 0 comes back missing the `IS_SANDBOX=1` prefix and
  claude refuses to start.
- **onTurnEnd** — spawn merges a `Stop` hook into the worktree's
  `.claude/settings.local.json` (kept out of git via `info/exclude`) running
  `turnend-hook.js` (the relay), which appends one TurnEndEvent per turn boundary to
  `<stateDir>/<session>.turnend.jsonl` and optionally POSTs it to a callback URL
  (`opts.callbackUrl` / `BC_TURNEND_URL`). `onTurnEnd()` tails that file
  (fs.watch + 1s polling backstop) and fires the hook per event.
- **permission prompts** — when there is a callback URL, `claude-settings.js`
  `installHooks` also
  merges ONE `PermissionRequest` entry (`matcher: "*"`, `timeout: 3600`)
  running `permission-hook.js <stateDir> <session> <server>/api/permission`
  (other tools' entries survive; a stale bc entry is replaced). Claude runs it
  only when it would show a permission dialog, so never in bypass mode. The
  hook POSTs `{ ts, session, session_id, cwd, tmux_session, tool_name,
  tool_input, permission_mode }` and waits (up to ~3550s) while the server holds
  the request for the captain. A reply of `{ decision: "allow" }` or
  `{ decision: "deny", message? }` becomes the hook's decision on stdout. A null
  decision, an error, bad JSON or no server prints nothing, so claude falls back
  to its own in-terminal dialog. The hook always exits 0.
- **slash commands** — beyond the shared set, claude reports `/autocompact` and
  `/output-style` (both verified against the binary; the public docs lag). The
  latter is NOT a pass-through — the 2.1.239 binary removed the command and
  moved output styles into the interactive `/config` dialog — so it does what
  claude itself does with the setting: it WRITES it and says when it lands. The
  style goes into the SESSION's own `<cwd>/.claude/settings.local.json` (merged,
  so the Stop hook survives; never `~/.claude/settings.json`, which would
  repaint every claude on the machine), and the reply says it applies the next
  time this session starts — the setting is read at process start. It names no
  command to get there: `/reset` is a board command that exists only for
  lieutenant targets, so a card thread would be sent at a command its worker
  session refuses. Nothing is killed and nothing is resumed. The
  offered styles are the built-ins plus every `*.md` under
  `<cwd>/.claude/output-styles/` and `~/.claude/output-styles/` (project shadows
  user; `opts.stylesDir` / `BC_CLAUDE_OUTPUT_STYLES_DIR` override the user
  directory), each named by its front-matter `name:` with the basename as
  fallback. A missing or unknown name throws before anything is written.

State lives in `opts.stateDir` — the server binds the port to the
workspace's `.bridge-commander/harness/` and the CLI installs its hooks against
the same dir (`server/layout.js` `harnessStateDir`; `BC_HARNESS_STATE` overrides; the
global `~/.bridge-commander/harness/` is a last-resort for bare embedders only):
`<session>.prompt`, `<session>.session-id`, `<session>.turnend.jsonl`,
`<session>.env` (a profile's expanded env, mode 0600, only when it has one),
`<session>.spawn-args` (the launch facts a spawn was given — `opts.extraArgs`,
`opts.model`, `opts.effort`, `opts.permissionMode`, `opts.allowRoot` and the env
TEMPLATES — recorded by the shared `tmux-session.js` so a RESUME
replays them: a worker pinned to a `--model` by its playbook must not come back
on the default one. A missing or corrupt record reads as "nothing extra" and
never throws — a resume that cannot read a hint must still resume).

## The codex profile

Same adapter as claude; what differs is the launch line, the screen signatures,
and where the turn-end relay rides (command line, not settings file). Verified
against codex 0.144.1; the fatal screens against the 0.155.1 binary.

- **spawn** — launches
  `codex --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust -c notify='[...]'`
  (bare — no prompt on the command line; delivered into the composer the same
  way claude's spawn does, once launch-settle confirms the UI is up).
  - `--dangerously-bypass-approvals-and-sandbox` is codex's analog of claude's
    `--dangerously-skip-permissions` (YOLO mode: no sandbox, no approval
    prompts — the port's full-autonomy rule).
  - `--dangerously-bypass-hook-trust` suppresses the "Hooks need review"
    picker a global `~/.codex/hooks.json` otherwise raises at launch; without
    it spawn hangs on that screen.
  - a fresh cwd still shows codex's **directory-trust** prompt ("Do you trust
    the contents of this directory?", accept preselected) even with both
    bypass flags; launch-settle auto-accepts it with Enter, exactly like
    claude's folder trust. codex renders inline in the primary screen (no
    alternate screen), so the settle signatures are matched against the pane
    TAIL — the accepted trust prompt lingers in scrollback.
  - `opts.permissionMode` is accepted and ignored: codex has no
    board-relayed approval hook, so it keeps its bypass flags.
  - the typed options become `-m <model>` and `-c model_reasoning_effort=<effort>`
    (pinned against the 0.157.1 binary's strings; its `--help` hangs off a
    terminal); the default model comes from `~/.codex/config.toml`.
- **turn ends + resume id** — one mechanism gives both: `-c notify=[...]`
  makes codex run `codex-notify.js` at every turn boundary with its payload
  JSON appended as the LAST argv (`type: "agent-turn-complete"`, `thread-id`,
  `cwd`, `last-assistant-message`, ...). The relay normalizes it into the same
  TurnEndEvent claude's hook emits, `text` included, appends to `<key>.turnend.jsonl` (so `onTurnEnd()`
  is the shared tail), records the thread-id at `<key>.session-id`, and
  best-effort POSTs the callback URL. Nothing is written into the worktree —
  the never-dirty rule holds for free.
- **resumeId** — the codex thread-id. Unlike claude there is no `--session-id`
  flag: the ref is born WITHOUT `resumeId` and adopts it from the first
  turn-end (the server writes it back into the ref; the `.session-id` file is
  the ground truth either way).
- **resume** — `codex resume <thread-id>` with the same bypass + notify flags,
  in a fresh pane under the same name, plus the spawn's extra flags replayed
  from `<session>.spawn-args` (`opts.extraArgs` wins when given), so a worker
  pinned to a `--model` comes back on it. Resuming continues the SAME thread-id
  (verified empirically — `smoke.js codex --resume` asserts it), so refs
  survive any number of death/resume cycles. Without any id: fresh launch,
  memory lost.
- **fatal screens** — no binary, the first-run sign-in picker, the update modal
  (its preselected option runs `brew upgrade`), and `codex resume` of a thread
  with no rollout end the settle at once, with the pane tail on the error.
- **composer** — codex's prompt glyph is `›` (U+203A), in `tmux.js`
  `PROMPT_GLYPHS` so verified submit gets its positive ack when the composer
  clears; codex's busy footer matches the shared `BUSY_RE`
  ("esc to interrupt").

## Moving a lieutenant between harnesses

A lieutenant's harness is a property of its SESSION (`ref.harness`), so there is
no migration to perform: `lieutenant.patch --harness` kills the lieutenant's `lt`
window — never its session, whose worker windows are alive — and spawns a new
session on the other harness, on the same from-nothing prompt `/reset` and
supervision's non-resumable branch use (doctrine + charter + owned cards +
pending queue). The ref is rewritten whole and comes back WITHOUT a `resumeId`:
a claude session id means nothing to codex, and a stale one would have
supervision try to resume a thread that never existed. The conversation is lost
in the move; the delivery queue is not, so the new session drains everything the
old one never acked. A `model` on the lieutenant rides the typed `opts.model` on
every spawn AND resume of it — recorded in `<key>.spawn-args` like a worker's, so
a later respawn comes back on the same model instead of the harness's default. A
harness that does not honor it starts without it, and the board says so once.

## Adding a new harness

The cheapest route is JSON: a plugin whose `plugin.json` contributes a derived
profile over an existing one (see "Adapter family, profile, derived profile").
It joins `listHarnesses()` and `conformance.test.js` with no code.

For a new CLI, implement the seven verbs in one module and register it (claude
and codex are already builtins — `getHarness('codex')` just works):

```js
const { registerHarness } = require('./port.js');
registerHarness('goose', require('./goose-tmux.js'));
```

For a tmux-TUI harness, write a profile and hand it to `tmuxAdapter` —
`codex-tmux.js` is the short example: launch lines, screen signatures, and
where its turn-end relay rides. Add its payload fields to `turnend-relay.js`
and add the profile to `test/conformance.test.js`.

Rules of the road, learned the hard way (from firstmate's verified adapters):

1. **Refs are values.** Everything needed to find, kill, or resume the session
   must be in the ref or derivable from `stateDir` — no in-process state.
2. **Verify submission.** TUIs swallow Enter (slash-command popups, multi-line
   paste). Type once, verify the composer cleared, retry Enter only.
3. **Turn ends are pushed.** Use the harness's own hook/notify mechanism
   (claude: Stop hooks; codex: `-c notify=[...]`), never pane polling.
4. **Unattended at launch, answerable from the board.** The agent must never
   wait on a terminal nobody watches. claude launches with
   `--permission-mode <mode>` (default `auto`) and relays the prompts it still
   raises to the board through the PermissionRequest hook; `bypass` restores
   `--dangerously-skip-permissions`. codex keeps its bypass flags and ignores
   `permissionMode`. Handle any trust dialog at spawn.
5. **Never dirty the worktree.** Hook/config files written into the worktree go
   into `.git/info/exclude`.
6. Verify each behavior empirically in a real session before relying on it.

## Running the tests

```sh
node --test harness/test/*.test.js      # unit + conformance
node harness/smoke.js claude            # REAL e2e: spawn → relay turn-end → reply →
                                        # send → reply → kill (needs tmux + the CLI)
node harness/smoke.js codex --resume    # + kill → resume → memory recall on the same id
```

The smoke prints `SMOKE <HARNESS> OK` and exits 0 on success, skips when the
CLI is not on PATH, and dumps the pane tail on failure. It runs on a temp
`stateDir` and cleans up its session, workdir and state.
