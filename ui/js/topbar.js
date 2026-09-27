// topbar — the topbar/v1 slot: plugin command buttons in the header, before the
// status dot. A topbar command never has a card, so each entry's `when` is
// asked of the empty context and the run is card-less (commandui.js): a link
// opens its url, anything else posts with no card. The server allows that only
// for commands placed in a card-less slot, so a stale page cannot use the
// topbar to run a card command without its card.
//
// The header is one row, on a phone too: each plugin gets at most
// TOPBAR_PER_PLUGIN buttons, and the stylesheet hides the labels below 760px.
import { entries, hasEntries } from './slots.js';
import { EMPTY_CONTEXT } from './cardview.js';
import { runCommand, isBusy } from './commandui.js';
import { esc, setHtmlIfChanged } from './util.js';

export const TOPBAR_SLOT = 'topbar/v1';
export const TOPBAR_PER_PLUGIN = 4;

/** The topbar entries on show, in rank order. */
export function topbarEntries() {
  if (!hasEntries(TOPBAR_SLOT)) return [];
  return entries(TOPBAR_SLOT, EMPTY_CONTEXT, { limitPerPlugin: TOPBAR_PER_PLUGIN });
}

/** The buttons as markup: the icon, the title as a label and a tooltip. Pure. */
export function topbarHtml(list, busy = isBusy) {
  return list.map((e) => {
    const b = busy(e.command, '');
    const tip = e.title + (e.plugin ? ' · ' + e.plugin : '');
    return '<button type="button" class="tb-cmd' + (b ? ' busy' : '') + '" data-cmd="' + esc(e.command) + '"' +
      ' title="' + esc(tip) + '" aria-label="' + esc(e.title) + '"' + (b ? ' disabled' : '') + '>' +
      '<span class="tb-icon">' + esc(e.icon || '▸') + '</span><span class="tb-label">' + esc(e.title) + '</span></button>';
  }).join('');
}

let el = null;
/** Hand over the header span the buttons live in. */
export function initTopbar({ el: host }) {
  el = host;
  el.addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-cmd]');
    if (b && !b.disabled) runCommand(b.dataset.cmd, null);
  });
}

/** Paint the buttons; the span is hidden while there are none. */
export function renderTopbar() {
  if (!el) return;
  const html = topbarHtml(topbarEntries());
  setHtmlIfChanged(el, html);
  el.hidden = !html;
}
