'use strict';
// harness/turnend-relay.js — both entry points (claude's Stop hook, codex's
// notify program) must produce the SAME TurnEndEvent, because the server reads
// one body shape at /api/turn-end.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { normalize, TEXT_MAX } = require('../turnend-relay.js');

// The relay trusts a codex thread only when it has a rollout (see relay()).
const SESSIONS = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-codex-sessions-'));
process.env.BC_CODEX_SESSIONS_DIR = SESSIONS;
fs.mkdirSync(path.join(SESSIONS, '2026', '09', '28'), { recursive: true });
fs.writeFileSync(path.join(SESSIONS, '2026', '09', '28', 'rollout-2026-09-28T08-00-00-thread-x.jsonl'), '');

const CLAUDE = { hook_event_name: 'Stop', session_id: 'uuid-c', cwd: '/w', last_assistant_message: ' done, waiting on review ' };
const CODEX = { type: 'agent-turn-complete', 'thread-id': 'thread-x', 'turn-id': 't1', cwd: '/w',
  'input-messages': ['go'], 'last-assistant-message': ' done, waiting on review ' };

test('normalize: claude and codex payloads become the same event', () => {
  const c = normalize('claude', CLAUDE);
  const x = normalize('codex', CODEX);
  assert.deepStrictEqual(c, { harness: 'claude', event: 'turn-end', session_id: 'uuid-c', cwd: '/w', text: 'done, waiting on review' });
  assert.deepStrictEqual(x, { harness: 'codex', event: 'turn-end', session_id: 'thread-x', cwd: '/w', text: 'done, waiting on review' });
});

test('normalize: text is capped, and absent when the agent said nothing', () => {
  assert.strictEqual(normalize('codex', { ...CODEX, 'last-assistant-message': 'z'.repeat(999) }).text.length, TEXT_MAX);
  assert.ok(!('text' in normalize('claude', { ...CLAUDE, last_assistant_message: '  ' })));
  assert.ok(!('text' in normalize('codex', { ...CODEX, 'last-assistant-message': 42 })));
});

test('normalize: claude records a boundary from an empty payload; codex drops other notify kinds', () => {
  assert.deepStrictEqual(normalize('claude', {}), { harness: 'claude', event: 'turn-end', session_id: null, cwd: null });
  assert.strictEqual(normalize('codex', { type: 'something-else', 'thread-id': 'nope' }), null);
  assert.strictEqual(normalize('codex', null), null);
  assert.throws(() => normalize('goose', {}), /unknown harness/);
});

function run(args, stdin) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.TMUX;
    delete env.BC_TURNEND_URL;
    const child = spawn(process.execPath, args, { env, stdio: ['pipe', 'ignore', 'ignore'] });
    child.stdin.end(stdin || '');
    child.on('close', resolve);
  });
}

// Bug B, end to end: the file each entry point writes carries the same keys,
// text included — the server's stall alert reads `text` off either.
test('turnend-hook.js and codex-notify.js write the same event shape', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-relay-'));
  try {
    await run([path.join(__dirname, '..', 'turnend-hook.js'), dir, 'bc-c'], JSON.stringify(CLAUDE));
    await run([path.join(__dirname, '..', 'codex-notify.js'), dir, 'bc-x', JSON.stringify(CODEX)]);
    const line = (key) => JSON.parse(fs.readFileSync(path.join(dir, key + '.turnend.jsonl'), 'utf8').trim());
    const c = line('bc-c');
    const x = line('bc-x');
    assert.deepStrictEqual(Object.keys(c).sort(), Object.keys(x).sort());
    assert.strictEqual(c.text, 'done, waiting on review');
    assert.strictEqual(x.text, 'done, waiting on review');
    assert.strictEqual(c.session, 'bc-c');
    assert.strictEqual(x.session_id, 'thread-x');
    assert.strictEqual(fs.readFileSync(path.join(dir, 'bc-x.session-id'), 'utf8'), 'thread-x\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
