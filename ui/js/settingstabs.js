// settingstabs — settings.sections/v1: a plugin's own section in the config
// screen, as one more tab after "plugins". The tab button and the section box
// are made here from the slot's entries; what goes inside is the plugin's —
// its ui module is imported the first time the tab is shown, and its
// render(el, null, state) (the detail section contract, with no card) runs on
// every repaint of the tab, inside the slot error boundary (plugins.js).
//
// A settings section belongs to the board, not a card, so its `when` is asked
// of the empty context. The boxes are rebuilt only when the set of sections
// changes, so a plugin's DOM survives a board push.
import { entries, hasEntries } from './slots.js';
import { EMPTY_CONTEXT } from './cardview.js';
import { renderPluginSection } from './plugins.js';

export const SETTINGS_SLOT = 'settings.sections/v1';
const PREFIX = 'p:';

let tabsEl = null;
let screenEl = null;
let mounts = { sig: '', list: [] }; // list: [{ tab, entry, btn, sec, body, dispose }]

/** Hand over the tab strip (#ss-tabs) and the screen the sections go in. */
export function initSettingsTabs({ tabs, screen }) { tabsEl = tabs; screenEl = screen; }

/** The tab id of a settings section entry. */
export function tabOf(entry) { return PREFIX + entry.key; }
export function isPluginTab(tab) { return typeof tab === 'string' && tab.startsWith(PREFIX); }

/** The settings sections on show, in rank order. */
export function settingsEntries() {
  return hasEntries(SETTINGS_SLOT) ? entries(SETTINGS_SLOT, EMPTY_CONTEXT) : [];
}

function clear() {
  for (const m of mounts.list) {
    if (m.dispose) m.dispose();
    m.btn.remove();
    m.sec.remove();
  }
  mounts = { sig: '', list: [] };
}

/**
 * Make the plugin tabs match the slot. `current` is the tab on screen, so a
 * new box is born visible when it is that tab. -> the plugin tab ids.
 */
export function syncSettingsTabs(current) {
  if (!tabsEl || !screenEl) return [];
  const list = settingsEntries();
  const sig = list.map((e) => e.key + '|' + e.title + '|' + (e.icon || '')).join(',');
  if (sig !== mounts.sig) {
    clear();
    mounts.sig = sig;
    for (const entry of list) {
      const tab = tabOf(entry);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.tab = tab;
      btn.textContent = (entry.icon ? entry.icon + ' ' : '') + entry.title;
      btn.title = entry.title + (entry.plugin ? ' — from plugin ' + entry.plugin : '');
      if (entry.plugin) btn.dataset.plugin = entry.plugin;
      btn.classList.toggle('on', tab === current);
      tabsEl.appendChild(btn);
      const sec = document.createElement('section');
      sec.className = 'ss-sec ss-psec' + (tab === current ? ' on' : '');
      sec.dataset.sec = tab;
      const head = document.createElement('div');
      head.className = 'ss-title';
      head.textContent = entry.title;
      if (entry.plugin) {
        const by = document.createElement('span');
        by.className = 'dt-psec-by';
        by.textContent = ' ' + entry.plugin;
        head.appendChild(by);
      }
      const body = document.createElement('div');
      body.className = 'ss-psec-body';
      sec.append(head, body);
      screenEl.appendChild(sec);
      mounts.list.push({ tab, entry, btn, sec, body, dispose: null });
    }
  }
  return mounts.list.map((m) => m.tab);
}

/** Paint plugin tab `tab` (a no-op when it is gone). */
export function renderSettingsTab(tab) {
  const m = mounts.list.find((x) => x.tab === tab);
  if (!m) return;
  const d = renderPluginSection(m.entry, m.body, null);
  if (d) m.dispose = d;
}
