'use strict';
// conversation — who is talking. Every route that needs "the caller" (say, line
// pass, drain, ack, the turn-end hook) asks identify() here, so a worker and its
// lieutenant can never be told apart in one place and confused in another.
//
// A worker is a WINDOW inside its lieutenant's tmux SESSION (names.js —
// workerWindow), so the session alone names the lieutenant for both of them.
// The window is what tells them apart.

const path = require('node:path');
const { isHarnessRef } = require(path.join(__dirname, '..', 'harness', 'port.js'));

// Same shape as server.js refKey: the state key a harness hook posts as its
// `session` — `session:window` for a window-granular ref, the bare session else.
function refKey(ref) { return ref.window ? ref.session + ':' + ref.window : ref.session; }

// names.workerWindow always yields `w-<card>`, so the prefix marks a worker's
// window even when its record is already gone (a stale caller is still not the
// lieutenant).
function isWorkerWindow(win) { return typeof win === 'string' && win.startsWith('w-'); }

function str(v) { return typeof v === 'string' ? v : (v == null ? '' : String(v)); }

/**
 * createConversation(deps) — the conversation concept bound to one board.
 * deps.board: () => board (the live object; read at call time)
 */
function createConversation(deps) {
  const board = deps.board;
  const findLieutenant = (id) => board().lieutenants.find((l) => l.id === id) || null;
  const findCard = (id) => board().cards.find((c) => c.id === id) || null;

  /**
   * identify(caller) — resolve a caller to the agent it is.
   * caller: { session?, window?, sessionId?, key?, cwd? }
   *   session   — tmux session (bc-axi `#S`, the hook's tmux_session)
   *   window    — tmux window (bc-axi `#W`); absent from an older bc-axi
   *   sessionId — harness conversation id (hook session_id)
   *   key       — harness state key, `session[:window]` (hook `session`)
   *   cwd       — last resort for a lieutenant born without a resumeId; only
   *               consulted when no session was given
   * -> {kind:'lieutenant', lt} | {kind:'worker', worker, card, owner} | {kind:'none'}
   */
  function identify(caller) {
    const c = caller || {};
    const b = board();
    const sid = str(c.sessionId);
    const session = str(c.session);
    const window = str(c.window);
    const key = str(c.key) || (session && window ? session + ':' + window : '');
    const lts = b.lieutenants.filter((l) => isHarnessRef(l.ref));
    const asLt = (lt) => ({ kind: 'lieutenant', lt });

    // Exact addresses first: a conversation id or a full state key names one agent.
    let lt = (sid && lts.find((l) => l.ref.resumeId === sid))
      || (key && lts.find((l) => refKey(l.ref) === key));
    if (lt) return asLt(lt);
    const workers = (b.workers || []).filter((w) => w && w.ref);
    const w = (sid && workers.find((x) => x.ref.resumeId === sid))
      || (key && workers.find((x) => refKey(x.ref) === key));
    if (w) {
      const card = findCard(w.card);
      return { kind: 'worker', worker: w, card, owner: card ? findLieutenant(card.owner) : null };
    }
    // Session fallback. A worker's window sits in its lieutenant's session, so a
    // worker-looking window never resolves here; a window-granular lieutenant
    // must also match on the window. No window at all = an older bc-axi.
    const win = window || (key.includes(':') ? key.slice(key.indexOf(':') + 1) : '');
    if (session && !isWorkerWindow(win)) {
      lt = lts.find((l) => l.ref.session === session && (!win || !l.ref.window || l.ref.window === win));
      if (lt) return asLt(lt);
    }
    // A codex lieutenant is born without a resumeId and its hook may carry no
    // tmux session: the one such lieutenant living in that cwd is it.
    if (!session && sid && c.cwd) {
      const cands = lts.filter((l) => !l.ref.resumeId);
      if (cands.length === 1 && cands[0].ref.cwd === str(c.cwd)) return asLt(cands[0]);
    }
    return { kind: 'none' };
  }

  /**
   * callerName(who) — the name a caller signs with: a lieutenant's name, a
   * worker's `worker <card>`, null for anyone unidentified.
   */
  function callerName(who) {
    if (who && who.kind === 'lieutenant') return who.lt.name;
    if (who && who.kind === 'worker') return 'worker ' + who.worker.card;
    return null;
  }

  return { identify, callerName };
}

module.exports = { createConversation, refKey, isWorkerWindow };
