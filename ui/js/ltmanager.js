// The config screen's lieutenants section: who is on this board, and the facts
// about each one that nowhere else shows.
//
// Three of them are invisible today. The card PREFIX and the NEXT number it
// would mint — the id of the card he is about to create, before he creates it.
// The count of live cards it owns. And whether its SESSION is up: a lieutenant
// whose agent died still sits on the board looking exactly like a working one,
// so this row is the only place the difference reads.
//
// Both actions reuse what already exists — ⚙ is the switcher's own settings
// modal (name, colour, avatar, voice), ✎ opens the charter on the file screen,
// the same editor a playbook opens in. Retiring is deliberately absent: the
// switcher's ⋯ menu already has it, and a second door onto the one destructive
// verb is how it gets opened by accident.
import { api } from './api.js';
import { lieutenantColor } from './state.js';
import { avatarHtml, validAvatar } from './avatars.js';
import { openLtSettings } from './ltswitcher.js';
import { openArtifactFile } from './detail.js';
import { listSection, button } from './listpanel.js';
import { lieutenantView } from './panelviews.js';

let listEl;
/** Hand the section its list element: {list}. */
export function initLieutenants(els) { listEl = els.list; }

// [{id, name, color, avatar, prefix, next, cards, memory, session}] — the last
// answer from /api/lieutenants?live=1, in the order the board holds them.
let items = null;

// `reload` is what the tab passes on the way in, so entering reads the session
// probes afresh while the renders that follow — one per board event — repaint
// what is already here. Opening the screen for labels asks the harness nothing.
export const renderLieutenants = listSection({
  load: async () => { items = (await api.lieutenants(true)).lieutenants || []; },
  paint,
  fail: (e) => { listEl.textContent = '⚠ ' + e.message; },
});

// One line per lieutenant, the way the playbooks tab is one line per playbook:
// face, name, id, the three facts as a single dim run, and the two actions as
// icons at the right end. Eight of them fit a phone screen.
function paint() {
  listEl.textContent = '';
  for (const l of items) {
    const v = lieutenantView(l);
    const row = document.createElement('div');
    row.className = 'lt-row';
    row.append(face(l), span('lt-name', v.name), span('lt-id', v.id), facts(v),
      actions(v, (a) => (a.key === 'settings' ? openLtSettings(l.id) : openCharter(l))));
    listEl.appendChild(row);
  }
  if (!items.length) listEl.textContent = 'no lieutenants';
}

// the avatar in its own colour, or a plain dot when it has none
function face(l) {
  const el = document.createElement('span');
  if (validAvatar(l.avatar) !== null) {
    el.className = 'lt-face';
    el.style.borderColor = lieutenantColor(l.id);
    el.innerHTML = avatarHtml(l.avatar);
  } else {
    el.className = 'lt-dot';
    el.style.background = lieutenantColor(l.id);
  }
  return el;
}

function span(cls, text) {
  const el = document.createElement('span');
  el.className = cls;
  el.textContent = text;
  return el;
}

// Separators, not labels: the section heading says what these are once. The
// session keeps a colour of its own, because a dead one is what the eye lands on.
function facts(v) {
  const el = span('lt-facts', v.facts);
  el.title = 'next card id · live cards it owns · session';
  const sess = span(v.session.cls, v.session.text);
  sess.title = v.session.title;
  el.append(sess);
  return el;
}

function actions(v, on) {
  const el = document.createElement('span');
  el.className = 'lt-acts';
  el.append(...v.actions.map((a) => button(a, () => on(a))));
  return el;
}

// The charter is a file, so editing it is the file screen — the same 💾, the
// same version check, the same 409 as a playbook or a card artifact. A
// lieutenant that never wrote one opens on the empty document (the board answers
// version '' for it), and the first save creates the file.
async function openCharter(l) {
  try {
    await openArtifactFile('file://' + l.memory, (l.name || l.id) + ' — README.md');
  } catch (e) {
    listEl.textContent = '⚠ cannot open the charter of ' + l.id + ' — ' + e.message;
  }
}
