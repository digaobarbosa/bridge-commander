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
import { renderChat, onOpenCard as chatOnOpenCard, openCardConversation, openLieutenantChat, onQuoteSource, escInterrupt } from './chat.js';
import { onModeSwitch, forgetFile, fileOpen, fileName, fileQuote } from './filepane.js';
import { renderLtSwitcher, ltSwitcherOpen, closeLtSwitcher, ltSettingsOpen, closeLtSettings } from './ltswitcher.js';
import { renderDetail, openDetail, closeDetail, detailOpen, auxDetailKey, closeArtifact, artifactOpen, onArtifactClose, artifactWritten, talkOnCard } from './detail.js';
import { openPopover, closePopover, closeTopPopover } from './popover.js';
import { registerView, views, allViews, view, current, isScreen, setMode, restoreMode, lastSwitcher, renderCurrent, onViewsChange, onModeChange } from './views.js';
import { closeTopModal } from './modal.js';
import { configurePlugins, loadPlugins, syncPlugins, onPluginsChange, fillHarnessOptions } from './plugins.js';
import { configureCardActions } from './cardactions.js';
import { configureCommands } from './commandui.js';
import { initActivities, renderTaskbar, openActivity } from './activities.js';
import { initPluginSettings, renderPluginSettings } from './pluginsettings.js';
import { configureSidebar, registerSidebar, renderSidebar, activeSidebar } from './sidebar.js';
import { initTopbar, renderTopbar } from './topbar.js';
import { configurePalette, togglePalette } from './palette.js';
import { initSettingsTabs, syncSettingsTabs, isPluginTab, renderSettingsTab } from './settingstabs.js';
import { push as toastPush } from './toast.js';
import { closePane, paneOpen, openCardPane } from './pane.js';
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

// ---------- plugins, commands, activities ----------
// The modules below are DOM-free at import; this is where they are handed the
// page: the board region plugin views paint into, and the panels they open.
{
  const toast = (text, sub) => toastPush({ text, sub: sub || '' });
  const taskbar = document.getElementById('taskbar');
  configurePlugins({ host: document.getElementById('board-wrap'), before: taskbar, openCard: openDetail, openActivity, toast });
  configureCommands({ openActivity, toast });
  configureCardActions({ openPane: openCardPane, talk: talkOnCard });
  initActivities({ bar: taskbar, openCard: openDetail });
  initTopbar({ el: document.getElementById('topbar-cmds') });
  // the palette's context: the card the detail panel shows (not a schedule or a hook)
  configurePalette({ openCardId: () => (auxDetailKey() ? null : S.openCardId) });
  document.getElementById('palette-btn').onclick = (e) => { e.stopPropagation(); togglePalette(); };
  // sidebar/v1: the chat is its built-in filler, registered with its own
  // element so nothing of it is rebuilt; a plugin sidebar gets a sibling
  // section and shows when the overlay switches `sidebar:chat` off.
  const layout = document.getElementById('layout');
  configureSidebar({ host: layout, before: document.getElementById('board-wrap') });
  registerSidebar({ id: 'chat', key: 'sidebar:chat', title: 'Chat', icon: '💬', rank: 100,
    el: document.getElementById('chat'), render: renderChat });
  // the lieutenant harness dropdowns list what the server can run
  const fillHarnesses = () => {
    for (const id of ['lt-harness', 'ls-harness']) {
      const sel = document.getElementById(id);
      fillHarnessOptions(sel, sel.value);
    }
  };
  fillHarnesses();
  onPluginsChange(fillHarnesses);
}

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
  initPluginSettings({ list: $('pl-list') });
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
// A plugin's settings.sections/v1 entry is one more tab after "plugins"
// (settingstabs.js makes its button and box; `p:<key>` is its tab id).
const WS_RENDER = { labels: renderLabelManager, playbooks: renderPlaybooks, projects: renderProjects,
  lieutenants: renderLieutenants, plugins: renderPluginSettings };
let wsTab = 'labels';
initSettingsTabs({ tabs: document.getElementById('ss-tabs'), screen: document.getElementById('settings-screen') });
function paintWsTab(fresh) {
  if (WS_RENDER[wsTab]) WS_RENDER[wsTab](fresh);
  else renderSettingsTab(wsTab);
}
function setWsTab(tab) {
  const pluginTabs = syncSettingsTabs(tab);
  // a plugin tab switched off (or never there) lands on the plugins list
  wsTab = WS_RENDER[tab] || pluginTabs.includes(tab) ? tab : 'plugins';
  for (const el of document.querySelectorAll('#settings-screen [data-sec]')) {
    el.classList.toggle('on', el.dataset.sec === wsTab);
  }
  for (const b of document.querySelectorAll('#ss-tabs button')) {
    b.classList.toggle('on', b.dataset.tab === wsTab);
  }
  paintWsTab(true);
}
// delegated: plugin tabs come and go with the catalog
document.getElementById('ss-tabs').onclick = (e) => {
  const b = e.target.closest('button[data-tab]');
  if (b) setWsTab(b.dataset.tab);
};
// the screen's repaint: keep the plugin tabs in step, then the tab on show
function renderSettingsScreen() {
  const pluginTabs = syncSettingsTabs(wsTab);
  if (isPluginTab(wsTab) && !pluginTabs.includes(wsTab)) { setWsTab('plugins'); return; }
  paintWsTab(false);
}
// ---- board region: the main/v1 view registry ----
// Which views exist, which one is on screen and which one a reload restores is
// views.js; the built-ins register here the way a plugin view does (plugins.js).
// The switcher buttons, the phone's mode menu and the render dispatch below all
// read the registry — none of them names a view.
const $id = (id) => document.getElementById(id);
// Entering ⚡ is a fresh look at the clock, not last visit's answer — the same
// contract setWsTab gives a config section. enter() raises it, the next render
// hands it to renderAutomation once and clears it.
let enteringAuto = false;
registerView({ id: 'board', key: 'view:kanban', title: 'kanban', icon: '▦', tip: 'kanban board', btn: 'vs-board',
  rank: 100, el: $id('board'), remember: true, render: renderBoard });
registerView({ id: 'table', title: 'table', icon: '☰', tip: 'table view', btn: 'vs-table',
  rank: 200, el: $id('table'), remember: true, render: renderTable });
registerView({ id: 'archive', title: 'archived', icon: '🧊', tip: 'archived cards', btn: 'vs-arch',
  rank: 300, el: $id('archive'), remember: true, render: renderArchive });
registerView({ id: 'auto', title: 'automation', icon: '⚡', tip: 'hooks & schedules', btn: 'vs-auto',
  rank: 400, el: $id('auto-screen'), remember: true,
  enter: () => { enteringAuto = true; },
  render: () => { const r = enteringAuto; enteringAuto = false; renderAutomation(r); } });
// The file screen owns its own DOM and is never repainted from here: a render
// under the captain's cursor would eat what he is typing.
registerView({ id: 'file', title: 'file', icon: '📄', el: $id('filepane'), screen: true, remember: false, render: () => {} });
registerView({ id: 'settings', title: 'config', icon: '🗂', el: $id('settings-screen'), screen: true, remember: false,
  render: renderSettingsScreen });

// What changing the view does beyond the registry: the ⚡ screen's panel
// belongs to that screen, and anything but the file screen leaves the file.
onModeChange((to, from) => {
  if (to !== from && auxDetailKey()) closeDetail();
  if (to !== 'file') forgetFile();
  const wrap = $id('board-wrap');
  // <id>-mode classes: the stylesheet's per-view rules key off them
  for (const v of allViews()) wrap.classList.toggle(v.id + '-mode', v.id === to);
  paintSwitcher();
  render();
});
function setBoardMode(mode) {
  if (mode === current()) { render(); return; }
  setMode(mode);
}
// The way out of a screen: back to the switcher view this browser remembers,
// the first switcher view when it remembers none. Both exits — the workspace ⟵
// and the mobile Board tab — ask the registry, so they can never disagree.
function leaveScreen() { setBoardMode(lastSwitcher()); }
// On a phone the board tab IS the main area, so tapping it while that area
// holds a screen means "give me the board back" — the switcher has collapsed to
// a button the screens do not have.
function tapBoardTab() {
  S.view = 'board';
  if (isScreen(current())) leaveScreen(); // renders
  else render();
}
$id('ss-back').onclick = leaveScreen;
onModeSwitch(setBoardMode);   // the file screen flips the mode through this one owner
onQuoteSource(fileQuote);     // …and is where every message's file context comes from

// The switcher: one button per switcher view, rebuilt when the registry
// changes (a plugin view arrives, the overlay switches one off). Mobile
// collapses it to the active view's button; tapping that opens a dropdown of
// every switcher view. On desktop clicking the active one was always a no-op,
// so the dropdown branch can never fire there.
const segEl = $id('view-seg');
function btnId(v) { return v.btn || 'vs-p-' + String(v.id).replace(/[^A-Za-z0-9_-]/g, '_'); }
function paintSwitcher() {
  const list = views();
  const sig = list.map((v) => v.id + '|' + v.icon + '|' + v.title).join(',');
  if (segEl.__bcSig !== sig) {
    segEl.__bcSig = sig;
    segEl.textContent = '';
    for (const v of list) {
      const b = document.createElement('button');
      b.id = btnId(v);
      b.type = 'button';
      b.title = v.tip || v.title;
      b.textContent = v.icon || v.title;
      if (v.plugin) b.dataset.plugin = v.plugin;
      b.onclick = (e) => {
        if (v.id === current() && matchMedia('(max-width: 760px)').matches) {
          if (!closePopover('mode-menu')) openModeMenu(e.currentTarget);
        } else setBoardMode(v.id);
      };
      segEl.appendChild(b);
    }
  }
  for (const b of segEl.children) b.classList.toggle('on', b.id === btnId(view(current()) || {}));
}
function openModeMenu(anchor) {
  openPopover(anchor, views().map((v) => ({
    label: (v.id === current() ? '● ' : '') + (v.icon ? v.icon + ' ' : '') + v.title,
    current: v.id === current(),
    onClick: () => setBoardMode(v.id),
  })), { id: 'mode-menu', align: 'right' });
}
onViewsChange(paintSwitcher);
restoreMode();

// ---------- mobile tabs ----------
const tabChat = document.getElementById('tab-chat');
const tabBoard = document.getElementById('tab-board');
tabChat.onclick = () => { S.view = 'chat'; render(); };
tabBoard.onclick = tapBoardTab;
function renderTabs() {
  document.body.dataset.view = S.view;
  // The board tab IS the main area, so when that area holds a file it says so.
  tabBoard.firstChild.nodeValue = fileOpen() ? '📄 ' + fileName() : '▦ Board';
  // …and the chat tab is whatever fills the sidebar
  const sb = activeSidebar();
  tabChat.firstChild.nodeValue = !sb || sb.id === 'chat' ? '💬 Chat' : (sb.icon || '◧') + ' ' + sb.title;
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
  // ⌘K / Ctrl+K: the command palette, from anywhere (a field included — it
  // is the one chord no text box here wants)
  if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (e.key === 'k' || e.key === 'K')) {
    e.preventDefault();
    togglePalette();
    return;
  }
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
    else if (closeTopModal()) return; // a command form or an activity log — the top one only
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
    else if (escInterrupt(e)) return; // nothing on top: Esc in an empty composer stops the agent
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
  renderCurrent(); // the view on screen (views.js) paints itself
  renderTaskbar();
  renderTopbar();
  renderSidebar(); // the chat, unless the overlay put a plugin sidebar there
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
onBoard(syncPlugins); // a moved pluginsVersion re-reads GET /api/plugins
onBoard(trackMessages);
onBoard(trackEvents);
onBoard(trackPermissions);
startLive({
  onConnection: renderStatusDot,
  // a file screen open on the written artifact follows along by itself
  onArtifact: artifactWritten,
});
renderStatusDot();
loadPlugins();
// the minute tick: one guarded render pass — the [data-ago] labels are updated
// in place by the refreshAgoLabels post-pass, and time-derived STATE (the
// stale-owed ⚠ flip) still surfaces; panels whose markup didn't change leave
// their DOM untouched
setInterval(render, 60000);
