'use strict';
// playbooks.js — a playbook is a markdown file the USER owns, rendered against
// the card at card.start into the worker's brief. The unit tests pin the
// renderer: which playbook wins, what a placeholder resolves to, and what
// happens to one that resolves to nothing. The server tests at the bottom pin
// the seam: which playbook a card gets, when it is read, and what happens when
// a card has none.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  workerBrief, render, listPlaybooks, resolvePlaybook, playbooksDir, seedPlaybooksAndDuties, parsePlaybook,
  briefVars, PACKAGED_PLAYBOOKS_DIR, PACKAGED_SKILL_DIR, FM_KEYS, PLACEHOLDERS, FRONTMATTER,
} = require('../server/playbooks.js');
const { startServerWithProject, withOwner, runCli, LT } = require('./helper');
const { lieutenantSession, workerWindow } = require('../server/layout.js');

function tmpState(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-playbooks-'));
  const bd = path.join(dir, 'playbooks');
  fs.mkdirSync(bd, { recursive: true });
  for (const [name, body] of Object.entries(files || {})) fs.writeFileSync(path.join(bd, name), body);
  return dir;
}

function brief(template, overrides = {}) {
  return workerBrief(Object.assign({
    template,
    card: { id: 'MON-9', title: 'Demo card', type: 'implementation', body: 'do the thing', attributes: {} },
    thread: [],
    project: { name: 'proj', path: '/repos/proj' },
    worktree: '/wt/MON-9',
    branch: 'bc/MON-9',
    workspace: '/ws',
    stateDir: '/ws/.bridge-commander',
    cli: 'bc-axi',
  }, overrides));
}

// ---------- the playbook list ----------

test('playbooks come from the workspace first, packaged second; README is not one', () => {
  const dir = tmpState({ 'house-style.md': '# ours\n', 'README.md': 'docs, not a playbook\n' });
  const ids = listPlaybooks(dir);
  assert.ok(ids.includes('house-style'), 'the workspace playbook lists');
  assert.ok(ids.includes('default'), 'a packaged playbook the workspace never seeded still lists');
  assert.ok(ids.includes('no-mistakes'));
  assert.ok(!ids.includes('README'), 'README documents the folder — it is not a playbook');
  assert.deepStrictEqual(ids, [...ids].sort(), 'sorted, so the dropdown is stable');
  assert.strictEqual(resolvePlaybook(dir, 'README'), '', 'and it never resolves as an id either');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a workspace file wins over the packaged one of the same name — an upgrade never overwrites an edit', () => {
  const dir = tmpState({ 'default.md': 'MY default\n' });
  assert.strictEqual(resolvePlaybook(dir, 'default'), path.join(playbooksDir(dir), 'default.md'));
  assert.strictEqual(fs.readFileSync(resolvePlaybook(dir, 'default'), 'utf8'), 'MY default\n');
  // one it has NOT overridden still resolves, to the packaged copy
  assert.strictEqual(resolvePlaybook(dir, 'investigation'),
    path.join(PACKAGED_PLAYBOOKS_DIR, 'investigation.md'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an unknown id resolves to nothing, and so does a path dressed up as one', () => {
  const dir = tmpState({});
  assert.strictEqual(resolvePlaybook(dir, 'nope'), '');
  assert.strictEqual(resolvePlaybook(dir, ''), '');
  assert.strictEqual(resolvePlaybook(dir, '../../etc/passwd'), '');
  assert.strictEqual(resolvePlaybook(dir, 'sub/dir'), '');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- frontmatter ----------
//
// A playbook is a repeatable procedure, and part of the procedure is what RUNS
// it. The block is four optional keys and deliberately not yaml — what is
// pinned here is that a playbook without one is untouched, and that everything
// the parser does not understand becomes an error naming the line rather than
// a guess.

test('no frontmatter = the body is the file, untouched', () => {
  const md = '# Title\n\nnot frontmatter: this is prose\n';
  assert.deepStrictEqual(parsePlaybook(md), { meta: {}, body: md });
  assert.deepStrictEqual(parsePlaybook(''), { meta: {}, body: '' });
  // a --- that is not on line 1 is a horizontal rule, not an opening delimiter
  const rule = 'intro\n\n---\nharness: codex\n---\n';
  assert.deepStrictEqual(parsePlaybook(rule), { meta: {}, body: rule });
});

test('the six keys parse to their types, and the body starts after the closing ---', () => {
  const { meta, body } = parsePlaybook([
    '---',
    'harness: codex',
    'model: gpt-5.6-sol',
    'requires: [pr_url, pr_number, repo_slug]',
    'branch: false',
    'keep_worktree: true',
    'teardown: .claude/skills/devcontainer/cli.sh down',
    '---',
    '',
    '# The brief',
  ].join('\n'));
  assert.deepStrictEqual(meta, {
    harness: 'codex',
    model: 'gpt-5.6-sol',
    requires: ['pr_url', 'pr_number', 'repo_slug'],
    branch: false,
    keep_worktree: true,
    teardown: '.claude/skills/devcontainer/cli.sh down',
  });
  assert.strictEqual(body, '# The brief'); // the blank line under the block is not the brief
});

test('the small mercies: blank lines, quotes, an empty list, a lone required name', () => {
  const { meta } = parsePlaybook([
    '---',
    'harness: claude',
    '',
    "model: 'claude-opus-5'",
    'requires: [] ',
    'branch: true',
    '---',
    'body',
  ].join('\n'));
  assert.deepStrictEqual(meta, { harness: 'claude', model: 'claude-opus-5', requires: [], branch: true });
  assert.deepStrictEqual(parsePlaybook('---\nrequires: pr_url\n---\nb').meta.requires, ['pr_url']);
  // a teardown carries flags and quotes like any command line
  assert.strictEqual(parsePlaybook('---\nteardown: "docker compose down -v"\n---\nb').meta.teardown,
    'docker compose down -v');
});

test('a malformed block fails with the offending line named', () => {
  const bad = (lines, re) => assert.throws(() => parsePlaybook(lines.join('\n')), re);
  bad(['---', 'harness: codex', 'this is prose', '---', 'b'], /line 3: expected `key: value`.*this is prose/);
  bad(['---', 'hraness: codex', '---', 'b'], /line 2: unknown key "hraness"/);
  bad(['---', 'branch: nope', '---', 'b'], /line 2: branch takes true or false/);
  bad(['---', 'keep_worktree: yes', '---', 'b'], /line 2: keep_worktree takes true or false/);
  bad(['---', 'harness: [a, b]', '---', 'b'], /line 2: harness takes a name/);
  // teardown is a command line, so the check is only that there IS one — a
  // flag or a list is not a command anyone meant to run
  bad(['---', 'teardown: true', '---', 'b'], /line 2: teardown takes a shell command.*true/);
  bad(['---', 'teardown: [a, b]', '---', 'b'], /line 2: teardown takes a shell command/);
  bad(['---', 'teardown:', '---', 'b'], /line 2: "teardown" has no value/);
  bad(['---', 'harness: true', '---', 'b'], /line 2: harness takes a name/);
  bad(['---', 'model:', '---', 'b'], /line 2: "model" has no value/);
  bad(['---', 'requires: [pr_url, ]', '---', 'b'], /line 2: empty item in the list/);
  bad(['---', 'requires: [pr url]', '---', 'b'], /line 2: requires takes attribute names/);
  // not coerced into the attribute literally named "true": a scalar that is
  // not a name is an error, the same as everything else the block cannot read
  bad(['---', 'requires: true', '---', 'b'], /line 2: requires takes attribute names.*true/);
  bad(['---', 'requires: false', '---', 'b'], /line 2: requires takes attribute names.*false/);
  bad(['---', 'harness: codex', 'harness: claude', '---', 'b'], /line 3: "harness" is set twice/);
  bad(['---', 'harness: codex'], /never closed/);
  // the everyday version of "never closed": the brief itself runs into the block
  bad(['---', 'harness: codex', '# the brief'], /line 3: expected `key: value`.*is that one missing/);
  // a map is well-formed and simply unsupported — saying "unclosed list" would
  // point the author at a fix for a problem they do not have
  bad(['---', 'requires: {a: 1}', '---', 'b'], /line 2: a map is not supported here/);
  bad(['---', 'requires: [pr_url', '---', 'b'], /line 2: unclosed list/);
});

// A first line of `---` is an opening delimiter here and a horizontal rule in
// every playbook written before this existed, so both ways the block can fail
// have to name the way out — the line alone leaves the author guessing.
test('a block opened by a first-line --- says how to make it a rule again', () => {
  const hint = /horizontal rule.*heading or a blank line above it/;
  assert.throws(() => parsePlaybook(['---', 'harness: codex'].join('\n')), hint);
  assert.throws(() => parsePlaybook(['---', '***', '---', 'b'].join('\n')), hint);
});

test('every packaged playbook has a parseable block, and investigation is the one that cuts no branch', () => {
  for (const f of fs.readdirSync(PACKAGED_PLAYBOOKS_DIR)) {
    if (!f.endsWith('.md') || f === 'README.md') continue;
    const { meta } = parsePlaybook(fs.readFileSync(path.join(PACKAGED_PLAYBOOKS_DIR, f), 'utf8'));
    const want = f === 'investigation.md' ? { branch: false } : {};
    assert.deepStrictEqual(meta, want, f + ' frontmatter');
  }
});

// ---------- rendering ----------

test('every documented placeholder resolves, and nothing is left unrendered', () => {
  const out = brief([
    '{{CARD_ID}} | {{CARD_TITLE}} | {{PROJECT}} | {{PROJECT_PATH}}',
    '{{WORKTREE}} | {{BRANCH}} | {{WORKSPACE}} | {{CLI}} | {{REPORT_FILE}}',
    '{{TASK}}',
  ].join('\n'));
  assert.strictEqual(out, [
    'MON-9 | Demo card | proj | /repos/proj',
    '/wt/MON-9 | bc/MON-9 | /ws | bc-axi --workspace /ws | /ws/.bridge-commander/reports/MON-9.md',
    'do the thing',
  ].join('\n'));
  assert.doesNotMatch(out, /\{\{/);
});

test('the packaged playbooks render with no {{ left in them', () => {
  for (const f of fs.readdirSync(PACKAGED_PLAYBOOKS_DIR)) {
    if (!f.endsWith('.md') || f === 'README.md') continue;
    const out = brief(fs.readFileSync(path.join(PACKAGED_PLAYBOOKS_DIR, f), 'utf8'), {
      card: {
        id: 'MON-9', title: 'Demo card', type: 'implementation', body: 'do the thing',
        attributes: { pr_url: 'https://x/1', pr_number: '1', repo_slug: 'o/r' },
      },
    });
    assert.doesNotMatch(out, /\{\{/, f + ' left a placeholder unrendered');
  }
});

test('an unknown placeholder is left EXACTLY as written — a typo has to be visible', () => {
  const out = brief('{{CARD_ID}} {{CRAD_ID}} {{NOT_A_THING}}');
  assert.strictEqual(out, 'MON-9 {{CRAD_ID}} {{NOT_A_THING}}');
});

test('{{ATTR_<NAME>}} reads card attributes; one that does not exist stays literal', () => {
  const out = brief('{{ATTR_PR_URL}} | {{ATTR_REPO}} | {{ATTR_NOPE}}', {
    card: { id: 'MON-9', title: 't', type: 'implementation', body: 'b',
      attributes: { pr_url: 'https://github.com/o/r/pull/7', repo: 'proj' } },
  });
  assert.strictEqual(out, 'https://github.com/o/r/pull/7 | proj | {{ATTR_NOPE}}');
});

test('a structured attribute has no text form, so it stays literal rather than printing [object Object]', () => {
  const out = brief('{{ATTR_ARTIFACTS}}', {
    card: { id: 'MON-9', title: 't', type: 'implementation', body: 'b',
      attributes: { artifacts: [{ uri: 'file:///x', label: 'brief' }] } },
  });
  assert.strictEqual(out, '{{ATTR_ARTIFACTS}}');
});

test('{{TASK}} is the card body, overridden by the lieutenant\'s brief-file text, and never empty', () => {
  assert.strictEqual(brief('{{TASK}}'), 'do the thing');
  assert.strictEqual(brief('{{TASK}}', { task: 'do THIS instead' }), 'do THIS instead');
  // an empty body falls back to the title: a brief with no task in it is useless
  assert.strictEqual(brief('{{TASK}}', { card: { id: 'MON-9', title: 'Demo card', body: '' } }), 'Demo card');
});

test('{{THREAD}} carries its own heading, and renders to nothing when the thread is empty', () => {
  assert.strictEqual(brief('{{THREAD}}'), '');
  const out = brief('{{THREAD}}', {
    thread: [
      { author: 'user', text: 'ship it behind a flag' },
      { author: 'monica', text: 'two lines\nsecond one' },
      { author: 'user', text: '   ' }, // blank messages are not context
    ],
  });
  assert.match(out, /^## Card thread/m);
  assert.match(out, /- user: ship it behind a flag/);
  assert.match(out, /- monica: two lines\n {2}second one/);
  assert.doesNotMatch(out, /- user: {3}/);
});

test('{{BRANCH}} is empty for a card with no branch (an investigation), not the string "null"', () => {
  assert.strictEqual(brief('[{{BRANCH}}]', { branch: '' }), '[]');
});

test('{{CLI}} carries --workspace, so a playbook can paste it in front of any verb', () => {
  const out = brief('{{CLI}} worker done {{CARD_ID}} --outcome "x"');
  assert.strictEqual(out, 'bc-axi --workspace /ws worker done MON-9 --outcome "x"');
});

test('render() substitutes only what it was given, and leaves the rest alone', () => {
  assert.strictEqual(render('a {{X}} b {{Y}}', { X: '1' }), 'a 1 b {{Y}}');
  assert.strictEqual(render('{{x}} {{X_1}}', { X_1: 'ok' }), '{{x}} ok'); // lowercase is not a placeholder name we set
});

// ---------- seeding a workspace (workspace.init) ----------

test('init seeds COPIES of the playbooks and never overwrites one the user edited', () => {
  const dir = tmpState({ 'default.md': 'MY default, do not touch\n' });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-home-'));
  const first = seedPlaybooksAndDuties(dir, home);
  // the edited one is left alone; the rest arrive
  assert.ok(!first.playbooks.includes('default.md'), 'an existing file is not re-seeded');
  assert.ok(first.playbooks.includes('no-mistakes.md'));
  assert.strictEqual(fs.readFileSync(path.join(playbooksDir(dir), 'default.md'), 'utf8'), 'MY default, do not touch\n');
  // copies, not symlinks: editing one must not write into the install
  assert.ok(!fs.lstatSync(path.join(playbooksDir(dir), 'no-mistakes.md')).isSymbolicLink());

  // idempotent — a re-run (an upgrade, a second init) copies nothing
  assert.deepStrictEqual(seedPlaybooksAndDuties(dir, home).playbooks, []);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

test('init SYMLINKS the worker-duties skill, repoints a stale link, and leaves a real dir alone', () => {
  const dir = tmpState({});
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-home-'));
  const skillDst = path.join(home, '.claude', 'skills', 'bridge-commander-worker');

  const r = seedPlaybooksAndDuties(dir, home);
  assert.strictEqual(r.skill, skillDst);
  assert.ok(fs.lstatSync(skillDst).isSymbolicLink(), 'a symlink, so an upgrade upgrades the duties');
  assert.strictEqual(fs.readlinkSync(skillDst), PACKAGED_SKILL_DIR);
  assert.match(fs.readFileSync(path.join(skillDst, 'SKILL.md'), 'utf8'), /name: bridge-commander-worker/);
  assert.ok(fs.existsSync(path.join(skillDst, 'images.md')), 'the whole skill dir ships, not one file');

  // already ours and pointing right: nothing to do
  assert.strictEqual(seedPlaybooksAndDuties(dir, home).skill, '');

  // a link left by an older checkout is repointed at the current one
  fs.unlinkSync(skillDst);
  fs.symlinkSync(path.join(home, 'somewhere-else'), skillDst, 'dir');
  assert.strictEqual(seedPlaybooksAndDuties(dir, home).skill, skillDst);
  assert.strictEqual(fs.readlinkSync(skillDst), PACKAGED_SKILL_DIR);

  // a REAL directory is someone's own install — never clobbered
  fs.unlinkSync(skillDst);
  fs.mkdirSync(skillDst);
  fs.writeFileSync(path.join(skillDst, 'SKILL.md'), 'hand-rolled\n');
  assert.strictEqual(seedPlaybooksAndDuties(dir, home).skill, '');
  assert.strictEqual(fs.readFileSync(path.join(skillDst, 'SKILL.md'), 'utf8'), 'hand-rolled\n');

  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

// ---------- the reference the config screen shows ----------
//
// Two lists documenting the two vocabularies, and the whole point of them is
// that they cannot drift: they are checked against the code that implements
// them, so a new placeholder or a new frontmatter key without a line of prose
// is a red suite, not a stale panel.

test('the documented placeholders are exactly the ones briefVars fills, plus ATTR_<NAME>', () => {
  const sample = {
    card: { id: 'MON-9', title: 'Demo card', body: 'do the thing', attributes: {} },
    thread: [], project: { name: 'proj', path: '/repos/proj' },
    worktree: '/wt/MON-9', branch: 'bc/MON-9', workspace: '/ws',
    stateDir: '/ws/.bridge-commander', cli: 'bc-axi',
  };
  const documented = PLACEHOLDERS.map((p) => p.name);
  assert.deepStrictEqual(documented, [...Object.keys(briefVars(sample)), 'ATTR_<NAME>'],
    'every placeholder the brief renders is documented, in the order it is filled');
  for (const p of PLACEHOLDERS) assert.ok(p.desc && p.desc.trim(), p.name + ' has a description');
});

test('the documented frontmatter keys are exactly FM_KEYS', () => {
  assert.deepStrictEqual(FRONTMATTER.map((f) => f.key), FM_KEYS);
  for (const f of FRONTMATTER) assert.ok(f.desc && f.desc.trim(), f.key + ' has a description');
});

// ================= through the server: the card's playbook =================
// The card's playbook is a POINTER to a markdown file the user owns, resolved
// and rendered into the worker's brief at card.start and only there.

function workerKey(dir, cardId) {
  return lieutenantSession(dir, LT) + ':' + workerWindow(cardId);
}
async function boot() {
  const { s, fdir, teardown } = await startServerWithProject({ prefix: 'bc-cardplaybook-' });
  // the prompt the fake harness was spawned with
  const prompt = (cardId) =>
    JSON.parse(fs.readFileSync(path.join(fdir, workerKey(s.dir, cardId) + '.json'), 'utf8')).prompt;
  const pbDir = path.join(s.dir, '.bridge-commander', 'playbooks');
  return { s, fdir, prompt, pbDir, teardown };
}

test('the playbook list is served off disk, workspace and packaged together', async () => {
  const { s, pbDir, teardown } = await boot();
  try {
    let r = await s.api('GET', '/api/playbooks');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body.playbooks, ['default', 'investigation', 'no-mistakes']);
    assert.strictEqual(r.body.dir, pbDir);

    // a playbook dropped in a second ago is pickable now — no restart, no cache
    fs.mkdirSync(pbDir, { recursive: true });
    fs.writeFileSync(path.join(pbDir, 'house-style.md'), '# {{CARD_TITLE}}\n');
    r = await s.api('GET', '/api/playbooks');
    assert.ok(r.body.playbooks.includes('house-style'));

    const cli = await runCli(['playbook', 'list', '--workspace', s.dir, '--port', String(s.port)]);
    assert.strictEqual(cli.code, 0, cli.stderr);
    assert.match(cli.stdout, /^house-style$/m);
    assert.match(cli.stdout, /^no-mistakes$/m);
  } finally { await teardown(); }
});

test('a card carries the playbook it was created with, and card patch --playbook changes it', async () => {
  const { s, teardown } = await boot();
  try {
    const c = await s.api('POST', '/api/cards', withOwner({ title: 'Pick one', playbook: 'no-mistakes' }));
    assert.strictEqual(c.body.card.playbook, 'no-mistakes');

    const cli = await runCli(['card', 'patch', 'pick-one', '--playbook', 'investigation',
      '--workspace', s.dir, '--port', String(s.port)]);
    assert.strictEqual(cli.code, 0, cli.stderr);
    assert.strictEqual((await s.api('GET', '/api/cards/pick-one')).body.playbook, 'investigation');

    // a typo is refused where it is typed, and the error names what exists
    let r = await s.api('PATCH', '/api/cards/pick-one', { playbook: 'no-mistkaes' });
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /unknown playbook: no-mistkaes/);
    assert.match(r.body.error, /no-mistakes/);
    r = await s.api('POST', '/api/cards', withOwner({ title: 'Typo', playbook: 'nope' }));
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /unknown playbook: nope/);

    // and it can be cleared back to none
    assert.strictEqual((await s.api('PATCH', '/api/cards/pick-one', { playbook: '' })).status, 200);
    assert.strictEqual((await s.api('GET', '/api/cards/pick-one')).body.playbook, '');
  } finally { await teardown(); }
});

test('card start refuses a card with no playbook, and names the playbooks', async () => {
  const { s, teardown } = await boot();
  try {
    // cards that predate playbooks have none — that is the state, not a bug
    await s.api('POST', '/api/cards', withOwner({ title: 'Old card', playbook: '', attributes: { repo: 'proj' } }));
    const r = await s.api('POST', '/api/cards/old-card/start', { harness: 'fake' });
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /has no playbook/);
    assert.match(r.body.error, /card patch old-card --playbook/);
    assert.match(r.body.error, /default, investigation, no-mistakes/);
    // it did not half-start: no worker, still in backlog
    assert.strictEqual((await s.api('GET', '/api/cards/old-card')).body.column, 'backlog');

    // one playbook away from starting
    assert.strictEqual((await s.api('PATCH', '/api/cards/old-card', { playbook: 'default' })).status, 200);
    assert.strictEqual((await s.api('POST', '/api/cards/old-card/start', { harness: 'fake' })).status, 200);
  } finally { await teardown(); }
});

// The dead `brief` key is not migrated and not special-cased: it is simply not
// a key the board reads, so a card carrying only that one has no playbook and
// takes the refusal every playbookless card already takes.
test('a card whose only key is the dead `brief` has no playbook, and no special case says so', async () => {
  const { s, teardown } = await boot();
  try {
    const c = await s.api('POST', '/api/cards', withOwner({
      title: 'Legacy', playbook: '', brief: 'default', attributes: { repo: 'proj' },
    }));
    assert.strictEqual(c.body.card.playbook, '');
    assert.strictEqual(c.body.card.brief, undefined, '`brief` is not a card key');
    const r = await s.api('POST', '/api/cards/legacy/start', { harness: 'fake' });
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /has no playbook/);
  } finally { await teardown(); }
});

test('the card gets ITS playbook: playbook no-mistakes renders no-mistakes.md, fully', async () => {
  const { s, prompt, teardown } = await boot();
  try {
    await s.api('POST', '/api/cards', withOwner({
      title: 'Gate it', playbook: 'no-mistakes', attributes: { repo: 'proj' }, body: 'add the flag',
    }));
    assert.strictEqual((await s.api('POST', '/api/cards/gate-it/start', { harness: 'fake' })).status, 200);
    const p = prompt('gate-it');
    assert.match(p, /^# Gate it \(gate-it\)/);
    assert.match(p, /Delivery — the no-mistakes gate/);
    assert.match(p, /add the flag/);
    assert.doesNotMatch(p, /\{\{/, 'nothing left unrendered');
    // the OTHER playbooks' text is nowhere near it
    assert.doesNotMatch(p, /a report, not a change/);
  } finally { await teardown(); }
});

test('the playbook resolves at START: the body edited a second before it is the body the worker reads', async () => {
  const { s, prompt, teardown } = await boot();
  try {
    await s.api('POST', '/api/cards', withOwner({
      title: 'Stale?', playbook: 'default', attributes: { repo: 'proj' }, body: 'the ORIGINAL plan',
    }));
    // everything the brief reads keeps moving between create and start
    await s.api('PATCH', '/api/cards/stale', { title: 'Fresh!', body: 'the REWRITTEN plan' });
    await s.api('POST', '/api/feedback', { target: 'card:stale', text: 'and mind the mobile flow' });
    assert.strictEqual((await s.api('POST', '/api/cards/stale/start', { harness: 'fake' })).status, 200);

    const p = prompt('stale');
    assert.match(p, /the REWRITTEN plan/);
    assert.match(p, /^# Fresh! \(stale\)/);
    assert.match(p, /and mind the mobile flow/);
    assert.doesNotMatch(p, /the ORIGINAL plan/);
  } finally { await teardown(); }
});

test('editing playbooks/default.md changes the next card started on it — no restart', async () => {
  const { s, prompt, pbDir, teardown } = await boot();
  try {
    fs.mkdirSync(pbDir, { recursive: true });
    fs.writeFileSync(path.join(pbDir, 'default.md'), 'HOUSE STYLE for {{CARD_ID}}\n');
    await s.api('POST', '/api/cards', withOwner({ title: 'After the edit', attributes: { repo: 'proj' } }));
    assert.strictEqual((await s.api('POST', '/api/cards/after-the-edit/start', { harness: 'fake' })).status, 200);
    assert.strictEqual(prompt('after-the-edit'), 'HOUSE STYLE for after-the-edit\n');

    // edit it again — the NEXT card gets the new text, same running server
    fs.writeFileSync(path.join(pbDir, 'default.md'), 'SECOND take for {{CARD_ID}}\n');
    await s.api('POST', '/api/cards', withOwner({ title: 'After the second', attributes: { repo: 'proj' } }));
    assert.strictEqual((await s.api('POST', '/api/cards/after-the-second/start', { harness: 'fake' })).status, 200);
    assert.strictEqual(prompt('after-the-second'), 'SECOND take for after-the-second\n');
  } finally { await teardown(); }
});

// How {{ATTR_*}} renders (and that a missing one stays literal) is pinned in
// the unit tests above; this pins that the server hands the renderer the
// card's attributes as they are at START.
test('{{ATTR_*}} reads the card attributes at start, including one set after create', async () => {
  const { s, prompt, pbDir, teardown } = await boot();
  try {
    fs.mkdirSync(pbDir, { recursive: true });
    fs.writeFileSync(path.join(pbDir, 'attrs.md'), 'PR {{ATTR_PR_URL}} on {{ATTR_REPO}}\n');
    await s.api('POST', '/api/cards', withOwner({ title: 'Review it', playbook: 'attrs', attributes: { repo: 'proj' } }));
    // set through the CLI, exactly as a lieutenant would
    const cli = await runCli(['card', 'patch', 'review-it', '--attr', 'pr_url=https://github.com/o/r/pull/9',
      '--workspace', s.dir, '--port', String(s.port)]);
    assert.strictEqual(cli.code, 0, cli.stderr);
    assert.strictEqual((await s.api('POST', '/api/cards/review-it/start', { harness: 'fake' })).status, 200);
    assert.strictEqual(prompt('review-it'), 'PR https://github.com/o/r/pull/9 on proj\n');
  } finally { await teardown(); }
});

test('a playbook deleted out from under the card is a loud refusal', async () => {
  const { s, pbDir, teardown } = await boot();
  try {
    fs.mkdirSync(pbDir, { recursive: true });
    fs.writeFileSync(path.join(pbDir, 'doomed.md'), 'hi {{CARD_ID}}\n');
    await s.api('POST', '/api/cards', withOwner({ title: 'Orphan', playbook: 'doomed', attributes: { repo: 'proj' } }));
    fs.unlinkSync(path.join(pbDir, 'doomed.md'));
    const r = await s.api('POST', '/api/cards/orphan/start', { harness: 'fake' });
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /points at playbook "doomed", which no file matches/);
  } finally { await teardown(); }
});
