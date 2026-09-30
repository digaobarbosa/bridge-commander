// board: dense card tiles, drag&drop, long-press move menu, new-card /
// new-lieutenant modals. (Lieutenant switching lives in the chat header —
// ltswitcher.js — not on the board.)
import { S, columns, cards, lieutenants, lieutenant, lieutenantColor, cardVisible, cardRecency, byRecency, toggleFilter, filterSelected, render } from './state.js';
import { api } from './api.js';
import { esc, agoSpanHtml, cardNumHtml, cardPrs, prChipHtml, ctxBarHtml } from './util.js';
import { cardFacts, cornerHtml, orderHtml, WORKER_LABEL } from './cardview.js';
import { labelChipHtml } from './labels.js';
import { openDetail } from './detail.js';
import { openLieutenantChat } from './chat.js';
import { openCardSession } from './pane.js';
import { cardSessions } from './terminal.js';
import { avatarGridHtml, wireAvatarGrid } from './avatars.js';
import { selectionOn, isSelected, pick } from './selection.js';
import { openCardMenu, moveCard, pluginBadgesHtml, activityChipHtml, tileActionsHtml } from './cardactions.js';
import { runCommand } from './commandui.js';
import { openActivity } from './activities.js';
import { fillHarnessOptions, defaultHarness } from './plugins.js';

const boardEl = document.getElementById('board');

// ---------- tiles ----------
// Every fact on a tile comes from cardFacts (cardview.js), the same model the
// table row and the detail panel draw from, so the surfaces cannot drift.
function tileHtml(c) {
  const f = cardFacts(c, S.doc, Date.now());
  const session = cardSessions(c)[0];
  const sessionTitle = 'open or resume session' + (session ? ' · ' + session.provider + ' · ' + session.host : '');
  const at = c.attributes || {};
  const repo = at.repo || '';
  const msgs = f.messageCount;
  // the corner: owed (the chat typing bubble's source) beats the unread dot
  const cornerInd = cornerHtml(f);
  const hasLink = Object.entries(at).some(([k, v]) => /^https?:\/\//.test(String(v)));
  const labels = (c.labels || []).map((n) => labelChipHtml(n, filterSelected('label', n))).join('');
  // PR chips: attributes.prs [{url, state}] — one state-colored chip per entry
  const prs = cardPrs(c).map((pr) => prChipHtml(pr)).join('');
  // a worker on this card is blocked on a permission prompt: the loudest chip,
  // first in the row, because nothing moves on the card until the captain answers
  const nPerm = f.needsApproval;
  const perm = nPerm
    ? '<span class="t-perm" title="' + nPerm + ' permission request' + (nPerm > 1 ? 's' : '') + ' waiting for you">🔐 needs approval' + (nPerm > 1 ? ' ×' + nPerm : '') + '</span>'
    : '';
  const order = orderHtml(f, 'chip', c.owner);
  // plugin data only — badges and the running-activity chip are markup built
  // from the card and the manifests; no plugin code runs per tile
  const ext = pluginBadgesHtml(c, S.doc) + activityChipHtml(c, S.doc);
  // worker-state stripe on the tile's RIGHT edge — a PERSISTENT status signal,
  // deliberately separate from the transient top-right corner (the LEFT edge is
  // the owner's color). workerState is whitelisted in cardview, so no server
  // value reaches the class name. working=green pulsing, needs-you=amber, idle=gray.
  const worker = f.workerState === 'absent' ? '' : f.workerState;
  const workerCls = worker ? ' worker worker-' + worker : '';
  const workerTitle = worker
    ? ' title="worker: ' + esc(WORKER_LABEL[worker]) + (f.workerId ? ' — ' + esc(f.workerId) : '') + '"'
    : '';
  // owner color stripe on the LEFT edge: every card belongs to exactly one lieutenant
  const stripe = '<span class="t-stripe" style="background:' + esc(lieutenantColor(c.owner)) + '"></span>';
  // selection mode only: the checkbox and the selected state. Off = the tile is
  // exactly what it always was, and dragging still belongs to drag&drop.
  const sel = selectionOn();
  const box = sel
    ? '<input class="t-sel" type="checkbox" tabindex="-1" aria-label="select card"' + (isSelected(c.id) ? ' checked' : '') + '>'
    : '';
  return '<div class="tile' + (c.id === S.openCardId ? ' open' : '') + (sel && isSelected(c.id) ? ' sel' : '') + workerCls + (nPerm ? ' needs-perm' : '') +
    '" draggable="' + (sel ? 'false' : 'true') + '" data-id="' + esc(c.id) + '"' + workerTitle + '>' +
    stripe +
    '<div class="t-row1">' + box + '<span class="t-emoji">' + esc(f.emoji) + '</span>' +
    '<span class="t-title">' + esc(c.title || c.id) + '</span>' +
    cardNumHtml(c.id) + cornerInd + '</div>' +
    (perm || labels || prs || order || ext ? '<div class="t-chips">' + perm + order + ext + labels + prs + '</div>' : '') +
    '<div class="t-foot">' +
    '<span class="t-owner' + (filterSelected('owner', c.owner) ? ' active' : '') + '" data-owner="' + esc(c.owner) +
      '" title="click: filter by lieutenant · alt-click: exclude"><span class="dot" style="background:' + esc(lieutenantColor(c.owner)) + '"></span>' + esc(f.ownerName) + '</span>' +
    (repo ? '<span class="t-repo" title="repo">' + esc(repo) + '</span>' : '') +
    '<span class="grow"></span>' +
    (hasLink ? '<span class="t-ind" title="has link">📎</span>' : '') +
    (msgs ? '<span class="t-ind" title="' + msgs + ' messages">💬' + msgs + '</span>' : '') +
    // The conversation stays reachable after its worker leaves Working.
    (f.inWorking ? ctxBarHtml(f.agentStatus) : '') +
    (f.inWorking || session ? '<button class="t-peek" title="' + esc(sessionTitle) + '">👁</button>' : '') +
    tileActionsHtml(c, S.doc) +
    agoSpanHtml(cardRecency(c), 't-ago') +
    '</div></div>';
}

// the visible cards in the order the board draws them — what a shift-click
// range runs over
function boardOrder() {
  return columns().flatMap((col) =>
    cards().filter((c) => c.column === col.id && cardVisible(c)).sort(byRecency).map((c) => c.id));
}

export function renderBoard() {
  const cols = columns();
  boardEl.classList.toggle('selecting', selectionOn()); // outside the html cache
  const html = !cols.length
    ? '<div class="empty">waiting for board…</div>'
    : cols.map((col) => {
      const list = cards().filter((c) => c.column === col.id && cardVisible(c)).sort(byRecency);
      return '<div class="column" data-id="' + esc(col.id) + '"><h2><span>' + esc(col.title || col.id) + '</span>' +
        '<span class="count">' + list.length + '</span>' +
        '<button class="add-card" title="new card here">+</button></h2>' +
        '<div class="cards">' + list.map(tileHtml).join('') + '</div></div>';
    }).join('');
  // unchanged markup = leave the DOM (and scroll/selection/handlers) alone;
  // only a real change pays the rebuild + scroll save/restore
  if (boardEl.__bcHtml === html) return;
  boardEl.__bcHtml = html;
  const sx = boardEl.scrollLeft;
  const colScroll = {};
  boardEl.querySelectorAll('.column').forEach((col) => {
    colScroll[col.dataset.id] = col.querySelector('.cards').scrollTop;
  });
  boardEl.innerHTML = html;
  if (!cols.length) return;
  boardEl.scrollLeft = sx;
  boardEl.querySelectorAll('.column').forEach((col) => {
    if (colScroll[col.dataset.id] != null) col.querySelector('.cards').scrollTop = colScroll[col.dataset.id];
  });
  wire();
}

// ---------- interactions ----------
let pressTimer = null, pressFired = false;

function wire() {
  boardEl.querySelectorAll('.tile').forEach((el) => {
    el.onclick = (e) => {
      if (pressFired) { pressFired = false; return; } // long-press already handled
      // in selection mode the whole tile is the checkbox — nothing else on it
      // does its usual thing: a label click would filter, and a PR chip is an
      // <a> that would open GitHub, so the anchor's own navigation is cancelled
      // too (shift-clicking a run of cards must not also open six tabs)
      if (selectionOn()) {
        e.preventDefault();
        pick(el.dataset.id, e.shiftKey, boardOrder());
        render();
        return;
      }
      const t = e.target;
      if (t.closest('a')) return; // PR chip / link: let the anchor navigate, don't open detail
      if (t.closest('.t-peek')) { openCardSession(el.dataset.id); return; }
      const cmd = t.closest('.t-cmd');
      if (cmd) { runCommand(cmd.dataset.cmd, el.dataset.id); return; }
      const act = t.closest('.t-activity');
      if (act) { openActivity(act.dataset.activity); return; }
      if (t.classList.contains('label')) { toggleFilter('label', t.dataset.label, e.altKey); return; }
      const own = t.closest('.t-owner');
      if (own) { toggleFilter('owner', own.dataset.owner, e.altKey); return; }
      openDetail(el.dataset.id);
    };
    // drag&drop (desktop)
    el.ondragstart = (e) => {
      e.dataTransfer.setData('text/bc-card', el.dataset.id);
      e.dataTransfer.effectAllowed = 'move';
      el.classList.add('dragging');
    };
    el.ondragend = () => el.classList.remove('dragging');
    // long-press (touch) -> move menu
    el.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch') return;
      pressFired = false;
      pressTimer = setTimeout(() => {
        pressFired = true;
        openMoveMenu(el.dataset.id, e.clientX, e.clientY);
      }, 480);
    });
    for (const evName of ['pointerup', 'pointercancel', 'pointermove']) {
      el.addEventListener(evName, (e) => {
        if (evName === 'pointermove' && pressTimer) return; // small moves ok until fired
        clearTimeout(pressTimer); pressTimer = null;
      });
    }
    el.oncontextmenu = (e) => { e.preventDefault(); openMoveMenu(el.dataset.id, e.clientX, e.clientY); };
  });
  boardEl.querySelectorAll('.column').forEach((col) => {
    const id = col.dataset.id;
    col.ondragover = (e) => {
      if (e.dataTransfer.types.includes('text/bc-card')) { e.preventDefault(); col.classList.add('drag-over'); }
    };
    col.ondragleave = () => col.classList.remove('drag-over');
    col.ondrop = async (e) => {
      e.preventDefault();
      col.classList.remove('drag-over');
      const cardId = e.dataTransfer.getData('text/bc-card');
      if (cardId) await moveCard(cardId, id);
    };
    col.querySelector('.add-card').onclick = (e) => { e.stopPropagation(); openNewCard(id); };
  });
}

// ---------- move / actions menu ----------
// The menu itself (moves with the order-comment rule, select, archive with its
// refusal, plugin commands) is the card command table in cardactions.js; this
// name stays for the callers that open it at a point.
export function openMoveMenu(cardId, x, y) {
  return openCardMenu(cardId, { x, y });
}

// ---------- new card modal ----------
const ncOverlay = document.getElementById('nc-overlay');
const ncType = document.getElementById('nc-type');
const ncOwner = document.getElementById('nc-owner');
const ncPlaybook = document.getElementById('nc-playbook');
let ncColumnId = ''; // the column whose "+" opened the modal — the create target

// The playbook dropdown: the workspace's playbooks/ folder. Refetched on every
// open — the folder is the captain's to edit, and a playbook added between two
// cards has to be pickable on the second. The empty option stays selectable: a
// card may be born without a playbook and get one later, but it will not start
// until it does, which is what the hint says.
export async function fillPlaybookOptions(select, selected) {
  select.textContent = '';
  const none = document.createElement('option');
  none.value = '';
  none.textContent = '— playbook (needed to start)';
  select.appendChild(none);
  let ids = [];
  try { ids = (await api.playbooks()).playbooks || []; } catch (e) { ids = []; }
  // a card pointing at a playbook that has since been renamed away still shows
  // its own value rather than silently reading as "no playbook"
  if (selected && !ids.includes(selected)) ids = [selected, ...ids];
  for (const id of ids) {
    const o = document.createElement('option');
    o.value = id;
    o.textContent = id;
    select.appendChild(o);
  }
  select.value = selected || '';
  return ids;
}
export function openNewCard(columnId) {
  if (!lieutenants().length) { openNewLieutenant(); return; } // a card needs an owner
  ncColumnId = columnId || 'backlog';
  ncType.value = 'implementation';
  ncOwner.textContent = '';
  for (const l of lieutenants()) {
    const o = document.createElement('option');
    o.value = l.id;
    o.textContent = l.name || l.id;
    ncOwner.appendChild(o);
  }
  // default owner: the lieutenant whose chat is open, else the first
  if (S.chatMode) {
    const cur = S.chatMode.mode === 'lieutenant' ? S.chatMode.id : (cards().find((c) => c.id === S.chatMode.id) || {}).owner;
    if (cur && lieutenant(cur)) ncOwner.value = cur;
  }
  document.getElementById('nc-name').value = '';
  document.getElementById('nc-body').value = '';
  // async: the modal opens now, the options land a tick later. `default` is
  // preselected only when it actually exists — offering an id the server would
  // reject is worse than offering none.
  fillPlaybookOptions(ncPlaybook, '').then((ids) => {
    if (!ncPlaybook.value && ids.includes('default')) ncPlaybook.value = 'default';
  });
  ncOverlay.hidden = false;
  document.getElementById('nc-name').focus();
}
export function closeNewCard() { ncOverlay.hidden = true; }
export function newCardOpen() { return !ncOverlay.hidden; }
document.getElementById('nc-cancel').onclick = closeNewCard;
ncOverlay.onclick = (e) => { if (e.target === ncOverlay) closeNewCard(); };
document.getElementById('nc-modal').onsubmit = async (e) => {
  e.preventDefault();
  const title = document.getElementById('nc-name').value.trim();
  if (!title) return;
  const body = document.getElementById('nc-body').value;
  // What a card starts on is the PLAYBOOK's business (its frontmatter), so the
  // modal picks a playbook and nothing else about the harness.
  try {
    const r = await api.createCard(
      { title, column: ncColumnId, body, type: ncType.value, owner: ncOwner.value, playbook: ncPlaybook.value });
    closeNewCard();
    openDetail(r.card.id);
  } catch (err) { alert(err.message); }
};

// ---------- new lieutenant modal ----------
const ltOverlay = document.getElementById('lt-overlay');
const ltAvatarGrid = document.getElementById('lt-avatar-grid');
let ltAvatarPick = null; // null = no avatar (the "none" cell), "none" allowed
export function openNewLieutenant() {
  document.getElementById('lt-name').value = '';
  // the harnesses the server lists (GET /api/plugins), the built-in pair otherwise
  fillHarnessOptions(document.getElementById('lt-harness'), defaultHarness());
  ltAvatarPick = null;
  ltAvatarGrid.innerHTML = avatarGridHtml(ltAvatarPick);
  wireAvatarGrid(ltAvatarGrid, (idx) => { ltAvatarPick = idx; });
  ltOverlay.hidden = false;
  document.getElementById('lt-name').focus();
}
export function closeNewLieutenant() { ltOverlay.hidden = true; }
export function newLieutenantOpen() { return !ltOverlay.hidden; }
document.getElementById('lt-cancel').onclick = closeNewLieutenant;
ltOverlay.onclick = (e) => { if (e.target === ltOverlay) closeNewLieutenant(); };
document.getElementById('lt-modal').onsubmit = async (e) => {
  e.preventDefault();
  const name = document.getElementById('lt-name').value.trim();
  if (!name) return;
  // This modal births a REAL lieutenant: the server spawns its agent
  // session (doctrine + its memory file as launch prompt) and persists the ref. Slow
  // (up to a minute) — keep the modal up, button disabled, until it lands.
  const btn = document.getElementById('lt-create');
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = 'spawning…';
  try {
    const r = await api.createLieutenant({
      name,
      avatar: ltAvatarPick,
      color: document.getElementById('lt-color').value,
      harness: document.getElementById('lt-harness').value || defaultHarness(),
      spawn: true,
    });
    closeNewLieutenant();
    openLieutenantChat(r.lieutenant.id);
  } catch (err) { alert(err.message); }
  finally { btn.disabled = false; btn.textContent = label; }
};
