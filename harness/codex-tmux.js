'use strict';
// codex-tmux — the OpenAI Codex CLI PROFILE of the tmux adapter
// (tmux-adapter.js runs the verbs). Only codex facts live here.
//
// HarnessRef: { harness: 'codex', session: 'bc-<id>', window?, cwd, resumeId? }
//   resumeId — the codex THREAD-ID. codex has no --session-id flag, so the ref
//              is born WITHOUT one; the notify relay records it at
//              <stateDir>/<key>.session-id and POSTs it, and the server writes it
//              back into the ref. `codex resume <thread-id>` continues the SAME
//              thread (verified 0.144.1), so refs survive death/resume cycles.
//
// Launch (verified 0.144.1):
//   codex --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust \
//     -c notify='["node","<relay>","<stateDir>","<key>","<url>"]'
//   - the first flag is codex's --dangerously-skip-permissions (full autonomy);
//   - the second suppresses the "Hooks need review" picker a global
//     ~/.codex/hooks.json raises — without it spawn hangs there;
//   - notify runs codex-notify.js at every turn boundary with the payload as
//     the LAST argv: turn-end detection AND the thread-id in one mechanism,
//     with nothing written into the worktree.
// A fresh cwd shows "Do you trust the contents of this directory?" even with
// both flags ("Yes, continue" preselected); the settle accepts it.

const os = require('node:os');
const path = require('node:path');
const s = require('./tmux-session.js');
const { codexStatus } = require('./agent-status.js');
const { tmuxAdapter } = require('./tmux-adapter.js');

const NOTIFY_SCRIPT = path.join(__dirname, 'codex-notify.js');
const TRUST_RE = /Do you trust the contents of this directory|Yes, continue/;

// UI_READY_RE matches signatures only the codex main UI renders: the intro
// box (">_ OpenAI Codex (vX.Y.Z)"), the YOLO-mode permissions line, or the
// composer glyph '›' at a line start. The trust screen shows none of these as
// a line of its own — and trustRe is checked first anyway.
const UI_READY_RE = /OpenAI Codex \(v|YOLO mode|\n›/;

// FATAL_RE — screens a codex launch never gets past on its own (strings pinned
// against the 0.155.1 binary): no binary, the first-run login picker, the
// update modal (its preselected option runs `brew upgrade` — not ours to press),
// and `codex resume` of a thread it has no rollout for.
const FATAL_RE = /codex: command not found|command not found: codex|env: .?codex.?: No such file|Sign in with ChatGPT to use Codex|Provide your own API key|Update now \(runs|Skip until next version|No saved session found with ID/;
// No resumeRe: `codex resume <id>` goes straight into the thread — the picker
// only appears for a bare `codex resume`, which we never run.
const SETTLE = { trustRe: TRUST_RE, readyRe: UI_READY_RE, fatalRe: FATAL_RE, label: 'codex' };

// The bypass + notify flags every codex launch (spawn AND resume) carries.
function launchFlags(ctx) {
  const notify = ['node', NOTIFY_SCRIPT, ctx.stateDir, ctx.key].concat(ctx.callbackUrl ? [ctx.callbackUrl] : []);
  return '--dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust '
    + `-c ${s.shellQuote('notify=' + JSON.stringify(notify))}`
    + (ctx.extra ? ' ' + ctx.extra : '');
}

// The line a PERSON runs by hand to clear codex's own first-run screens: the
// spawn's flags, so it meets the same ones. codex ignores the permission mode.
const HAND_RUN = 'codex --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust';

// diagnose(text, {here, handRun}) -> {cause, headline, fix} | null — the codex
// screens a spawn can die on (the FATAL_RE ones), named from the pane.
function diagnose(text, ctx = {}) {
  const t = String(text || '');
  const handRun = ctx.handRun || (() => '  cd ' + (ctx.here || '<the workspace folder>') + ' && ' + HAND_RUN);
  const hit = (re, cause, headline, fix) => (re.test(t) ? { cause, headline, fix } : null);
  return hit(/command not found|not found: codex|codex: No such file/, 'missing',
    'the agent CLI is not installed — the shell answered "command not found".',
    'Install it and run the SAME command again:\n' + INSTALL_HINT)
  || hit(/Sign in with ChatGPT|Provide your own API key/, 'auth',
    'the `codex` CLI is installed but not logged in — her pane is on its sign-in picker.',
    'Log in once by hand in the workspace, then run the SAME command again:\n' + handRun())
  || hit(/Update now \(runs|Skip until next version/, 'update',
    'her pane is on codex\'s update prompt — its preselected option runs an upgrade, so it is not mine to press.',
    'Run it once by hand, answer the update prompt, quit, then run the SAME command again:\n' + handRun())
  || hit(/Do you trust the contents of this directory/, 'trust',
    'her pane is on codex\'s directory-trust question for the workspace.',
    'Run it once by hand in the workspace, answer it, quit, then run the SAME command again:\n' + handRun());
}

const INSTALL_HINT = '  npm i -g @openai/codex          # a user-local npm prefix, or an administrator, may be needed';

const profile = {
  name: 'codex',
  settle: SETTLE,
  idAtBirth: () => undefined, // codex assigns the thread-id; the first notify delivers it
  // No prepare: the relay rides the launch line, so opts.installHooks has
  // nothing to install (or clobber) in any cwd. ctx.permissionMode is ignored
  // too: codex has no board-relayed approval hook, so it keeps its bypass
  // flags whatever the board is configured for.
  launch: (ctx) => 'codex ' + launchFlags(ctx),
  resumeLaunch: (id, ctx) => (id ? `codex resume ${id} ` : 'codex ') + launchFlags(ctx),
  // The thread-id comes from the relay's record first, the ref second — the
  // same order resume() uses, so a ref that never adopted an id still reads.
  status: (ref, ctx) => codexStatus(ref, { ...ctx.opts, stateDir: ctx.stateDir }),
  noStatusHint: 'rollout log not found (thread-id not adopted yet?)',
  // No /autocompact: codex only has the model_auto_compact_token_limit CONFIG
  // key, not a command (verified 0.144.x).

  // Typed options. `-m` and the model_reasoning_effort config key are pinned
  // against the 0.157.1 binary's own strings (its --help hangs off a terminal).
  options: ['model', 'effort'],
  modelArgs: ({ model, effort } = {}) => [].concat(model ? ['-m', model] : [],
    effort ? ['-c', 'model_reasoning_effort=' + effort] : []),

  // No board-relayed approval hook, so no permission modes and no root refusal to plan for.
  permissions: { modes: [] },
  requirements: { bins: ['codex'], tmux: true, rootBypass: false },
  installHint: INSTALL_HINT,
  contextWindows: [], // the rollout log carries the real window

  handRunLine: () => HAND_RUN,
  setupScreens: () => '(a login, and a trust question about this folder):\n',
  diagnose,
  // codex exports CODEX_THREAD_ID — the id `codex resume` takes — to what it runs.
  detectSelf: (env) => (env && env.CODEX_THREAD_ID ? { resumeId: env.CODEX_THREAD_ID } : null),
  skillsDir: (home) => path.join(home || os.homedir(), '.codex', 'skills'),
};

module.exports = { ...tmuxAdapter(profile),
  // The JS base a derived JSON profile `extends` (harness/profiles.js).
  profile,
  // Exported for settle-screens.test.js, which pins them against real screens.
  SETTLE };
