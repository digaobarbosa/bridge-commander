# Writing a Bridge Commander plugin

A plugin adds behaviour to the board without a change to the core. Most plugins are one `plugin.json` file. The board reads it and renders menus, forms and sections from it. It runs no plugin code for that. JavaScript is the escape hatch, for work that data cannot do.

This guide uses real plugins as worked examples:

| Plugin | Where | Shows |
|---|---|---|
| `open-in-editor` | [plugins/open-in-editor](../../../plugins/open-in-editor/plugin.json) | an exec command, a plugin config, an env-var script |
| `local-git` | [plugins/local-git](../../../plugins/local-git/plugin.json) | a form, a tracked activity, a refusal with exit 1 |
| `github` | [plugins/github](../../../plugins/github) | a link command, a `server.js` (a watcher), a `ui.js` (a detail section) |
| `rfslot` | [docs/examples/plugins/rfslot](rfslot) | `prepare: "server"`: a form that opens pre-filled |
| `deepseek` | [plugins/deepseek](../../../plugins/deepseek/plugin.json) | an agent profile derived from `claude` |
| `core-checks` | [plugins/core-checks](../../../plugins/core-checks/plugin.json) | startup checks |

The design is in [docs/rfc/plugins.md](../../rfc/plugins.md). The exact contracts are in [docs/rfc/plugins-contracts.md](../../rfc/plugins-contracts.md).

## Where a plugin lives

```
<repo>/plugins/<id>/                     shipped with the board
<ws>/.bridge-commander/plugins/<id>/     your workspace's own
  plugin.json    the manifest (required)
  server.js      optional, Node:  module.exports = { activate(ctx) }
  ui.js          optional, browser ES module:  export function activate(ui)
```

A workspace folder with the same id **replaces** the shipped plugin whole. The board never mixes files from the two.

To try the `rfslot` example, copy it into your workspace:

```sh
cp -R docs/examples/plugins/rfslot <ws>/.bridge-commander/plugins/rfslot
```

A broken manifest never stops the board. The plugin shows as disabled, with the reason, in `GET /api/plugins` and in the server log.

## The manifest

```json
{
  "id": "open-in-editor",
  "name": "Open in editor",
  "description": "Open a card's worktree in your editor.",
  "version": "1.0.0",
  "enabled": true,
  "activation": "lazy",
  "server": "server.js",
  "ui": "ui.js",
  "config": { "editor": { "enum": ["cursor", "code", "zed", "idea", "subl"], "default": "cursor" } },
  "contributes": { "commands": [], "menus": {}, "sections": [], "badges": [], "views": [], "profiles": [], "checks": [] }
}
```

- `id` must equal the folder name. It matches `[a-z0-9][a-z0-9-]*`.
- An unknown key is an error. A typo that the board ignores is a contribution that never shows up.
- `enabled: false` ships the plugin off. The overlay can turn it on (see [The overlay](#the-overlay)).
- `activation` is `lazy` (the default) or `boot`. See [Server code](#server-code-serverjs).
- `config` uses the same field schema as a form (see [Forms](#forms)). The overlay supplies the values. A template reads them as `${config.<name>}`.

## Commands

A command is the only unit of behaviour. A menu entry, a button or a palette item only names a command id. Every command id starts with `<plugin id>.`.

```json
{ "id": "open-in-editor.open", "title": "Open in editor", "icon": "🖥",
  "description": "Open the card's worktree in the configured editor.",
  "run": { "exec": "${config.editor} ${card.worktree}", "timeoutMs": 30000 } }
```

`run` takes one of three forms:

| `run` | What happens |
|---|---|
| `{ "exec": "<shell line>", "cwd"?, "env"?, "timeoutMs"? }` | `/bin/sh -c` runs the line, on the server |
| `{ "open": "<url template>" }` | the browser opens the URL. Only `http(s)://` opens |
| `"server"` | your `server.js` handler runs (see [Server code](#server-code-serverjs)) |

`github.open-pr` is a link command:

```json
{ "id": "github.open-pr", "title": "Open PR on GitHub", "icon": "↗",
  "run": { "open": "${card.attributes.prs[0].url}" } }
```

### Templates and quoting

A template reads the card context with `${path}`. The roots are `card`, `project`, `worker`, `harness`, `input`, `config` and `workspace`. Any other `${NAME}` stays for the shell, so `${HOME}` is still `$HOME`.

**In an `exec` line, the board single-quotes every substitution.** The value arrives as one literal word, so a branch named `x'; rm -rf / #` is only an odd argument:

```
template:  ${config.editor} ${card.worktree}
card:      worktree = /w/x'; rm -rf / #
runs:      'cursor' '/w/x'\''; rm -rf / #'
```

Because the board quotes, write each substitution bare. The board refuses a line that puts `${…}` inside quotes, after `$` or `\`, in a comment, or in a here-doc.

`open` URLs, `cwd` and `env` values are not quoted. No shell reads them.

A value the card lacks refuses the run with the missing names (HTTP 422). A list or an object is not a value: use an index, as in `prs[0].url`.

### Environment variables

The exec line also gets the context as environment variables. Use them when you need the shell's own word splitting, or in shell code that must not meet a template:

| Variable | Value |
|---|---|
| `BC_CARD` | the card id |
| `BC_WORKTREE`, `BC_BRANCH` | the card's worktree and branch |
| `BC_REPO` | the project path |
| `BC_WORKSPACE` | the workspace root |
| `BC_COMMAND`, `BC_PLUGIN` | the command id and the plugin id |
| `BC_INPUT_<NAME>` | each form value, the field name in upper case |
| `BC_RUN` | the run id |

`open-in-editor.reveal` needs a `case` on the OS, so it reads the path from `$BC_WORKTREE` inside its own quotes:

```json
"exec": "case \"$(uname -s)\" in Darwin) exec open \"$BC_WORKTREE\" ;; *) exec xdg-open \"$BC_WORKTREE\" ;; esac"
```

`rfslot.deploy` wants `emulators app` as two words, so it uses `$BC_INPUT_SERVICES` unquoted. That is safe because the value comes from an `enum`:

```json
"exec": "rfslot use ${input.slot} --from ${card.worktree} --watch && rfslot start ${input.slot} $BC_INPUT_SERVICES",
"env": { "RFSLOT_OWNER": "${card.id}" }
```

`run.env` adds variables. Its values are templates, not quoted.

### Where it runs

`cwd` defaults to the card's worktree, then the project folder, then the workspace. A relative `run.cwd` resolves against that default. The default timeout is 30 minutes. `timeoutMs` changes it.

A template can only read the card context, so a plugin cannot name a script in its own folder from an exec line. Put a longer script inline, as `local-git.checkout` does, or use `run: "server"`.

## Menus: where a command shows up

```json
"menus": {
  "card.menu/v1":      [{ "command": "local-git.checkout", "rank": 420,
                          "when": { "card.branch": {"$exists": true}, "project.path": {"$exists": true} } }],
  "detail.actions/v1": [{ "command": "local-git.checkout", "rank": 420,
                          "when": { "card.branch": {"$exists": true}, "project.path": {"$exists": true} } }]
}
```

| Slot | Where |
|---|---|
| `card.menu/v1` | the card's menu on the board |
| `card.actions/v1` | the buttons on a card tile |
| `detail.actions/v1` | the header of the card detail |
| `palette/v1` | the command palette |

- A lower `rank` comes first. The default is 1000.
- Slot ids carry a version. A slot that changes shape gets a new id, so a plugin written for `v1` never half-renders.
- One plugin shows at most 8 entries per slot.
- Before a run, the server checks the `when` of the command's menu entries again. If no entry matches the card, it refuses with 403.

### `when`: the card context

A `when` is a JSON predicate over this frozen object:

```
{ card: { id, title, type, owner, column, labels[], attributes{}, playbook,
          branch, worktree, repo, prs[] },
  project: { name, path } | null,
  worker:  { state, live } | null,      // state: absent | idle | working | needs-you
  harness: string | null }
```

`card.branch`, `card.worktree` and `card.repo` come from `card.attributes`. `card.repo` is the project **name**, not a URL.

Each key of a predicate is a dotted path or a combinator. All keys must hold.

| Form | Meaning |
|---|---|
| `{"card.column": "review"}` | equal (for a list: contains) |
| `{"card.worktree": {"$exists": true}}` | carries a value. An empty string or list does not |
| `{"card.column": {"$in": ["working", "review"]}}` | one of |
| `$eq $ne $nin $gt $gte $lt $lte $regex $contains` | as the names say |
| `{"$any": [p, q]}`, `{"$all": [p, q]}`, `{"$not": p}` | or, and, not |

An unknown operator fails when the manifest loads, and the plugin shows as disabled with the error.

## Forms

A command with a `form` opens a modal before it runs. The core renders it. You write no UI code.

```json
"form": {
  "slot":     { "type": "string", "required": true, "title": "Slot" },
  "services": { "enum": ["emulators app", "emulators", "app", "api"], "default": "emulators app" }
}
```

A field has `type` (`string`, `text`, `number`, `boolean` or `enum`; `enum` is implied by a list), `title`, `description`, `default`, `required` and `placeholder`. The browser and the server validate with the same rules (`ui/js/fields.js`). A `string` is one line, and a `text` can hold several.

A template reads the values as `${input.<name>}`. The env reads them as `$BC_INPUT_<NAME>`.

### `prepare`: a form that opens pre-filled

With `"prepare": "server"`, the board asks your `server.js` for values before the modal opens. `rfslot` runs `rfslot ls` and offers the first slot whose lease reads `free` or `expired`:

```js
function activate(ctx) {
  ctx.commands.handle('rfslot.deploy', {
    async prepare(req) {           // req = { card, context, input, config }
      const slot = pickSlot(parseLs(await ls()));
      return slot ? { slot, services: 'emulators app' } : { services: 'emulators app' };
    },
  });
}
```

- `prepare` returns form values only. The board lays them over the field defaults.
- It has no message channel. Say why a field is empty with `ctx.log`, and let the captain fill it.
- Give every external call a timeout. The modal waits for the answer.

## Tracked runs: activities

With `"tracked": true`, a run becomes an **activity**:

- It is appended to `<ws>/.bridge-commander/activities.jsonl`, at start and at end.
- Its full output goes to a log that streams live (`GET /api/activities/:id/stream`).
- It shows in the taskbar and on the card.
- If it fails, the card owner gets an item in their queue.

Track a run the captain waits for or must see fail: a checkout, a deploy. Do not track a fire-and-forget action, such as opening an editor.

A clear failure is part of the command. `local-git.checkout` checks first, prints why it refuses, and exits 1:

```
refusing: /p/app has uncommitted changes. Commit or stash them there first:
 M src/index.js
```

## Server code: `server.js`

```js
module.exports = {
  activate(ctx) { /* register things; each call returns a disposer */ },
  deactivate() { /* optional */ },
};
```

The board calls `activate(ctx)` once. `ctx` holds:

| Member | Use |
|---|---|
| `ctx.plugin` | `{ id, dir, config }`, frozen |
| `ctx.log(msg)` | the server log, tagged with the plugin id |
| `ctx.commands.handle(id, { prepare?, run? })` | the server side of a command. `run(req)` returns `{ok, message?}` or throws |
| `ctx.events.on(name, fn)` | observe `card-created`, `card-moved`, `card-archived`, `worker-started`, `worker-done`, `worker-died`, `activity-ended`. Observe only: the return value is ignored |
| `ctx.decorate(fn(card, board))` | server-computed card data: `{ badges: [{text, tone?, tooltip?}], attrs }`. Synchronous; cached per card change |
| `ctx.watchers.register({ id, intervalMs, tick })` | periodic work, with an overlap guard and a catch |
| `ctx.routes.handle(method, subpath, fn(req, res, body))` | `/api/x/<plugin>/<subpath>` |
| `ctx.api` | `board()`, `findCard(id)`, `queuePush(owner, item)`, `cardEvent(card, text, kind)`, `runs`, `commit()` |

**Activation.** A `lazy` plugin starts on its first command handler or route. Events, decorators and watchers only reach a plugin that already runs, so a plugin that uses them says `"activation": "boot"`.

Deactivation runs every disposer, then `deactivate()`. That includes registrations the plugin did not undo itself. An error in a handler is logged with the plugin id and goes no further.

**The internal tier.** A shipped plugin also gets `ctx.internal`, for surfaces that are not stable yet. `github` is an example: the board builds the PR watch and the plugin decides if it runs.

```js
function activate(ctx) {
  const internal = ctx.internal;
  if (!internal || !internal.prWatch) { ctx.log('no internal PR watch; the PR watch is not running'); return; }
  ctx.watchers.register({ id: 'prwatch', intervalMs: internal.prWatchIntervalMs, tick: internal.prWatch.tick });
}
```

A workspace copy of `github` gets no `ctx.internal`, so it logs and does nothing. Disabling `github` stops the PR watch.

## Browser code: `ui.js`

A plugin that contributes `views` or `sections` needs a `ui` module. The board serves it at `/plugins/<id>/<file>` and loads it the first time it is needed.

```json
"sections": [{ "id": "prs", "slot": "detail.sections/v1", "title": "GitHub",
               "when": { "card.attributes.prs": { "$exists": true } } }]
```

```js
export function activate(ui) {
  ui.sections.register({
    id: 'prs',                                     // the manifest's sections[].id
    render(el, card, state) { el.innerHTML = prsHtml(card, ui.html.esc); },
    dispose(el) {},
  });
}
```

`ui` holds:

| Member | Use |
|---|---|
| `ui.plugin` | `{ id, config }` |
| `ui.views.register({ id, render(el, state), dispose? })` | a `main/v1` view |
| `ui.sections.register({ id, render(el, card, state), dispose? })` | a `detail.sections/v1` or `settings.sections/v1` section |
| `ui.state()` | `{ doc, context(card) }`: the live board and the card context |
| `ui.openCard(id)`, `ui.openActivity(id)`, `ui.toast(text)` | shell actions |
| `ui.api(method, path, body)` | a same-origin fetch that returns JSON |
| `ui.html.esc(s)` | the escaper |

- `render` runs again on every board push while the section is visible. Keep it cheap and idempotent. `github` builds a string and writes the DOM only when the string changed.
- **Escape every value.** A card attribute can hold anything. Put only `http(s)` links in an `href`.
- A throwing `render` shows "⚠ plugin X failed" in its own slot and nowhere else.

## Agent profiles

A plugin can add an agent to the harness dropdowns with a **profile**. A profile is data, so it needs no JavaScript.

**Derived from a built-in (tmux).** `deepseek` keeps Claude Code's full TUI and points it at DeepSeek's Anthropic-compatible API:

```json
{ "id": "deepseek",
  "contributes": { "profiles": [{
    "name": "deepseek", "extends": "claude",
    "env": { "ANTHROPIC_BASE_URL": "https://api.deepseek.com/anthropic",
             "ANTHROPIC_AUTH_TOKEN": "${DEEPSEEK_API_KEY}",
             "ANTHROPIC_MODEL": "deepseek-chat" },
    "contextWindows": { "deepseek": 128000 } }] } }
```

**An ACP agent.** Any agent that speaks the [Agent Client Protocol](https://agentclientprotocol.com) runs behind the `acp` adapter. BC shows its session as a read-only event log. See [harness/ACP.md](../../../harness/ACP.md).

```json
{ "id": "codex-acp",
  "contributes": { "profiles": [{
    "name": "codex-acp", "adapter": "acp",
    "command": "npx", "args": ["-y", "@agentclientprotocol/codex-acp"] }] } }
```

DeepSeek can also run this way: `{"name": "deepseek-acp", "adapter": "acp", "command": "npx", "args": ["@deepseek-ai/dsh-acp"], "env": {"DEEPSEEK_API_KEY": "${DEEPSEEK_API_KEY}"}}`.

Profile fields: `name`, `extends`, `adapter` (`tmux`, the default, or `acp`), `env`, `contextWindows`, `requirements`, `installHint`, and for `acp` only `command` and `args`. An unknown `extends` fails at load.

Use tmux for an agent you talk to and attach to (a lieutenant). Use ACP for workers and for agents that have no TUI worth attaching to.

## Secrets

- A profile `env` value is either a literal with no `${`, or exactly `${NAME}`.
- A key that ends in `KEY`, `TOKEN`, `SECRET` or `PASSWORD` must be a `${NAME}` reference. A literal secret in a manifest fails the load.
- `${NAME}` resolves from the server's environment, then from `<ws>/.bridge-commander/secrets.env` (`NAME=value` lines). Keep that file out of git.
- At launch the value goes to a `0600` env file that the launch line sources. It never appears in argv, in the tmux launch line, or in `spawn-args`.

Command templates have no secret root. An exec line that needs a token reads the server's environment (`"$GH_TOKEN"`), and the tool reads its own config (`gh auth login`, `rfslot`'s own settings).

## Startup checks

`core-checks` declares what the board needs on the machine. `bc-axi init` and the board's health panel list the results.

```json
"checks": [
  { "id": "gh", "phase": "boot", "bin": "gh", "title": "gh (GitHub CLI) is installed",
    "severity": "warn", "hint": "brew install gh, then gh auth login" },
  { "id": "git-identity", "phase": "init", "exec": "git config user.name && git config user.email",
    "title": "git has an identity", "severity": "warn" }
]
```

`bin` passes when the binary is on PATH. `exec` passes on exit 0, and its first output line becomes the message. `phase` is `init`, `boot` or `card-start`.

## The overlay

`<ws>/.bridge-commander/plugins.json` turns plugins and single contributions on and off, sets config, and reorders. The Plugins section in Settings writes it (`PUT /api/plugins/overlay`).

```json
{
  "plugins": {
    "deepseek":       { "enabled": true },
    "open-in-editor": { "config": { "editor": "zed" } }
  },
  "contributions": {
    "command:open-in-editor.reveal":                   { "enabled": false },
    "menu:card.menu/v1:github.open-pr":                { "rank": 50 }
  }
}
```

A contribution key is `<kind>:<id>`: `command:…`, `section:…`, `badge:…`, `view:…`, `check:…`, `profile:<name>`. A menu entry is `menu:<slot>:<command id>`. Built-in contributions use the same keys, so the overlay can turn them off too.

## Test your plugin

`test/shipped-plugins.test.js` is the model. For each plugin it:

1. loads the manifest with `readManifest` and compiles every `when`;
2. plans each exec command with `planRun` against a card whose branch is `x'; rm -rf / #`, and checks that the value arrives quoted;
3. runs the planned line for real where that is safe: `local-git` in a temp repo with a linked worktree, `open-in-editor` with the editor swapped for `echo`, `rfslot` with a fake `rfslot` on PATH;
4. calls `server.js` with a fake `ctx`, and `prepare` with a captured `rfslot ls` as the fixture.
