'use strict';
// harness port — the multi-harness contract. The server speaks ONLY this port.
// An implementation exposes these seven verbs (all may be async):
//
//   spawn(cwd, prompt, opts?) -> HarnessRef   birth an agent session
//   send(ref, text)                           type a message into a session (verified submit)
//   alive(ref) -> bool                        liveness; throws when it cannot tell
//   resumable(ref, opts?) -> bool             would resume(ref, opts) restore memory?
//   resume(ref, opts?) -> HarnessRef          reincarnate a dead session, with memory when possible
//   kill(ref)                                 end a session for good (idempotent)
//   onTurnEnd(ref, hook, opts?) -> unsubscribe()   turn-boundary detection
//
// opts is one bag for spawn, resumable, resume and onTurnEnd: stateDir,
// callbackUrl, extraArgs, model, effort, allowRoot, installHooks, session,
// window. model/effort are TYPED options: a profile turns them into its own
// flags (profile.modelArgs), and one it does not honor is dropped by the
// caller with a warning — options are best-effort, verbs throw. The first
// two are plumbing: a server binds them once (getHarness(name, env) /
// harnessFor(ref, env), see "binding" below) and passes only the rest.
//
// A HarnessRef is plain JSON: { harness, session, window?, cwd, resumeId? },
// with window and resumeId either absent or strings. keyOf(ref) is its state
// key (`session` or `session:window`) — the name a turn-end relay posts and
// every per-agent state file carries. Nobody outside the harness builds it.
//
// A verb a harness cannot honor THROWS with the reason, never silently
// succeeds. The optional capability verbs (pane viewing, slash commands,
// status, window adoption) are deliberately NOT validated here — the contract
// for them lives in ONE place, harness/README.md, and the inventory in
// docs/api/overview.md.

const { keyOf, isSpawnableSession } = require('./util.js');

const VERBS = ['spawn', 'send', 'alive', 'resumable', 'resume', 'kill', 'onTurnEnd'];

// ---------- paneInput payload validation (the port contract, in one place) ----------
// Lives HERE, not in an implementation, because every harness that offers
// paneInput must enforce the SAME contract: a fake that is laxer than the real
// thing turns route tests green against payloads tmux would choke on. port.js
// depends only on util.js, so both the tmux adapters and the fake can require it.
//
// KEY_RE — tmux's key-name grammar. Anchored, and no branch can begin with '-':
// tmux is spawned via execFile (an argv array, so no shell) and sendKey passes
// `--`, but a name that looks like a flag has no business reaching argv at all.
// The punctuation branch is the five control keys that are not letters — C-[
// (Escape on a lot of muscle memory), C-\, C-], C-^, C-_ — every one verified
// accepted by tmux 3.4. The client emits them, so the grammar must too.
const KEY_RE = /^(C-|M-|S-)*([A-Za-z0-9]+|[[\\\]^_])$/;
// One POST must not be able to shove a whole file into a live agent's pane —
// and, more sharply, must not hand tmux more than tmux can take. Single-line
// text rides `send-keys -l -- <text>` in ARGV, and a tmux client packs one
// command into a single imsg: MAX_IMSGSIZE 16384 minus the 16-byte header, so
// the whole NUL-packed argv must fit in 16368 bytes. Measured against tmux 3.4:
// `send-keys -t <target> -l -- <text>` succeeds while
// target.length + text.length <= 16343 and fails at 16344 with "failed to send
// command" — the same total for an 8-char target and a 49-char one, which is
// how we know the budget is the command, not the payload. Multi-line text is
// unconstrained (it rides load-buffer's STDIN), but one cap is honest and does
// not drift; 16 KB less 512 bytes leaves room for the longest pane target plus
// the fixed argv words.
const PANE_INPUT_MAX = 16 * 1024 - 512;

// validatePaneInput(input) -> { key, text } — exactly one of the two is
// non-empty. Throws with the reason otherwise; callers let it propagate.
function validatePaneInput(input) {
  const key = input && input.key != null ? String(input.key) : '';
  const text = input && input.text != null ? String(input.text) : '';
  if (key && text) throw new Error('paneInput: pass key or text, not both');
  if (!key && !text) throw new Error('paneInput: nothing to send (pass key or text)');
  if (key && !KEY_RE.test(key)) throw new Error(`paneInput: invalid tmux key name "${key}"`);
  // BYTES, not String.length: argv is UTF-8, so 16384 emoji is 65536 bytes and
  // would sail past a UTF-16-unit check to die as `spawn E2BIG`.
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > PANE_INPUT_MAX) {
    throw new Error(`paneInput: text too long (${bytes} > ${PANE_INPUT_MAX} bytes)`);
  }
  return { key, text };
}

// Builtins are lazy-required so requiring port.js never drags in tmux/claude
// machinery for callers that only use the fake.
const BUILTINS = {
  claude: './claude-tmux.js',
  codex: './codex-tmux.js',
  fake: './fake.js',
};

const registry = new Map();
const pluginOf = new Map(); // harness name -> the plugin that contributed or declared it

function validateImpl(name, impl) {
  if (!impl || typeof impl !== 'object') {
    throw new TypeError(`harness "${name}": implementation must be an object`);
  }
  for (const verb of VERBS) {
    if (typeof impl[verb] !== 'function') {
      throw new TypeError(`harness "${name}": missing verb ${verb}()`);
    }
  }
  return impl;
}

// meta.plugin names the plugin that contributed the harness (listHarnesses).
function registerHarness(name, impl, meta) {
  if (!name || typeof name !== 'string') throw new TypeError('harness name must be a non-empty string');
  registry.set(name, validateImpl(name, impl));
  if (meta && meta.plugin) pluginOf.set(name, meta.plugin);
  return impl;
}

function isBuiltin(name) { return Object.prototype.hasOwnProperty.call(BUILTINS, name); }
// A shipped plugin declares a built-in profile so it is listed with its plugin.
function tagHarness(name, plugin) { if (plugin) pluginOf.set(name, plugin); }

// The one place the default harness literal lives outside the profiles; a
// workspace's config.json `harness` overrides it at every call site.
function defaultHarness() { return 'claude'; }

function lookup(name) {
  if (registry.has(name)) return registry.get(name);
  if (Object.prototype.hasOwnProperty.call(BUILTINS, name)) {
    const impl = validateImpl(name, require(BUILTINS[name]));
    registry.set(name, impl);
    return impl;
  }
  throw new Error(`unknown harness "${name}" (known: ${[...new Set([...registry.keys(), ...Object.keys(BUILTINS)])].join(', ')})`);
}

// ---------- binding ----------
// Two opts are plumbing, not choices: where harness state lives (stateDir) and
// where turn ends are POSTed (callbackUrl). A board has exactly one of each, and
// a call that forgot stateDir used to land silently in the global last-resort
// dir, shared by every board on the machine. A BOUND instance carries both, so
// its verbs take only the real per-call choices (permissionMode, extraArgs,
// session, window, …). The binding wins over whatever a caller passes.
//
// OPTS_AT — which argument of each verb is its opts bag. A verb not listed
// takes no plumbing and is passed through as it is, optional verbs included,
// so a capability check (`typeof impl.openPane`) reads the same bound or not.
const OPTS_AT = { spawn: 2, resumable: 1, resume: 1, onTurnEnd: 2, status: 1, runCommand: 2, brief: 1 };
const bindings = new WeakMap(); // env -> Map(impl -> bound instance)

function bind(impl, env) {
  if (!env || typeof env.stateDir !== 'string' || !env.stateDir) {
    throw new TypeError('a harness binding needs a stateDir');
  }
  let cache = bindings.get(env);
  if (!cache) bindings.set(env, (cache = new Map()));
  if (cache.has(impl)) return cache.get(impl);
  const plumbing = { stateDir: env.stateDir };
  if (env.callbackUrl) plumbing.callbackUrl = env.callbackUrl;
  const out = {};
  for (const [verb, fn] of Object.entries(impl)) {
    const at = OPTS_AT[verb];
    out[verb] = typeof fn !== 'function' || at === undefined ? fn
      : (...args) => { args[at] = { ...args[at], ...plumbing }; return fn.apply(impl, args); };
  }
  cache.set(impl, out);
  return out;
}

// getHarness(name, env?) — the implementation registered under name; bound to
// env ({ stateDir, callbackUrl? }) when one is given. The unbound form is for
// tests and embedders that pass opts themselves.
function getHarness(name, env) {
  const impl = lookup(name);
  return env ? bind(impl, env) : impl;
}

// profileInfo(name) -> the profile's data (options, permission modes,
// requirements, install hint, context windows), or null for an impl that
// offers none.
function profileInfo(name) {
  const impl = lookup(name);
  return typeof impl.profileInfo === 'function' ? impl.profileInfo() : null;
}

// profileOf(name) -> the profile object behind a profile-backed impl, or null.
// The core calls its behavioural fields (handRunLine, diagnose, detectSelf,
// skillsDir, installWorkspace, permissions.describe) directly.
function profileOf(name) {
  const impl = lookup(name);
  return impl && impl.profile && typeof impl.profile === 'object' ? impl.profile : null;
}

// listHarnesses() -> [{name, adapter, plugin?, handResume?, appResume?}], sorted. The fake is a test
// double, so it is listed only where tests run it.
function listHarnesses() {
  const withFake = !!(process.env.BC_FAKE_STATE || process.env.BC_LIST_FAKE);
  const names = [...new Set([...Object.keys(BUILTINS), ...registry.keys()])]
    .filter((n) => withFake || n !== 'fake').sort();
  const out = [];
  for (const name of names) {
    let info = null;
    try { info = profileInfo(name); } catch { continue; } // a builtin that cannot load is not offered
    const e = { name, adapter: (info && info.adapter) || (name === 'fake' ? 'fake' : 'custom') };
    if (pluginOf.has(name)) e.plugin = pluginOf.get(name);
    if (info && info.handResume) e.handResume = info.handResume;
    if (info && info.appResume) e.appResume = info.appResume;
    out.push(e);
  }
  return out;
}

// splitOptions(impl, wanted) -> {opts, ignored[]}: the typed options the impl
// honors (profileInfo().options), and the names of the ones it does not.
// Empty values are neither.
function splitOptions(impl, wanted) {
  const info = impl && typeof impl.profileInfo === 'function' ? impl.profileInfo() : null;
  const honored = new Set((info && info.options) || []);
  const opts = {};
  const ignored = [];
  for (const [k, v] of Object.entries(wanted || {})) {
    if (v === undefined || v === null || v === '') continue;
    if (honored.has(k)) opts[k] = v;
    else ignored.push(k);
  }
  return { opts, ignored };
}

// isHarnessRef — structural check for a persisted/deserialized ref.
function isHarnessRef(ref) {
  return !!ref
    && typeof ref === 'object'
    && typeof ref.harness === 'string' && ref.harness.length > 0
    && typeof ref.session === 'string' && ref.session.length > 0
    && (ref.window === undefined || (typeof ref.window === 'string' && ref.window.length > 0))
    && typeof ref.cwd === 'string' && ref.cwd.length > 0
    && (ref.resumeId === undefined || typeof ref.resumeId === 'string');
}

// harnessFor(ref, env?) — dispatch helper: the implementation a ref belongs
// to, bound to env when one is given (see getHarness).
function harnessFor(ref, env) {
  if (!isHarnessRef(ref)) throw new TypeError('not a HarnessRef: ' + JSON.stringify(ref));
  return getHarness(ref.harness, env);
}

module.exports = { VERBS, registerHarness, getHarness, isHarnessRef, harnessFor,
  listHarnesses, defaultHarness, profileInfo, profileOf, splitOptions, isBuiltin, tagHarness,
  keyOf, isSpawnableSession, validatePaneInput, KEY_RE, PANE_INPUT_MAX };
