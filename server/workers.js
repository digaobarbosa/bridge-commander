'use strict';
// workers — the worker lifecycle, one module (docs/api/overview.md, "Worker",
// "card.start", "card.move", "worker plumbing"; ARCHITECTURE.md "Workers").
//
// A worker record lives in board.workers from card.start to the end of its
// life. Everything that changes a record's lifecycle flags goes through ONE
// function, transition(w, event), and everything that ends a worker goes
// through ONE function, end(card, trigger), whose rules are the END_OF_LIFE
// table below. server.js injects every side effect (harness port, worktrees,
// hooks, events, queue, save, clock), so this module runs in-process in tests.
//
// Node built-ins only.

const fs = require('fs');
const path = require('path');
const { keyOf } = require(path.join(__dirname, '..', 'harness', 'port.js'));

// ---------- transitions: the one writer of lifecycle flags ----------

const STALE = ['staleNotified', 'staleNotifiedAt', 'staleHits'];

// Per event, the flags it clears. Fields to SET ride the call; an undefined
// value deletes. Any real activity resets the stall ladder (the DNA's
// "worker stall"), so every activity row clears STALE.
const TRANSITIONS = {
  'turn-end': STALE,
  // a permission ask or its answer is activity: the stall ladder starts over
  permission: STALE,
  'stop-notified': [],
  signal: ['stopNotified', ...STALE],
  done: ['flagged', 'stopNotified', ...STALE, 'expectExit', 'pauseReason'],
  // resume and send-reopen are the same fact: a finished or dead run gets a new
  // turn. The last words belong to the run before, so the stall alert must not
  // quote them.
  revive: ['outcome', 'flagged', 'stopNotified', ...STALE, 'paused', 'killFailed',
    'expectExit', 'pauseReason', 'lastTurnEndText', 'lastSignalText'],
  pause: ['stopNotified', ...STALE],
  'pause-failed': ['paused'],
  stopped: ['expectExit', 'pauseReason'],
  leave: ['stopNotified', ...STALE],
  died: [],
  stalled: [],
  'kill-failed': [],
  killed: ['killFailed'],
  'teardown-ran': [],
  // the board typed into the worker (busy until the next turn-end or interrupt)
  input: [],
  // its running turn was stopped; the session stays for the next message
  interrupted: [],
};

/**
 * Apply one lifecycle event to a worker record: clear the event's flags, then
 * write `set` (undefined deletes). Unknown events throw — a typo must not
 * silently leave a flag standing.
 * @param {object} w worker record (null is a no-op)
 * @param {string} event key of TRANSITIONS
 * @param {object} [set] fields to write
 * @returns {object} w
 */
function transition(w, event, set) {
  const clears = TRANSITIONS[event];
  if (!clears) throw new Error('unknown worker transition: ' + event);
  if (!w) return w;
  for (const k of clears) delete w[k];
  for (const [k, v] of Object.entries(set || {})) {
    if (v === undefined) delete w[k];
    else w[k] = v;
  }
  return w;
}

// ---------- end of life: one table ----------

// ground(w, card): does ending this worker leave work standing on disk? A
// record claims its own path until that path is released; with no path on the
// record, the card's `worktree` pointer is the only handle left.
function holdsGround(w, card) {
  if (w && w.worktree && w.worktree.path) return !w.worktree.released;
  return !!(card && card.attributes && card.attributes.worktree);
}

// Every way a worker's life ends. Columns:
//   spares(w, card, onBoard)  nothing happens at all (keep_worktree, or a worker
//                             that never reported done: its checkout and its
//                             conversation may be the only copy)
//   hooks                     `card-archived` hooks run after the kill, before
//                             the release (a hook may still read $BC_WORKTREE)
//   release                   teardown budget of the release point, or null
//                             (the boot sweep ends processes, never ground)
//   drops(o)                  whether the record goes, given
//                             o = {killed, released, ground, onBoard, abandoned}
//   late                      reason to end a worker bound DURING the awaits
// The record is the last handle on unfinished ground, so only the archive
// points (nothing left to come back for) drop it past a refused release.
//
//            spares                      hooks  release  record goes when
//   handoff  keep_worktree | !done       no     long     killed & (released | no ground)
//   archive  never                       yes    long     killed
//   merge    never                       yes    long     killed
//   restart  never                       no     short    killed & released
//   sweep    on board: working|keep|!done no    none     killed & (off board | no ground),
//                                                        or off board & kill failed twice
const END_OF_LIFE = {
  handoff: {
    spares: (w) => !!w && (!!w.keepWorktree || !w.done),
    reason: () => 'the handoff — the card left Working',
    hooks: false, release: 'long',
    drops: (o) => o.killed && (o.released || !o.ground),
  },
  archive: {
    spares: () => false,
    reason: () => 'the card was archived',
    hooks: true, release: 'long', late: 'the card was archived while it was working',
    drops: (o) => o.killed,
  },
  merge: {
    spares: () => false,
    reason: () => 'the PR merged',
    hooks: true, release: 'long', late: 'the PR merged while it was working',
    drops: (o) => o.killed,
  },
  restart: {
    spares: () => false,
    reason: () => 'the card was restarted',
    hooks: false, release: 'short',
    drops: (o) => o.killed && o.released,
  },
  sweep: {
    spares: (w, card, onBoard) => !w
      || (onBoard && (card.column === 'working' || !!w.keepWorktree || !w.done)),
    reason: (card, onBoard, columnTitle) => (onBoard
      ? 'boot sweep: the card is in ' + columnTitle(card.column) + ', not Working'
      : 'boot sweep: the card is no longer on the board'),
    hooks: false, release: null,
    drops: (o) => (o.killed ? (!o.onBoard || !o.ground) : (!o.onBoard && o.refused && o.abandoned)),
  },
};

const TEARDOWN_OUTPUT_TAIL = 1200; // of the event text, whose own cap is 2000
const PR_URL_RE = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;

/**
 * Build the worker lifecycle over injected dependencies.
 * @param {object} deps
 * @param {() => object} deps.board live board ({workers: []})
 * @param {(id: string) => object|null} deps.findCard card on the board, or null
 * @param {(name: string) => object|null} deps.findProject registered project
 * @param {(id: string) => string} deps.columnTitle
 * @param {(ref: object) => object} deps.harnessFor harness port for a ref, BOUND
 *   (port.js getHarness/harnessFor with an env): verbs take no stateDir/callbackUrl
 * @param {{create: Function, release: Function, toolFor: Function}} deps.worktrees
 * @param {(cmd: string, ctx: object, opts: object) => Promise<object>} deps.runTeardown
 * @param {(card: object, w: object) => object} deps.hookContext
 * @param {(event: string, card: object, w: object, opts?: object) => Promise} deps.fireHooks
 * @param {(body: object, defaults: object) => object} deps.mkEvent
 * @param {(card: object, ev: object, opts?: object) => object} deps.landEvent
 * @param {(owner: string, item: object) => object} deps.queuePush
 * @param {() => void} deps.save persist + broadcast
 * @param {() => number} [deps.clock] epoch ms
 * @param {(card: object, body: object, project: object) => object} deps.planStart
 * @param {(card: object) => string} deps.ownerSession
 * @param {(cardId: string) => string} deps.workerWindow
 * @param {(w: object) => Promise<boolean>} [deps.refreshStatus]
 * @param {(msg: string) => void} [deps.log]
 * @param {object} deps.config {stateDir, teardownMs, restartTeardownMs, staleSecs}
 */
function createWorkers(deps) {
  const cfg = deps.config || {};
  // permission approvals are optional: an embedder without them never waits on an ask
  const permissionMode = deps.permissionMode || (() => undefined);
  const permissionPending = deps.permissionPending || (() => false);
  const clock = deps.clock || Date.now;
  const iso = () => new Date(clock()).toISOString();
  const log = deps.log || ((m) => console.error(iso() + ' ' + m));
  const records = () => deps.board().workers;
  const errText = (e) => String((e && e.message) || e);

  // ---------- lookups ----------

  const refKey = keyOf; // the harness owns the state key's shape
  function find(cardId) { return records().find((w) => w.card === cardId); }
  // A record stops being this card's the moment it is dropped or a newer worker
  // binds the card; every await in here re-asks before touching it.
  function isCurrent(w) { return !!w && find(w.card) === w; }
  function supersededBy(cardId, w) { const cur = find(cardId); return cur && cur !== w ? cur : null; }

  /** The worker record a turn-end hook posts for: by resume id, then by pane key. */
  function byHook(sid, sname) {
    let w = sid ? records().find((x) => x.ref.resumeId === sid) : null;
    if (!w && sname) w = records().find((x) => refKey(x.ref) === sname);
    return w || null;
  }

  // note(card, fields, defaults) — one timeline entry, landing on the board
  // stream when the card has left the board.
  function note(card, fields, defaults, opts) {
    return deps.landEvent(card, deps.mkEvent(fields, defaults || {}), opts);
  }
  // notify(card, kind, text, level) — the pair every worker alarm is: a card
  // event and a queue item waking the owner.
  function notify(card, kind, text, level) {
    const ev = note(card, level ? { text, actor: 'server', level } : { text, actor: 'server' }, { kind });
    deps.queuePush(card.owner, { kind, card: card.id, text });
    return ev;
  }

  async function alive(ref) { return deps.harnessFor(ref).alive(ref); }
  async function aliveOrFalse(ref) { try { return await alive(ref); } catch (e) { return false; } }

  // ---------- the card's side ----------

  // card.start is the ONE way into Working; clears any start order it executes.
  function enterWorking(card, text) {
    const from = card.column;
    card.column = 'working';
    card.pendingOrder = null;
    card.updated = iso();
    return note(card, {
      text: text + (from !== 'working' ? ' (' + deps.columnTitle(from) + ' → ' + deps.columnTitle('working') + ')' : ''),
      actor: 'server',
    }, { kind: 'started' });
  }

  // The brief the harness persisted at spawn — its optional brief verb, so the
  // server never builds a harness file path. A harness without it (or one that
  // cannot answer) simply attaches nothing.
  async function briefOf(ref) {
    try {
      const impl = deps.harnessFor(ref);
      return typeof impl.brief === 'function' ? (await impl.brief(ref)) || null : null;
    } catch (e) { return null; }
  }
  // Attached once: a resume never regenerates the brief, so the uri dedup
  // keeps this idempotent.
  function attachBrief(card, briefFile) {
    if (!briefFile) return;
    if (!Array.isArray(card.attributes.artifacts)) card.attributes.artifacts = [];
    const uri = 'file://' + briefFile;
    if (!card.attributes.artifacts.some((a) => a && a.uri === uri)) {
      card.attributes.artifacts.push({ uri, label: 'brief', type: 'markdown' });
    }
  }

  /**
   * The card's own note of the run (`session` + `resumeId`), so the transcript
   * stays findable after the record goes. The pair is one address: resumeId
   * is set or deleted, never left from a previous run.
   */
  function stamp(card, w) {
    if (!card || !card.attributes || !w) return;
    card.attributes.session = refKey(w.ref);
    if (w.ref && w.ref.resumeId) card.attributes.resumeId = w.ref.resumeId;
    else delete card.attributes.resumeId;
    if (deps.rememberSession) deps.rememberSession(card, w);
  }

  // ---------- kill / release / drop: the three halves of an ending ----------

  /**
   * End the session and VERIFY it is gone (kill, then alive() again). Never
   * throws. The level-1 bell rings once per record; a verified kill re-arms it.
   * @returns {Promise<{killed: boolean, reason?: string}|null>} null when the
   *   record is no longer this card's (nothing to do)
   */
  async function kill(card, w, opts = {}) {
    try {
      if (!w || !isCurrent(w)) return null;
      const name = refKey(w.ref);
      let up = true;
      let err = null;
      let already = false;
      try {
        const impl = deps.harnessFor(w.ref);
        // alive() goes false when the agent exits while its window still stands
        // at a shell, so the kill runs regardless; this read only decides what to SAY.
        already = !(await impl.alive(w.ref));
        await impl.kill(w.ref);
        up = await impl.alive(w.ref);
      } catch (e) { err = e; }
      if (up || err) {
        const why = err ? errText(err) : 'the pane answered alive() after the kill';
        log('worker kill for ' + card.id + ' failed: ' + why);
        if (!w.killFailed) {
          transition(w, 'kill-failed', { killFailed: why });
          note(card, {
            text: 'worker ' + name + ' could NOT be killed (' + why + ') — its record is kept, '
              + 'so the session is still on the board rather than leaked; end it by hand '
              + '(tmux kill-window -t ' + name + ') and archive or restart the card',
            actor: 'server',
          }, { kind: 'worker-kill-failed' });
        }
        deps.save();
        return { killed: false, reason: why };
      }
      const rang = !!w.killFailed;
      transition(w, 'killed');
      // A pane already gone is killed by definition: announcing it would repeat
      // the same closure at every boot the spared record survives.
      if (already) {
        if (rang) deps.save();
        return { killed: true };
      }
      note(card, {
        text: 'worker ' + name + ' closed (' + (opts.reason || 'the card left Working') + ')',
        actor: 'server', level: 2,
      }, {});
      deps.save();
      return { killed: true };
    } catch (e) {
      log('worker kill for ' + card.id + ' failed: ' + errText(e));
      return null;
    }
  }

  // Not persisted: a teardown interrupted by a server restart is not in flight.
  const teardownInFlight = new WeakSet();

  // The playbook's `teardown`, in the checkout, just before it goes. Best
  // effort: its outcome is an event and never steers the release.
  async function teardown(card, w, wtPath, timeoutMs) {
    const command = String((w && w.teardown) || '').trim();
    if (!command) return null;
    // A released path may be a pool slot leased to another card by now.
    if (!wtPath || !fs.existsSync(wtPath)) return null;
    if (w.worktree && w.worktree.released) return null;
    // Only a SUCCESS is recorded: a failure stays retryable at the next release point.
    if (w.teardownRan || teardownInFlight.has(w)) return null;
    teardownInFlight.add(w);
    try {
      // The path is passed, never re-derived: hookContext reports a released
      // worktree as '' and the teardown would run in the workspace root.
      const ctx = Object.assign(deps.hookContext(card, w), { worktree: wtPath });
      const r = await deps.runTeardown(command, ctx, { timeoutMs });
      if (r.ok) transition(w, 'teardown-ran', { teardownRan: true });
      const detail = r.timedOut ? 'timed out' : r.error ? String(r.error) : 'exit ' + r.code;
      const out = r.output.length > TEARDOWN_OUTPUT_TAIL ? '…' + r.output.slice(-TEARDOWN_OUTPUT_TAIL) : r.output;
      const text = 'teardown `' + command + '` ' + (r.ok ? 'ok' : 'FAILED')
        + ' (' + detail + ', ' + (r.ms / 1000).toFixed(1) + 's)' + (out ? ': ' + out : '');
      note(card, { text, actor: 'server' }, { kind: r.ok ? 'hook-ran' : 'hook-failed' });
      if (!r.ok) {
        log('teardown for ' + card.id + ' failed (' + detail + '): ' + command);
        deps.queuePush(card.owner, { kind: 'hook-failed', card: card.id, text: text.slice(0, 2000) });
      }
      deps.save(); // the release may sit behind the clone lock for minutes
      return r;
    } catch (e) {
      log('teardown for ' + card.id + ' failed: ' + errText(e));
      return null;
    } finally {
      teardownInFlight.delete(w);
    }
  }

  // The OTHER card whose live record stands on this path. A card pointer (or a
  // record that already released) is not ownership: a pool re-leases slots.
  function holderOf(cardId, wtPath) {
    return records().find((x) => x.card !== cardId
      && x.worktree && x.worktree.path === wtPath && !x.worktree.released) || null;
  }
  function claims(w) { return !!(w && w.worktree && w.worktree.path && !w.worktree.released); }

  /**
   * Give the card's worktree back: teardown first, then releaseWorktree, which
   * REFUSES a checkout still holding work (that refusal is the feature). Never
   * throws.
   * @param {object} opts {teardownMs, project (fallback clone)}
   * @returns {Promise<{released: boolean, reason?: string, holder?: string}|null>}
   *   null when nothing could run (no ground, no clone, superseded, threw)
   */
  async function release(card, w, opts = {}) {
    try {
      if (supersededBy(card.id, w)) return null;
      const attrs = (card && card.attributes) || {};
      const fromRecord = !!(w && w.worktree && w.worktree.path);
      const wtRec = fromRecord ? w.worktree
        : (attrs.worktree ? { path: String(attrs.worktree), tool: deps.worktrees.toolFor(String(attrs.worktree)) } : null);
      if (!wtRec) return null;
      const project = deps.findProject(String((w && w.project) || attrs.repo || '')) || opts.project || null;
      if (!project) return null; // no clone to release against — leave the directory alone
      const holder = (fromRecord && claims(w)) ? null : holderOf(card.id, wtRec.path);
      let rel;
      if (holder) {
        rel = { released: false, reason: 'it belongs to card ' + holder.card + ', whose worker is live on it', holder: holder.card };
      } else {
        await teardown(card, w, wtRec.path, opts.teardownMs || cfg.teardownMs);
        // The teardown is minutes long: a restart meanwhile may have re-cut this
        // very path for a new worker. Whoever holds the card holds its path.
        if (supersededBy(card.id, w)) return null;
        rel = await deps.worktrees.release(wtRec, project.path);
      }
      const live = deps.findCard(card.id);
      if (rel.released) {
        if (live && live.attributes) delete live.attributes.worktree;
        if (w && w.worktree) w.worktree.released = true;
      }
      if (!(rel.released && rel.reason === 'already gone')) { // nothing happened, nothing to say
        const text = rel.released
          ? 'worktree released: ' + wtRec.path
          : 'worktree kept (' + rel.reason + '): ' + wtRec.path;
        if (!rel.released) log('worktree not released for ' + card.id + ': ' + rel.reason);
        note(card, { text, actor: 'server' }, { level: 2 });
      }
      deps.save();
      return rel;
    } catch (e) {
      log('worktree release for ' + card.id + ' failed: ' + errText(e));
      return null;
    }
  }

  /** Drop the registry entry (ONLY behind a verified kill), stamping its address on the card. */
  function drop(card, w) {
    if (!isCurrent(w)) return null;
    stamp(deps.findCard(w.card) || card, w);
    deps.board().workers = records().filter((x) => x !== w);
    deps.save();
    return w;
  }

  /**
   * End a worker's life — the ONE path for the handoff, archive, PR merge,
   * rework restart and boot sweep; END_OF_LIFE says what each one does.
   * Never throws.
   * @param {object} card the card (or a {id, title} stand-in for an orphan record)
   * @param {'handoff'|'archive'|'merge'|'restart'|'sweep'} trigger
   * @param {object} [opts] {project: fallback clone for the release}
   * @returns {Promise<{spared?: true, kill?: object|null, release?: object|null,
   *   dropped?: boolean, newer?: object}>}
   */
  async function end(card, trigger, opts = {}) {
    const row = END_OF_LIFE[trigger];
    if (!row) throw new Error('unknown end-of-life trigger: ' + trigger);
    if (card.execution === 'external') return { spared: true };
    let w = find(card.id) || null;
    const onBoard = !!deps.findCard(card.id);
    if (row.spares(w, card, onBoard)) return { spared: true };
    // Read before the release: a landed one clears the card's pointer.
    const ground = holdsGround(w, card);
    // Read before the kill: the attempt itself sets it.
    const abandoned = !!(w && w.killFailed);
    const reason = row.reason(card, onBoard, deps.columnTitle);
    let killed = null;
    if (w) {
      killed = await kill(card, w, { reason });
      if (killed && !killed.killed && trigger === 'restart') return { kill: killed };
      if (!killed && trigger === 'restart') {
        // The record retired while we looked (the handoff's detached release,
        // the boot sweep): a newer worker refuses the start, nobody is a clean slate.
        const newer = find(card.id);
        if (newer) return { kill: null, newer };
        w = null;
      }
    }
    if (row.hooks) await deps.fireHooks('card-archived', card, w, { boardLevel: true });
    const rel = row.release
      ? await release(card, w, {
        teardownMs: row.release === 'short' ? cfg.restartTeardownMs : cfg.teardownMs,
        project: opts.project,
      })
      : null;
    let dropped = false;
    if (w && row.drops({
      killed: !!(killed && killed.killed), refused: !!(killed && !killed.killed),
      released: !!(rel && rel.released), ground, onBoard, abandoned,
    })) {
      if (!(killed && killed.killed)) {
        // The sweep's terminal path: kept records protect work somebody may come
        // back for, and nobody comes back for a card that left the board.
        const name = refKey(w.ref);
        note(card, {
          text: 'worker ' + name + ' ABANDONED (' + ((killed && killed.reason) || 'the kill could not be verified')
            + '): its card is off the board, so the record is dropped — nothing is left to come back for it. '
            + 'End the session by hand if it is still up (tmux kill-window -t ' + name + ')',
          actor: 'server', level: 2,
        }, {});
      }
      dropped = !!drop(card, w);
    }
    // A worker bound during the awaits above is working a card that is ending.
    if (row.late) {
      const bound = find(card.id);
      if (bound && bound !== w) {
        const late = await kill(card, bound, { reason: row.late });
        if (late && late.killed) drop(card, bound);
      }
    }
    return { kill: killed, release: rel, dropped };
  }

  /** Boot: one pass of the registry through end(…, 'sweep'). */
  async function sweep() {
    for (const w of [...records()]) {
      const card = deps.findCard(w.card) || { id: w.card, title: w.card };
      await end(card, 'sweep');
    }
  }

  // ---------- start / resume ----------

  const starting = new Set(); // card ids with a start or resume in flight

  /**
   * card.start — ONE atomic op: worktree + spawn + bind + card → Working.
   * body.resume reincarnates the recorded worker instead. A second start of
   * the SAME card while one is in flight is refused; other cards interleave.
   * @returns {Promise<{worker: object, resumed?: true}|{error: string, code: number}>}
   */
  async function start(card, body) {
    if (starting.has(card.id)) return { error: 'card start already in progress: ' + card.id, code: 409 };
    starting.add(card.id);
    try {
      return await doStart(card, body || {});
    } finally {
      starting.delete(card.id);
    }
  }

  async function doStart(card, body) {
    if (card.execution === 'external') return { error: 'this card tracks an external session; use its eye button to continue it', code: 409 };
    if (card.type === 'plan') return { error: 'plan cards never start (no worker is spawned for a plan)', code: 400 };
    // The second way a card could start is gone, not merely unsupported.
    if (body.command !== undefined) {
      return { error: '--command was removed: a card starts one way, from its playbook. '
        + 'Pick one with: bc-axi card patch ' + card.id + ' --playbook <id>', code: 400 };
    }
    if (body.resume) return resume(card, body);

    let existing = find(card.id);
    if (card.column === 'working') return { error: 'card is already Working', code: 409 };
    if (existing && !existing.done) {
      return { error: 'card already has a worker (' + refKey(existing.ref) + ') — resume it (card start --resume) or archive first', code: 409 };
    }
    const repoAttr = card.attributes && card.attributes.repo;
    if (!repoAttr) return { error: 'card has no repo attribute — set it first: card patch ' + card.id + ' --attr repo=<project>', code: 400 };
    const project = deps.findProject(String(repoAttr));
    if (!project) return { error: 'unregistered project: ' + repoAttr + ' (register it: bc-axi project add <url|path>)', code: 400 };
    const plan = deps.planStart(card, body, project);
    if (plan.error) return plan;

    // A finished previous worker (rework restart): a live one is steered or
    // resumed, never spawned over — except done on ground the handoff already
    // released, which has nowhere left to write.
    if (existing) {
      let up = false;
      try { up = await alive(existing.ref); } catch (e) { up = false; }
      const groundGone = !!(existing.done && existing.worktree && existing.worktree.path
        && !fs.existsSync(existing.worktree.path));
      if (up && !groundGone) {
        const reopenHint = existing.done ? ' (or, since it reported done, reopen it in place with worker send)' : '';
        return { error: 'previous worker session ' + refKey(existing.ref) + ' is still alive — resume it (card start --resume) or steer it instead of spawning over it' + reopenHint, code: 409 };
      }
    }
    if (existing || (card.attributes && card.attributes.worktree)) {
      const refused = await restartOver(card, existing, project);
      if (refused) return refused;
    }

    let wt;
    try { wt = await deps.worktrees.create(project.path, card.id); }
    catch (e) { return { error: 'worktree provisioning failed: ' + errText(e), code: 502 }; }
    for (const warning of (wt.warnings || [])) {
      note(card, { text: 'worktree base: ' + warning, actor: 'server' }, { kind: 'stale-base' });
    }
    delete wt.warnings; // said on the card; the persisted record is the checkout itself

    const spawnOpts = {
      session: deps.ownerSession(card), window: deps.workerWindow(card.id),
      permissionMode: permissionMode(),
    };
    if (plan.extraArgs && plan.extraArgs.length) spawnOpts.extraArgs = plan.extraArgs;
    let ref;
    try {
      ref = await plan.impl.spawn(wt.path, plan.brief(wt.path), spawnOpts);
    } catch (e) {
      await deps.worktrees.release(wt, project.path).catch(() => {}); // no spawnless lease left behind
      return { error: 'worker spawn failed: ' + errText(e), code: 502 };
    }
    const brief = await briefOf(ref);
    if (!deps.findCard(card.id)) { // archived while provisioning/spawn were in flight
      Promise.resolve().then(() => plan.impl.kill(ref)).catch(() => {});
      await deps.worktrees.release(wt, project.path).catch(() => {});
      return { error: 'card left the board during start: ' + card.id, code: 409 };
    }

    card.attributes.worktree = wt.path;
    // Cleared when this run cuts none, so nothing downstream reads the last run's branch.
    if (plan.branch) card.attributes.branch = plan.branch;
    else delete card.attributes.branch;
    attachBrief(card, brief);
    const worker = { card: card.id, ref, worktree: wt, project: project.name, spawnedAt: iso(), done: false };
    stamp(card, worker);
    if (plan.branch) worker.branch = plan.branch;
    // Read at the handoff; the playbook is resolved here and only here.
    if (plan.keepWorktree) worker.keepWorktree = true;
    if (plan.teardown) worker.teardown = plan.teardown;
    records().push(worker);
    enterWorking(card, 'worker ' + refKey(ref) + ' started in ' + wt.path);
    return { worker };
  }

  // The restart half of a start: end the previous run (end(…, 'restart')) and
  // turn each way it can refuse into the 409 that names the way out.
  async function restartOver(card, existing, project) {
    const pointer = String((card.attributes && card.attributes.worktree) || '');
    const out = await end(card, 'restart', { project });
    if (out.newer) {
      return { error: 'card already has a worker (' + refKey(out.newer.ref)
        + ') — resume it (card start --resume) or archive first', code: 409 };
    }
    if (out.kill && !out.kill.killed) {
      const name = refKey(existing.ref);
      return { error: 'previous worker session ' + name + ' could not be ended ('
        + out.kill.reason + ') — end it by hand (tmux kill-window -t ' + name
        + ') and start the card again', code: 409 };
    }
    // out.kill is null when the record retired mid-flight: the pointer is all that is left.
    const onRecord = !!(existing && out.kill && existing.worktree && existing.worktree.path);
    const target = onRecord ? existing.worktree.path : pointer;
    const rel = out.release;
    if (rel && rel.holder) {
      return { error: onRecord
        ? 'the worktree ' + card.id + '\'s previous worker recorded (' + target + ') belongs to card '
          + rel.holder + ', whose worker is live on it — this record\'s claim on it is spent. Look at '
          + rel.holder + ' first, then archive or restart ' + card.id
        : 'the worktree ' + card.id + ' still points at (' + target + ') belongs to card '
          + rel.holder + ', whose worker is live on it — this card\'s pointer is stale. Clear it '
          + '(bc-axi card patch ' + card.id + ' --attr worktree=) once you have looked at '
          + rel.holder + ', then start again', code: 409 };
    }
    if (rel && !rel.released) {
      return { error: 'previous worker worktree not releasable (' + rel.reason + '): ' + target, code: 409 };
    }
    // Ground nothing released stays the record's, and a card never holds two
    // records: whatever kept the old one refuses the start.
    const left = find(card.id);
    if (left) {
      return { error: 'previous worker worktree not releasable (the release could not run): '
        + (target || '(no worktree recorded)'), code: 409 };
    }
    if (card.attributes) delete card.attributes.worktree;
    return null;
  }

  async function resume(card, body) {
    const existing = find(card.id);
    if (body.brief) {
      return { error: 'resume does not deliver briefs — the reincarnated worker keeps its own context '
        + 'and the brief would be silently dropped. To hand a live worker new instructions: '
        + 'bc-axi worker send ' + card.id + ' --text-file <f|->', code: 400 };
    }
    if (!existing) {
      return { error: 'nothing to resume: card ' + card.id + ' has no recorded worker — a handoff '
        + 'ends the worker it hands off, so rework after one is a fresh start (card start ' + card.id
        + '), and a card that never started has nothing to reincarnate either', code: 400 };
    }
    // --expect-exit: the first run still holds the path; a resume would be a second run.
    if (existing.expectExit) {
      return { error: 'refusing to resume ' + card.id + ': its worker stopped with --expect-exit — resuming '
        + 'would start a second run over the one already in flight. '
        + 'The way back, as recorded at the pause: ' + (existing.pauseReason || '(no reason recorded)'), code: 409 };
    }
    if (existing.worktree && existing.worktree.path && !fs.existsSync(existing.worktree.path)) {
      return { error: 'cannot resume ' + card.id + ': its worktree is gone (' + existing.worktree.path
        + ') — released when the card left Working. Start a fresh worker (card start ' + card.id
        + ' — it spawns over the finished session), or, for a playbook whose cards are reworked in '
        + 'place, set `keep_worktree: true` in its frontmatter', code: 409 };
    }
    let ref;
    try {
      ref = await deps.harnessFor(existing.ref).resume(existing.ref, { permissionMode: permissionMode() });
    } catch (e) {
      return { error: 'worker resume failed: ' + errText(e), code: 502 };
    }
    const brief = await briefOf(ref);
    if (!deps.findCard(card.id)) { // archived while the resume was in flight
      Promise.resolve().then(() => deps.harnessFor(ref).kill(ref)).catch(() => {});
      return { error: 'card left the board during resume: ' + card.id, code: 409 };
    }
    existing.ref = ref;
    stamp(card, existing);
    transition(existing, 'revive', { done: false });
    attachBrief(card, brief);
    enterWorking(card, 'worker ' + refKey(ref) + ' resumed in ' + existing.worktree.path);
    return { worker: existing, resumed: true };
  }

  // ---------- worker verbs ----------

  /** worker.signal — a milestone: resets the stall clock, level-2 event + owner item. */
  function signal(card, body) {
    const text = String((body && body.text) || '').trim();
    if (!text) return { error: 'text required', code: 400 };
    transition(find(card.id), 'signal', { lastSignalAt: iso(), lastSignalText: text.slice(0, 300) });
    const ev = note(card, { text: text.slice(0, 2000), actor: (body && body.actor) || 'worker' }, { kind: 'signal' });
    deps.queuePush(card.owner, { kind: 'worker-signal', card: card.id, text: text.slice(0, 2000) });
    return { ok: true, event: ev };
  }

  /**
   * worker.done — the card does NOT move (the lieutenant verifies and hands
   * off); PR URLs populate `prs`, an investigation's report is attached.
   */
  function done(card, body) {
    const outcome = String((body && body.outcome) || '').trim();
    if (!outcome) return { error: 'outcome required', code: 400 };
    transition(find(card.id), 'done', { done: true, outcome: outcome.slice(0, 2000) });
    const urls = outcome.match(PR_URL_RE) || [];
    if (urls.length) {
      if (!Array.isArray(card.attributes.prs)) card.attributes.prs = [];
      for (const url of urls) {
        if (!card.attributes.prs.some((p) => p && p.url === url)) card.attributes.prs.push({ url, state: 'open' });
      }
    }
    if (card.type === 'investigation') {
      const report = path.join(cfg.stateDir, 'reports', card.id + '.md');
      if (fs.existsSync(report)) {
        if (!Array.isArray(card.attributes.artifacts)) card.attributes.artifacts = [];
        const uri = 'file://' + report;
        if (!card.attributes.artifacts.some((a) => a && a.uri === uri)) card.attributes.artifacts.push({ uri, label: 'report' });
      }
    }
    const ev = note(card, { text: 'worker done: ' + outcome.slice(0, 1900), actor: (body && body.actor) || 'worker' }, { kind: 'worker-done' });
    deps.queuePush(card.owner, { kind: 'worker-done', card: card.id, text: outcome.slice(0, 2000) });
    return { ok: true, event: ev };
  }

  /**
   * worker.send — type into the live worker (verified submission). On a
   * done-but-alive worker it reopens the turn (card → Working).
   */
  async function send(card, body) {
    const text = String((body && body.text) || '').trim();
    if (!text) return { error: 'text required', code: 400 };
    const w = find(card.id);
    if (!w) {
      return { error: 'no worker bound to card ' + card.id + ' — start one first (card start ' + card.id + ')', code: 404 };
    }
    const up = await aliveOrFalse(w.ref);
    if (w.done) {
      // The ground first: neither a reopen nor a resume has anywhere to write.
      if (w.worktree && w.worktree.path && !fs.existsSync(w.worktree.path)) {
        return { error: 'worker for ' + card.id + ' reported done and its worktree was released at the handoff ('
          + w.worktree.path + ') — a reopened turn would have nowhere to write. Start a fresh worker '
          + '(card start ' + card.id + ' — it spawns over this finished session), or, for a playbook whose '
          + 'cards are reworked in place, set `keep_worktree: true` in its frontmatter', code: 409 };
      }
      if (!up) {
        return { error: 'worker for ' + card.id + ' reported done and its session is gone — revive it first (card start ' + card.id + ' --resume), then send', code: 409 };
      }
      transition(w, 'revive', { done: false });
      enterWorking(card, 'worker ' + refKey(w.ref) + ' reopened for a new turn');
    } else if (!up) {
      return { error: 'worker session ' + refKey(w.ref) + ' is not alive — resume it first (card start ' + card.id + ' --resume), then send', code: 409 };
    }
    try {
      await deps.harnessFor(w.ref).send(w.ref, text);
    } catch (e) {
      return { error: 'delivery to ' + refKey(w.ref) + ' failed: ' + errText(e), code: 502 };
    }
    transition(w, 'input', { lastInputAt: iso() });
    const ev = note(card, { text: 'sent to worker: ' + text.slice(0, 1900), actor: (body && body.actor) || 'agent' }, { kind: 'worker-send' });
    return { ok: true, event: ev, session: refKey(w.ref) };
  }

  /**
   * worker.pause — the ONE deliberate stop: marked BEFORE the kill so
   * supervision never reads it as a death. body.expectExit kills nothing (the
   * caller is inside the session) and makes `--resume` refuse, quoting
   * body.reason. body.park composes card.park.
   */
  async function pause(card, body) {
    body = body || {};
    const w = find(card.id);
    if (!w) return { error: 'no worker recorded for card ' + card.id + ' — nothing to pause', code: 404 };
    if (w.done) {
      return { error: 'worker for ' + card.id + ' already reported done — nothing to pause (the lieutenant verifies and hands off)', code: 409 };
    }
    if (body.park && card.column !== 'working') {
      return { error: 'pause --park needs a Working card — ' + card.id + ' is in ' + deps.columnTitle(card.column), code: 409 };
    }
    transition(w, 'pause', { paused: iso() });
    if (!body.expectExit) {
      try {
        await deps.harnessFor(w.ref).kill(w.ref);
      } catch (e) {
        transition(w, 'pause-failed'); // the session may still be alive: let supervision judge
        return { error: 'pause failed killing session ' + refKey(w.ref) + ': ' + errText(e), code: 502 };
      }
    }
    const actor = String(body.actor || 'agent').slice(0, 60);
    const reason = String(body.reason || '').trim().slice(0, 500) || 'resume: card start ' + card.id + ' --resume';
    transition(w, 'stopped', body.expectExit ? { expectExit: true, pauseReason: reason } : {});
    const ev = note(card, { text: 'worker ' + refKey(w.ref) + ' paused (deliberate) — ' + reason, actor }, { kind: 'worker-paused' });
    const out = { ok: true, event: ev, session: refKey(w.ref) };
    if (body.park) {
      const p = await park(card, body);
      if (p.error) { out.parked = false; out.parkError = p.error; }
      else { out.parked = true; out.parkEvent = p.event; }
    }
    return out;
  }

  /**
   * card.park — Working → Backlog, legal only when the worker is absent or
   * dead (checked HERE). Not a release: the record and checkout stay for --resume.
   */
  async function park(card, body) {
    if (card.column !== 'working') {
      return { error: 'park moves a Working card back to Backlog — ' + card.id + ' is in ' + deps.columnTitle(card.column), code: 409 };
    }
    const w = find(card.id);
    if (w && await aliveOrFalse(w.ref)) {
      return w.done
        ? { error: 'refusing to park ' + card.id + ': its worker reported done and session ' + refKey(w.ref)
            + ' is still alive — verify the work and hand off (card move ' + card.id + ' review), or archive', code: 409 }
        : { error: 'refusing to park ' + card.id + ': worker session ' + refKey(w.ref)
            + ' is ALIVE — pause it first (worker pause ' + card.id + ' [--park]) or let it finish', code: 409 };
    }
    const from = card.column;
    card.column = 'backlog';
    card.pendingOrder = null;
    card.updated = iso();
    transition(w, 'leave');
    const ev = note(card, {
      actor: (body && body.actor) || 'agent',
      text: 'parked (worker ' + (w ? refKey(w.ref) + (w.paused ? ', paused' : ', dead') : 'absent') + '): '
        + deps.columnTitle(from) + ' → ' + deps.columnTitle('backlog'),
    }, { kind: 'parked' });
    return { ok: true, event: ev };
  }

  /** The card left Working (any move out): the stop and stall states are over. */
  function leave(cardId) { transition(find(cardId), 'leave'); }

  /**
   * A worker turn-end: activity stamp, and — on a Working card with no `done` —
   * the stop signal, EVERY time (a re-sent worker that stops again stopped again).
   * @returns {Promise<{stopped: boolean, statusChanged: boolean}>}
   */
  async function turnEnd(w, { sid, text } = {}) {
    if (sid && w.ref.resumeId !== sid) w.ref.resumeId = sid; // hook payload is ground truth
    const said = typeof text === 'string' && text.trim() ? text.trim().slice(0, 300) : undefined;
    transition(w, 'turn-end', Object.assign({ lastTurnEnd: iso(), turns: (w.turns || 0) + 1 },
      said ? { lastTurnEndText: said } : {}));
    const statusChanged = deps.refreshStatus ? !!(await deps.refreshStatus(w)) : false;
    const card = deps.findCard(w.card);
    stamp(card, w);
    let stopped = false;
    if (card && card.column === 'working' && !w.done) {
      transition(w, 'stop-notified', { stopNotified: true });
      stopped = true;
      notify(card, 'worker-stopped', 'worker ' + refKey(w.ref) + ' stopped without reporting done');
    }
    return { stopped, statusChanged };
  }

  // ---------- supervision: died / stalled ----------

  // The worker's most recent words: the newer of turn-end text and signal text.
  function lastWordOf(w) {
    const turn = w.lastTurnEndText ? Date.parse(w.lastTurnEnd) : NaN;
    const sig = w.lastSignalText ? Date.parse(w.lastSignalAt) : NaN;
    if (!Number.isNaN(turn) && !Number.isNaN(sig)) return sig > turn ? w.lastSignalText : w.lastTurnEndText;
    return w.lastTurnEndText || w.lastSignalText || '';
  }

  // One rung of the stall ladder when the silence outlived the window since
  // the last activity AND since the last alert: level 2 first, then level 1.
  function stallCheck(w) {
    const card = deps.findCard(w.card);
    if (!card || card.column !== 'working') return false;
    // a worker with a permission ask pending waits on the captain; it is not hung
    if (permissionPending(w.card)) return false;
    const stamps = [w.spawnedAt, w.lastTurnEnd, w.lastSignalAt, w.lastPermissionAt]
      .map((t) => (t ? Date.parse(t) : NaN)).filter((n) => !Number.isNaN(n));
    const lastActivity = stamps.length ? Math.max(...stamps) : 0;
    const notifiedAt = w.staleNotifiedAt ? Date.parse(w.staleNotifiedAt) : NaN;
    const t = clock();
    const sinceNotify = Number.isNaN(notifiedAt) ? Infinity : t - notifiedAt;
    const windowMs = cfg.staleSecs * 1000;
    if (!lastActivity || t - lastActivity <= windowMs || sinceNotify <= windowMs) return false;
    transition(w, 'stalled', { staleNotified: true, staleNotifiedAt: iso(), staleHits: (w.staleHits || 0) + 1 });
    const lastWord = lastWordOf(w);
    let text = 'worker ' + refKey(w.ref) + ' alive but silent for '
      + Math.round((t - lastActivity) / 60000) + 'min (no signal/turn-end) — may be hung';
    if (w.staleHits >= 2) {
      text += ' — still silent, alert #' + w.staleHits
        + (lastWord ? '; last said: ' + JSON.stringify(lastWord.slice(0, 300)) : '');
    }
    notify(card, 'worker-stalled', text, w.staleHits >= 2 ? 1 : 2);
    return true;
  }

  /**
   * One supervision pass over the workers: a dead worker without done is
   * flagged once (worker-died), a live silent one climbs the stall ladder.
   * @returns {Promise<boolean>} whether anything changed
   */
  async function tick() {
    let changed = false;
    for (const w of [...records()]) {
      if (w.done || w.flagged || w.paused) continue;
      const up = await aliveOrFalse(w.ref);
      // Re-read after the await: a pause marks before it kills, and an ending
      // (handoff, merge, archive) may have killed and dropped this very record.
      if (w.paused || !isCurrent(w)) continue;
      if (up) {
        if (cfg.staleSecs > 0 && stallCheck(w)) changed = true;
        continue;
      }
      transition(w, 'died', { flagged: true });
      changed = true;
      const card = deps.findCard(w.card);
      if (card) {
        notify(card, 'worker-died', 'worker session ' + refKey(w.ref) + ' died without reporting done');
        deps.fireHooks('worker-died', card, w); // fire-and-forget
      }
    }
    return changed;
  }

  /**
   * The single-card read's lease: a worker that never leased reads `absent`
   * while its session is plainly alive, so ask the session. A written lease wins.
   */
  async function withLiveness(card, status) {
    if (!status || !status.worker || status.worker.state !== 'absent') return status;
    const w = find(card.id);
    if (!w || !(await aliveOrFalse(w.ref))) return status;
    return Object.assign({}, status, {
      worker: { id: refKey(w.ref), state: (w.done || w.paused) ? 'idle' : 'working', derived: true },
    });
  }

  return {
    find, byHook, refKey, stamp, kill, release, drop, end, sweep, start, signal, done, send,
    pause, park, leave, turnEnd, tick, withLiveness, transition, enterWorking,
  };
}

module.exports = { createWorkers, transition, holdsGround, END_OF_LIFE, TRANSITIONS };
