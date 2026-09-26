'use strict';
// card.start and what it provisions: the refusals, the worktree it cuts (from
// origin's tip, pooled or plain), and the playbook frontmatter it reads on every
// start (harness, model, `requires`, `branch`). Fake harness + real throwaway
// git repos, via workers-helper.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startServerWithLieutenant, withOwner, runCli, LT } = require('./helper');
const { lieutenantSession } = require('../server/names.js');
const { workerKey, git, makeRepo, boot, boardOnDisk, writeFakeTreehouse, writePlaybook, cardEvents, rx } = require('./workers-helper');

test('cards cannot be created in Working (Working ⇔ live worker)', async () => {
  const { s, teardown } = await boot();
  try {
    const r = await s.api('POST', '/api/cards', withOwner({ title: 'Sneaky', column: 'working' }));
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /card\.start/);
    const cli = await runCli(['card', 'create', '--title', 'Sneaky CLI', '--owner', LT,
      '--column', 'working', '--workspace', s.dir, '--port', String(s.port)]);
    assert.strictEqual(cli.code, 1);
    assert.match(cli.stderr, /Working/);
  } finally { await teardown(); }
});

test('a minted card starts on bc/<id>: branch, window and worktree all follow the id', async () => {
  const { s, teardown } = await boot();
  try {
    // no id pinned — the owner mints it, and everything downstream follows it
    const card = (await s.api('POST', '/api/cards',
      { title: 'Tile click clears selection', owner: LT, playbook: 'default', attributes: { repo: 'proj' } })).body.card;
    assert.strictEqual(card.id, 'ADA-1');

    const r = await s.api('POST', '/api/cards/ADA-1/start', { harness: 'fake' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    // deliberately the id and nothing else — no title slug appended (the captain
    // reads branch names and wants them aligned with the card).
    assert.strictEqual(r.body.worker.branch, 'bc/ADA-1');
    assert.strictEqual(r.body.card.attributes.branch, 'bc/ADA-1');
    assert.strictEqual(r.body.worker.ref.window, 'w-ADA-1');
    assert.strictEqual(path.basename(r.body.worker.worktree.path), 'ADA-1');
  } finally { await teardown(); }
});

test('card.start refusals: plan cards, missing/unregistered repo, already Working', async () => {
  const { s, teardown } = await boot();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'A plan', type: 'plan', attributes: { repo: 'proj' } }));
    let r = await s.api('POST', '/api/cards/a-plan/start', { harness: 'fake' });
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /plan cards never start/);

    await s.api('POST', '/api/cards', withOwner({ title: 'No repo' }));
    r = await s.api('POST', '/api/cards/no-repo/start', { harness: 'fake' });
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /no repo attribute/);

    await s.api('POST', '/api/cards', withOwner({ title: 'Bad repo', attributes: { repo: 'nope' } }));
    r = await s.api('POST', '/api/cards/bad-repo/start', { harness: 'fake' });
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /unregistered project: nope/);

    await s.api('POST', '/api/cards', withOwner({ title: 'Task', attributes: { repo: 'proj' } }));
    assert.strictEqual((await s.api('POST', '/api/cards/task/start', { harness: 'fake' })).status, 200);
    r = await s.api('POST', '/api/cards/task/start', { harness: 'fake' });
    assert.strictEqual(r.status, 409);
    assert.match(r.body.error, /already Working/);
  } finally { await teardown(); }
});

test('card.start: worktree + spawn + bind + system move, brief contract, registry persisted', async () => {
  const { s, repo, fdir, teardown } = await boot();
  try {
    await s.api('POST', '/api/cards', withOwner({
      title: 'Fix login', id: 'fix-login', attributes: { repo: 'proj' },
      body: 'The login button 404s; make it work.',
    }));
    // captain context on the thread + a start-order (pendingOrder must clear on start)
    await s.api('POST', '/api/feedback', { target: 'card:fix-login', text: 'prioritize the mobile flow' });
    await s.api('POST', '/api/cards/fix-login/move', { column: 'working', actor: 'user' });
    assert.strictEqual((await s.api('GET', '/api/cards/fix-login')).body.pendingOrder.kind, 'start-order');

    const r = await s.api('POST', '/api/cards/fix-login/start', { harness: 'fake' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const w = r.body.worker;
    // the worker is a WINDOW inside the owning lieutenant's session; the
    // window name is w- prefixed so tmux never parses it as an index
    assert.strictEqual(w.ref.session, lieutenantSession(s.dir, LT));
    assert.strictEqual(w.ref.window, 'w-fix-login');
    const sess = workerKey(s.dir, 'fix-login');
    assert.match(sess, /^bc-[A-Za-z0-9-]+-lt-ada:w-fix-login$/);
    assert.ok(w.ref.resumeId, 'resumeId known at birth');
    assert.strictEqual(w.branch, 'bc/fix-login');
    assert.strictEqual(w.project, 'proj');

    // the card moved → Working (system move), pendingOrder cleared, attrs bound
    const card = r.body.card;
    assert.strictEqual(card.column, 'working');
    assert.strictEqual(card.pendingOrder, null);
    assert.strictEqual(card.attributes.session, sess);
    assert.strictEqual(card.attributes.worktree, w.worktree.path);
    assert.strictEqual(card.attributes.branch, 'bc/fix-login');
    const started = card.events[card.events.length - 1];
    assert.strictEqual(started.kind, 'started');
    assert.strictEqual(started.level, 2);
    assert.match(started.text, /📋 Backlog → 🔨 Working/);

    // the worktree is REAL and isolated: distinct from the clone, a genuine
    // worktree root, sharing history but not the clone's git dir
    const wt = w.worktree.path;
    assert.ok(fs.existsSync(wt));
    assert.notStrictEqual(fs.realpathSync(wt), fs.realpathSync(repo));
    assert.strictEqual(fs.realpathSync(git(wt, 'rev-parse', '--show-toplevel')), fs.realpathSync(wt));
    assert.notStrictEqual(git(wt, 'rev-parse', '--absolute-git-dir'), git(repo, 'rev-parse', '--absolute-git-dir'));
    assert.strictEqual(git(wt, 'rev-parse', 'HEAD'), git(repo, 'rev-parse', 'HEAD'));

    // the brief: the card's playbook (`default`) rendered against the card as
    // it stands — title, body, thread, branch, and the workspace-carrying CLI
    const rec = JSON.parse(fs.readFileSync(path.join(fdir, sess + '.json'), 'utf8'));
    assert.strictEqual(rec.cwd, wt);
    assert.match(rec.prompt, /^# Fix login \(fix-login\)/);
    assert.match(rec.prompt, /Load the `bridge-commander-worker` skill first/);
    assert.match(rec.prompt, /login button 404s/);
    assert.match(rec.prompt, /prioritize the mobile flow/);
    assert.match(rec.prompt, /git checkout -b bc\/fix-login/);
    assert.match(rec.prompt, /ready in branch bc\/fix-login/);
    assert.match(rec.prompt, new RegExp('--workspace ' + s.dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(rec.prompt, /\{\{/, 'every placeholder resolved');

    // the brief is auto-attached as a card artifact (label "brief"), pointing
    // at the SAME persisted prompt file the harness port treats as the
    // source of truth — and it is servable through the artifact preview endpoint
    const briefFile = path.join(s.dir, '.bridge-commander', 'harness', sess + '.prompt');
    assert.deepStrictEqual(card.attributes.artifacts, [{ uri: 'file://' + briefFile, label: 'brief', type: 'markdown' }]);
    const art = await s.api('GET', '/api/artifact?uri=' + encodeURIComponent('file://' + briefFile));
    assert.strictEqual(art.status, 200);
    assert.match(art.body.content, /^# Fix login \(fix-login\)/);

    // worker registry survives on disk (board is truth)
    const disk = boardOnDisk(s);
    assert.strictEqual(disk.workers.length, 1);
    assert.strictEqual(disk.workers[0].card, 'fix-login');
    assert.strictEqual(disk.workers[0].ref.session, lieutenantSession(s.dir, LT));
    assert.strictEqual(disk.workers[0].ref.window, 'w-fix-login');
  } finally { await teardown(); }
});

test('a worktree is cut from origin\'s tip, not from wherever the clone happens to stand', async () => {
  const { s, repo, teardown } = await boot();
  try {
    // the source moves on AFTER the project was registered — the shape of any
    // long-lived clone. Nothing pulls it, so its HEAD is now behind.
    fs.writeFileSync(path.join(repo, 'NEW.md'), 'landed after the clone\n');
    git(repo, 'add', '.');
    git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'moved on');
    const tip = git(repo, 'rev-parse', 'HEAD');
    const clone = path.join(s.dir, 'projects', 'proj');
    assert.notStrictEqual(git(clone, 'rev-parse', 'HEAD'), tip, 'the clone really is behind');

    await s.api('POST', '/api/cards', withOwner({
      title: 'Late start', id: 'late-start', attributes: { repo: 'proj' },
    }));
    const r = await s.api('POST', '/api/cards/late-start/start', { harness: 'fake' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const wt = r.body.worker.worktree.path;
    assert.strictEqual(git(wt, 'rev-parse', 'HEAD'), tip, 'the worker starts from origin\'s tip');
    assert.ok(fs.existsSync(path.join(wt, 'NEW.md')), 'files added since the clone are present');
  } finally { await teardown(); }
});

test('a pooled worktree lands on the tip the board fetched, not on the pool clone\'s stale one', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-pool-'));
  try {
    const repo = makeRepo(root);
    // the pool's clone is taken NOW and never fetches again — a June checkout
    // in somebody else's workspace, which is what backs the real pool here
    const poolClone = path.join(root, 'poolclone');
    execFileSync('git', ['clone', '-q', repo, poolClone], { stdio: ['ignore', 'pipe', 'pipe'] });
    const stale = git(poolClone, 'rev-parse', 'origin/main');

    const bin = writeFakeTreehouse(root, poolClone);
    const s = await startServerWithLieutenant({
      env: {
        BC_FAKE_STATE: path.join(root, 'fake'), BC_WORKTREE_TOOL: 'treehouse',
        PATH: bin + path.delimiter + process.env.PATH,
        BC_SUPERVISE_INTERVAL_MS: '0', BC_PRWATCH_INTERVAL_MS: '0',
      },
    });
    try {
      assert.strictEqual((await s.api('POST', '/api/projects', { source: repo, name: 'proj' })).status, 200);
      // origin moves on after both clones exist — the pool clone never learns
      fs.writeFileSync(path.join(repo, 'NEW.md'), 'pushed between starts\n');
      git(repo, 'add', '.');
      git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'moved on');
      const tip = git(repo, 'rev-parse', 'HEAD');
      assert.notStrictEqual(tip, stale, 'the pool clone really is behind');

      await s.api('POST', '/api/cards', withOwner({
        title: 'Pooled', id: 'pooled', attributes: { repo: 'proj' },
      }));
      const r = await s.api('POST', '/api/cards/pooled/start', { harness: 'fake' });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      const w = r.body.worker;
      assert.strictEqual(w.worktree.tool, 'treehouse');
      // the pooled worktree hangs off the OTHER clone — the bug's precondition
      assert.match(git(w.worktree.path, 'rev-parse', '--git-common-dir'), rx(fs.realpathSync(poolClone)));
      assert.strictEqual(git(w.worktree.path, 'rev-parse', 'HEAD'), tip,
        'the worker stands on the sha the board fetched, not the pool clone\'s origin/main');
      assert.strictEqual(w.worktree.baseSha, tip);
      assert.ok(fs.existsSync(path.join(w.worktree.path, 'NEW.md')));
      // nothing to say: the base was refreshed
      assert.deepStrictEqual((await cardEvents(s, 'pooled')).filter((e) => e.kind === 'stale-base'), []);
      // The carried tip is held by a REAL ref in the lease's own ref store, not
      // by FETCH_HEAD alone: releaseWorktree reads `--branches --tags --remotes`
      // to decide whether HEAD carries work nothing else holds, and a worker
      // that committed nothing must never look like one that did.
      assert.strictEqual(
        git(w.worktree.path, 'rev-list', '--max-count=1', 'HEAD', '--not', '--branches', '--tags', '--remotes'),
        '', 'the base is reachable from a ref, so the release is not refused');
      // and that ref is named for the CARD: refs/remotes/* is shared by every
      // worktree of the pool clone, so a per-branch name is one ref that two
      // boards on the same repo race to force-update under each other.
      assert.strictEqual(git(w.worktree.path, 'rev-parse', 'refs/remotes/bc-base/pooled'), tip);
      assert.throws(() => git(w.worktree.path, 'rev-parse', '--verify', 'refs/remotes/bc-base/main'),
        'the destination is scoped to the card, never to the branch');
      const { releaseWorktree } = require('../server/worktrees.js');
      const realPath = process.env.PATH;
      process.env.PATH = bin + path.delimiter + realPath; // the fake pool, as the server sees it
      let rel;
      try { rel = await releaseWorktree(w.worktree, path.join(s.dir, 'projects', 'proj')); }
      finally { process.env.PATH = realPath; }
      assert.strictEqual(rel.released, true, JSON.stringify(rel));
    } finally { await s.stop(); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a second start after a push to origin gets the new commit — the actual sha, plain git', async () => {
  const { s, repo, teardown } = await boot();
  try {
    const commit = (msg, file) => {
      fs.writeFileSync(path.join(repo, file), msg + '\n');
      git(repo, 'add', '.');
      git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', msg);
      return git(repo, 'rev-parse', 'HEAD');
    };
    const first = commit('before', 'ONE.md');
    await s.api('POST', '/api/cards', withOwner({ title: 'One', id: 'one', attributes: { repo: 'proj' } }));
    const r1 = await s.api('POST', '/api/cards/one/start', { harness: 'fake' });
    assert.strictEqual(git(r1.body.worker.worktree.path, 'rev-parse', 'HEAD'), first);

    const second = commit('after', 'TWO.md');
    await s.api('POST', '/api/cards', withOwner({ title: 'Two', id: 'two', attributes: { repo: 'proj' } }));
    const r2 = await s.api('POST', '/api/cards/two/start', { harness: 'fake' });
    assert.strictEqual(git(r2.body.worker.worktree.path, 'rev-parse', 'HEAD'), second,
      'the second worker starts on the commit pushed between the two starts');
    assert.strictEqual(r2.body.worker.worktree.baseSha, second);
  } finally { await teardown(); }
});

test('a fetch that fails says so on the card, at level 1 — not on a stderr nobody reads', async () => {
  const { s, teardown } = await boot();
  try {
    const clone = path.join(s.dir, 'projects', 'proj');
    git(clone, 'remote', 'set-url', 'origin', path.join(s.dir, 'gone-forever.git'));
    await s.api('POST', '/api/cards', withOwner({ title: 'Stale', id: 'stale', attributes: { repo: 'proj' } }));
    const r = await s.api('POST', '/api/cards/stale/start', { harness: 'fake' });
    assert.strictEqual(r.status, 200, 'a failed fetch never blocks the board');
    const ev = (await cardEvents(s, 'stale')).find((e) => e.kind === 'stale-base');
    assert.ok(ev, 'the timeline carries the stale base');
    assert.strictEqual(ev.level, 1);
    assert.match(ev.text, /fetch failed/);
    assert.match(ev.text, rx(clone));
  } finally { await teardown(); }
});

// A playbook is a repeatable procedure, and part of the procedure is WHAT RUNS
// IT: the playbook may open with frontmatter naming harness, model, the
// attributes it cannot work without, and whether a branch is cut. Precedence is
// explicit CLI flag > frontmatter > config default. Observed through a 'recfake'
// harness preloaded into the server process (test/recording-harness.js via
// NODE_OPTIONS) that captures the extraArgs card.start builds — the harness port
// (harness/) itself stays untouched.
test('playbook frontmatter names the harness and model; an explicit flag still wins', async () => {
  const recFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bc-rec-')), 'extraargs.json');
  const preload = path.join(__dirname, 'recording-harness.js');
  const { s, teardown } = await boot({
    NODE_OPTIONS: '--require ' + preload,
    BC_REC_EXTRAARGS: recFile,
  });
  const readExtra = () => JSON.parse(fs.readFileSync(recFile, 'utf8')).extraArgs;
  const clearExtra = () => { try { fs.unlinkSync(recFile); } catch (e) {} };
  try {
    writePlaybook(s, 'runs-on-recfake', [
      '---', 'harness: recfake', 'model: template-model', '---', '# {{CARD_TITLE}}', '',
    ].join('\n'));

    // (a) no flags: the template decides. recfake is reachable ONLY through the
    // frontmatter here, so its extraArgs file being written proves the harness
    // key fired; the --model proves the model key fired.
    await s.api('POST', '/api/cards', withOwner({
      title: 'FM A', id: 'fm-a', playbook: 'runs-on-recfake', attributes: { repo: 'proj' },
    }));
    clearExtra();
    let r = await s.api('POST', '/api/cards/fm-a/start', {});
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual(readExtra(), ['--model', 'template-model']);

    // (b) explicit --model overrides the template's model
    await s.api('POST', '/api/cards', withOwner({
      title: 'FM B', id: 'fm-b', playbook: 'runs-on-recfake', attributes: { repo: 'proj' },
    }));
    clearExtra();
    r = await s.api('POST', '/api/cards/fm-b/start', { model: 'cli-model' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual(readExtra(), ['--model', 'cli-model']);

    // (c) explicit --harness overrides the template's harness: the plain 'fake'
    // never writes the extraArgs file, so its absence is the proof.
    await s.api('POST', '/api/cards', withOwner({
      title: 'FM C', id: 'fm-c', playbook: 'runs-on-recfake', attributes: { repo: 'proj' },
    }));
    clearExtra();
    r = await s.api('POST', '/api/cards/fm-c/start', { harness: 'fake' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(fs.existsSync(recFile), false, 'the flag won: recfake never ran');
  } finally {
    await teardown();
    fs.rmSync(path.dirname(recFile), { recursive: true, force: true });
  }
});

test('a card missing a `requires` attribute is refused before ANYTHING is provisioned', async () => {
  const { s, teardown } = await boot();
  try {
    writePlaybook(s, 'needs-pr', [
      '---', 'requires: [pr_url, repo_slug]', '---', 'review {{ATTR_PR_URL}}', '',
    ].join('\n'));
    await s.api('POST', '/api/cards', withOwner({
      title: 'Review it', id: 'needy', playbook: 'needs-pr',
      attributes: { repo: 'proj', pr_url: 'https://github.com/o/r/pull/7' },
    }));
    const r = await s.api('POST', '/api/cards/needy/start', { harness: 'fake' });
    assert.strictEqual(r.status, 400, JSON.stringify(r.body));
    assert.match(r.body.error, /repo_slug/, 'the error names the missing attribute');
    assert.doesNotMatch(r.body.error, /pr_url,/, 'and only the missing one');
    // nothing was provisioned: no worktree, no worker, the card never moved
    assert.strictEqual(fs.existsSync(path.join(s.dir, '.bridge-commander', 'worktrees', 'needy')), false);
    assert.deepStrictEqual(boardOnDisk(s).workers, []);
    assert.strictEqual((await s.api('GET', '/api/cards/needy')).body.column, 'backlog');

    // set it and the same start goes through
    await s.api('PATCH', '/api/cards/needy', { attributes: { repo_slug: 'o/r' } });
    const ok = await s.api('POST', '/api/cards/needy/start', { harness: 'fake' });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
  } finally { await teardown(); }
});

// A required name is matched the way the brief would READ it, not by exact
// spelling: the template author sees the uppercase placeholder, the card
// carries the lowercase key, and both have to name one attribute.
test('`requires` matches the attribute however it is spelled, and names the card key when it is missing', async () => {
  const { s, teardown } = await boot();
  try {
    writePlaybook(s, 'needs-upper', [
      '---', 'requires: [PR_URL, Repo-Slug]', '---', 'review {{ATTR_PR_URL}}', '',
    ].join('\n'));
    await s.api('POST', '/api/cards', withOwner({
      title: 'Review it', id: 'shouty', playbook: 'needs-upper',
      attributes: { repo: 'proj', pr_url: 'https://github.com/o/r/pull/9' },
    }));
    const r = await s.api('POST', '/api/cards/shouty/start', { harness: 'fake' });
    assert.strictEqual(r.status, 400, JSON.stringify(r.body));
    // pr_url answered PR_URL, so only the genuinely missing one is named — and
    // named as the CARD needs it: an --attr Repo-Slug would earn a second
    // attribute resolving to the placeholder repo_slug already owns.
    assert.match(r.body.error, /--attr repo_slug=<value>/);
    assert.doesNotMatch(r.body.error, /PR_URL|Repo-Slug|REPO_SLUG/);

    await s.api('PATCH', '/api/cards/shouty', { attributes: { repo_slug: 'o/r' } });
    const ok = await s.api('POST', '/api/cards/shouty/start', { harness: 'fake' });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
  } finally { await teardown(); }
});

// `requires` asks whether the card CARRIES the thing, which is a different
// question from whether the thing renders: prs has no text form, and "this
// card must have PRs recorded" is still a legitimate demand from a review
// playbook. And prs is the board's to write — so the refusal names it without
// handing out an --attr recipe that would flatten the recorded list.
test('`requires` counts a recorded list as present, an empty one as missing, and offers no recipe for what the board owns', async () => {
  const { s, teardown } = await boot();
  try {
    writePlaybook(s, 'needs-prs', ['---', 'requires: [prs]', '---', 'review the PRs', ''].join('\n'));
    const pr = { url: 'https://github.com/o/r/pull/11', state: 'open' };
    await s.api('POST', '/api/cards', withOwner({
      title: 'Has PRs', id: 'haspr', playbook: 'needs-prs', attributes: { repo: 'proj', prs: [pr] },
    }));
    const ok = await s.api('POST', '/api/cards/haspr/start', { harness: 'fake' });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.deepStrictEqual(ok.body.card.attributes.prs, [pr], 'the recorded list is untouched');

    // an empty list carries nothing
    await s.api('POST', '/api/cards', withOwner({
      title: 'No PRs', id: 'nopr', playbook: 'needs-prs', attributes: { repo: 'proj', prs: [] },
    }));
    const r = await s.api('POST', '/api/cards/nopr/start', { harness: 'fake' });
    assert.strictEqual(r.status, 400, JSON.stringify(r.body));
    // anchored on the attribute: a bare /prs/ would pass on the playbook id alone
    assert.match(r.body.error, /requires the attribute prs\./, 'the refusal names the attribute');
    assert.doesNotMatch(r.body.error, /--attr prs=/, 'and never a recipe that would flatten the list');
    assert.match(r.body.error, /recorded by the board itself/);
    assert.deepStrictEqual(boardOnDisk(s).workers.filter((w) => w.card === 'nopr'), []);
  } finally { await teardown(); }
});

test('`branch: false` cuts no branch — the playbook owns the delivery contract, not the card type', async () => {
  const { s, teardown } = await boot();
  try {
    writePlaybook(s, 'no-branch', ['---', 'branch: false', '---', 'read only: {{TASK}}', ''].join('\n'));
    // an IMPLEMENTATION card — under the old rule its type alone would cut bc/<id>
    await s.api('POST', '/api/cards', withOwner({
      title: 'Just look', id: 'look', playbook: 'no-branch', attributes: { repo: 'proj' },
    }));
    const r = await s.api('POST', '/api/cards/look/start', { harness: 'fake' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.worker.branch, undefined);
    assert.strictEqual(r.body.card.attributes.branch, undefined);
    assert.strictEqual(git(r.body.worker.worktree.path, 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD',
      'detached HEAD: there is nothing to push');

    // and with no `branch` key the card type still decides, exactly as before
    writePlaybook(s, 'silent', ['# {{CARD_TITLE}}', ''].join('\n'));
    await s.api('POST', '/api/cards', withOwner({
      title: 'Ship it', id: 'shipit', playbook: 'silent', attributes: { repo: 'proj' },
    }));
    const r2 = await s.api('POST', '/api/cards/shipit/start', { harness: 'fake' });
    assert.strictEqual(r2.body.worker.branch, 'bc/shipit');
    await s.api('POST', '/api/cards', withOwner({
      title: 'Why slow', id: 'why', type: 'investigation', playbook: 'silent', attributes: { repo: 'proj' },
    }));
    const r3 = await s.api('POST', '/api/cards/why/start', { harness: 'fake' });
    assert.strictEqual(r3.body.worker.branch, undefined);
  } finally { await teardown(); }
});

// The branch is a per-START decision now, so it has to be UNSET as readily as
// it is set: everything downstream (lifecycle hooks, the rendered brief) reads
// the attribute, and a leftover from the last run points them at a branch that
// this run never cut.
test('a restart on a `branch: false` playbook clears the branch the previous run cut', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-workers-'));
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
    writePlaybook(s, 'cuts-one', ['# {{CARD_TITLE}}', ''].join('\n'));
    writePlaybook(s, 'cuts-none', ['---', 'branch: false', '---', 'read only', ''].join('\n'));
    await s.api('POST', '/api/cards', withOwner({
      title: 'Two ways', id: 'twoways', playbook: 'cuts-one', attributes: { repo: 'proj' },
    }));
    let r = await s.api('POST', '/api/cards/twoways/start', { harness: 'fake' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.card.attributes.branch, 'bc/twoways');

    await s.api('POST', '/api/cards/twoways/worker/done', { outcome: 'first pass' });
    await s.api('POST', '/api/cards/twoways/move', { column: 'review', actor: 'agent' });
    // the session dies (restart clears the in-process fake; drop its marker so
    // the next start is a fresh spawn, not a resume)
    await s.stop();
    fs.rmSync(path.join(fdir, workerKey(wsDir, 'twoways') + '.json'), { force: true });
    s = await startServerWithLieutenant({ dir: wsDir, env });

    await s.api('PATCH', '/api/cards/twoways', { playbook: 'cuts-none' });
    r = await s.api('POST', '/api/cards/twoways/start', { harness: 'fake' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.worker.branch, undefined);
    assert.strictEqual(r.body.card.attributes.branch, undefined, 'not the previous run\'s branch');
    const onDisk = boardOnDisk(s).cards.find((c) => c.id === 'twoways');
    assert.strictEqual(onDisk.attributes.branch, undefined);
  } finally {
    await s.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a malformed frontmatter block refuses the start and names the line', async () => {
  const { s, teardown } = await boot();
  try {
    writePlaybook(s, 'broken', ['---', 'harness: codex', 'hrness: claude', '---', 'body', ''].join('\n'));
    await s.api('POST', '/api/cards', withOwner({
      title: 'Bad playbook', id: 'bad-fm', playbook: 'broken', attributes: { repo: 'proj' },
    }));
    const r = await s.api('POST', '/api/cards/bad-fm/start', { harness: 'fake' });
    assert.strictEqual(r.status, 400, JSON.stringify(r.body));
    assert.match(r.body.error, /broken\.md: frontmatter line 3: unknown key "hrness"/);
    assert.deepStrictEqual(boardOnDisk(s).workers, []);
  } finally { await teardown(); }
});

// An unknown harness names the file that asked for it: the person starting the
// card is rarely the person who typed the name, and a workspace holds several
// playbooks to hunt through.
test('an unknown harness from the frontmatter names the playbook it came from', async () => {
  const { s, teardown } = await boot();
  try {
    writePlaybook(s, 'typo-harness', ['---', 'harness: codx', '---', 'body', ''].join('\n'));
    await s.api('POST', '/api/cards', withOwner({
      title: 'Typo', id: 'typo-h', playbook: 'typo-harness', attributes: { repo: 'proj' },
    }));
    let r = await s.api('POST', '/api/cards/typo-h/start', {});
    assert.strictEqual(r.status, 400, JSON.stringify(r.body));
    assert.match(r.body.error, /codx/);
    assert.match(r.body.error, /from playbook .*typo-harness\.md/);

    // the flag won, so the playbook did not ask: none named back
    r = await s.api('POST', '/api/cards/typo-h/start', { harness: 'nosuchharness' });
    assert.strictEqual(r.status, 400, JSON.stringify(r.body));
    assert.doesNotMatch(r.body.error, /from playbook/);
    assert.deepStrictEqual(boardOnDisk(s).workers, []);
  } finally { await teardown(); }
});

// There is ONE way for a card to start: the card's playbook, read on every
// start. `--command` was the second one, and it is gone — the flag has to fail
// at the CLI's own front door rather than slide in as a positional.
test('--command is gone: the CLI refuses the flag outright', async () => {
  const { s, teardown } = await boot();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Runner', id: 'runner', attributes: { repo: 'proj' } }));
    const cli = await runCli(['card', 'start', 'runner', '--command', 'node bin/thing.js',
      '--workspace', s.dir, '--port', String(s.port)]);
    assert.notStrictEqual(cli.code, 0);
    assert.match(cli.stderr, /unknown flag --command/);
    // and nothing was started behind it
    assert.deepStrictEqual(boardOnDisk(s).workers, []);
  } finally {
    await teardown();
  }
});

// The wire has no unknown-flag guard, so it says it itself. A caller that asks
// for the second way must not quietly get the first one: spawning an agent on
// the playbook is not what it asked for, and silence would let old callers keep
// believing the launcher is there.
test('--command is gone: the API refuses the field by name', async () => {
  const { s, teardown } = await boot();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Runner', id: 'apirunner', attributes: { repo: 'proj' } }));
    const r = await s.api('POST', '/api/cards/apirunner/start', { command: 'node bin/thing.js' });
    assert.strictEqual(r.status, 400, JSON.stringify(r.body));
    assert.match(r.body.error, /--command was removed/);
    assert.match(r.body.error, /--playbook/);
    assert.deepStrictEqual(boardOnDisk(s).workers, []);
  } finally {
    await teardown();
  }
});
