'use strict';
// tmux-adapter — ONE implementation of the harness port over tmux, driven by a
// small per-harness PROFILE. claude-tmux.js and codex-tmux.js are profiles:
// they hold only what is true of their CLI (launch line, screen signatures,
// how the turn-end relay is wired, the extra slash commands). Everything that
// is true of "an agent TUI in a tmux pane" lives here, once.
//
// Profile shape:
//   name                         'claude' | 'codex' — the ref's `harness`
//   settle                       { trustRe, resumeRe?, readyRe, fatalRe, declineRe?, label } (tmux-session.js)
//   idAtBirth() -> string|undefined
//                                the resume id known before launch (claude mints
//                                one for --session-id; codex has none — the first
//                                turn-end delivers it)
//   prepare?(cwd, key, ctx)      per-launch setup before the pane exists (claude:
//                                install the Stop and PermissionRequest hooks);
//                                runs on spawn AND resume
//   launch(ctx) -> string        the fresh launch line
//   resumeLaunch(id, ctx) -> string
//                                the resume launch line; id undefined = no memory
//   status(ref, ctx) -> status|null
//   noStatusHint                 why status can be null, for the /status error
//   commands?(ref) -> [{name, description, args?}]
//                                the profile's commands beyond the shared trio
//   handlers?                    { '/name': (ref, line, opts) -> reply } — emulated commands
//   passthrough?                 extra names typed literally into the session
//
// ctx = { opts, stateDir, key, callbackUrl, resumeId, extra, allowRoot, permissionMode }:
// `extra` is the already shell-quoted extra flags, `allowRoot` the caller's
// consent, `permissionMode` the caller's mode (undefined = the profile's
// default; codex ignores it) — on resume all three are replayed from the
// spawn's record, and opts wins over it.

const fs = require('node:fs');
const path = require('node:path');
const t = require('./tmux.js');
const s = require('./tmux-session.js');
const { SLASH_COMMANDS, runSlashCommand } = require('./agent-status.js');

function submitOpts() {
  return {
    retries: Number(process.env.BC_SEND_RETRIES || 3),
    enterSleep: Number(process.env.BC_SEND_SLEEP_MS || 400),
  };
}

/**
 * makeRef — the ONE ref shape every harness returns: `window` and `resumeId`
 * are either absent or strings, never an `undefined` key.
 */
function makeRef(harness, session, window, cwd, resumeId) {
  const ref = { harness, session, cwd };
  if (window) ref.window = window;
  if (resumeId) ref.resumeId = resumeId;
  return ref;
}

/**
 * tmuxAdapter(profile) -> harness impl (the seven verbs plus the optional
 * pane, command, status and adoptWindow verbs).
 */
function tmuxAdapter(profile) {
  const callbackOf = (opts) => opts.callbackUrl || process.env.BC_TURNEND_URL || '';
  const quote = (args) => args.map((a) => s.shellQuote(String(a))).join(' ');

  // deliverPrompt — the brief goes into the settled composer via verified
  // submit, never argv: a prompt in argv is visible to `ps` for the session's
  // life, and an agent's own broad pattern-kill could match itself.
  async function deliverPrompt(target, prompt) {
    const verdict = await t.submit(target, prompt, submitOpts());
    if (verdict === 'pending' || verdict === 'send-failed') {
      // A launch that settles and then refuses the brief is diagnosed from the
      // screen underneath, so the pane tail rides on the error.
      let tail = '';
      try { tail = (await t.capture(target, 20)) || ''; } catch { tail = ''; }
      throw new Error((verdict === 'pending'
        ? 'brief not submitted at spawn (Enter swallowed; text left in composer)'
        : 'brief not sent at spawn (tmux send failed)') + '; pane tail:\n' + tail);
    }
  }

  /** spawn(cwd, prompt, opts?) -> HarnessRef. opts: session, window, stateDir, callbackUrl, extraArgs, allowRoot, installHooks, permissionMode. */
  async function spawn(cwd, prompt, opts = {}) {
    const cwdAbs = path.resolve(cwd);
    if (!fs.existsSync(cwdAbs)) throw new Error(`spawn cwd does not exist: ${cwdAbs}`);
    const { session, window } = await s.claimPaneNames(opts);
    const stateDir = s.stateDirOf(opts);
    const key = s.stateKey(session, window);
    const ctx = {
      opts, stateDir, key, callbackUrl: callbackOf(opts), resumeId: profile.idAtBirth(),
      extra: quote(opts.extraArgs || []), allowRoot: !!opts.allowRoot,
      permissionMode: opts.permissionMode || undefined,
    };
    if (profile.prepare) await profile.prepare(cwdAbs, key, ctx);

    const promptFile = path.join(stateDir, `${key}.prompt`);
    fs.writeFileSync(promptFile, prompt);
    // Recorded so resume() can replay them — a worker pinned to a model by its
    // playbook must not come back on the default one, nor a worker born asking
    // permission come back skipping it.
    s.recordSpawnArgs(stateDir, key, opts);

    const target = s.paneTarget(session, window);
    await s.createPane(session, window, cwdAbs);
    try {
      await s.launchAndSettle(target, profile.launch(ctx), profile.settle);
      await deliverPrompt(target, prompt);
      // Returning claims a session is here. A settle can match a modal's own
      // wording, so look once more after the brief.
      await s.verifyLive(target, profile.settle);
    } catch (err) {
      await s.killPane(session, window);
      try { fs.unlinkSync(promptFile); } catch { /* best-effort */ }
      throw err;
    }
    return makeRef(profile.name, session, window, cwdAbs, ctx.resumeId);
  }

  /** send(ref, text) — verified submit; Enter is retried, never the text. Throws when it provably failed. */
  async function send(ref, text) {
    const name = s.stateKey(ref.session, ref.window);
    if (!(await alive(ref))) throw new Error(`session ${name} is not alive`);
    const verdict = await t.submit(s.paneTarget(ref.session, ref.window), text, submitOpts());
    if (verdict === 'pending') throw new Error(`text not submitted to ${name} (Enter swallowed; text left in composer)`);
    if (verdict === 'send-failed') throw new Error(`text not sent to ${name} (tmux send failed)`);
    // 'unknown' (pane unreadable) is read as sent: an unreadable pane must not
    // turn a normal send into a false error.
    await t.sleep(1000); // let the turn spin up so an immediate capture sees it working
  }

  /** alive(ref) — the pane exists and is not back at a bare shell. Throws when tmux cannot be read. */
  async function alive(ref) {
    // STRICT: the board drops worker records on false, so an unreadable tmux
    // must throw rather than pass for "the pane is gone".
    if (!(await s.paneExists(ref.session, ref.window, { strict: true }))) return false;
    const cmd = await s.paneCommand(s.paneTarget(ref.session, ref.window), { strict: true });
    return cmd !== null && !s.SHELLS.has(cmd);
  }

  // The resume id to use: the relay's record (refreshed every turn) beats the
  // ref's, which may be stale or — for codex — never adopted.
  function resumeIdOf(ref, stateDir) {
    return s.readSessionId(stateDir, s.stateKey(ref.session, ref.window)) || ref.resumeId || undefined;
  }

  /** resumable(ref, opts?) -> bool — would resume restore memory? Introspection only. */
  async function resumable(ref, opts = {}) {
    return !!resumeIdOf(ref, s.stateDirOf(opts));
  }

  /** resume(ref, opts?) -> HarnessRef — relaunch a dead session with memory when an id is known; fresh otherwise. */
  async function resume(ref, opts = {}) {
    if (await alive(ref)) return { ...ref };
    const stateDir = s.stateDirOf(opts);
    const key = s.stateKey(ref.session, ref.window);
    const resumeId = resumeIdOf(ref, stateDir);
    // The spawn's launch facts are replayed, not rebuilt; opts wins over the
    // record, and a missing or corrupt record is no flags, never a throw.
    const rec = s.recordedSpawnArgs(stateDir, key);
    const ctx = {
      opts, stateDir, key, callbackUrl: callbackOf(opts), resumeId,
      extra: quote(opts.extraArgs || rec.args), allowRoot: !!(opts.allowRoot || rec.allowRoot),
      permissionMode: opts.permissionMode || rec.permissionMode || undefined,
    };
    await s.killPane(ref.session, ref.window); // clear any dead pane still holding the name
    if (profile.prepare) await profile.prepare(ref.cwd, key, ctx);
    const target = s.paneTarget(ref.session, ref.window);
    await s.createPane(ref.session, ref.window, ref.cwd);
    try {
      await s.launchAndSettle(target, profile.resumeLaunch(resumeId, ctx), profile.settle);
      await s.verifyLive(target, profile.settle);
    } catch (err) {
      await s.killPane(ref.session, ref.window);
      throw err;
    }
    return makeRef(profile.name, ref.session, ref.window, ref.cwd, resumeId);
  }

  /**
   * kill(ref) — end the pane for good; idempotent. A window-granular ref takes
   * only its window. State files stay: a premature kill can still be resumed.
   */
  async function kill(ref) {
    await s.killPane(ref.session, ref.window);
  }

  /** commands(ref?) — the shared trio plus the profile's own. */
  function commands(ref) {
    const own = profile.commands ? profile.commands(ref) : [];
    return SLASH_COMMANDS.map((c) => ({ ...c })).concat(own);
  }

  /** status(ref, opts?) -> status | null — read from files the CLI already writes. */
  async function status(ref, opts = {}) {
    return profile.status(ref, { opts, stateDir: s.stateDirOf(opts) });
  }

  /** runCommand(ref, line, opts?) -> reply text — /help, /status, the profile's handlers, then pass-through. */
  function runCommand(ref, command, opts = {}) {
    return runSlashCommand(ref, command, opts, {
      key: s.stateKey(ref.session, ref.window),
      commands, status, send,
      handlers: profile.handlers || {},
      passthrough: ['/compact'].concat(profile.passthrough || []),
      noStatusHint: profile.noStatusHint,
    });
  }

  return {
    spawn, send, alive, resumable, resume, kill,
    onTurnEnd: s.onTurnEnd,
    openPane: s.openPane, paneSnapshot: s.paneSnapshot, paneInput: s.paneInput,
    adoptWindow: s.adoptWindow,
    commands, runCommand, status,
  };
}

module.exports = { tmuxAdapter, makeRef };
