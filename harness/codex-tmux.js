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
const FATAL_RE = /codex: command not found|command not found: codex|Sign in with ChatGPT to use Codex|Provide your own API key|Update now \(runs|Skip until next version|No saved session found with ID/;
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

const profile = {
  name: 'codex',
  settle: SETTLE,
  idAtBirth: () => undefined, // codex assigns the thread-id; the first notify delivers it
  // No prepare: the relay rides the launch line, so opts.installHooks has
  // nothing to install (or clobber) in any cwd.
  launch: (ctx) => 'codex ' + launchFlags(ctx),
  resumeLaunch: (id, ctx) => (id ? `codex resume ${id} ` : 'codex ') + launchFlags(ctx),
  // The thread-id comes from the relay's record first, the ref second — the
  // same order resume() uses, so a ref that never adopted an id still reads.
  status: (ref, ctx) => codexStatus(ref, { ...ctx.opts, stateDir: ctx.stateDir }),
  noStatusHint: 'rollout log not found (thread-id not adopted yet?)',
  // No /autocompact: codex only has the model_auto_compact_token_limit CONFIG
  // key, not a command (verified 0.144.x).
};

module.exports = { ...tmuxAdapter(profile),
  // Exported for settle-screens.test.js, which pins them against real screens.
  SETTLE };
