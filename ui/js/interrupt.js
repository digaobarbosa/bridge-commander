// interrupt — which agent a ⏹ (or Esc in the composer) stops, and when Esc
// means "stop" at all. Pure and DOM-free, so node tests import it directly.
//
// The server marks each lieutenant and worker `busy` (the board typed into it
// and no turn-end or interrupt came after) and `canInterrupt` (its harness has
// the verb). A card thread stops the card's live WORKER, not the lieutenant
// the thread talks to: the worker is the one running on it.

/**
 * interruptTarget(target, doc) -> { kind: 'cards'|'lieutenants', id } | null —
 * the agent this conversation can stop right now. null hides the ⏹.
 */
export function interruptTarget(target, doc) {
  const m = /^(card|lieutenant):(.+)$/.exec(target || '');
  if (!m || !doc) return null;
  if (m[1] === 'lieutenant') {
    const l = (doc.lieutenants || []).find((x) => x && x.id === m[2]);
    return l && l.busy && l.canInterrupt ? { kind: 'lieutenants', id: l.id } : null;
  }
  const c = (doc.cards || []).find((x) => x && x.id === m[2]);
  if (!c || c.column !== 'working') return null;
  const w = (doc.workers || []).find((x) => x && x.card === c.id);
  return w && w.busy && w.canInterrupt ? { kind: 'cards', id: c.id } : null;
}

/**
 * escInterrupts({ value, attachments, menuOpen, target, doc }) -> the agent to
 * stop, or null when Esc keeps its old meaning. Esc stops only from an EMPTY
 * composer with no menu open: with text, Esc belongs to editing; with a menu,
 * it closes the menu.
 */
export function escInterrupts({ value, attachments, menuOpen, target, doc }) {
  if (menuOpen || String(value || '').trim() || attachments) return null;
  return interruptTarget(target, doc);
}
