'use strict';
// runs — the one module that runs a plugin command's shell line and remembers it.
//
//   <stateDir>/runs/<id>.log      the WHOLE output of one run (capped at 5 MB)
//   <stateDir>/activities.jsonl   tracked runs: one line at start, one at end
//
// A run is an ACTIVITY when `tracked`: the board lists it, the card shows it,
// and it survives a restart in activities.jsonl. An untracked run still gets a
// log and a get(id) while this process lives; it just never reaches the list.
//
// The spawn is hooks.runOne's: /bin/sh -c, its own process group, a timeout
// that kills the whole tree. The runner's 4 KB `output` is not the log — the
// log streams from opts.onOutput, so a deploy's hour of output is all there.
//
// A server restart cannot adopt a child it no longer holds a pipe to. So a line
// that says `running` at boot is a run nobody will ever finish: it is closed as
// failed, "server restarted", and that end line is appended so the file says
// so too.
//
// Node built-ins only.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readJsonl, sealJsonl } = require('./jsonl.js');

const ACTIVITIES_FILE = 'activities.jsonl';
const LOG_DIR = 'runs';
const LOG_CAP = 5 * 1024 * 1024;
const LOG_CAP_NOTE = '\n[bridge-commander: log truncated at 5 MB]\n';
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
// What memory holds of the past: the board lists 30, the card a handful. The
// file keeps everything; only this process forgets.
const KEEP = 500;
const ID_RE = /^r-[a-z0-9]+-[0-9a-f]{4}$/;

// The public record, and only it: the shell line and env stay server-side.
function pub(run) {
  const out = { id: run.id, plugin: run.plugin, command: run.command, title: run.title,
    card: run.card, owner: run.owner, status: run.status, startedAt: run.startedAt };
  for (const k of ['endedAt', 'code', 'error']) if (run[k] !== undefined) out[k] = run[k];
  return out;
}

/**
 * The tracked-run service.
 * @param {object} deps
 * @param {string} deps.stateDir <workspace>/.bridge-commander
 * @param {() => (string|number)} [deps.now] ISO string or epoch ms (default Date.now)
 * @param {(msg: string) => void} [deps.log]
 * @param {() => void} [deps.onChange] a run started or ended (the board re-publishes)
 * @param {Function} [deps.runOne] hooks.runOne (injected by tests)
 */
function createRuns(deps) {
  const stateDir = deps.stateDir;
  const log = deps.log || ((m) => console.error(m));
  const runOne = deps.runOne || require('./hooks.js').runOne;
  const nowMs = () => {
    const t = deps.now ? deps.now() : Date.now();
    return typeof t === 'number' ? t : Date.parse(t);
  };
  const iso = (ms) => new Date(ms).toISOString();
  const actFile = path.join(stateDir, ACTIVITIES_FILE);
  const logDir = path.join(stateDir, LOG_DIR);

  const runs = new Map(); // id -> run (public fields + private: tracked, subs, kill, ...)
  const endListeners = new Set();

  function changed() {
    if (!deps.onChange) return;
    try { deps.onChange(); } catch (e) { log('runs onChange failed: ' + String((e && e.message) || e)); }
  }

  function append(run) {
    try { fs.appendFileSync(actFile, JSON.stringify(pub(run)) + '\n'); }
    catch (e) { log('activities.jsonl append failed: ' + e.message); }
  }

  function forget() {
    if (runs.size <= KEEP) return;
    for (const [id, r] of runs) {
      if (runs.size <= KEEP) break;
      if (r.status !== 'running') runs.delete(id);
    }
  }

  // Boot: replay the file (last line per id wins), then close the orphans.
  (function load() {
    sealJsonl(actFile);
    const byId = new Map();
    for (const rec of readJsonl(actFile)) {
      if (rec && typeof rec.id === 'string') { byId.delete(rec.id); byId.set(rec.id, rec); }
    }
    const endedAt = iso(nowMs());
    for (const rec of byId.values()) {
      const run = Object.assign(pub(rec), { tracked: true, subs: new Set() });
      if (run.status === 'running') {
        Object.assign(run, { status: 'failed', endedAt, error: 'server restarted' });
        append(run);
      }
      runs.set(run.id, run);
    }
    forget();
  })();

  function newId(ms) {
    let id;
    do id = 'r-' + ms.toString(36) + '-' + crypto.randomBytes(2).toString('hex');
    while (runs.has(id));
    return id;
  }

  function logPath(id) { return path.join(logDir, id + '.log'); }

  /**
   * Start a run now. Returns the public record at once; the process is spawned.
   * @param {{plugin, command, title, card, owner, shell, cwd, env, timeoutMs, tracked}} spec
   */
  function start(spec) {
    const shell = String((spec && spec.shell) || '');
    if (!shell.trim()) throw new Error('runs.start: shell required');
    const startMs = nowMs();
    const run = {
      id: newId(startMs),
      plugin: String(spec.plugin || ''),
      command: String(spec.command || ''),
      title: String(spec.title || spec.command || ''),
      card: String(spec.card || ''),
      owner: String(spec.owner || ''),
      status: 'running',
      startedAt: iso(startMs),
      tracked: !!spec.tracked,
      subs: new Set(),
      size: 0,
      capped: false,
      kill: null,
      canceled: false,
    };
    runs.set(run.id, run);

    let fd = null;
    try {
      fs.mkdirSync(logDir, { recursive: true });
      fd = fs.openSync(logPath(run.id), 'w');
    } catch (e) { log('run ' + run.id + ': cannot open its log: ' + e.message); }

    // The log and the live subscribers see the same bytes: what a late reader
    // gets from readLog is what an early one was streamed.
    const write = (text) => {
      if (run.capped || !text) return;
      let piece = text;
      const room = LOG_CAP - run.size;
      if (Buffer.byteLength(piece) > room) {
        piece = Buffer.from(piece).subarray(0, Math.max(0, room)).toString('utf8') + LOG_CAP_NOTE;
        run.capped = true;
      }
      if (fd !== null) { try { fs.writeSync(fd, piece); } catch (e) {} }
      run.size += Buffer.byteLength(piece);
      for (const fn of run.subs) { try { fn(piece); } catch (e) {} }
    };

    const env = Object.assign({}, process.env, spec.env || {}, { BC_RUN: run.id });
    const timeoutMs = spec.timeoutMs > 0 ? spec.timeoutMs : DEFAULT_TIMEOUT_MS;
    if (run.tracked) append(run);
    changed();

    runOne(run.title || run.command, '/bin/sh', ['-c', shell], env, spec.cwd || path.dirname(stateDir), timeoutMs, {
      onOutput: write,
      onSpawn: (kill) => { run.kill = kill; if (run.canceled) kill(); },
    }).then((r) => {
      if (fd !== null) { try { fs.closeSync(fd); } catch (e) {} }
      run.endedAt = iso(nowMs());
      run.code = r.code === undefined ? null : r.code;
      if (run.canceled) run.status = 'canceled';
      else if (r.timedOut) { run.status = 'timeout'; run.error = 'timed out after ' + Math.round(timeoutMs / 1000) + 's'; }
      else if (r.ok) run.status = 'ok';
      else {
        run.status = 'failed';
        run.error = r.error ? String(r.error).slice(0, 500) : (r.signal ? 'killed by ' + r.signal : 'exit ' + r.code);
      }
      run.kill = null;
      if (run.tracked) append(run);
      const ended = pub(run);
      const subs = [...run.subs];
      run.subs.clear();
      for (const s of subs) { if (s.end) { try { s.end(ended); } catch (e) {} } }
      for (const fn of endListeners) {
        try { fn(ended); } catch (e) { log('runs onEnd listener failed: ' + String((e && e.message) || e)); }
      }
      forget();
      changed();
    });
    return pub(run);
  }

  /** Tracked runs, running ones first, then newest first. */
  function list(opts) {
    const card = opts && opts.card ? String(opts.card) : '';
    const limit = opts && opts.limit > 0 ? Math.floor(opts.limit) : 30;
    const out = [...runs.values()].filter((r) => r.tracked && (!card || r.card === card));
    out.sort((a, b) => ((b.status === 'running') - (a.status === 'running'))
      || (b.startedAt < a.startedAt ? -1 : b.startedAt > a.startedAt ? 1 : 0));
    return out.slice(0, limit).map(pub);
  }

  function get(id) {
    const r = runs.get(String(id));
    return r ? pub(r) : null;
  }

  /**
   * The log from byte `from` to its current end. null for an id nobody knows.
   * -> {text, size, done}: `size` is the byte offset the text ends at, the next
   * call's `from`. done = the run has ended (nothing more will arrive).
   */
  function readLog(id, opts) {
    const key = String(id || '');
    // The id names a file: never let it be a path.
    if (!ID_RE.test(key)) return null;
    const r = runs.get(key);
    let buf;
    try { buf = fs.readFileSync(logPath(key)); }
    catch (e) { if (!r) return null; buf = Buffer.alloc(0); }
    const from = Math.max(0, Math.min(buf.length, Math.floor((opts && Number(opts.from)) || 0)));
    return { text: buf.subarray(from).toString('utf8'), size: buf.length, done: !r || r.status !== 'running' };
  }

  /**
   * Live output of a running run: fn(chunk) per piece, end(run) once it ends.
   * A run that already ended calls end at once. -> unsubscribe
   */
  function subscribe(id, fn, end) {
    const r = runs.get(String(id));
    if (!r || r.status !== 'running') {
      if (r && typeof end === 'function') { try { end(pub(r)); } catch (e) {} }
      return () => {};
    }
    const sub = (chunk) => fn(chunk);
    if (typeof end === 'function') sub.end = end;
    r.subs.add(sub);
    return () => { r.subs.delete(sub); };
  }

  /** Kill a running run's process group. -> true when there was one to cancel. */
  function cancel(id) {
    const r = runs.get(String(id));
    if (!r || r.status !== 'running' || r.canceled) return false;
    r.canceled = true;
    if (r.kill) { try { r.kill(); } catch (e) {} }
    return true;
  }

  /** fn(run) after every run ends (the server queues `activity-failed`). -> dispose */
  function onEnd(fn) {
    endListeners.add(fn);
    return () => { endListeners.delete(fn); };
  }

  return { start, list, get, readLog, subscribe, cancel, onEnd, logPath };
}

module.exports = { createRuns, ACTIVITIES_FILE, LOG_CAP, DEFAULT_TIMEOUT_MS };
