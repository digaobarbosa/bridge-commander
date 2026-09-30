# Card brief: Slice 1, agent plugins contribute profiles

Project: bridge-commander. Base branch: `kiss/all`. Design: [plugins.md § Slice 1](plugins.md#slice-1-decided-agent-plugins-contribute-profiles).

## Goal

A harness is an **adapter family** plus a **profile**. Profiles can be declared in JSON, deriving from a built-in profile. Nothing in `server/`, `cli/` or `ui/` names a CLI.

This is done when a JSON-only `deepseek` profile (see below) can run a lieutenant on the live board, and the whole suite passes.

## Scope

1. **Loader and registry.** Add `harness/profiles.js` with a `resolveProfile(json)` function.
   - `extends` a registered JS profile, then overlay the data fields: `name`, `env`, `contextWindows`, `requirements`, `installHint`.
   - Build `tmuxAdapter(merged)` and call `registerHarness`.
   - An unknown base, or a duplicate name, throws at load.
   - Load profiles from `plugins/*/plugin.json` (shipped) and from `<ws>/.bridge-commander/plugins/*/plugin.json` (workspace). A workspace id replaces a shipped one.
   - Add `listHarnesses()` to `harness/port.js`.
2. **Env and secrets.**
   - Env values must match `${VAR}`. A literal secret is rejected at load.
   - Resolve values from `process.env`, then from `.bridge-commander/secrets.env` (git-ignored; add it to the workspace `.gitignore` seed).
   - The tmux adapter writes `<stateDir>/<key>.env` with mode `0600` and launches `set -a; . '<file>'; exec <cli …>`.
   - `<key>.spawn-args` records the template only, and resume re-expands it.
3. **Typed options.**
   - Add `opts.model` and `opts.effort` to the port's opts bag.
   - Each profile gets `modelArgs(model, effort) → argv`:
     - claude produces `--model`, `--effort`;
     - codex produces `-m <model>`, `-c model_reasoning_effort=<effort>`. Check the flag names against the installed `codex --help` before relying on them.
   - The server stops building `extraArgs` for model and effort (`server/server.js:766`, `:2452-2453`).
   - If a profile returns no args for an option it was given, the server lands a timeline warning on the card and starts anyway. This is the captain's rule: options are best-effort, verbs still throw.
4. **Move the leaks into profiles.** For the full table, see the RFC. Each item below lists the file, what it knows today, and what replaces it:
   - `server/permissions.js`: the modes and the claude tool names. Replaced by `profile.permissions.{modes, describe(req)}`.
   - `cli/bc-axi` founder ref: `detectSelf(env)`.
   - `cli/bc-axi` init: `tmuxBacked`, the root/bypass check, "(ignored by X)". Replaced by `requirements`.
   - `server/firstrun.js`: `handRunLine`, `agentMissingText`, `diagnoseSpawn`. Replaced by `handRunLine(mode)`, `installHint`, `diagnose(tail)`. This fixes codex getting claude's bypass flag.
   - `server/playbooks.js` skill symlink: `skillsDir(home)`.
   - `bc-axi` statusline and workspace-hook install: `installWorkspace(ws, env)`.
   - `harness/agent-status.js` `CLAUDE_CONTEXT_WINDOWS`: `contextWindows` data.
   - The UI harness `<option>` lists and the `'claude'` defaults: fed from `listHarnesses()` and the config default, served by an existing or new read-only endpoint.
5. **Ship an example.** Add `plugins/deepseek/plugin.json` (from the RFC), disabled by default in the config overlay.

## Out of scope

The generic plugin host, commands, activities, UI slots and the `acp` adapter. Do not build a manifest loader beyond `contributes.profiles`.

## Tests

- `harness/test/conformance.test.js` iterates `listHarnesses()`, so derived profiles join it for free.
- New tests:
  - `extends` merge; unknown base; duplicate name;
  - a literal secret rejected;
  - the secret absent from the launch line, from `spawn-args` and from `ps` (use `tmux-mock` for the line);
  - the env file mode is `0600`;
  - claude and codex `modelArgs`;
  - an unsupported option leads to a timeline warning and no flag (server test on `fake`);
  - a grep test: no `'claude'` or `'codex'` literal in `server/`, `cli/` or `ui/js/` except the config default.
- Run the suite as CI does: `TMPDIR=/private/tmp/bct node --test --test-concurrency=1 test/*.test.js harness/test/*.test.js`.

## Verification in the real app

The captain restarts the live server, because a lieutenant cannot. Then:

1. Export `DEEPSEEK_API_KEY` and enable `deepseek` in the overlay.
2. Switch one lieutenant to `deepseek` from the board.
3. Check that it answers, that its context bar uses `128000`, and that `ps aux | grep -i deepseek` shows no key.
4. Start a codex card with an effort pin. Check that it launches with codex's own flag, and that a claude-only option shows a timeline warning.

## Docs

- In `harness/README.md`, define *adapter family*, *profile* and *derived profile*.
- Add one DNA line to `docs/api/overview.md` § harness port: "a harness is an adapter family + a profile; plugins contribute profiles; options are best-effort, verbs throw".
