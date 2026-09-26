// What the config sections and the ⚡ columns share: a list read from the
// server and painted, cards of captioned facts, and the buttons on them.
//
// The views that say WHAT a card shows live in panelviews.js and touch no DOM;
// this file is the one place that turns a view into elements.

/**
 * One list section's read-and-paint cycle, written once.
 *   load()  reads the server and keeps the answer (the caller owns it)
 *   paint() paints from the kept answer
 *   fail(err, hadAnswer) says a failed read; hadAnswer = an earlier read landed
 *   live    every render asks the server (the ⚡ screen: the board event is its
 *           only nudge). Otherwise only `reload` asks, and the renders between
 *           repaint the kept answer — a config tab costs nothing per board event.
 * Returns render(reload).
 */
export function listSection({ load, paint, fail, live = false }) {
  let loaded = false, loading = false, stale = false;
  return async function render(reload) {
    if (reload && !live) loaded = false;
    if (loaded && !live) return paint();
    // The read in flight answers every asker — unless one wants a fresher answer
    // than it will bring, and then it goes round once more.
    if (loading) { if (live || reload) stale = true; return; }
    loading = true;
    try {
      do { stale = false; await load(); } while (stale);
    } catch (e) {
      // a list still true on screen is not blanked by a failed re-read
      fail(e, loaded);
      return;
    } finally { loading = false; }
    loaded = true;
    paint();
  };
}

/** Stable sort by rank (lower first): red rises, and nothing else moves under a finger. */
export function rankSort(items, rank) {
  return items.map((x, i) => [x, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([x]) => x);
}

/** {total, bad} — what the ⚡ masthead counts. */
export function tally(items, isBad) {
  const list = items || [];
  return { total: list.length, bad: list.filter(isBad).length };
}

/**
 * The one button builder. {label, title, cls = 'au-act', disabled, aria}.
 * A title of '' is set, not skipped: it stops a parent's title showing here.
 */
export function button({ label, title, cls, disabled, aria }, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls || 'au-act';
  b.textContent = label;
  if (title != null) b.title = title;
  if (aria) b.setAttribute('aria-label', aria);
  b.disabled = !!disabled;
  b.onclick = onClick;
  return b;
}

/**
 * Paint one card from a view (panelviews.js):
 *   {kind, name, title, cls, focus, lead, chips[], actions[], note, facts[], problem, headKey, headTitle}
 * `kind` prefixes the class names (hk-row, hk-head, hk-name, hk-acts).
 * A fact is {cap, text, cls} or {cap, bits[]}. A bit (chip, action, fact bit)
 * with a `key` is a button, and pressing it calls on(bit, view).
 */
export function factCard(v, on) {
  const row = el('div', v.kind + '-row' + (v.cls ? ' ' + v.cls : '') + (v.focus ? ' au-focus' : ''));
  const head = el('div', v.kind + '-head');
  if (v.headKey) {
    head.title = v.headTitle || '';
    head.onclick = () => on({ key: v.headKey }, v);
  }
  if (v.lead) head.append(el('span', 'au-caret', v.lead));
  const name = el('span', v.kind + '-name', v.name);
  if (v.title) name.title = v.title;
  head.append(name, ...(v.chips || []).map((b) => bit(b, v, on)));
  if (v.actions && v.actions.length) {
    const acts = el('span', v.kind + '-acts');
    acts.onclick = (e) => e.stopPropagation(); // …and neither is a press on a disabled one
    acts.append(...v.actions.map((a) => bit(a, v, on)));
    head.append(acts);
  }
  row.append(head);
  if (v.note) row.append(el('div', 'ss-note ' + v.kind + '-note', v.note));
  if (v.facts && v.facts.length) {
    const box = el('div', 'facts');
    for (const f of v.facts) {
      const val = el('div', 'fact-val' + (f.cls ? ' ' + f.cls : ''), f.bits ? '' : f.text);
      if (f.bits) val.append(...f.bits.map((b) => bit(b, v, on)));
      const fact = el('div', 'fact');
      fact.append(el('div', 'fact-cap', f.cap), val);
      box.append(fact);
    }
    row.append(box);
  }
  // in full, never a title and never cut: the whole sentence is the useful part
  if (v.problem) row.append(el('div', 'card-problem', '⚠ ' + v.problem));
  return row;
}

/**
 * Repaint a list of fact cards, or `emptyText` when there are none, and scroll
 * the one marked `focus` into view. Returns whether a focused card was painted.
 */
export function paintCards(listEl, views, on, emptyText) {
  listEl.textContent = '';
  let marked = null;
  for (const v of views) {
    const card = factCard(v, on);
    if (v.focus) marked = card;
    listEl.append(card);
  }
  if (!views.length && emptyText) listEl.append(el('div', 'au-empty', emptyText));
  if (marked) marked.scrollIntoView({ block: 'nearest' });
  return !!marked;
}

function bit(b, v, on) {
  if (!b.key) {
    const s = el('span', b.cls || '', b.label);
    if (b.title) s.title = b.title;
    return s;
  }
  // a press here is not a press on the head row it sits in
  const btn = button({ ...b, title: b.tip ? '' : b.title }, (e) => { e.stopPropagation(); on(b, v); });
  if (!b.tip) return btn;
  // Our hint, not the browser's: a native title is drawn at the pointer, which
  // would cover the card's name. The wrapper carries it because the pill clips.
  const wrap = el('span', 'tip-wrap');
  wrap.setAttribute('data-tip', b.tip);
  wrap.append(btn);
  return wrap;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}
