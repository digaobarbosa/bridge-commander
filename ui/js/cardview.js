// cardview — the card view model. Every surface that shows a card (the tile,
// the table row, the archive row, the detail panel, the bulk bar) asks THIS
// module what is true about it, so no two surfaces can disagree about whether
// a card owes a reply, has a worker, or may be archived.
//
// Pure and DOM-free: everything comes from (card, doc, nowMs), so node tests
// import it directly and plugins' `when` predicates read the same context.
import { cardStatus, cardOwedState, owedStale } from './state.js';
import { esc, cardEmoji, cardPrs, owedIndHtml } from './util.js';
import { cardPermissions } from './perms.js';

// The lease states that mean something on screen. A whitelist, so no server
// value ever reaches a class name.
export const WORKER_LABEL = { working: 'Working', 'needs-you': 'Needs you', idle: 'Idle' };

function workerRecord(doc, cardId) {
  return ((doc && doc.workers) || []).find((w) => w && w.card === cardId) || null;
}
function leaseState(card) {
  const w = cardStatus(card).worker;
  return w && WORKER_LABEL[w.state] ? w.state : 'absent';
}
function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}
function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

/**
 * The context of a card-less command (the topbar, the palette with no card
 * open). The same shape with nothing in it, so a `when` or a template that
 * needs a card reads "missing" rather than throwing — here and on the server.
 */
export const EMPTY_CONTEXT = deepFreeze({ card: null, project: null, worker: null, harness: null });

// Same card object + same doc = same context: `when` is asked of every card for
// every contribution on every render, and a board push brings new objects anyway.
const ctxCache = new WeakMap();

/**
 * The frozen object `when` predicates and command templates read (the shape is
 * fixed in docs/rfc/plugins-contracts.md, "Card context"). A copy, so a plugin
 * predicate can never write into the board.
 */
export function cardContext(card, doc) {
  const hit = ctxCache.get(card);
  if (hit && hit.doc === doc) return hit.ctx;
  const at = (card && card.attributes) || {};
  const rec = workerRecord(doc, card.id);
  const state = leaseState(card);
  const repo = at.repo ? String(at.repo) : '';
  const proj = repo && ((doc && doc.projects) || []).find((p) => p && p.name === repo);
  const ctx = deepFreeze({
    card: {
      id: card.id,
      title: card.title || '',
      type: card.type || '',
      owner: card.owner || '',
      column: card.column || '',
      labels: (card.labels || []).slice(),
      attributes: clone(at) || {},
      playbook: card.playbook || '',
      branch: at.branch ? String(at.branch) : '',
      worktree: at.worktree ? String(at.worktree) : '',
      repo,
      prs: clone(cardPrs(card)),
    },
    project: proj ? { name: proj.name, path: proj.path || '' } : null,
    // null = nothing about a worker is known; a record without a lease is still live
    worker: rec || state !== 'absent' ? { state, live: !!rec } : null,
    harness: (rec && rec.ref && rec.ref.harness) || null,
  });
  ctxCache.set(card, { doc, ctx });
  return ctx;
}

/**
 * Everything a surface draws about a card, derived once. `arch` is the archive
 * record when the card is a frozen snapshot: nothing about a snapshot is live
 * or editable. `nowMs` only feeds the "may be stuck" rule.
 */
export function cardFacts(card, doc, nowMs = Date.now(), arch = null) {
  const frozen = !!arch;
  const st = cardStatus(card);
  const lease = st.worker || null;
  const rec = frozen ? null : workerRecord(doc, card.id);
  const workerState = frozen ? 'absent' : leaseState(card);
  const owed = frozen ? null : cardOwedState(card);
  const inWorking = !frozen && card.column === 'working';
  // Any lease state but absent means someone is on it, whitelisted or not: a
  // refusal must not fail open on a state this UI has not heard of yet.
  const leaseBound = !frozen && !!(lease && lease.state && lease.state !== 'absent');
  const lt = ((doc && doc.lieutenants) || []).find((l) => l.id === card.owner);
  return {
    emoji: cardEmoji(card),
    ownerName: lt ? lt.name || lt.id : card.owner,
    workerState,
    workerId: workerState !== 'absent' && lease.id ? String(lease.id) : '',
    live: !!rec,
    needsApproval: frozen ? 0 : cardPermissions(doc, card.id).length,
    pendingOrder: !frozen && card.pendingOrder ? card.pendingOrder : null,
    owed,
    stale: !!owed && owedStale(card.thread, nowMs),
    queued: owed === 'queued',
    unread: !frozen && !!st.unread,
    messageCount: (card.thread || []).length,
    archiveReason: frozen ? (arch.reason === 'merged' ? 'merged' : 'killed') : null,
    archiveNote: frozen && arch.note ? String(arch.note) : '',
    canArchive: archiveVerdict(frozen, rec, leaseBound ? lease.state : ''),
    // the server refuses an owner change while ANY worker record exists (done
    // or not), so the ✎ is drawn by that rule and not by the advisory lease alone
    canEditOwner: !frozen && !rec && !leaseBound,
    // Backlog only: a started card already rendered its brief from the playbook it had
    canEditPlaybook: !frozen && card.type !== 'plan' && card.column === 'backlog',
    inWorking,
    // the worker's context bar rides Working cards only (agentStatus is turn-end fed)
    agentStatus: inWorking && rec ? rec.agentStatus || null : null,
  };
}

// Archiving kills the card's session and drops its worktree binding, so a live
// worker refuses. The registry (a record with done !== true) is the truth the
// server kills by; the lease is asked second, never alone.
function archiveVerdict(frozen, rec, leaseBoundState) {
  if (frozen) return { ok: false, reason: 'already archived' };
  if (rec && rec.done !== true) return { ok: false, reason: 'live worker' + (rec.branch ? ' on ' + rec.branch : '') };
  if (leaseBoundState) return { ok: false, reason: 'worker ' + leaseBoundState };
  return { ok: true, reason: '' };
}

// ---------- presenters: the markup every surface shares ----------

/** The saved checkpoint is plain text, including frozen archive snapshots. */
export function sessionCheckpointHtml(card) {
  const checkpoint = card && card.sessionCheckpoint;
  if (!checkpoint || typeof checkpoint !== 'object') return '';
  const value = (field) => typeof checkpoint[field] === 'string' ? checkpoint[field].trim() : '';
  const summary = value('summary'), stage = value('stage');
  const nextAction = value('nextAction'), blocker = value('blocker');
  if (!summary && !stage && !nextAction && !blocker) return '';
  return '<h3>Session checkpoint' + (stage ? '<span>' + esc(stage) + '</span>' : '') + '</h3>' +
    (summary ? '<p>' + esc(summary) + '</p>' : '') +
    (nextAction || blocker ? '<dl>' +
      (nextAction ? '<dt>Next action</dt><dd>' + esc(nextAction) + '</dd>' : '') +
      (blocker ? '<dt class="checkpoint-blocker">Blocker</dt><dd class="checkpoint-blocker">' + esc(blocker) + '</dd>' : '') +
      '</dl>' : '');
}

const CARD_OWED_TITLES = {
  stale: 'no response yet — the lieutenant may be stuck',
  queued: 'delivered — the lieutenant hasn\'t picked it up yet',
  seen: 'the lieutenant owes you a reply here',
};
/**
 * The one corner indicator: stale ⚠, queued ⏳, owed dots — the same source as
 * the chat typing bubble — and only when nothing is owed, the unread dot.
 */
export function cornerHtml(f) {
  if (f.owed) return owedIndHtml(f.owed, f.stale, CARD_OWED_TITLES);
  return f.unread ? '<span class="t-unread" title="unread activity"></span>' : '';
}

/**
 * A captain order awaiting the lieutenant. `variant`: 'chip' (tile row),
 * 'mark' (table status cell) or 'attr' (detail header). `owner` names who it
 * was sent to, for the chip's tooltip.
 */
export function orderHtml(f, variant, owner) {
  const o = f.pendingOrder;
  if (!o) return '';
  const kind = esc(o.kind);
  if (variant === 'mark') return ' <span class="t-order" title="' + kind + ' pending">⏳</span>';
  if (variant === 'attr') return '<span class="attr"><span class="k">pending</span><span class="v">⏳ ' + kind + '</span></span>';
  return '<span class="t-order" title="' + kind + ' sent to ' + esc(owner || '') + ' — the card moves when the lieutenant acts">⏳ ordered</span>';
}

/** Why a frozen card left the board: 🏁 merged or 🪦 killed, the note as tooltip. */
export function archiveReasonHtml(f) {
  const r = f.archiveReason;
  if (!r) return '';
  return '<span class="tv-rsn tv-rsn-' + r + '"' + (f.archiveNote ? ' title="' + esc(f.archiveNote) + '"' : '') + '>' +
    (r === 'merged' ? '🏁 merged' : '🪦 killed') + '</span>';
}
