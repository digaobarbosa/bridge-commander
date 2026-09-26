'use strict';
// conversation — who is talking, to whom, and what an utterance sets in motion
// (docs/api/overview.md — chat.say, line.who/pass). Every route that needs "the
// caller" (say, line pass, drain, ack, the turn-end hook) asks identify() here,
// so every route tells a worker from its lieutenant the same way; every say
// goes through say(), so the thread append, the QueueItem, the wake and the
// line move are decided once.
//
// A worker is a WINDOW inside its lieutenant's tmux SESSION (layout.js —
// workerWindow), so the session alone names the lieutenant for both of them.
// The window is what tells them apart.
//
// Board access, the queue and the clock are injected, so all of it runs
// in-process in a test (test/conversation.test.js).

const path = require('node:path');
// keyOf(ref) — the state key a harness hook posts as its `session`:
// `session:window` for a window-granular ref, the bare session else.
const { isHarnessRef, keyOf } = require(path.join(__dirname, '..', 'harness', 'port.js'));

// names.workerWindow always yields `w-<card>`, so the prefix marks a worker's
// window even when its record is already gone (a stale caller is still not the
// lieutenant).
function isWorkerWindow(win) { return typeof win === 'string' && win.startsWith('w-'); }

function str(v) { return typeof v === 'string' ? v : (v == null ? '' : String(v)); }

/**
 * parseTarget(s) — a chat target: `lieutenant:<id>` (its main chat) or
 * `card:<id>` (the card's thread). -> {kind:'lieutenant'|'card', id} | null
 */
function parseTarget(s) {
  const m = /^(lieutenant|card):(.+)$/.exec(str(s));
  return m ? { kind: m[1], id: m[2] } : null;
}

// The captain as a say's `from` — the one speaker identify() never returns: he
// talks through the board, not from a tmux pane.
const CAPTAIN = Object.freeze({ kind: 'captain' });

/**
 * createConversation(deps) — the conversation concept bound to one board.
 * deps.board:     () => board (the live object; read at call time)
 * deps.now:       () => ISO timestamp
 * deps.queuePush: (ltId, rec) => item — write-ahead append; it wakes the lieutenant
 * deps.chatAppend:(ltId, msg) => msg — a main chat's append-only log
 * deps.mkEvent:   (body, defaults) => event — a timeline entry (kinds resolved)
 */
function createConversation(deps) {
  const board = deps.board;
  const findLieutenant = (id) => board().lieutenants.find((l) => l.id === id) || null;
  const findCard = (id) => board().cards.find((c) => c.id === id) || null;

  /**
   * threadFor(target) — what a target's thread READS as: a card's stored
   * array, or a lieutenant's in-memory tail (a view — append via appendMessage).
   * null when the target does not exist.
   */
  function threadFor(target) {
    const t = parseTarget(target);
    if (t && t.kind === 'lieutenant') {
      const lt = findLieutenant(t.id);
      return lt ? (lt.chat = lt.chat || []) : null;
    }
    if (t && t.kind === 'card') {
      const card = findCard(t.id);
      return card ? (card.thread = card.thread || []) : null;
    }
    return null;
  }

  /**
   * appendMessage(target, msg) — the one door a chat message goes in by: a
   * main chat appends to its own log, a card thread pushes to the card and
   * marks it touched. -> msg | null (no such target)
   */
  function appendMessage(target, msg) {
    const t = parseTarget(target);
    if (t && t.kind === 'lieutenant') {
      const lt = findLieutenant(t.id);
      return lt ? deps.chatAppend(lt.id, msg) : null;
    }
    if (t && t.kind === 'card') {
      const card = findCard(t.id);
      if (!card) return null;
      (card.thread = card.thread || []).push(msg);
      card.updated = deps.now();
      if (!card.threadStart) card.threadStart = msg.ts;
      return msg;
    }
    return null;
  }

  /**
   * targetLieutenant(target) — who a target's deliveries route to: the
   * lieutenant itself, or the card's owner (a card thread's interlocutor is
   * always the owning lieutenant, never the worker).
   */
  function targetLieutenant(target) {
    const t = parseTarget(target);
    if (t && t.kind === 'lieutenant') return findLieutenant(t.id);
    const card = t && t.kind === 'card' ? findCard(t.id) : null;
    return card ? findLieutenant(card.owner) : null;
  }

  /**
   * lineHolder() — who the captain reaches over the line:
   * {lieutenant, source:'held'|'default'|'none'}. A retired holder falls back
   * to the founding lieutenant, so the line never points at a ghost.
   */
  function lineHolder() {
    const b = board();
    const held = b.line ? findLieutenant(b.line) : null;
    if (held) return { lieutenant: held, source: 'held' };
    const first = b.lieutenants[0];
    if (first) return { lieutenant: first, source: 'default' };
    return { lieutenant: null, source: 'none' };
  }

  /**
   * lineFollow(id) — the line follows the voice the captain last heard.
   * -> true when it moved. A no-op when already there, so board state never churns.
   */
  function lineFollow(id) {
    const b = board();
    if (!id || b.line === id || !findLieutenant(id)) return false;
    b.line = id;
    return true;
  }

  /**
   * captainTarget(target) — where a captain post lands: `line` resolves to the
   * holder's main chat. -> {target, via?:'line'} | {error, code}
   */
  function captainTarget(target) {
    let t = str(target);
    const overLine = t === 'line';
    if (overLine) {
      const holder = lineHolder().lieutenant;
      if (!holder) return { error: 'nobody is on the line — this board has no lieutenant', code: 404 };
      t = 'lieutenant:' + holder.id;
    }
    if (!threadFor(t)) return { error: 'unknown target: ' + t, code: 404 };
    return overLine ? { target: t, via: 'line' } : { target: t };
  }

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
    const key = str(c.key) || (session && window ? keyOf({ session, window }) : '');
    const lts = b.lieutenants.filter((l) => isHarnessRef(l.ref));
    const asLt = (lt) => ({ kind: 'lieutenant', lt });

    // Exact addresses first: a conversation id or a full state key names one agent.
    let lt = (sid && lts.find((l) => l.ref.resumeId === sid))
      || (key && lts.find((l) => keyOf(l.ref) === key));
    if (lt) return asLt(lt);
    const workers = (b.workers || []).filter((w) => w && w.ref);
    const w = (sid && workers.find((x) => x.ref.resumeId === sid))
      || (key && workers.find((x) => keyOf(x.ref) === key));
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

  /**
   * say(from, target, text, attachments, opts) — chat.say: append the
   * utterance and set in motion what it owes. `from` is CAPTAIN or an
   * identify() result; opts: {author?, level?, kind?} (the latter two shape a
   * main-chat post's timeline event).
   *   captain → `message` QueueItem to the target's lieutenant FIRST
   *             (write-ahead), `via:'line'` on the envelope for a line post
   *   agent on a card thread, unless it IS the owner → `worker-said` to the owner
   *   agent in a main chat → level-1 event; from anyone but that lieutenant
   *             (a peer, a worker) → `peer-message` to it, else the line follows it
   * -> {ok, target, message, item|null, via?} | {error, code}
   */
  function say(from, target, text, attachments, opts) {
    const o = opts || {};
    const atts = Array.isArray(attachments) ? attachments : [];
    const body = str(text);
    const captain = from && from.kind === 'captain';
    let via;
    if (captain) {
      const ct = captainTarget(target);
      if (ct.error) return ct;
      target = ct.target;
      via = ct.via;
    } else if (!threadFor(target)) {
      return { error: 'unknown target: ' + str(target), code: 404 };
    }
    if (!body.trim() && !atts.length) return { error: 'text or attachments required', code: 400 };
    const lt = targetLieutenant(target);
    const withAtts = (msg) => (atts.length ? Object.assign(msg, { attachments: atts }) : msg);

    if (captain) {
      if (!lt) return { error: 'no lieutenant behind target: ' + target, code: 404 };
      // The channel rides the ENVELOPE, never the captain's words.
      const item = deps.queuePush(lt.id, Object.assign({ kind: 'message', target, text: body, attachments: atts },
        via ? { via } : null));
      const message = appendMessage(target, withAtts({ author: 'user', text: body, ts: deps.now() }));
      return { ok: true, target, via, message, item };
    }

    // Author: explicit, else the CALLER — never inferred from the target.
    const author = str(o.author || callerName(from) || 'agent').slice(0, 60);
    const message = appendMessage(target, withAtts({ author, text: body, ts: deps.now() }));
    const t = parseTarget(target);
    let item = null;
    if (t.kind === 'card') {
      // The thread alone notifies nobody; only the identified owner is exempt,
      // since author names cannot be trusted. Captain posts never come this way.
      const card = findCard(t.id);
      const fromOwner = from && from.kind === 'lieutenant' && from.lt.id === card.owner;
      if (!fromOwner && author !== 'user') {
        item = deps.queuePush(card.owner, { kind: 'worker-said', card: card.id, target, author,
          text: body.slice(0, 2000), attachments: atts });
      }
      return { ok: true, target, message, item };
    }
    // A main-chat post is a level-1 notification.
    board().events.push(deps.mkEvent({ text: body.slice(0, 200), actor: author, level: o.level, kind: o.kind }, { level: 1 }));
    // Someone else posting in this lieutenant's chat must be DELIVERED to it, and
    // is not its voice — the line stays where it is.
    const fromOther = !!from && ((from.kind === 'lieutenant' && lt && from.lt.id !== lt.id) || from.kind === 'worker');
    if (fromOther) {
      item = deps.queuePush(lt.id, { kind: 'peer-message', target, author,
        text: body.slice(0, 4000), attachments: atts });
    } else if (lt) {
      // The last voice the captain heard holds the line; card threads never move it.
      lineFollow(lt.id);
    }
    return { ok: true, target, message, item };
  }

  /**
   * pass(from, ltId, note, opts) — line.pass: move the line AND tell the
   * receiver with a `line-passed` delivery, so it wakes and greets the captain.
   * opts.actor overrides the caller's name; nobody identified = the captain.
   * -> {ok, lt, item, event} | {error, code}
   */
  function pass(from, ltId, note, opts) {
    const id = str(ltId).trim();
    const lt = findLieutenant(id);
    if (!lt) return { error: 'unknown lieutenant: ' + (id || '(none)'), code: 404 };
    const text = str(note).trim().slice(0, 2000);
    const by = str((opts && opts.actor) || callerName(from) || 'user').trim().slice(0, 60);
    board().line = lt.id;
    const item = deps.queuePush(lt.id, { kind: 'line-passed', from: by, text });
    const event = deps.mkEvent({ text: 'the line passed to ' + lt.name + (text ? ': ' + text : ''),
      actor: by, kind: 'line' }, {});
    board().events.push(event);
    return { ok: true, lt, item, event };
  }

  return { identify, callerName, threadFor, appendMessage, targetLieutenant,
    lineHolder, lineFollow, captainTarget, say, pass };
}

module.exports = { createConversation, parseTarget, CAPTAIN, isWorkerWindow };
