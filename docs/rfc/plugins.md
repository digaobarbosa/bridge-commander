# RFC: a plugin system where the built-ins are plugins too

Status: **implemented** on branch `rfc/plugins` (base `kiss/all` `1a4e73b`). The spec for what shipped is [docs/api/overview.md](../api/overview.md) § plugins; the exact shapes are in [plugins-contracts.md](plugins-contracts.md); how to write one is [docs/examples/plugins/README.md](../examples/plugins/README.md).

| Part | Where | Verified |
|---|---|---|
| Manifests, overlay, `when`, fields | `server/manifests.js`, `ui/js/when.js`, `ui/js/fields.js` | unit tests |
| Agent profiles, DeepSeek derived profile, typed options, leaks out of core | `harness/profiles.js`, `harness/*-tmux.js`, `plugins/{claude,codex,deepseek}` | conformance suite; real Claude Code launched against DeepSeek's API (401 with a dummy key: the env reached it; the key never in `ps` or `spawn-args`) |
| ACP adapter family + acp-host sidecar | `harness/acp-*.js`, `harness/ACP.md` | real `claude-agent-acp` lieutenant answered on the board chat, survived a BC server restart (same session, no respawn); ACP worker on a card, killed on archive |
| Plugin host, tracked runs (activities), commands, watchers, checks | `server/plugins.js`, `runs.js`, `commands.js`, `watchers.js`, `checks.js`, `prwatch.js`, `pluginapi.js` | server tests; browser e2e |
| UI: views registry (`main/v1`), card command table, badges, detail actions/sections, modal, taskbar, plugins settings, topbar, palette, settings sections, sidebar | `ui/js/views.js`, `cardactions.js`, `plugins.js`, `modal.js`, `commandui.js`, `activities.js`, `pluginsettings.js`, `topbar.js`, `palette.js`, `settingstabs.js`, `sidebar.js` | headless-Chromium e2e against the real server (29 + 31 checks), 390px mobile |
| Shipped plugins | `plugins/{github,local-git,open-in-editor,core-checks}`; examples `docs/examples/plugins/{rfslot,repo-link}` | browser e2e (deploy through a fake `rfslot` on PATH) |


## Why

Today every extension of Bridge Commander (BC) means editing the core. Here is what the captain wants to add without doing that:

- **Agents.** Claude and Codex are built in. Adding DeepSeek, Gemini or Qwen should be a small plugin.
- **Startup checks.** tmux, git identity, treehouse, gh auth.
- **Card actions.** "Open on GitHub". "Deploy": a modal with prefilled fields, then a run that the board tracks as an activity. "Checkout into my main folder". "Open in Cursor".
- **UI regions.** A sidebar, the central view, and a taskbar. The Kanban becomes one implementation of the central view.

The built-ins move onto the same plugin surface.

**What does not change.** The server is the harness. `board.json` is the canonical state. Delivery is a durable at-least-once queue. Supervision is infrastructure. Plugins sit **around** this kernel, not inside it.

## Prior art: what we copy, what we avoid

| Source | Idea we copy |
|---|---|
| VS Code | Declarative manifest; `when` clauses evaluated by the host; activation on intent |
| JupyterLab (Lumino) | The shell itself is plugins; **commands are the unit of behaviour**, and menus, the palette and keybindings only reference a command id; a core plugin is replaced by disabling it and providing the same id |
| Backstage (new frontend system) | Config can disable, move or configure any extension id; entity-scoped contributions use a declarative **predicate** (`filter`) plus a lazy `loader`; composable predicates from day one (issue #22390) |
| Grafana | Extension points declared in `plugin.json` with **versioned ids** (`…/v1`); the context is frozen before plugins see it; `limitPerPlugin` |
| Obsidian | `register*` helpers that auto-dispose on unload |
| Cordis / DeepSeek Harness | Services by name, with `requires`; every registration returns a disposer; built-ins register exactly as third-party plugins; typed list/chain slots whose entries get only the data they need (`{sessionId, displayTitle}`) |

We **avoid** per-item DOM hooks, like Obsidian's markdown post-processor and old Backstage's hand-wired JSX. Their cost is *N cards × M plugins × every SSE push*.

We take **no dependency** on Cordis: its API is marked "not yet stable", and DeepSeek Harness is a developer preview.

## Kernel vs plugins

**Kernel (not pluggable):**
- the store (`server/store.js`) and board normalization;
- queue and delivery (`server/delivery.js`);
- supervision, the worker lifecycle (`server/workers.js`) and the column state machine;
- the permissions broker and SSE;
- the plugin host itself;
- the registries for commands, activities, slots and harness adapter families.

**Plugins:** everything else. The migration table below shows the plan for each built-in.

## The unit: a plugin folder

```
plugins/<id>/                          # shipped with BC
<ws>/.bridge-commander/plugins/<id>/   # per workspace; same id replaces the shipped one
  plugin.json   # manifest: id, requires[], contributes{…}, config schema
  server.js     # optional, Node: module.exports = { activate(ctx) }
  ui.js         # optional, browser ES module: export default { activate(ui) }
```

The core renders menus, badges, forms and settings from `plugin.json` **without running plugin code**. Most plugins need only `plugin.json` plus shell commands, as workspace hooks do today. JS is the escape hatch.

The config overlay `.bridge-commander/plugins.json` can disable, reorder, move or configure any contribution id, built-ins included.

### Server `ctx`

Every `register*` returns a disposer, and deactivation unwinds them all.

| Surface | Purpose |
|---|---|
| `ctx.harness` | contribute **profiles** (see Slice 1); `register(name, impl)` for a whole adapter (rare) |
| `ctx.checks.register({id, phase, run})` | `phase` is `init`, `boot` or `card-start`. `run()` returns `{ok, message, fix?}`. `bc-axi init` and a board health panel list the checks |
| `ctx.events.on(name, fn)` | observe lifecycle events (emit only; see "Open questions") |
| `ctx.commands.handle(id, {prepare, run})` | the server side of a command |
| `ctx.activities` | the core service for tracked runs (see Commands) |
| `ctx.watchers.register({id, intervalMs, tick})` | periodic work; the PR watch moves here |
| `ctx.worktrees.register(provider)` | worktree providers: treehouse, git |
| `ctx.decorate(fn(card, board) → {badges, attrs})` | card data computed on the server (see Cards) |
| `ctx.routes` / `ctx.cli` | `/api/x/<plugin>/*` and `bc-axi <plugin> <verb>` |
| `ctx.board`, `ctx.config`, `ctx.log` | read access plus existing ops; config validated by the manifest schema; logs tagged by plugin |

Built-ins may use an **internal** tier of `ctx` until a surface proves stable. Only then does that surface become public. This is how we keep core velocity; see Risks.

## Slice 1 (decided): agent plugins contribute profiles

`kiss/all` already has `tmuxAdapter(profile)` (`harness/tmux-adapter.js`). It implements every verb once, and it has the claude and codex **profiles**, one turn-end relay (`harness/turnend-relay.js`), a bound port (`harness/port.js` `bind`), and `harness/test/conformance.test.js`. Slice 1 finishes that direction.

**Seam.** Adapter families are kernel and few:
- `tmux` exists;
- `acp` is new (see ACP);
- `fake` is for tests.

A plugin contributes a **profile**: facts about one CLI. `registerHarness(name, impl)` remains for the rare plugin that ships a whole adapter.

**Derived profiles are JSON.** Example `plugins/deepseek/plugin.json`:

```json
{ "id": "deepseek",
  "contributes": { "profiles": [{
    "name": "deepseek", "extends": "claude",
    "env": { "ANTHROPIC_BASE_URL": "https://api.deepseek.com/anthropic",
             "ANTHROPIC_AUTH_TOKEN": "${DEEPSEEK_API_KEY}",
             "ANTHROPIC_MODEL": "deepseek-chat" },
    "contextWindows": { "deepseek": 128000 } }] } }
```

- **Loader.** A new `harness/profiles.js` exposes `resolveProfile(json)`. It takes the base JS profile, overlays the JSON data fields, and builds `tmuxAdapter(merged)`. When the profile says `"adapter": "acp"`, it builds `acpAdapter(merged)` from `command/args/env` instead. Either way, it then calls `registerHarness`. An unknown `extends` fails loudly at load.
- **Registry.** `port.js` gains `listHarnesses()`. It feeds the harness dropdowns (`ui/index.html:375`, `:418`) and replaces the literal `'claude'` defaults (`server/server.js:809`, `:2442`) with a config default.

**Secrets.**
- `env` values may reference only `${VAR}`. The value comes from the server environment or from `.bridge-commander/secrets.env`, which is git-ignored.
- The adapter writes `<stateDir>/<key>.env` with mode `0600` and launches `set -a; . <file>; exec <cli>`.
- `<key>.spawn-args` records the **template**, never the expanded value. This is the same rule as "the brief never rides argv".

**Typed options replace `extraArgs` for model and effort.**
- `opts.model` and `opts.effort` go to `profile.modelArgs(model, effort) → argv`. Claude produces `--model` / `--effort`. Codex produces `-m` / `-c model_reasoning_effort=…`.
- **If a profile does not support an option, it is ignored and a warning lands on the card timeline.** Options are best-effort. The port rule "a verb a harness cannot honor THROWS" still applies to *verbs*.
- This fixes `--effort` reaching codex (`server/server.js:2453`) and the hard-coded `--model` (`:766`, `:2452`).

**Every remaining harness leak moves into the profile:**

| Leak on `kiss/all` | Profile field |
|---|---|
| `server/permissions.js:10-25`: `PERMISSION_MODES` and claude tool names in `summarize` | `permissions: {modes, describe(request)}` |
| `cli/bc-axi:427`: founder ref `harness:'claude'`, `CLAUDE_SESSION_ID` | `detectSelf(env)` |
| `cli/bc-axi:624-661`: `tmuxBacked`, the root/bypass check, "(ignored by X)" | `requirements: {bins, tmux, rootBypass}` |
| `server/firstrun.js`: `handRunLine` (gives codex claude's `--dangerously-skip-permissions`), `agentMissingText`, `diagnoseSpawn` | `handRunLine(mode)`, `installHint`, `diagnose(tail)` |
| `server/playbooks.js:310`: symlink into `~/.claude/skills` | `skillsDir(home)` |
| `bc-axi` statusline plus workspace Stop-hook install | `installWorkspace(ws, env)` (`harness/claude-settings.js` already owns the writer) |
| `harness/agent-status.js:64`: `CLAUDE_CONTEXT_WINDOWS` | `contextWindows`, as data; a derived JSON profile can override it |

The core reads data through one bound optional verb, `profileInfo()`, and calls the behavioural fields directly. After this slice, nothing in `server/`, `cli/` or `ui/` names a CLI.

**Tests.**
- `conformance.test.js` iterates `listHarnesses()`, so a JSON-derived profile joins the suite for free.
- New cases:
  - `extends` merge, and failure on an unknown base;
  - the secret is absent from argv, from the launch line and from `spawn-args`;
  - the env file has mode `0600`;
  - an unsupported option produces a timeline warning and no flag;
  - codex `modelArgs`.
- A grep test pins "no CLI name in `server/`, `cli/`, `ui/`" outside config defaults.

## ACP vs tmux: hybrid, behind the same port

The port already has ACP's shape:

| Port verb | ACP |
|---|---|
| `spawn` | `initialize` + `session/new` |
| `send` | `session/prompt` |
| `onTurnEnd` | prompt response `stopReason` (v2: `state_update` idle) |
| `resumable` / `resume` | `session/resume` (`session/load` in v1) |
| `kill` | `session/close` |
| `commands` | `available_commands_update` |
| `status` | `usage_update` |
| permission hook | `session/request_permission`, routed to the existing permissions broker |
| `openPane` | render the `session/update` stream as an event log (no terminal) |

**What ACP gives us:**
- structured tool calls, diffs, plans and usage;
- an explicit turn end;
- permissions as a protocol message, which retires the hook relay, statusline scraping and screen-signature regexes for those sessions;
- 40+ agents that already speak it (Gemini CLI, Qwen Code, OpenCode, Goose, Kimi, Copilot CLI, `dsh-acp`), so a new agent is nearly free.

**What ACP costs:**
- **No human attach.** The 👁 terminal drawer has nothing to show.
- **Process lifetime.** stdio children die with the server, and BC restarts often. Without a host process, every restart kills in-flight turns, which breaks "a restart is a non-event".
- **Adapter maturity.** `claude-agent-acp` and `codex-acp` each have around 100 open issues: steering, background tasks, a permission deadlock, orphaned children, partial history replay.
- **Spec churn.** Spec v2 is a draft with breaking changes: it removes `session/load` and the client `fs/*` and `terminal/*` methods.
- **Fidelity.** Some slash commands are filtered and there is no statusline.
- **Terms.** It is unclear whether a subscription login is allowed from third-party products.
- **DeepSeek Harness's own lesson.** It cut its ACP bridge to "automation-only" (2026-07-23), because a full bridge "had become a second interactive product UI".

**Decision.**
- tmux stays the default for **lieutenants**, because the captain talks to them and attaches to them.
- An `acp` adapter family serves **workers** and long-tail agents.
- It runs behind a small long-lived **acp-host** sidecar that owns the stdio children and exposes a local socket, so server restarts stay non-events.
- BC shows an ACP session as a read-only event log, and the composer sends prompts. BC does not rebuild a TUI.

**DeepSeek has two routes, and neither needs JS:**
- a derived profile over `claude` (above), which keeps the full TUI and works today;
- `{"adapter": "acp", "command": "npx", "args": ["@deepseek-ai/dsh-acp"]}`.

## Commands, menus and activities

**A command is the only unit of behaviour.** Buttons, menus, the palette, keybindings and card actions reference a command id. Where a command shows up is separate data.

```json
"commands": [{
  "id": "rfslot.deploy", "title": "Deploy", "icon": "🚀",
  "form": { "env": {"enum": ["staging", "prod"], "default": "staging"}, "slot": {"type": "string"} },
  "prepare": "server",
  "run": { "exec": "rfslot deploy --branch ${card.branch} --env ${input.env}", "cwd": "${card.worktree}" },
  "tracked": true }],
"menus": {
  "card.menu/v1":      [{ "command": "rfslot.deploy", "rank": 200,
                          "when": { "card.attributes.branch": {"$exists": true}, "project.id": "roboflow" } }],
  "detail.actions/v1": [{ "command": "rfslot.deploy" }],
  "palette/v1":        [{ "command": "rfslot.deploy" }] }
```

- **The core renders a generic modal from `form`.** `prepare` (the plugin's `server.js`) prefills it from the card, so a deploy plugin needs no UI code.
- **`run.exec`** goes through one core **tracked-run** module, built on the hook runner's `runOne`. That gives it process-group kill, timeouts, env, and a trace. **`run: "server"`** calls the plugin's handler instead.
- **`tracked: true` creates an Activity:** `{id, plugin, command, card, status, startedAt, endedAt, log}`, appended to `.bridge-commander/activities.jsonl`.
  - Its log streams over SSE.
  - It shows in the `taskbar` slot and as a chip on the card.
  - A failure queues an item for the card owner, the way `hook-failed` does.

More examples:

| Action | Definition |
|---|---|
| Open on GitHub | `{"open": "${card.attributes.prs[0].url}"}`, a link with no run |
| Checkout into my main folder | `exec: "git -C ${project.path} checkout ${card.branch}"` |
| Open in Cursor | `exec: "cursor ${card.worktree}"` |

## UI slots

The shell becomes a small slot host, and the built-ins fill its slots exactly as plugins do.

| Slot | Kind | Built-in fillers |
|---|---|---|
| `topbar.start/v1`, `topbar.end/v1` | list | title, filter, 🔔, ⚙️ |
| `sidebar/v1` | single | chat + lieutenant switcher |
| `main/v1` | keyed view | `kanban`, `table`, `archive`, `files`, `automation`, `settings` |
| `taskbar/v1` | list | activities (new), permission tray, status dot |
| `card.badges/v1` | list, data only | 🔐, ⏳, labels, PR chips, context bar |
| `card.menu/v1`, `card.actions/v1` | list, manifest only | 👁, move, archive, plugin commands |
| `detail.sections/v1` | list, lazy mount | attributes, labels, timeline, artifacts, body (generalizes `openAuxDetail`, `ui/js/detail.js:32`) |
| `settings.sections/v1` | list | labels, playbooks, projects, lieutenants (`WS_RENDER`, `ui/js/main.js:128`) |
| `modal` | host primitive | command forms; grows from `ui/js/popover.js` |

Rules:
- **Typed payloads.** No slot takes "any DOM". An action is `{command, when, rank}`, a badge is `{text, tone, tooltip}`, and a section is `{title, mount}`. Only `main`, `sidebar` and `detail.sections` get an element to paint.
- **Versioned ids**, deterministic `rank`, one provider per single slot (a conflict fails at load), and `limitPerPlugin` on list slots.
- **One error boundary per contribution.** A failing plugin renders "⚠ plugin X failed" in its own slot and nowhere else.

A view plugin looks like this: `{"contributes": {"views": [{"id": "kanban", "title": "▦", "slot": "main/v1"}]}}`, plus a `ui.js` that exports `render(el, board, api)`.

## Cards: how plugins touch them without being heavy

1. **Cards get data, never plugin code.** A card-level contribution takes one of two forms:
   - a manifest entry: a command placed with a `when`;
   - a server-computed decoration in `card.ext.<plugin>`.

   The core renders both inside the existing HTML-string path, so `setHtmlIfChanged` keeps working. No plugin function runs per card per render.
2. **`when` is a JSON predicate.**
   - Mongo-like: `$exists`, `$in`, `$any`, `$all`, `$not`.
   - Evaluated by the core over a small, frozen card context (`card.*`, `project.*`, `worker.state`, `harness`), and compiled once per manifest load.
   - User config uses the same syntax.
3. **Code activates on intent.**
   - `ui.js` loads when a view opens, a detail section opens, or a command runs.
   - `server.js` loads on the first command, event or decoration it serves. It loads at boot only if it registers a profile, a watcher or a check.
4. **Decorators run server-side** on board change, keyed by `card.updated`. Their cost is paid once per change, not once per client render.

A **pure card view model** (candidate 3 below) is the prerequisite. The card context for `when` and the badge data are the same derived facts the tile, the table row and the detail panel need today.

## Migration of built-ins

| Built-in | Became | Status |
|---|---|---|
| claude and codex profiles, fake | agent plugins `plugins/claude`, `plugins/codex` (declared, disable-able); fake stays a test harness | done |
| statusline, status readers | part of the claude and codex profiles | done |
| PR watch (`gh`) | `github` plugin (boot): the watcher through the internal tier, "Open PR on GitHub", a GitHub detail section. Disabling the plugin stops the PR watch | done |
| init checks | `core-checks` plugin; `bc-axi init` and boot run them | done |
| kanban, table, archive, automation (+ file, settings screens) | views in the `main/v1` registry; `view:kanban` can be switched off in the overlay | done |
| chat | the built-in `sidebar:chat` of `sidebar/v1`; a plugin sidebar replaces it when the overlay disables it | done |
| treehouse and git worktrees | still `server/worktrees.js` | **not done** — two providers, no third in sight; a seam with no new adapter is speculative |
| workspace hooks and the schedules UI | still kernel | **not done, on purpose** — `workers.end()` awaits the `card-archived` hooks before the release, so the hook runner is part of the lifecycle ordering, and the DNA keeps plugin events observe-only |
| TTS/STT proxies, voice, music, bridge3d | still built in | **not done** — moving them buys no new capability; they are the next candidates if a second implementation ever appears |

## Deepening work this RFC depends on

This comes from an architecture review (deep vs shallow modules, seams, locality). The review first ran on `0ada4c6`, was re-checked on `kiss/all` (`1a4e73b`), and the table below is the state after the implementation.

| # | Deepening | Status on `rfc/plugins` |
|---|---|---|
| 1 | Harness adapter owns all harness knowledge | **Done**: profiles own permissions, model/effort args, requirements, install hints, diagnose, workspace install, skills dir, context windows; `no-cli-names.test.js` pins `server/`, `cli/`, `ui/` |
| 2 | Worker lifecycle | **Mostly done** (on `kiss/all`); still open: start/resume kill fire-and-forget when an archive races them, a supervised death leaves the window open, hooks fire from 3 places |
| 3 | Pure card view model | **Done**: `ui/js/cardview.js` (`cardContext`, `cardFacts`); the table's missing ⚠/⏳ fixed |
| 4 | Card command table | **Done**: `ui/js/cardactions.js`; the move menu's archive refusal fixed |
| 5 | Tracked-run module | **Done**: `server/runs.js` over the exported `runOne`; teardown traced |
| 6 | View registry + render listeners | **Done**: `ui/js/views.js`; `onRender` is a listener set |
| 7 | Overlay/popover host | **Partial**: `modal.js` stacks with `popover.js`; the Escape chain in `main.js` and several click-away listeners are still hand-written |
| 8 | Watcher module | **Done**: `server/watchers.js`; supervise and the PR watch register through it, with a catch |

## Open questions

- **Veto.** `docs/api/overview.md:329` says hooks "never block or fail the lifecycle outcome they observe". A `card:before-start` veto would reopen that rule, so events are **emit only** until the captain decides otherwise.

  The code already bends this rule in one place. `workers.end()` awaits the `card-archived` hooks before it releases the worktree (`server/workers.js:449`; the reason is at `server/server.js:2290`), so on archive and merge the release waits on hooks. The DNA should say "hooks can delay the release but never refuse it", or the code should change.
- **Upstream.** This changes the architecture of `tonylampada/bridge-commander`. Open an RFC issue upstream before any slice beyond Slice 1 lands; otherwise the fork becomes permanent.

## Risks

- **Over-generic slots.** JupyterLab and Backstage both rewrote their extension inputs. Start with the slots that have real consumers (`main`, `card.menu`, `detail.sections`, `taskbar`) and add more on demand.
- **API churn vs core velocity.** Once built-ins go through the public API, internal refactors become breaking changes. Mitigate with the internal `ctx` tier, versioned slot ids and a frozen context.
- **UI refactor cost.** Modules bind DOM at import time. Migrate one region at a time, last.
- **Security.** Unchanged: a plugin is local code with full trust, like a hook. The board has no auth, so the loopback-only rule matters more.

## Phases

Each phase ships and is validated on the live board before the next starts.

1. **Slice 1: agent profiles.** The DeepSeek-derived profile answers as a lieutenant on the board.
2. **Plugin host, commands and activities.** The manifest loader, the tracked-run module, the generic form modal, the taskbar, and the `github` and `rfslot-deploy` plugins. A real deploy runs from a card.
3. **`acp` adapter and acp-host.** A pilot with a worker only. An ACP worker survives a server restart mid-turn.
4. **The `main/v1` view registry.** The Kanban becomes a view plugin.
5. **The remaining slots and tail migrations.**

## Verification per phase

- Run the suite the way CI does: `TMPDIR=/private/tmp/bct node --test --test-concurrency=1 test/*.test.js harness/test/*.test.js`.
- A plugin-host test loads a fixture plugin from a temp workspace (fake harness). It asserts that dispose unwinds every registration and that a disabled plugin contributes nothing.
- The real app is used after the captain restarts the live server; lieutenants cannot restart it.
- Measure render cost: time `render()` on a board of 300 synthetic cards before and after phase 5.
