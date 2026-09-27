'use strict';
// commands — turn a plugin command + a card into what to do: a shell line to
// run, a URL to open, or "ask the plugin's server handler". Pure: nothing runs
// here, nothing is read from disk.
//
// A template says `${card.branch}`, `${input.env}`, `${project.path}`. Only the
// scope's roots are substituted (card, project, worker, harness, input, config,
// workspace); any other `${NAME}` is left for the shell, so `${HOME}` still
// means $HOME.
//
// THE RULE for an exec line: a substitution arrives as ONE literal word, never
// as shell syntax. Each value is POSIX single-quoted, and a substitution is
// refused where quoting cannot hold — inside '…', "…", `…` or $'…', right
// after a `$`, in a comment, or after a here-doc `<<`. `\${card.x}` is the
// escape: the shell gets the literal text and nothing is substituted. A card title of
// `'; rm -rf /; '` or `$(curl evil)` is then just an odd argument. What the
// plugin's own shell does with that word (`eval`, `sh -c`) is the plugin's.
//
// when.js and fields.js are ES modules shared with the browser, so this
// CommonJS file loads them once with import(): the public functions are async.
//
// Node built-ins only.
const path = require('path');
const { pathToFileURL } = require('url');

const ROOTS = new Set(['card', 'project', 'worker', 'harness', 'input', 'config', 'workspace']);
// The path grammar getPath walks: dotted names with [n] indices. Attribute
// keys may carry '-'.
const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\[\d+\])*(?:\.[A-Za-z0-9_-]+(?:\[\d+\])*)*$/;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

let pure = null;
/** when.js + fields.js, imported once. -> Promise<{getPath, compileWhen, matches, validateValues, defaultsFor}> */
function loadPure() {
  if (!pure) {
    const ui = path.join(__dirname, '..', 'ui', 'js');
    pure = Promise.all([
      import(pathToFileURL(path.join(ui, 'when.js')).href),
      import(pathToFileURL(path.join(ui, 'fields.js')).href),
    ]).then(([w, f]) => ({
      getPath: w.getPath, compileWhen: w.compileWhen, matches: w.matches,
      validateValues: f.validateValues, defaultsFor: f.defaultsFor,
    }));
  }
  return pure;
}

/** POSIX single quotes: the one quoting with no escapes inside it. */
function shellQuote(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

function scalar(v) {
  if (typeof v === 'string') return v === '' ? undefined : v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'boolean') return String(v);
  return undefined; // missing, null, a list, an object: nothing a word can carry
}

// The substitutions of one template: [{start, end, name, safe}]. `safe` is the
// shell lexer's word on whether a quoted value stays one word at that spot;
// computed only when quoting (a URL or a path has no shell to break out of).
function scan(tpl, shell) {
  const out = [];
  let state = 'none'; // none | single | double | backtick | ansi | comment
  let heredoc = false;
  let i = 0;
  const wordStart = (j) => j === 0 || /[\s;&|()<>]/.test(tpl[j - 1]);
  while (i < tpl.length) {
    const c = tpl[i];
    if (c === '$' && tpl[i + 1] === '{') {
      const close = tpl.indexOf('}', i + 2);
      const name = close === -1 ? '' : tpl.slice(i + 2, close);
      const root = name.split(/[.[]/)[0];
      if (close !== -1 && ROOTS.has(root) && PATH_RE.test(name)) {
        // `$'…'` is ANSI-C quoting, where \' does not close: $ + a quoted value breaks out.
        const afterDollar = shell && i > 0 && tpl[i - 1] === '$';
        out.push({ start: i, end: close + 1, name,
          safe: !shell || (state === 'none' && !heredoc && !afterDollar) });
        i = close + 1;
        continue;
      }
    }
    if (shell) {
      if (state === 'comment') { if (c === '\n') state = 'none'; }
      else if (state === 'single') { if (c === "'") state = 'none'; }
      else if (state === 'ansi') { if (c === '\\') i++; else if (c === "'") state = 'none'; }
      else if (state === 'double') { if (c === '\\') i++; else if (c === '"') state = 'none'; }
      else if (state === 'backtick') { if (c === '\\') i++; else if (c === '`') state = 'none'; }
      else if (c === '\\') i++;
      else if (c === "'") state = tpl[i - 1] === '$' ? 'ansi' : 'single';
      else if (c === '"') state = 'double';
      else if (c === '`') state = 'backtick';
      else if (c === '#' && wordStart(i)) state = 'comment';
      else if (c === '<' && tpl[i + 1] === '<') heredoc = true;
    }
    i++;
  }
  return out;
}

function expandWith(getPath, tpl, scope, opts) {
  const quote = !!(opts && opts.quote);
  const text = String(tpl === undefined || tpl === null ? '' : tpl);
  const subs = scan(text, quote);
  const unsafe = [...new Set(subs.filter((s) => !s.safe).map((s) => s.name))];
  if (unsafe.length) {
    return { error: 'unsafe placement of ${' + unsafe.join('}, ${') + '}: the board quotes each value itself, so write it bare '
      + '(not inside quotes, after \\ or $, in a comment or a here-doc)', missing: [], unsafe };
  }
  const missing = [];
  let out = '';
  let at = 0;
  for (const s of subs) {
    const v = scalar(getPath(scope, s.name));
    if (v === undefined) { if (!missing.includes(s.name)) missing.push(s.name); continue; }
    out += text.slice(at, s.start) + (quote ? shellQuote(v) : v);
    at = s.end;
  }
  if (missing.length) return { error: 'missing ' + missing.map((n) => '${' + n + '}').join(', '), missing };
  return { text: out + text.slice(at) };
}

/**
 * Resolve every `${path}` of a template against scope.
 * @param {string} tpl
 * @param {{card, project, worker, harness, input, config, workspace}} scope
 * @param {{quote?: boolean}} [opts] quote: true for a shell line
 * @returns {Promise<{text: string} | {error: string, missing: string[], unsafe?: string[]}>}
 */
async function expandTemplate(tpl, scope, opts) {
  const { getPath } = await loadPure();
  return expandWith(getPath, tpl, scope, opts);
}

function wsOf(workspace) {
  if (!workspace) return { path: '', name: '' };
  if (typeof workspace === 'string') return { path: workspace, name: path.basename(workspace) };
  return { path: String(workspace.path || ''), name: String(workspace.name || path.basename(String(workspace.path || ''))) };
}

/**
 * What running `command` on this card means.
 * @param {object} command a normalized manifest command (manifests.js), tagged with `plugin`
 * @param {{context: object, input?: object, config?: object, workspace: string|{path, name}}} args
 *   context is the card context (cardContext); workspace is the workspace root
 * @returns {Promise<
 *   {kind: 'exec', shell, cwd, env, timeoutMs, tracked, input} |
 *   {kind: 'open', url, input} | {kind: 'server', input} |
 *   {error, code, field?, missing?}>}
 *   code: 400 bad input · 422 the card lacks what the template needs · 500 a manifest bug
 */
async function planRun(command, args) {
  const { getPath, validateValues } = await loadPure();
  const a = args || {};
  if (!command || typeof command !== 'object') return { error: 'no such command', code: 404 };
  const checked = validateValues(command.form || {}, a.input);
  if (checked.error) return { error: checked.error, code: 400, field: checked.field };
  const input = checked.values;
  const ctx = a.context || {};
  const ws = wsOf(a.workspace);
  const scope = {
    card: ctx.card || null, project: ctx.project || null, worker: ctx.worker || null,
    harness: ctx.harness === undefined ? null : ctx.harness,
    input, config: a.config || {}, workspace: ws,
  };
  const run = command.run;
  const refuse = (r) => ({ error: r.error, code: r.unsafe ? 500 : 422, missing: r.missing });

  if (run === 'server') return { kind: 'server', input };
  if (run && typeof run === 'object' && typeof run.open === 'string') {
    const r = expandWith(getPath, run.open, scope, { quote: false });
    if (r.error) return refuse(r);
    // A card attribute can hold anything; only a web link opens from a click.
    if (!/^https?:\/\//i.test(r.text)) return { error: 'refusing to open "' + r.text.slice(0, 200) + '": only http(s) links open', code: 422 };
    return { kind: 'open', url: r.text, input };
  }
  if (!run || typeof run !== 'object' || typeof run.exec !== 'string') {
    return { error: 'command ' + (command.id || '?') + ': run must be "server", {exec} or {open}', code: 500 };
  }

  const sh = expandWith(getPath, run.exec, scope, { quote: true });
  if (sh.error) return refuse(sh);

  // Where it runs: the card's checkout, else its project, else the workspace.
  const card = scope.card || {};
  const base = card.worktree || (scope.project && scope.project.path) || ws.path;
  let cwd = base;
  if (run.cwd !== undefined) {
    const c = expandWith(getPath, run.cwd, scope, { quote: false });
    if (c.error) return refuse(c);
    cwd = path.resolve(base || '/', c.text);
  }
  if (!cwd || !path.isAbsolute(cwd)) return { error: 'no directory to run in (no worktree, project or workspace)', code: 422 };

  // The context rides the env too: "$BC_INPUT_ENV" in a script is the one
  // spelling that never meets a template at all.
  const env = {
    BC_EVENT: 'command', BC_COMMAND: String(command.id || ''), BC_PLUGIN: String(command.plugin || ''),
    BC_CARD: String(card.id || ''), BC_WORKTREE: String(card.worktree || ''), BC_BRANCH: String(card.branch || ''),
    BC_REPO: String((scope.project && scope.project.path) || ''), BC_WORKSPACE: ws.path,
    // A plugin's own scripts: "$BC_PLUGIN_DIR/x.sh" beats a shell program inlined in JSON.
    BC_PLUGIN_DIR: String(a.pluginDir || ''),
  };
  for (const [k, v] of Object.entries(input)) env['BC_INPUT_' + k.toUpperCase()] = String(v);
  if (run.env && typeof run.env === 'object') {
    for (const [k, tpl] of Object.entries(run.env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) return { error: 'command ' + command.id + ': bad env name "' + k + '"', code: 500 };
      const e = expandWith(getPath, tpl, scope, { quote: false });
      if (e.error) return refuse(e);
      env[k] = e.text;
    }
  }
  const t = Number(run.timeoutMs !== undefined ? run.timeoutMs : command.timeoutMs);
  return { kind: 'exec', shell: sh.text, cwd, env, timeoutMs: t > 0 ? t : DEFAULT_TIMEOUT_MS, tracked: !!command.tracked, input };
}

module.exports = { expandTemplate, planRun, loadPure, shellQuote, ROOTS, DEFAULT_TIMEOUT_MS };
