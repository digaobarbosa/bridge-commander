# Bridge Commander

<p align="center">
  <a href="https://youtu.be/lewm5_2LiNs">
    <img src="https://github.com/user-attachments/assets/048b00c1-bae8-4a49-aa7c-4ae8f0d8656c" width="420" alt="Watch the video">
  </a>
</p>

As you work with AI, your **attention gets fragmented** — driving multiple planning tasks while
overseeing multiple implementation tasks. Chat quickly becomes the wrong UX for piloting a fleet
of agents.

This skill lets you use Claude Code / Codex as multiple chiefs of staff (**lieutenants**). You
get a web UI where you work together, as work items get done by independent agent sessions on a
kanban board.

![the board](docs/img/board.png)

## Install

One skill:

```sh
npx skills add tonylampada/bridge-commander -g -y
```

That's it. The rest happens in the terminal you already have.

## Start

- Make an empty folder (e.g. `myfleet`) and start `claude` in it
- (Recommended) Set permissions mode to auto
- `/bridge-commander`
- Open the board URL it prints (default `http://localhost:4780/`)

**Bridget** is already there with a message waiting. She's your first lieutenant, and she does the
rest of the setup with you.

You need `tmux` and `git` on the machine (Bridget will offer to install if missing). 
You never have to use tmux yourself, but you can if you want.

## Configuration

Per-workspace config lives in `.bridge-commander/config.json`:

| Key | Default | Meaning |
|---|---|---|
| `port` | `4780` | server port (also `--port N` on `init`/`open`) |
| `host` | `127.0.0.1` | bind address — see network exposure below |
| `harness` | `claude` | default agent harness: a built-in (`claude` \| `codex`) or a profile a plugin contributes (`plugins/deepseek`; `claude-acp` \| `codex-acp` from `plugins/acp-agents`, see [harness/ACP.md](harness/ACP.md#the-shipped-profiles-claude-acp-and-codex-acp)) |
| `permissionMode` | `auto` | how agents launch: `auto` \| `default` \| `acceptEdits` \| `bypass`. Outside `bypass`, a prompt an agent would show lands on the board for you to approve or deny |
| `voices` | — | UI text-to-speech voice filter |
| `tts` | — | speak agent messages through an external TTS engine: `{"url": "http://127.0.0.1:8883", "lang": "pt", "voice": null, "params": {}}` (voxbench API). Absent = the board stays silent. The **server** reaches the engine: the browser talks to `/api/tts/*` on the board's own origin and the url only has to be reachable from the machine running the server (no CORS, no tailnet on the phone) |

Two more files in `.bridge-commander/` shape the harnesses:

| File | Meaning |
|---|---|
| `plugins.json` | the plugin overlay: `{"plugins": {"deepseek": {"enabled": true}}, "contributions": {"profile:codex": {"enabled": false}}}` turns a plugin, or one of its contributions, on or off. Shipped plugins live in `plugins/<id>/`; a workspace's own in `.bridge-commander/plugins/<id>/` replaces a shipped one of the same id. Re-read whenever the board or `bc-axi plugins enable\|disable` writes it; agent profiles only register at server start |
| `secrets.env` | `KEY=value` lines a profile's `env` may reference as `${KEY}` (the server's own environment wins). `bc-axi init` already keeps `.bridge-commander/` out of git. Values reach the agent through a mode-0600 file its launch sources — never argv, the tmux launch line or `spawn-args` |

Per-browser settings live in the board's ⚙️ menu, not here. One of them, **terminal**, adds a ⌨
to the 👁 drawer that opens the agent's tmux session in a real terminal: `iTerm2 (macOS)` hands an
`iterm2:` link to iTerm (it asks before running), `copy tmux command` works with any terminal. Off
by default.

Env knobs (set on the server process):

| Variable | Default | Meaning |
|---|---|---|
| `BC_SUPERVISE_INTERVAL_MS` | `30000` | supervision tick (lieutenant respawn, dead-worker detection); `0` disables |
| `BC_PRWATCH_INTERVAL_MS` | `120000` | PR watch tick; `0` disables |
| `BC_UPLOAD_MAX_BYTES` | `10485760` | per-file chat upload cap |
| `BC_WORKER_TTL_SECS` | `600` | card status lease TTL — `working`/`needs-you` decays to `idle` past it |
| `BC_WORKTREE_TOOL` | auto | `treehouse` \| `git` — worker worktree provisioning |
| `BC_HARNESS_STATE` | `~/.bridge-commander/harness` | harness state dir (prompts, session ids, turn-end logs) |
| `BC_GH_CMD` | `gh` | gh binary used by the PR watch and by the packaged `gh-watch` hook |
| `BC_SCHEDULE_INTERVAL_MS` | `15000` | schedule tick — how often the clock looks for due windows; `0` disables |
| `BC_TURNEND_URL` | — | default callback URL baked into installed turn-end hooks |
| `BC_SEND_RETRIES` / `BC_SEND_SLEEP_MS` | `3` / `400` | verified-submit tuning for `harness.send` |
| `BC_HOOK_TIMEOUT_MS` | `120000` | per-script timeout for workspace hooks, lifecycle and named alike |
| `BC_TEARDOWN_TIMEOUT_MS` | `300000` / `60000` | timeout for a playbook's `teardown` command — 5 min at the handoff and archive (un-awaited), 60s at a rework restart (awaited inside `card start`); set, it overrides both |
| `BC_TTS_IDLE_MS` | `20000` | how long the TTS passthrough waits for the next byte from the engine before hanging up — a gap between bytes, not a cap on the request |
| `BC_SYSLOAD_MS` | `2000` | monitoring panel (⚙️ → machine load) sample interval; the sampler runs only while the panel is open |

### Network exposure

The board has **no application-level auth** — whoever reaches the bind address fully controls
the board, including starting workers (running code):

- **Default (recommended): loopback only** (`127.0.0.1`).
- Private mesh (e.g. Tailscale): set `host` to that interface's address; a loopback listener is
  kept alongside. The mesh is your only auth boundary.
- **Never bind `0.0.0.0`.**

## Plugins

A plugin is a folder with a `plugin.json`: shipped ones in `plugins/<id>/`, a workspace's own in
`.bridge-commander/plugins/<id>/` (the same id replaces the shipped one whole). A manifest can
contribute agent **profiles**, card **commands** placed in menus with a `when` predicate,
**checks**, views and sections; an optional `server.js` runs on the board's server and an
optional `ui` module in the browser. The RFC is [docs/rfc/plugins.md](docs/rfc/plugins.md), the
exact shapes are in [docs/rfc/plugins-contracts.md](docs/rfc/plugins-contracts.md).

- **The overlay** (`.bridge-commander/plugins.json`) turns a plugin or one contribution on or off
  and holds each plugin's config. The board's Plugins settings and `bc-axi plugins` write it; the
  server reloads the catalog on each write. A change to which agent profiles are enabled needs a
  server restart, and the answer says so.
- **`secrets.env`** holds the values a profile's `env` references as `${KEY}` (see above).
- **Commands** run one of three ways: a shell line (every `${card.*}` / `${input.*}` value is
  single-quoted into it, and `BC_CARD`, `BC_WORKTREE`, `BC_INPUT_<NAME>`… ride the env), a link
  to open, or the plugin's own server handler. A `tracked` command is an **activity**: the board
  lists it, its whole log is kept in `.bridge-commander/runs/`, and a failure wakes the card's
  owner.
- **Events** (`card-created`, `card-moved`, `card-archived`, `worker-started`, `worker-done`,
  `worker-died`, `activity-ended`) reach a plugin that says `"activation": "boot"`. They are
  observe-only, like hooks.
- The PR watch is the shipped `github` plugin's: `bc-axi plugins disable github` turns it off.

```
bc-axi plugins                               # id, source, enabled, active, error
bc-axi plugins enable|disable <id>
bc-axi command run <command-id> <card-id> [--input k=v]...
bc-axi activities [--card <id>]
bc-axi activity log <activity-id> [--follow]
bc-axi checks [--phase init|boot]            # init also runs the init checks itself
```

How it works inside: [ARCHITECTURE.md](ARCHITECTURE.md). The conceptual API
([docs/api/overview.md](docs/api/overview.md)) is the spec the implementation follows.
