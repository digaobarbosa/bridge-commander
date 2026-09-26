// boot: SSE, header controls, mobile tabs, render orchestration
import { S, onRender, render, onBoard, cards, lieutenants, cardUnread, lieutenantUnread, notifUnreadCount, owedTargets, clearFilters, filtersActive } from './state.js';
import { startLive } from './live.js';
import { refreshAgoLabels } from './util.js';
import { trackMessages } from './voice.js';
import { trackEvents, trackPermissions, renderNotifSettings } from './notifysettings.js';
import { renderPermTray } from './permtray.js';
import { docPermissions } from './perms.js';
import { onOpenCard as toastOnOpenCard, onOpenLieutenant as toastOnOpenLieutenant } from './toast.js';
import { renderBoard, newCardOpen, closeNewCard, newLieutenantOpen, closeNewLieutenant } from './board.js';
import { renderTable } from './table.js';
import { renderBulkBar } from './bulk.js';
import { selectionOn, exitSelection } from './selection.js';
import { renderArchive } from './archtable.js';
import { renderFilterUI, filterPanelOpen, closeFilterPanel } from './filterpop.js';
import { renderChat, onOpenCard as chatOnOpenCard, openCardConversation, openLieutenantChat, onQuoteSource } from './chat.js';
import { onModeSwitch, forgetFile, fileOpen, fileName, fileQuote } from './filepane.js';
import { renderLtSwitcher, ltSwitcherOpen, closeLtSwitcher, ltSettingsOpen, closeLtSettings } from './ltswitcher.js';
import { renderDetail, openDetail, closeDetail, detailOpen, auxDetailKey, closeArtifact, artifactOpen, onArtifactClose, artifactWritten } from './detail.js';
import { openPopover, closePopover, closeTopPopover } from './popover.js';
import { MODE_BTN, SCREENS, boardModeFor, switcherModeFor } from './modes.js';
import { closePane, paneOpen } from './pane.js';
import { openMonitor, closeMonitor, monitorOpen } from './monitor.js';
import { closeLog, logOpen } from './logview.js';
import { renderNotifications, onOpenCard as notifOnOpenCard } from './notify.js';
import { renderLabelManager, renderPicker, pickerIsOpen, closeLabelPicker } from './labels.js';
import { renderPlaybooks, initPlaybooks } from './pbmanager.js';
import { renderProjects, initProjects } from './projmanager.js';
import { renderLieutenants, initLieutenants } from './ltmanager.js';
import { renderAutomation, initAutomation } from './automation.js';
import './resize.js'; // draggable side-panel widths
import './keepalivesettings.js'; // the pocket switch: hold the audio session open

chatOnOpenCard(openDetail);
// a notification is about a conversation — clicking it lands IN the chat,
// filtered to the card (same action as the message card chips); the detail
// stays behind the filtered header's explicit "open card" button
notifOnOpenCard(openCardConversation);
toastOnOpenCard(openDetail);
toastOnOpenLieutenant(openLieutenantChat); // card-less chat toast → the lieutenant's main chat

// ---------- header: filter ----------
// Just the text input here — every richer filter lives in the popup
// (filterpop.js), behind the one button with the active-count badge.
const filterInput = document.getElementById('filter');
filterInput.oninput = () => { S.filters.text = filterInput.value; render(); };
// Mobile collapses the input to a 🔍 button; tapping it puts the topbar in
// "search mode" (the input over the whole row) until ✕. Desktop never shows
// either button and the .searching class is inert there.
const topbarEl = document.getElementById('topbar');
const filterOpenBtn = document.getElementById('filter-open');
document.getElementById('filter-close').onclick = () => topbarEl.classList.remove('searching');
filterOpenBtn.onclick = () => { topbarEl.classList.add('searching'); filterInput.focus(); };
function searchModeOn() { return topbarEl.classList.contains('searching'); }
function syncFilterInputs() {
  if (filterInput.value !== S.filters.text) filterInput.value = S.filters.text;
  // collapsed 🔍 lights up while a text filter is applied
  filterOpenBtn.classList.toggle('on', !!S.filters.text);
}

// ---------- header: status dot ----------
function renderStatusDot() {
  const el = document.getElementById('status-dot');
  const owed = owedTargets().length;
  el.className = !S.connected ? '' : owed ? 'busy' : 'ok';
  el.title = !S.connected ? 'disconnected — reconnecting…'
    : owed ? 'a lieutenant owes a reply on ' + owed + ' conversation' + (owed > 1 ? 's' : '')
    : 'connected — all quiet';
  // mobile hides the dot and wears the same state as a colored underline on
  // the title (the dot had no tap action, so the underline is passive too)
  const titleEl = document.getElementById('b-title');
  titleEl.dataset.load = !S.connected ? 'down' : owed ? 'busy' : 'ok';
  titleEl.title = el.title;
}

// ---------- settings panel ----------
const gearBtn = document.getElementById('gear');
const spEl = document.getElementById('settings-panel');
gearBtn.onclick = (e) => {
  e.stopPropagation();
  spEl.hidden = !spEl.hidden;
  gearBtn.classList.toggle('on', !spEl.hidden);
  if (!spEl.hidden) { S.notifOpen = false; renderNotifSettings(); render(); }
};
document.addEventListener('click', (e) => {
  if (!spEl.hidden && !spEl.contains(e.target) && e.target !== gearBtn) {
    spEl.hidden = true;
    gearBtn.classList.remove('on');
  }
});
// ⚙️ → monitoring: the settings row hands off to the monitor panel
document.getElementById('mon-open').onclick = () => {
  spEl.hidden = true;
  gearBtn.classList.remove('on');
  openMonitor();
};
// ⚙️ → config: same handoff, to the config screen in the board region (so the
// chat stays at its side). Mobile lives in the board tab, like the file screen.
// The dropdown is this browser; the screen is the board everyone shares.
document.getElementById('config-open').onclick = () => {
  spEl.hidden = true;
  gearBtn.classList.remove('on');
  S.view = 'board';
  setWsTab('labels'); // never remembered: the gear always lands on labels
  setBoardMode('settings');
};

// ---------- the list panels ----------
// They look nothing up at import — each is handed its elements here, once — so
// a module can be loaded without the page it paints into.
{
  const $ = (id) => document.getElementById(id);
  initPlaybooks({ list: $('pb-list'), dir: $('pb-dir'), ref: $('pb-ref') });
  initProjects({ list: $('pj-list') });
  initLieutenants({ list: $('lt-list') });
  initAutomation();
}

// ---------- config screen tabs ----------
// One tab per section, one section visible. The tab is a class toggle over
// [data-sec] plus one variable — nothing is persisted, so entering from the
// gear always lands on labels, the same way the screen itself is not
// remembered across a reload.
// WS_RENDER is what a section paints with: the tab shows it with `true` (read
// the source afresh on the way in), the render loop repaints it without. A new
// section is a <section data-sec>, a <button data-tab> and one entry here; the
// switching below never learns its name.
const WS_RENDER = { labels: renderLabelManager, playbooks: renderPlaybooks, projects: renderProjects,
  lieutenants: renderLieutenants };
let wsTab = 'labels';
function setWsTab(tab) {
  wsTab = tab;
  for (const el of document.querySelectorAll('#settings-screen [data-sec]')) {
    el.classList.toggle('on', el.dataset.sec === tab);
  }
  for (const b of document.querySelectorAll('#ss-tabs button')) {
    b.classList.toggle('on', b.dataset.tab === tab);
  }
  WS_RENDER[tab](true);
}
for (const b of document.querySelectorAll('#ss-tabs button')) {
  b.onclick = () => setWsTab(b.dataset.tab);
}
// ---- board region mode: kanban ⇄ table ⇄ archived ⇄ automation ⇄ file ⇄ settings ----
// Which modes exist and which are remembered is modes.js; this is the wiring.
// Entering ⚡ is a fresh look at the clock, not last visit's answer — the same
// contract setWsTab gives a config section. The render loop below hands this to
// renderAutomation once and clears it, so the board events that follow repaint
// without re-entering.
let enteringAuto = false;
function setBoardMode(mode) {
  if (mode === 'auto' && S.boardMode !== 'auto') enteringAuto = true;
  // The ⚡ screen's panel belongs to that screen: leaving the mode takes it with
  // us rather than leaving a schedule floating over the kanban.
  if (mode !== S.boardMode && auxDetailKey()) closeDetail();
  mode = boardModeFor(mode);
  if (mode !== 'file') forgetFile(); // anything else leaves the file screen
  S.boardMode = mode;
  if (MODE_BTN[mode]) try { localStorage.setItem('bc-board-mode', mode); } catch (e) {}
  const wrap = document.getElementById('board-wrap');
  wrap.classList.toggle('table-mode', mode === 'table');
  wrap.classList.toggle('archive-mode', mode === 'archive');
  wrap.classList.toggle('auto-mode', mode === 'auto');
  wrap.classList.toggle('file-mode', mode === 'file');
  wrap.classList.toggle('settings-mode', mode === 'settings');
  for (const [m, id] of Object.entries(MODE_BTN)) {
    document.getElementById(id).classList.toggle('on', m === mode);
  }
  render();
}
// The way out of a screen: back to the switcher mode this browser remembers,
// kanban when it remembers none. Both exits — the workspace ⟵ and the mobile
// Board tab — ask the question here, so they can never disagree.
function lastSwitcherMode() {
  let m = null;
  try { m = localStorage.getItem('bc-board-mode'); } catch (e) {}
  return switcherModeFor(m);
}
function leaveScreen() { setBoardMode(lastSwitcherMode()); }
// On a phone the board tab IS the main area, so tapping it while that area
// holds a screen means "give me the board back" — the switcher has collapsed to
// a button the screens do not have.
function tapBoardTab() {
  S.view = 'board';
  if (SCREENS.includes(S.boardMode)) leaveScreen(); // renders
  else render();
}
document.getElementById('ss-back').onclick = leaveScreen;
onModeSwitch(setBoardMode);   // the file screen flips the mode through this one owner
onQuoteSource(fileQuote);     // …and is where every message's file context comes from
// Mobile collapses the switcher to just the active mode's button; tapping it
// opens a small dropdown of the four modes. Desktop shows all four buttons,
// where clicking the active one was always a no-op — so the dropdown branch
// can never fire there.
const MODE_LABEL = { board: '▦ kanban', table: '☰ table', archive: '🧊 archived', auto: '⚡ automation' };
function openModeMenu(anchor) {
  openPopover(anchor, Object.keys(MODE_BTN).map((m) => ({
    label: (m === S.boardMode ? '● ' : '') + MODE_LABEL[m],
    current: m === S.boardMode,
    onClick: () => setBoardMode(m),
  })), { id: 'mode-menu', align: 'right' });
}
for (const [m, id] of Object.entries(MODE_BTN)) {
  document.getElementById(id).onclick = (e) => {
    if (m === S.boardMode && matchMedia('(max-width: 760px)').matches) {
      if (!closePopover('mode-menu')) openModeMenu(e.currentTarget);
    } else setBoardMode(m);
  };
}
try { setBoardMode(localStorage.getItem('bc-board-mode') || 'board'); } catch (e) {}

// ---------- mobile tabs ----------
const tabChat = document.getElementById('tab-chat');
const tabBoard = document.getElementById('tab-board');
tabChat.onclick = () => { S.view = 'chat'; render(); };
tabBoard.onclick = tapBoardTab;
function renderTabs() {
  document.body.dataset.view = S.view;
  // The board tab IS the main area, so when that area holds a file it says so.
  tabBoard.firstChild.nodeValue = fileOpen() ? '📄 ' + fileName() : '▦ Board';
  tabChat.classList.toggle('on', S.view === 'chat');
  tabBoard.classList.toggle('on', S.view === 'board');
  // chat tab badge: unread across every lieutenant chat + all card threads;
  // board badge: notifications
  let chatN = 0;
  for (const l of lieutenants()) chatN += lieutenantUnread(l);
  for (const c of cards()) chatN += cardUnread(c);
  const cn = document.getElementById('tab-chat-n');
  cn.hidden = !chatN; cn.textContent = chatN > 99 ? '99+' : String(chatN);
  const bn = document.getElementById('tab-board-n');
  const notifN = notifUnreadCount();
  bn.hidden = !notifN; bn.textContent = notifN > 99 ? '99+' : String(notifN);
}

// ---------- keyboard ----------
document.addEventListener('keydown', (e) => {
  const active = document.activeElement;
  const inField = /^(INPUT|TEXTAREA|SELECT)$/.test((active && active.tagName) || '');
  if (e.key === '/' && !inField) {
    e.preventDefault();
    if (matchMedia('(max-width: 760px)').matches) topbarEl.classList.add('searching');
    filterInput.focus();
    return;
  }
  // Escape closes the topmost thing — EXCEPT when the LIVE pane has focus: a
  // focused pane is a terminal, and Escape is a key its agent uses (Claude's
  // own composer clears on it). pane.js stops that keydown at the <pre>, so it
  // never reaches this handler; the pane's head line carries the way out
  // instead (✕, or click outside).
  if (e.key === 'Escape') {
    if (artifactOpen()) closeArtifact();
    else if (closeTopPopover()) return; // just the menu — what it opened over stays
    else if (logOpen()) closeLog();
    else if (paneOpen()) closePane();
    else if (monitorOpen()) closeMonitor();
    else if (newCardOpen()) closeNewCard();
    else if (newLieutenantOpen()) closeNewLieutenant();
    else if (ltSettingsOpen()) closeLtSettings();
    else if (pickerIsOpen()) closeLabelPicker();
    else if (filterPanelOpen()) closeFilterPanel();
    else if (ltSwitcherOpen()) closeLtSwitcher();
    else if (S.notifOpen) { S.notifOpen = false; render(); }
    else if (selectionOn()) { exitSelection(); render(); } // leave selection mode
    else if (!spEl.hidden) { spEl.hidden = true; gearBtn.classList.remove('on'); }
    else if (detailOpen()) closeDetail();
    else if (searchModeOn()) topbarEl.classList.remove('searching'); // collapse first, filters survive
    else if (filtersActive()) { clearFilters(); syncFilterInputs(); }
  }
});

// ---------- render orchestration ----------
// Reading-mode guard: while the artifact viewer popup is open, workers still
// push board updates (S.doc keeps updating) but repainting the regions would
// blink the text/iframe being read. So record the pending render and bail; when
// the viewer closes, onArtifactClose below runs the one deferred pass.
let renderPending = false;
onRender(() => {
  if (!S.doc) return;
  // An agent is blocked on the captain: the tray stays live even over the
  // reading-mode guard, and the tab title says so when the tab is in the background.
  renderPermTray();
  const nPerm = docPermissions(S.doc).length;
  document.title = (nPerm ? '🔐' + nPerm + ' · ' : '') + (S.doc.title || 'bridge command');
  if (artifactOpen()) { renderPending = true; return; }
  document.getElementById('b-title').textContent = S.doc.title || 'bridge command';
  document.getElementById('b-subtitle').textContent = S.doc.subtitle || '';
  syncFilterInputs();
  renderFilterUI();
  renderStatusDot();
  // the selection is trimmed to what the filters still show BEFORE the views
  // paint it, so the checkboxes and the action bar's count never disagree
  renderBulkBar();
  // The file screen owns its own DOM and is never repainted from here: a render
  // under the captain's cursor would eat what he is typing.
  if (S.boardMode === 'file') { /* nothing to repaint */ }
  else if (S.boardMode === 'settings') WS_RENDER[wsTab]();
  else if (S.boardMode === 'auto') { renderAutomation(enteringAuto); enteringAuto = false; }
  else if (S.boardMode === 'archive') renderArchive();
  else if (S.boardMode === 'table') renderTable();
  else renderBoard();
  renderChat();
  renderLtSwitcher();
  renderDetail();
  renderNotifications();
  renderTabs();
  if (pickerIsOpen()) renderPicker();
  if (!spEl.hidden) renderNotifSettings();
  // fill the [data-ago] spans the panels above left empty (see util.js: time
  // text stays out of the compared markup so it never forces a rebuild)
  refreshAgoLabels();
});
// When the viewer closes, flush the render that was deferred while it was open
// so the board catches up in one pass (no-op if nothing pushed meanwhile).
onArtifactClose(() => { if (renderPending) { renderPending = false; render(); } });

// ---------- live board ----------
// The stream itself (SSE + staleness watchdog + boot id) lives in live.js,
// shared with the 3D room; this page adds its two trackers and the status dot.
onBoard(trackMessages);
onBoard(trackEvents);
onBoard(trackPermissions);
startLive({
  onConnection: renderStatusDot,
  // a file screen open on the written artifact follows along by itself
  onArtifact: artifactWritten,
});
renderStatusDot();
// the minute tick: one guarded render pass — the [data-ago] labels are updated
// in place by the refreshAgoLabels post-pass, and time-derived STATE (the
// stale-owed ⚠ flip) still surfaces; panels whose markup didn't change leave
// their DOM untouched
setInterval(render, 60000);
