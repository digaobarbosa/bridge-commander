#!/usr/bin/env node
// dev/ui-server.js — the frontend dev playground. Node built-ins only.
//
// Boots the REAL server/server.js on a throwaway workspace seeded from
// dev/fixtures/, with every harness replaced by the fake one
// (dev/playground-harness.js). The routes and payload shapes are the board's own,
// so the playground cannot drift from it. The one thing faked here is what needs
// a live agent: the lieutenants reply to the captain and act on his orders.
//
//   node dev/ui-server.js [--port N] [--host ADDR] [--tts URL]   (default 4790)
//
// Restart = reseed. The workspace lives in the OS temp dir and goes on exit.
'use strict';

const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (f) => JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8'));
function write(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
}

// ---------- seeding ----------
// Fixture strings are tokens: "T-3600" = an hour before seeding, and a path
// under /fake/ lands under the temp root (/fake/ws is the workspace itself).
function resolver(root, base) {
  const walk = (v) => {
    if (typeof v === 'string') {
      const t = /^T([+-]\d+)$/.exec(v);
      if (t) return new Date(base + parseInt(t[1], 10) * 1000).toISOString();
      return v.replace(/^(file:\/\/)?\/fake\//, (_, f) => (f || '') + root + '/');
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk;
}

// seedWorkspace(root, {tts?}) -> {ws, fakeState, seq}. seq is the last queue
// item seeded; the fake lieutenants leave those alone so the owed states show.
function seedWorkspace(root, opts = {}) {
  const r = resolver(root, Date.now());
  const ws = path.join(root, 'ws');
  const state = path.join(ws, '.bridge-commander');
  const fakeState = path.join(root, 'fake-harness');
  const board = r(readJson('board.json'));
  for (const c of board.cards) {
    if (c.bodyFile) { c.body = fs.readFileSync(path.join(FIX, c.bodyFile), 'utf8'); delete c.bodyFile; }
  }
  // Owed is queue truth on the real board: one captain message per target,
  // drained (seen) or not (queued).
  let seq = 0;
  for (const [target, owed] of Object.entries(board.owedSeed || {})) {
    const [kind, id] = target.split(':');
    const lt = kind === 'lieutenant' ? id : board.cards.find((c) => c.id === id).owner;
    const thread = kind === 'lieutenant' ? board.lieutenants.find((l) => l.id === id).chat : board.cards.find((c) => c.id === id).thread;
    const said = thread.filter((m) => m.author === 'user').pop() || { text: '(seeded)', ts: new Date().toISOString() };
    fs.mkdirSync(path.join(state, 'queue'), { recursive: true });
    fs.appendFileSync(path.join(state, 'queue', lt + '.jsonl'),
      JSON.stringify({ seq: ++seq, ts: said.ts, lieutenant: lt, kind: 'message', target, text: said.text }) + '\n');
    if (owed === 'seen') write(path.join(state, 'queue', lt + '.drained'), String(seq));
  }
  delete board.owedSeed;
  write(path.join(state, 'board.json'), JSON.stringify(board, null, 2));
  write(path.join(state, 'archive.jsonl'), fs.readFileSync(path.join(FIX, 'archive.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.stringify(r(JSON.parse(l))) + '\n').join(''));
  for (const [file, body] of Object.entries(readJson('artifacts.json'))) {
    write(r(file), fs.readFileSync(path.join(FIX, body)));
  }
  for (const [id, a] of Object.entries(readJson('attachments.json'))) {
    const data = fs.readFileSync(path.join(FIX, a.file));
    const stored = id + '__' + a.name;
    write(path.join(state, 'uploads', stored), data);
    write(path.join(state, 'uploads', id + '.json'), JSON.stringify({ id, name: a.name, mime: a.mime, size: data.length, stored }));
  }
  fs.cpSync(path.join(FIX, 'hooks'), path.join(state, 'hooks'), { recursive: true });
  write(path.join(state, 'config.json'), JSON.stringify(opts.tts ? { tts: { url: opts.tts, lang: 'pt' } } : {}));
  // A marker the fake harness did not spawn itself reads as a live session.
  for (const x of [...board.lieutenants, ...board.workers]) {
    if (x.ref) write(path.join(fakeState, x.ref.session + '.json'), JSON.stringify({ cwd: x.ref.cwd }));
  }
  // Projects are real repos with a local origin, so a start-order ends in a
  // real worktree cut from a base the server could fetch.
  for (const p of board.projects) {
    const origin = path.join(root, 'origins', p.name + '.git');
    const git = (...a) => execFileSync('git', ['-c', 'user.name=playground', '-c', 'user.email=dev@localhost', ...a], { stdio: 'ignore' });
    git('init', '-q', '--bare', '-b', 'main', origin);
    git('clone', '-q', origin, p.path);
    fs.writeFileSync(path.join(p.path, 'README.md'), '# ' + p.name + ' (playground)\n');
    git('-C', p.path, 'add', '.'); git('-C', p.path, 'commit', '-q', '-m', 'playground seed');
    git('-C', p.path, 'push', '-q', 'origin', 'HEAD:main'); git('-C', p.path, 'remote', 'set-head', 'origin', 'main');
  }
  return { ws, fakeState, seq };
}

// ---------- the fake lieutenants ----------
// The server wakes a lieutenant by sending it a line through its harness, and
// the fake harness logs each send to <session>.sends.jsonl. This loop plays the
// lieutenant's side from there, through the API a real one uses: drain, reply
// (or start the ordered card), ack.
const REPLIES = [
  'On it. I\'ll signal when there\'s something to look at.',
  'Good catch — folding that into the next worker turn.',
  'Done:\n\n```bash\ngit log --oneline -1\n# a1b2c3d the thing you asked for\n```\n\nAnything else on this one?',
  'Two options:\n\n1. **quick** — patch it on the current branch\n2. **right** — split a follow-up card\n\nI\'d go with 2; the branch is already review-sized.',
  'Hmm — that contradicts the card body. Want me to update the body to match, or keep the original scope?',
];
function fakeLieutenants(base, fakeState, seededSeq, replyMs = 3000) {
  const api = (method, p, body) => fetch(base + p, {
    method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body),
  }).then((res) => res.json());
  const offsets = new Map(); // sends file -> bytes already read
  const busy = new Set();
  let n = 0;
  // Loops until nothing new is left: a wake that lands mid-turn is not missed.
  async function turn(lt) {
    const say = (target, text) => api('POST', '/api/message', { target, text, session: lt.ref.session });
    for (;;) {
      // Peek first (an unscoped drain moves no cursor): items the fixture seeded
      // stay unanswered, so the queued/seen states it shows survive.
      const peek = await api('GET', '/api/feed');
      if (!peek.items.some((i) => i.lieutenant === lt.id && i.seq > seededSeq)) return;
      await sleep(replyMs / 2);
      const { items } = await api('GET', '/api/feed?lieutenant=' + lt.id); // drained: queued → seen
      await sleep(replyMs);
      for (const it of items) {
        if (it.kind === 'message') await say(it.target, REPLIES[n++ % REPLIES.length]);
        if (it.kind === 'start-order' || it.kind === 'rework-order') {
          const r = await api('POST', '/api/cards/' + it.card + '/start', { actor: lt.id });
          if (r.error) await say('card:' + it.card, 'Could not start it: ' + r.error);
        }
      }
      const ack = await api('POST', '/api/feed/ack', { seq: items[items.length - 1].seq, lieutenant: lt.id });
      if (ack.error) throw new Error('ack: ' + ack.error);
    }
  }
  const timer = setInterval(async () => {
    const woken = [];
    for (const f of fs.existsSync(fakeState) ? fs.readdirSync(fakeState) : []) {
      if (!f.endsWith('.sends.jsonl')) continue;
      const size = fs.statSync(path.join(fakeState, f)).size;
      if (size > (offsets.get(f) || 0)) woken.push(f.slice(0, -'.sends.jsonl'.length));
      offsets.set(f, size);
    }
    if (!woken.length) return;
    const { lieutenants } = await api('GET', '/api/lieutenants').catch(() => ({ lieutenants: [] }));
    for (const lt of lieutenants) {
      const key = lt.ref && (lt.ref.window ? lt.ref.session + ':' + lt.ref.window : lt.ref.session);
      if (!woken.includes(key) || busy.has(lt.id)) continue;
      busy.add(lt.id);
      turn(lt).catch((e) => console.error('[dev-playground] ' + lt.id + ': ' + e.message))
        .finally(() => busy.delete(lt.id));
    }
  }, 300);
  return () => clearInterval(timer);
}

// ---------- boot ----------
// A port the OS just handed out. Never 0 to the server: it reads 0 as "unset"
// and falls back to 4780, where a real board lives.
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer().once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

// startPlayground({port?, host?, tts?, replyMs?}) -> {base, port, dir, ws, stop}
async function startPlayground(opts = {}) {
  opts = Object.assign({}, opts, { port: opts.port || await freePort() });
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bc-playground-')));
  const { ws, fakeState, seq } = seedWorkspace(root, opts);
  const args = ['--require', path.join(__dirname, 'playground-harness.js'),
    path.join(ROOT, 'server', 'server.js'), ws, '--port', String(opts.port)];
  if (opts.host) args.push('--host', opts.host);
  const child = spawn(process.execPath, args, {
    // No PR polling: the fixture's PR links are real GitHub URLs.
    env: Object.assign({}, process.env, { BC_FAKE_STATE: fakeState, BC_PRWATCH_INTERVAL_MS: '0', BC_WAKE_TTL_MS: '0' }),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; process.stderr.write(c); });
  const cleanup = () => fs.rmSync(root, { recursive: true, force: true });
  const base = 'http://127.0.0.1:' + opts.port;
  for (let t = Date.now(); ; await sleep(50)) {
    // Our server is the one answering with our child's pid; anyone else on the port is a clash.
    const st = await fetch(base + '/api/status').then((r) => r.json()).catch(() => null);
    if (st && st.pid === child.pid) break;
    if (child.exitCode != null || st || Date.now() - t > 10000) {
      child.kill('SIGKILL'); cleanup();
      throw new Error('playground server did not come up' + (st ? ': EADDRINUSE, port taken' : '') + '\n' + stderr);
    }
  }
  const stopLieutenants = fakeLieutenants(base, fakeState, seq, opts.replyMs);
  async function stop() {
    stopLieutenants();
    if (child.exitCode == null) {
      const gone = new Promise((r) => child.once('exit', r));
      child.kill('SIGTERM');
      await Promise.race([gone, sleep(3000).then(() => child.kill('SIGKILL'))]);
    }
    cleanup();
  }
  return { base, port: opts.port, dir: root, ws, stop };
}

module.exports = { startPlayground };

if (require.main === module) {
  const opts = { port: 4790 };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') opts.port = parseInt(argv[++i], 10);
    else if (argv[i] === '--host') opts.host = String(argv[++i] || '').trim();
    else if (argv[i] === '--tts') opts.tts = String(argv[++i] || '').trim();
  }
  if (!Number.isInteger(opts.port) || opts.port <= 0) { console.error('bad --port'); process.exit(1); }
  if (opts.tts && !/^https?:\/\//.test(opts.tts)) { console.error('bad --tts (want http://host:port)'); process.exit(1); }
  startPlayground(opts).then((pg) => {
    console.log('[dev-playground] ' + pg.base + '  real server, fixture workspace ' + pg.ws + ' (gone on exit)');
    for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => pg.stop().then(() => process.exit(0)));
  }, (e) => { console.error(e.message); process.exit(1); });
}
