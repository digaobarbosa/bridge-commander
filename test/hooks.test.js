'use strict';
// Hooks — the workspace's own executable scripts under .bridge-commander/hooks/.
//
// Lifecycle hooks live in hooks/<event>/ and run on worker-done / worker-died /
// card-archived, alphabetical, sequential, context via BC_* env, fire-and-
// forget (per-hook timeout then kill). Results land as timeline events:
// hook-ran (level 2) / hook-failed (level 1 — the bell). The one ordering
// guarantee: card-archived hooks finish BEFORE the worktree release.
//
// Named hooks are executable files DIRECTLY in hooks/: nothing fires them but a
// caller. Directory means event, file means name, and listHooks() only ever
// reads the directories, so the two cannot collide. `bc-axi hook run <name>`,
// the board's ▶ and a schedule are the three callers: one code path, and the
// trace line is identical but for which one it was.
//
// The trace is .bridge-commander/hookruns.jsonl, written by the RUNNER — so the
// lifecycle hooks a workspace already had land in it too and stop being
// invisible — and read back from the TAIL.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { runHooks, runNamedHook, runTeardown, listAllHooks, listHooks, readRuns } = require('../server/hooks.js');
const { startServerWithLieutenant, startServer, withOwner, runCli, sleep, LT } = require('./helper');
const { lieutenantSession, workerWindow } = require('../server/names.js');

// A worker's harness key: a WINDOW in its lieutenant's session — the form the
// fake harness's marker files carry, so a test can make a session dead.
function workerKey(dir, cardId) {
  return lieutenantSession(dir, LT) + ':' + workerWindow(cardId);
}

// event '' writes a named hook (a file directly in hooks/); any other event
// writes a lifecycle hook into hooks/<event>/.
function writeHook(ws, event, name, body, mode = 0o755) {
  const dir = path.join(ws, '.bridge-commander', 'hooks', event);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  fs.chmodSync(file, mode);
  return file;
}
function shHook(ws, event, name, script, mode) {
  return writeHook(ws, event, name, '#!/bin/sh\n' + script + '\n', mode);
}

function scratchWs() { return fs.mkdtempSync(path.join(os.tmpdir(), 'bc-hooks-')); }
function runsFile(ws) { return path.join(ws, '.bridge-commander', 'hookruns.jsonl'); }
function lines(ws) {
  return fs.readFileSync(runsFile(ws), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

async function until(what, fn, ms = 6000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('timeout waiting for: ' + what);
    await sleep(50);
  }
}

// ================= unit: server/hooks.js against a scratch workspace =================

// ---------- runHooks: the lifecycle runner ----------

test('runHooks: missing hooks dir is a no-op', async () => {
  const ws = scratchWs();
  try {
    assert.deepStrictEqual(await runHooks('worker-done', { workspace: ws }), []);
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test('runHooks: happy run — BC_* env visible, exit 0, output captured, cwd = workspace', async () => {
  const ws = scratchWs();
  try {
    shHook(ws, 'worker-done', 'env.sh',
      'echo "$BC_EVENT|$BC_CARD|$BC_REPO|$BC_WORKTREE|$BC_BRANCH" > env.out\necho hello');
    const results = await runHooks('worker-done',
      { workspace: ws, card: 'c1', repo: '/r', worktree: '/w', branch: 'bc/c1' });
    assert.strictEqual(results.length, 1);
    assert.deepStrictEqual(
      { hook: results[0].hook, ok: results[0].ok, code: results[0].code, output: results[0].output },
      { hook: 'env.sh', ok: true, code: 0, output: 'hello' });
    // env.out written relative to cwd — the workspace root
    assert.strictEqual(fs.readFileSync(path.join(ws, 'env.out'), 'utf8').trim(),
      'worker-done|c1|/r|/w|bc/c1');
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test('runHooks: empty string for N/A context fields', async () => {
  const ws = scratchWs();
  try {
    shHook(ws, 'card-archived', 'env.sh', 'printf "%s|%s" "$BC_WORKTREE" "$BC_BRANCH" > env.out');
    await runHooks('card-archived', { workspace: ws, card: 'c1' });
    assert.strictEqual(fs.readFileSync(path.join(ws, 'env.out'), 'utf8'), '|');
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test('runHooks: alphabetical order, sequential; non-executable skipped silently', async () => {
  const ws = scratchWs();
  try {
    // written in non-alphabetical order on purpose
    shHook(ws, 'worker-done', '20-second.sh', 'echo second >> order.out');
    shHook(ws, 'worker-done', '10-first.sh', 'echo first >> order.out');
    shHook(ws, 'worker-done', '15-skipme.sh', 'echo NEVER >> order.out', 0o644); // not executable
    const results = await runHooks('worker-done', { workspace: ws, card: 'c1' });
    assert.deepStrictEqual(results.map((r) => r.hook), ['10-first.sh', '20-second.sh']);
    assert.strictEqual(fs.readFileSync(path.join(ws, 'order.out'), 'utf8'), 'first\nsecond\n');
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

// The runner is shared by lifecycle and named hooks (runOne + traceRun), so a
// failure, a timeout and a broken interpreter are each pinned once.
test('runHooks: failing hook reports ok:false + exit code and is traced; later hooks still run', async () => {
  const ws = scratchWs();
  try {
    shHook(ws, 'worker-done', '1-bad.sh', 'echo boom >&2\nexit 3');
    shHook(ws, 'worker-done', '2-good.sh', 'exit 0');
    const results = await runHooks('worker-done', { workspace: ws, card: 'c1' }); // resolves — a bad exit is a RESULT
    assert.deepStrictEqual(results.map((r) => [r.hook, r.ok, r.code, r.timedOut]),
      [['1-bad.sh', false, 3, false], ['2-good.sh', true, 0, false]]);
    assert.strictEqual(results[0].output, 'boom'); // stderr captured too
    assert.deepStrictEqual(lines(ws).map((r) => [r.hook, r.ok, r.code, r.output]),
      [['1-bad.sh', false, 3, 'boom'], ['2-good.sh', true, 0, '']], 'the exit code and output tail are on the trace');
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test('runHooks: output capped at a few KB', async () => {
  const ws = scratchWs();
  try {
    shHook(ws, 'worker-done', 'noisy.sh', 'i=0; while [ $i -lt 2000 ]; do echo aaaaaaaaaaaaaaaa; i=$((i+1)); done');
    const results = await runHooks('worker-done', { workspace: ws, card: 'c1' });
    assert.strictEqual(results[0].ok, true);
    assert.ok(results[0].output.length <= 4096, 'capped');
    assert.strictEqual(results[0].truncated, true);
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

// ---------- the namespace ----------

test('directory means event, file means name — the two live in one hooks/ and never collide', async () => {
  const ws = scratchWs();
  try {
    shHook(ws, '', 'gh-watch', 'echo named');
    shHook(ws, 'worker-done', 'sweep.sh', 'echo lifecycle');
    assert.deepStrictEqual(listAllHooks(ws).map((h) => [h.name, h.event]),
      [['gh-watch', ''], ['sweep.sh', 'worker-done']]);
    // the lifecycle side is unchanged: worker-done still runs its own dir, and
    // the named hook sitting one level up is not part of any event
    const r = await runHooks('worker-done', { workspace: ws, card: 'c1' });
    assert.deepStrictEqual(r.map((x) => [x.hook, x.output]), [['sweep.sh', 'lifecycle']]);
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test('a non-executable file in hooks/ is not a named hook, and neither is a name that is not an id', async () => {
  const ws = scratchWs();
  try {
    const f = shHook(ws, '', 'inert', 'echo nope');
    fs.chmodSync(f, 0o644);
    shHook(ws, '', 'real', 'echo yes');
    assert.deepStrictEqual(listAllHooks(ws).map((h) => h.name), ['real']);
    await assert.rejects(() => runNamedHook(ws, 'inert', {}), (e) => e.code === 'ENOHOOK');
    await assert.rejects(() => runNamedHook(ws, '../real', {}), (e) => e.code === 'ENOHOOK');
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

// The listing is what the tab and `hook list` read, and every row it prints
// carries a ✎ that goes through the artifact gate — which matches the board's id
// shape. A lifecycle hook the gate would refuse is left off the listing rather
// than offered with a pencil that 404s; the RUNNER is untouched and still runs
// whatever the workspace installed.
test('a lifecycle hook whose name the editor gate would refuse is not listed — but still runs', async () => {
  const ws = scratchWs();
  try {
    shHook(ws, 'worker-done', '10 deploy.sh', 'echo spacey');
    shHook(ws, 'worker-done', 'sweep.sh', 'echo fine');
    assert.deepStrictEqual(listAllHooks(ws).map((h) => [h.name, h.event]), [['sweep.sh', 'worker-done']]);
    assert.deepStrictEqual(listHooks(ws, 'worker-done').map((f) => path.basename(f)),
      ['10 deploy.sh', 'sweep.sh'], 'the runner still sees both');
    const r = await runHooks('worker-done', { workspace: ws, card: 'c1' });
    assert.deepStrictEqual(r.map((x) => x.output), ['spacey', 'fine']);
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test('an unknown name is an error naming the hooks directory, never a silent success', async () => {
  const ws = scratchWs();
  try {
    shHook(ws, '', 'real', 'echo yes');
    await assert.rejects(() => runNamedHook(ws, 'ghost', {}), (e) => {
      assert.strictEqual(e.code, 'ENOHOOK');
      assert.match(e.message, /no hook "ghost"/);
      assert.ok(e.message.includes(path.join(ws, '.bridge-commander', 'hooks')), 'the directory is named');
      return true;
    });
    assert.ok(!fs.existsSync(runsFile(ws)), 'and nothing was traced for a hook that never ran');
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

// ---------- env and the trace ----------

test('a named hook gets its OWN name in BC_EVENT, empty card context, and bc-axi on its PATH', async () => {
  const ws = scratchWs();
  try {
    shHook(ws, '', 'gh-watch',
      'echo "$BC_EVENT|$BC_CARD|$BC_WORKTREE|$BC_BRANCH" > env.out\n'
      + 'command -v bc-axi > cli.out');
    const run = await runNamedHook(ws, 'gh-watch', {});
    assert.strictEqual(run.ok, true);
    assert.strictEqual(fs.readFileSync(path.join(ws, 'env.out'), 'utf8').trim(), 'gh-watch|||');
    assert.match(fs.readFileSync(path.join(ws, 'cli.out'), 'utf8').trim(), /bc-axi$/,
      'a hook is bash with the board CLI on its PATH — that is the whole API');
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

// The PATH guarantee is *reachable*, not *mine*: a `bc-axi` the operator put
// earlier on PATH is the one that runs. Shadowing it would make a hook resolve
// a name differently from the shell he tested it in.
test('the CLI is APPENDED to PATH, so an operator-installed bc-axi still wins', async () => {
  const ws = scratchWs();
  const mine = path.join(ws, 'bin');
  const savedPath = process.env.PATH;
  try {
    fs.mkdirSync(mine, { recursive: true });
    fs.writeFileSync(path.join(mine, 'bc-axi'), '#!/bin/sh\necho operator\n');
    fs.chmodSync(path.join(mine, 'bc-axi'), 0o755);
    process.env.PATH = mine + path.delimiter + savedPath;
    shHook(ws, '', 'which-cli', 'command -v bc-axi > cli.out');
    const run = await runNamedHook(ws, 'which-cli', {});
    assert.strictEqual(run.ok, true);
    assert.strictEqual(fs.readFileSync(path.join(ws, 'cli.out'), 'utf8').trim(),
      path.join(mine, 'bc-axi'), 'the board makes its CLI reachable, it does not take the name');
  } finally {
    process.env.PATH = savedPath;
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('a card supplied by the caller fills BC_CARD/BC_WORKTREE/BC_BRANCH', async () => {
  const ws = scratchWs();
  try {
    shHook(ws, '', 'ctx', 'echo "$BC_CARD|$BC_WORKTREE|$BC_BRANCH" > env.out');
    await runNamedHook(ws, 'ctx', { card: 'MNC-9', worktree: '/w', branch: 'bc/MNC-9' });
    assert.strictEqual(fs.readFileSync(path.join(ws, 'env.out'), 'utf8').trim(), 'MNC-9|/w|bc/MNC-9');
    assert.strictEqual(lines(ws)[0].card, 'MNC-9');
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test('a lifecycle hook firing appends a trace line with trigger = its event', async () => {
  const ws = scratchWs();
  try {
    shHook(ws, 'worker-done', 'sweep.sh', 'echo swept');
    shHook(ws, 'card-archived', 'bury.sh', 'echo buried');
    await runHooks('worker-done', { workspace: ws, card: 'c1' });
    await runHooks('card-archived', { workspace: ws, card: 'c1' });
    assert.deepStrictEqual(lines(ws).map((r) => [r.hook, r.trigger, r.card, r.ok, r.code]), [
      ['sweep.sh', 'worker-done', 'c1', true, 0],
      ['bury.sh', 'card-archived', 'c1', true, 0],
    ]);
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test('a hook that hangs past the timeout lands timedOut with what it managed to say', async () => {
  const ws = scratchWs();
  try {
    shHook(ws, '', 'hang', 'echo starting\nsleep 30');
    const t0 = Date.now();
    const run = await runNamedHook(ws, 'hang', {}, { timeoutMs: 300 });
    assert.ok(Date.now() - t0 < 5000, 'did not wait for the sleep');
    assert.strictEqual(run.timedOut, true);
    assert.strictEqual(run.ok, false);
    const rec = lines(ws)[0];
    assert.strictEqual(rec.timedOut, true);
    assert.match(rec.output, /starting/, 'the output tail is on the line');
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test('a broken interpreter is a traced failure, not a crash', async () => {
  const ws = scratchWs();
  try {
    writeHook(ws, '', 'broken', '#!/no/such/interpreter\necho hi\n');
    const run = await runNamedHook(ws, 'broken', {});
    assert.strictEqual(run.ok, false);
    assert.ok(run.error, 'the spawn failure is on the record');
    assert.ok(lines(ws)[0].error, 'and on the trace line');
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

// ---------- one run per name ----------

test('a second run of a name already in flight is refused, naming the one that is running', async () => {
  const ws = scratchWs();
  try {
    shHook(ws, '', 'slow', 'sleep 1');
    const first = runNamedHook(ws, 'slow', { card: 'MNC-1' }, { trigger: 'schedule' });
    await sleep(150);
    await assert.rejects(() => runNamedHook(ws, 'slow', {}, { trigger: 'board' }), (e) => {
      assert.strictEqual(e.code, 'EBUSY');
      assert.match(e.message, /already running/);
      assert.match(e.message, /trigger schedule/, 'it says WHAT is running');
      assert.match(e.message, /card MNC-1/);
      return true;
    });
    await first;
    // …and once it is done the name is free again
    const again = await runNamedHook(ws, 'slow', {}, { trigger: 'board', timeoutMs: 300 });
    assert.ok(again, 'the lock released with the run');
    assert.strictEqual(lines(ws).length, 2, 'the refusal traced nothing — it never ran');
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

// ---------- reading the trace off the tail ----------

test('readRuns answers off the TAIL — a huge trace is never loaded whole', async () => {
  const ws = scratchWs();
  try {
    fs.mkdirSync(path.join(ws, '.bridge-commander'), { recursive: true });
    // ~3MB of history, then the three runs anybody cares about
    const filler = [];
    for (let i = 0; i < 12000; i++) {
      filler.push(JSON.stringify({ hook: 'old', trigger: 'cli', card: '', started: '2020-01-01T00:00:00.000Z',
        ms: 1, code: 0, ok: true, timedOut: false, output: 'x'.repeat(200) }));
    }
    fs.writeFileSync(runsFile(ws), filler.join('\n') + '\n');
    for (const [hook, code] of [['a', 0], ['b', 3], ['a', 0]]) {
      fs.appendFileSync(runsFile(ws), JSON.stringify({ hook, trigger: 'cli', card: '',
        started: '2026-01-01T00:00:00.000Z', ms: 5, code, ok: code === 0, timedOut: false, output: '' }) + '\n');
    }
    assert.ok(fs.statSync(runsFile(ws)).size > 2e6, 'the trace is genuinely large');

    // The proof, not a stopwatch: slurping the file is the thing readRuns must
    // not do, so make slurping the file impossible.
    const real = fs.readFileSync;
    fs.readFileSync = () => { throw new Error('readRuns read the whole file'); };
    let newest, mine;
    try {
      newest = readRuns(ws, { limit: 3 });
      mine = readRuns(ws, { hook: 'b', limit: 5 });
    } finally { fs.readFileSync = real; }

    assert.deepStrictEqual(newest.map((r) => [r.hook, r.code]), [['a', 0], ['b', 3], ['a', 0]].reverse());
    assert.deepStrictEqual(mine.map((r) => r.hook), ['b']);
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test('a torn line is skipped, and the rest of the trace still reads', async () => {
  const ws = scratchWs();
  try {
    fs.mkdirSync(path.join(ws, '.bridge-commander'), { recursive: true });
    fs.writeFileSync(runsFile(ws),
      JSON.stringify({ hook: 'a', trigger: 'cli', code: 0, ok: true }) + '\n'
      + '{"hook":"torn","trig\n'
      + JSON.stringify({ hook: 'c', trigger: 'cli', code: 0, ok: true }) + '\n');
    assert.deepStrictEqual(readRuns(ws, { limit: 10 }).map((r) => r.hook), ['c', 'a']);
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

// ---------- runTeardown: a playbook's teardown ----------
// The per-playbook counterpart of a hook: the command that stops what THAT
// playbook's run started, run in the worktree immediately before the release.
// Best effort in every direction — the release makes its own decision, as it
// always has.

test('runTeardown: a shell command line, cwd = the worktree, BC_* env, BC_EVENT=teardown', async () => {
  const ws = scratchWs();
  try {
    const wt = path.join(ws, 'wt');
    fs.mkdirSync(wt);
    const r = await runTeardown('echo "$BC_EVENT|$BC_CARD|$BC_BRANCH" > env.out && pwd && echo stopped',
      { workspace: ws, card: 'c1', repo: '/r', worktree: wt, branch: 'bc/c1' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.code, 0);
    assert.match(r.output, /stopped/);
    assert.ok(r.ms >= 0, 'the run is timed');
    // written relative to cwd — the worktree, not the workspace
    assert.strictEqual(fs.readFileSync(path.join(wt, 'env.out'), 'utf8').trim(), 'teardown|c1|bc/c1');
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test('runTeardown: non-zero exit and a timeout are RESULTS, never throws', async () => {
  const ws = scratchWs();
  try {
    const bad = await runTeardown('echo down the drain >&2; exit 4', { workspace: ws, card: 'c1' });
    assert.deepStrictEqual([bad.ok, bad.code], [false, 4]);
    assert.strictEqual(bad.output, 'down the drain');

    const t0 = Date.now();
    const hung = await runTeardown('sleep 30', { workspace: ws, card: 'c1' }, { timeoutMs: 300 });
    assert.ok(Date.now() - t0 < 5000, 'did not wait for the sleep');
    assert.deepStrictEqual([hung.ok, hung.timedOut], [false, true]);
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test('runTeardown: output keeps the TAIL — where a teardown gives up is the end', async () => {
  const ws = scratchWs();
  try {
    const r = await runTeardown(
      'i=0; while [ $i -lt 2000 ]; do echo aaaaaaaaaaaaaaaa; i=$((i+1)); done; echo LAST-LINE',
      { workspace: ws, card: 'c1' });
    assert.strictEqual(r.truncated, true);
    assert.ok(r.output.length <= 4096, 'capped');
    assert.match(r.output, /LAST-LINE$/, 'the tail survived, not the head');
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

// ================= integration: through a real server =================

function makeRepo(root) {
  const repo = path.join(root, 'srcrepo');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: ['ignore', 'pipe', 'pipe'] });
  fs.writeFileSync(path.join(repo, 'README.md'), 'hi\n');
  execFileSync('git', ['-C', repo, 'add', '.'], { stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  return repo;
}

async function bootWithProject(extraEnv = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-hooks-int-'));
  const repo = makeRepo(root);
  const s = await startServerWithLieutenant({
    env: Object.assign({
      BC_FAKE_STATE: path.join(root, 'fake'), BC_WORKTREE_TOOL: 'git',
      BC_SUPERVISE_INTERVAL_MS: '0', BC_PRWATCH_INTERVAL_MS: '0',
    }, extraEnv),
  });
  await s.api('POST', '/api/projects', { source: repo, name: 'proj' });
  const teardown = async () => { await s.stop(); fs.rmSync(root, { recursive: true, force: true }); };
  return { s, root, teardown };
}

// ---------- lifecycle hooks fire on card events ----------

test('worker-done hooks: env context from the worker record, hook-ran level-2 card event', async () => {
  const { s, root, teardown } = await bootWithProject();
  try {
    const out = path.join(root, 'wd-env.out');
    shHook(s.dir, 'worker-done', 'capture.sh',
      'echo "$BC_EVENT|$BC_CARD|$BC_REPO|$BC_WORKTREE|$BC_BRANCH" > ' + JSON.stringify(out) + '\necho swept');
    await s.api('POST', '/api/cards', withOwner({ title: 'Hooked', id: 'hooked', attributes: { repo: 'proj' } }));
    const w = (await s.api('POST', '/api/cards/hooked/start', { harness: 'fake' })).body.worker;
    await s.api('POST', '/api/cards/hooked/worker/done', { outcome: 'all done' });

    const ev = await until('hook-ran event on the card', async () => {
      const c = (await s.api('GET', '/api/cards/hooked')).body;
      return (c.events || []).find((e) => e.kind === 'hook-ran');
    });
    assert.strictEqual(ev.level, 2);
    assert.match(ev.text, /capture\.sh/);
    assert.match(ev.text, /exit 0/);
    assert.match(ev.text, /swept/); // trimmed output included
    const project = path.join(s.dir, 'projects', 'proj');
    assert.strictEqual(fs.readFileSync(out, 'utf8').trim(),
      'worker-done|hooked|' + project + '|' + w.worktree.path + '|bc/hooked');
  } finally { await teardown(); }
});

test('worker-done failing hook: hook-failed level-1 card event + hook-failed QueueItem to the owner', async () => {
  const { s, teardown } = await bootWithProject();
  try {
    shHook(s.dir, 'worker-done', 'bad.sh', 'echo teardown exploded >&2\nexit 7');
    await s.api('POST', '/api/cards', withOwner({ title: 'Bad hook', id: 'bad-hook', attributes: { repo: 'proj' } }));
    await s.api('POST', '/api/cards/bad-hook/start', { harness: 'fake' });
    await s.api('POST', '/api/cards/bad-hook/worker/done', { outcome: 'done anyway' });

    const ev = await until('hook-failed event on the card', async () => {
      const c = (await s.api('GET', '/api/cards/bad-hook')).body;
      return (c.events || []).find((e) => e.kind === 'hook-failed');
    });
    assert.strictEqual(ev.level, 1, 'the bell — the captain must see hook failures');
    assert.match(ev.text, /bad\.sh/);
    assert.match(ev.text, /exit 7/);
    assert.match(ev.text, /teardown exploded/);
    const items = (await s.api('GET', '/api/feed?lieutenant=' + LT)).body.items;
    assert.ok(items.some((i) => i.kind === 'hook-failed' && i.card === 'bad-hook'));
  } finally { await teardown(); }
});

test('worker-done with no hooks dir: lifecycle unaffected, no hook events', async () => {
  const { s, teardown } = await bootWithProject();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Plain', id: 'plain', attributes: { repo: 'proj' } }));
    await s.api('POST', '/api/cards/plain/start', { harness: 'fake' });
    const r = await s.api('POST', '/api/cards/plain/worker/done', { outcome: 'fin' });
    assert.strictEqual(r.status, 200);
    await sleep(400);
    const c = (await s.api('GET', '/api/cards/plain')).body;
    assert.ok(!c.events.some((e) => e.kind === 'hook-ran' || e.kind === 'hook-failed'));
    assert.ok(c.events.some((e) => e.kind === 'worker-done'));
  } finally { await teardown(); }
});

test('hook timeout: BC_HOOK_TIMEOUT_MS override, hook-failed says timed out, lifecycle unharmed', async () => {
  const { s, teardown } = await bootWithProject({ BC_HOOK_TIMEOUT_MS: '300' });
  try {
    shHook(s.dir, 'worker-done', 'hang.sh', 'sleep 30');
    await s.api('POST', '/api/cards', withOwner({ title: 'Hang', id: 'hang', attributes: { repo: 'proj' } }));
    await s.api('POST', '/api/cards/hang/start', { harness: 'fake' });
    await s.api('POST', '/api/cards/hang/worker/done', { outcome: 'fin' });
    const ev = await until('timed-out hook-failed event', async () => {
      const c = (await s.api('GET', '/api/cards/hang')).body;
      return (c.events || []).find((e) => e.kind === 'hook-failed');
    });
    assert.match(ev.text, /hang\.sh/);
    assert.match(ev.text, /timed out/);
  } finally { await teardown(); }
});

test('worker-died hooks fire from the supervision loop', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-hooks-died-'));
  const nowIso = new Date().toISOString();
  const wt = path.join(root, 'wt');
  fs.mkdirSync(wt, { recursive: true });
  const s = await startServer({
    env: { BC_FAKE_STATE: path.join(root, 'fake'), BC_SUPERVISE_INTERVAL_MS: '150', BC_PRWATCH_INTERVAL_MS: '0' },
    seed: (dir) => {
      const sd = path.join(dir, '.bridge-commander');
      fs.mkdirSync(sd, { recursive: true });
      fs.writeFileSync(path.join(sd, 'board.json'), JSON.stringify({
        title: 'seeded', seq: 0, labels: [], reads: {}, kinds: {}, events: [],
        lieutenants: [{ id: 'ada', name: 'Ada', color: '#58b6ff', chat: [], created: nowIso }],
        projects: [{ name: 'proj', path: path.join(root, 'proj'), added: nowIso }],
        cards: [{
          id: 'doomed', title: 'Doomed', type: 'implementation', owner: 'ada', column: 'working',
          labels: [], attributes: { repo: 'proj' }, body: '', created: nowIso, updated: nowIso,
          threadStart: null, pendingOrder: null, events: [], thread: [],
        }],
        // no fake session marker exists -> dead on the first tick
        workers: [{ card: 'doomed', ref: { harness: 'fake', session: 'bc-w-doomed', cwd: '/tmp', resumeId: 'x' },
          worktree: { path: wt, tool: 'git' }, branch: 'bc/doomed', project: 'proj', spawnedAt: nowIso, done: false }],
      }, null, 2));
    },
  });
  try {
    const out = path.join(root, 'died-env.out');
    shHook(s.dir, 'worker-died', 'capture.sh',
      'echo "$BC_EVENT|$BC_CARD|$BC_WORKTREE|$BC_BRANCH" > ' + JSON.stringify(out));
    const ev = await until('hook-ran after worker-died', async () => {
      const c = (await s.api('GET', '/api/cards/doomed')).body;
      return (c.events || []).find((e) => e.kind === 'hook-ran');
    });
    assert.match(ev.text, /worker-died hook capture\.sh ok/);
    assert.ok((await s.api('GET', '/api/cards/doomed')).body.events.some((e) => e.kind === 'worker-died'));
    assert.strictEqual(fs.readFileSync(out, 'utf8').trim(), 'worker-died|doomed|' + wt + '|bc/doomed');
  } finally {
    await s.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('card-archived hooks (manual archive): board-level events with a card ref; worktree released after them', async () => {
  const { s, root, teardown } = await bootWithProject();
  try {
    const out = path.join(root, 'arch-env.out');
    shHook(s.dir, 'card-archived', 'capture.sh',
      'if [ -d "$BC_WORKTREE" ]; then echo "worktree-present"; else echo "worktree-gone"; fi > ' + JSON.stringify(out));
    await s.api('POST', '/api/cards', withOwner({ title: 'Kill me', id: 'kill-me', attributes: { repo: 'proj' } }));
    const w = (await s.api('POST', '/api/cards/kill-me/start', { harness: 'fake' })).body.worker;
    const r = await s.api('POST', '/api/cards/kill-me/archive', { reason: 'killed', actor: 'user' });
    assert.strictEqual(r.status, 200);

    // the archived card can't take timeline events — they land on the board
    // stream with a card reference instead of being dropped
    const ev = await until('board-level hook-ran', async () => {
      const b = (await s.api('GET', '/api/board')).body;
      return b.events.find((e) => e.kind === 'hook-ran' && e.card === 'kill-me');
    });
    assert.strictEqual(ev.cardTitle, 'Kill me');
    assert.match(ev.text, /card-archived hook capture\.sh ok/);
    // archive is the backstop release: the hook saw the worktree in place, and
    // only then did it go
    assert.strictEqual(fs.readFileSync(out, 'utf8').trim(), 'worktree-present');
    await until('worktree released after the hooks', async () => !fs.existsSync(w.worktree.path));
  } finally { await teardown(); }
});

// The handoff usually released the worktree long before the card is archived:
// a hook must be told N/A (the empty string), not handed a path that is gone.
test('card-archived hooks on a handed-off card: BC_WORKTREE is empty, not a released path', async () => {
  const { s, root, teardown } = await bootWithProject();
  try {
    const out = path.join(root, 'released-env.out');
    shHook(s.dir, 'card-archived', 'capture.sh',
      'echo "[$BC_WORKTREE]" > ' + JSON.stringify(out));
    await s.api('POST', '/api/cards', withOwner({ title: 'Handed off', id: 'handed', attributes: { repo: 'proj' } }));
    const w = (await s.api('POST', '/api/cards/handed/start', { harness: 'fake' })).body.worker;
    await s.api('POST', '/api/cards/handed/worker/done', { outcome: 'shipped' });
    await s.api('POST', '/api/cards/handed/move', { column: 'review', actor: 'agent' });
    // the move answers before the release lands — it queues behind the per-clone lock
    await until('the handoff released it', async () => !fs.existsSync(w.worktree.path));

    const r = await s.api('POST', '/api/cards/handed/archive', { reason: 'merged', actor: 'user' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    await until('card-archived hook ran', async () => fs.existsSync(out));
    assert.strictEqual(fs.readFileSync(out, 'utf8').trim(), '[]');
  } finally { await teardown(); }
});

test('card-archived hooks run BEFORE the worktree release on the merged-PR path', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-hooks-merge-'));
  const repo = makeRepo(root);
  // gh stub: every PR is MERGED
  const stub = path.join(root, 'gh-stub');
  fs.writeFileSync(stub, '#!/usr/bin/env node\nconsole.log(JSON.stringify({ state: "MERGED", mergedAt: "2026-01-01T00:00:00Z" }));\n');
  fs.chmodSync(stub, 0o755);
  const s = await startServerWithLieutenant({
    env: {
      BC_FAKE_STATE: path.join(root, 'fake'), BC_WORKTREE_TOOL: 'git',
      BC_SUPERVISE_INTERVAL_MS: '0', BC_PRWATCH_INTERVAL_MS: '200', BC_GH_CMD: stub,
    },
  });
  try {
    await s.api('POST', '/api/projects', { source: repo, name: 'proj' });
    const out = path.join(root, 'wt-check.out');
    shHook(s.dir, 'card-archived', 'check.sh',
      'if [ -d "$BC_WORKTREE" ]; then echo "worktree-present"; else echo "worktree-gone"; fi > ' + JSON.stringify(out));
    await s.api('POST', '/api/cards', withOwner({ title: 'Merge me', id: 'merge-me', attributes: { repo: 'proj' } }));
    const w = (await s.api('POST', '/api/cards/merge-me/start', { harness: 'fake' })).body.worker;
    await s.api('POST', '/api/cards/merge-me/worker/done',
      { outcome: 'PR: https://github.com/acme/proj/pull/1' });

    await until('card archived on merge', async () =>
      (await s.api('GET', '/api/cards/merge-me')).status === 404);
    // the hook ran while the worktree still existed; the release still happened after
    assert.strictEqual(fs.readFileSync(out, 'utf8').trim(), 'worktree-present');
    assert.ok(!fs.existsSync(w.worktree.path), 'worktree released after the hooks');
    const b = (await s.api('GET', '/api/board')).body;
    assert.ok(b.events.some((e) => e.kind === 'hook-ran' && e.card === 'merge-me'));
  } finally {
    await s.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------- named hooks: the three callers ----------

test('CLI and board produce identical trace lines but for the trigger', async () => {
  const s = await startServerWithLieutenant();
  try {
    shHook(s.dir, '', 'gh-watch', 'echo checked');
    const cli = await runCli(['hook', 'run', 'gh-watch', '--workspace', s.dir, '--port', String(s.port)]);
    assert.strictEqual(cli.code, 0, cli.stderr);
    assert.match(cli.stdout, /checked/);
    assert.match(cli.stdout, /exit 0/);

    const board = await s.api('POST', '/api/hooks/run', { name: 'gh-watch', trigger: 'board' });
    assert.strictEqual(board.status, 200, JSON.stringify(board.body));

    const [a, b] = lines(s.dir);
    assert.strictEqual(a.trigger, 'cli');
    assert.strictEqual(b.trigger, 'board');
    const same = (r) => ({ hook: r.hook, card: r.card, ok: r.ok, code: r.code, timedOut: r.timedOut, output: r.output });
    assert.deepStrictEqual(same(a), same(b), 'the trigger is the ONLY difference');
    assert.deepStrictEqual(same(a),
      { hook: 'gh-watch', card: '', ok: true, code: 0, timedOut: false, output: 'checked' });
  } finally { await s.stop(); }
});

test('hook run over the CLI: a failing hook exits 1 and the trace says why; a busy name is refused', async () => {
  const s = await startServerWithLieutenant();
  try {
    shHook(s.dir, '', 'boom', 'echo nope >&2\nexit 4');
    // Three seconds, where the in-process refusal test upstairs needs one: this
    // assertion has to outlive a COLD node spawning the CLI — config read, port
    // resolution, the request — before the 409 can be observed at all. The two
    // tests do not pay the same cost, so they do not carry the same margin.
    // Three seconds of wall in one test is nothing; a flake costs an hour every
    // time it fires, on a branch whose author has no reason to suspect it.
    shHook(s.dir, '', 'slow', 'sleep 3');
    const ws = ['--workspace', s.dir, '--port', String(s.port)];

    const bad = await runCli(['hook', 'run', 'boom', ...ws]);
    assert.strictEqual(bad.code, 1, 'the caller inherits the hook’s failure');
    assert.match(bad.stdout, /exit 4/);

    const ghost = await runCli(['hook', 'run', 'ghost', ...ws]);
    assert.strictEqual(ghost.code, 1);
    assert.match(ghost.stderr, /no hook "ghost"/);

    const inFlight = s.api('POST', '/api/hooks/run', { name: 'slow', trigger: 'schedule' });
    await sleep(200);
    const clash = await runCli(['hook', 'run', 'slow', ...ws]);
    assert.strictEqual(clash.code, 1);
    assert.match(clash.stderr, /already running/);
    await inFlight;
  } finally { await s.stop(); }
});

test('hook list and hook runs read the workspace and the trace', async () => {
  const s = await startServerWithLieutenant();
  try {
    shHook(s.dir, '', 'gh-watch', 'echo checked');
    shHook(s.dir, 'worker-done', 'sweep.sh', 'exit 0');
    const ws = ['--workspace', s.dir, '--port', String(s.port)];

    let list = await runCli(['hook', 'list', ...ws]);
    assert.match(list.stdout, /gh-watch\tnamed\tnever ran/);
    assert.match(list.stdout, /sweep\.sh\tworker-done\tnever ran/);

    await runCli(['hook', 'run', 'gh-watch', '--trigger', 'cron', ...ws]);
    list = await runCli(['hook', 'list', ...ws]);
    assert.match(list.stdout, /gh-watch\tnamed\tran .* · exit 0/);
    assert.match(list.stdout, /sweep\.sh\tworker-done\tnever ran/, 'a run of one is not a run of the other');

    const runs = await runCli(['hook', 'runs', ...ws]);
    assert.match(runs.stdout, /gh-watch\s+cron\s+exit 0/);
    const mine = await runCli(['hook', 'runs', 'sweep.sh', ...ws]);
    assert.match(mine.stdout, /no runs recorded for sweep\.sh/);
  } finally { await s.stop(); }
});

test('hook run --card hands the hook the card’s real worktree and branch', async () => {
  const s = await startServerWithLieutenant();
  try {
    const out = path.join(s.dir, 'ctx.out');
    shHook(s.dir, '', 'ctx', 'echo "$BC_CARD|$BC_BRANCH" > ' + JSON.stringify(out));
    await s.api('POST', '/api/cards', withOwner({ title: 'Watched', id: 'watched' }));
    const r = await runCli(['hook', 'run', 'ctx', '--card', 'watched',
      '--workspace', s.dir, '--port', String(s.port)]);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.strictEqual(fs.readFileSync(out, 'utf8').trim(), 'watched|');

    const unknown = await s.api('POST', '/api/hooks/run', { name: 'ctx', card: 'nope' });
    assert.strictEqual(unknown.status, 404);
  } finally { await s.stop(); }
});

test('GET /api/hooks: every hook, its kind, and its newest trace line', async () => {
  const s = await startServerWithLieutenant();
  try {
    shHook(s.dir, '', 'gh-watch', 'exit 2');
    shHook(s.dir, 'worker-done', 'sweep.sh', 'exit 0');
    await s.api('POST', '/api/hooks/run', { name: 'gh-watch', trigger: 'board' });
    const r = await s.api('GET', '/api/hooks');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.dir, path.join(s.dir, '.bridge-commander', 'hooks'));
    const by = Object.fromEntries(r.body.hooks.map((h) => [h.name, h]));
    assert.strictEqual(by['gh-watch'].event, '');
    assert.deepStrictEqual([by['gh-watch'].last.trigger, by['gh-watch'].last.code, by['gh-watch'].last.ok],
      ['board', 2, false]);
    assert.strictEqual(by['sweep.sh'].event, 'worker-done');
    assert.strictEqual(by['sweep.sh'].last, null, 'it has not fired');
  } finally { await s.stop(); }
});

// ---------- a playbook's teardown at the release points ----------

function writePlaybook(s, id, text) {
  const dir = path.join(s.dir, '.bridge-commander', 'playbooks');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, id + '.md'), text);
  return id;
}

test('teardown runs at the handoff, in the worktree, and lands an event even when it worked', async () => {
  const { s, root, teardown } = await bootWithProject();
  try {
    const out = path.join(root, 'td-env.out');
    // writes OUTSIDE the worktree: a teardown that dirties the checkout would
    // make the release refuse, which is a different test
    writePlaybook(s, 'containered', ['---',
      'teardown: printf "%s|%s|%s" "$BC_EVENT" "$BC_CARD" "$(pwd)" > ' + out + '; echo container down',
      '---', 'work in a container', ''].join('\n'));
    await s.api('POST', '/api/cards', withOwner({
      title: 'Containered', id: 'td-ok', playbook: 'containered', attributes: { repo: 'proj' } }));
    const w = (await s.api('POST', '/api/cards/td-ok/start', { harness: 'fake' })).body.worker;
    assert.strictEqual(w.teardown, 'printf "%s|%s|%s" "$BC_EVENT" "$BC_CARD" "$(pwd)" > ' + out + '; echo container down');
    await s.api('POST', '/api/cards/td-ok/worker/done', { outcome: 'shipped' });
    await sleep(300);
    assert.ok(!fs.existsSync(out), 'nothing torn down yet — done hands the diff to the lieutenant');

    await s.api('POST', '/api/cards/td-ok/move', { column: 'review', actor: 'agent' });
    const ev = await until('the teardown lands an event on the card', async () => {
      const c = (await s.api('GET', '/api/cards/td-ok')).body;
      return (c.events || []).find((e) => /^teardown /.test(e.text));
    });
    assert.strictEqual(ev.kind, 'hook-ran');
    assert.strictEqual(ev.level, 2);
    assert.match(ev.text, /exit 0/);
    assert.match(ev.text, /\d+\.\ds\)/, 'how long it took');
    assert.match(ev.text, /container down/, 'the tail of its output');
    assert.strictEqual(fs.readFileSync(out, 'utf8').trim(), 'teardown|td-ok|' + w.worktree.path);
    // ...and the release still happened, after it
    await until('worktree released after the teardown', async () => !fs.existsSync(w.worktree.path));
  } finally { await teardown(); }
});

test('a teardown that exits non-zero rings the bell and the release runs anyway', async () => {
  const { s, teardown } = await bootWithProject();
  try {
    writePlaybook(s, 'brokendown', ['---', 'teardown: echo could not stop it >&2; exit 9', '---', 'x', ''].join('\n'));
    await s.api('POST', '/api/cards', withOwner({
      title: 'Broken teardown', id: 'td-bad', playbook: 'brokendown', attributes: { repo: 'proj' } }));
    const w = (await s.api('POST', '/api/cards/td-bad/start', { harness: 'fake' })).body.worker;
    await s.api('POST', '/api/cards/td-bad/worker/done', { outcome: 'shipped' });
    await s.api('POST', '/api/cards/td-bad/move', { column: 'review', actor: 'agent' });

    const ev = await until('the failure is on the timeline', async () => {
      const c = (await s.api('GET', '/api/cards/td-bad')).body;
      return (c.events || []).find((e) => /^teardown /.test(e.text));
    });
    assert.strictEqual(ev.kind, 'hook-failed');
    assert.strictEqual(ev.level, 1, 'the bell');
    assert.match(ev.text, /exit 9/);
    assert.match(ev.text, /could not stop it/);
    const items = (await s.api('GET', '/api/feed?lieutenant=' + LT)).body.items;
    assert.ok(items.some((i) => i.kind === 'hook-failed' && i.card === 'td-bad'));
    // a user's broken script must never wedge a card
    await until('the release ran regardless', async () => !fs.existsSync(w.worktree.path));
  } finally { await teardown(); }
});

test('a teardown that hangs is killed at the timeout, and the release still runs', async () => {
  const { s, teardown } = await bootWithProject({ BC_TEARDOWN_TIMEOUT_MS: '500' });
  try {
    writePlaybook(s, 'hangs', ['---', 'teardown: sleep 60', '---', 'x', ''].join('\n'));
    await s.api('POST', '/api/cards', withOwner({
      title: 'Hanging teardown', id: 'td-hang', playbook: 'hangs', attributes: { repo: 'proj' } }));
    const w = (await s.api('POST', '/api/cards/td-hang/start', { harness: 'fake' })).body.worker;
    await s.api('POST', '/api/cards/td-hang/worker/done', { outcome: 'shipped' });
    await s.api('POST', '/api/cards/td-hang/move', { column: 'review', actor: 'agent' });

    const ev = await until('the timeout is on the timeline', async () => {
      const c = (await s.api('GET', '/api/cards/td-hang')).body;
      return (c.events || []).find((e) => /^teardown /.test(e.text));
    });
    assert.strictEqual(ev.kind, 'hook-failed');
    assert.match(ev.text, /timed out/);
    await until('the release ran regardless', async () => !fs.existsSync(w.worktree.path));
  } finally { await teardown(); }
});

test('`keep_worktree: true` runs neither the teardown nor the release; archive runs both', async () => {
  const { s, root, teardown } = await bootWithProject();
  try {
    const out = path.join(root, 'kept-td.out');
    writePlaybook(s, 'keptdown', ['---', 'keep_worktree: true',
      'teardown: echo stopped >> ' + out, '---', 'rework me', ''].join('\n'));
    await s.api('POST', '/api/cards', withOwner({
      title: 'Kept', id: 'td-kept', playbook: 'keptdown', attributes: { repo: 'proj' } }));
    const w = (await s.api('POST', '/api/cards/td-kept/start', { harness: 'fake' })).body.worker;
    await s.api('POST', '/api/cards/td-kept/worker/done', { outcome: 'first pass' });
    await s.api('POST', '/api/cards/td-kept/move', { column: 'review', actor: 'agent' });
    await sleep(500);
    assert.ok(fs.existsSync(w.worktree.path), 'the checkout is kept for the rework');
    assert.ok(!fs.existsSync(out), 'and so is its container — the teardown never ran');

    // archive is the backstop for both: nothing is left to rework
    await s.api('POST', '/api/cards/td-kept/archive', { reason: 'killed' });
    await until('released at archive', async () => !fs.existsSync(w.worktree.path));
    assert.strictEqual(fs.readFileSync(out, 'utf8').trim(), 'stopped');
  } finally { await teardown(); }
});

test('`keep_worktree: true` + teardown: the handoff runs neither, the RESTART runs both', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-hooks-redo-'));
  const repo = makeRepo(root);
  const wsDir = path.join(root, 'ws');
  fs.mkdirSync(wsDir);
  const fdir = path.join(root, 'fake');
  const env = {
    BC_FAKE_STATE: fdir, BC_WORKTREE_TOOL: 'git',
    BC_SUPERVISE_INTERVAL_MS: '0', BC_PRWATCH_INTERVAL_MS: '0',
  };
  let s = await startServerWithLieutenant({ dir: wsDir, env });
  try {
    await s.api('POST', '/api/projects', { source: repo, name: 'proj' });
    const out = path.join(root, 'redo-td.out');
    writePlaybook(s, 'keptdown', ['---', 'keep_worktree: true',
      'teardown: echo "stopped in $(pwd)" >> ' + out, '---', 'rework me', ''].join('\n'));
    await s.api('POST', '/api/cards', withOwner({
      title: 'Redo', id: 'td-redo', playbook: 'keptdown', attributes: { repo: 'proj' } }));
    const first = (await s.api('POST', '/api/cards/td-redo/start', { harness: 'fake' })).body.worker;
    await s.api('POST', '/api/cards/td-redo/worker/done', { outcome: 'first pass' });
    await s.api('POST', '/api/cards/td-redo/move', { column: 'review', actor: 'agent' });
    await sleep(500);
    assert.ok(fs.existsSync(first.worktree.path), 'the checkout is kept for the rework');
    assert.ok(!fs.existsSync(out), 'and its container with it — the handoff ran neither');

    // the session dies (a live one is never spawned over), then the rework
    // restart — the moment that checkout is actually destroyed
    await s.stop();
    fs.rmSync(path.join(fdir, workerKey(wsDir, 'td-redo') + '.json'), { force: true });
    s = await startServerWithLieutenant({ dir: wsDir, env });
    const r = await s.api('POST', '/api/cards/td-redo/start', { harness: 'fake' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));

    // the teardown ran, in the OLD checkout, before it went
    assert.strictEqual(fs.readFileSync(out, 'utf8').trim(), 'stopped in ' + first.worktree.path);
    const ev = (await s.api('GET', '/api/cards/td-redo')).body.events
      .find((e) => /^teardown /.test(e.text));
    assert.ok(ev, 'and said so on the timeline');
    assert.strictEqual(ev.kind, 'hook-ran');

    // ...and the release followed it: one linked worktree, the new worker's
    const clone = path.join(wsDir, 'projects', 'proj');
    const wtList = execFileSync('git', ['-C', clone, 'worktree', 'list'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim().split('\n').filter(Boolean);
    assert.strictEqual(wtList.length, 2, 'clone + exactly one linked worktree:\n' + wtList.join('\n'));
    assert.ok(fs.existsSync(r.body.worker.worktree.path), 'new worktree provisioned');
  } finally {
    await s.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a teardown that FAILED is retried at the next release point; one that succeeded is not', async () => {
  const { s, root, teardown } = await bootWithProject();
  try {
    const out = path.join(root, 'retry.out');
    // leaves the checkout dirty on its way out, so the release refuses and the
    // worktree — and its container — are still there for the next attempt
    writePlaybook(s, 'wedged', ['---',
      'teardown: echo ran >> ' + out + '; echo still up > leftover.txt; exit 3',
      '---', 'x', ''].join('\n'));
    await s.api('POST', '/api/cards', withOwner({
      title: 'Wedged', id: 'td-retry', playbook: 'wedged', attributes: { repo: 'proj' } }));
    const w = (await s.api('POST', '/api/cards/td-retry/start', { harness: 'fake' })).body.worker;
    await s.api('POST', '/api/cards/td-retry/worker/done', { outcome: 'shipped' });
    await s.api('POST', '/api/cards/td-retry/move', { column: 'review', actor: 'agent' });

    await until('the release is refused, and says why', async () => {
      const c = (await s.api('GET', '/api/cards/td-retry')).body;
      return (c.events || []).find((e) => /^worktree kept \(/.test(e.text));
    });
    assert.strictEqual(fs.readFileSync(out, 'utf8'), 'ran\n', 'once so far');
    assert.ok(fs.existsSync(w.worktree.path), 'the checkout stayed');

    // a failure never spends the card's only attempt — archive is the next
    // release point, and it tries again
    const ar = await s.api('POST', '/api/cards/td-retry/archive', { reason: 'killed', note: 'giving up' });
    assert.strictEqual(ar.status, 200, JSON.stringify(ar.body));
    await until('the teardown ran again', async () => fs.readFileSync(out, 'utf8') === 'ran\nran\n');
  } finally { await teardown(); }
});

test('the handoff teardown does not run a second time when the card is archived', async () => {
  const { s, root, teardown } = await bootWithProject();
  try {
    const out = path.join(root, 'once.out');
    writePlaybook(s, 'oncedown', ['---', 'teardown: echo ran >> ' + out, '---', 'x', ''].join('\n'));
    await s.api('POST', '/api/cards', withOwner({
      title: 'Once', id: 'td-once', playbook: 'oncedown', attributes: { repo: 'proj' } }));
    const w = (await s.api('POST', '/api/cards/td-once/start', { harness: 'fake' })).body.worker;
    await s.api('POST', '/api/cards/td-once/worker/done', { outcome: 'shipped' });
    await s.api('POST', '/api/cards/td-once/move', { column: 'review', actor: 'agent' });
    await until('released at the handoff', async () => !fs.existsSync(w.worktree.path));

    await s.api('POST', '/api/cards/td-once/archive', { reason: 'merged' });
    await sleep(500);
    assert.strictEqual(fs.readFileSync(out, 'utf8'), 'ran\n', 'nothing left to tear down');
  } finally { await teardown(); }
});

test('no teardown key: the handoff behaves exactly as it does today', async () => {
  const { s, teardown } = await bootWithProject();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Plain', id: 'td-none', attributes: { repo: 'proj' } }));
    const w = (await s.api('POST', '/api/cards/td-none/start', { harness: 'fake' })).body.worker;
    assert.strictEqual(w.teardown, undefined);
    await s.api('POST', '/api/cards/td-none/worker/done', { outcome: 'shipped' });
    await s.api('POST', '/api/cards/td-none/move', { column: 'review', actor: 'agent' });
    await until('worktree released', async () => !fs.existsSync(w.worktree.path));
    const c = (await s.api('GET', '/api/cards/td-none')).body;
    assert.ok(!(c.events || []).some((e) => /^teardown /.test(e.text)));
  } finally { await teardown(); }
});
