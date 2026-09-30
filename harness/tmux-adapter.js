'use strict';
// tmux-adapter — ONE implementation of the harness port over tmux, driven by a
// small per-harness PROFILE. claude-tmux.js and codex-tmux.js are profiles:
// they hold only what is true of their CLI (launch line, screen signatures,
// how the turn-end relay is wired, the extra slash commands). Everything that
// is true of "an agent TUI in a tmux pane" lives here, once.
//
// Profile shape:
//   name                         'claude' | 'codex' | a derived name — the ref's `harness`
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
//   modelArgs?({model, effort}) -> argv   the profile's own flags for the typed options
//   options?                     the typed options it honors (['model', 'effort'])
//   env?                         { NAME: '${VAR}' | literal } — expanded at every
//                                launch into <stateDir>/<key>.env (mode 0600)
//   permissions?, requirements?, installHint?, contextWindows?  data for profileInfo()
//   handResume?                  the by-hand resume prefix (`<it> <resumeId>`), for the UI
//
// ctx = { opts, stateDir, key, callbackUrl, resumeId, extra, allowRoot, permissionMode, model, effort }:
// `extra` is the already shell-quoted extra flags (the typed options' flags
// included), `allowRoot` the caller's
// consent, `permissionMode` the caller's mode (undefined = the profile's
// default; codex ignores it) — on resume all three are replayed from the
// spawn's record, and opts wins over it.

const fs = require('node:fs');
const path = require('node:path');
const t = require('./tmux.js');
const s = require('./tmux-session.js');
const { SLASH_COMMANDS, runSlashCommand } = require('./agent-status.js');
const { expandEnv, envSources } = require('./profiles.js');

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

// The brief spawn persists (its source of truth — it never rides argv).
function promptFile(stateDir, key) {
  return path.join(stateDir, `${key}.prompt`);
}

/**
 * tmuxAdapter(profile) -> harness impl (the seven verbs plus the optional
 * pane, command, status, brief, panePids, adoptWindow and interrupt verbs).
 */
function tmuxAdapter(profile) {
  const callbackOf = (opts) => opts.callbackUrl || process.env.BC_TURNEND_URL || '';
  const quote = (args) => args.map((a) => s.shellQuote(String(a))).join(' ');
  const envTemplate = profile.env && Object.keys(profile.env).length ? profile.env : null;
  const typedArgs = (model, effort) => (profile.modelArgs && (model || effort)
    ? profile.modelArgs({ model: model || undefined, effort: effort || undefined }) : []);

  // withEnv(line, stateDir, key) — a profile with env gets its values through
  // a 0600 file the launch sources, so a secret never rides argv, the typed
  // launch line or spawn-args. The subshell keeps them out of the pane's own
  // shell; `exec env` keeps the CLI the pane's foreground command.
  function withEnv(line, stateDir, key) {
    const file = path.join(stateDir, `${key}.env`);
    if (!envTemplate) {
      fs.rmSync(file, { force: true });
      return line;
    }
    const { env, missing } = expandEnv(envTemplate, envSources(profile.secretsFile));
    if (missing.length) {
      throw new Error(`${profile.name}: missing ${missing.map((m) => '${' + m + '}').join(', ')} — export it for the server`
        + (profile.secretsFile ? ` or add it to ${profile.secretsFile}` : ''));
    }
    const body = Object.entries(env).map(([k, v]) => `${k}=${s.shellQuote(v)}`).join('\n') + '\n';
    fs.writeFileSync(file, body, { mode: 0o600 });
    fs.chmodSync(file, 0o600); // mode only applies when the file is created
    return `( set -a; . ${s.shellQuote(file)}; set +a; exec env ${line} )`;
  }

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
      extra: quote((opts.extraArgs || []).concat(typedArgs(opts.model, opts.effort))), allowRoot: !!opts.allowRoot,
      permissionMode: opts.permissionMode || undefined, model: opts.model || undefined, effort: opts.effort || undefined,
    };
    const launchLine = withEnv(profile.launch(ctx), stateDir, key);
    if (profile.prepare) await profile.prepare(cwdAbs, key, ctx);

    // A reused pane name starts a new conversation, not the previous run's id.
    fs.rmSync(path.join(stateDir, key + '.session-id'), { force: true });

    const briefFile = promptFile(stateDir, key);
    fs.writeFileSync(briefFile, prompt);
    // Recorded so resume() can replay them — a worker pinned to a model by its
    // playbook must not come back on the default one, nor a worker born asking
    // permission come back skipping it.
    s.recordSpawnArgs(stateDir, key, opts, envTemplate);

    const target = s.paneTarget(session, window);
    await s.createPane(session, window, cwdAbs);
    try {
      await s.launchAndSettle(target, launchLine, profile.settle);
      await deliverPrompt(target, prompt);
      // Returning claims a session is here. A settle can match a modal's own
      // wording, so look once more after the brief.
      await s.verifyLive(target, profile.settle);
    } catch (err) {
      await s.killPane(session, window);
      try { fs.unlinkSync(briefFile); } catch { /* best-effort */ }
      throw err;
    }
    return makeRef(profile.name, session, window, cwdAbs, ctx.resumeId);
  }

  /** send(ref, text) — verified submit; Enter is retried, never the text. Throws when it provably failed. */
  async function send(ref, text) {
    const name = s.keyOf(ref);
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
    return s.readSessionId(stateDir, s.keyOf(ref)) || ref.resumeId || undefined;
  }

  /** resumable(ref, opts?) -> bool — would resume restore memory? Introspection only. */
  async function resumable(ref, opts = {}) {
    return !!resumeIdOf(ref, s.stateDirOf(opts));
  }

  /** resume(ref, opts?) -> HarnessRef — relaunch a dead session with memory when an id is known; fresh otherwise. */
  async function resume(ref, opts = {}) {
    if (await alive(ref)) return { ...ref };
    const stateDir = s.stateDirOf(opts);
    const key = s.keyOf(ref);
    const resumeId = resumeIdOf(ref, stateDir);
    // The spawn's launch facts are replayed, not rebuilt; opts wins over the
    // record, and a missing or corrupt record is no flags, never a throw.
    const rec = s.recordedSpawnArgs(stateDir, key);
    const model = opts.model || rec.model || undefined;
    const effort = opts.effort || rec.effort || undefined;
    const ctx = {
      opts, stateDir, key, callbackUrl: callbackOf(opts), resumeId,
      extra: quote((opts.extraArgs || rec.args).concat(typedArgs(model, effort))),
      allowRoot: !!(opts.allowRoot || rec.allowRoot),
      permissionMode: opts.permissionMode || rec.permissionMode || undefined, model, effort,
    };
    // Re-expanded from the profile, never from a record: a rotated key lands on the next resume.
    const launchLine = withEnv(profile.resumeLaunch(resumeId, ctx), stateDir, key);
    await s.killPane(ref.session, ref.window); // clear any dead pane still holding the name
    if (profile.prepare) await profile.prepare(ref.cwd, key, ctx);
    const target = s.paneTarget(ref.session, ref.window);
    await s.createPane(ref.session, ref.window, ref.cwd);
    try {
      await s.launchAndSettle(target, launchLine, profile.settle);
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

  /**
   * interrupt(ref) — stop the running turn the way a person would: the
   * profile's interrupt keys (Escape unless it says otherwise). The session
   * stays alive and ready for the next message. Throws when the pane is gone.
   */
  async function interrupt(ref) {
    if (!(await s.paneExists(ref.session, ref.window))) throw new Error(`pane ${s.keyOf(ref)} is gone`);
    const target = s.paneTarget(ref.session, ref.window);
    if (profile.beforeInterrupt) await profile.beforeInterrupt(target, t);
    for (const key of profile.interruptKeys || ['Escape']) await t.sendKey(target, key);
  }

  /** brief(ref, opts?) -> path | null — the brief spawn persisted for this agent, when it is on disk. */
  function brief(ref, opts = {}) {
    const file = promptFile(s.stateDirOf(opts), s.keyOf(ref));
    return fs.existsSync(file) ? file : null;
  }

  /** commands(ref?) — the shared trio plus the profile's own. */
  function commands(ref) {
    const own = profile.commands ? profile.commands(ref) : [];
    return SLASH_COMMANDS.map((c) => ({ ...c })).concat(own);
  }

  /** status(ref, opts?) -> status | null — read from files the CLI already writes. */
  async function status(ref, opts = {}) {
    return profile.status(ref, { opts, stateDir: s.stateDirOf(opts), profile });
  }

  /** profileInfo() -> the profile's data, for the core to read without naming a CLI. */
  function profileInfo() {
    const req = profile.requirements || {};
    return {
      name: profile.name,
      adapter: 'tmux',
      options: profile.modelArgs ? (profile.options || ['model', 'effort']).slice() : [],
      permissionModes: ((profile.permissions && profile.permissions.modes) || []).slice(),
      requirements: { bins: (req.bins || []).slice(), tmux: req.tmux !== false, rootBypass: !!req.rootBypass },
      installHint: profile.installHint || '',
      contextWindows: (profile.contextWindows || []).map((p) => p.slice()),
      handResume: profile.handResume || '',
      ...(profile.appResume ? { appResume: { ...profile.appResume } } : {}),
    };
  }

  /** runCommand(ref, line, opts?) -> reply text — /help, /status, the profile's handlers, then pass-through. */
  function runCommand(ref, command, opts = {}) {
    return runSlashCommand(ref, command, opts, {
      key: s.keyOf(ref),
      commands, status, send,
      handlers: profile.handlers || {},
      passthrough: ['/compact'].concat(profile.passthrough || []),
      noStatusHint: profile.noStatusHint,
    });
  }

  return {
    spawn, send, alive, resumable, resume, kill, interrupt,
    onTurnEnd: s.onTurnEnd,
    openPane: s.openPane, paneSnapshot: s.paneSnapshot, paneInput: s.paneInput,
    adoptWindow: s.adoptWindow, panePids: s.panePids,
    commands, runCommand, status, brief, profileInfo,
    // The profile's behaviour (handRunLine, diagnose, detectSelf, …) for port.profileOf.
    profile,
  };
}

module.exports = { tmuxAdapter, makeRef };
