// pluginsettings — the config screen's "plugins" tab: every plugin the server
// found (shipped or the workspace's own), switched on or off, its config, and
// what it adds to the board. Every write is PUT /api/plugins/overlay — the one
// file (.bridge-commander/plugins.json) the workspace owns — and the catalog
// is re-read after it, so the tab shows what the server now believes.
import { pluginList, pluginsState, contributionsOf, moduleError, loadPlugins, saveOverlay } from './plugins.js';
import { formHtml, readForm } from './form.js';
import { validateValues } from './fields.js';
import { esc, setHtmlIfChanged } from './util.js';

let listEl = null;
const notes = new Map(); // plugin id -> { text, kind } — what the last write said
let restartNote = '';
const configOpen = new Set(); // plugin ids whose config fold is open: a repaint keeps it so

export function initPluginSettings({ list }) {
  listEl = list;
  list.addEventListener('change', (e) => {
    const t = e.target.closest('input[data-toggle]');
    if (t) toggle(t.dataset.toggle, t.checked, t);
  });
  // `toggle` does not bubble: listen in the capture phase
  list.addEventListener('toggle', (e) => {
    const d = e.target;
    if (!d || !d.classList || !d.classList.contains('pl-config')) return;
    const id = d.closest('[data-plugin]').dataset.plugin;
    if (d.open) configOpen.add(id); else configOpen.delete(id);
  }, true);
  list.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-save]');
    if (b) saveConfig(b.dataset.save, b);
  });
}

/** Paint the tab; `fresh` (entering it) re-reads the catalog first. */
export function renderPluginSettings(fresh) {
  if (!listEl) return;
  if (fresh) loadPlugins().then(() => paint());
  paint();
}

function contributionsHtml(p) {
  if (!p.enabled) return '';
  const c = contributionsOf(p.id);
  const rows = [];
  const names = (list, f) => list.map((x) => '<span class="pl-chip">' + esc(f(x)) + '</span>').join('');
  if (c.commands.length) rows.push(['commands', names(c.commands, (x) => (x.icon ? x.icon + ' ' : '') + (x.title || x.id))]);
  if (c.menus.length) rows.push(['menus', names(c.menus, (x) => x.slot.replace(/\/v\d+$/, '') + ' → ' + x.command)]);
  if (c.views.length) rows.push(['views', names(c.views, (x) => (x.icon ? x.icon + ' ' : '') + (x.title || x.id))]);
  if (c.sections.length) rows.push(['sections', names(c.sections, (x) => x.title || x.id)]);
  if (c.badges.length) rows.push(['badges', names(c.badges, (x) => x.text)]);
  if (c.checks.length) rows.push(['checks', names(c.checks, (x) => x.title || x.id)]);
  if (!rows.length) return '<div class="pl-contrib"><span class="pl-k">adds</span><span class="pl-none">nothing to the board (a harness or a check only)</span></div>';
  return rows.map(([k, v]) => '<div class="pl-contrib"><span class="pl-k">' + k + '</span><span class="pl-v">' + v + '</span></div>').join('');
}

function rowHtml(p) {
  const schema = p.configSchema || {};
  const hasConfig = Object.keys(schema).length > 0;
  const err = p.error || moduleError(p.id);
  const note = notes.get(p.id);
  return '<div class="pl-row' + (p.enabled ? '' : ' off') + (err ? ' err' : '') + '" data-plugin="' + esc(p.id) + '">' +
    '<div class="pl-head">' +
      // a manifest that failed to load cannot be switched on: fix the file first
      '<label class="pl-switch" title="' + (p.error ? 'cannot load — see the error below' : p.enabled ? 'on — click to switch it off' : 'off — click to switch it on') + '">' +
        '<input type="checkbox" data-toggle="' + esc(p.id) + '"' + (p.enabled ? ' checked' : '') + (p.error ? ' disabled' : '') + '><span class="pl-knob"></span></label>' +
      '<span class="pl-name">' + esc(p.name || p.id) + '</span>' +
      '<span class="pl-id">' + esc(p.id) + '</span>' +
      (p.version ? '<span class="pl-ver">v' + esc(p.version) + '</span>' : '') +
      '<span class="pl-src pl-src-' + (p.source === 'workspace' ? 'workspace' : 'shipped') + '">' + esc(p.source || 'shipped') + '</span>' +
      '<span class="grow"></span>' +
      '<span class="pl-active' + (p.active ? ' on' : '') + '" title="' + (p.active ? 'its server module is running' : 'nothing of it is running on the server (lazy, or no server module)') + '">' + (p.active ? '● active' : '○ idle') + '</span>' +
    '</div>' +
    (p.description ? '<div class="pl-desc">' + esc(p.description) + '</div>' : '') +
    (err ? '<div class="pl-error">⚠ ' + esc(err) + '</div>' : '') +
    contributionsHtml(p) +
    (hasConfig && p.enabled ? '<details class="pl-config"' + (configOpen.has(p.id) ? ' open' : '') + '><summary>config</summary>' +
      '<div class="pl-form" data-form="' + esc(p.id) + '">' + formHtml(schema, p.config || {}, { idPrefix: 'plc-' + p.id }) + '</div>' +
      '<div class="pl-actions"><button type="button" class="bc-btn primary" data-save="' + esc(p.id) + '">save</button></div></details>' : '') +
    (note ? '<div class="pl-note pl-note-' + note.kind + '">' + esc(note.text) + '</div>' : '') +
    '</div>';
}

function paint() {
  const st = pluginsState();
  const list = pluginList();
  const top = (restartNote ? '<div class="pl-restart">↻ ' + esc(restartNote) + '</div>' : '') +
    (st.missing ? '<div class="pl-note pl-note-warn">this server has no plugin host (GET /api/plugins answered 404)</div>' : '') +
    (st.error ? '<div class="pl-note pl-note-err">could not read the plugins: ' + esc(st.error) + '</div>' : '');
  const body = list.length ? list.map(rowHtml).join('')
    : (st.loaded ? '<div class="ss-note">no plugins found</div>' : '<div class="ss-note">reading the plugins…</div>');
  setHtmlIfChanged(listEl, top + body);
}

async function write(id, patch, el) {
  if (el) el.disabled = true;
  try {
    const res = await saveOverlay(patch);
    notes.set(id, { text: 'saved', kind: 'ok' });
    if (res && res.restartNeeded) {
      restartNote = typeof res.restartNeeded === 'string' ? res.restartNeeded
        : 'restart the board server for this change to take full effect';
    }
  } catch (e) {
    notes.set(id, { text: 'not saved: ' + e.message, kind: 'err' });
  }
  if (el) el.disabled = false;
  paint();
}

// Each write carries the plugin's whole overlay entry (enabled + config), so a
// server that replaces the entry rather than merging it loses nothing.
function entryFor(p, over) {
  return { plugins: { [p.id]: Object.assign({ enabled: !!p.enabled, config: p.config || {} }, over) } };
}

function toggle(id, on, input) {
  const p = pluginList().find((x) => x.id === id);
  if (!p) return;
  write(id, entryFor(p, { enabled: on }), input);
}

function saveConfig(id, btn) {
  const p = pluginList().find((x) => x.id === id);
  const form = listEl.querySelector('[data-form="' + CSS.escape(id) + '"]');
  if (!p || !form) return;
  const schema = p.configSchema || {};
  const v = validateValues(schema, readForm(form, schema));
  if (v.error) { notes.set(id, { text: v.error, kind: 'err' }); paint(); return; }
  write(id, entryFor(p, { config: v.values }), btn);
}
