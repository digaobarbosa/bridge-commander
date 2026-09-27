#!/usr/bin/env node
// bridge-commander server — the harness control surface. Node built-ins only, zero deps.
// Usage: node server/server.js [workspace] [--workspace DIR] [--port N] [--host H]
// One workspace = one board. All state lives in <workspace>/.bridge-commander/:
//   board.json     the board (canonical state of the world)
//   archive.jsonl  append-only frozen card snapshots (reason: merged|killed)
//   hookruns.jsonl append-only trace of every hook run (lifecycle and named), read from the tail
//   eventkeys.json at-most-once keys for `event --key`, per card, pruned at 7 days
//   chat/<lieutenant>.jsonl  append-only lieutenant main chat (the truth; board.json holds none)
//   config.json    { port, host?, voices?, tts?, permissionMode? } — port default 4780, written on first boot;
//                  permissionMode: auto (default) | default | acceptEdits | bypass — how every agent
//                  launches; bypass = --dangerously-skip-permissions, the rest ask via the board
//                  (POST /api/permission holds the hook until the captain decides)
//   queue/<lieutenant>.jsonl  durable per-lieutenant delivery queue (global seq)
//   queue/<lieutenant>.ack    committed ack cursor (at-least-once; only ack removes)
//   server.pid     single server instance per workspace
//
// Data model (docs/api/overview.md is the DNA):
//   board = { title, subtitle, updated, seq,
//             columns: fixed frame (backlog | working | review | peer),
//             lieutenants: [{id, name, color, prefix, cardSeq, avatar?: 0-63, voice?, created,
//                            — the charter is NOT here: it is lieutenants/<id>/README.md in the workspace,
//                            chat: [{author,text,ts}]  — NOT stored: the newest CHAT_TAIL of chat/<id>.jsonl, served only,
//                            ref: null|HarnessRef {harness, session, cwd, resumeId?},
//                            lastTurnEnd?, turns?}],
//             projects: [{name, path, mode, source?, added}],   // registered repos (F6)
//             workers:  [{card, ref, worktree: {path, tool}, branch?, project,
//                         spawnedAt, done?, outcome?, flagged?, paused?, lastTurnEnd?, lastTurnEndText?,
//                         lastSignalAt?, lastSignalText?, lastPermissionAt?, turns?,
//                         stopNotified?, staleNotified?, staleNotifiedAt?, staleHits?}],
//             cards:   [{id, title, type, owner, column, labels[], attributes{}, body,
//                        created, updated, threadStart, pendingOrder,
//                        status: {worker: null|{id, state, expires}},  // lease; only status.set writes it
//                        events: [{seq, ts, level, kind, text, actor}],
//                        thread: [{author, text, ts}] }],
//             events:  [{seq, ts, level, kind?, text, actor, card?, cardTitle?}], // board-level
//             labels:  [{name, color}],                     // user-owned registry
//             kinds:   {<kind>: {emoji, level}},            // registered kinds map (overrides built-ins)
//             line:    null|<lieutenant-id>,                 // who holds the captain's voice channel
//             reads:   { <user>: { notifSeq, notifSeqs[], threads: {<target>: ts} } } }
//
// Every card belongs to exactly one lieutenant (`owner`); card `type` is
// plan | implementation | investigation. A card id is minted by its owner as
// <prefix>-<cardSeq>, e.g. MON-14 — cards created before that keep their
// hand-written slug ids, and no verb tells the two apart. Chat targets are `lieutenant:<id>`
// (a lieutenant's main chat) and `card:<id>` (a card thread, whose interlocutor
// is the owning lieutenant).
//
// Captain drag semantics (side effects, per the DNA): backlog → working and
// review → backlog do NOT move the card; they append a start-order / rework-order
// QueueItem to the owning lieutenant (the card carries `pendingOrder` until it
// actually moves). Every other captain drag applies normally. Lieutenant moves
// are allowed only → review (the handoff).
//
// Events are append-only and carry a global monotonic seq. The unified stream =
// board.events + every card's events, ordered by seq. Notifications are the
// level-1 slice of that stream UNION unseen lieutenant-authored card-thread
// replies (per-user read state persists in board.reads, server-side).
// Kill = archive; restore = resurrection with frozen state and a loud level-1
// event; the archive log stays append-only — the board is truth for liveness.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
// The harness port — the ONLY seam the server speaks to agent sessions through
// (docs/api/overview.md, "harness port"). Lazy builtins: requiring port.js
// drags in no tmux/claude machinery until a ref is actually dispatched.
const port = require(path.join(__dirname, '..', 'harness', 'port.js'));
const { isHarnessRef, keyOf, isSpawnableSession } = port;
const { createWorktree, releaseWorktree, worktreeToolFor } = require(path.join(__dirname, 'worktrees.js'));
const { createWorkers } = require(path.join(__dirname, 'workers.js'));
const { runHooks, runTeardown, listAllHooks, runNamedHook, runningHook, readRuns, lastRuns, hookKey,
  hooksDir, namedHookFile,
  TEARDOWN_TIMEOUT_MS: TEARDOWN_DEFAULT_MS, HOOK_NAME_RE } = require(path.join(__dirname, 'hooks.js'));
const { parseWhen, normalizeSchedules,
  NAME_RE: SCHEDULE_NAME_RE, OVERLAP, CATCHUP } = require(path.join(__dirname, 'schedules.js'));
const { createSampler } = require(path.join(__dirname, 'sysload.js'));
const { workerBrief, listPlaybooks, resolvePlaybook, playbooksDir, PACKAGED_PLAYBOOKS_DIR, parsePlaybook, attrVar, attrCardKey, PLACEHOLDERS, FRONTMATTER } = require(path.join(__dirname, 'playbooks.js'));
// layout.js: where things live in a workspace — the state dir, the charter,
// and the session names (still read as `names.<fn>` below).
const names = require(path.join(__dirname, 'layout.js'));
const { STATE_DIR_NAME, migrateStateDir, migrateHomeStateDir, isId, ONBOARDING_STEPS,
  charterPath, readCharter, writeCharter } = require(path.join(__dirname, 'layout.js'));
const gitrev = require(path.join(__dirname, 'gitrev.js'));
const { makeProxy, engineUrl } = require(path.join(__dirname, 'proxy.js'));
const { createFileGate } = require(path.join(__dirname, 'filegate.js'));
const { createClock } = require(path.join(__dirname, 'clock.js'));
const { createWatchers } = require(path.join(__dirname, 'watchers.js'));
const { createPrWatch } = require(path.join(__dirname, 'prwatch.js'));
const { createConversation, parseTarget, CAPTAIN } = require(path.join(__dirname, 'conversation.js'));
const { permissionModes, permissionMode, summarize, createPermissions } = require(path.join(__dirname, 'permissions.js'));
const { readJsonl, sealJsonl } = require(path.join(__dirname, 'jsonl.js'));
const { createDelivery } = require(path.join(__dirname, 'delivery.js'));
const feedtext = require(path.join(__dirname, 'feedtext.js'));
const { createStore } = require(path.join(__dirname, 'store.js'));
const { execFile, execFileSync } = require('child_process');

// ---------- args ----------
function parseArgs(argv) {
  const o = { workspace: '', port: 0, host: '' };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') o.port = parseInt(argv[++i], 10);
    else if (argv[i] === '--workspace') o.workspace = argv[++i];
    else if (argv[i] === '--host') o.host = argv[++i];
    else pos.push(argv[i]);
  }
  if (!o.workspace && pos.length) o.workspace = pos[0];
  if (o.port && (!Number.isInteger(o.port) || o.port <= 0)) { console.error('bad --port'); process.exit(1); }
  if (o.host && !/^[\w.:-]+$/.test(o.host)) { console.error('bad --host'); process.exit(1); }
  return o;
}
const opts = parseArgs(process.argv.slice(2));

// ---------- paths (workspace-scoped; no global state) ----------
// Resolved AND real: every path the board hands out is built from this one, and
// the file gate (filegate.js) compares a hook's containing directory against
// realpathSync of itself. A workspace reached through a symlinked parent (/tmp
// on macOS, ~/work → /mnt/data/work anywhere) would fail that comparison for the
// board's OWN hooks, so the link is followed once here rather than at each call site.
// A workspace that is not on disk YET is the same question one level up: `--workspace
// ~/work/newboard` through a ~/work → /mnt/data/work link has a link to follow even
// though the board's own directory does not exist. So this resolves the deepest
// ancestor that IS there and re-joins the tail the mkdirs below will create.
// Worth the walk even though a restart would fix it: until then the whole life of
// that process answers 404 to every hook on the tab, and nobody would ever connect
// "the board came up before its directory did" to "the pencil stopped working".
// A card artifact's directory takes the same walk (normalizeArtifactUri).
function realDir(dir) {
  const missing = [];
  for (let at = dir; ;) {
    try { return path.join(fs.realpathSync(at), ...missing); } catch (e) {}
    const up = path.dirname(at);
    if (up === at) return dir; // nothing on the way to the root resolved
    missing.unshift(path.basename(at));
    at = up;
  }
}
const WORKSPACE = realDir(path.resolve(opts.workspace || process.cwd()));
// One-shot rename migrations (bridge-command → bridge-commander). Boot-time and
// idempotent: the server owns this workspace as it starts, so renaming the state
// dir before any path below is used is safe. Legacy installs survive the flag day.
const migratedState = migrateStateDir(WORKSPACE);
if (migratedState) console.log('[bridge-commander] migrated state dir → ' + migratedState);
const migratedHome = migrateHomeStateDir();
if (migratedHome) console.log('[bridge-commander] migrated home state dir → ' + migratedHome);
const STATE_DIR = path.join(WORKSPACE, STATE_DIR_NAME);
const BOARD_FILE = path.join(STATE_DIR, 'board.json');
const ARCHIVE_FILE = path.join(STATE_DIR, 'archive.jsonl');
const CONFIG_FILE = path.join(STATE_DIR, 'config.json');
const QUEUE_DIR = path.join(STATE_DIR, 'queue');
const CHAT_DIR = path.join(STATE_DIR, 'chat');
const PID_FILE = path.join(STATE_DIR, 'server.pid');
// Chat file uploads. Lives under the workspace .bridge-commander/ (already
// git-ignored). NOTE: this dir grows unbounded — an upload is never garbage
// collected here; a prune policy (age/size cap, orphan sweep) can come later.
// Each file is stored as <id>__<safeName> with a sidecar <id>.json holding its
// metadata (name/mime/size), so GET can serve the right Content-Type and the
// stored name can never be spoofed by the request path.
const UPLOADS_DIR = path.join(STATE_DIR, 'uploads');
const UI_DIR = path.join(__dirname, '..', 'ui');
// Harness working state (session ids, prompts, turn-end logs) lives in the
// WORKSPACE (layout.js harnessStateDir); the port is bound to it below.
const HARNESS_STATE_DIR = names.harnessStateDir(STATE_DIR);
fs.mkdirSync(QUEUE_DIR, { recursive: true });
fs.mkdirSync(CHAT_DIR, { recursive: true });
fs.mkdirSync(HARNESS_STATE_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
// A crash mid-append leaves a torn last line; end it so the next append starts clean.
sealJsonl(ARCHIVE_FILE);
for (const f of fs.readdirSync(CHAT_DIR)) if (f.endsWith('.jsonl')) sealJsonl(path.join(CHAT_DIR, f));

// Upload size cap (decoded bytes). Over-cap uploads are rejected 413.
const UPLOAD_MAX_BYTES = parseInt(process.env.BC_UPLOAD_MAX_BYTES, 10) > 0
  ? parseInt(process.env.BC_UPLOAD_MAX_BYTES, 10) : 10 * 1024 * 1024;
// Raw-artifact byte serve cap. Images/binaries are delivered as bytes to an
// <img>/download (not inlined as text), so this is far larger than the text
// preview cap; over-cap → 413.
const ARTIFACT_MAX_BYTES = parseInt(process.env.BC_ARTIFACT_MAX_BYTES, 10) > 0
  ? parseInt(process.env.BC_ARTIFACT_MAX_BYTES, 10) : 25 * 1024 * 1024;

const DEFAULT_PORT = 4780;
// The one prefix the TTS engine is served under, both ends of it: what the
// browser is handed as its engine address, and what the proxy strips.
const TTS_PREFIX = '/api/tts';
// ---------- workspace config (.bridge-commander/config.json) ----------
function readConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (c && typeof c === 'object' && !Array.isArray(c)) return c;
  } catch (e) {}
  return {};
}
// The launch mode every agent gets, read at launch time so an edit to
// config.json takes effect on the next spawn. An unknown value launches in the
// default mode — said once per value, not on every launch.
const warnedModes = new Set();
// The modes the harnesses accept (profile data), the default harness's first:
// its first mode is what an unknown value launches as.
function harnessModes(c) {
  const first = (c || readConfig()).harness || port.defaultHarness();
  const lists = [first].concat(port.listHarnesses().map((h) => h.name)).map((n) => {
    try { const info = port.profileInfo(n); return (info && info.permissionModes) || []; } catch (e) { return []; }
  });
  return permissionModes(lists);
}
function configPermissionMode(c) {
  const cfg = c || readConfig();
  const raw = cfg.permissionMode;
  const modes = harnessModes(cfg);
  const mode = permissionMode(raw, modes);
  if (raw !== undefined && raw !== mode && !warnedModes.has(String(raw))) {
    warnedModes.add(String(raw));
    console.warn(now() + ' config.json permissionMode ' + JSON.stringify(raw)
      + ' is not one of ' + modes.join('|') + ' — using ' + mode);
  }
  return mode;
}
function userConfig() {
  const c = readConfig();
  const out = { voices: null, permissionMode: configPermissionMode(c) };
  if (Array.isArray(c.voices)) {
    const voices = c.voices.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim());
    if (voices.length) out.voices = voices;
  }
  // The browser is the engine's client, through us: it gets the defaults whole
  // and, for the address, the board's own proxy prefix. A relative base resolves
  // against whatever origin the page came from, so the phone off the tailnet and
  // the https page both reach the engine, and the real engine address stays the
  // server's business. No tts config => no tts key => the UI is byte-for-byte
  // what it was before this feature existed.
  const t = ttsConfig();
  if (t) out.tts = Object.assign({ enabled: true }, t, { url: TTS_PREFIX });
  return out;
}
// External TTS engine (voxbench API), optional: config.json
//   "tts": { "url": "http://127.0.0.1:8883", "voice": null, "lang": "pt", "params": {} }
// Anything malformed (or a missing url) reads as "not configured".
function ttsConfig() {
  const t = readConfig().tts;
  const url = engineUrl(t);
  if (!url) return null;
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return {
    url,
    lang: str(t.lang),
    voice: str(t.voice),
    params: t.params && typeof t.params === 'object' && !Array.isArray(t.params) ? t.params : {},
  };
}
// The engines themselves, on the board's own origin (server/proxy.js). No
// engine configured means no route at all: the prefix falls through to the
// ordinary 404. STT is config.json "stt": { "url": "http://127.0.0.1:8878" },
// and nothing is handed to the UI for it — ui/stt-test.html is the only page
// that speaks it, over http and websocket both.
const ttsProxy = makeProxy({ prefix: TTS_PREFIX, idleEnv: 'BC_TTS_IDLE_MS', urlOf: () => engineUrl(readConfig().tts) });
const sttProxy = makeProxy({ prefix: '/api/stt', idleEnv: 'BC_STT_IDLE_MS', urlOf: () => engineUrl(readConfig().stt) });
// Port: --port flag > config.json "port" > 4780. The resolved port is written
// back into config.json when absent, so the CLI and UI can always find it.
const cfg = readConfig();
const PORT = opts.port || (Number.isInteger(cfg.port) && cfg.port > 0 ? cfg.port : DEFAULT_PORT);
if (!Number.isInteger(cfg.port) || cfg.port <= 0) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(Object.assign({}, cfg, { port: PORT }), null, 2) + '\n');
}
// Bind host is machine-private config: --host flag > config.json "host" > 127.0.0.1.
function configHost() {
  const c = readConfig();
  if (typeof c.host === 'string' && /^[\w.:-]+$/.test(c.host.trim())) return c.host.trim();
  return '';
}
const LOOPBACKS = ['127.0.0.1', 'localhost', '::1'];
const BIND_HOST = opts.host || configHost() || '127.0.0.1';
// Turn-end hooks (workspace-level and per-worker-spawn) POST here.
const TURNEND_URL = 'http://127.0.0.1:' + PORT + '/api/turn-end';
// The harness port BOUND to this workspace: every verb gets the state dir and
// the turn-end callback from here, so no call site passes them and none can
// forget them. The rest of the server asks for harnesses only through these two.
const HARNESS_ENV = Object.freeze({ stateDir: HARNESS_STATE_DIR, callbackUrl: TURNEND_URL });
function harnessFor(ref) { return port.harnessFor(ref, HARNESS_ENV); }
function getHarness(name) { return port.getHarness(name, HARNESS_ENV); }
// The harnesses plugins contribute as profiles (plugins/*/plugin.json and the
// workspace's own), registered once, before anything asks for one by name.
// A bad profile is logged and skipped; it never stops the boot.
{
  const manifests = require(path.join(__dirname, 'manifests.js'));
  const log = (m) => console.error(now() + ' ' + m);
  const catalog = manifests.resolveCatalog({ workspaceDir: path.join(STATE_DIR, 'plugins'), stateDir: STATE_DIR, log });
  require(path.join(__dirname, '..', 'harness', 'profiles.js')).loadProfiles({
    profiles: manifests.contributions(catalog).profiles,
    stateDir: STATE_DIR, // where secrets.env lives
    harnessStateDir: HARNESS_STATE_DIR,
    log,
  });
}

// The commit this process is RUNNING, decided once here at boot and never
// re-read: a merge into the checkout below moves the files, not this record,
// and /api/status hands the difference to the CLI to announce. Boot is the only
// place a git subprocess is allowed — no request path ever pays for it.
// BC_CODE_ROOT is a test-only seam (tests point it at a fabricated checkout).
const CODE_ROOT = process.env.BC_CODE_ROOT || path.join(__dirname, '..');
const CODE = gitrev.bootRecord(CODE_ROOT);

// ---------- pidfile: single instance per workspace ----------
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
// A live pid alone isn't proof it's OUR server — pids get recycled by the OS,
// so an unrelated process can end up wearing a stale server.pid. Sanity-check
// via /proc/<pid>/cmdline (Linux only — cmdline is null/unreadable elsewhere,
// e.g. after the process exits mid-check or on a non-Linux OS) so a recycled
// pid doesn't block a real boot; null means "can't tell" and falls back to
// trusting pidAlive, same as before this check existed.
function looksLikeOurServer(pid) {
  try {
    const cmdline = fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8');
    return cmdline.split('\0').some((a) => a && path.basename(a) === 'server.js');
  } catch (e) { return null; }
}
if (fs.existsSync(PID_FILE)) {
  const old = parseInt(fs.readFileSync(PID_FILE, 'utf8'), 10);
  if (old && pidAlive(old)) {
    const ours = looksLikeOurServer(old);
    if (ours !== false) process.exit(0); // live server already owns this workspace (or unverifiable — trust it)
    // else: pid is alive but is NOT a bridge-commander server — a recycled pid
    // wearing a stale pidfile. Fall through and boot normally.
  }
}
fs.writeFileSync(PID_FILE, String(process.pid));
function cleanup() {
  try { if (parseInt(fs.readFileSync(PID_FILE, 'utf8'), 10) === process.pid) fs.unlinkSync(PID_FILE); } catch (e) {}
}
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanup(); process.exit(0); });

// ---------- board state ----------
function now() { return new Date().toISOString(); }

// The fixed column frame. No Done: cards leave by archive (merged | killed).
const COLUMNS = [
  { id: 'backlog', title: '📋 Backlog' },
  { id: 'working', title: '🔨 Working' },
  { id: 'review', title: '👀 Your review' },
  { id: 'peer', title: '🤝 Peer review' },
];
const CARD_TYPES = ['plan', 'implementation', 'investigation'];

// Worker lease states. `absent` is never persisted: it is the derived state of a
// card with no worker linked (persisted lease = null).
const WORKER_STATES = ['absent', 'idle', 'working', 'needs-you'];
const WORKER_LEASE_STATES = ['idle', 'working', 'needs-you'];
const WORKER_TTL_SECS = parseFloat(process.env.BC_WORKER_TTL_SECS) || 600;

function defaultBoard() {
  return {
    title: path.basename(WORKSPACE), subtitle: '', updated: now(), seq: 0,
    columns: COLUMNS, lieutenants: [], cards: [], events: [], labels: [], reads: {}, kinds: {},
    projects: [], workers: [], schedules: [], line: null,
  };
}
function normalizeBoard(doc) {
  const b = Object.assign(defaultBoard(), doc);
  b.columns = COLUMNS; // the frame is fixed — never board data
  if (!Array.isArray(b.lieutenants)) b.lieutenants = [];
  if (!Array.isArray(b.cards)) b.cards = [];
  if (!Array.isArray(b.events)) b.events = [];
  if (!Array.isArray(b.labels)) b.labels = [];
  if (!b.reads || typeof b.reads !== 'object') b.reads = {};
  if (typeof b.line !== 'string' || !b.line) b.line = null; // resolved through lineHolder()
  b.kinds = sanitizeKinds(b.kinds);
  for (const lt of b.lieutenants) {
    if (!Array.isArray(lt.chat)) lt.chat = [];
    // ref: a persisted HarnessRef or null (odd shapes collapse to null).
    if (lt.ref !== undefined && !isHarnessRef(lt.ref)) lt.ref = null;
  }
  ensureMinting(b.lieutenants); // prefix + card counter (backfilled for the ones that predate them)
  // projects: the registered-repo registry; workers: the live worker-ref registry
  // (both survive restarts — board is truth). Odd shapes are dropped. A `mode`
  // left over from delivery modes is ignored and dropped on the next write:
  // the card's playbook chooses the delivery contract now.
  if (!Array.isArray(b.projects)) b.projects = [];
  b.projects = b.projects.filter((p) => p && typeof p === 'object'
    && typeof p.name === 'string' && p.name
    && typeof p.path === 'string' && p.path);
  for (const p of b.projects) delete p.mode;
  if (!Array.isArray(b.workers)) b.workers = [];
  b.workers = b.workers.filter((w) => w && typeof w === 'object' && w.card && isHarnessRef(w.ref));
  // schedules: the board's own clock. A schedule whose `when` no longer parses
  // is KEPT (it says so on the schedule, and the tick refuses to fire it) —
  // dropping it would be a clock that silently loses an entry, which is the
  // exact failure host cron already had.
  b.schedules = normalizeSchedules(b.schedules);
  for (const c of b.cards) {
    if (!Array.isArray(c.events)) c.events = [];
    if (!Array.isArray(c.thread)) c.thread = [];
    if (!Array.isArray(c.labels)) c.labels = [];
    if (!c.attributes || typeof c.attributes !== 'object') c.attributes = {};
    if (!CARD_TYPES.includes(c.type)) c.type = 'implementation';
    // playbook: the id of a file in playbooks/, or '' — cards that predate it
    // have none and cannot start until one is set (card patch --playbook <id>).
    if (typeof c.playbook !== 'string') c.playbook = '';
    if (!b.columns.some((k) => k.id === c.column)) c.column = 'backlog';
    if (c.pendingOrder && !(typeof c.pendingOrder === 'object' && c.pendingOrder.kind)) c.pendingOrder = null;
    // status: keep only a valid persisted worker lease; an absent status stays
    // absent (means "status.set never touched this card"), odd shapes collapse
    // to a cleared lease. Decay is derived on read, never persisted.
    if (c.status !== undefined) {
      const w = c.status && typeof c.status === 'object' ? c.status.worker : null;
      const ok = w && typeof w === 'object' && w.id && WORKER_LEASE_STATES.includes(w.state);
      c.status = { worker: ok ? { id: String(w.id), state: w.state, expires: w.expires || null } : null };
    }
  }
  // seq must top every stored event (defensive after hand edits)
  let max = b.seq || 0;
  for (const e of b.events) if (e.seq > max) max = e.seq;
  for (const c of b.cards) for (const e of c.events) if (e.seq > max) max = e.seq;
  b.seq = max;
  return b;
}
// What lands on disk: the board MINUS every lieutenant's chat. The main chat is
// an append-only log of its own (chat/<id>.jsonl, below) — keeping a second copy
// here is the drift bug, and it is what made every write rewrite megabytes of
// conversation nobody scrolls to.
function storedBoard(b) {
  return Object.assign({}, b, {
    lieutenants: b.lieutenants.map((l) => {
      const copy = Object.assign({}, l);
      delete copy.chat;
      return copy;
    }),
  });
}
// The board lives in the store (server/store.js): it is the only writer of
// board.json, mints every event, and coalesces the SSE push. `board` is the
// live object for the rest of this file; a change goes through store.mutate
// (a domain result) or store.commit (a change already made).
const store = createStore({
  file: BOARD_FILE, normalize: normalizeBoard, fresh: defaultBoard, serialize: storedBoard,
  kinds: () => effectiveKinds(), now,
  publish: () => sseSend('board', publicBoard('user')),
  log: (m) => console.error(now() + ' ' + m),
});
const board = store.load();

// One-time migration, at boot: the charter used to be a board field. Move what
// is still there into the lieutenant's memory file and drop the key. The write
// happens ONLY when no file exists yet — booting twice must not overwrite what
// the lieutenant has since written into its own memory — but the key goes
// either way, so this converges on the first boot and is a no-op on the second.
(function migrateCharters() {
  let moved = false;
  for (const lt of board.lieutenants) {
    if (!('charter' in lt)) continue;
    const text = String(lt.charter || '').trim();
    if (text && !fs.existsSync(charterPath(WORKSPACE, lt.id))) {
      // A workspace that cannot take the write keeps its key for the next boot
      // to retry: one stale field must never be what stops the board booting.
      try { writeCharter(WORKSPACE, lt.id, text); }
      catch (e) {
        console.error('charter migration failed for ' + lt.id + ': ' + String((e && e.message) || e));
        continue;
      }
    }
    delete lt.charter;
    moved = true;
  }
  if (moved) store.save();
})();

// ---------- events / kinds ----------
// A kind is an open token. The server ships structural defaults only for the
// kinds its OWN operations emit; a board may register its own kinds map
// (PUT /api/kinds) whose entries are merged OVER these built-ins. A kind in
// neither map is stored as-is (opaque token: no emoji, level falls back to 2).
const BUILTIN_KINDS = {
  created: { emoji: '🐣', level: 2 },
  moved: { emoji: '🔁', level: 2 },
  ordered: { emoji: '⏳', level: 2 },
  handoff: { emoji: '👀', level: 1 },
  landed: { emoji: '🏁', level: 1 },
  killed: { emoji: '🪦', level: 2 },
  resurrected: { emoji: '🧟', level: 1 },
  question: { emoji: '🙋', level: 1 },
  started: { emoji: '🚀', level: 2 },
  signal: { emoji: '📡', level: 2 },
  'worker-done': { emoji: '✅', level: 2 },
  'worker-died': { emoji: '💀', level: 2 },
  'hook-ran': { emoji: '🪝', level: 2 },
  'hook-failed': { emoji: '🧨', level: 1 },
  schedule: { emoji: '⏰', level: 2 },
  // What the packaged gh-watch hook puts on a card when a check goes red. A
  // kind is an open token, but the one hook this board ships with earns an
  // emoji: an unlabelled row on the timeline is the thing nobody reads.
  'ci-failed': { emoji: '🔴', level: 1 },
  'schedule-failed': { emoji: '🔔', level: 1 },
  'worker-stopped': { emoji: '⏸️', level: 2 },
  'worker-stalled': { emoji: '🐢', level: 1 },
  // A worker that would not die. The record is kept on purpose (a session
  // nothing points at is a leak), so this has to be loud enough that somebody
  // ends it: level 1, the captain's bell.
  'worker-kill-failed': { emoji: '🧟', level: 1 },
  // A start that could not put the worker on the tip it just fetched. It still
  // started — that is exactly why this is level 1: the work is running, on a
  // base nobody chose.
  'stale-base': { emoji: '🧊', level: 1 },
  'worker-paused': { emoji: '💤', level: 2 },
  parked: { emoji: '🅿️', level: 2 },
  respawned: { emoji: '♻️', level: 1 },
  // The captain moved a lieutenant to another harness (or model): its session
  // is gone and a new one is up on the respawn prompt. Level 1 — nobody should
  // learn that from the session name changing under them.
  'harness-switch': { emoji: '🔀', level: 1 },
  'needs-captain': { emoji: '🚨', level: 1 },
  line: { emoji: '📞', level: 2 },
  // Kinds the server's own verbs emit (/reset, worker send, PR watch, permission
  // decisions): without
  // an entry here they render on the timeline with no emoji.
  reset: { emoji: '🧹', level: 1 },
  'worker-send': { emoji: '📨', level: 2 },
  'pr-merged': { emoji: '🟣', level: 2 },
  permission: { emoji: '🔐', level: 2 },
};
function validKindEntry(v) {
  return !!(v && typeof v === 'object' && typeof v.emoji === 'string' && v.emoji.trim() &&
    (v.level === 1 || v.level === 2));
}
// Defensive normalization for the persisted registered map (hand edits included).
function sanitizeKinds(doc) {
  const out = {};
  if (doc && typeof doc === 'object' && !Array.isArray(doc)) {
    for (const [k, v] of Object.entries(doc)) {
      if (k.trim() && validKindEntry(v)) out[k.trim().slice(0, 60)] = { emoji: v.emoji.trim(), level: v.level };
    }
  }
  return out;
}
function effectiveKinds() { return Object.assign({}, BUILTIN_KINDS, board.kinds); }
// Events are minted by the store (it owns board.seq); level resolution is there.
const mkEvent = store.event;

// ---------- label registry (user-owned; persisted in board json) ----------
const LABEL_PALETTE = ['#4cc2ff', '#2fbf71', '#e2b93b', '#c678dd', '#e2795b', '#56b6c2', '#98c379', '#e06c75'];
function validColor(c) { return typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c) ? c : null; }
// lieutenant avatar: index into the 64-head sprite sheet (ui/img/avatars.png,
// 8x8, row-major). Absent = colored-dot fallback everywhere (every existing
// lieutenant has no avatar).
function validAvatar(a) { return Number.isInteger(a) && a >= 0 && a <= 63; }
const BAD_AVATAR = 'avatar must be an integer 0-63';
// lieutenant voice: an opaque TTS-engine voice id, whatever the engine calls its
// own. Absent = the board's voice speaks for this lieutenant (the default).
function validVoice(v) { return typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : null; }
// lieutenant model: the string handed STRAIGHT to the harness CLI as `--model`.
// Bridge Commander keeps no list of model names — a board that did would be
// wrong the week a new one ships — so the only rules are the ones argv itself
// has: one token, no control characters, bounded. Absent = the harness default
// (`~/.codex/config.toml` for codex, claude's own for claude).
function validModel(m) {
  if (typeof m !== 'string') return null;
  const t = m.trim();
  // eslint-disable-next-line no-control-regex
  if (!t || /[\s\u0000-\u001f]/.test(t) || t.length > 100) return null;
  return t;
}
function labelIndex(name) { return board.labels.findIndex((l) => l && l.name === name); }
function registerCardLabels() {
  for (const c of board.cards) {
    for (const n of c.labels || []) {
      if (typeof n === 'string' && n && labelIndex(n) < 0) {
        board.labels.push({ name: n, color: LABEL_PALETTE[board.labels.length % LABEL_PALETTE.length] });
      }
    }
  }
}

// ---------- lieutenants ----------
const LT_PALETTE = ['#58b6ff', '#3ecf8e', '#e6c04a', '#c678dd', '#e2795b', '#56b6c2', '#98c379', '#e06c75'];
function findLieutenant(id) { return board.lieutenants.find((l) => l.id === id); }

// Is this lieutenant's session actually up? Three answers, and the difference
// between the last two is why the config screen shows it at all — a dead
// lieutenant is indistinguishable from a live one on the board:
//   none — never spawned, so there is no session to be up (no ref)
//   live — the harness says its session is there
//   dead — it had one and it is gone (superviseTick is what brings it back)
async function sessionState(lt) {
  if (!isHarnessRef(lt.ref)) return 'none';
  try { return (await harnessFor(lt.ref).alive(lt.ref)) ? 'live' : 'dead'; }
  catch (e) { return 'dead'; } // an unknown harness cannot answer for it either
}

// ---------- card-id minting (prefix + counter, both the LIEUTENANT's) ----------
// A card id is <PREFIX>-<n>: the prefix names the lieutenant that created it,
// the number is that lieutenant's own counter — incremented at creation, never
// reissued. Nothing new lands on the card; the id is still just the id, so the
// branch (bc/<id>), the worktree and the artifact paths follow it unchanged.
// Cards born before this keep their hand-written slugs. There is no migration:
// every verb takes an id, and a slug is an id.
function validPrefix(p) {
  const s = String(p == null ? '' : p).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return /^[A-Z][A-Z0-9]{0,7}$/.test(s) ? s : null;
}
// Default from the display name: its first three letters. Accents fold, emoji
// and punctuation drop (the same "never let non-ASCII reach a name" rule as
// slugBase); a name with no letters at all falls back to LT.
function prefixFrom(name) {
  const letters = String(name || '').normalize('NFD').replace(/[^A-Za-z]/g, '');
  return letters ? letters.slice(0, 3).toUpperCase() : 'LT';
}
// A prefix belongs to one lieutenant at a time — two lieutenants sharing one
// would mint each other's ids and collide on every create. The default is
// nudged aside when taken (MON → MO2); an EXPLICIT prefix is refused instead,
// so the captain always learns his pick was unavailable.
function uniquePrefixIn(lts, base, exceptId) {
  const taken = (p) => lts.some((l) => l.id !== exceptId && l.prefix === p);
  if (!taken(base)) return base;
  for (let i = 2; ; i++) {
    const n = String(i);
    const cand = base.slice(0, Math.max(1, 3 - n.length)) + n;
    if (!taken(cand)) return cand;
  }
}
// The id this lieutenant mints next — what createCard will pick, said ahead of
// it so no client has to repeat the arithmetic.
function nextCardId(l) { return l.prefix + '-' + ((Number.isInteger(l.cardSeq) ? l.cardSeq : 0) + 1); }
const BAD_PREFIX = 'bad prefix (1-8 letters/digits starting with a letter — it heads every card id this lieutenant mints)';
const BAD_MODEL = 'bad model (one token, no spaces or control characters, max 100 chars — '
  + 'it is handed straight to the harness CLI as --model; null clears it back to the harness default)';
function prefixOwner(p, exceptId) {
  return board.lieutenants.find((l) => l.id !== exceptId && l.prefix === p) || null;
}
function prefixTakenMsg(p, owner) {
  return 'prefix ' + p + ' already belongs to ' + owner.name + ' (' + owner.id + ') — pick another';
}
// Backfill on load: lieutenants registered before this feature get a prefix and
// a counter at zero. Their existing slug cards are not touched or counted —
// the counter numbers what this lieutenant mints from now on.
function ensureMinting(lts) {
  for (const lt of lts) {
    const p = validPrefix(lt.prefix);
    lt.prefix = p || uniquePrefixIn(lts, prefixFrom(lt.name), lt.id);
    if (!Number.isInteger(lt.cardSeq) || lt.cardSeq < 0) lt.cardSeq = 0;
  }
}

// ---------- conversation & identity (server/conversation.js) ----------
// Who is talking — and, from there, what a say sets in motion — lives in one
// module bound to this board, so every route asks the same question the same way.
const conversation = createConversation({ board: () => board, now, queuePush, chatAppend, mkEvent });

/**
 * resolveHookAgent(body) — the agent a turn-end hook POST came from:
 * { lt, worker } with at most one set. The hook's fields mapped onto identify().
 */
function resolveHookAgent(body) {
  const tmux = typeof body.tmux_session === 'string' ? body.tmux_session : null;
  const who = conversation.identify({
    sessionId: body.session_id,
    key: body.session,
    session: tmux,
    // only an OLD hook (no tmux_session field at all) may be adopted by cwd
    cwd: tmux === null && body.cwd ? path.resolve(String(body.cwd)) : '',
  });
  return { lt: who.kind === 'lieutenant' ? who.lt : null, worker: who.kind === 'worker' ? who.worker : null };
}

/**
 * callerOf(fields) — identify() for a CLI caller: bc-axi sends its tmux
 * `session` and `window` (the window is absent from an older bc-axi).
 */
function callerOf(fields) {
  return conversation.identify({ session: fields.session, window: fields.window });
}

// ---------- the line (the captain's voice channel) ----------
// The captain talks to the board from his phone with the screen off, through a
// voice shortcut that has no chat picker: it posts `target: "line"` and names
// nobody. WHO that reaches is the SERVER's memory — the phone is not the only
// thing that talks to this board, so a client-side answer (localStorage and
// friends) would be a different answer per device.
//
// Two ways the line moves, and no third:
//   - it follows the conversation — whoever last spoke to the captain in a main
//     chat holds it, so nobody has to maintain it;
//   - `line.pass` hands it over deliberately, as a delivery to the receiver.
// A workspace that has never had a conversation still has to answer: the
// FOUNDING lieutenant (first registered — the teleport) holds it by default, so
// the shortcut works on day one with nothing seeded. Only a board with no
// lieutenant at all has nobody on the line.
function lineHolder() { return conversation.lineHolder(); }

function createLieutenant(body) {
  const name = String(body.name || '').trim();
  if (!name) return { error: 'name required', code: 400 };
  const id = body.id ? String(body.id) : lieutenantIdFrom(name);
  if (!isId(id)) return { error: 'bad lieutenant id (use [A-Za-z0-9_.-])', code: 400 };
  if (findLieutenant(id)) return { error: 'lieutenant exists: ' + id, code: 409 };
  if (body.avatar !== undefined && body.avatar !== null && !validAvatar(body.avatar)) {
    return { error: BAD_AVATAR, code: 400 };
  }
  let prefix;
  if (body.prefix === undefined || body.prefix === null || body.prefix === '') {
    prefix = uniquePrefixIn(board.lieutenants, prefixFrom(name), id);
  } else {
    prefix = validPrefix(body.prefix);
    if (!prefix) return { error: BAD_PREFIX, code: 400 };
    const clash = prefixOwner(prefix, id);
    if (clash) return { error: prefixTakenMsg(prefix, clash), code: 409 };
  }
  const color = validColor(body.color) || LT_PALETTE[board.lieutenants.length % LT_PALETTE.length];
  const lt = {
    id, name: name.slice(0, 60), color, prefix, cardSeq: 0,
    chat: [], created: now(),
  };
  if (validAvatar(body.avatar)) lt.avatar = body.avatar;
  if (validVoice(body.voice)) lt.voice = validVoice(body.voice);
  if (validModel(body.model)) lt.model = validModel(body.model);
  if (isHarnessRef(body.ref)) lt.ref = body.ref; // the live-session address, persisted with the board
  board.lieutenants.push(lt);
  store.boardEvent({ text: 'lieutenant ' + lt.name + ' joined the bridge', actor: body.actor || 'user', level: 2 });
  return { lieutenant: lt };
}

// lieutenant.create with spawn: birth a REAL session via the harness port in the
// workspace root, then register the lieutenant with the returned ref. Launch
// prompt = doctrine + charter + situating line. installHooks:false because the
// workspace-level Stop hook (installed by `bc-axi init`) already covers every
// claude in this cwd; the server dedupes its turn-end POSTs by session_id.
function doctrineText() {
  try { return fs.readFileSync(path.join(__dirname, '..', 'DOCTRINE.md'), 'utf8').trim(); }
  catch (e) { return ''; }
}
function lieutenantPrompt(name, id) {
  const cli = path.join(__dirname, '..', 'cli', 'bc-axi');
  const charter = readCharter(WORKSPACE, id);
  return [
    doctrineText(),
    '## Your charter\n\n' + (charter
      || 'Your memory file at ' + charterPath(WORKSPACE, id) + ' does not exist yet; write it.'),
    'You are lieutenant "' + name + '" (id: ' + id + ') in workspace ' + WORKSPACE + '.\n'
      + 'The board server runs at http://127.0.0.1:' + PORT + '/. The board CLI is `bc-axi`'
      + ' (at ' + cli + ' if not on your PATH).\n'
      + 'Your first act, now and at the start of every turn: run `bc-axi drain`. Ack what you handle.',
  ].filter(Boolean).join('\n\n');
}
// A handoff artifact on one of the lieutenant's PLAN cards is the note the
// previous incarnation left for whoever picks the work up. The fresh session
// gets the PATHS and nothing else — a prompt that inlined them would be a
// launch prompt the size of a plan, and the agent can read what it decides it
// needs. Label match is `handoff*` (handoff, handoff-2026-09, handoff notes).
function handoffPointers(owned) {
  const out = [];
  for (const c of owned) {
    if (c.type !== 'plan') continue;
    const arts = Array.isArray(c.attributes && c.attributes.artifacts) ? c.attributes.artifacts : [];
    for (const a of arts) {
      if (!a || typeof a.label !== 'string' || !/^handoff/i.test(a.label.trim())) continue;
      const uri = String(a.uri || '');
      out.push('- ' + c.id + ' (' + a.label.trim() + '): '
        + (uri.startsWith('file://') ? decodeURIComponent(uri.slice(7)) : uri));
    }
  }
  return out;
}
// Relaunch prompt for a lieutenant whose dead session has no recoverable
// memory (harness.resumable said no): the same doctrine + charter launch
// prompt, plus a compact board digest — owned cards, the handoff notes on them,
// and the pending queue count — so the fresh session reorients from truth
// instead of lost conversation.
function respawnPrompt(lt) {
  const owned = board.cards.filter((c) => c.owner === lt.id);
  const digest = owned.map((c) => '- ' + c.id + ' [' + c.column + '] ' + c.title).join('\n');
  const handoffs = handoffPointers(owned);
  return lieutenantPrompt(lt.name, lt.id) + '\n\n'
    + '## Respawned without memory\n\n'
    + 'Your previous session is gone; the board is truth — reorient from it.\n'
    + 'Your cards (' + owned.length + '):\n' + (digest || '(none)') + '\n'
    + (handoffs.length
      ? 'Handoff notes on your plan cards — read these first:\n' + handoffs.join('\n') + '\n'
      : '')
    + 'Pending queue: ' + pendingItems(lt.id).length + ' item(s). Your first act: `bc-axi drain`.';
}

// The launch options every lieutenant spawn and resume goes out with. The model
// is the TYPED `model` option, the way card.start pins a worker's: the harness
// turns it into its own flag and records it with the spawn, so a resume
// replays it — a lieutenant pinned to a model comes back on it, respawn after
// respawn. A harness that cannot take a model starts without it, and the
// board says so once per lieutenant and harness, not on every respawn.
const ignoredLtOptions = new Set();
function ltLaunchOpts(lt, extra, harness) {
  const opts = Object.assign(
    { installHooks: false, permissionMode: configPermissionMode() },
    extra || {}
  );
  const name = harness || (lt && lt.ref && lt.ref.harness) || readConfig().harness || port.defaultHarness();
  let impl = null;
  try { impl = getHarness(name); } catch (e) { return opts; } // the spawn names the unknown harness itself
  const { opts: typed, ignored } = port.splitOptions(impl, { model: lt && validModel(lt.model) });
  Object.assign(opts, typed);
  for (const opt of ignored) {
    const once = (lt && (lt.id || lt.name)) + '|' + name + '|' + opt;
    if (ignoredLtOptions.has(once)) continue;
    ignoredLtOptions.add(once);
    store.boardEvent({ text: 'lieutenant ' + ((lt && (lt.name || lt.id)) || '?') + ': ' + name + ' does not support '
      + opt + '; started without it', actor: 'server' }, { kind: 'option-ignored' });
  }
  return opts;
}

// The one way a lieutenant comes back FROM NOTHING: kill whatever holds its
// window and spawn a new session on respawnPrompt (doctrine + charter + what it
// owns). /reset, supervision's non-resumable branch and a harness switch all
// land here, so there is one implementation of "start this lieutenant over",
// not three.
//
// `harness` names the one to come back on — absent = the one it is on. The KILL
// always goes to the harness that owns the pane today (a switch changes hands
// between these two lines), and it takes the lieutenant's WINDOW, never its
// session: the worker windows cohabiting it are alive and did not ask to die.
// A kill that fails is logged, not fatal — a pane nobody could clear announces
// itself in the spawn that follows, and a dead one is exactly what we wanted.
async function respawnFresh(lt, harness) {
  const impl = getHarness(harness || lt.ref.harness);
  // Keep the session name (an incarnation, not a new entity) when it is
  // spawnable; a founder's foreign name gets a workspace-scoped one.
  const session = isSpawnableSession(lt.ref.session)
    ? lt.ref.session : names.lieutenantSession(WORKSPACE, lt.id);
  const window = lt.ref.window || names.LIEUTENANT_WINDOW;
  try { await harnessFor(lt.ref).kill({ ...lt.ref, window }); }
  catch (e) { console.error(now() + ' kill failed relaunching ' + lt.id + ': ' + String((e && e.message) || e)); }
  return impl.spawn(lt.ref.cwd, respawnPrompt(lt), ltLaunchOpts(lt, { session, window }, harness || lt.ref.harness));
}

async function spawnLieutenant(body) {
  const name = String(body.name || '').trim();
  if (!name) return { error: 'name required', code: 400 };
  const id = body.id ? String(body.id) : lieutenantIdFrom(name);
  if (!isId(id)) return { error: 'bad lieutenant id (use [A-Za-z0-9_.-])', code: 400 };
  // revive:true is what makes `bc-axi init --onboard` re-runnable: the founding
  // lieutenant already exists, and the question is only whether her session is
  // still up. A live one is left strictly alone (spawning over a live session
  // is how you lose a conversation); a dead or never-spawned one gets a new
  // session on the same record, charter and chat history included.
  const existing = findLieutenant(id);
  if (existing && !body.revive) return { error: 'lieutenant exists: ' + id, code: 409 };
  if (existing && (await sessionState(existing)) === 'live') {
    return { lieutenant: existing, spawned: false };
  }
  const harnessName = String(body.harness || readConfig().harness || port.defaultHarness());
  let impl;
  try { impl = getHarness(harnessName); } catch (e) { return { error: String(e.message || e), code: 400 }; }
  if (body.model !== undefined && body.model !== null && body.model !== '' && !validModel(body.model)) {
    return { error: BAD_MODEL, code: 400 };
  }
  // Checked before the spawn, not after it in createLieutenant: a refusal
  // there would leave a live session behind with no lieutenant to own it.
  if (body.avatar !== undefined && body.avatar !== null && !validAvatar(body.avatar)) {
    return { error: BAD_AVATAR, code: 400 };
  }
  // A revived lieutenant keeps the model it was pinned to unless this call
  // names another; a new one is born on whatever it was given.
  const model = validModel(body.model) || (existing && validModel(existing.model)) || null;
  const session = names.lieutenantSession(WORKSPACE, id);
  let ref;
  try {
    ref = await impl.spawn(WORKSPACE, lieutenantPrompt(name, id), ltLaunchOpts({ id, name, model }, {
      session,
      window: names.LIEUTENANT_WINDOW, // its own window in its own session — see layout.js
      // Only the first run sends this, and only when the person said so out
      // loud: the harness decides what it means.
      allowRoot: !!body.allowRoot,
    }, harnessName));
  } catch (e) {
    return { error: 'spawn failed: ' + String((e && e.message) || e), code: 502 };
  }
  if (existing) {
    existing.ref = ref;
    if (model) existing.model = model; else delete existing.model;
    return { lieutenant: existing, spawned: true };
  }
  return Object.assign({ spawned: true }, createLieutenant(Object.assign({}, body, { id, ref })));
}

// lieutenant.retire — explicit only (the DNA). Refuses while the lieutenant
// still owns non-archived cards (archive or finish them first); otherwise
// kills its live session via the harness port, removes the lieutenant (ref
// included) and its delivery queue, and lands a loud level-1 event.
async function retireLieutenant(id, body) {
  const lt = findLieutenant(id);
  if (!lt) return { error: 'unknown lieutenant: ' + id, code: 404 };
  const owned = board.cards.filter((c) => c.owner === id);
  if (owned.length) {
    return { error: 'lieutenant ' + id + ' still owns ' + owned.length + ' card(s): '
      + owned.map((c) => c.id).join(', ') + ' — archive or finish them first', code: 409 };
  }
  if (isHarnessRef(lt.ref)) {
    try { await harnessFor(lt.ref).kill(lt.ref); }
    catch (e) { console.error(now() + ' kill failed retiring ' + id + ': ' + String((e && e.message) || e)); }
  }
  board.lieutenants = board.lieutenants.filter((l) => l.id !== id);
  if (board.line === id) board.line = null; // the line falls back rather than pointing at a ghost
  respawnAttempts.delete(id);
  delivery.forget(id); // a retired lieutenant can never drain again: its queue goes too
  // …and so does its conversation, which used to leave with the record itself:
  // a conversation belongs to the instance that had it. The memory file does
  // NOT leave — lieutenants/<id>/ belongs to the ROLE, hand-written by the
  // captain and versioned in git — so retire names the path it leaves behind
  // rather than deleting it, and a same-slug successor inherits it knowingly.
  try { fs.unlinkSync(chatFile(id)); } catch (e) { /* none */ }
  const memory = fs.existsSync(charterPath(WORKSPACE, id)) ? charterPath(WORKSPACE, id) : null;
  const ev = store.boardEvent({ text: 'lieutenant ' + lt.name + ' retired',
    actor: (body && body.actor) || 'user', level: 1 });
  return { ok: true, event: ev, memory };
}

/**
 * lieutenant.patch minus the harness switch: validates every field before any
 * applies, so a refusal leaves no half-applied lieutenant behind. Names the
 * harness to switch to (validated, not applied) for the caller to run last.
 * @returns {{ok: true, harness: string}|{error: string, code: number}}
 */
function patchLieutenant(lt, body) {
  // Prefix is the only field a peer can veto (two lieutenants may not share
  // one). Past cards keep the id they were minted with — a prefix change is
  // about what comes next.
  let prefix;
  if (body.prefix !== undefined) {
    prefix = validPrefix(body.prefix);
    if (!prefix) return { error: BAD_PREFIX, code: 400 };
    const clash = prefixOwner(prefix, lt.id);
    if (clash) return { error: prefixTakenMsg(prefix, clash), code: 409 };
  }
  if (body.ref !== undefined && body.ref !== null && !isHarnessRef(body.ref)) {
    return { error: 'bad ref (want {harness, session, cwd, resumeId?} or null)', code: 400 };
  }
  if (body.avatar !== undefined && body.avatar !== null && !validAvatar(body.avatar)) {
    return { error: 'avatar must be an integer 0-63 or null', code: 400 };
  }
  // null / "" clears the model back to the harness's own default.
  const clearModel = body.model === null || body.model === '';
  const model = body.model !== undefined && !clearModel ? validModel(body.model) : null;
  if (body.model !== undefined && !clearModel && !model) return { error: BAD_MODEL, code: 400 };
  const harness = body.harness !== undefined && body.harness !== null ? String(body.harness) : '';
  if (harness) {
    try { getHarness(harness); } catch (e) { return { error: String((e && e.message) || e), code: 400 }; }
  }

  if (prefix) lt.prefix = prefix;
  if (body.ref !== undefined) {
    // A re-run of `bc-axi init` re-sends the founder's session-granular ref
    // (the caller's tmux session is all it can see). Keep the window this
    // lieutenant was already pinned to — losing it would put the ref back
    // to killing its whole session, worker windows included, on revive.
    lt.ref = body.ref && !body.ref.window && lt.ref && lt.ref.window
      && lt.ref.session === body.ref.session
      ? { ...body.ref, window: lt.ref.window }
      : body.ref;
  }
  if (body.name !== undefined && String(body.name).trim()) lt.name = String(body.name).trim().slice(0, 60);
  if (body.color !== undefined && validColor(body.color)) lt.color = body.color;
  if (body.avatar === null) delete lt.avatar;
  else if (body.avatar !== undefined) lt.avatar = body.avatar;
  // "" / null clears the pick — the lieutenant is back to the board's voice.
  if (body.voice !== undefined) {
    const v = validVoice(body.voice);
    if (v) lt.voice = v; else delete lt.voice;
  }
  // The model is stored, not applied: it rides `--model` on the next spawn
  // or resume this lieutenant gets. Set BEFORE the harness switch, so a
  // captain who moves harness and model in one call lands on both.
  if (clearModel) delete lt.model;
  else if (model) lt.model = model;
  return { ok: true, harness };
}

// ---------- delivery (server/delivery.js: queues, cursors, wakes, owed) ----------
// One QueueItem = one durable delivery to a lieutenant: a captain message, a
// drag-order, a worker event. Write-ahead and at-least-once: the queue write
// lands first, then ONE coalesced wake line goes to the lieutenant's live
// session; only an ack removes. A failed wake is non-fatal — the turn-end hook
// and the supervision sweep re-nudge — and the wake flag is in-memory by
// design: after a restart the next append or turn-end simply re-nudges.
const WAKE_TTL_MS = process.env.BC_WAKE_TTL_MS !== undefined
  ? parseInt(process.env.BC_WAKE_TTL_MS, 10) : 90000;
const delivery = createDelivery({
  dir: QUEUE_DIR,
  wakeTtlMs: WAKE_TTL_MS,
  send(ltId, text) {
    const lt = findLieutenant(ltId);
    if (!lt || !isHarnessRef(lt.ref)) return false;
    const ref = lt.ref;
    return Promise.resolve()
      .then(() => harnessFor(ref).send(ref, text))
      .catch((e) => {
        console.error(now() + ' wake failed for ' + ltId + ' (' + ref.harness + ':' + ref.session + '): '
          + String((e && e.message) || e));
        throw e;
      });
  },
});
// The names the rest of the server calls.
function queuePush(lt, rec) { return delivery.push(lt, rec); }
function pendingItems(lt) { return delivery.pending(lt); }
function scheduleWake(lt) { delivery.nudge(lt); }

// ---------- lieutenant main chat (append-only files; the FILE is truth) ----------
// One jsonl per lieutenant, written exactly the way archive.jsonl and the
// delivery queues are: one message per line, appended, never rewritten. A
// message is durable the moment the line lands — a crash before the next
// board save loses nothing, because the board stores no chat at all.
// The server keeps the newest CHAT_TAIL per lieutenant in memory (lt.chat, read
// from the file at boot) and that is what GET /api/board ships; everything
// older is paged in over GET /api/chat. No index, no compaction: reading the
// whole file is a boot/paging cost, and the hot path (append) never reads it.
// Card threads are NOT here — they die with their card, so board.json is still
// the right home for them.
const CHAT_TAIL = 50;
function chatFile(lt) { return path.join(CHAT_DIR, lt + '.jsonl'); }
// A crash mid-append can leave one torn line behind. That line is skipped and
// the rest of the conversation is served — the file is never rewritten to
// repair it, because append-only means append-only.
function readChatLog(lt) { return readJsonl(chatFile(lt)); }
// The one writer. Appends the line, then extends the in-memory tail — so the
// served board reflects the message without re-reading the file.
function chatAppend(ltId, msg) {
  fs.appendFileSync(chatFile(ltId), JSON.stringify(msg) + '\n');
  const lt = findLieutenant(ltId);
  if (lt) {
    if (!Array.isArray(lt.chat)) lt.chat = [];
    lt.chat.push(msg);
    if (lt.chat.length > CHAT_TAIL) lt.chat.splice(0, lt.chat.length - CHAT_TAIL);
  }
  return msg;
}
// A page of history, oldest-last (the order the pane renders). `before` is the
// ts of the oldest message the caller already has — strictly older messages are
// returned, so paging walks backwards; past the beginning the page is empty.
// limit <= 0 means the whole conversation (what `bc-axi thread` asks for).
function chatPage(ltId, before, limit) {
  let all = readChatLog(ltId);
  if (before) all = all.filter((m) => m && m.ts && m.ts < before);
  return limit > 0 ? all.slice(-limit) : all;
}
function chatTail(ltId, n) { return chatPage(ltId, '', n); }
// Boot migration, once: a lieutenant that still carries `chat` in board.json
// gets it appended to its file in order, and the key is dropped by the save
// (storedBoard strips it). The second boot reads a board with no chat key at
// all, so it appends nothing — normalizeBoard leaves an empty array behind.
{
  let migrated = 0, carried = false;
  for (const lt of board.lieutenants) {
    const stored = Array.isArray(lt.chat) ? lt.chat : [];
    if (stored.length) carried = true;
    // The file's existence IS the "already migrated" mark, and it appears whole
    // (write + rename) or not at all — so a crash anywhere in here can never
    // double his history on the next boot, and never truncate it either.
    if (stored.length && !fs.existsSync(chatFile(lt.id))) {
      const tmp = chatFile(lt.id) + '.tmp';
      fs.writeFileSync(tmp, stored.map((m) => JSON.stringify(m) + '\n').join(''));
      fs.renameSync(tmp, chatFile(lt.id));
      migrated += stored.length;
    }
    lt.chat = chatTail(lt.id, CHAT_TAIL);
  }
  if (migrated) console.log('[bridge-commander] moved ' + migrated + ' lieutenant chat message(s) out of board.json');
  if (carried) store.save(); // drops the key even when the file was already there
}

// ---------- card status (the ONE work signal; derived on read) ----------
// card.status.worker is the only writable signal, set exclusively by status.set
// (POST /api/cards/:id/status) as a lease with expiry: the persisted record is
// {id, state, expires}; when the lease expires, working/needs-you decays to
// idle AT READ TIME (no timers, so decay survives a restart). No worker → absent.
// `owed` and `unread` are server-derived from persisted thread/event/read state,
// so they too survive restarts; nobody writes them.
function derivedWorker(card) {
  const w = card.status && card.status.worker;
  if (!w || !w.id) return { id: null, state: 'absent' };
  let state = w.state;
  if ((state === 'working' || state === 'needs-you') && w.expires && Date.parse(w.expires) <= Date.now()) state = 'idle';
  return { id: w.id, state, expires: w.expires };
}
function lastThreadReadMs(target, user) {
  const r = board.reads[String(user || 'user').slice(0, 60)];
  const ts = r && r.threads && r.threads[target];
  return ts ? Date.parse(ts) : 0;
}
// owed is QUEUE truth, not thread order: the latest captain message delivered
// to this target has not been ACKED by its lieutenant. Thread order lies under
// interleaving — a captain message sent mid-turn gets buried when the lieutenant
// replies to an EARLIER batch. Only the ack clears owed; a reply alone does not.
// owedState splits it by the drained cursor (a lieutenant drains at the START of
// a turn, acks at the END): 'queued' = not drained yet, the lieutenant never saw
// it; 'seen' = drained, the turn is underway; null = not owed (delivery.owed).
function cardStatus(card, user) {
  const thread = card.thread || [];
  const owedState = delivery.owed('card:' + card.id);
  const owed = owedState !== null;
  const readMs = lastThreadReadMs('card:' + card.id, user);
  let unread = false;
  for (const m of thread) if (m.author !== 'user' && Date.parse(m.ts) > readMs) { unread = true; break; }
  if (!unread) for (const e of card.events || []) if (e.level === 1 && Date.parse(e.ts) > readMs) { unread = true; break; }
  return { worker: derivedWorker(card), owed, owedState, unread };
}
// Last REAL activity on a card, derived (never persisted). A card's mutable
// `updated` is bumped by incidental/system writes too — a status-lease refresh or
// decay (status.set) and any attribute patch — so it reads "now" for cards nothing
// meaningful happened to. Real activity always lands as an event or a thread
// message, so the max of those timestamps (floored at `created`) reflects genuine
// activity and ignores the bookkeeping writes. The UI shows and sorts on this.
function cardActivity(card) {
  let ts = card.created || card.updated || '';
  for (const e of card.events || []) if (e.ts && e.ts > ts) ts = e.ts;
  for (const m of card.thread || []) if (m.ts && m.ts > ts) ts = m.ts;
  return ts;
}
// Serialization view: cards go out with the derived `status` and `activity`
// attached; the stored board keeps only the raw lease.
function publicCard(card, user) {
  return Object.assign({}, card, { status: cardStatus(card, user), activity: cardActivity(card) });
}
// The served board carries the EFFECTIVE kinds map (built-ins merged under the
// registered entries); the stored board keeps only the registered map.
// `boot` identifies this server instance: a client seeing it change knows the
// server restarted and any SSE events in between are gone — refetch, don't trust
// the old stream.
const BOOT_ID = process.pid + '-' + Date.now();
function publicBoard(user) {
  const holder = lineHolder().lieutenant;
  return Object.assign({}, board, {
    boot: BOOT_ID,
    kinds: effectiveKinds(),
    // The RESOLVED holder, never the raw stored id: a board that never had a
    // conversation still names whoever a `target: "line"` post would reach.
    line: holder ? holder.id : null,
    cards: board.cards.map((c) => publicCard(c, user)),
    workers: board.workers.map(withStatusAge),
    // Held permission asks — in memory only, never in board.json (storedBoard
    // never sees them): a restart drops the held requests they stand for.
    permissions: permissions.list(),
    // chatOwed/chatQueued mirror status.owed/owedState:'queued' for a
    // lieutenant's MAIN chat — both queue-derived, same rules as cards.
    lieutenants: board.lieutenants.map((l) => Object.assign({}, withStatusAge(l), {
      chatOwed: delivery.owed('lieutenant:' + l.id) !== null,
      chatQueued: delivery.owed('lieutenant:' + l.id) === 'queued',
    })),
  });
}

// status.set — the ONLY writer of card.status.worker.
function setStatus(card, body) {
  if (!body || !('worker' in body)) return { error: 'worker required: {id, state} (or null / state "absent" to clear)', code: 400 };
  const w = body.worker;
  if (w === null || (w && typeof w === 'object' && w.state === 'absent')) {
    card.status = { worker: null };
  } else {
    if (!w || typeof w !== 'object') return { error: 'worker must be {id, state} or null', code: 400 };
    if (!WORKER_STATES.includes(w.state)) return { error: 'bad worker.state (use ' + WORKER_STATES.join('|') + ')', code: 400 };
    const id = String(w.id || '').trim();
    if (!id) return { error: 'worker.id required for state ' + w.state, code: 400 };
    let ttl = WORKER_TTL_SECS;
    if (body.ttl !== undefined) {
      ttl = Number(body.ttl);
      if (!Number.isFinite(ttl) || ttl <= 0) return { error: 'bad ttl (seconds > 0)', code: 400 };
    }
    card.status = { worker: { id: id.slice(0, 120), state: w.state, expires: new Date(Date.now() + ttl * 1000).toISOString() } };
  }
  card.updated = now();
  return { ok: true };
}

// ---------- SSE clients ----------
// Every stream the board serves (board, pane peek, sysload) opens the same way
// and speaks the same named-event frame, so a proxy or client quirk is fixed once.
const SSE_HEADERS = { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' };
/** sseFrame(event, data) -> one named SSE frame; `data` defaults to {}. */
function sseFrame(event, data) {
  return 'event: ' + event + '\ndata: ' + JSON.stringify(data === undefined ? {} : data) + '\n\n';
}
const sseClients = new Set();
function sseSend(event, data) {
  const payload = sseFrame(event, data);
  for (const res of sseClients) res.write(payload);
}
// Coalesced by the store: N calls in one tick push the board once.
function broadcast() { store.broadcast(); }

// ---------- permission approvals (see server/permissions.js) ----------
// Claude Code gives the hook 3600s; answering null a little earlier lets the
// agent fall back to its own dialog instead of dying on a hook timeout.
const PERMISSION_CAP_MS = Number(process.env.BC_PERMISSION_TIMEOUT_MS) > 0
  ? Number(process.env.BC_PERMISSION_TIMEOUT_MS) : 3500 * 1000;
const permissions = createPermissions({ capMs: PERMISSION_CAP_MS, onChange: permissionChanged });
function permissionWorker(item) {
  return item.card ? board.workers.find((w) => w.card === item.card && workerName(w.ref) === item.worker) || null : null;
}
// An ask and its end are both activity: the stall ladder starts over from
// here, not from whenever the worker last spoke before it waited.
function permissionChanged(item, outcome) {
  const w = permissionWorker(item);
  if (w) workers.transition(w, 'permission', { lastPermissionAt: now() });
  if (outcome === 'allow' || outcome === 'deny') return; // the decide route saves and broadcasts with its event
  if (w) store.commit();
  else broadcast();
}
function permissionFields(body, lt, w) {
  const tool = String(body.tool_name || 'unknown').slice(0, 200);
  const input = body.tool_input && typeof body.tool_input === 'object' && !Array.isArray(body.tool_input)
    ? body.tool_input : {};
  // The asking agent's harness knows which field of its tool input carries the
  // risk; one that does not say (a test double, an unattributed ask) gets the
  // default harness's reading.
  const askRef = (w && w.ref) || (lt && lt.ref) || null;
  const describeOf = (name) => {
    try { const p = port.profileOf(name); return p && p.permissions && p.permissions.describe; } catch (e) { return null; }
  };
  const describe = (askRef && describeOf(askRef.harness)) || describeOf(readConfig().harness || port.defaultHarness());
  const out = { ts: now(), tool_name: tool, tool_input: input, summary: summarize(tool, input, describe),
    lieutenant: null, card: null, worker: null, agentLabel: '' };
  if (w) {
    const card = findCard(w.card);
    Object.assign(out, { lieutenant: card ? card.owner : null, card: w.card, worker: workerName(w.ref),
      agentLabel: 'worker on ' + (card ? card.title : w.card) });
  } else if (lt) {
    Object.assign(out, { lieutenant: lt.id, agentLabel: lt.name });
  } else {
    out.agentLabel = body.cwd ? path.basename(String(body.cwd)) || String(body.cwd) : 'unknown agent';
  }
  return out;
}

// A file an editor may have open changed on disk (through PUT /api/artifact —
// the one door). Tiny event on the SAME stream, not a channel of its own: which
// uri, which version now, and `by` = the writer's own client tag (a random
// per-page string the browser sends, absent for a CLI write) so the tab that
// just saved recognizes its echo instead of flashing at itself. The screen
// fetches the content itself if it cares.
function broadcastArtifact(uri, version, by) { sseSend('artifact', { uri, version, by: by || '' }); }

// ---------- pane hub (👁 peek: live pane frames over a per-target SSE) ----------
// The harness port's OPTIONAL openPane capability, ref-counted per pane key:
// the FIRST subscriber for a key opens ONE harness pane feed, every frame fans
// out to that key's SSE clients, and the LAST disconnect closes the feed. A
// dedicated per-target stream, never /api/events — per-card frames must not
// spam every board client. The server owns ref resolution (card → its worker's
// ref, lieutenant → its ref); the harness owns how a pane is actually watched.
// Guards are clean SSE events then close (never a 500, never a hang):
//   unsupported — the ref's harness exposes no openPane
//   no-pane     — nothing to watch (unknown target, card not Working, no worker,
//                 no live session, or the open itself failed)
//   busy        — the concurrent-pane cap (bounds child-process load) is hit
const PANE_MAX = parseInt(process.env.BC_PANE_MAX, 10) > 0 ? parseInt(process.env.BC_PANE_MAX, 10) : 8;
// resolvePaneRef(kind, id) -> { ref, reason } — which harness ref does a pane
// target address? Shared by BOTH pane routes (the read stream and the write
// input) so they can never disagree about what `/api/cards/x/pane/*` means.
// ref null + a human reason is the "nothing to watch / nothing to type into"
// answer; each route renders it in its own dialect (SSE event vs 404).
// paneWindows(card) -> the windows a card offers, in order, first is default.
// `pane` is one name or a list of them; anything malformed is simply not
// offered. A worker that opens sibling windows (an orchestrator running its
// agents beside itself) is otherwise unwatchable — the board shows the window
// it bound at `card.start`, which sits silent while the work happens one window
// over.
//
// Only WINDOW names live here, never sessions: the pane always rides the
// worker's own session, so this can never address a session the card does not
// already own. The charset excludes `:` deliberately — the value becomes a
// `session:window` tmux target and a colon would retarget another session.
const PANE_WINDOW = /^[A-Za-z0-9_.-]{1,80}$/;
function paneWindows(card) {
  const v = card && card.attributes && card.attributes.pane;
  const list = Array.isArray(v) ? v : (typeof v === 'string' ? v.split(',') : []);
  const out = [];
  for (const w of list) {
    const name = String(w).trim();
    if (PANE_WINDOW.test(name) && !out.includes(name)) out.push(name);
  }
  return out;
}
function resolvePaneRef(kind, id, want) {
  if (kind === 'cards') {
    const card = findCard(id);
    const w = card && findWorker(card.id);
    if (!card) return { ref: null, reason: 'unknown card: ' + id };
    if (card.column !== 'working') return { ref: null, reason: 'card is not Working' };
    if (!w) return { ref: null, reason: 'no worker bound to ' + id };
    // `want` is the caller asking for one of the offered windows by name —
    // honoured only if the CARD listed it, so a request can never name a window
    // of its own. Unlisted or absent falls back to the card's first offer, then
    // to the worker's own window.
    const offered = paneWindows(card);
    const win = want && offered.includes(want) ? want : offered[0];
    if (win) return { ref: Object.assign({}, w.ref, { window: win }), reason: '' };
    return { ref: w.ref, reason: '' };
  }
  const lt = findLieutenant(id);
  if (!lt) return { ref: null, reason: 'unknown lieutenant: ' + id };
  if (!isHarnessRef(lt.ref)) return { ref: null, reason: 'lieutenant has no live session' };
  return { ref: lt.ref, reason: '' };
}
const panes = new Map(); // paneKey -> { clients: Set<res>, handle, last }
function paneKey(ref) { return ref.harness + '/' + keyOf(ref); }
function paneWrite(res, event, data) { res.write(sseFrame(event, data)); }
function paneStream(req, res, ref, reason) {
  res.writeHead(200, SSE_HEADERS);
  if (!ref) { paneWrite(res, 'no-pane', { reason }); return res.end(); }
  let impl;
  try { impl = harnessFor(ref); }
  catch (e) { paneWrite(res, 'no-pane', { reason: String((e && e.message) || e) }); return res.end(); }
  if (typeof impl.openPane !== 'function') {
    paneWrite(res, 'unsupported', { harness: ref.harness });
    return res.end();
  }
  const key = paneKey(ref);
  let hub = panes.get(key);
  if (!hub) {
    if (panes.size >= PANE_MAX) { paneWrite(res, 'busy', { max: PANE_MAX }); return res.end(); }
    hub = { clients: new Set(), handle: null, last: null };
    panes.set(key, hub);
    // openPane may be async (the port's verbs all may be); frames can only
    // start after it resolves, so subscribers added meanwhile just wait. If
    // everyone left before it resolved, close the freshly opened feed.
    Promise.resolve()
      .then(() => impl.openPane(ref, {
        onFrame: (frame) => {
          hub.last = String(frame);
          for (const c of hub.clients) paneWrite(c, 'frame', hub.last);
        },
      }))
      .then((handle) => {
        if (panes.get(key) === hub) { hub.handle = handle; return; }
        try { handle && typeof handle.close === 'function' && handle.close(); } catch (e) { /* already gone */ }
      })
      .catch((e) => {
        if (panes.get(key) !== hub) return;
        panes.delete(key);
        for (const c of hub.clients) {
          paneWrite(c, 'no-pane', { reason: 'open failed: ' + String((e && e.message) || e) });
          c.end();
        }
      });
  }
  hub.clients.add(res);
  // Immediate paint: late joiners get the hub's last frame; the first
  // subscriber gets a one-shot snapshot when the harness offers one and the
  // live feed hasn't delivered yet (a real frame arriving first wins).
  if (hub.last != null) paneWrite(res, 'frame', hub.last);
  else if (typeof impl.paneSnapshot === 'function') {
    Promise.resolve()
      .then(() => impl.paneSnapshot(ref))
      .then((snap) => {
        if (hub.last == null && hub.clients.has(res) && typeof snap === 'string') paneWrite(res, 'frame', snap);
      })
      .catch(() => { /* the interval frame will paint instead */ });
  }
  req.on('close', () => {
    hub.clients.delete(res);
    if (hub.clients.size) return;
    panes.delete(key); // last subscriber gone: release the harness feed
    try { hub.handle && typeof hub.handle.close === 'function' && hub.handle.close(); }
    catch (e) { /* closing a dead pane is a no-op */ }
  });
}

// ---------- sysload (⚙️ → monitoring: on-demand machine/agent load) ----------
// Zero cost when closed: the sampler loop (server/sysload.js) exists only
// while /api/sysload/stream has subscribers — first EventSource starts it,
// last disconnect stops it. Never rides the board push: samples are per-viewer
// telemetry, not board state. targets() re-reads the live registries every
// sample, so rows appear/disappear with workers and lieutenants.
const SYSLOAD_MS = parseInt(process.env.BC_SYSLOAD_MS, 10) > 0
  ? parseInt(process.env.BC_SYSLOAD_MS, 10) : 2000;
function sysloadTargets() {
  const out = [];
  for (const w of board.workers) {
    if (w.done || !isHarnessRef(w.ref)) continue;
    const card = findCard(w.card);
    out.push({ kind: 'worker', id: w.card, label: (card && card.title) || w.card,
      session: w.ref.session, window: w.ref.window || null, ref: w.ref });
  }
  for (const lt of board.lieutenants) {
    if (!isHarnessRef(lt.ref)) continue;
    out.push({ kind: 'lieutenant', id: lt.id, label: lt.name,
      session: lt.ref.session, window: lt.ref.window || null, ref: lt.ref });
  }
  return out;
}
// Pane pids come through the port (its optional panePids verb): a harness
// without it contributes no rows, and an unknown one throws into the sampler,
// which reads that as no rows too.
function sysloadPanePids(target) {
  const impl = harnessFor(target.ref);
  return typeof impl.panePids === 'function' ? impl.panePids(target.ref) : [];
}
const sysload = createSampler({ workspace: WORKSPACE, targets: sysloadTargets, panePids: sysloadPanePids,
  intervalMs: SYSLOAD_MS });

// Named ping (not an SSE comment): comments are invisible to EventSource, so
// the client's staleness watchdog couldn't see the stream is alive. Pane
// streams piggyback on the same ping so proxies don't drop them either.
setInterval(() => {
  const ping = sseFrame('ping');
  for (const res of sseClients) res.write(ping);
  for (const hub of panes.values()) for (const res of hub.clients) res.write(ping);
}, 25000).unref();

// ---------- helpers ----------
// Byte serve shared by the raw artifact and attachment routes. Honors a single
// `Range: bytes=` header (206 + Content-Range) because iOS Safari refuses to
// play <video> from a server that answers Range requests with a plain 200;
// anything unparseable falls back to the full 200, unsatisfiable → 416.
function sendBytes(req, res, data, headers) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  const base = { ...headers, 'Accept-Ranges': 'bytes' };
  if (m && (m[1] || m[2])) {
    const start = m[1] ? parseInt(m[1], 10) : data.length - parseInt(m[2], 10);
    const end = m[1] && m[2] ? Math.min(parseInt(m[2], 10), data.length - 1) : data.length - 1;
    if (start < 0 || start > end || start >= data.length) {
      res.writeHead(416, { 'Content-Range': 'bytes */' + data.length });
      return res.end();
    }
    const chunk = data.subarray(start, end + 1);
    res.writeHead(206, { ...base, 'Content-Length': chunk.length, 'Content-Range': 'bytes ' + start + '-' + end + '/' + data.length });
    return res.end(chunk);
  }
  res.writeHead(200, { ...base, 'Content-Length': data.length });
  res.end(data);
}
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
/**
 * respond(res, r, payload?) — the one mapping from a domain result to HTTP:
 * `{error, code}` answers `code` (400 when a caller forgot one) with the error;
 * anything else is a 200 carrying payload(r), or r itself.
 */
function respond(res, r, payload) {
  if (r && r.error) return sendJson(res, r.code || 400, { error: r.error });
  return sendJson(res, 200, payload ? payload(r) : r);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 8e6) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
// Larger-capped body reader for the base64 upload transport: the 10 MB decoded
// cap becomes ~13.4 MB of base64 + JSON overhead, well past readBody's 8 MB
// guard. Rejects with .code 413 past the cap so the caller can answer correctly.
function readBodyUpto(req, max) {
  return new Promise((resolve, reject) => {
    let len = 0; const chunks = [];
    req.on('data', (c) => {
      len += c.length;
      if (len > max) { const e = new Error('body too large'); e.code = 413; reject(e); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ---------- chat attachments (uploads) ----------
// Filename sanitization: keep a readable tail but strip anything that could
// escape the uploads dir or confuse a shell/browser — path separators, control
// chars, leading dots. The <id> prefix guarantees uniqueness, so a collapsed or
// empty name is harmless (falls back to "file").
function safeUploadName(name) {
  const base = String(name || '').split(/[\\/]/).pop() || '';
  const cleaned = base.replace(/[\x00-\x1f\x7f]/g, '').replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^\.+/, '').slice(0, 120);
  return cleaned || 'file';
}
function newAttachmentId() {
  for (;;) {
    const id = crypto.randomBytes(8).toString('hex');
    if (!fs.existsSync(path.join(UPLOADS_DIR, id + '.json'))) return id;
  }
}
function attachmentSidecar(id) { return path.join(UPLOADS_DIR, id + '.json'); }
// Read the stored metadata for an id, or null. The id must be a bare token —
// path traversal (slashes, dots) can never reach the filesystem.
function readAttachmentMeta(id) {
  if (!/^[a-f0-9]{8,}$/.test(String(id || ''))) return null;
  try {
    const meta = JSON.parse(fs.readFileSync(attachmentSidecar(id), 'utf8'));
    if (!meta || typeof meta !== 'object' || meta.id !== id || typeof meta.stored !== 'string') return null;
    // The absolute on-disk path, resolved strictly within the uploads dir.
    const file = path.join(UPLOADS_DIR, meta.stored);
    if (path.dirname(path.resolve(file)) !== path.resolve(UPLOADS_DIR)) return null;
    meta.path = file;
    return meta;
  } catch (e) { return null; }
}
// Persist an uploaded file + sidecar; returns the public meta. `data` is the
// decoded Buffer (size already enforced by the caller).
function storeAttachment(name, mime, data) {
  const id = newAttachmentId();
  const safe = safeUploadName(name);
  const stored = id + '__' + safe;
  fs.writeFileSync(path.join(UPLOADS_DIR, stored), data);
  const meta = {
    id, name: safe, mime: String(mime || 'application/octet-stream').slice(0, 200),
    size: data.length, stored, created: now(),
  };
  fs.writeFileSync(attachmentSidecar(id), JSON.stringify(meta));
  return meta;
}
// Resolve a client-supplied attachment list to AUTHORITATIVE metas by id: the
// client only names ids, the server reads name/mime/size/path from its own
// sidecar so a message can never inject an arbitrary path or spoofed metadata.
// Unknown ids are dropped. The stored form carries the absolute `path` so the
// agent (drain/thread) and the UI (id → /api/attachments/:id) both resolve it.
function resolveAttachments(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const a of list.slice(0, 20)) {
    const id = a && (typeof a === 'string' ? a : a.id);
    const meta = readAttachmentMeta(id);
    if (meta) out.push({ id: meta.id, name: meta.name, mime: meta.mime, size: meta.size, path: meta.path });
  }
  return out;
}
function findCard(id) { return board.cards.find((c) => c.id === id); }
// Chat targets: lieutenant:<id> (main chat) | card:<id> (card thread) — parsed,
// read, appended to and routed by server/conversation.js.
function threadFor(target) { return conversation.threadFor(target); }
function appendMessage(target, msg) { return conversation.appendMessage(target, msg); }
function targetLieutenant(target) { return conversation.targetLieutenant(target); }
// ---------- slash commands (the harness port's OPTIONAL commands/runCommand/status) ----------
// The session a chat target's slash commands (and /api/commands) address: a
// lieutenant target is the lieutenant's OWN session; a card target is the
// card's WORKER session (the card thread's slash surface talks to the worker,
// unlike say — whose interlocutor is the owning lieutenant).
// → { ref } | { ref: null, why } (valid target, no live session to address)
//   | { error, code } (bad/unknown target)
function commandTargetRef(target) {
  const t = parseTarget(target);
  if (t && t.kind === 'lieutenant') {
    const lt = findLieutenant(t.id);
    if (!lt) return { error: 'unknown target: ' + target, code: 404 };
    if (!isHarnessRef(lt.ref)) return { ref: null, why: 'lieutenant ' + lt.id + ' has no live session' };
    return { ref: lt.ref };
  }
  if (t && t.kind === 'card') {
    const card = findCard(t.id);
    if (!card) return { error: 'unknown target: ' + target, code: 404 };
    const w = findWorker(card.id);
    if (!w || !isHarnessRef(w.ref)) {
      return { ref: null, why: 'no worker on card ' + card.id + ' — slash commands address the worker session (card start ' + card.id + ' first)' };
    }
    return { ref: w.ref };
  }
  return { error: 'bad target (use lieutenant:<id> or card:<id>)', code: 400 };
}
function harnessCommands(ref) {
  let impl;
  try { impl = getHarness(ref.harness); } catch { return []; }
  return typeof impl.commands === 'function' ? impl.commands(ref) : [];
}

// Commands the BOARD answers, not the harness — because the harness does not
// know what a lieutenant is. /reset needs the charter and the board digest,
// which live here.
//
// Lieutenants only. A worker's session belongs to its card and to whatever
// started it; resetting one would hand it a lieutenant's doctrine and no idea
// what it was building.
const BOARD_COMMANDS = [
  { name: '/reset', description: 'start this lieutenant over: same identity, no memory of the conversation' },
];
function boardCommands(target) {  // MUTATION-TEST ME
  const t = parseTarget(target);
  return t && t.kind === 'lieutenant' ? BOARD_COMMANDS : [];
}

// /reset — kill the session and bring it back on the launch prompt: doctrine,
// its charter, and the digest of what it owns. Deliberately the SAME path
// supervision takes for a lieutenant whose memory could not be recovered, so
// there is one way a lieutenant comes back from nothing, not two.
//
// The conversation is gone and cannot be undone from here. It is not destroyed:
// the transcript stays on disk under ~/.claude/projects, so a human can still
// read it. The agent cannot.
async function resetLieutenant(id) {
  const lt = findLieutenant(id);
  if (!lt) return { error: 'unknown lieutenant: ' + id, code: 404 };
  if (!isHarnessRef(lt.ref)) return { error: 'lieutenant ' + id + ' has no session to reset', code: 409 };
  try { getHarness(lt.ref.harness); } catch (e) { return { error: String((e && e.message) || e), code: 400 }; }
  try {
    lt.ref = await respawnFresh(lt);
  } catch (e) {
    return { error: 'reset failed: ' + String((e && e.message) || e), code: 502 };
  }
  respawnAttempts.delete(id);
  delivery.resetNudge(id); // the new session owes a drain — the queue is truth, its memory was a cache
  // Saved by the caller: /reset only runs inside the chat route's store.mutate.
  store.boardEvent({
    text: 'lieutenant ' + lt.name + ' was reset by the captain — new session on the launch prompt',
    actor: 'user',
  }, { kind: 'reset', level: 1 });
  if (pendingItems(id).length) scheduleWake(id);
  return { ok: true, session: lt.ref.session };
}
// /reset kills a lieutenant's session and spawns it fresh on its launch prompt
// — a whole spawn, with a brief to deliver. Supervision has one rule about a
// lieutenant that is down: it died, so respawn it, which mid-reset means a
// second spawn racing this one for the same pane and a captain told his
// lieutenant crashed when he is the one who restarted it.
//
// pauseWorker sets w.paused before its own kill for exactly this reason ("the
// death must never look like a crash"); a lieutenant has no such field, so the
// mark lives here, wrapped around the call for the whole of it.
//
// Cleared in a `finally`, including when the reset throws: a marker left behind
// would silence supervision for that lieutenant permanently, which is a worse
// failure than the one this is preventing.
const cyclingLieutenants = new Set(); // ids being restarted by /reset right now
async function withCycleGuard(id, fn) {
  cyclingLieutenants.add(id);
  try {
    return await fn();
  } finally {
    cyclingLieutenants.delete(id);
  }
}

// lieutenant.patch { harness } — move a LIVING lieutenant to another harness.
// retire is refused while it owns cards, so before this there was no front door
// at all: the captain's only route from claude to codex was hand-editing
// board.json under a running server.
//
// It is a RELAUNCH, not a migration — no harness can hand another its
// conversation — so it is deliberately the same from-nothing path /reset and
// supervision take: the new session opens on doctrine + charter + owned cards +
// pending queue (+ the handoff notes on its plan cards), and the queue it never
// drained is still there, because the queue is the truth and the conversation
// was the cache.
//
// resumeId goes with the old harness: an id minted by claude means nothing to
// codex, and a ref carrying one would have supervision try to resume a thread
// that does not exist.
//
// Wrapped in withCycleGuard for the same reason /reset is: between the kill and
// the spawn the lieutenant is legitimately down, and supervision's one rule for
// a lieutenant that is down is to respawn it — racing this spawn for the pane
// and telling the captain his lieutenant crashed while he is the one moving it.
async function switchLieutenantHarness(lt, harness, actor) {
  try { getHarness(harness); } catch (e) { return { error: String((e && e.message) || e), code: 400 }; }
  if (!isHarnessRef(lt.ref)) {
    return { error: 'lieutenant ' + lt.id + ' has no session — a harness is a property of the '
      + 'session it runs in, so there is nothing here to move (spawn one first)', code: 409 };
  }
  if (lt.ref.harness === harness) return { ok: true, switched: false, lieutenant: lt };
  let ref;
  try {
    ref = await withCycleGuard(lt.id, () => respawnFresh(lt, harness));
  } catch (e) {
    return { error: 'harness switch failed: ' + String((e && e.message) || e), code: 502 };
  }
  // The ref is rewritten WHOLE — window kept, resumeId gone — rather than
  // patched: half of an old address is not an address.
  lt.ref = { harness: ref.harness, session: ref.session, cwd: ref.cwd, window: ref.window || names.LIEUTENANT_WINDOW };
  respawnAttempts.delete(lt.id);
  delivery.resetNudge(lt.id); // the new session owes a drain; its predecessor's memory went with it
  const ev = store.boardEvent({
    text: 'lieutenant ' + lt.name + ' moved to ' + harness
      + (validModel(lt.model) ? ':' + validModel(lt.model) : '')
      + ' — respawned as ' + lt.ref.session,
    actor: actor || 'user',
  }, { kind: 'harness-switch', level: 1 });
  if (pendingItems(lt.id).length) scheduleWake(lt.id);
  return { ok: true, switched: true, lieutenant: lt, event: ev };
}

// A captain chat message starting with "/" routes HERE instead of becoming a
// say: the command runs against the target session's harness and both the
// command and its reply land in the thread — nothing rides the delivery queue
// (no wake, no owed). Unknown commands and missing sessions answer in-thread
// too (a composer conversation, not an HTTP failure).
async function runChatCommand(target, text) {
  // command messages carry `cmd` metadata the UI keys off for its console-style
  // rendering: the request (cmd.name only) and its reply (cmd.reply true). The
  // /status reply additionally carries the structured `status` payload so the UI
  // renders a real progress bar instead of regex-parsing the formatted prose.
  const stamp = (author, t, cmd, extra) => {
    appendMessage(target, Object.assign({ author, text: t, ts: now(), cmd }, extra || {}));
  };
  const name = text.split(/\s+/)[0];
  const reply = (author, t, extra) => stamp(author, t, { name, reply: true }, extra);
  stamp('user', text, { name });
  const r = commandTargetRef(target);
  if (r.error) return r; // unknown target — the normal 404, same as a say
  // Board commands are answered here, and BEFORE the live-session check: the
  // harness has no idea what a lieutenant is, and /reset is at its most useful
  // on one whose session has died — bringing it back is the whole point.
  if (boardCommands(target).some((c) => c.name === name)) {
    const id = parseTarget(target).id;
    const out = await withCycleGuard(id, () => resetLieutenant(id));
    if (out.error) reply('bridge', '⚠ ' + name + ' — ' + out.error);
    else reply('bridge', 'reset — ' + id + ' is a new session on the launch prompt (doctrine, charter, and what it owns). The conversation before this one is gone.');
    return { ok: true, command: name };
  }
  if (!r.ref) {
    reply('bridge', '⚠ ' + name + ' — ' + r.why);
    return { ok: true, command: name };
  }
  const cmds = harnessCommands(r.ref).concat(boardCommands(target));
  if (!cmds.length) {
    reply('bridge', '⚠ ' + name + ' — the ' + r.ref.harness + ' harness has no slash commands');
    return { ok: true, command: name };
  }
  if (!cmds.some((c) => c && c.name === name)) {
    reply('bridge', '⚠ unknown command ' + name + ' — available: ' + cmds.map((c) => c.name).join(', '));
    return { ok: true, command: name };
  }
  try {
    // the FULL line goes to the harness — pass-through commands (/compact,
    // claude's /autocompact) may carry arguments; `name` only did the match
    const impl = getHarness(r.ref.harness);
    const result = await impl.runCommand(r.ref, text);
    // /status also fetches the structured status (a cheap transcript read) so the
    // reply carries both the formatted text (fallback) and the payload the UI
    // renders as model + context bar + rate lines — never parsing the prose.
    let extra;
    if (name === '/status' && typeof impl.status === 'function') {
      try { const st = await impl.status(r.ref); if (st && typeof st === 'object') extra = { status: st }; } catch {}
    }
    reply(r.ref.harness, String(result == null ? name + ' done' : result), extra);
  } catch (e) {
    reply('bridge', '⚠ ' + name + ' failed: ' + String((e && e.message) || e));
  }
  return { ok: true, command: name };
}
// agentStatus — the port's OPTIONAL status() surfaced on the board payload
// (model, context used/window, rate limits) for lieutenants and workers.
// Refreshed at turn-end (the turn boundary the server already tracks — no
// polling loops). Best-effort: no capability, no session, unreadable files →
// the recorded status simply stays as it was. Returns true when it changed.
async function refreshAgentStatus(rec) {
  if (!rec || !isHarnessRef(rec.ref)) return false;
  let impl;
  try { impl = getHarness(rec.ref.harness); } catch { return false; }
  if (typeof impl.status !== 'function') return false;
  try {
    const st = await impl.status(rec.ref);
    if (!st || typeof st !== 'object') return false;
    rec.agentStatus = Object.assign({}, st, { ts: now() });
    return true;
  } catch {
    return false;
  }
}
// AGENT_STATUS_STALE_MS — how old a reading may be before the board stops
// presenting it as current. Status refreshes at turn-end and nowhere else, so
// a reading older than this means either the session has been quiet that long
// or its status read is failing (a rollout/transcript the harness can no
// longer resolve) — either way the numbers are a memory, not a measurement.
// Ten minutes: longer than any one turn, short enough that a frozen bar is
// marked within a single idle stretch.
const AGENT_STATUS_STALE_MS = 10 * 60 * 1000;
// Derived at serialization, never stored: the same untouched record reads
// fresh and later stale with no writer involved. The flag is all the server
// says — how (or whether) to show an old reading is the UI's call.
function withStatusAge(rec) {
  const st = rec && rec.agentStatus;
  const at = st && st.ts ? Date.parse(st.ts) : NaN;
  if (!Number.isFinite(at) || Date.now() - at <= AGENT_STATUS_STALE_MS) return rec;
  return Object.assign({}, rec, { agentStatus: Object.assign({}, st, { stale: true }) });
}
function columnTitle(id) {
  const c = board.columns.find((k) => k.id === id);
  return c ? c.title : id;
}
// Lieutenant id from a display name (layout.slugBase). A name with no ASCII at
// all (pure emoji) falls back to 'lt', made unique so a second such lieutenant
// can still be born; a real slug collision stays a 409 in createLieutenant
// (same-name duplicates are a caller mistake, not a naming gap).
function lieutenantIdFrom(name) {
  const base = names.slugBase(name);
  if (base) return base;
  if (!findLieutenant('lt')) return 'lt';
  for (let i = 2; ; i++) if (!findLieutenant('lt-' + i)) return 'lt-' + i;
}
function userReads(user) {
  const u = String(user || 'user').slice(0, 60);
  if (!board.reads[u]) board.reads[u] = { notifSeq: 0, notifSeqs: [], threads: {} };
  const r = board.reads[u];
  if (!Array.isArray(r.notifSeqs)) r.notifSeqs = [];
  if (!r.threads || typeof r.threads !== 'object') r.threads = {};
  return r;
}
// The unified stream: board-level events + every card's events, by seq.
function allEvents() {
  const out = [];
  for (const e of board.events) out.push(e);
  for (const c of board.cards) for (const e of c.events) out.push(Object.assign({ card: c.id, cardTitle: c.title }, e));
  out.sort((a, b) => a.seq - b.seq);
  return out;
}

// The bell: everything the captain hasn't seen yet. Level-1 events (read state:
// notifSeq/notifSeqs) UNION lieutenant-authored card-thread replies (read state:
// the same per-user thread read marker that derives a card's `unread`, so opening
// the card clears them). Lieutenant main-chat messages already ride their level-1
// event, so those threads are excluded here — no double count. Level-2 events
// never notify. Reply items are shaped like event items minus the seq
// (ts/text/actor/card/cardTitle/read) plus kind "reply" to tell them apart.
function notificationItems(user) {
  const r = userReads(user);
  const items = allEvents().filter((e) => e.level === 1)
    .map((e) => Object.assign({}, e, { read: e.seq <= r.notifSeq || r.notifSeqs.includes(e.seq) }));
  for (const c of board.cards) {
    const readMs = lastThreadReadMs('card:' + c.id, user);
    for (const m of c.thread || []) {
      if (m.author === 'user') continue;
      items.push({ ts: m.ts, level: 1, kind: 'reply', text: m.text, actor: m.author,
        card: c.id, cardTitle: c.title, read: Date.parse(m.ts) <= readMs });
    }
  }
  return items.sort((a, b) => (Date.parse(b.ts) - Date.parse(a.ts)) || ((b.seq || 0) - (a.seq || 0)));
}

// ---------- card mutations ----------
// A card's `playbook` is the id of a markdown file under playbooks/ — a
// pointer, never text. Validated where it is SET so a typo is caught at the
// keyboard rather than at card.start; '' clears it (and a card with none never
// starts).
function playbooksHint() {
  const ids = listPlaybooks(STATE_DIR);
  return ids.length ? ids.join(', ') : '(none — seed them with bc-axi init)';
}
function checkPlaybook(raw) {
  const id = String(raw || '').trim();
  if (!id) return { playbook: '' };
  if (!resolvePlaybook(STATE_DIR, id)) {
    return { error: 'unknown playbook: ' + id + ' — playbooks in ' + path.join(STATE_DIR, 'playbooks')
      + ': ' + playbooksHint(), code: 400 };
  }
  return { playbook: id };
}
function createCard(body, actorDefault) {
  const title = String(body.title || '').trim();
  if (!title) return { error: 'title required', code: 400 };
  const owner = String(body.owner || '').trim();
  if (!owner) return { error: 'owner required (every card belongs to exactly one lieutenant)', code: 400 };
  const lt = findLieutenant(owner);
  if (!lt) return { error: 'unknown lieutenant: ' + owner, code: 400 };
  const type = body.type ? String(body.type) : 'implementation';
  if (!CARD_TYPES.includes(type)) return { error: 'bad type (use ' + CARD_TYPES.join('|') + ')', code: 400 };
  const pb = checkPlaybook(body.playbook);
  if (pb.error) return pb;
  // No id given: the owner mints the next one from its own counter. The counter
  // advances only when the card is actually born (below).
  const minted = body.id ? 0 : (Number.isInteger(lt.cardSeq) ? lt.cardSeq : 0) + 1;
  const id = body.id ? String(body.id) : lt.prefix + '-' + minted;
  if (!/^[\w][\w.:-]*$/.test(id)) return { error: 'bad card id (use [A-Za-z0-9_.:-])', code: 400 };
  // A duplicate is an error, not a case to engineer around: no suffix, no retry,
  // no silently picking the next free number. It can happen when a prefix outlives
  // the lieutenant that used it (retire, recreate, counter back at 1) — rare, and
  // the captain settles it with the lieutenant. What must never happen is a
  // collision created SILENTLY. The fix named is the prefix: every caller has it
  // (the CLI takes no --id), and it is the one that unwedges the mint for good.
  if (findCard(id)) {
    return { error: minted
      ? 'card exists: ' + id + ' — ' + lt.name + ' would mint that id next (counter at ' + (minted - 1)
        + '). Give ' + lt.name + ' an unused prefix in its settings.'
      : 'card exists: ' + id, code: 409 };
  }
  const column = body.column ? String(body.column) : 'backlog';
  if (!board.columns.some((c) => c.id === column)) return { error: 'unknown column: ' + column, code: 400 };
  // Working is a fact, not a label: a card is in Working iff a live worker
  // exists for it, and only card.start creates one. Cards are never BORN there.
  if (column === 'working') return { error: 'cards cannot be created in Working — a card enters Working only through card.start (which spawns its worker)', code: 400 };
  // Nor anywhere else: cards are born in Backlog ONLY (review is the handoff,
  // peer is the captain's shelf — both are earned, never a birthplace).
  if (column !== 'backlog') return { error: 'cards are born in Backlog only — create it there and move it after', code: 400 };
  const actor = String(body.actor || actorDefault || 'agent').slice(0, 60);
  const card = {
    id, title: title.slice(0, 200), type, owner, column, playbook: pb.playbook,
    labels: Array.isArray(body.labels) ? body.labels.filter((l) => typeof l === 'string' && l) : [],
    attributes: (body.attributes && typeof body.attributes === 'object') ? body.attributes : {},
    body: typeof body.body === 'string' ? body.body : '',
    created: now(), updated: now(), threadStart: null, pendingOrder: null,
    events: [], thread: [],
  };
  // Write-ahead first: a queue append that throws must leave no card behind.
  if (actor === 'user') queuePush(owner, { kind: 'card-created', card: id, text: card.title, column });
  store.cardEvent(card, { text: 'created in ' + columnTitle(column), actor }, { kind: 'created' });
  if (minted) lt.cardSeq = minted; // never reissued, never rolled back
  board.cards.push(card);
  registerCardLabels();
  return { card };
}

// card.move — who moves matters (the DNA's side-effects table):
//   captain (actor "user"):
//     any column → working = start-order: the card does NOT move; a QueueItem
//                          goes to the owner and the card carries pendingOrder
//                          (invariant 3: only card.start enters Working — a
//                          plain write would create a workerless Working card)
//     review → backlog   = rework-order: same, optionally carrying the captain's
//                          comment (body.text)
//     anything else      = applies normally (parking in peer, reordering, …)
//   lieutenant (any other actor): only → review (the handoff, a level-1 event);
//   → working is a 409 pointing at card.start.
// Any APPLIED move clears pendingOrder — the ordered move happening (or the
// captain rearranging) resolves the order marker.
function moveCard(card, body, actorDefault) {
  const column = String(body.column || '');
  if (!board.columns.some((c) => c.id === column)) return { error: 'unknown column: ' + column, code: 400 };
  const actor = String(body.actor || actorDefault || 'agent').slice(0, 60);
  if (column === card.column) return { ok: true, unchanged: true };
  const from = card.column;

  if (actor === 'user') {
    const order = column === 'working' ? 'start-order'
      : from === 'review' && column === 'backlog' ? 'rework-order' : null;
    if (order) {
      const item = queuePush(card.owner, Object.assign(
        { kind: order, card: card.id, from, to: column },
        String(body.text || '').trim() ? { text: String(body.text).slice(0, 2000) } : {}));
      card.pendingOrder = { kind: order, seq: item.seq, ts: item.ts };
      const ev = store.cardEvent(card, { actor, kind: 'ordered',
        text: (order === 'start-order' ? 'start ordered' : 'rework ordered') + ' (' + columnTitle(from) + ' → ' + columnTitle(column) + ')' });
      return { ok: true, ordered: order, event: ev, seq: item.seq };
    }
  } else if (column === 'working') {
    return { error: 'only card.start moves a card into Working (it spawns the worker) — run: card start ' + card.id, code: 409 };
  } else if (column !== 'review') {
    return { error: 'lieutenants move cards only to review (the handoff)', code: 400 };
  }

  card.column = column;
  card.pendingOrder = null;
  if (from === 'working') workers.leave(card.id); // leaving Working ends the stop/stale-state
  // A move is a deliberate act: it always lands on the timeline. Default kind:
  // a lieutenant move is a handoff (level 1 from the kinds map — rings the
  // captain); a captain move is `moved` (level 2). `kind` in the body overrides;
  // levels come from the effective kinds map unless an explicit level is given.
  const ev = store.cardEvent(card,
    { level: body.level, kind: body.kind, actor, text: columnTitle(from) + ' → ' + columnTitle(column) },
    { kind: actor === 'user' ? 'moved' : 'handoff' });
  if (actor === 'user') queuePush(card.owner, { kind: 'card-moved', card: card.id, from, to: column });
  return { ok: true, event: ev };
}

function patchCard(card, body) {
  // Validate every field before applying any: a refused patch must leave nothing
  // in memory for the next unrelated save to persist.
  // Owner reassignment is allowed ONLY while no worker is bound to the card
  // (live or recorded): a worker's session/worktree belong to the owning
  // lieutenant's supervision, so mid-work handovers stay forbidden.
  const newOwner = body.owner !== undefined ? String(body.owner).replace(/^lieutenant:/, '') : card.owner;
  if (newOwner !== card.owner) {
    if (findWorker(card.id)) {
      return { error: 'owner change refused: card has a worker bound (session/worktree) — finish or archive first', code: 409 };
    }
    if (!board.lieutenants.some((l) => l.id === newOwner)) {
      return { error: 'unknown lieutenant: ' + newOwner, code: 400 };
    }
  }
  const pb = body.playbook !== undefined ? checkPlaybook(body.playbook) : null;
  if (pb && pb.error) return pb;

  if (newOwner !== card.owner) {
    const prev = card.owner;
    card.owner = newOwner;
    store.cardEvent(card, { actor: body.actor, text: 'owner: ' + prev + ' → ' + newOwner }, { kind: 'moved' });
  }
  if (pb) card.playbook = pb.playbook;
  if (body.title !== undefined) card.title = String(body.title).slice(0, 200);
  if (body.body !== undefined) card.body = String(body.body);
  if (body.type !== undefined && CARD_TYPES.includes(body.type)) card.type = body.type;
  if (Array.isArray(body.labels)) card.labels = body.labels.filter((l) => typeof l === 'string' && l);
  if (body.attributes && typeof body.attributes === 'object') {
    for (const [k, v] of Object.entries(body.attributes)) {
      if (v === null) delete card.attributes[k];
      else card.attributes[k] = v;
    }
  }
  card.updated = now();
  registerCardLabels();
  return { ok: true };
}

// ---------- promote to artifact (the DELIBERATE tool — chat upload ≠ artifact) ----------
// Add/remove a curated deliverable on card.attributes.artifacts [{uri, label}].
// This is the ONLY path (besides the investigation auto-attach) that puts an
// entry there — a chat upload alone never does. Idempotent by uri, mirroring the
// investigation auto-attach shape. A bare filesystem path is normalized to a
// file:// absolute uri; attachment:// and http(s):// uris pass through.
function literalArtifactUri(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (/^(attachment|https?|file):\/\//.test(s)) return s;
  return 'file://' + path.resolve(s);
}
// The stored uri is the file's REAL directory: the write gate refuses a path
// whose realpath differs, so `/tmp/x.md` on macOS (/tmp → /private/tmp) would
// read forever and never save. Only the directory is followed — a symlinked
// leaf stays as given, and the gate still refuses it. An unclean file:// path
// stays verbatim so the gate refuses the traversal instead of it being resolved away.
function normalizeArtifactUri(raw) {
  const uri = literalArtifactUri(raw);
  if (!uri.startsWith('file://')) return uri;
  const file = uri.slice('file://'.length);
  if (!path.isAbsolute(file) || path.resolve(file) !== file) return uri;
  return 'file://' + path.join(realDir(path.dirname(file)), path.basename(file));
}
function cardArtifactAdd(card, body) {
  const uri = normalizeArtifactUri(body && body.uri);
  if (!uri) return { error: 'uri required (attachment://id | file://path | path)', code: 400 };
  if (!Array.isArray(card.attributes.artifacts)) card.attributes.artifacts = [];
  const label = String((body && body.label) || '').slice(0, 200);
  const existing = card.attributes.artifacts.find((a) => a && a.uri === uri);
  if (existing) {
    if (label && existing.label !== label) { existing.label = label; card.updated = now(); }
    return { ok: true, artifact: existing, unchanged: !label || existing.label === label };
  }
  // Default label: an attachment's stored name (nicer than its opaque id), else
  // the uri's basename.
  let defLabel = uriBasenameServer(uri);
  const am = /^attachment:\/\/(.+)$/.exec(uri);
  if (am) { const meta = readAttachmentMeta(am[1]); if (meta) defLabel = meta.name; }
  const art = label ? { uri, label } : { uri, label: defLabel };
  card.attributes.artifacts.push(art);
  store.cardEvent(card, { text: 'artifact added: ' + (art.label || uri), actor: (body && body.actor) || 'agent', level: 2 });
  return { ok: true, artifact: art };
}
function cardArtifactRemove(card, body) {
  const uri = normalizeArtifactUri(body && body.uri);
  if (!uri) return { error: 'uri required', code: 400 };
  // The literal form too: an entry stored before uris were realpath'd must stay removable.
  const literal = literalArtifactUri(body && body.uri);
  const arts = Array.isArray(card.attributes.artifacts) ? card.attributes.artifacts : [];
  const next = arts.filter((a) => !(a && (a.uri === uri || a.uri === literal)));
  const removed = next.length !== arts.length;
  card.attributes.artifacts = next;
  if (removed) card.updated = now();
  return { ok: true, removed };
}
// Server-side twin of ui/js/util.js uriBasename — the artifact's display name.
function uriBasenameServer(uri) {
  const s = String(uri).replace(/[?#].*$/, '').replace(/\/+$/, '');
  const i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(i + 1) : s;
}

function readArchive() { return readJsonl(ARCHIVE_FILE); }

function archiveCard(card, body, actorDefault) {
  const actor = String((body && body.actor) || actorDefault || 'agent').slice(0, 60);
  // Archive reason is the validated enum `merged | killed` (merged = landed,
  // killed = dismissed — the default when none is given). Free text belongs in
  // the optional `note`, preserved on the archive record.
  const reason = (body && body.reason) || 'killed';
  if (reason !== 'merged' && reason !== 'killed') {
    return { error: "reason must be 'merged' or 'killed' (free text goes in note)", code: 400 };
  }
  // The worker's address goes onto the card BEFORE the snapshot freezes: the
  // record may be dropped later, detached, with no card left to stamp.
  stampWorkerAddress(card, findWorker(card.id));
  const note = body && body.note ? String(body.note).slice(0, 500) : null;
  const rec = { ts: now(), actor, reason, card };
  if (note) rec.note = note;
  fs.appendFileSync(ARCHIVE_FILE, JSON.stringify(rec) + '\n');
  board.cards = board.cards.filter((c) => c.id !== card.id);
  // An archived card has no worker (invariant: Working ⇔ live worker), and by
  // now it usually has none left either — the handoff killed it. Any lingering
  // one is ended by the CALLER, through killCardWorker: the kill is awaited and
  // verified there, and the registry entry is dropped only once the pane is
  // provably gone. It used to be a fire-and-forget kill plus an unconditional
  // drop right here, which is exactly how a session ends up alive with nothing
  // on the board pointing at it.
  // The kill lands on the board-level stream (the card is gone) with a card
  // reference. Typed by reason: merged = landed (level 1 — worth a bell),
  // killed = killed (level 2 — the captain's own act, no bell). Levels come from
  // the effective kinds map.
  const ev = store.boardEvent(
    { level: body && body.level, kind: body && body.kind, actor, text: reason + ': ' + (note || card.title) },
    { kind: reason === 'merged' ? 'landed' : 'killed' });
  ev.card = card.id; ev.cardTitle = card.title; ev.archived = true;
  return { ok: true, event: ev };
}

// card.restore — back from the archive with frozen state intact. The MOST RECENT
// archive record for the id wins (a card can be archived and restored repeatedly).
// The archive log stays append-only: the original record REMAINS, so an archive
// record can exist for a live card — the board is truth for liveness. The frozen
// snapshot is restored in full (body, events, thread, attributes, column); only
// the worker lease starts absent (nothing is working a resurrected card until
// status.set says so), and owed/unread re-derive from the restored thread/events
// against the per-user read state as on any card. The return is loud: a level-1
// event says the card was resurrected and by whom.
function restoreCard(id, body) {
  if (findCard(id)) return { error: 'card already on the board: ' + id, code: 409 };
  let rec = null;
  for (const r of readArchive()) if (r && r.card && r.card.id === id) rec = r; // last = most recent
  if (!rec) return { error: 'not in archive: ' + id, code: 404 };
  const card = JSON.parse(JSON.stringify(rec.card)); // the frozen snapshot, in full
  if (!Array.isArray(card.events)) card.events = [];
  if (!Array.isArray(card.thread)) card.thread = [];
  if (!Array.isArray(card.labels)) card.labels = [];
  if (!card.attributes || typeof card.attributes !== 'object') card.attributes = {};
  if (!CARD_TYPES.includes(card.type)) card.type = 'implementation';
  if (typeof card.playbook !== 'string') card.playbook = ''; // frozen before playbooks existed
  card.status = { worker: null }; // the lease starts absent until the next status.set
  card.pendingOrder = null;
  // Working ⇔ live worker: a frozen Working snapshot restores workerless, so
  // it lands in Backlog instead (card.start is the only way back into Working).
  const wasWorking = card.column === 'working';
  if (wasWorking) card.column = 'backlog';
  for (const e of card.events) if (e.seq > board.seq) board.seq = e.seq; // defensive: no seq reuse
  const ev = store.cardEvent(card, {
    level: body && body.level, kind: body && body.kind, actor: body && body.actor,
    text: (String((body && body.text) || '').trim() || 'resurrected')
      + (wasWorking ? ' — restored to backlog (was working)' : ''),
  }, { kind: 'resurrected' });
  board.cards.push(card);
  registerCardLabels();
  return { ok: true, card, event: ev };
}

// ---------- projects (F6: the registered-repo registry) ----------
// workspace.addProject: clone the repo into <workspace>/projects/<name> and
// record {name, path}. A card's `repo` attribute must name a registered
// project for card.start to provision its worker a worktree. How finished work
// leaves the worktree is the CARD's playbook, not a property of the repo.
function findProject(name) { return board.projects.find((p) => p.name === name); }
const addingProjects = new Set(); // names with a clone in flight (async clone opens racing duplicate adds)
async function addProject(body) {
  const source = String((body && body.source) || '').trim();
  if (!source) return { error: 'source required (git URL or local path)', code: 400 };
  const name = String((body && body.name) || path.basename(source.replace(/\/+$/, '')).replace(/\.git$/, '')).trim();
  if (!isId(name)) return { error: 'bad project name: ' + name + ' (use [A-Za-z0-9_.-], or pass --name)', code: 400 };
  if (findProject(name)) return { error: 'project exists: ' + name, code: 409 };
  if (addingProjects.has(name)) return { error: 'project add already in progress: ' + name, code: 409 };
  const dest = path.join(WORKSPACE, 'projects', name);
  if (fs.existsSync(dest)) return { error: 'destination already exists: ' + dest, code: 409 };
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const src = fs.existsSync(source) ? path.resolve(source) : source;
  addingProjects.add(name);
  try {
    await new Promise((resolve, reject) => {
      execFile('git', ['clone', src, dest], { encoding: 'utf8', timeout: 300000 },
        (err, stdout, stderr) => (err ? reject(Object.assign(err, { stderr })) : resolve()));
    });
  } catch (e) {
    return { error: 'clone failed: ' + String((e && e.stderr) || (e && e.message) || e).trim(), code: 502 };
  } finally {
    addingProjects.delete(name);
  }
  const project = { name, path: dest, source: src, added: now() };
  board.projects.push(project);
  store.boardEvent({ text: 'project ' + name + ' registered', actor: (body && body.actor) || 'agent', level: 2 });
  return { project };
}

// What a registered clone says about itself: where it pushes, and the branch a
// fresh worktree starts detached from. Both are read from the checkout, never
// from the registry — `source` records what the clone was made from once and
// then goes stale, while these two follow the repo.
//
// A missing `.git` short-circuits: without it there is nothing to read, and
// `git -C` would happily answer for whatever repo the path happens to sit
// inside. Nothing here throws — a read that fails is a null field, so a row the
// server cannot describe still renders with what it has.
function projectGit(dir) {
  const out = { remote: null, branch: null, missing: !dir || !fs.existsSync(dir) };
  if (out.missing || !fs.existsSync(path.join(dir, '.git'))) return out;
  const read = (args) => {
    try {
      return execFileSync('git', ['-C', dir].concat(args),
        { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
    } catch (e) { return null; }
  };
  out.remote = read(['remote', 'get-url', 'origin']);
  const head = read(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  out.branch = head ? head.replace(/^origin\//, '') : null;
  return out;
}

// ---------- workers (F5: card.start, worker.signal, worker done) ----------
// A worker lives as a tmux WINDOW inside its owning lieutenant's session
// (papercut #8): ref = { session: <lieutenant session>, window: 'w-<card-id>' }.
// The 'w-' prefix keeps tmux from ever parsing the window name as an index.
// Lifecycle coupling is accepted design — the lieutenant's session dying takes
// its worker windows with it (supervision then flags them as died). Refs are
// data, so workers recorded under the old one-session-per-worker scheme keep
// working via their session-only ref.
function ownerSession(card) {
  const lt = board.lieutenants.find((l) => l.id === card.owner);
  // Mirror the supervision respawn rule: a founder's foreign session name is
  // not spawnable — those workers get the workspace-scoped lieutenant name.
  return lt && isHarnessRef(lt.ref) && isSpawnableSession(lt.ref.session)
    ? lt.ref.session
    : names.lieutenantSession(WORKSPACE, card.owner);
}
// workerName(ref) — the attach-facing address of a worker's pane:
// `session:window` for window-granular refs, the bare session for legacy ones.
// refKey — the harness state key an agent's turn-end hook posts as `session`:
// the bare tmux session for a session-granular ref, `session:window` for a
// window-granular one. Lieutenants are window-granular too (their own `lt`
// window — names.LIEUTENANT_WINDOW), so this is NOT worker-only. Both are the
// port's keyOf: the harness owns the key's shape.
function refKey(ref) { return keyOf(ref); }
function workerName(ref) { return keyOf(ref); }
function findWorker(cardId) { return workers.find(cardId); }

// ---------- event dedupe keys (POST /api/cards/<id>/events `key`) ----------
//
// A hook that polls `gh` every five minutes sees the same red check sixty
// times. Without a key it wakes its lieutenant sixty times; with one, the
// second and later events carrying that key FOR THAT CARD are a no-op that
// answers 200 and says it was a duplicate — no timeline entry, no queue item.
// So every polling hook gets deduping free instead of keeping its own state
// file beside itself.
//
// Keys are scoped per card (the same key on a different card is a different
// thing that happened) and kept 7 days, pruned on every write. One small JSON
// file, not board state: it is a cache of what has already been said, and
// losing it costs one duplicate wake.
const EVENTKEYS_FILE = path.join(STATE_DIR, 'eventkeys.json');
const EVENTKEY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// The store is null-prototype all the way down, and that is load-bearing: a key
// is whatever string a hook chose, and `toString` or `constructor` on an
// ordinary object answers as if it had already been claimed — the very first
// event carrying one would be dropped as a duplicate, silently. `__proto__` is
// worse on the write side: assigning it sets a prototype instead of storing a
// key, so it never persists and never prunes.
function readEventKeys() {
  const out = Object.create(null);
  try {
    const doc = JSON.parse(fs.readFileSync(EVENTKEYS_FILE, 'utf8'));
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return out;
    for (const [c, keys] of Object.entries(doc)) {
      if (!keys || typeof keys !== 'object' || Array.isArray(keys)) continue;
      out[c] = Object.assign(Object.create(null), keys);
    }
  } catch (e) {}
  return out;
}

// The pair is deliberately two functions, and the ORDER they are called in is
// the guarantee: ask (read-only), deliver, then claim. Claiming first would
// make a delivery that throws — an unwritable queue file, a full disk — a wake
// that is forever answered "duplicate" and never actually arrived. At-least-once
// beats a silently swallowed escalation, so a failed delivery leaves the key
// unclaimed and the next poll says the same thing again.

// seenEventKey(cardId, key) -> true when that card already claimed this key
// inside the window. Reads only; it never touches the file.
function seenEventKey(cardId, key) {
  const doc = readEventKeys();
  const ts = doc[cardId] && doc[cardId][key];
  return typeof ts === 'number' && ts > Date.now() - EVENTKEY_TTL_MS;
}

// claimEventKey(cardId, key) — the key is now spoken for. Prunes everything
// past the window while it holds the file, which is the only thing that ever
// expires a key.
function claimEventKey(cardId, key) {
  const doc = readEventKeys();
  const cutoff = Date.now() - EVENTKEY_TTL_MS;
  for (const [c, keys] of Object.entries(doc)) {
    for (const [k, ts] of Object.entries(keys)) if (!(typeof ts === 'number' && ts > cutoff)) delete keys[k];
    if (!Object.keys(keys).length) delete doc[c];
  }
  (doc[cardId] = doc[cardId] || Object.create(null))[key] = Date.now();
  try { fs.writeFileSync(EVENTKEYS_FILE, JSON.stringify(doc)); }
  catch (e) { console.error(now() + ' event key store unwritable: ' + String((e && e.message) || e)); }
}

// forgetEventKeys(id) -> true when it dropped one that was still live. The
// counterpart the pair needed once something could RECOVER: a failure that has
// been fixed must stop answering "duplicate", or the next one would never be
// heard and silence would mean both "healed" and "still broken". Prunes the
// window on the way through like the claim does, and writes nothing at all when
// there was nothing to forget — the green path is the common one.
function forgetEventKeys(id) {
  const doc = readEventKeys();
  const cutoff = Date.now() - EVENTKEY_TTL_MS;
  let dropped = false;
  for (const [c, keys] of Object.entries(doc)) {
    for (const [k, ts] of Object.entries(keys)) {
      const live = typeof ts === 'number' && ts > cutoff;
      if (!live) { delete keys[k]; continue; }
      if (c === id) { delete keys[k]; dropped = true; }
    }
    if (!Object.keys(keys).length) delete doc[c];
  }
  if (!dropped) return false;
  try { fs.writeFileSync(EVENTKEYS_FILE, JSON.stringify(doc)); }
  catch (e) { console.error(now() + ' event key store unwritable: ' + String((e && e.message) || e)); }
  return true;
}

// ---------- lifecycle hooks (workspace-owned scripts; server/hooks.js) ----------
// Events v1: worker-done, worker-died, card-archived. Fire-and-forget — a hook
// never blocks or fails the lifecycle outcome it observes. The ONE ordering
// guarantee: card-archived hooks are AWAITED before the worktree release (the
// PR-watch path), so a hook can still reach paths inside $BC_WORKTREE.
const HOOK_TIMEOUT_MS = parseInt(process.env.BC_HOOK_TIMEOUT_MS, 10) > 0
  ? parseInt(process.env.BC_HOOK_TIMEOUT_MS, 10) : 0; // 0 = the module default (~120s)

// Hook env context: prefer the live worker record, fall back to the card's
// own attributes (the worker registry entry may already be gone on archive).
//
// A RELEASED worktree is no longer a path: the registry entry keeps naming it
// (the recovery paths probe it to explain what happened), but a hook gets the
// empty string that documents N/A instead of a directory that is gone — the
// ordinary card-archived case, since the handoff released it long before a PR
// merged.
function hookContext(card, w) {
  const attrs = (card && card.attributes) || {};
  const project = findProject(String((w && w.project) || attrs.repo || ''));
  const wt = (w && w.worktree && !w.worktree.released && w.worktree.path) || '';
  return {
    workspace: WORKSPACE,
    card: card.id,
    repo: project ? project.path : '',
    worktree: wt || String(attrs.worktree || ''),
    branch: (w && w.branch) || String(attrs.branch || ''),
  };
}

// fireHooks(event, card, w, opts) — run the workspace's hooks for a lifecycle
// event and land each result as a timeline event: hook-ran (level 2, routine)
// per success, hook-failed (level 1 — the captain's bell) per failure, text =
// filename + exit detail + trimmed output. Failures also queuePush to the
// owner. Never throws (so every call site can stay fire-and-forget); the
// returned promise resolves after the events landed, which is what lets the
// card-archived call site await it BEFORE releasing the worktree.
//
// An ARCHIVED card can't take timeline events — it left the board and its
// archive.jsonl snapshot is already frozen — so when the card is gone (or the
// call site knows it is leaving: opts.boardLevel) the events land on the
// board-level stream with a card reference instead of being dropped.
async function fireHooks(event, card, w, opts) {
  try {
    const results = await runHooks(event, hookContext(card, w),
      HOOK_TIMEOUT_MS ? { timeoutMs: HOOK_TIMEOUT_MS } : undefined);
    if (!results.length) return;
    for (const r of results) {
      const detail = r.timedOut ? 'timed out'
        : r.error ? String(r.error)
        : 'exit ' + r.code;
      const text = event + ' hook ' + r.hook + (r.ok ? ' ok' : ' FAILED') + ' (' + detail + ')'
        + (r.output ? ': ' + r.output : '');
      landCardEvent(card, mkEvent({ text, actor: 'server' },
        { kind: r.ok ? 'hook-ran' : 'hook-failed' }), opts);
      if (!r.ok) queuePush(card.owner, { kind: 'hook-failed', card: card.id, text: text.slice(0, 2000) });
    }
    store.commit();
  } catch (e) {
    console.error(now() + ' ' + event + ' hooks for ' + card.id + ' failed: ' + String((e && e.message) || e));
  }
}

// landCardEvent(card, ev, opts) — the card takes the event if it is still on
// the board; an ARCHIVED card cannot (it left, and its archive.jsonl snapshot
// is frozen), so the event goes to the board-level stream carrying a reference
// to the card instead of being dropped. opts.boardLevel takes the board stream
// without asking: the call site already knows the card is leaving.
function landCardEvent(card, ev, opts) {
  const live = (opts && opts.boardLevel) ? null : findCard(card.id);
  if (live) {
    store.pushCardEvent(live, ev);
  } else {
    ev.card = card.id;
    ev.cardTitle = card.title;
    board.events.push(ev);
  }
  return ev;
}

// The playbook's `teardown` gets TWO budgets, named apart by who is waiting:
// at the handoff and archive nothing waits (the release is detached), so five
// minutes; at the rework RESTART a `card start` caller is on the line, so one.
// BC_TEARDOWN_TIMEOUT_MS overrides both (the test knob).
const TEARDOWN_TIMEOUT_MS = parseInt(process.env.BC_TEARDOWN_TIMEOUT_MS, 10) > 0
  ? parseInt(process.env.BC_TEARDOWN_TIMEOUT_MS, 10) : TEARDOWN_DEFAULT_MS;
const RESTART_TEARDOWN_TIMEOUT_MS = parseInt(process.env.BC_TEARDOWN_TIMEOUT_MS, 10) > 0
  ? parseInt(process.env.BC_TEARDOWN_TIMEOUT_MS, 10) : 60000;
// The alive-but-hung gap: a worker stuck inside one turn emits no end-of-life
// signal, so long silence on a Working card is the only tell (30 min default).
const BC_WORKER_STALE_SECS = process.env.BC_WORKER_STALE_SECS !== undefined
  ? parseInt(process.env.BC_WORKER_STALE_SECS, 10) : 1800;

// The worker lifecycle (server/workers.js): start, the verbs, supervision and
// the ONE end-of-life path. Everything it touches is injected from here.
const workers = createWorkers({
  board: () => board,
  findCard, findProject, columnTitle,
  harnessFor,
  worktrees: {
    create: (projectPath, cardId) => createWorktree(projectPath, cardId, WORKSPACE),
    release: releaseWorktree,
    toolFor: (p) => worktreeToolFor(p, WORKSPACE),
  },
  runTeardown, hookContext, fireHooks,
  mkEvent, landEvent: landCardEvent, queuePush,
  save: store.commit,
  planStart, ownerSession, workerWindow: names.workerWindow,
  refreshStatus: refreshAgentStatus,
  permissionMode: () => configPermissionMode(),
  permissionPending: (cardId) => permissions.has((it) => it.card === cardId),
  log: (m) => console.error(now() + ' ' + m),
  config: {
    stateDir: STATE_DIR,
    teardownMs: TEARDOWN_TIMEOUT_MS, restartTeardownMs: RESTART_TEARDOWN_TIMEOUT_MS,
    staleSecs: BC_WORKER_STALE_SECS,
  },
});
// Kept for callers outside the worker region.
function killCardWorker(card, w, opts) { return workers.kill(card, w, opts); }
function stampWorkerAddress(card, w) { return workers.stamp(card, w); }

// card.start's playbook half: the card's playbook is resolved and read HERE,
// at start and only here, so the worker gets the card and the playbook as they
// stand. No fallback: a card with no playbook does not start. The lifecycle
// half (worktree, spawn, bind, restart) is workers.start in server/workers.js.
// The attributes the BOARD writes and a human never does: named in a refusal,
// never offered as a recipe.
const BOARD_OWNED_ATTRS = new Set(['prs', 'artifacts']);

/**
 * Resolve what a start runs from the card's playbook: harness, branch, launch
 * flags, keep_worktree/teardown, and the brief renderer. Refuses BEFORE
 * anything is provisioned (a missing `requires` attribute, an unknown harness).
 * @returns {{impl, branch, extraArgs, keepWorktree, teardown, brief: (wtPath) => string}|{error, code}}
 * `impl` carries the typed model/effort into its spawn.
 */
function planStart(card, body, project) {
  const playbookId = String(card.playbook || '').trim();
  if (!playbookId) {
    return { error: 'card ' + card.id + ' has no playbook — pick one before starting it: '
      + 'bc-axi card patch ' + card.id + ' --playbook <id>. Available: ' + playbooksHint(), code: 400 };
  }
  const playbookFile = resolvePlaybook(STATE_DIR, playbookId);
  if (!playbookFile) {
    return { error: 'card ' + card.id + ' points at playbook "' + playbookId + '", which no file '
      + 'matches. Available: ' + playbooksHint(), code: 400 };
  }
  let raw;
  try { raw = fs.readFileSync(playbookFile, 'utf8'); }
  catch (e) { return { error: 'playbook unreadable (' + playbookFile + '): ' + String((e && e.message) || e), code: 502 }; }
  let template = '';
  let meta = {};
  try { ({ meta, body: template } = parsePlaybook(raw)); }
  catch (e) { return { error: 'playbook ' + playbookFile + ': ' + String((e && e.message) || e), code: 400 }; }
  // `requires`: does the card CARRY the attribute (an empty list carries
  // nothing), matched through attrVar() like the placeholders, so PR_URL is
  // answered by pr_url.
  const have = new Set();
  for (const [k, v] of Object.entries((card.attributes || {}))) {
    if (v === null || v === undefined) continue;
    const carried = typeof v === 'object'
      ? (Array.isArray(v) ? v.length > 0 : Object.keys(v).length > 0)
      : String(v).trim() !== '';
    if (carried) have.add(attrVar(k));
  }
  // Named back in the form the CARD carries, so nobody sets a second spelling.
  const missing = [...new Set((meta.requires || [])
    .filter((k) => !have.has(attrVar(k)))
    .map((k) => attrCardKey(k)))];
  if (missing.length) {
    const ours = missing.filter((k) => BOARD_OWNED_ATTRS.has(k));
    const settable = missing.filter((k) => !BOARD_OWNED_ATTRS.has(k));
    let err = 'card ' + card.id + ' cannot start on playbook "' + playbookId + '": that playbook '
      + 'requires the attribute' + (missing.length > 1 ? 's ' : ' ') + missing.join(', ') + '.';
    if (settable.length) {
      err += ' Set ' + (settable.length > 1 ? 'them' : 'it') + ' first: bc-axi card patch '
        + card.id + ' ' + settable.map((k) => '--attr ' + k + '=<value>').join(' ') + '.';
    }
    if (ours.length) {
      err += ' ' + ours.join(' and ') + ' ' + (ours.length > 1 ? 'are' : 'is')
        + ' recorded by the board itself and never set by hand — the card has to earn '
        + (ours.length > 1 ? 'them' : 'it') + ' before this playbook can run.';
    }
    return { error: err, code: 400 };
  }
  // Harness and model: explicit flag, then the playbook's frontmatter, then config.
  const harnessFromPlaybook = !body.harness && !!meta.harness;
  const harnessName = String(body.harness || meta.harness || readConfig().harness || port.defaultHarness());
  let impl;
  // A name the playbook asked for names the playbook back.
  try { impl = getHarness(harnessName); }
  catch (e) {
    return { error: String((e && e.message) || e)
      + (harnessFromPlaybook ? ' (from playbook ' + playbookFile + ')' : ''), code: 400 };
  }
  // model and effort are TYPED options: the harness spells its own flags, and
  // one it does not honor is dropped with a note on the card (best-effort;
  // verbs still throw). The start never fails over an option.
  const modelHint = body.model || meta.model;
  const { opts: typed, ignored } = port.splitOptions(impl, {
    model: modelHint ? String(modelHint) : undefined,
    effort: body.effort ? String(body.effort) : undefined,
  });
  for (const opt of ignored) {
    store.cardEvent(card, { text: harnessName + ' does not support ' + opt + '; started without it', actor: 'server' },
      { kind: 'option-ignored' });
  }
  const extraArgs = [];
  if (Object.keys(typed).length) {
    const raw = impl;
    impl = Object.assign({}, raw, { spawn: (cwd, prompt, o) => raw.spawn(cwd, prompt, Object.assign({}, o, typed)) });
  }
  // A branch is the playbook's delivery contract; without the key the card type decides.
  const cuts = typeof meta.branch === 'boolean' ? meta.branch : card.type !== 'investigation';
  const branch = cuts ? 'bc/' + card.id : null;
  return {
    impl, branch, extraArgs, keepWorktree: !!meta.keep_worktree, teardown: meta.teardown || '',
    brief: (wtPath) => workerBrief({
      template, card, task: body.brief, thread: card.thread || [],
      project, worktree: wtPath, branch: branch || '', workspace: WORKSPACE,
      stateDir: STATE_DIR, cli: path.join(__dirname, '..', 'cli', 'bc-axi'),
    }),
  };
}

// ---------- supervision loop (invariant 8: supervision is infrastructure) ----------
// Every ~30s: harness.alive on every lieutenant + worker ref.
//   lieutenant dead  -> harness.resume when resumable (memory recoverable),
//                       else harness.spawn with charter + board digest (same
//                       session name either way), ref updated, level-1 event,
//                       nudge to drain; max 3 failed attempts then a level-1
//                       needs-captain flag (attempts reset when alive).
//   worker dead w/o done -> QueueItem to the owner + level-2 card event; the
//                       card STAYS Working but the registry entry is flagged —
//                       the owner decides (card start --resume, or move back).
//   worker done      -> nothing to watch (the done QueueItem already landed).
const SUPERVISE_MS = process.env.BC_SUPERVISE_INTERVAL_MS !== undefined
  ? parseInt(process.env.BC_SUPERVISE_INTERVAL_MS, 10) : 30000;
const respawnAttempts = new Map(); // lieutenant id -> consecutive failed respawns
// One skeleton for every periodic job (guard, catch, unref). Kept in a const so
// the plugin host can hand it to plugins as ctx.watchers.
const watchers = createWatchers({ log: (msg) => console.error(now() + ' ' + msg) });
async function superviseTick() {
  let changed = false;
  for (const lt of board.lieutenants) {
    if (!isHarnessRef(lt.ref)) continue;
    let impl = null;
    try { impl = harnessFor(lt.ref); } catch (e) { impl = null; }
    // A lieutenant's session is shared with its worker windows, so its ref
    // must name its own window (names.LIEUTENANT_WINDOW) — a session-granular
    // one would kill every worker on revive and read liveness off whichever
    // window has focus. Refs registered before that (founders, older boards)
    // are migrated here, in place: the running lieutenant is renamed into its
    // window, never restarted. Best-effort — a tick on the old ref is fine.
    if (impl && !lt.ref.window && typeof impl.adoptWindow === 'function') {
      try {
        const taken = board.workers
          .filter((w) => w.ref.session === lt.ref.session && w.ref.window)
          .map((w) => w.ref.window);
        const ref = await impl.adoptWindow(lt.ref, names.LIEUTENANT_WINDOW, taken);
        if (ref) { lt.ref = ref; changed = true; }
      } catch (e) { /* keep the old ref; the next tick tries again */ }
    }
    // /reset is restarting this lieutenant right now: between its kill and
    // its spawn it is legitimately down, and respawning here would race that
    // spawn for the same pane.
    if (cyclingLieutenants.has(lt.id)) continue;
    let up = false;
    try { up = impl ? await impl.alive(lt.ref) : false; } catch (e) { up = false; }
    if (up) {
      respawnAttempts.delete(lt.id);
      // Alive but possibly deaf: a wake that landed in a busy pane never
      // became a turn, yet was recorded as sent. Re-run scheduleWake — it
      // no-ops while the last nudge is within WAKE_TTL_MS or nothing is
      // pending, so only a genuinely stuck wake re-fires.
      if (pendingItems(lt.id).length) scheduleWake(lt.id);
      continue;
    }
    // Asked again on the way out: the kill can land DURING the alive()
    // round-trip, so a tick that passed the check above still gets down=true
    // from a lieutenant /reset is legitimately restarting.
    if (cyclingLieutenants.has(lt.id)) continue;
    const n = (respawnAttempts.get(lt.id) || 0) + 1;
    if (n > 3) continue; // already flagged needs-captain; a manual revival resets via alive
    respawnAttempts.set(lt.id, n);
    try {
      // Resume when memory is recoverable; else relaunch a fresh session with
      // charter + owned cards + pending queue as the prompt (the DNA's
      // auto-respawn side effect) — a bare agent with no context helps nobody.
      // The model rides both halves: a resume replays the recorded --model,
      // and passing it explicitly keeps a lieutenant repinned since its last
      // launch from coming back on the old one.
      const opts = ltLaunchOpts(lt);
      let ref;
      if (await impl.resumable(lt.ref, opts)) {
        ref = await impl.resume(lt.ref, opts);
      } else {
        ref = await respawnFresh(lt); // kills the dead pane, relaunches on the digest prompt
      }
      lt.ref = ref;
      respawnAttempts.delete(lt.id);
      store.boardEvent({
        text: 'lieutenant ' + lt.name + ' session died — respawned as ' + ref.harness + ':' + ref.session,
        actor: 'server',
      }, { kind: 'respawned' });
      changed = true;
      delivery.resetNudge(lt.id); // the reincarnated session owes a drain: queue is truth, its memory is a cache
      if (pendingItems(lt.id).length) scheduleWake(lt.id);
      else {
        const target = lt.ref;
        Promise.resolve()
          .then(() => harnessFor(target).send(target, '[bridge-commander] session respawned — run: bc-axi drain'))
          .catch(() => {});
      }
    } catch (e) {
      console.error(now() + ' respawn failed for ' + lt.id + ' (attempt ' + n + '/3): ' + String((e && e.message) || e));
      if (n === 3) {
        store.boardEvent({
          text: 'lieutenant ' + lt.name + ' is down and 3 respawn attempts failed — needs the captain (session ' + lt.ref.session + ')',
          actor: 'server',
        }, { kind: 'needs-captain' });
        respawnAttempts.set(lt.id, 4);
        changed = true;
      }
    }
  }
  if (await workers.tick()) changed = true; // died / stalled workers
  if (changed) store.commit();
}
watchers.register({ id: 'supervise', intervalMs: SUPERVISE_MS, tick: superviseTick });

// ---------- PR watch (F6: merged PR ⇒ archive + release, no agent turn) ----------
// Every ~2min: for every card whose `prs` attribute holds an open URL, ask gh.
// MERGED -> a pr-merged event + owner item per PR that landed; then, ONLY when
// no PR of the card is left open (a stack merges one at a time), release the
// worktree (only when clean — uncommitted work is never discarded) and archive
// the card (reason merged: the landed level-1 event). CLOSED (unmerged) -> mark
// the state and tell the owner; the card stays. gh failures leave state untouched.
const PRWATCH_MS = process.env.BC_PRWATCH_INTERVAL_MS !== undefined
  ? parseInt(process.env.BC_PRWATCH_INTERVAL_MS, 10) : 120000;
// The loop lives in server/prwatch.js; the board reaches it only through these.
const prWatch = createPrWatch({
  cards: () => board.cards,
  ghCmd: process.env.BC_GH_CMD || 'gh', // injectable for tests
  cardEvent: (card, ev, opts) => store.cardEvent(card, ev, opts),
  queuePush,
  endWorker: (card, trigger) => workers.end(card, trigger),
  archiveCard,
  commit: store.commit,
});
watchers.register({ id: 'prwatch', intervalMs: PRWATCH_MS, tick: prWatch.tick });

// ---------- the clock (schedules; server/clock.js runs them) ----------
// A schedule fires a NAMED hook through `hook run`, and a failed firing lands
// on its owner. The tick, the claims and the overlap policy are clock.js's;
// what it touches on the board comes in here.
const SCHEDULE_MS = process.env.BC_SCHEDULE_INTERVAL_MS !== undefined
  ? parseInt(process.env.BC_SCHEDULE_INTERVAL_MS, 10) : 15000;
const clock = createClock({
  workspace: WORKSPACE,
  schedules: () => board.schedules,
  findLieutenant,
  // The kind travels onto the queue item as well as the timeline entry: the
  // drain dispatches on the item's kind alone.
  notify: (s, { text, kind, level, wake }) => {
    store.boardEvent({ text, actor: 'server', level }, { kind });
    if (wake && findLieutenant(s.owner)) {
      queuePush(s.owner, { kind, schedule: s.name, text, source: 'schedule ' + s.name });
    }
  },
  keys: { seen: seenEventKey, claim: claimEventKey, forget: forgetEventKeys },
  save: store.commit,
  runNamedHook,
  now,
  hookTimeoutMs: HOOK_TIMEOUT_MS,
});
const { publicSchedules, findSchedule, scheduleTrigger, describeWhenSafe } = clock;
if (Number.isInteger(SCHEDULE_MS) && SCHEDULE_MS > 0) setInterval(clock.tick, SCHEDULE_MS).unref();

// validateSchedule(body) -> {error, code} | {schedule}
// The refusals are the point of `add`: a bad expression names the offending
// text, a hook that is not there is refused before it can become a dead window
// every five minutes, and an unregistered owner is refused because a firing's
// failure would land nowhere.
function validateSchedule(body) {
  const name = String(body.name || '').trim();
  if (!SCHEDULE_NAME_RE.test(name)) {
    return { error: 'bad schedule name "' + name + '" (letters, digits, _ . - ; starts with a letter, digit or _)', code: 400 };
  }
  if (findSchedule(name)) return { error: 'schedule "' + name + '" already exists', code: 409 };
  const hook = String(body.hook || '').trim();
  if (!HOOK_NAME_RE.test(hook)) return { error: 'a schedule fires a NAMED hook — give one with --hook', code: 400 };
  if (!namedHookFile(WORKSPACE, hook)) {
    return { error: 'no hook "' + hook + '" — a named hook is an executable file in ' + hooksDir(WORKSPACE)
      + ' (bc-axi hook list). A schedule naming a hook that does not exist is a window that fires nothing', code: 400 };
  }
  let when;
  try { when = parseWhen(body.when); } catch (e) { return { error: e.message, code: 400 }; }
  const owner = String(body.owner || '').trim();
  if (!findLieutenant(owner)) {
    return { error: 'unknown lieutenant "' + owner + '" — a schedule needs an owner for its failures to land on', code: 400 };
  }
  const overlap = body.overlap === undefined || body.overlap === null || body.overlap === ''
    ? 'skip' : String(body.overlap);
  if (!OVERLAP.includes(overlap)) return { error: 'overlap must be one of: ' + OVERLAP.join(', '), code: 400 };
  const catchup = body.catchup === undefined || body.catchup === null || body.catchup === ''
    ? 'latest' : String(body.catchup);
  if (!CATCHUP.includes(catchup)) return { error: 'catch-up must be one of: ' + CATCHUP.join(', '), code: 400 };
  return { schedule: { name, hook, when: when.text, owner, overlap, catchup,
    paused: false, created: now(), lastWindow: '', problem: '' } };
}

// ---------- static ui ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  // The keep-alive's loops. music.js fetches them as bytes and would not care
  // what this said — but a captain auditioning one before he merges it opens
  // the URL, and a browser plays audio/mp4 where it downloads octet-stream.
  '.m4a': 'audio/mp4',
  // The room's environment assets. A browser will sniff an image whatever this
  // says, but an HDR arrives through fetch() as bytes and a wrong type is the
  // kind of thing that works everywhere until it does not.
  '.webp': 'image/webp', '.hdr': 'image/vnd.radiance',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.ktx2': 'image/ktx2',
};
function serveStatic(res, rel) {
  const file = path.normalize(path.join(UI_DIR, rel));
  if (!file.startsWith(UI_DIR + path.sep) && file !== path.join(UI_DIR, 'index.html')) {
    return sendJson(res, 404, { error: 'not found' });
  }
  let data;
  try { data = fs.readFileSync(file); } catch (e) { return sendJson(res, 404, { error: 'not found' }); }
  // Two populations of file, two opposite policies — and `no-cache` was the
  // wrong answer for both. It permits a store-and-revalidate, and with no
  // validator to revalidate against, a phone behind a CDN handed the captain
  // yesterday's JavaScript three separate times. Each time it looked like a bug
  // in the thing he was actually testing, which is the expensive kind of wrong.
  //
  // Ours changes every few minutes and is small: never store it.
  // Vendored builds are immutable — their version is in the path, so a new
  // version is a new URL — and one of them is four megabytes: keep it a year.
  // Anchored at the start and cut at a separator: `ui/vendor/…` is vendored,
  // anything merely spelled like it is ours. No file exercises that difference
  // today, which is why it is written strictly here rather than pinned below.
  // `ui/env/` is the same population as `ui/vendor/`: fetched-once assets that
  // are replaced by editing the manifest rather than by mutating a file. One of
  // them is a 5.4 MB sky, and re-downloading it on every open — over a headset's
  // wifi — is the difference between a room that appears and one he gives up
  // waiting for. `no-store` on that would have been a real bug in the field and
  // never once in a test.
  const vendored = /^(vendor|env|audio)([/\\]|$)/.test(rel);
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': vendored ? 'public, max-age=31536000, immutable' : 'no-store',
  });
  res.end(data);
}

// ---------- the file gate (server/filegate.js) ----------
// Which files the artifact routes may read and write: a card's listed
// artifacts, the workspace's playbooks, charters and hooks — nothing else.
const files = createFileGate({
  workspace: WORKSPACE,
  cards: () => board.cards,
  lieutenants: () => board.lieutenants,
  attachment: readAttachmentMeta,
  maxBytes: ARTIFACT_MAX_BYTES,
});

// ---------- server ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const route = req.method + ' ' + p;
  try {
    // ----- ui -----
    if (route === 'GET /') return serveStatic(res, 'index.html');
    if (req.method === 'GET' && p.startsWith('/ui/')) return serveStatic(res, p.slice(4));

    // ----- reads -----
    if (route === 'GET /api/board') return sendJson(res, 200, publicBoard(url.searchParams.get('user') || 'user'));
    if (route === 'GET /api/config') return sendJson(res, 200, userConfig());
    // ----- the TTS and STT engines, on the board's own origin -----
    // Any method, any path under the prefix, streamed both ways (the STT
    // websocket half is on 'upgrade').
    if (ttsProxy.handle(req, res, p, url.search)) return;
    if (sttProxy.handle(req, res, p, url.search)) return;
    if (route === 'GET /api/status') {
      const pending = delivery.pending().length;
      return sendJson(res, 200, {
        // `host` is what this process actually BOUND, not what config said —
        // a caller that wants a different bind (init/open --host) can only tell
        // by asking, and a server that ignored the flag silently is the bug
        // that sent a stranger a URL their browser could not reach.
        workspace: WORKSPACE, port: PORT, host: BIND_HOST, cards: board.cards.length,
        lieutenants: board.lieutenants.length, seq: board.seq,
        queue_seq: delivery.head(), queue_pending: pending,
        projects: board.projects.length, workers: board.workers.length,
        pid: process.pid,
        code: CODE, // {root, commit, short, dirty} as of BOOT — the CLI compares it to HEAD now
        sysload: sysload.stats(), // the monitoring refcount probe: {subscribers, sampling}
      });
    }
    // ----- first-run state (the onboarding conversation's memory) -----
    // Onboarding is a conversation, and a conversation that restarts from the
    // top on every server bounce is a conversation nobody finishes. The step
    // lives on the board (so it survives the session that is having it, and the
    // UI ships with it in GET /api/board) and Bridget reads it as her first act.
    if (route === 'GET /api/onboarding') return sendJson(res, 200, { onboarding: board.onboarding || null });
    if (route === 'POST /api/onboarding') {
      const body = JSON.parse(await readBody(req) || '{}');
      const cur = board.onboarding || { started: now() };
      const step = body.step === undefined ? cur.step : String(body.step || '');
      if (step && !ONBOARDING_STEPS.includes(step)) {
        return sendJson(res, 400, { error: 'unknown step: ' + step + ' (want ' + ONBOARDING_STEPS.join(' | ') + ')' });
      }
      const next = Object.assign({}, cur, body, { step, updated: now() });
      delete next.actor;
      board.onboarding = next;
      store.commit();
      return sendJson(res, 200, { ok: true, onboarding: board.onboarding });
    }
    if (route === 'GET /api/archive') {
      // Paginated read over the append-only log, newest first: a limit+offset
      // window plus the total, so the UI's 🧊 archived mode can page-in ("load
      // more") instead of slurping an unbounded jsonl in one go. Offset-less
      // calls keep their old meaning (the newest `limit` records) and the
      // response stays a superset of the old shape (CLI reads `archive` only).
      const n = parseInt(url.searchParams.get('limit') || '50', 10) || 50;
      const off = parseInt(url.searchParams.get('offset') || '0', 10) || 0;
      const all = readArchive().reverse();
      return sendJson(res, 200, { archive: all.slice(off, off + n), total: all.length });
    }
    if (route === 'GET /api/notifications') {
      const items = notificationItems(url.searchParams.get('user'));
      return sendJson(res, 200, { items, unread: items.filter((e) => !e.read).length });
    }
    // Artifact directory serve. `/api/artifact?uri=…` is not a path: a page at
    // that address resolving `./audio.wav` asks the board for `/api/audio.wav`,
    // so there is no directory for a relative path to sit in — which is why
    // artifact pages had to inline their assets as base64. `/artifacts/<dir>/<rel>`
    // gives the page a folder, and its siblings load the way every relative path
    // on the web does. Scoped by the file gate to the directory of a listed
    // artifact.
    const adir = /^\/artifacts\/([^/]+)\/(.+)$/.exec(p);
    if (adir && req.method === 'GET') {
      let dir, rel;
      try { dir = decodeURIComponent(adir[1]); rel = decodeURIComponent(adir[2]); }
      catch (e) { return sendJson(res, 400, { error: 'bad artifact path' }); }
      const r = files.readDir(dir, rel);
      if (r.error) return sendJson(res, r.code, { error: r.error });
      return sendBytes(req, res, r.bytes, r.headers);
    }
    // Artifact serve, for the UI's popup viewer: whatever the file gate allows
    // (a card's listed artifacts, or the workspace files the config screen
    // edits) — never an arbitrary file read. Default: the TEXT content and its
    // version. raw=1: the bytes with a real Content-Type, backing the inline
    // <img> and downloads.
    if (route === 'GET /api/artifact') {
      const raw = url.searchParams.get('raw') === '1' || url.searchParams.get('raw') === 'true';
      const r = files.read(url.searchParams.get('uri') || '', { raw });
      if (r.error) return sendJson(res, r.code, { error: r.error });
      if (raw) return sendBytes(req, res, r.bytes, r.headers);
      return sendJson(res, 200, r);
    }

    // Artifact WRITE — what the file editor's save actually does. The file
    // gate decides what is writable and guards the write (no symlink, no `..`,
    // atomic swap); a version the writer read that no longer matches the disk
    // is a 409 carrying what is there now, and nothing is written. A write that
    // lands announces itself on the board SSE (event `artifact`), so an editor
    // already open on the file follows along.
    if (route === 'PUT /api/artifact') {
      let raw;
      try { raw = await readBodyUpto(req, ARTIFACT_MAX_BYTES + 65536); }
      catch (e) {
        if (e.code === 413) return sendJson(res, 413, { error: 'content too large (max ' + ARTIFACT_MAX_BYTES + ' bytes)' });
        throw e;
      }
      const body = JSON.parse(raw || '{}');
      const uri = String(body.uri || '');
      if (typeof body.content !== 'string') return sendJson(res, 400, { error: 'content required' });
      const w = files.write(uri, body.content, body.version);
      if (w.conflict) {
        return sendJson(res, 409, {
          error: 'the file changed on disk since you opened it — nothing was written',
          version: w.conflict.version, content: w.conflict.content,
        });
      }
      if (w.error) return sendJson(res, w.code, { error: w.error });
      // Whoever has this file open hears about it right away — that is what
      // makes four hands four hands instead of two taking turns around a
      // reload button. The writer's own client recognizes the echo.
      broadcastArtifact(uri, w.version, String(body.client || ''));
      return sendJson(res, 200, { ok: true, version: w.version, bytes: w.bytes });
    }

    // ----- chat attachments (uploads) -----
    // POST: base64 upload transport (zero-dep). Decode, size-cap (413), sanitize,
    // store under <STATE_DIR>/uploads with a sidecar; return {id, uri, ...}.
    if (route === 'POST /api/attachments') {
      let raw;
      try { raw = await readBodyUpto(req, Math.ceil(UPLOAD_MAX_BYTES * 1.4) + 65536); }
      catch (e) {
        if (e.code === 413) return sendJson(res, 413, { error: 'upload too large (max ' + UPLOAD_MAX_BYTES + ' bytes)' });
        throw e;
      }
      const body = JSON.parse(raw || '{}');
      const b64 = String(body.dataBase64 || '');
      if (!b64) return sendJson(res, 400, { error: 'dataBase64 required' });
      let data;
      try { data = Buffer.from(b64, 'base64'); } catch (e) { data = null; }
      if (!data || !data.length) return sendJson(res, 400, { error: 'bad base64 data' });
      if (data.length > UPLOAD_MAX_BYTES) return sendJson(res, 413, { error: 'upload too large (max ' + UPLOAD_MAX_BYTES + ' bytes)' });
      const meta = storeAttachment(body.name, body.mime, data);
      return sendJson(res, 200, { id: meta.id, uri: 'attachment://' + meta.id, name: meta.name, mime: meta.mime, size: meta.size });
    }
    // GET: stream the stored bytes with the stored Content-Type. Backs both the
    // inline <img> and file downloads. Strictly within the uploads dir; unknown
    // id → 404 (readAttachmentMeta rejects any traversal in the id).
    const attRoute = /^\/api\/attachments\/([^/]+)$/.exec(p);
    if (attRoute && req.method === 'GET') {
      const meta = readAttachmentMeta(decodeURIComponent(attRoute[1]));
      if (!meta) return sendJson(res, 404, { error: 'unknown attachment' });
      let data;
      try { data = fs.readFileSync(meta.path); } catch (e) { return sendJson(res, 404, { error: 'unreadable' }); }
      // Uploaded bytes are untrusted content served from the board's own origin.
      // nosniff pins the stored Content-Type (no MIME sniffing into executable
      // types); the sandbox CSP neutralizes scripts if an HTML/SVG upload is
      // navigated to as a document — inline <img>/<video> subresources are unaffected.
      return sendBytes(req, res, data, {
        'Content-Type': meta.mime || 'application/octet-stream',
        'Cache-Control': 'private, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': 'sandbox',
      });
    }

    // ----- lieutenants -----
    // Every listing carries `next`, the card id this lieutenant would mint.
    // `live=1` adds what the config screen's lieutenants tab shows and the board
    // payload cannot: how many live cards it owns, where its charter file is,
    // and — the one fact a board tile never tells you — whether its session is
    // actually up. The probe shells out to the harness once per lieutenant, so
    // it is gated the way /api/projects gates its git reads: the tab asks,
    // nobody else pays.
    if (route === 'GET /api/lieutenants') {
      if (!/^(1|true)$/.test(url.searchParams.get('live') || '')) {
        return sendJson(res, 200, { lieutenants: board.lieutenants.map((l) =>
          Object.assign({}, withStatusAge(l), { next: nextCardId(l) })) });
      }
      const lieutenants = await Promise.all(board.lieutenants.map(async (l) => Object.assign({}, withStatusAge(l), {
        cards: board.cards.filter((c) => c.owner === l.id).length,
        next: nextCardId(l),
        memory: charterPath(WORKSPACE, l.id),
        session: await sessionState(l),
      })));
      return sendJson(res, 200, { lieutenants });
    }
    if (route === 'POST /api/lieutenants') {
      const body = JSON.parse(await readBody(req) || '{}');
      if (body.ref !== undefined && body.ref !== null && !isHarnessRef(body.ref)) {
        return sendJson(res, 400, { error: 'bad ref (want {harness, session, cwd, resumeId?})' });
      }
      // spawn:true births a real session (harness.spawn in the workspace root)
      // and registers the lieutenant with the returned ref; without it this is
      // registration only (the founding lieutenant brings its own ref).
      const r = await store.mutate(() => (body.spawn ? spawnLieutenant(body) : createLieutenant(body)));
      // `spawned` is how a re-run of `init --onboard` tells "I revived her" from
      // "she was already up" — the second is not worth a line of anyone's output.
      return respond(res, r, () => ({ ok: true, lieutenant: r.lieutenant, spawned: r.spawned }));
    }
    const ltRoute = /^\/api\/lieutenants\/([^/]+)$/.exec(p);
    if (ltRoute && req.method === 'DELETE') { // lieutenant.retire — explicit only
      const body = JSON.parse(await readBody(req) || '{}');
      const r = await store.mutate(() => retireLieutenant(decodeURIComponent(ltRoute[1]), body));
      return respond(res, r, () => ({ ok: true, event: r.event, memory: r.memory }));
    }
    if (ltRoute && req.method === 'PATCH') { // name/color/avatar/voice/prefix/model/harness/ref (init idempotency)
      const lt = findLieutenant(decodeURIComponent(ltRoute[1]));
      if (!lt) return sendJson(res, 404, { error: 'unknown lieutenant: ' + decodeURIComponent(ltRoute[1]) });
      const body = JSON.parse(await readBody(req) || '{}');
      const r = store.mutate(() => patchLieutenant(lt, body));
      if (r.error || !r.harness) return respond(res, r, () => ({ ok: true, lieutenant: lt }));
      // Last, and its own change: the switch costs the lieutenant its session,
      // and the fields above are already on the record the respawn prompt reads.
      const sw = await store.mutate(() => switchLieutenantHarness(lt, r.harness, body.actor));
      return respond(res, sw, () => ({ ok: true, lieutenant: lt, switched: sw.switched, event: sw.event }));
    }

    // ----- turn boundaries (the BC_TURNEND_URL target; posted by the Stop-hook relay) -----
    // The workspace-level hook fires for ANY claude in the workspace cwd, so
    // resolution dedupes by session_id: (1) a lieutenant ref whose resumeId
    // matches; (2) a lieutenant ref whose STATE KEY (refKey — `session:lt` for
    // the usual window-granular lieutenant) matches the hook's session arg;
    // (3) a WORKER ref by resumeId then session (workers' POSTs
    // arrive from the per-spawn hooks in their isolated worktrees — resolved
    // BEFORE lieutenant attribution so a worker's first POST can never be
    // mis-adopted); (4) tmux attribution — the hook runs inside the agent's
    // pane, so its tmux_session names the owning lieutenant's ref.session
    // exactly — never for a worker's `:w-<card>` key, whose pane shares that
    // session (adopts/refreshes resumeId; works for any number of founders);
    // (5) legacy adoption — only for old hooks whose payload carries no
    // tmux_session field: exactly one ref-bearing lieutenant missing its
    // resumeId, and never a session_id whose cwd is not that lieutenant's
    // ref.cwd (a stray claude in the workspace must not become a lieutenant).
    // Anything else is some other agent in the workspace: acknowledged, ignored.
    // The steps are conversation.identify's (resolveHookAgent).
    if (route === 'POST /api/turn-end') {
      const body = JSON.parse(await readBody(req) || '{}');
      const sid = body.session_id ? String(body.session_id) : '';
      const { lt, worker: w } = resolveHookAgent(body);
      if (w) {
        const r = await workers.turnEnd(w, { sid, text: body.text });
        store.save();
        if (r.stopped || r.statusChanged) broadcast();
        return sendJson(res, 200, { ok: true, lieutenant: null, worker: w.card });
      }
      if (!lt) return sendJson(res, 200, { ok: true, lieutenant: null });
      if (sid && lt.ref.resumeId !== sid) lt.ref.resumeId = sid; // hook payload is ground truth
      lt.lastTurnEnd = now();
      lt.turns = (lt.turns || 0) + 1;
      // turn-end is the status refresh point (context bar / /status data)
      const statusChanged = await refreshAgentStatus(lt);
      store.save();
      if (statusChanged) broadcast();
      // Drain-at-turn-start backstop: the lieutenant just ended a turn with
      // items still unacked. Re-nudge unless a wake is already outstanding
      // since its last drain (a drained-but-unacked queue re-nudges here; an
      // ignored outstanding wake does not loop the session forever).
      const pending = pendingItems(lt.id).length;
      if (pending) scheduleWake(lt.id);
      return sendJson(res, 200, { ok: true, lieutenant: lt.id, pending });
    }

    // ----- permission approvals -----
    // A PermissionRequest hook asks here and waits: the response stays open
    // until the captain decides (/decide below), the cap answers null, or the
    // hook hangs up. Attribution is turn-end's, read-only — an ask never
    // adopts a resumeId. Unattributed asks still show: the captain can judge.
    if (route === 'POST /api/permission') {
      const body = JSON.parse(await readBody(req) || '{}');
      const { lt, worker } = resolveHookAgent(body);
      permissions.hold(res, permissionFields(body, lt, worker));
      return;
    }
    const decideRoute = /^\/api\/permission\/([^/]+)\/decide$/.exec(p);
    if (decideRoute && req.method === 'POST') {
      const id = decodeURIComponent(decideRoute[1]);
      if (!permissions.has((it) => it.id === id)) return sendJson(res, 404, { error: 'unknown permission: ' + id });
      const body = JSON.parse(await readBody(req) || '{}');
      if (body.decision !== 'allow' && body.decision !== 'deny') {
        return sendJson(res, 400, { error: 'decision must be allow or deny' });
      }
      const message = typeof body.message === 'string' ? body.message.trim().slice(0, 1000) : '';
      const item = permissions.decide(id, body.decision, message);
      // The hook may have hung up while this body was being read.
      if (!item) return sendJson(res, 404, { error: 'unknown permission: ' + id });
      const card = item.card ? findCard(item.card) : null;
      if (card) {
        const text = 'captain ' + (body.decision === 'allow' ? 'approved ' : 'denied ') + item.tool_name + ': '
          + item.summary + (message ? ' — ' + message : '');
        store.cardEvent(card, { text, actor: 'captain' }, { kind: 'permission', level: 2 });
      }
      store.commit();
      return sendJson(res, 200, { ok: true });
    }

    // ----- cards -----
    if (route === 'POST /api/cards') {
      const body = JSON.parse(await readBody(req) || '{}');
      const r = store.mutate(() => createCard(body));
      return respond(res, r, () => ({ ok: true, card: publicCard(r.card, 'user') }));
    }
    // restore targets a card that is NOT on the board, so it routes before the
    // find-card paths (which would 404 the normal restore case).
    const restoreRoute = /^\/api\/cards\/([^/]+)\/restore$/.exec(p);
    if (restoreRoute && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      const r = store.mutate(() => restoreCard(decodeURIComponent(restoreRoute[1]), body));
      return respond(res, r, () => ({ ok: true, card: publicCard(r.card, 'user'), event: r.event }));
    }
    const cardRoute = /^\/api\/cards\/([^/]+)(\/(move|events|archive|status|start|park|artifacts|worker\/signal|worker\/done|worker\/send|worker\/pause))?$/.exec(p);
    if (cardRoute) {
      const card = findCard(decodeURIComponent(cardRoute[1]));
      if (!card) return sendJson(res, 404, { error: 'unknown card: ' + decodeURIComponent(cardRoute[1]) });
      const sub = cardRoute[3];
      if (sub === 'start' && req.method === 'POST') { // card.start — the ONE atomic op into Working
        const body = JSON.parse(await readBody(req) || '{}');
        const r = await store.mutate(() => workers.start(card, body));
        return respond(res, r, () => ({ ok: true, card: publicCard(card, 'user'), worker: r.worker, resumed: !!r.resumed }));
      }
      if (sub === 'worker/signal' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req) || '{}');
        const r = store.mutate(() => workers.signal(card, body));
        return respond(res, r, () => ({ ok: true, event: r.event }));
      }
      if (sub === 'worker/send' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req) || '{}');
        const r = await store.mutate(() => workers.send(card, body));
        return respond(res, r, () => ({ ok: true, event: r.event, session: r.session }));
      }
      if (sub === 'worker/pause' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req) || '{}');
        const r = await store.mutate(() => workers.pause(card, body));
        return respond(res, r, () => ({ ok: true, event: r.event, session: r.session,
          parked: r.parked, parkError: r.parkError, card: publicCard(card, 'user') }));
      }
      if (sub === 'park' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req) || '{}');
        const r = await store.mutate(() => workers.park(card, body));
        return respond(res, r, () => ({ ok: true, event: r.event, card: publicCard(card, 'user') }));
      }
      if (sub === 'worker/done' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req) || '{}');
        const r = store.mutate(() => workers.done(card, body));
        if (r.error) return respond(res, r);
        // The worktree STAYS: done hands the card to its lieutenant, whose first
        // job is to read the diff in it. It goes at the handoff (the move out of
        // Working), not here.
        fireHooks('worker-done', card, findWorker(card.id)); // fire-and-forget
        return sendJson(res, 200, { ok: true, event: r.event, card: publicCard(card, 'user') });
      }
      if (!sub && req.method === 'GET') {
        const pc = publicCard(card, url.searchParams.get('user') || 'user');
        pc.status = await workers.withLiveness(card, pc.status);
        return sendJson(res, 200, pc);
      }
      if (!sub && req.method === 'PATCH') {
        const body = JSON.parse(await readBody(req) || '{}');
        const r = store.mutate(() => patchCard(card, body));
        return respond(res, r, () => ({ ok: true, card: publicCard(card, 'user') }));
      }
      if (sub === 'status' && req.method === 'POST') { // status.set(card, worker{id, state}, ttl?)
        const body = JSON.parse(await readBody(req) || '{}');
        const r = store.mutate(() => setStatus(card, body));
        return respond(res, r, () => ({ ok: true, status: cardStatus(card, 'user') }));
      }
      if (sub === 'move' && req.method === 'POST') {
        const wasWorking = card.column === 'working';
        const body = JSON.parse(await readBody(req) || '{}');
        const r = store.mutate(() => moveCard(card, body));
        // The handoff IS the end of the worker (workers.end: kill, then release,
        // with its exceptions). NOT awaited: the release queues behind the clone
        // lock and a teardown, and lands on the timeline when it lands.
        if (!r.error && wasWorking && card.column !== 'working') {
          workers.end(card, 'handoff').catch((e) => console.error(now() + ' handoff teardown for ' + card.id
            + ' failed: ' + String((e && e.message) || e)));
        }
        return respond(res, r);
      }
      if (sub === 'events' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req) || '{}');
        if (!String(body.text || '').trim()) return sendJson(res, 400, { error: 'text required' });
        // `key`: at-most-once for this card within the window. Answered 200 —
        // a poller that already reported this is not in error, and a hook that
        // exits non-zero on it would ring the bell sixty times instead.
        const key = String(body.key || '').trim().slice(0, 200);
        if (key && seenEventKey(card.id, key)) {
          return sendJson(res, 200, { ok: true, duplicate: true, key });
        }
        // Write-ahead, then the live board — the order queuePush itself keeps.
        // The append is the step that can throw, and a throw before the push
        // must leave NOTHING behind in the board object for somebody else's
        // save to write out later: the caller was told nothing happened,
        // so a phantom entry surfacing on the next unrelated save is the one
        // duplicate --key was never meant to buy. mkEvent has already spent a
        // board.seq by then, which costs nothing — seq is monotonic, not dense.
        const ev = mkEvent(body, { level: 2 });
        // `source`: who put this here. Rides onto the timeline entry AND the
        // queue item below, so a drain at 2am says who woke you.
        const source = String(body.source || '').trim().slice(0, 60);
        if (source) ev.source = source;
        // wakeOwner: the door an outside process (a workflow, a cron, a CI hook)
        // uses to wake a card's lieutenant. Same pair every server-side wake
        // already uses — timeline entry AND a queue item — so the escalation is
        // on the record instead of interjecting in the captain's chat thread.
        // Orthogonal to level: level 1 rings THE CAPTAIN and always has. Both
        // flags together does both, deliberately — the caller asked for both.
        if (body.wakeOwner) {
          queuePush(card.owner, Object.assign(
            { kind: 'card-event', card: card.id, eventKind: ev.kind || null, text: ev.text },
            source ? { source } : {}));
        }
        store.pushCardEvent(card, ev);
        store.commit();
        // Only now: the entry is on the card and the queue item is written, so
        // this key really has been said.
        if (key) claimEventKey(card.id, key);
        return sendJson(res, 200, { ok: true, event: ev });
      }
      if (sub === 'archive' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req) || '{}');
        const r = store.mutate(() => archiveCard(card, body));
        if (r.error) return respond(res, r);
        // Kill, card-archived hooks, release (keep_worktree buys nothing: the
        // card is gone) — detached, like the handoff.
        workers.end(card, 'archive').catch((e) => console.error(now() + ' archive teardown for ' + card.id
          + ' failed: ' + String((e && e.message) || e)));
        return sendJson(res, 200, r);
      }
      // promote-to-artifact — the deliberate tool. POST adds, DELETE removes an
      // entry on card.attributes.artifacts. A chat upload alone never lands here.
      if (sub === 'artifacts' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req) || '{}');
        const r = store.mutate(() => cardArtifactAdd(card, body));
        return respond(res, r, () => ({ ok: true, artifact: r.artifact, card: publicCard(card, 'user') }));
      }
      if (sub === 'artifacts' && req.method === 'DELETE') {
        const body = JSON.parse(await readBody(req) || '{}');
        const r = store.mutate(() => cardArtifactRemove(card, body));
        return respond(res, r, () => ({ ok: true, removed: r.removed, card: publicCard(card, 'user') }));
      }
      return sendJson(res, 405, { error: 'method not allowed' });
    }

    // ----- projects (F6) -----
    // The registry as it is stored, plus what a reader needs to trust a row.
    // `cards` is board data (the live cards whose `repo` names this project), so
    // it is always there and costs nothing. `remote` and `branch` are two git
    // reads off the clone — only ?git=1 pays for them, so the CLI and every
    // other caller of this route are unchanged.
    // Ordered by live-card count then name: the registry grows monotonically and
    // most of it is idle, so the ones actually in use lead.
    if (route === 'GET /api/projects') {
      const git = /^(1|true)$/.test(url.searchParams.get('git') || '');
      const projects = board.projects.map((p) => {
        const out = Object.assign({}, p,
          { cards: board.cards.filter((c) => c.attributes && c.attributes.repo === p.name).length });
        return git ? Object.assign(out, projectGit(p.path)) : out;
      });
      projects.sort((a, b) => (b.cards - a.cards) || String(a.name).localeCompare(String(b.name)));
      return sendJson(res, 200, { projects });
    }
    if (route === 'POST /api/projects') {
      const body = JSON.parse(await readBody(req) || '{}');
      const r = await store.mutate(() => addProject(body));
      return respond(res, r, () => ({ ok: true, project: r.project }));
    }

    // ----- playbooks (the card's `playbook` picks one by id) -----
    // Read off the filesystem on every call, never cached: editing a template
    // (or dropping a new one in) changes the next card started, with no
    // restart, and the dropdown has to say so too.
    if (route === 'GET /api/playbooks') {
      const dir = playbooksDir(STATE_DIR);
      const ids = listPlaybooks(STATE_DIR);
      // `playbooks` stays the plain id list the picker and the CLI read.
      // `items` says WHERE each one comes from — resolvePlaybook already decides
      // which file wins, so where it landed is the answer, not a second guess at
      // the same rule. That is what lets the config screen open a workspace
      // playbook for editing and offer to copy a packaged one first.
      const items = ids.map((id) => {
        const file = resolvePlaybook(STATE_DIR, id);
        return { id, file, source: path.dirname(file) === dir ? 'workspace' : 'packaged' };
      });
      // `reference` is the two vocabularies a playbook is written in, straight
      // off playbooks.js — the screen renders it, never restates it.
      return sendJson(res, 200, { playbooks: ids, items, dir,
        reference: { placeholders: PLACEHOLDERS, frontmatter: FRONTMATTER } });
    }

    // ----- hooks (the workspace's own executable scripts; server/hooks.js) -----
    // Read off the filesystem on every call, never cached: a hook dropped in a
    // second ago is in the next answer, the way playbooks work.
    //
    // `last` is the newest trace line for that hook, read from the TAIL of
    // hookruns.jsonl in one backward walk for the whole list.
    if (route === 'GET /api/hooks') {
      const hooks = listAllHooks(WORKSPACE);
      const last = lastRuns(WORKSPACE, hooks);
      return sendJson(res, 200, {
        dir: hooksDir(WORKSPACE),
        hooks: hooks.map((h) => Object.assign({}, h, {
          last: last.get(hookKey(h)) || null,
          running: h.event ? null : runningHook(WORKSPACE, h.name),
        })),
      });
    }
    // The ONE code path a named hook runs through: `bc-axi hook run` posts here,
    // and so does the board's ▶. Not a door for outside callers — an external
    // trigger runs on this machine and speaks CLI; this is what the CLI speaks
    // to, the same way every other verb does.
    if (route === 'POST /api/hooks/run') {
      const body = JSON.parse(await readBody(req) || '{}');
      const name = String(body.name || '');
      const cardId = String(body.card || '');
      let ctx = {};
      if (cardId) {
        const card = findCard(cardId);
        if (!card) return sendJson(res, 404, { error: 'unknown card: ' + cardId });
        ctx = hookContext(card, findWorker(card.id));
      }
      try {
        const run = await runNamedHook(WORKSPACE, name, ctx, {
          trigger: String(body.trigger || 'cli'),
          timeoutMs: HOOK_TIMEOUT_MS || 0,
        });
        return sendJson(res, 200, { ok: true, run });
      } catch (e) {
        if (e && e.code === 'ENOHOOK') return sendJson(res, 404, { error: e.message });
        if (e && e.code === 'EBUSY') return sendJson(res, 409, { error: e.message, running: e.running });
        throw e;
      }
    }
    // The trace, newest first. Reads the tail — never the whole file.
    if (route === 'GET /api/hookruns') {
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '20', 10) || 20, 500);
      return sendJson(res, 200, {
        runs: readRuns(WORKSPACE, { hook: url.searchParams.get('hook') || '', limit }),
      });
    }

    // ----- schedules (the board's own clock) -----
    // A schedule is board state, so it rides board.json into git with everything
    // else — which is the whole difference from the host cron it replaces.
    if (route === 'GET /api/schedules') {
      return sendJson(res, 200, { schedules: publicSchedules() });
    }
    if (route === 'POST /api/schedules') {
      const body = JSON.parse(await readBody(req) || '{}');
      const v = store.mutate(() => {
        const out = validateSchedule(body);
        if (out.error) return out;
        board.schedules.push(out.schedule);
        store.boardEvent({
          text: 'schedule ' + out.schedule.name + ' added — hook ' + out.schedule.hook + ', '
            + describeWhenSafe(out.schedule.when) + ', owner ' + out.schedule.owner,
          actor: String(body.actor || 'agent'), level: 2,
        }, { kind: 'schedule' });
        return out;
      });
      return respond(res, v, () => ({ ok: true, schedule: publicSchedules().find((s) => s.name === v.schedule.name) }));
    }
    const schedRoute = /^\/api\/schedules\/([^/]+)$/.exec(p);
    if (schedRoute) {
      const name = decodeURIComponent(schedRoute[1]);
      const s = findSchedule(name);
      if (!s) return sendJson(res, 404, { error: 'unknown schedule: ' + name });
      if (req.method === 'GET') {
        // The firings come off the trace — the run detail is already there, and
        // a second copy on the schedule would be a second truth.
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '10', 10) || 10, 200);
        const runs = readRuns(WORKSPACE, { hook: s.hook, limit: limit * 20 })
          .filter((r) => r.trigger === scheduleTrigger(s)).slice(0, limit);
        return sendJson(res, 200, { schedule: publicSchedules().find((x) => x.name === name), runs });
      }
      if (req.method === 'PATCH') {
        const body = JSON.parse(await readBody(req) || '{}');
        if (typeof body.paused !== 'boolean') return sendJson(res, 400, { error: 'only {paused: true|false} is patchable' });
        // Resuming re-arms the cursor at NOW: a schedule paused over the weekend
        // is paused, not queued, and must not wake up owing sixty windows.
        if (s.paused && !body.paused) s.lastWindow = now();
        s.paused = body.paused;
        store.commit();
        return sendJson(res, 200, { ok: true, schedule: publicSchedules().find((x) => x.name === name) });
      }
      if (req.method === 'DELETE') {
        board.schedules = board.schedules.filter((x) => x.name !== name);
        store.boardEvent({ text: 'schedule ' + name + ' removed', actor: 'agent', level: 2 }, { kind: 'schedule' });
        store.commit();
        return sendJson(res, 200, { ok: true });
      }
    }

    // ----- board-level events (free-form notify) -----
    if (route === 'POST /api/events') {
      const body = JSON.parse(await readBody(req) || '{}');
      if (!String(body.text || '').trim()) return sendJson(res, 400, { error: 'text required' });
      const ev = store.boardEvent(body, { level: 1 });
      store.commit();
      return sendJson(res, 200, { ok: true, event: ev });
    }

    // ----- kinds (registered map; idempotent replace) -----
    if (route === 'GET /api/kinds') {
      return sendJson(res, 200, { kinds: effectiveKinds(), registered: board.kinds });
    }
    if (route === 'PUT /api/kinds') {
      const doc = JSON.parse(await readBody(req) || 'null');
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
        return sendJson(res, 400, { error: 'kinds must be {"<kind>": {"emoji": "...", "level": 1|2}}' });
      }
      for (const [k, v] of Object.entries(doc)) {
        if (!k.trim() || !validKindEntry(v)) {
          return sendJson(res, 400, { error: 'bad kind "' + k + '": each entry needs {emoji: non-empty string, level: 1|2}' });
        }
      }
      const next = sanitizeKinds(doc);
      if (JSON.stringify(next) === JSON.stringify(board.kinds)) {
        return sendJson(res, 200, { ok: true, kinds: Object.keys(board.kinds).length, unchanged: true });
      }
      board.kinds = next;
      store.commit();
      return sendJson(res, 200, { ok: true, kinds: Object.keys(board.kinds).length });
    }

    // ----- board meta (title/subtitle) -----
    if (route === 'PATCH /api/board') {
      const body = JSON.parse(await readBody(req) || '{}');
      if (body.title !== undefined) board.title = String(body.title).slice(0, 120);
      if (body.subtitle !== undefined) board.subtitle = String(body.subtitle).slice(0, 300);
      store.commit();
      return sendJson(res, 200, { ok: true });
    }

    // ----- slash commands -----
    // The composer autocomplete's source: what the target session's harness
    // answers. A valid target with no live session (or a harness without the
    // capability) is an EMPTY list, not an error — the composer just shows
    // nothing, and the in-thread reply explains if a command is sent anyway.
    if (route === 'GET /api/commands') {
      const target = String(url.searchParams.get('target') || '');
      const r = commandTargetRef(target);
      if (r.error) return sendJson(res, r.code || 400, { error: r.error });
      // A board command is offered even with no live session — /reset is how a
      // dead lieutenant comes back, so hiding it exactly when it is needed
      // would be the wrong way round.
      if (!r.ref) return sendJson(res, 200, { target, commands: boardCommands(target) });
      return sendJson(res, 200, {
        target,
        harness: r.ref.harness,
        commands: harnessCommands(r.ref).concat(boardCommands(target)),
      });
    }

    // ----- chat -----
    // Older history, straight off the append-only log: the board payload carries
    // only the newest CHAT_TAIL, so the pane pages backwards through here as the
    // captain scrolls up. `before` = the ts of the oldest message he already has;
    // the answer is oldest-first (render order) and EMPTY past the beginning —
    // running out of conversation is not an error. `limit=0` = the whole thing
    // (what `bc-axi thread` prints). Card threads ride the board payload and
    // have nothing to page.
    if (route === 'GET /api/chat') {
      const target = String(url.searchParams.get('target') || '');
      const t = parseTarget(target);
      if (!t || t.kind !== 'lieutenant') return sendJson(res, 400, { error: 'target must be lieutenant:<id> (card threads ride the board payload)' });
      const lt = findLieutenant(t.id);
      if (!lt) return sendJson(res, 404, { error: 'unknown target: ' + target });
      // Only an explicit 0 means the whole conversation; anything unreadable
      // falls back to the default page rather than shipping the entire log.
      const raw = url.searchParams.get('limit');
      const n = raw == null ? NaN : parseInt(raw, 10);
      const limit = Number.isNaN(n) ? CHAT_TAIL : Math.max(0, n);
      const before = String(url.searchParams.get('before') || '');
      return sendJson(res, 200, { target, before: before || null, messages: chatPage(lt.id, before, limit) });
    }
    // chat.say — both sides go through conversation.say(), which decides the
    // thread append, the QueueItem (and so the wake) and the line move.
    if (route === 'POST /api/message') { // lieutenant -> captain (chat.say, lieutenant side)
      const body = JSON.parse(await readBody(req) || '{}');
      // The caller is resolved from its tmux session + window (like drain/ack),
      // so a lieutenant speaking elsewhere is stamped as itself and a worker as
      // `worker <card>` — never as the lieutenant whose session it shares.
      // owed clears on ACK, not here — the reply alone leaves it derived from the queue
      const r = store.mutate(() => conversation.say(callerOf(body), String(body.target || ''),
        String(body.text_md || body.text || ''), resolveAttachments(body.attachments),
        { author: body.author, level: body.level, kind: body.kind }));
      return respond(res, r, () => ({ ok: true }));
    }
    if (route === 'POST /api/feedback') { // captain -> lieutenant (chat.say, captain side)
      const body = JSON.parse(await readBody(req) || '{}');
      const text = String(body.text || '');
      const attachments = resolveAttachments(body.attachments);
      // A bare "/command" (no attachments riding along) is a slash command,
      // not a say: it routes to the target harness's runCommand and both the
      // command and its reply land in the thread — no QueueItem, no wake.
      if (text.trim().startsWith('/') && !attachments.length) {
        const t = conversation.captainTarget(body.target); // `line` = whoever holds it
        if (t.error) return respond(res, t);
        return respond(res, await store.mutate(() => runChatCommand(t.target, text.trim())));
      }
      // a captain message flips derived owed via the broadcast
      const r = store.mutate(() => conversation.say(CAPTAIN, String(body.target || ''), text, attachments));
      return respond(res, r, () => ({ ok: true, seq: r.item.seq, target: r.target, via: r.via }));
    }

    // ----- the line -----
    if (route === 'GET /api/line') { // line.who
      const h = lineHolder();
      if (!h.lieutenant) return sendJson(res, 200, { lieutenant: null, name: null, source: h.source });
      return sendJson(res, 200, { lieutenant: h.lieutenant.id, name: h.lieutenant.name, source: h.source });
    }
    if (route === 'POST /api/line') { // line.pass — a DELIVERY, not a quiet flag flip
      const body = JSON.parse(await readBody(req) || '{}');
      // Who is handing it over: explicit actor, else the CALLER resolved from
      // its tmux session + window (like say/drain/ack), else the captain.
      const r = store.mutate(() => conversation.pass(callerOf(body), body.lieutenant, body.note, { actor: body.actor }));
      return respond(res, r, () => ({ ok: true, lieutenant: r.lt.id, name: r.lt.name, seq: r.item.seq }));
    }

    // ----- read state (persisted server-side, per user) -----
    if (route === 'POST /api/notifications/read') {
      const body = JSON.parse(await readBody(req) || '{}');
      const r = userReads(body.user);
      if (body.all) {
        r.notifSeq = board.seq; r.notifSeqs = [];
        // Clearing is reading: unseen lieutenant replies clear via the same
        // thread read marker that opening the card would set, so mark-all
        // advances it for every card that still has an unseen reply.
        const ts = now();
        for (const c of board.cards) {
          const readMs = lastThreadReadMs('card:' + c.id, body.user);
          if ((c.thread || []).some((m) => m.author !== 'user' && Date.parse(m.ts) > readMs)) {
            r.threads['card:' + c.id] = ts;
          }
        }
      }
      else if (Array.isArray(body.seqs)) {
        for (const s of body.seqs) if (Number.isInteger(s) && s > r.notifSeq && !r.notifSeqs.includes(s)) r.notifSeqs.push(s);
      }
      store.commit();
      return sendJson(res, 200, { ok: true });
    }
    if (route === 'POST /api/read') { // thread read marker: {user?, target, ts?}
      const body = JSON.parse(await readBody(req) || '{}');
      const r = userReads(body.user);
      const target = String(body.target || '');
      if (!/^(lieutenant:.+|card:.+)$/.test(target)) return sendJson(res, 400, { error: 'bad target' });
      r.threads[target] = body.ts || now();
      // No broadcast: a read marker only moves the POSTING user's unread/bell
      // derivation, and that device applies it locally when it POSTs. The
      // unified stream fires one POST per viewed thread per device — full
      // board pushes here burst every SSE client. Other devices of the same
      // user converge on the next real broadcast.
      store.save();
      return sendJson(res, 200, { ok: true });
    }

    // ----- labels registry -----
    if (route === 'POST /api/labels') {
      const b = JSON.parse(await readBody(req) || '{}');
      if (b.create) {
        const name = String(b.create.name || '').trim();
        if (!name) return sendJson(res, 400, { error: 'label name required' });
        const color = validColor(b.create.color);
        const i = labelIndex(name);
        if (i >= 0) { if (color) board.labels[i].color = color; }
        else board.labels.push({ name, color: color || LABEL_PALETTE[board.labels.length % LABEL_PALETTE.length] });
      } else if (b.rename) {
        const from = String(b.rename.from || ''), to = String(b.rename.to || '').trim();
        const i = labelIndex(from);
        if (i < 0) return sendJson(res, 404, { error: 'unknown label: ' + from });
        if (!to) return sendJson(res, 400, { error: 'new name required' });
        if (to !== from && labelIndex(to) >= 0) return sendJson(res, 400, { error: 'label exists: ' + to });
        board.labels[i].name = to;
        for (const c of board.cards) {
          if (Array.isArray(c.labels)) c.labels = c.labels.map((n) => (n === from ? to : n)).filter((n, k, a) => a.indexOf(n) === k);
        }
      } else if (b.recolor) {
        const i = labelIndex(String(b.recolor.name || ''));
        const color = validColor(b.recolor.color);
        if (i < 0) return sendJson(res, 404, { error: 'unknown label: ' + String(b.recolor.name || '') });
        if (!color) return sendJson(res, 400, { error: 'color must be #rrggbb' });
        board.labels[i].color = color;
      } else if (b.delete) {
        const name = String(b.delete.name || '');
        const i = labelIndex(name);
        if (i < 0) return sendJson(res, 404, { error: 'unknown label: ' + name });
        board.labels.splice(i, 1);
        for (const c of board.cards) {
          if (Array.isArray(c.labels)) c.labels = c.labels.filter((n) => n !== name);
        }
      } else {
        return sendJson(res, 400, { error: 'expected create|rename|recolor|delete' });
      }
      store.commit();
      return sendJson(res, 200, { ok: true, labels: board.labels });
    }

    // ----- feed.drain: pending QueueItems past the committed ack cursor -----
    // Each item goes out with its `head` and `hint` (feedtext.js), rendered
    // against the card as it stands now; the stored item is never touched.
    if (route === 'GET /api/feed') {
      const served = (items) => items.map((it) => Object.assign({}, it, feedtext.describe(it, findCard)));
      let lt = url.searchParams.get('lieutenant') || '';
      const sess = url.searchParams.get('session') || '';
      // Session-scoped drain: a lieutenant identifies itself by its tmux session
      // so it drains ONLY its own queue — the fix for cross-lieutenant drain.
      if (lt && !findLieutenant(lt)) return sendJson(res, 404, { error: 'unknown lieutenant: ' + lt });
      if (!lt && sess) {
        const who = callerOf({ session: sess, window: url.searchParams.get('window') });
        const owner = who.kind === 'lieutenant' ? who.lt : null;
        // A session that resolves to no lieutenant (a worker, a stale ref, a
        // non-lieutenant tmux) gets nothing — draining every queue here is
        // exactly what let a non-owner ack-wipe another lieutenant's items.
        if (!owner) return sendJson(res, 200, { items: [], head: delivery.head() });
        lt = owner.id;
      }
      // No identity at all (raw tooling): a read-only peek at every queue. It is
      // not a lieutenant starting its turn, so no wake flag or cursor moves.
      if (!lt) return sendJson(res, 200, { items: served(delivery.pending()), head: delivery.head() });
      // Draining is SEEING: the drained cursor moves, the UI flips queued→seen.
      const r = delivery.drain(lt);
      if (r.seen) broadcast();
      return sendJson(res, 200, { items: served(r.items), head: delivery.head() });
    }

    // ----- feed.ack: commit the cursor AFTER the items were handled -----
    if (route === 'POST /api/feed/ack') {
      const body = JSON.parse(await readBody(req) || '{}');
      const seq = parseInt(body.seq, 10);
      if (!Number.isInteger(seq) || seq < 0) return sendJson(res, 400, { error: 'seq required (integer)' });
      // Identity-scoped ack: a lieutenant commits only within its own queue,
      // and an ack nobody can attribute is refused — it could discard any
      // lieutenant's pending items. Only a one-lieutenant board is unambiguous.
      let ackOwner = body.lieutenant || '';
      if (ackOwner && !findLieutenant(ackOwner)) return sendJson(res, 404, { error: 'unknown lieutenant: ' + ackOwner });
      if (!ackOwner && body.session) {
        const who = callerOf(body);
        // A worker shares its lieutenant's session but owns no queue: unscoped,
        // its ack could commit (and so discard) the lieutenant's pending items.
        if (who.kind === 'worker') return sendJson(res, 409, { error: 'a worker has no delivery queue — acks belong to its lieutenant' });
        if (who.kind !== 'lieutenant') return sendJson(res, 403, { error: 'session ' + body.session + ' is not a lieutenant — ack refused' });
        ackOwner = who.lt.id;
      }
      if (!ackOwner && board.lieutenants.length === 1) ackOwner = board.lieutenants[0].id;
      if (!ackOwner) {
        return sendJson(res, 400, { error: 'ack needs an identity: run it in your lieutenant session, or pass --lieutenant <id>' });
      }
      const r = delivery.ack(ackOwner, seq);
      if (r.error) return sendJson(res, r.code || 400, { error: r.error });
      broadcast(); // the ack advances the seen cursor too (drain normally beat it here)
      return sendJson(res, 200, r);
    }

    // ----- pane streams (👁 peek — per-target SSE; see the pane hub above) -----
    // The HTTP connection's lifetime IS the subscription: connect to watch,
    // disconnect to release (refcounted). Ref resolution happens HERE — the
    // route knows cards and lieutenants, the hub knows refs, the harness knows
    // the rest. Every guard is an SSE event, not an HTTP error: the client is
    // an EventSource, which can't read error bodies.
    const paneRoute = /^\/api\/(cards|lieutenants)\/([^/]+)\/pane\/stream$/.exec(p);
    if (paneRoute && req.method === 'GET') {
      const { ref, reason } = resolvePaneRef(paneRoute[1], decodeURIComponent(paneRoute[2]), url.searchParams.get('window'));
      return paneStream(req, res, ref, reason);
    }

    // ----- pane input (⌨️ type into the LIVE pane — the write half of 👁) -----
    // Same ref resolution as the stream above (resolvePaneRef), same targets,
    // opposite direction: one keystroke or a short literal burst forwarded raw
    // to the pane's tmux target. NOT the agent `send` verb — that one types,
    // settles and Enters with verified retries, which is right for a brief and
    // wrong for an arrow key. Ordinary JSON in, ordinary status codes out (the
    // client is fetch(), not an EventSource): 404 nothing to type into, 501 the
    // harness cannot take input, 502 the harness refused or tmux failed.
    // Same-origin only, exactly like every other route that writes — the
    // network boundary is the auth boundary (README).
    const paneInputRoute = /^\/api\/(cards|lieutenants)\/([^/]+)\/pane\/input$/.exec(p);
    if (paneInputRoute && req.method === 'POST') {
      const { ref, reason } = resolvePaneRef(paneInputRoute[1], decodeURIComponent(paneInputRoute[2]),
        url.searchParams.get('window'));
      if (!ref) return sendJson(res, 404, { error: reason });
      let impl;
      try { impl = harnessFor(ref); }
      catch (e) { return sendJson(res, 404, { error: String((e && e.message) || e) }); }
      if (typeof impl.paneInput !== 'function') {
        return sendJson(res, 501, { error: 'harness "' + ref.harness + '" cannot take pane input' });
      }
      const body = JSON.parse(await readBody(req) || '{}');
      try { await impl.paneInput(ref, { key: body.key, text: body.text }); }
      catch (e) { return sendJson(res, 502, { error: String((e && e.message) || e) }); }
      return sendJson(res, 200, { ok: true });
    }

    // ----- sysload stream (⚙️ → monitoring; see the sysload section above) -----
    // The HTTP connection's lifetime IS the subscription, exactly like the
    // pane streams: connect to watch, disconnect to release. Each sample lands
    // as one `sample` event; samples flow every ~2s, so no extra ping rides here.
    if (route === 'GET /api/sysload/stream') {
      res.writeHead(200, SSE_HEADERS);
      const unsubscribe = sysload.subscribe((sample) => {
        res.write(sseFrame('sample', sample));
      });
      req.on('close', unsubscribe);
      return;
    }

    // ----- SSE -----
    if (route === 'GET /api/events') {
      res.writeHead(200, SSE_HEADERS);
      res.write(sseFrame('board', publicBoard('user')));
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    // A malformed body (JSON) or URL escape is the caller's fault; anything else,
    // e.g. the board save failing on disk, is ours and must not read as a bad request.
    const code = e instanceof SyntaxError || e instanceof URIError ? 400 : 500;
    sendJson(res, code, { error: String(e.message || e) });
  }
});

// The only websocket the board has an opinion about: the STT engine's. Anything
// else asking to upgrade gets the socket dropped, which is what an http server
// with no upgrade handler does anyway.
function onUpgrade(req, socket, head) {
  const u = new URL(req.url, 'http://localhost');
  if (sttProxy.upgrade(req, socket, head, u.pathname, u.search)) return;
  socket.destroy();
}
server.on('upgrade', onUpgrade);

server.on('error', (e) => { console.error('server error: ' + e.message); cleanup(); process.exit(1); });
server.listen(PORT, BIND_HOST, () => {
  console.log('bridge-commander server up: http://localhost:' + PORT + '/ host=' + BIND_HOST +
    ' workspace=' + WORKSPACE + ' pid=' + process.pid);
  // A worker outlives neither its card's Working state nor a board restart that
  // forgot to notice. Off the critical path of the boot, and it never throws.
  workers.sweep().catch((e) => console.error(now() + ' worker sweep failed: ' + String((e && e.message) || e)));
});
// Non-loopback bind: also listen on loopback so local CLI/UI keep working.
if (!LOOPBACKS.includes(BIND_HOST) && BIND_HOST !== '0.0.0.0') {
  const local = http.createServer(server.listeners('request')[0]);
  local.on('upgrade', onUpgrade);
  local.on('error', (e) => { console.error('loopback listener error: ' + e.message); });
  local.listen(PORT, '127.0.0.1');
}
