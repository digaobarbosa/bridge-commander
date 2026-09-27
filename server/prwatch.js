'use strict';
// prwatch — F6: a merged PR archives its card and releases the worktree with no
// agent turn. Lifted out of server.js so the board is reached only through the
// deps below, which is what lets a `github` plugin own it later.
//
// For every card whose `prs` attribute holds an open URL, ask gh.
// MERGED -> a pr-merged event + owner item per PR that landed; then, ONLY when
// no PR of the card is left open (a stack merges one at a time), release the
// worktree (only when clean — uncommitted work is never discarded) and archive
// the card (reason merged: the landed level-1 event). CLOSED (unmerged) -> mark
// the state and tell the owner; the card stays. gh failures leave state untouched.
//
// Node built-ins only.
const childProcess = require('child_process');

/** ghPrState(url) for a gh binary: {state, mergedAt} or null on any failure. */
function ghPrStateFor(ghCmd, execFile = childProcess.execFile) {
  return (url) => new Promise((resolve) => {
    execFile(ghCmd, ['pr', 'view', url, '--json', 'state,mergedAt'], { timeout: 30000 }, (err, stdout) => {
      if (err) return resolve(null);
      try { resolve(JSON.parse(stdout)); } catch (e) { resolve(null); }
    });
  });
}

/**
 * createPrWatch(deps) -> { tick }
 *   cards()                     the board's live card list
 *   prState(url)                -> {state} | null (default: gh via `ghCmd`)
 *   ghCmd                       the gh binary when prState is not given (BC_GH_CMD)
 *   cardEvent(card, ev, opts)   store.cardEvent
 *   queuePush(owner, item)      an owner queue item
 *   endWorker(card, trigger)    workers.end -> {release?}
 *   archiveCard(card, body)     the archive verb
 *   commit()                    persist the board and broadcast it
 * The overlap guard and the catch belong to watchers.js, not here.
 */
function createPrWatch({
  cards, prState, ghCmd = 'gh', cardEvent, queuePush, endWorker, archiveCard, commit,
}) {
  const stateOf = prState || ghPrStateFor(ghCmd);

  async function tick() {
    for (const card of [...cards()]) {
      const prs = card.attributes && card.attributes.prs;
      if (!Array.isArray(prs) || !prs.some((p) => p && p.state === 'open' && p.url)) continue;
      const merged = []; // every PR of this card that landed in THIS tick
      let changed = false;
      for (const pr of prs) {
        if (!pr || pr.state !== 'open' || !pr.url) continue;
        const st = await stateOf(pr.url);
        if (!st || !st.state) continue;
        if (st.state === 'MERGED') { pr.state = 'merged'; merged.push(pr); changed = true; }
        else if (st.state === 'CLOSED') {
          pr.state = 'closed';
          changed = true;
          cardEvent(card, { text: 'PR closed without merge: ' + pr.url, actor: 'server', level: 2 });
          queuePush(card.owner, { kind: 'pr-closed', card: card.id, text: pr.url });
        }
      }
      if (!changed) continue;
      // one signal per PR that landed — a stack can flip several between polls
      for (const pr of merged) {
        cardEvent(card, { text: 'PR merged: ' + pr.url, actor: 'server' }, { kind: 'pr-merged' });
        queuePush(card.owner, { kind: 'pr-merged', card: card.id, text: pr.url });
      }
      // a stack card only finishes when nothing is left open: a partial merge
      // keeps the card on the board, the worktree alive and the hooks unfired.
      const anyOpenLeft = prs.some((p) => p && p.state === 'open');
      if (merged.length && !anyOpenLeft) {
        // Ended BEFORE the archive, awaited: the release's refusal must ride the
        // archive note, the one place a merged card's refusal stays readable.
        const out = await endWorker(card, 'merge');
        let note = merged.map((p) => p.url).join(' ');
        if (out.release && !out.release.released) note += ' (worktree NOT released: ' + out.release.reason + ')';
        // archiveCard stamps the worker's address: a record the kill could not
        // verify is kept, and the snapshot still names its run.
        archiveCard(card, { reason: 'merged', note, actor: 'server' }); // landed — the level-1 bell
      }
      commit();
    }
  }

  return { tick };
}

module.exports = { createPrWatch, ghPrStateFor };
