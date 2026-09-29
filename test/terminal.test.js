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

test('safeAttach: the attach command for plain names, null for anything else', async () => {
  const { safeAttach, attachCommand } = await mod;
  assert.strictEqual(safeAttach({ session: 'bc-x-lt-ada', window: 'lt' }), attachCommand('bc-x-lt-ada', 'lt'));
  assert.strictEqual(safeAttach({ session: 'x; rm -rf ~' }), null);
  assert.strictEqual(safeAttach({ session: 'ok', window: '$(id)' }), null);
  assert.strictEqual(safeAttach(null), null);
});

const ID = '0f8e2c1a-3b4d-4e5f-8a9b-0c1d2e3f4a5b';
const CLI = 'agent --resume'; // any profile prefix; the real one is harness data

test('resumeCommand: cd into the quoted cwd, then the profile prefix and the uuid', async () => {
  const { resumeCommand } = await mod;
  assert.strictEqual(resumeCommand(CLI, '/Users/me/dev/proj', ID), `cd '/Users/me/dev/proj' && agent --resume ${ID}`);
  // a quote in the path closes, is escaped, and reopens; $() and spaces stay literal
  assert.strictEqual(resumeCommand(CLI, "/tmp/it's $(id) here", ID), `cd '/tmp/it'\\''s $(id) here' && agent --resume ${ID}`);
});

test('resumeCommand: a non-uuid id, a missing cwd or an unsafe prefix gives null', async () => {
  const { resumeCommand } = await mod;
  assert.strictEqual(resumeCommand(CLI, '/p', 'abc; rm -rf ~'), null);
  assert.strictEqual(resumeCommand(CLI, '/p', ID + ' x'), null);
  assert.strictEqual(resumeCommand(CLI, '/p', ''), null);
  assert.strictEqual(resumeCommand(CLI, '', ID), null);
  assert.strictEqual(resumeCommand('', '/p', ID), null);
  assert.strictEqual(resumeCommand('x; rm -rf ~ #', '/p', ID), null);
});

test('refResume: a ref resumes only when its harness has a by-hand prefix', async () => {
  const { refResume, resumeCommand } = await mod;
  assert.strictEqual(refResume({ cwd: '/p', resumeId: ID }, CLI), resumeCommand(CLI, '/p', ID));
  assert.strictEqual(refResume({ cwd: '/p', resumeId: ID }, ''), null);
  assert.strictEqual(refResume({ cwd: '/p' }, CLI), null);
  assert.strictEqual(refResume(null, CLI), null);
});

test('openerLink: any vetted command through the chosen opener; off or no command gives null', async () => {
  const { openerLink } = await mod;
  const cmd = `cd '/p' && codex resume ${ID}`;
  assert.deepStrictEqual(openerLink('iterm2', cmd), { href: 'iterm2:/command?c=' + encodeURIComponent(cmd) });
  assert.deepStrictEqual(openerLink('copy', cmd), { copy: cmd });
  assert.strictEqual(openerLink('off', cmd), null);
  assert.strictEqual(openerLink('iterm2', null), null);
});

test('appResumeLink: the profile url with the uuid in {id}; a bad url or id gives null', async () => {
  const { appResumeLink } = await mod;
  assert.strictEqual(appResumeLink({ label: 'Claude desktop', url: 'claude://resume?session={id}' }, ID), 'claude://resume?session=' + ID);
  assert.strictEqual(appResumeLink({ label: 'Codex app', url: 'codex://threads/{id}' }, ID), 'codex://threads/' + ID);
  assert.strictEqual(appResumeLink({ url: 'codex://threads/{id}' }, 'x&evil=1'), null);
  assert.strictEqual(appResumeLink({ url: 'javascript:alert(1)//{id}' }, ID), null);
  assert.strictEqual(appResumeLink({ url: 'codex://threads/' }, ID), null, 'no {id}: it would open the wrong thing');
  assert.strictEqual(appResumeLink(null, ID), null);
});
