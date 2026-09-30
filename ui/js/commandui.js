// commandui — running a plugin command for a card, the three ways a command
// can be:
//   open  — a link: the url is filled from the card context here and opened
//           (http(s) only); nothing is posted.
//   form  — it has a `form` or a server `prepare`: a modal opens, prefilled by
//           POST /api/commands/:id/prepare, validated with the same
//           fields.validateValues the server applies, then POST …/run.
//   run   — neither: POST …/run straight away, with the button busy meanwhile.
// A tracked run answers with an activity: a toast says so and the activity
// panel opens on its log.
//
// A null card is a card-less run (a topbar button, the palette with no card
// open): the empty context fills a link, and the posts carry no `card`, which
// the server allows only for commands placed in topbar/v1 or palette/v1.
//
// The server re-checks every `when` before it runs anything; the checks here
// are for the captain, not for safety.
import { S, card as cardById, render } from './state.js';
import { cardContext, EMPTY_CONTEXT } from './cardview.js';
import { command } from './plugins.js';
import { expandUrl } from './template.js';
import { validateValues, defaultsFor } from './fields.js';
import { formHtml, readForm } from './form.js';
import { openModal } from './modal.js';
import { esc } from './util.js';

const deps = {
  openActivity() {},
  toast() {},
  openUrl: (url) => globalThis.window && window.open(url, '_blank', 'noopener'),
  fetch: (...a) => globalThis.fetch(...a),
};
export function configureCommands(d) { Object.assign(deps, d); }

// "cmd|card" pairs posted and not yet answered: the tile and detail buttons
// draw themselves busy from this, so a double click is one run.
const busy = new Set();
export function isBusy(cmdId, cardId) { return busy.has(cmdId + '|' + (cardId || '')); }

/** Which way a command runs: 'open', 'form' or 'run'. Pure. */
export function commandKind(cmd) {
  if (!cmd) return null;
  if (cmd.open) return 'open';
  if ((cmd.form && Object.keys(cmd.form).length) || cmd.prepare) return 'form';
  return 'run';
}

async function post(path, body) {
  const r = await deps.fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let json = null;
  try { json = await r.json(); } catch (e) { json = null; }
  if (!r.ok || (json && json.ok === false)) {
    const msg = (json && (json.error || json.message)) || 'HTTP ' + r.status;
    const err = new Error(r.status === 403 ? 'not available here: ' + msg : msg);
    err.status = r.status;
    err.body = json;
    throw err;
  }
  return json || {};
}
const cmdPath = (id, verb) => '/api/commands/' + encodeURIComponent(id) + '/' + verb;

// The body of a prepare/run: a card-less one names no card.
function bodyFor(c, extra) { return Object.assign(c ? { card: c.id } : {}, extra); }

/**
 * Run command `cmdId` for card `cardId` — or with no card when `cardId` is
 * null/''. Resolves when the command has been handed over (the link opened,
 * the modal shown, or the run answered).
 */
export async function runCommand(cmdId, cardId) {
  const cmd = command(cmdId);
  const c = cardId ? cardById(cardId) : null;
  if (!cmd || (cardId && !c)) { deps.toast('⚠ ' + (cmd ? 'card ' + cardId + ' is gone' : 'command ' + cmdId + ' is not available')); return; }
  const kind = commandKind(cmd);
  if (kind === 'open') {
    const url = expandUrl(cmd.open, c ? cardContext(c, S.doc) : EMPTY_CONTEXT);
    if (!url) { deps.toast('⚠ ' + (cmd.title || cmdId) + ': ' + (c ? 'this card has nothing to open' : 'it needs a card to open')); return; }
    deps.openUrl(url);
    return;
  }
  if (kind === 'form') return openCommandForm(cmd, c);
  const key = cmdId + '|' + (c ? c.id : '');
  if (busy.has(key)) return;
  busy.add(key);
  render();
  try { finish(cmd, c, await post(cmdPath(cmdId, 'run'), bodyFor(c, { input: {} }))); }
  catch (e) { deps.toast('⚠ ' + (cmd.title || cmdId) + ' — ' + e.message); }
  finally { busy.delete(key); render(); }
}

// What a successful run answered: an activity to follow, a url, a message.
function finish(cmd, c, res) {
  const act = res.activity && (typeof res.activity === 'string' ? { id: res.activity } : res.activity);
  const sub = c ? c.title || c.id : '';
  if (act && act.id) {
    deps.toast((cmd.icon ? cmd.icon + ' ' : '') + (cmd.title || cmd.id) + ' started', sub);
    deps.openActivity(act.id);
  } else if (res.message) {
    deps.toast((cmd.icon ? cmd.icon + ' ' : '') + res.message, sub);
  } else {
    deps.toast('✓ ' + (cmd.title || cmd.id), sub);
  }
  if (res.url && /^https?:\/\//i.test(String(res.url))) deps.openUrl(String(res.url));
}

// The generic modal a command's `form` becomes. Prefill first (the plugin's
// prepare knows the card), then validate locally and run; every refusal —
// local or the server's — is shown inside the modal, next to what caused it.
function openCommandForm(cmd, c) {
  const fields = cmd.form || {};
  const idPrefix = 'cmd-' + String(cmd.id).replace(/[^A-Za-z0-9_-]/g, '_');
  const title = (cmd.icon ? cmd.icon + ' ' : '') + (cmd.title || cmd.id);
  const intro = (c ? '<div class="bc-cmd-card">' + esc(c.title || c.id) + ' <span class="bc-cmd-id">' + esc(c.id) + '</span></div>' : '') +
    (cmd.description ? '<div class="bc-cmd-desc">' + esc(cmd.description) + '</div>' : '');
  const m = openModal({
    title,
    cls: 'bc-cmd-modal',
    body: intro + '<div class="bc-cmd-fields"><div class="bc-slot-loading">preparing…</div></div>',
    actions: [{ label: 'cancel' }, { label: cmd.tracked ? 'run ▶' : 'run', primary: true }],
    onSubmit: (h) => submit(h),
  });
  m.setBusy(true, 'preparing…');
  const slot = m.body.querySelector('.bc-cmd-fields');
  const paint = (values) => {
    slot.innerHTML = Object.keys(fields).length ? formHtml(fields, values, { idPrefix }) : '<div class="bc-cmd-desc">nothing to fill in</div>';
    m.setBusy(false);
    const first = slot.querySelector('input, select, textarea');
    if (first && first.focus) first.focus();
  };
  (async () => {
    let values = defaultsFor(fields);
    if (cmd.prepare) {
      try { values = defaultsFor(fields, (await post(cmdPath(cmd.id, 'prepare'), bodyFor(c, {}))).values); }
      catch (e) { m.setError('could not prefill: ' + e.message); }
    }
    if (m.isOpen()) paint(values);
  })();

  // Point at the field a refusal names — ours or the server's ({error, field}).
  function markField(name) {
    const input = name && Object.prototype.hasOwnProperty.call(fields, name) && slot.querySelector('[data-bc-field="' + name + '"]');
    if (!input) return;
    const row = input.closest('.bc-field');
    if (row) row.classList.add('bc-invalid');
    if (input.focus) input.focus();
  }
  async function submit(h) {
    for (const f of slot.querySelectorAll('.bc-invalid')) f.classList.remove('bc-invalid');
    const v = validateValues(fields, readForm(slot, fields));
    if (v.error) {
      h.setError(v.error);
      markField(v.field);
      return;
    }
    h.setError('');
    h.setBusy(true, 'running…');
    try {
      const res = await post(cmdPath(cmd.id, 'run'), bodyFor(c, { input: v.values }));
      h.close();
      finish(cmd, c, res);
    } catch (e) {
      h.setBusy(false);
      h.setError(e.message);
      markField(e.body && e.body.field);
    }
  }
  return m;
}
