# The `acp` harness family

An `acp` profile drives any agent that speaks the
[Agent Client Protocol](https://agentclientprotocol.com) (v1) through the same
seven-verb harness port as the tmux family. The decision behind it is in
[docs/rfc/plugins.md](../docs/rfc/plugins.md), "ACP vs tmux": ACP serves workers
and long-tail agents, behind a long-lived host, and BC shows the session as a
read-only event log. BC does not rebuild a TUI.

## Configure a profile

```json
{ "name": "codex-acp", "adapter": "acp", "command": "npx", "args": ["-y", "@agentclientprotocol/codex-acp"] }
{ "name": "claude-acp", "adapter": "acp", "command": "npx", "args": ["-y", "@agentclientprotocol/claude-agent-acp"] }
{ "name": "deepseek", "adapter": "acp", "command": "npx", "args": ["@deepseek-ai/dsh-acp"],
  "env": { "DEEPSEEK_API_KEY": "${DEEPSEEK_API_KEY}" } }
```

`profiles.js` hands the profile to `require('./acp-adapter.js').acpAdapter(profile)`.

- `command` and `args` start the agent. `opts.extraArgs` is appended, and a
  resume replays it from `<key>.spawn-args`, like the tmux family.
- `env` values are literals or exactly `${NAME}`. A reference resolves from the
  server's env, then `secrets.env` beside the state dir. An unset reference
  fails the spawn. The values travel over the host socket, never in argv.
- `@zed-industries/codex-acp` stopped at 0.16.0 and hangs in `session/new`
  on today's model catalog. Use `@agentclientprotocol/codex-acp`.
- The agent logs in with its own CLI (`codex login`, `claude`). BC does not
  implement ACP `authenticate`. A spawn that meets `auth_required` fails and
  names the agent's login methods.

## How it works

```
BC server ──(harness port)── acp-adapter.js ──unix socket, JSON-RPC── acp-host.js ──stdio, ACP── agent
                                   │                                     │
                                   └── reads <stateDir>/<key>.* files ◄──┘ writes them
```

- **`acp-host.js`** is a detached sidecar, one per stateDir. The adapter starts
  it on demand. It listens on `<stateDir>/acp-host.sock`; a stateDir too long
  for a unix socket path gets `$TMPDIR/bc-acp-<hash>.sock` instead.
  `acp-host.pid` makes sure only one host runs. The host owns the agent
  processes, so a BC restart does not touch them. With no session and no
  client for `BC_ACP_HOST_IDLE_MS` (default 30 min) it exits.
- **One agent process per session.** The host spawns it in its own process
  group, so a kill reaches the whole tree (`npx` does not forward SIGTERM).
- **`acp-rpc.js`** is the one JSON-RPC 2.0 codec, for the agents and the socket.
- **Files per state key** (`session` or `session:window`):

  | File | Written by | Holds |
  |---|---|---|
  | `<key>.acp.jsonl` | host | every `session/update`, plus prompts, permission asks, turn ends, exits |
  | `<key>.acp-state.json` | host | capabilities, advertised commands, last usage, config options |
  | `<key>.turnend.jsonl`, `<key>.session-id` | host, through `turnend-relay.js` | the shared TurnEndEvent log and the resume id |
  | `<key>.prompt`, `<key>.spawn-args` | adapter | the brief and the launch facts, as for tmux |
  | `<key>.acp.stderr.log` | host | the agent's stderr, capped at 1 MB |

### Verbs

| Verb | ACP |
|---|---|
| `spawn` | start the host when needed → `initialize` (protocol 1, `fs` and `terminal` off) → `session/new {cwd, mcpServers: []}` → `session/set_config_option` for `opts.model` → the brief is queued as the first `session/prompt`. It returns once the session exists, not when the turn ends |
| `send` | queue a `session/prompt`. It returns once the host accepts it. Prompts run one at a time per session |
| `alive` | the host holds a live agent for the key. No host = `false`. A host that cannot answer throws |
| `resumable` | a resume id is known (`<key>.session-id`, then `ref.resumeId`) AND the agent advertised `sessionCapabilities.resume` or `loadSession` |
| `resume` | a live session comes back as it is. Else a new agent process, then `session/resume` (preferred) or `session/load`. A `session/load` replay is not appended to the log a second time. Without either, or when the agent forgot the session, it opens a fresh one and the ref gets the new id |
| `kill` | `session/close` when advertised (else `session/cancel` during a turn), then stdin EOF, SIGTERM and SIGKILL on the process group. Idempotent. State files stay |
| `onTurnEnd` | the shared tail of `<key>.turnend.jsonl` |
| `openPane` / `paneSnapshot` | `<key>.acp.jsonl` rendered as text frames: prompts, messages, thoughts (dim), tool calls with their status, diffs, the latest plan, permission asks and their verdicts, turn ends, exits |
| `commands` / `runCommand` | `/status` and `/help`, then what `available_commands_update` advertised. An advertised command is sent as a prompt, as the literal line |
| `status` | the last `usage_update` → `{contextUsed: used, contextWindow: size, model?}`; `model` is the `model` config option's current value |
| `brief` | `<key>.prompt` |
| `profileInfo` | `{name, adapter: 'acp', options: [] \| ['model'], permissionModes: [], requirements: {bins: [command], tmux: false, rootBypass: false}, installHint, contextWindows}`. `'model'` shows up once a session of this profile exposed a `model` config option, or when the profile lists it in `options` |

`paneInput`, `adoptWindow` and `panePids` are not offered: there is no terminal
to type into, no tmux window, and no pane. `opts.effort` and `permissionMode`
are not honored; `effort` throws.

### The ref

```json
{ "harness": "codex-acp", "session": "acp-a1b2c3", "window": "w-MON-14", "cwd": "/abs/worktree", "resumeId": "<ACP sessionId>" }
```

`session` is `acp-` plus `opts.session` without its `bc-` prefix (a random id
when absent). `window` is kept when given. `resumeId` is always the live ACP
sessionId. No key is ever `undefined`.

`alive`, `send` and `kill` take no opts, so they are never handed a stateDir.
After a restart the first call on a ref is often `alive`, so spawn and resume
leave a pointer `<registry>/<hash(key, cwd)>.json → stateDir`. The registry is
`~/.bridge-commander/acp-sessions/` (`BC_ACP_REGISTRY` overrides it). Kill
removes the pointer. A reboot kills the host anyway, so a lost pointer reads
as "not alive".

### Turn ends

At each `session/prompt` result the host records and POSTs the usual
TurnEndEvent to the spawn's callback URL:

```json
{ "ts": "…", "session": "<key>", "harness": "<profile name>", "event": "turn-end",
  "session_id": "<ACP sessionId>", "cwd": "/abs", "tmux_session": "", "stop_reason": "end_turn", "text": "…" }
```

`text` is the turn's `agent_message_chunk` text, trimmed and capped at 300
characters, like the relay. A prompt that errors ends the turn with
`stop_reason: "error"` and the error as `text`, because the agent is idle
again. An agent that dies mid-turn emits no turn end; `alive()` turns false,
and supervision takes it from there. The server needs no new route: it
attributes the event by `session_id` or by the state key.

### Permissions

`session/request_permission` becomes a POST to `<origin of callbackUrl>/api/permission`
with permission-hook.js's body:
`{ts, session, session_id, cwd, tmux_session: '', tool_name, tool_input, permission_mode: null}`.
`tool_name` is the tool call's `title` (else `name`, else `kind`). `tool_input`
is its `rawInput`. Fields reported in earlier `tool_call` updates are merged in.

- `{decision: 'allow'}` selects the agent's `allow_once` option (else `allow_always`).
- `{decision: 'deny'}` selects `reject_once` (else `reject_always`).
- No decision (the server's cap, a bad body, no callback URL) also rejects.
  There is no terminal dialog to fall back to, and a broken relay must never
  approve.
- A connection failure (BC restarting) re-posts the ask every 2 s for up to
  10 minutes before it rejects.
- A cancelled turn or a kill answers `{outcome: 'cancelled'}`.

## What happens when…

- **BC restarts:** nothing. The host and the agents keep running, turns in
  flight finish, and their turn ends are recorded in `<key>.turnend.jsonl`. The
  POST of a turn end that finished while the server was down is lost, as with
  the tmux relays. The new server's `alive()` finds the session through the
  pointer.
- **The agent crashes:** the host logs an `exit` entry, marks the session dead
  and rejects its queue. `alive()` is `false` and `send()` throws. `resume()`
  restores it when the agent supports it.
- **The host dies (or the machine reboots):** `alive()` is `false` (no socket).
  The agents see stdin EOF and, as ACP agents do, exit. `resume()` starts a
  new host.

## Limits

- **No human attach.** The pane is a read-only log. There is no terminal drawer
  and no statusline.
- **Adapter maturity.** The ACP bridges for Claude Code and Codex are young.
  The RFC records around 100 open issues each: steering, background tasks, a
  permission deadlock, orphaned children, partial history replay. Pin versions
  in `args` once one works for you.
- **Spec churn.** This is ACP v1. v2 removes `session/load` and changes the
  turn lifecycle.
- The client offers no `fs/*`, `terminal/*` or elicitation methods, and no MCP
  servers are passed to `session/new`.
- `<key>.acp.jsonl` is not rotated. The pane renders only its last 512 KB.

## Tests and the smoke

```sh
node --test harness/test/acp-rpc.test.js harness/test/acp-host.test.js harness/test/acp-conformance.test.js
node harness/acp-smoke.js codex --resume     # REAL agent through npx; needs the network and a login
BC_ACP_SMOKE_MODEL=gpt-5.5 node harness/acp-smoke.js codex
node harness/acp-smoke.js claude --resume
```

`test/fake-acp-agent.js` is a scriptable ACP agent. Its env sets the
capabilities (`FAKE_ACP_LOAD`, `FAKE_ACP_RESUME`, `FAKE_ACP_CLOSE`,
`FAKE_ACP_MODEL`, `FAKE_ACP_AUTH`). The prompt text sets the turn (`CRASH`,
`HANG`, `SLOW <ms>`, `PERMISSION`, `RECALL`, `PLAN`, else an echo). The
conformance cases run the real detached host, and each one stops its host.
