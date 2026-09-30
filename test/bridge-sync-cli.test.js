'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFile } = require('node:child_process');
const { validatePayload, boardUrl, sync, summarize } = require('../skills/bridge-sync/scripts/sync');
const CLI = path.resolve(__dirname, '../skills/bridge-sync/scripts/sync.js');
const ID = '01a0f3a1-c6e7-7472-96ed-d029b815d305';

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-sync-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
async function mockBoard(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return 'http://127.0.0.1:' + server.address().port;
}
function run(args, env = {}, input = '') {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [CLI, ...args], { env: { ...process.env, ...env }, timeout: 5000 }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
    child.stdin.end(input);
  });
}
function modelStub(dir, name) {
  const bin = path.join(dir, name);
  fs.writeFileSync(bin, `#!${process.execPath}\n` +
    "const fs=require('node:fs');let input='';process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{\n" +
    "const a=process.argv.slice(2); const schema=a[0]==='exec'?JSON.parse(fs.readFileSync(a[a.indexOf('--output-schema')+1],'utf8')):JSON.parse(a[a.indexOf('--json-schema')+1]); fs.writeFileSync(process.env.STUB_CAPTURE,JSON.stringify({args:a,input,schema,cwd:process.cwd(),thread:process.env.CODEX_THREAD_ID,claudecode:process.env.CLAUDECODE}));\n" +
    "if(process.env.STUB_FAIL)process.exit(2);const out={summary:'Implemented the link; tests passed',stage:'review',nextAction:'Review the diff',blocker:'',body:process.env.STUB_BODY===undefined?'## Problem\\nCards need durable session links.\\n\\n## Approach\\nLink the exact conversation.\\n\\n## Status\\nTests passed.\\n\\n## Next action\\nReview the diff.':process.env.STUB_BODY};\n" +
    "if(process.env.STUB_INJECT)out.session={id:'ffffffff-ffff-ffff-ffff-ffffffffffff'};\n" +
    "if(a[0]==='exec')fs.writeFileSync(a[a.indexOf('-o')+1],JSON.stringify(out));else console.log(JSON.stringify({structured_output:out}));\n" +
    '});\n');
  fs.chmodSync(bin, 0o755);
}

test('session identity is exact and provider-specific; Claude never inherits Codex identity', () => {
  const payload = validatePayload({ provider: 'codex', cwd: '/project', surface: 'app' }, { CODEX_THREAD_ID: ID });
  assert.equal(payload.session.id, ID);
  assert.throws(() => validatePayload({ provider: 'claude' }, { CODEX_THREAD_ID: ID }), /exact session UUID/);
  assert.equal(validatePayload({ provider: 'claude', session_id: ID, cwd: '/project' }, {}).session.id, ID);
  assert.throws(() => validatePayload({ provider: 'codex', session_id: '--last' }, {}), /exact session UUID/);
  assert.throws(() => validatePayload({ provider: 'codex', session_id: ID, cwd: 'relative' }, {}), /absolute/);
});

test('board discovery uses nearest workspace, custom port, and explicit board overrides', (t) => {
  const root = temp(t); const child = path.join(root, 'project', 'src');
  fs.mkdirSync(child, { recursive: true });
  fs.mkdirSync(path.join(root, '.bridge-commander'));
  fs.writeFileSync(path.join(root, '.bridge-commander/config.json'), '{"port":4791}');
  assert.equal(boardUrl({ cwd: child }, {}), 'http://127.0.0.1:4791');
  assert.equal(boardUrl({ workspace: root }, {}), 'http://127.0.0.1:4791');
  assert.equal(boardUrl({ boardUrl: 'https://board.example/' }, {}), 'https://board.example');
  assert.throws(() => boardUrl({ boardUrl: 'https://secret:password@board.example' }, {}), /without credentials/);
  assert.throws(() => boardUrl({ workspace: child }, {}), /board not found/);
});

test('CLI sends one literal JSON update with exact identity and content; no shell interpolation', async (t) => {
  const requests = [];
  const url = await mockBoard(t, (req, res) => {
    let body = ''; req.on('data', (x) => body += x);
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, body: JSON.parse(body) });
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, card: { id: 'CARD-1' }, session: JSON.parse(body).session }));
    });
  });
  const summary = 'Literal $() and `ticks`, quotes " and\nnewlines';
  const result = await run(['--board-url', url, '--provider', 'codex', '--session-id', ID, '--cwd', '/project', '--surface', 'app', '--summary', summary, '--stage', 'planning']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/sessions/sync');
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].body.summary, summary);
  assert.equal(requests[0].body.session.id, ID);
  assert.equal(Object.hasOwn(requests[0].body, 'body'), false, 'legacy direct update must preserve the existing description');
  assert.equal(JSON.parse(result.stdout).card.id, 'CARD-1');
});

test('Claude hook input uses original session_id and explicit CLI identity has precedence', async (t) => {
  const url = await mockBoard(t, (req, res) => {
    let body = ''; req.on('data', (x) => body += x);
    req.on('end', () => res.end(JSON.stringify({ ok: true, card: {}, session: JSON.parse(body).session })));
  });
  const result = await run(['--board-url', url, '--provider', 'claude', '--surface', 'app', '--stdin'], {}, JSON.stringify({ session_id: ID, cwd: '/claude/project' }));
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual([JSON.parse(result.stdout).session.id, JSON.parse(result.stdout).session.cwd], [ID, '/claude/project']);
  const explicit = await run(['--board-url', url, '--provider', 'codex', '--session-id', ID, '--cwd', '/real/project', '--stdin'], {}, JSON.stringify({ session: { provider: 'claude', id: 'ffffffff-ffff-ffff-ffff-ffffffffffff', cwd: '/other' } }));
  assert.equal(explicit.code, 0, explicit.stderr);
  assert.equal(JSON.parse(explicit.stdout).session.id, ID);
  assert.equal(JSON.parse(explicit.stdout).session.provider, 'codex');
});

test('direct JSON body reaches the API literally with original PR, Slack, and Linear links', async (t) => {
  const description = '## Problem\nSession links disappear after review.\n\n## References\n' +
    '- [PR](https://github.com/example/bridge/pull/27)\n' +
    '- [Original Slack thread](https://example.slack.com/archives/C123/p1750000000000000?thread_ts=1750000000.000000&cid=C123)\n' +
    '- [Linear ticket](https://linear.app/example/issue/BRI-27/durable-links)';
  let posted;
  const url = await mockBoard(t, (req, res) => {
    let raw = ''; req.on('data', (x) => raw += x);
    req.on('end', () => { posted = JSON.parse(raw); res.end(JSON.stringify({ ok: true, card: {}, session: posted.session })); });
  });
  const result = await run(['--board-url', url, '--stdin'], {}, JSON.stringify({ session: { provider: 'codex', id: ID, cwd: '/project' }, body: description }));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(posted.body, description);
  assert.equal(posted.session.id, ID);
});

test('body-file takes precedence over input and lightweight model body while preserving exact content', async (t) => {
  const dir = temp(t); modelStub(dir, 'codex');
  const file = path.join(dir, 'body.md');
  const description = '## Problem\nCaller-maintained description with literal `code` and $().\n\n## References\n' +
    '- [PR](https://github.com/example/bridge/pull/73)\n';
  fs.writeFileSync(file, description);
  let posted;
  const url = await mockBoard(t, (req, res) => {
    let raw = ''; req.on('data', (x) => raw += x);
    req.on('end', () => { posted = JSON.parse(raw); res.end(JSON.stringify({ ok: true, card: {}, session: posted.session })); });
  });
  const env = { PATH: dir + path.delimiter + process.env.PATH, STUB_CAPTURE: path.join(dir, 'capture.json'), CODEX_THREAD_ID: ID };
  const result = await run(['--board-url', url, '--provider', 'codex', '--body-file', file, '--checkpoint', 'Tests passed; review next', '--stdin'], env, JSON.stringify({ body: 'Older description from input' }));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(posted.body, description);
  assert.equal(posted.stage, 'review');
  assert.equal(posted.session.id, ID);
});

test('body limits fail before writing and an explicit empty body remains deliberate caller input', (t) => {
  assert.equal(validatePayload({ provider: 'codex', session_id: ID, body: '' }, {}).body, '');
  assert.equal(validatePayload({ provider: 'codex', session_id: ID, body: 'x'.repeat(20000) }, {}).body.length, 20000);
  assert.throws(() => validatePayload({ provider: 'codex', session_id: ID, body: 'x'.repeat(20001) }, {}), /body.*20000/);
  assert.throws(() => validatePayload({ provider: 'codex', session_id: ID, body: null }, {}), /body must be a string/);
});

test('archived-session errors are surfaced without retrying or recreating', async (t) => {
  let calls = 0;
  const url = await mockBoard(t, (_req, res) => { calls++; res.writeHead(409); res.end('{"error":"session belongs to an archived card"}'); });
  await assert.rejects(sync(url, validatePayload({ provider: 'claude', session_id: ID })), /409.*archived card/);
  assert.equal(calls, 1);
});

test('network timeout and malformed response fail predictably', async (t) => {
  const stalled = await mockBoard(t, () => {});
  await assert.rejects(sync(stalled, {}, 25), /timed out/);
  const invalid = await mockBoard(t, (_req, res) => res.end('<html>bad</html>'));
  await assert.rejects(sync(invalid, {}), /invalid JSON/);
});

test('checkpoint uses a separate configurable small Codex runner and cannot replace original session', async (t) => {
  const dir = temp(t); modelStub(dir, 'codex');
  const capture = path.join(dir, 'capture.json');
  let posted;
  const url = await mockBoard(t, (req, res) => {
    let body = ''; req.on('data', (x) => body += x);
    req.on('end', () => { posted = JSON.parse(body); res.end(JSON.stringify({ ok: true, card: {}, session: posted.session })); });
  });
  const env = { PATH: dir + path.delimiter + process.env.PATH, STUB_CAPTURE: capture, STUB_INJECT: '1', CODEX_THREAD_ID: ID };
  const result = await run(['--board-url', url, '--provider', 'codex', '--checkpoint', 'Changed the session link and verified tests', '--model', 'my-small-model', '--surface', 'app', '--next-action', 'Caller-selected next action'], env);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(posted.session.id, ID);
  assert.equal(posted.stage, 'review');
  assert.equal(posted.nextAction, 'Caller-selected next action');
  assert.match(posted.body, /## Problem\nCards need durable session links/);
  const child = JSON.parse(fs.readFileSync(capture, 'utf8'));
  assert.equal(child.args[child.args.indexOf('-m') + 1], 'my-small-model');
  assert.ok(child.args.includes('--ephemeral'));
  assert.equal(child.args[child.args.indexOf('--sandbox') + 1], 'read-only');
  assert.equal(child.thread, undefined);
  assert.ok(child.schema.required.includes('body'));
  assert.equal(child.schema.properties.body.minLength, 1);
  assert.equal(child.schema.properties.body.maxLength, 20000);
  assert.notEqual(child.cwd, process.cwd());
  assert.equal(fs.existsSync(child.cwd), false, 'isolated model directory cleaned up');
});

test('Claude runner defaults to haiku, disables tools, preserves parent model, and clears nested-session env', async (t) => {
  const dir = temp(t); modelStub(dir, 'claude');
  const capture = path.join(dir, 'capture.json');
  const env = { ...process.env, PATH: dir + path.delimiter + process.env.PATH, STUB_CAPTURE: capture, CLAUDECODE: '1', CODEX_THREAD_ID: ID };
  const update = await summarize('Planning complete; implementation begins next', 'claude', {}, env);
  assert.equal(update.summary, 'Implemented the link; tests passed');
  const child = JSON.parse(fs.readFileSync(capture, 'utf8'));
  assert.equal(child.args[child.args.indexOf('--model') + 1], 'haiku');
  assert.equal(child.args[child.args.indexOf('--tools') + 1], '');
  assert.ok(child.args.includes('--safe-mode'));
  assert.ok(child.args.includes('--no-session-persistence'));
  assert.equal(child.claudecode, undefined);
  assert.equal(env.CLAUDECODE, '1');
});

test('checkpoint bodies retain exact supplied links, including references omitted by the lightweight model', async (t) => {
  const dir = temp(t); modelStub(dir, 'codex');
  const pr = 'https://github.com/example/bridge/pull/27';
  const slack = 'https://example.slack.com/archives/C123/p1750000000000000?thread_ts=1750000000.000000&cid=C123';
  const linear = 'https://linear.app/example/issue/BRI-27/durable-links';
  const checkpoint = `Problem: cards lose session links. Implemented a durable identity; tests passed.\nPR: <${pr}>\nOriginal thread: [Slack](${slack})\nTicket: ${linear}`;
  const modelBody = `## Problem\nCards lose session links.\n\n## Approach\nStore exact identity.\n\n## Status\nTests passed.\n\n## Next action\nReview the diff.\n\n## References\n- [PR](${pr})`;
  let posted;
  const url = await mockBoard(t, (req, res) => {
    let raw = ''; req.on('data', (x) => raw += x);
    req.on('end', () => { posted = JSON.parse(raw); res.end(JSON.stringify({ ok: true, card: {}, session: posted.session })); });
  });
  const capture = path.join(dir, 'capture.json');
  const env = { PATH: dir + path.delimiter + process.env.PATH, STUB_CAPTURE: capture, STUB_BODY: modelBody, CODEX_THREAD_ID: ID };
  const result = await run(['--board-url', url, '--provider', 'codex', '--checkpoint', checkpoint], env);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(posted.body.startsWith(modelBody));
  assert.ok(posted.body.includes(`- <${slack}>`));
  assert.ok(posted.body.includes(`- <${linear}>`));
  assert.equal((posted.body.match(/## References/g) || []).length, 1);
  const child = JSON.parse(fs.readFileSync(capture, 'utf8'));
  assert.ok(child.input.endsWith(checkpoint), 'original reference URLs reach the model unchanged');
  assert.equal(posted.session.id, ID);
});

test('invented or changed reference URLs from the lightweight model cannot update a card', async (t) => {
  const dir = temp(t); modelStub(dir, 'codex');
  let calls = 0;
  const url = await mockBoard(t, (_req, res) => { calls++; res.end('{"ok":true}'); });
  const env = { PATH: dir + path.delimiter + process.env.PATH, STUB_CAPTURE: path.join(dir, 'capture.json'), CODEX_THREAD_ID: ID, STUB_BODY: '## References\n- [PR](https://github.com/example/bridge/pull/999)' };
  const result = await run(['--board-url', url, '--provider', 'codex', '--checkpoint', 'Original PR: https://github.com/example/bridge/pull/27'], env);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /changed or invented a reference URL/);
  assert.equal(calls, 0);
});

test('empty generated body cannot erase a description or count as a successful checkpoint', async (t) => {
  const dir = temp(t); modelStub(dir, 'codex');
  let calls = 0;
  const url = await mockBoard(t, (_req, res) => { calls++; res.end('{"ok":true}'); });
  const env = { PATH: dir + path.delimiter + process.env.PATH, STUB_CAPTURE: path.join(dir, 'capture.json'), CODEX_THREAD_ID: ID, STUB_BODY: ' \n\t' };
  const result = await run(['--board-url', url, '--provider', 'codex', '--checkpoint', 'Current progress'], env);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /empty body/);
  assert.equal(calls, 0);
});

test('model failure and oversize checkpoint cannot update the board; dry-run launches neither', async (t) => {
  const dir = temp(t); modelStub(dir, 'codex');
  const capture = path.join(dir, 'capture.json');
  let calls = 0;
  const url = await mockBoard(t, (_req, res) => { calls++; res.end('{"ok":true}'); });
  const env = { PATH: dir + path.delimiter + process.env.PATH, STUB_CAPTURE: capture, STUB_FAIL: '1', CODEX_THREAD_ID: ID };
  const args = ['--board-url', url, '--provider', 'codex', '--checkpoint', 'A small checkpoint'];
  const failed = await run(args, env);
  assert.notEqual(failed.code, 0);
  assert.match(failed.stderr, /no card was updated/);
  assert.equal(calls, 0);
  fs.rmSync(capture);
  const dry = await run([...args, '--dry-run'], env);
  assert.equal(dry.code, 0, dry.stderr);
  assert.equal(calls, 0);
  assert.equal(fs.existsSync(capture), false);
  await assert.rejects(summarize('x'.repeat(12001), 'codex'), /exceeds 12000/);
});
