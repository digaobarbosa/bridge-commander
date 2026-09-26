'use strict';
// feedtext — what a drained QueueItem says to the lieutenant reading it: a
// one-line `head` and a next-action `hint`, one row per kind.
//
// The hints state lifecycle facts (the handoff kills the worker, a merged PR
// is already archived), so they live on the server beside the code that makes
// them true. /api/feed renders them at drain time, against the card as it
// stands now; `bc-axi drain` only prints them. Node built-ins only.

/**
 * @typedef {object} Ctx
 * @property {(id: string) => string} bit  `card <id> "<title>" [<column>]`
 * @property {(id: string) => object|null} card  the live card, or null
 */

// A kind's row: (item, ctx) -> {head, hint?}. A kind with no row reads as its
// own name plus the card it concerns, with no hint.
const KINDS = {
  message(it, { bit }) {
    const cm = /^card:(.+)$/.exec(it.target || '');
    const reply = it.target || 'lieutenant:' + it.lieutenant;
    if (cm) {
      return { head: 'captain message on ' + bit(cm[1]),
        hint: 'reply on the thread: bc-axi say ' + it.target + ' --text-file <f|->' };
    }
    // The channel is in the ENVELOPE — his text is untouched, so a reply read
    // back to him never contains our plumbing.
    if (it.via === 'line') {
      return { head: 'captain message (over the line)',
        hint: 'he is listening with the SCREEN OFF — this will be heard, not read: answer in a couple of '
          + 'spoken sentences, no links or diffs unless he asked. Reply: bc-axi say ' + reply + ' --text-file <f|->' };
    }
    return { head: 'captain message (your main chat)', hint: 'reply: bc-axi say ' + reply + ' --text-file <f|->' };
  },
  'peer-message': (it) => ({
    head: 'message from ' + (it.author || 'a fellow lieutenant') + ' (your main chat)',
    hint: 'a colleague wrote in your chat — act on it; reply in THEIR chat: bc-axi say lieutenant:<their-id> --text-file <f|->',
  }),
  'line-passed': (it) => ({
    head: 'YOU ARE ON THE LINE — passed by ' + (it.from || 'user'),
    hint: 'greet him in ONE spoken line before anything else (bc-axi say lieutenant:' + it.lieutenant
      + ' --text-file -) — the screen is off and the voice changing is how he knows the handoff took; '
      + 'then do what the note asks',
  }),
  'start-order': (it, { bit }) => ({
    head: 'START ORDER — ' + bit(it.card),
    hint: 'the captain ordered this card started: read it (bc-axi card show ' + it.card + '), brief the worker, then: bc-axi card start ' + it.card + ' [--brief-file <f>]',
  }),
  'rework-order': (it, { bit }) => ({
    head: 'REWORK ORDER — ' + bit(it.card),
    hint: 'the captain sent this back: the handoff that put it in review ended that worker, so rework is a FRESH one with an updated brief (bc-axi card start ' + it.card + ' --brief-file <f>) — only a keep_worktree playbook still has a live session to steer; when reworked, rewrite the body and hand off: bc-axi card move ' + it.card + ' review',
  }),
  'worker-signal': (it, { bit }) => ({
    head: 'worker milestone — ' + bit(it.card),
    hint: 'note it; act only if it changes your plan',
  }),
  'worker-said': (it, { bit }) => ({
    head: 'worker said — ' + bit(it.card),
    hint: 'read the thread (bc-axi thread card:' + it.card + ') and act; steer the worker: bc-axi worker send ' + it.card + ' --text-file <f|->',
  }),
  'worker-done': (it, { bit }) => ({
    head: 'WORKER DONE — ' + bit(it.card),
    hint: 'verify the work in its worktree (read the diff/branch, not just the outcome text) and ask the worker whatever you still want to ask (bc-axi worker send ' + it.card + ' --text-file <f|->) — the handoff KILLS that session and releases the worktree, so do both first; rewrite the card body to current state (bc-axi card patch ' + it.card + ' --body-file <f|->), then hand off: bc-axi card move ' + it.card + ' review',
  }),
  'worker-stopped': (it, { bit, card }) => ({
    head: 'WORKER STOPPED — ' + bit(it.card),
    hint: 'worker stopped without reporting — peek its session (tmux attach -t ' + sessionOf(card(it.card)) + ') or steer it, then act',
  }),
  'worker-stalled': (it, { bit, card }) => ({
    head: 'WORKER STALLED — ' + bit(it.card),
    hint: 'worker alive but silent — it may be hung: peek its session (tmux attach -t ' + sessionOf(card(it.card)) + '), steer it (bc-axi worker send ' + it.card + ' --text-file <f|->), or pause and resume later (bc-axi worker pause ' + it.card + ' [--park]); then narrate what you found on the card timeline (bc-axi event ' + it.card + ' --level 2 --text-file -) — a legit long wait is fine, a SILENT one is not',
  }),
  'worker-died': (it, { bit }) => ({
    head: 'WORKER DIED — ' + bit(it.card),
    hint: 'the worker session died without done: resume it (bc-axi card start ' + it.card + ' --resume) or park the card back to backlog (bc-axi card park ' + it.card + ')',
  }),
  'pr-merged': (it, { bit }) => ({
    head: 'PR MERGED — ' + bit(it.card),
    hint: 'the server archived the card and released the worktree; nothing to do beyond noting it',
  }),
  'pr-closed': (it, { bit }) => ({
    head: 'PR CLOSED (unmerged) — ' + bit(it.card),
    hint: 'decide: rework and reopen, or archive the card (killed)',
  }),
  'card-created': (it, { bit }) => ({
    head: 'new card for you — ' + bit(it.card),
    hint: 'read it: bc-axi card show ' + it.card,
  }),
  'schedule-failed': (it) => ({
    head: 'SCHEDULE ' + (it.schedule || '?') + ' — a firing failed',
    hint: 'the board\'s clock ran a hook for you and it did not come back clean: read the output above, '
      + 'then look at the schedule (bc-axi schedule show ' + (it.schedule || '<name>') + ') and the hook it fires. '
      + 'Fix the hook, or pause the schedule (bc-axi schedule pause ' + (it.schedule || '<name>') + ') so it stops '
      + 'waking you while you do',
  }),
  schedule: (it) => ({
    head: 'SCHEDULE ' + (it.schedule || '?') + ' — healthy again',
    hint: 'whatever stopped this schedule is gone and the clock is firing it again; '
      + 'nothing to do beyond noting it (bc-axi schedule show ' + (it.schedule || '<name>') + ')',
  }),
  'card-event': (it, { bit }) => ({
    head: 'CARD EVENT' + (it.eventKind ? ' [' + it.eventKind + ']' : '') + ' — ' + bit(it.card),
    hint: 'an outside process (a workflow, a cron, a CI hook) put this on the timeline and woke you: read the text and act',
  }),
  'card-moved': (it, { bit }) => ({ head: 'captain moved ' + bit(it.card) + ': ' + it.from + ' -> ' + it.to }),
};

function sessionOf(card) {
  return (card && card.attributes && card.attributes.session) || '<session>';
}

/**
 * describe(item, findCard) -> {head, hint} for one QueueItem. `hint` is ''
 * when the kind has nothing to suggest.
 * @param {object} it a QueueItem
 * @param {(id: string) => object|undefined} findCard the live board's lookup
 */
function describe(it, findCard) {
  const card = (id) => findCard(id) || null;
  const bit = (id) => {
    const c = card(id);
    return 'card ' + id + (c ? ' "' + c.title + '" [' + c.column + ']' : ' (not on the board — archived?)');
  };
  const row = KINDS[it.kind];
  const r = row ? row(it, { bit, card }) : { head: it.kind + (it.card ? ' — ' + bit(it.card) : '') };
  // Who woke you, when the caller said. It rides on the envelope, so the text
  // stays exactly what they wrote.
  const head = r.head + (it.source ? '  (from ' + it.source + ')' : '');
  return { head, hint: r.hint || '' };
}

module.exports = { describe, KINDS };
