'use strict';
// ui/js/terminal.js — the per-browser "open in a real terminal" opener: the
// attach command, the per-mode link, and where an agent's session comes from.
// DOM-free at import, so it loads straight into Node (perms.test.js pattern).
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const mod = import(pathToFileURL(path.join(__dirname, '..', 'ui', 'js', 'terminal.js')).href);

test('attachCommand joins as a grouped session, dropped when detached, on the right window', async () => {
  const { attachCommand } = await mod;
  assert.strictEqual(attachCommand('bc-x-lt-ada', 'lt'),
    'tmux new-session -t bc-x-lt-ada \\; set destroy-unattached on \\; select-window -t lt');
  assert.strictEqual(attachCommand('ar-sdk', null), 'tmux new-session -t ar-sdk \\; set destroy-unattached on');
});

test('terminalMode: unknown or missing storage reads as off', async () => {
  const { terminalMode } = await mod;
  assert.strictEqual(terminalMode(null), 'off');
  assert.strictEqual(terminalMode('ghostty'), 'off');
  assert.strictEqual(terminalMode('iterm2'), 'iterm2');
  assert.strictEqual(terminalMode('copy'), 'copy');
});

test('terminalLink: off gives nothing; iterm2 a url-encoded command url; copy the command', async () => {
  const { terminalLink, attachCommand } = await mod;
  const t = { session: 'bc-x-lt-ada', window: 'lt' };
  assert.strictEqual(terminalLink('off', t), null);
  const { href } = terminalLink('iterm2', t);
  assert.ok(href.startsWith('iterm2:/command?c='));
  assert.strictEqual(decodeURIComponent(href.slice('iterm2:/command?c='.length)), attachCommand('bc-x-lt-ada', 'lt'));
  assert.deepStrictEqual(terminalLink('copy', t), { copy: attachCommand('bc-x-lt-ada', 'lt') });
});

test('terminalLink: a name that is not a plain tmux name gets no link at all', async () => {
  const { terminalLink } = await mod;
  assert.strictEqual(terminalLink('copy', { session: 'x; rm -rf ~' }), null);
  assert.strictEqual(terminalLink('copy', { session: 'ok', window: '$(id)' }), null);
  assert.strictEqual(terminalLink('copy', { session: '' }), null);
  assert.strictEqual(terminalLink('copy', null), null);
});

test('targets: lieutenant ref, card worker ref first, else the card session attribute + picked tab', async () => {
  const { lieutenantTarget, cardTarget } = await mod;
  assert.deepStrictEqual(lieutenantTarget({ ref: { session: 's', window: 'lt' } }), { session: 's', window: 'lt' });
  assert.strictEqual(lieutenantTarget({ name: 'no ref' }), null);
  assert.deepStrictEqual(cardTarget({ attributes: { session: 'ext' } }, { ref: { session: 's', window: 'w-c1' } }, 'x'),
    { session: 's', window: 'w-c1' });
  assert.deepStrictEqual(cardTarget({ attributes: { session: 'ext' } }, null, 'orch'), { session: 'ext', window: 'orch' });
  assert.strictEqual(cardTarget({ attributes: {} }, null, null), null);
});
