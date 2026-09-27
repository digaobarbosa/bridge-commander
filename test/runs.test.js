'use strict';
// server/runs.js — a plugin command's shell line, run and remembered: the whole
// log on disk, tracked runs in activities.jsonl, cancel/timeout through the
// hook runner's process-group kill, and boot closing what a restart orphaned.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRuns, LOG_CAP } = require('../server/runs.js');

function tmp() { return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'bc-runs-')); }
function activities(dir) {
  let raw;
  try { raw = fs.readFileSync(path.join(dir, 'activities.jsonl'), 'utf8'); } catch (e) { return []; }
  return raw.split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch (e) { return []; } });
}
function ended(runs) { return new Promise((resolve) => { const off = runs.onEnd((r) => { off(); resolve(r); }); }); }
function spec(o) {
  return Object.assign({ plugin: 'deploy', command: 'deploy.run', title: 'Deploy', card: 'MON-1', owner: 'lt', tracked: true }, o);
}

test('a tracked run that exits 0: ok, two activity lines, the log whole, onChange on start and end', async () => {
  const dir = tmp();
  let changes = 0;
  const runs = createRuns({ stateDir: dir, log: () => {}, onChange: () => { changes++; } });
  const done = ended(runs);
  const run = runs.start(spec({ shell: 'echo hello; echo "$BC_RUN" >&2', cwd: dir }));
  assert.match(run.id, /^r-[a-z0-9]+-[0-9a-f]{4}$/);
  assert.strictEqual(run.status, 'running');
  assert.strictEqual(changes, 1);
  assert.deepStrictEqual(runs.list().map((r) => r.status), ['running']);
  const end = await done;
  assert.strictEqual(end.status, 'ok');
  assert.strictEqual(end.code, 0);
  assert.ok(end.endedAt);
  assert.strictEqual(changes, 2);
  const lines = activities(dir);
  assert.deepStrictEqual(lines.map((l) => [l.id, l.status]), [[run.id, 'running'], [run.id, 'ok']]);
  assert.strictEqual(lines[0].shell, undefined, 'the shell line stays server-side');
  const logText = runs.readLog(run.id).text;
  assert.match(logText, /hello/);
  assert.match(logText, new RegExp(run.id), 'BC_RUN names the run');
  assert.strictEqual(runs.readLog(run.id).done, true);
  assert.strictEqual(runs.get(run.id).status, 'ok');
});

test('non-zero exit is failed with the exit in error; timeout is timeout; neither throws', async () => {
  const dir = tmp();
  const runs = createRuns({ stateDir: dir, log: () => {} });
  let done = ended(runs);
  const bad = runs.start(spec({ shell: 'echo nope >&2; exit 3', cwd: dir }));
  let end = await done;
  assert.strictEqual(end.id, bad.id);
  assert.deepStrictEqual([end.status, end.code, end.error], ['failed', 3, 'exit 3']);
  done = ended(runs);
  const t0 = Date.now();
  runs.start(spec({ shell: 'sleep 30', cwd: dir, timeoutMs: 300 }));
  end = await done;
  assert.strictEqual(end.status, 'timeout');
  assert.ok(Date.now() - t0 < 5000, 'killed, not waited for');
});

test('cancel kills the whole process group and lands canceled', async () => {
  const dir = tmp();
  const runs = createRuns({ stateDir: dir, log: () => {} });
  const done = ended(runs);
  const pidFile = path.join(dir, 'child.pid');
  // A grandchild: only a group kill reaches it.
  const run = runs.start(spec({ shell: 'sleep 30 & echo $! > ' + pidFile + '; wait', cwd: dir }));
  const t0 = Date.now();
  while (!fs.existsSync(pidFile) || !fs.readFileSync(pidFile, 'utf8').trim()) {
    if (Date.now() - t0 > 5000) throw new Error('child never started');
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.strictEqual(runs.cancel(run.id), true);
  assert.strictEqual(runs.cancel(run.id), false, 'already canceling');
  const end = await done;
  assert.strictEqual(end.status, 'canceled');
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  await new Promise((r) => setTimeout(r, 100));
  assert.throws(() => process.kill(pid, 0), /ESRCH/, 'the grandchild is gone too');
  assert.strictEqual(runs.cancel(run.id), false, 'nothing left to cancel');
  assert.strictEqual(runs.cancel('r-nope-0000'), false);
});

test('subscribe streams chunks live, then end; readLog from an offset', async () => {
  const dir = tmp();
  const runs = createRuns({ stateDir: dir, log: () => {} });
  const done = ended(runs);
  const run = runs.start(spec({ shell: 'echo one; sleep 0.2; echo two', cwd: dir }));
  const chunks = [];
  let endRun = null;
  runs.subscribe(run.id, (c) => chunks.push(c), (r) => { endRun = r; });
  await done;
  assert.strictEqual(chunks.join(''), 'one\ntwo\n');
  assert.strictEqual(endRun.status, 'ok');
  const first = runs.readLog(run.id, { from: 0 });
  assert.strictEqual(first.size, 8);
  assert.strictEqual(runs.readLog(run.id, { from: 4 }).text, 'two\n');
  assert.strictEqual(runs.readLog(run.id, { from: first.size }).text, '');
  let lateEnd = null;
  runs.subscribe(run.id, () => {}, (r) => { lateEnd = r; });
  assert.strictEqual(lateEnd.status, 'ok', 'a subscriber to an ended run hears the end at once');
  assert.strictEqual(runs.readLog('../../etc/passwd'), null, 'an id is never a path');
});

test('the log is capped at 5 MB with a note, and the run still ends ok', async () => {
  const dir = tmp();
  const runs = createRuns({ stateDir: dir, log: () => {} });
  const done = ended(runs);
  // ~6 MB of output
  const run = runs.start(spec({ shell: 'head -c 6291456 /dev/zero | tr "\\0" x', cwd: dir, tracked: false }));
  const end = await done;
  assert.strictEqual(end.status, 'ok');
  const size = fs.statSync(runs.logPath(run.id)).size;
  assert.ok(size > LOG_CAP && size < LOG_CAP + 200, 'capped: ' + size);
  assert.match(runs.readLog(run.id).text.slice(-80), /truncated at 5 MB/);
});

test('untracked runs never reach the list or activities.jsonl, but get() knows them', async () => {
  const dir = tmp();
  const runs = createRuns({ stateDir: dir, log: () => {} });
  const done = ended(runs);
  const run = runs.start(spec({ shell: 'true', cwd: dir, tracked: false }));
  await done;
  assert.deepStrictEqual(runs.list(), []);
  assert.deepStrictEqual(activities(dir), []);
  assert.strictEqual(runs.get(run.id).status, 'ok');
});

test('list: running first, then newest; filtered by card; limited', async () => {
  const dir = tmp();
  let t = Date.parse('2026-01-01T00:00:00Z');
  const runs = createRuns({ stateDir: dir, log: () => {}, now: () => (t += 1000) });
  let done = ended(runs);
  const a = runs.start(spec({ shell: 'true', cwd: dir, card: 'A' }));
  await done;
  done = ended(runs);
  const b = runs.start(spec({ shell: 'true', cwd: dir, card: 'B' }));
  await done;
  const c = runs.start(spec({ shell: 'sleep 5', cwd: dir, card: 'A' }));
  assert.deepStrictEqual(runs.list().map((r) => r.id), [c.id, b.id, a.id]);
  assert.deepStrictEqual(runs.list({ card: 'A' }).map((r) => r.id), [c.id, a.id]);
  assert.deepStrictEqual(runs.list({ limit: 1 }).map((r) => r.id), [c.id]);
  done = ended(runs);
  runs.cancel(c.id);
  await done;
});

test('boot: a run still `running` in the file is closed failed "server restarted", and says so in the file', () => {
  const dir = tmp();
  const file = path.join(dir, 'activities.jsonl');
  fs.writeFileSync(file, [
    { id: 'r-a-0001', plugin: 'p', command: 'p.x', title: 'X', card: 'C', owner: 'lt', status: 'running', startedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'r-a-0001', plugin: 'p', command: 'p.x', title: 'X', card: 'C', owner: 'lt', status: 'ok', startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T00:00:01.000Z', code: 0 },
    { id: 'r-b-0002', plugin: 'p', command: 'p.x', title: 'X', card: 'C', owner: 'lt', status: 'running', startedAt: '2026-01-01T00:01:00.000Z' },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n{"torn');
  const runs = createRuns({ stateDir: dir, log: () => {} });
  const list = runs.list();
  assert.deepStrictEqual(list.map((r) => [r.id, r.status, r.error]),
    [['r-b-0002', 'failed', 'server restarted'], ['r-a-0001', 'ok', undefined]]);
  const last = activities(dir).filter((l) => l.id === 'r-b-0002').pop();
  assert.deepStrictEqual([last.status, last.error], ['failed', 'server restarted']);
  // A second boot has nothing left to close.
  const before = activities(dir).length;
  createRuns({ stateDir: dir, log: () => {} });
  assert.strictEqual(activities(dir).length, before);
});

test('a spawn that cannot start (missing cwd) is failed with the error, not a throw', async () => {
  const dir = tmp();
  const runs = createRuns({ stateDir: dir, log: () => {} });
  const done = ended(runs);
  runs.start(spec({ shell: 'true', cwd: path.join(dir, 'nope') }));
  const end = await done;
  assert.strictEqual(end.status, 'failed');
  assert.match(end.error, /ENOENT|spawn/);
});
