# Plugin system: implementation contracts

This file holds the working contracts between the implementation slices of [plugins.md](plugins.md). Every module follows the house style:
- Node built-ins only, zero dependencies.
- The `createX(deps)` factory with every side effect injected. See `server/store.js` and `server/workers.js`.
- Comments explain WHY.
- Tests use `node:test` and run in-process where they can.

A browser module is an ES module in `ui/js/`. A module that both the server and the UI need is DOM-free, lives in `ui/js/`, and the server loads it with a dynamic `import()`. `ui/js/when.js` and `ui/js/fields.js` are examples.

Already on the branch:
- `server/manifests.js`: discovery, validation, the overlay, contributions.
- `ui/js/when.js`: `compileWhen`, `matches`, `getPath`.
- `ui/js/fields.js`: `validateValues`, `defaultsFor`.

## Terms

- **Plugin:** a folder with `plugin.json`, found in `<repo>/plugins/<id>/` (shipped) or `<ws>/.bridge-commander/plugins/<id>/` (workspace, which replaces a shipped plugin of the same id).
- **Overlay:** `<ws>/.bridge-commander/plugins.json`, shaped as `{plugins: {<id>: {enabled?, config?}}, contributions: {<key>: {enabled?, rank?}}}`.
- **Contribution key:** `<kind>:<id>`, for example `command:deploy.run` or `view:kanban`. A menu entry's key is `menu:<slot>:<command>`.
- **Card context:** the frozen object that `when` predicates and command templates read. It is built by `cardContext(card, doc)` in `ui/js/cardview.js`:
  ```
  { card: { id, title, type, owner, column, labels[], attributes{}, playbook, branch, worktree, repo, prs[] },
    project: { name, path } | null,
    worker: { state } | null,     // state: absent|idle|working|needs-you (the lease) plus live: bool (a worker record exists)
    harness: string | null }      // the card's worker harness, else null
  ```
  `branch`, `worktree` and `repo` come from `card.attributes`, which the server writes. `prs` is `card.attributes.prs || []`.

## Slice A1: agent profiles (harness/, plus the leaks listed in plugins.md § Slice 1)

- `harness/profiles.js`
  - `resolveProfile(json, bases) → profile`.
    - `bases` is a `name → base profile object` lookup.
    - The JSON may carry: `name`, `extends`, `adapter` (`'tmux'`, the default, or `'acp'`), `env`, `contextWindows`, `requirements`, `installHint`, and for acp only `command`, `args`.
    - An `env` value is either exactly `${NAME}` (a reference) or a literal with no `${`. A key whose name ends in `KEY`, `TOKEN`, `SECRET` or `PASSWORD` must be a reference. Anything else throws.
    - An unknown `extends` throws.
  - `loadProfiles({ profiles, stateDir, log }) → [{name, plugin, ok, error?}]`.
    - `profiles` is `contributions(catalog).profiles`.
    - It registers each one through `port.registerHarness(name, adapter(profile))`.
    - A failure is recorded and logged. It is never fatal.
  - `expandEnv(env, sources) → {env, missing[]}`. `sources` are `process.env` then `<stateDir>/secrets.env`, in `KEY=value` lines.
- `harness/port.js`
  - `listHarnesses() → [{name, adapter, plugin?}]`: built-ins plus registered harnesses, sorted, and without `fake` unless `BC_FAKE_STATE` or `BC_LIST_FAKE` is set.
  - `defaultHarness()` returns `'claude'`. It is the only place that literal lives outside the profiles and the config default.
- Every profile-backed impl gains an optional verb `profileInfo() → data`. It is not an opts verb, so `bind` passes it through:
  ```
  { name, adapter, options: ['model','effort'],      // typed options this profile honors
    permissionModes: [...], requirements: { bins: [...], tmux: bool, rootBypass: bool },
    installHint: string, contextWindows: [[needle, n], ...] }
  ```
- `opts.model` and `opts.effort` join the opts bag. Each profile has `modelArgs({model, effort}) → argv[]`. The server passes only the options listed in `profileInfo().options`. For every other option it lands a card or lieutenant timeline warning: `"<harness> does not support <opt>; started without it"`.
- **Env at launch:**
  - Expanded values go to `<stateDir>/<key>.env` with mode 0600.
  - The launch sources that file (`set -a; . <file>; set +a; exec …`).
  - `<key>.spawn-args` records only the templates.
  - A secret never appears in argv, in the launch line typed into tmux, or in `spawn-args`.

## Slice A2: plugin host, tracked runs, commands (server/)

- `server/hooks.js`
  - Export `runOne(label, cmd, args, env, cwd, timeoutMs, opts)` and document it.
  - Add `opts.onOutput(chunk: string)`, which streams every stdout and stderr chunk as it arrives.
  - `runTeardown` now traces through `traceRun`, as `{hook: 'teardown', trigger: 'teardown', card}`. The DNA says every run is traced.
- `server/runs.js`: `createRuns({ stateDir, now, log, onChange, runOne })`. A run is an **activity** when `tracked`.
  - `start({ plugin, command, title, card, owner, shell, cwd, env, timeoutMs, tracked }) → run`.
    - `run = { id, plugin, command, title, card, owner, status: 'running'|'ok'|'failed'|'canceled'|'timeout', startedAt, endedAt?, code?, error? }`.
    - The id is `r-<base36 time>-<4 hex>`.
    - It runs `/bin/sh -c shell` through `runOne`.
    - The full output goes to `<stateDir>/runs/<id>.log`, with no 4 KB cap. Cap the log at 5 MB, then truncate with a note.
    - Tracked runs are appended to `<stateDir>/activities.jsonl`, one line at start and one at end.
    - `onChange()` fires on start and on end.
  - `list({ card?, limit = 30 }) → run[]`: tracked runs, newest first. Running runs come first. It is loaded from `activities.jsonl` on boot, and a run that was `running` at boot is marked `failed` with `error: 'server restarted'`.
  - `get(id)`.
  - `readLog(id, { from = 0 }) → { text, size, done }`.
  - `subscribe(id, fn(chunk)) → unsubscribe`.
  - `cancel(id) → bool`, which kills the process group.
  - `onEnd(fn(run))`: the server uses it to queue `activity-failed` to the card owner.
- `server/commands.js` (pure)
  - `expandTemplate(tpl, scope, { quote }) → { text } | { error, missing[] }`.
    - It resolves `${path}` with `getPath` from `when.js`, so it is loaded via `import()`. It is async, or it takes `getPath` as an injected dependency.
    - With `quote: true`, every substitution is POSIX single-quoted. A template never interpolates raw user text into a shell.
    - `scope = { card, project, worker, harness, input, config, workspace }`.
  - `planRun(command, { context, input, config, workspace }) → { kind: 'exec', shell, cwd, env, timeoutMs, tracked } | { kind: 'open', url } | { kind: 'server' } | { error, code }`.
    - It validates `input` with `fields.validateValues(command.form, input)`.
    - `cwd` defaults to `context.card.worktree`, then the project path, then the workspace. `exec` is quoted, `open` is not, and `cwd` is not.
- `server/plugins.js`: `createPluginHost({ catalog, log, now, api, internal })`.
  - `catalog()` returns the result of `resolveCatalog`.
  - `api` is what every plugin's `ctx` may reach: `{ board() (read-only), findCard(id), queuePush(owner, item), cardEvent(card, text, kind), runs, commit() }`.
  - `internal` is given only to `source === 'shipped'` plugins, as `ctx.internal`.
  - `activate(id) → Promise<void>`: requires `<dir>/<server>` and calls `activate(ctx)`. The ctx:
    ```
    ctx = { plugin: { id, dir, config }, log(msg),
            commands: { handle(commandId, { prepare?(req), run?(req) }) → dispose },
            events:   { on(name, fn(payload)) → dispose },
            decorate(fn(card, board) → { badges?: [{text, tone?, tooltip?}], attrs?: {} }) → dispose,
            watchers: { register({ id, intervalMs, tick }) → dispose },
            routes:   { handle(method, subpath, fn(req, res, body)) → dispose },
            api, internal? }
    req (prepare/run) = { card, context, input, config, activity? }   // prepare → defaults object; run → {ok, message?} or throws
    ```
  - Every registration returns a disposer. `deactivate(id)` runs them all, then the module's `deactivate?()`.
  - `bootActivate()` activates the enabled plugins with `activation: 'boot'`.
  - `reload()` re-reads the catalog and deactivates plugins that are gone or disabled.
  - Lazy activation happens on the first `handler(commandId)`, `route(id, …)` or `emit` that a plugin declares. A lazy plugin that registers events must say `activation: 'boot'`.
  - `emit(name, payload)` is observe-only (DNA rule). Handlers run in a try/catch; an error is logged and tagged with the plugin. Events: `card-created`, `card-moved`, `card-archived`, `worker-started`, `worker-done`, `worker-died`, `activity-ended`.
  - `decorations(card, board) → { <pluginId>: { badges, attrs } | { error } }`, cached per `card.id + card.updated`.
  - `handler(commandId) → Promise<{prepare?, run?} | null>`.
  - `route(pluginId, method, subpath) → Promise<fn | null>`.
  - `status() → [{ id, active, error? }]`.
  - Watcher registration is delegated to `deps.watchers` (see A5).

## Slice A3: pure UI modules and the card view model (ui/js/)

- `ui/js/cardview.js` (pure, candidate 3)
  - `cardContext(card, doc)` as above.
  - `cardFacts(card, doc, nowMs) → { emoji, ownerName, workerState, live, needsApproval, pendingOrder, owed, stale, queued, unread, messageCount, archiveReason, canArchive: {ok, reason}, canEditOwner, canEditPlaybook }`.
  - `board.js`, `table.js`, `archtable.js`, `detail.js` and `bulk.js` render from `cardFacts`, not from their own copies. This fixes the table's missing ⚠ and ⏳, and the move menu's archive, which must check `canArchive` the way the bulk bar does.
- `ui/js/form.js` (DOM)
  - `formHtml(fields, values, { idPrefix }) → string`: escaped, one labelled control per field.
  - `readForm(root, fields) → raw values`. Validation is `fields.validateValues`.
- `ui/js/slots.js` (DOM-free registry)
  - `contribute(slot, entry) → dispose`. The entry is `{ key, plugin?, rank = 1000, when?, ...payload }`.
  - `entries(slot, ctx?) → entry[]`: filtered by `when` (`matches`) and by `disabled` keys, sorted by `rank` then `key`, and capped by `limitPerPlugin` (default 8 per plugin per slot).
  - `setDisabled(keys[])`, `onChange(fn) → dispose`.
  - `boundary(entry, fn) → value | { error }`: the error boundary.
  - `badgeHtml(badge)` and `failedHtml(entry, error)` render the markup for a data badge and for a "⚠ plugin X failed" placeholder.

## Slice A4: ACP adapter family (harness/)

- `harness/acp-adapter.js`: `acpAdapter(profile) → impl`, with `profile = { name, command, args[], env{} }`.
  - It implements the 7 verbs plus `openPane`, `paneSnapshot`, `commands`, `runCommand` (pass-through prompt), `status` and `profileInfo`.
  - `ref = { harness: name, session: 'acp-<key>', window?, cwd, resumeId? }`. `resumeId` is the ACP sessionId.
- `harness/acp-host.js`: a long-lived sidecar, one per stateDir.
  - It is detached and started on demand by the adapter. It listens on a unix socket at `<stateDir>/acp-host.sock` and speaks JSON lines to the adapter.
  - It owns the agent child processes and speaks ACP (JSON-RPC 2.0 over stdio) to them.
  - Turn ends go through `harness/turnend-relay.js`, with `harness: name` and `session: key`: record and POST to the callback URL. The server needs no new route.
  - `session/request_permission` is POSTed to `<origin of callbackUrl>/api/permission`, with the same body shape `harness/permission-hook.js` sends. The reply is mapped to the agent's allow or reject option.
  - Every `session/update` is appended to `<stateDir>/<key>.acp.jsonl`, which `openPane` renders as text frames.
  - A server restart does not touch the host or its children.
- `harness/test/fake-acp-agent.js` is a scriptable ACP agent for tests. `harness/test/acp-conformance.test.js` runs the port's promises against it.

## Slice A5: watchers, the PR watch, checks (server/)

- `server/watchers.js`: `createWatchers({ log, setInterval })`.
  - `register({ id, intervalMs, tick }) → dispose`.
  - `intervalMs <= 0` disables the watcher.
  - An overlap guard skips a tick while the previous one runs.
  - Every tick error is caught and logged with the id.
  - Timers are `unref`'d.
  - `list()`, `stop()`.
- `server/prwatch.js`: `createPrWatch(deps) → { tick }`. This is `prWatchTick`, lifted out of `server.js` unchanged in behaviour, with its dependencies injected. Supervision and the PR watch both register through watchers.
- `server/checks.js`: `createChecks({ log, which, exec })`.
  - `register({ id, plugin, phase, title, severity: 'error'|'warn', run }) → dispose`.
  - `fromManifest(check, { plugin, dir }) → registration`. `bin` is checked on PATH. `exec` runs a shell command in the plugin folder, where exit 0 means ok and the first output line becomes the message. `hint` becomes `fix`.
  - `run(phase) → [{ id, plugin, title, severity, ok, message, fix, ms }]`.
- `plugins/core-checks/plugin.json` declares these checks:

  | Check | Phase | Severity |
  |---|---|---|
  | tmux (bin) | init | error |
  | git (bin) | init | error |
  | git identity (exec) | init | warn |
  | gh (bin) | boot | warn |
  | treehouse (bin) | boot | warn |

## Wave B: HTTP routes (server wiring) and UI

All new routes live under `/api/plugins` and `/api/activities`, plus plugin routes.

| Route | Body → answer |
|---|---|
| `GET /api/plugins` | → `{ plugins: [{id, name, description, version, source, enabled, error, active, config, configSchema, ui: '/plugins/<id>/<ui>'?}], contributions: { commands, menus, badges, views, sections, checks }, harnesses: listHarnesses(), disabled: [contribution keys] }`. The server-side `run.exec` and `env` are stripped from commands. The UI receives `{id, title, icon, description, form, prepare, tracked, open?}`, where `open` is the unexpanded template for link commands |
| `PUT /api/plugins/overlay` | `{ plugins?, contributions? }` → writes the overlay, `reload()`s, broadcasts |
| `POST /api/commands/:id/prepare` | `{ card }` → `{ values }`: the form defaults, merged with the plugin's `prepare` |
| `POST /api/commands/:id/run` | `{ card, input }` → `{ ok, activity?, url?, message? }`. It re-checks every `when` of the command's menu entries against the card context and refuses with 403 when none matches |
| `GET /api/activities?card=` | → `{ activities }` |
| `GET /api/activities/:id/log?from=` | → `{ text, size, done }` |
| `GET /api/activities/:id/stream` | SSE: a `chunk` event per piece of output, then `end` |
| `POST /api/activities/:id/cancel` | → `{ ok }` |
| `GET /api/checks?phase=boot` | → `{ checks: [...] }` |
| `* /api/x/<plugin>/<subpath>` | the plugin's routes |
| `GET /plugins/<id>/<file>` | serves the plugin's `ui` module and files under its `ui/` folder, nothing else |

- **Board payload:**
  - Each served card gains `ext: decorations(card)`. The key is omitted when it is empty.
  - The board gains `activities: runs.list({ limit: 30 })`.
  - The board gains `pluginsVersion`, a counter bumped by `reload()`, so the UI refetches `/api/plugins`.
- **Events:** `plugins.emit` fires next to the existing `fireHooks` calls, and at card create, card move and worker start.
- **UI:**
  - `ui/js/plugins.js` fetches `/api/plugins` and registers its contributions into `slots.js`.
  - `ui/js/views.js` is the `main/v1` registry. The built-in kanban, table, archive and automation views register through it.
  - `ui/js/modal.js` is the modal host: a stack, Escape, and the popover interplay.
  - `ui/js/cardactions.js` holds the built-in card commands (move, archive, peek, talk, select). The tile, the move menu (`card.menu/v1`), the detail header (`detail.actions/v1`) and the table all read it.
  - A taskbar shows activities, and a click opens the log.
  - A "Plugins" settings section lists plugins and enables or disables them through the overlay.

## As built in wave A (read this before wave B)

- `server/plugins.js` `createPluginHost({catalog, log, now, api, internal, watchers, load?})`.
  - Async: `reload`, `activate`, `deactivate`, `bootActivate`, `handler`, `route`.
  - Sync: `emit`, `decorations`, `status`, `catalog`.
  - **Use `contributions(host.catalog())`**. A plugin with a bad `when` is rewritten there as `enabled:false` with an error.
  - Lazy activation happens only through `handler()` and `route()`. Decorators and event listeners need `activation: "boot"`.
- `server/runs.js`: sync. `subscribe(id, fn, end?)`. `readLog` returns `size` = the next `from`.
- `server/commands.js`: async. `planRun(command, {context, input, config, workspace})`, and the exec env carries `BC_CARD`, `BC_WORKTREE`, `BC_BRANCH`, `BC_REPO`, `BC_COMMAND`, `BC_PLUGIN`, `BC_WORKSPACE`, `BC_INPUT_<NAME>`, `BC_RUN`.
- `server/watchers.js` `createWatchers` has a module-level `watchers` const in `server.js`. `server/checks.js` has `createChecks`. `server/prwatch.js` has `createPrWatch`.
- `harness/port.js` has `listHarnesses()`, `defaultHarness()` and `profileOf(name)`. Impls expose `profileInfo()`.
- `ui/js/cardview.js` has `cardContext` and `cardFacts`. `ui/js/slots.js`, `ui/js/form.js`.

## Internal tier: the PR watch belongs to the `github` plugin

- `server.js` stops registering the PR watch itself. It passes `internal = { prWatch: <createPrWatch instance {tick}>, prWatchIntervalMs: <parsed BC_PRWATCH_INTERVAL_MS, default 120000> }` to the host.
- The shipped `plugins/github` has `activation: "boot"`. It registers `ctx.watchers.register({id: 'prwatch', intervalMs: ctx.internal.prWatchIntervalMs, tick: ctx.internal.prWatch.tick})`.
- **Disabling the github plugin disables the PR watch.** That is the point of "built-ins are plugins".

## Plugin UI modules (browser)

A plugin's `ui` file is an ES module served at `/plugins/<id>/<file>`. It is loaded lazily: the first time one of its views is shown, one of its sections is rendered, or it is needed.

```js
export function activate(ui) { … }   // called once
ui = {
  plugin: { id, config },
  views:    { register({ id, render(el, state), dispose?(el) }) → dispose },       // id = the manifest's views[].id
  sections: { register({ id, render(el, card, state), dispose?(el) }) → dispose }, // id = the manifest's sections[].id
  state()      → { doc, context(card) },   // the live board doc; cardContext
  openCard(id), openActivity(id), toast(text),
  api(method, path, body) → Promise<json>, // same-origin fetch helper
  html: { esc },                           // escaping helper
}
```

- `render` is called again on every board push, only while the view or section is visible. It must be idempotent and cheap. The shell wraps every call in the slot error boundary.
