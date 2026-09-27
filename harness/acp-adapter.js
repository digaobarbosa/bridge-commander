'use strict';
// acp-adapter — the harness port over the Agent Client Protocol (ACP v1).
//
// acpAdapter(profile) -> impl, for a profile such as
//   { name: 'codex-acp', adapter: 'acp', command: 'npx', args: ['@zed-industries/codex-acp'], env: {} }
//
// The agent process never belongs to the BC server: it belongs to acp-host.js,
// a detached sidecar per stateDir that this adapter starts on demand and talks
// to over <stateDir>/acp-host.sock. A server restart therefore touches nothing
// (plugins.md, "ACP vs tmux"). What the host writes is what the adapter reads:
//   <key>.acp.jsonl       every session/update, prompt, permission ask, turn end
//   <key>.acp-state.json  capabilities, commands, usage, config options
//   <key>.turnend.jsonl   + <key>.session-id, through turnend-relay.js
//
// There is no terminal: openPane renders the event log as text frames, and
// the composer sends prompts. paneInput, adoptWindow and panePids are not
// offered.
//
// Ref: { harness: profile.name, session: 'acp-<id>', window?, cwd, resumeId: <ACP sessionId> }.

const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const { createRpc } = require('./acp-rpc.js');
const { socketPathFor, pidFileFor, logFile, stateFile, NOT_ALIVE } = require('./acp-host.js');
const s = require('./tmux-session.js');
const { makeRef } = require('./tmux-adapter.js');
const { SLASH_COMMANDS, runSlashCommand } = require('./agent-status.js');
const { keyOf, stateKey, readSessionId } = require('./util.js');

const HOST_PATH = path.join(__dirname, 'acp-host.js');
const HOST_START_MS = 10 * 1000;
const CALL_MS = 15 * 1000;
const SPAWN_CALL_MS = 5 * 60 * 1000; // initialize may wait on an npx download
const WINDOW_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;
const TAIL_BYTES = 512 * 1024;

// ---------- the host connection ----------

function hostDown(e) {
  return !!e && (e.code === 'ENOENT' || e.code === 'ECONNREFUSED' || e.hostDown === true);
}

/**
 * createHostClient(deps) -> { call(stateDir, method, params, { start?, timeoutMs? }), stop(stateDir) }
 *   deps.spawn     child_process.spawn (starts the detached host)
 *   deps.execPath  the node binary for the host
 *   deps.hostPath  acp-host.js
 *   deps.env       the host's environment
 * A call with `start` starts the host when none answers; without it a
 * missing host throws an error with hostDown: true.
 */
function createHostClient(deps = {}) {
  const spawn = deps.spawn || cp.spawn;
  const execPath = deps.execPath || process.execPath;
  const hostPath = deps.hostPath || HOST_PATH;
  const starting = new Map(); // stateDir -> Promise

  function request(sock, method, params, timeoutMs) {
    return new Promise((resolve, reject) => {
      const conn = net.connect(sock);
      let rpc = null;
      conn.once('error', (e) => { if (!rpc) reject(e); });
      conn.once('connect', () => {
        rpc = createRpc({ input: conn, output: conn });
        rpc.request(method, params, { timeoutMs }).then(resolve, reject).finally(() => conn.end());
      });
    });
  }

  async function waitForHost(stateDir, sock) {
    const deadline = Date.now() + HOST_START_MS;
    let last = null;
    while (Date.now() < deadline) {
      try { return await request(sock, 'ping', {}, 2000); } catch (e) { last = e; }
      await new Promise((r) => setTimeout(r, 100));
    }
    let tail = '';
    try { tail = fs.readFileSync(path.join(stateDir, 'acp-host.log'), 'utf8').slice(-1500); } catch { tail = ''; }
    throw new Error(`acp-host did not come up for ${stateDir}: ${last && last.message}` + (tail ? '\nhost log:\n' + tail : ''));
  }

  function startHost(stateDir) {
    if (starting.has(stateDir)) return starting.get(stateDir);
    const p = (async () => {
      fs.mkdirSync(stateDir, { recursive: true });
      const logFd = fs.openSync(path.join(stateDir, 'acp-host.log'), 'a');
      const env = { ...(deps.env || process.env) };
      delete env.TMUX;
      delete env.TMUX_PANE;
      try {
        // detached = its own session: the server's exit, SIGINT or terminal
        // hangup never reaches the host or the agents it owns.
        const child = spawn(execPath, [hostPath, stateDir], { detached: true, stdio: ['ignore', logFd, logFd], env });
        child.unref();
      } finally {
        fs.closeSync(logFd);
      }
      return waitForHost(stateDir, socketPathFor(stateDir));
    })();
    starting.set(stateDir, p);
    p.finally(() => starting.delete(stateDir)).catch(() => {});
    return p;
  }

  async function call(stateDir, method, params, opts = {}) {
    const sock = socketPathFor(stateDir);
    const timeoutMs = opts.timeoutMs || CALL_MS;
    try {
      return await request(sock, method, params, timeoutMs);
    } catch (e) {
      if (!hostDown(e)) throw e;
      if (!opts.start) { const err = new Error('acp-host is not running for ' + stateDir); err.hostDown = true; throw err; }
    }
    await startHost(stateDir);
    return request(sock, method, params, timeoutMs);
  }

  /** stop(stateDir) — shut the host down and wait for its process to go (SIGKILL as a last resort). */
  async function stop(stateDir) {
    let pid = NaN;
    try { pid = parseInt(fs.readFileSync(pidFileFor(stateDir), 'utf8'), 10); } catch { /* no host */ }
    try { await call(stateDir, 'shutdown', {}, { timeoutMs: 10000 }); } catch { /* already down */ }
    const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const deadline = Date.now() + 5000;
    while (Number.isInteger(pid) && alive() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    if (Number.isInteger(pid) && alive()) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    try { fs.unlinkSync(socketPathFor(stateDir)); } catch { /* gone */ }
    try { fs.unlinkSync(pidFileFor(stateDir)); } catch { /* gone */ }
  }

  return { call, stop };
}

// ---------- where a ref's state lives ----------
// alive, send and kill take no opts, so they are never handed a stateDir, yet
// the host socket lives in one. After a server restart the first call on a
// ref is often alive(), so an in-memory memo is not enough: spawn and resume
// also leave a pointer keyed by (state key, cwd) in a per-user registry. A
// reboot kills the host anyway, so a lost pointer reads as "not alive".
function registryDir() {
  return process.env.BC_ACP_REGISTRY || path.join(os.homedir(), '.bridge-commander', 'acp-sessions');
}
function pointerFile(ref) {
  const h = crypto.createHash('sha1').update(keyOf(ref) + '\n' + ref.cwd).digest('hex').slice(0, 24);
  return path.join(registryDir(), h + '.json');
}
function writePointer(ref, stateDir) {
  try {
    fs.mkdirSync(registryDir(), { recursive: true });
    fs.writeFileSync(pointerFile(ref), JSON.stringify({ stateDir, key: keyOf(ref), cwd: ref.cwd }) + '\n');
  } catch { /* the memo still covers this process */ }
}
function readPointer(ref) {
  try {
    const v = JSON.parse(fs.readFileSync(pointerFile(ref), 'utf8'));
    return v && v.key === keyOf(ref) && v.cwd === ref.cwd && typeof v.stateDir === 'string' ? v.stateDir : null;
  } catch { return null; }
}
function dropPointer(ref) { try { fs.unlinkSync(pointerFile(ref)); } catch { /* none */ } }

function readState(stateDir, key) {
  if (!stateDir) return null;
  try { return JSON.parse(fs.readFileSync(stateFile(stateDir, key), 'utf8')); } catch { return null; }
}

// ---------- env ----------
// A profile env value is a literal or exactly `${NAME}`, resolved from the
// server's env, then secrets.env beside the state (profiles.js rules). The
// values ride the socket to the host, never argv.
function readSecrets(file) {
  const out = {};
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
      if (m) out[m[1]] = m[2].trim();
    }
  } catch { /* no secrets file */ }
  return out;
}
function expandEnv(env, stateDir) {
  const out = {};
  const missing = [];
  let secrets = null;
  for (const [k, v] of Object.entries(env || {})) {
    const m = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(String(v));
    if (!m) { out[k] = String(v); continue; }
    if (process.env[m[1]] !== undefined) { out[k] = process.env[m[1]]; continue; }
    if (!secrets) secrets = { ...readSecrets(path.join(path.dirname(stateDir), 'secrets.env')), ...readSecrets(path.join(stateDir, 'secrets.env')) };
    if (secrets[m[1]] !== undefined) out[k] = secrets[m[1]];
    else missing.push(m[1]);
  }
  if (missing.length) throw new Error('acp profile env references unset variables: ' + missing.join(', '));
  return out;
}

// ---------- the event log as text ----------
const C = { reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m' };
const STATUS_COLOR = { completed: C.green, failed: C.red, in_progress: C.yellow, pending: C.dim };
const PLAN_MARK = { completed: '[x]', in_progress: '[~]', pending: '[ ]' };

function contentText(c) {
  if (!c || typeof c !== 'object') return '';
  if (c.type === 'text') return c.text || '';
  if (c.type === 'resource_link') return `[${c.name || c.uri}]`;
  if (c.type === 'image') return '[image]';
  return '';
}

/** renderLog(entries) -> string — the pane text for a session's event log. */
function renderLog(entries) {
  const blocks = [];
  const tools = new Map();
  let msg = null;
  let plan = null;
  const line = (t) => { msg = null; blocks.push({ t }); };
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    if (e.kind === 'prompt') { line(`${C.bold}${C.cyan}› ${C.reset}${e.text}`); continue; }
    if (e.kind === 'session') { line(`${C.dim}[session ${e.sessionId} ${e.mode}]${C.reset}`); continue; }
    if (e.kind === 'turn-end') {
      line(e.error ? `${C.red}── turn failed: ${e.error} ──${C.reset}` : `${C.dim}── turn ended (${e.stopReason}) ──${C.reset}`);
      continue;
    }
    if (e.kind === 'exit') {
      line(e.reason === 'killed' ? `${C.dim}[session closed]${C.reset}`
        : `${C.red}[agent exited${e.code !== null && e.code !== undefined ? ' code ' + e.code : ''}${e.signal ? ' ' + e.signal : ''}${e.error ? ': ' + e.error : ''}]${C.reset}`);
      continue;
    }
    if (e.kind === 'error') { line(`${C.red}! ${e.message}${C.reset}`); continue; }
    if (e.kind === 'permission') {
      const id = 'perm:' + (e.toolCallId || blocks.length);
      let b = tools.get(id);
      if (!b || e.status === 'asked') { b = { perm: {} }; tools.set(id, b); blocks.push(b); msg = null; }
      Object.assign(b.perm, e);
      continue;
    }
    if (e.kind !== 'update' || !e.update) continue;
    const u = e.update;
    const k = u.sessionUpdate;
    if (k === 'agent_message_chunk' || k === 'agent_thought_chunk' || k === 'user_message_chunk') {
      const role = k === 'agent_message_chunk' ? 'agent' : k === 'agent_thought_chunk' ? 'thought' : 'user';
      const text = contentText(u.content);
      if (msg && msg.role === role) msg.text += text;
      else { msg = { role, text }; blocks.push(msg); }
      continue;
    }
    if (k === 'tool_call' || k === 'tool_call_update') {
      let b = tools.get(u.toolCallId);
      if (!b) { b = { tool: {} }; tools.set(u.toolCallId, b); blocks.push(b); }
      for (const [f, v] of Object.entries(u)) if (v !== null && v !== undefined) b.tool[f] = v;
      msg = null;
      continue;
    }
    if (k === 'plan') {
      if (plan) blocks.splice(blocks.indexOf(plan), 1);
      plan = { plan: Array.isArray(u.entries) ? u.entries : [] };
      blocks.push(plan);
      msg = null;
      continue;
    }
    if (k === 'current_mode_update') line(`${C.dim}mode → ${u.currentModeId}${C.reset}`);
  }
  const out = [];
  for (const b of blocks) {
    if (b.t !== undefined) out.push(b.t);
    else if (b.role === 'agent') out.push(b.text);
    else if (b.role === 'thought') out.push(`${C.dim}${b.text}${C.reset}`);
    else if (b.role === 'user') out.push(`${C.bold}${C.cyan}› ${C.reset}${b.text}`);
    else if (b.tool) {
      const t = b.tool;
      const st = t.status || 'pending';
      out.push(`${STATUS_COLOR[st] || ''}⚙ ${t.title || t.name || t.toolCallId} [${st}]${C.reset}${t.kind ? ` ${C.dim}(${t.kind})${C.reset}` : ''}`);
      for (const c of Array.isArray(t.content) ? t.content : []) {
        if (c && c.type === 'diff') out.push(`    ± ${c.path}`);
      }
    } else if (b.perm) {
      const p = b.perm;
      const verdict = p.status === 'asked' ? `${C.yellow}waiting for the captain${C.reset}`
        : p.status === 'allow' ? `${C.green}allowed${C.reset}`
          : p.status === 'deny' ? `${C.red}denied${p.message ? ': ' + p.message : ''}${C.reset}`
            : p.status === 'cancelled' ? `${C.dim}cancelled${C.reset}`
              : `${C.red}no decision, rejected${C.reset}`;
      out.push(`${C.yellow}? permission${C.reset} ${p.tool_name} — ${verdict}`);
    } else if (b.plan) {
      out.push(`${C.bold}plan${C.reset}`);
      for (const pe of b.plan) out.push(`  ${PLAN_MARK[pe.status] || '[ ]'} ${pe.content}`);
    }
  }
  return out.join('\n');
}

/** readLog(file) -> entries — the tail of the log; a torn first or last line is skipped. */
function readLog(file) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return []; }
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    const out = [];
    for (const l of lines) {
      if (!l.trim()) continue;
      try { out.push(JSON.parse(l)); } catch { /* torn line */ }
    }
    return out;
  } finally {
    fs.closeSync(fd);
  }
}

function lastLines(text, n) {
  const ls = text.split('\n');
  return ls.length > n ? ls.slice(-n).join('\n') : text;
}

// ---------- the adapter ----------

/**
 * acpAdapter(profile, deps?) -> harness impl (the seven verbs plus openPane,
 * paneSnapshot, commands, runCommand, status, brief, profileInfo).
 *   profile  { name, command, args?, env?, installHint?, contextWindows?, options? }
 *   deps     { host: createHostClient(...), stateDir? } — for tests and embedders
 */
function acpAdapter(profile, deps = {}) {
  if (!profile || typeof profile.name !== 'string' || !profile.name) throw new TypeError('acp profile needs a name');
  if (typeof profile.command !== 'string' || !profile.command) throw new TypeError(`acp profile "${profile.name}" needs a command`);
  const host = deps.host || createHostClient();
  const memo = new Map(); // keyOf|cwd -> stateDir
  let modelSeen = Array.isArray(profile.options) && profile.options.includes('model');
  const callbackOf = (opts) => opts.callbackUrl || process.env.BC_TURNEND_URL || '';
  const memoKey = (ref) => keyOf(ref) + '\n' + ref.cwd;

  // stateDirOf(ref, opts?) — see "where a ref's state lives" above.
  function stateDirOf(ref, opts = {}) {
    if (opts.stateDir) return opts.stateDir;
    return memo.get(memoKey(ref)) || deps.stateDir || readPointer(ref) || process.env.BC_HARNESS_STATE || null;
  }
  function remember(ref, stateDir) {
    memo.set(memoKey(ref), stateDir);
    writePointer(ref, stateDir);
  }
  function noteModel(info) {
    if (info && Array.isArray(info.configOptions)
      && info.configOptions.some((o) => o && (o.category === 'model' || o.id === 'model'))) modelSeen = true;
  }

  function sessionName(opts) {
    if (opts.session === undefined || opts.session === null) return 'acp-' + crypto.randomBytes(3).toString('hex');
    const base = String(opts.session).replace(/^(bc|acp)-/, '');
    if (!/^[A-Za-z0-9_-]+$/.test(base)) throw new Error(`invalid session name "${opts.session}"`);
    return 'acp-' + base;
  }

  function hostParams(cwd, key, stateDir, opts, extraArgs) {
    if (opts.effort) throw new Error(`${profile.name} does not support effort`);
    const p = {
      key, harness: profile.name, command: profile.command,
      args: (profile.args || []).map(String).concat((extraArgs || []).map(String)),
      env: expandEnv(profile.env, stateDir), cwd, callbackUrl: callbackOf(opts),
    };
    if (opts.model) p.model = String(opts.model);
    return p;
  }

  /** spawn(cwd, prompt, opts?) -> ref: start the host if needed, open a session, queue the brief as its first turn. */
  async function spawn(cwd, prompt, opts = {}) {
    const window = opts.window === undefined || opts.window === null ? undefined : String(opts.window);
    if (window !== undefined && !WINDOW_RE.test(window)) {
      throw new Error(`invalid window name "${window}" (must start with a letter)`);
    }
    const session = sessionName(opts);
    const cwdAbs = path.resolve(cwd);
    if (!fs.existsSync(cwdAbs)) throw new Error(`spawn cwd does not exist: ${cwdAbs}`);
    const stateDir = s.stateDirOf(opts);
    const key = stateKey(session, window);
    const briefFile = path.join(stateDir, `${key}.prompt`);
    const params = { ...hostParams(cwdAbs, key, stateDir, opts, opts.extraArgs), mode: 'new', prompt: String(prompt || '') };
    fs.writeFileSync(briefFile, String(prompt || ''));
    s.recordSpawnArgs(stateDir, key, opts);
    let info;
    try {
      info = await host.call(stateDir, 'spawn', params, { start: true, timeoutMs: SPAWN_CALL_MS });
    } catch (e) {
      try { fs.unlinkSync(briefFile); } catch { /* best-effort */ }
      throw new Error(`${profile.name} could not start: ${e.message}`);
    }
    noteModel(info);
    const ref = makeRef(profile.name, session, window, cwdAbs, info.sessionId);
    remember(ref, stateDir);
    return ref;
  }

  /** send(ref, text) — queue a prompt; returns once the host accepted it, not when the turn ends. */
  async function send(ref, text) {
    const stateDir = stateDirOf(ref);
    const key = keyOf(ref);
    if (!stateDir) throw new Error(`session ${key} is not alive`);
    try {
      await host.call(stateDir, 'prompt', { key, text: String(text) });
    } catch (e) {
      if (hostDown(e) || e.code === NOT_ALIVE) throw new Error(`session ${key} is not alive`);
      throw e;
    }
  }

  /** alive(ref) — the host holds a live agent for this key. No host = false; a host that cannot answer throws. */
  async function alive(ref) {
    const stateDir = stateDirOf(ref);
    if (!stateDir) return false;
    try {
      const info = await host.call(stateDir, 'info', { key: keyOf(ref) });
      return !!(info && info.alive);
    } catch (e) {
      if (hostDown(e)) return false;
      throw e;
    }
  }

  function resumeIdOf(ref, stateDir) {
    return readSessionId(stateDir, keyOf(ref)) || ref.resumeId || undefined;
  }

  /** resumable(ref, opts?) — an id is known AND the agent advertised session/resume or session/load. */
  async function resumable(ref, opts = {}) {
    const stateDir = stateDirOf(ref, opts);
    if (!stateDir || !resumeIdOf(ref, stateDir)) return false;
    const st = readState(stateDir, keyOf(ref));
    return !!(st && st.caps && (st.caps.resume || st.caps.loadSession));
  }

  /** resume(ref, opts?) — a live session comes back as is; a dead one is reopened, with memory when the agent can. */
  async function resume(ref, opts = {}) {
    const stateDir = s.stateDirOf({ ...opts, stateDir: stateDirOf(ref, opts) || undefined });
    const key = keyOf(ref);
    const rec = s.recordedSpawnArgs(stateDir, key);
    const params = { ...hostParams(ref.cwd, key, stateDir, opts, opts.extraArgs || rec.args), mode: 'resume' };
    const id = resumeIdOf(ref, stateDir);
    if (id) params.resumeId = id;
    let info;
    try {
      info = await host.call(stateDir, 'spawn', params, { start: true, timeoutMs: SPAWN_CALL_MS });
    } catch (e) {
      throw new Error(`${profile.name} could not resume ${key}: ${e.message}`);
    }
    noteModel(info);
    const back = makeRef(profile.name, ref.session, ref.window, ref.cwd, info.sessionId);
    remember(back, stateDir);
    return back;
  }

  /** kill(ref) — session/close when advertised, then end the agent process. Idempotent; state files stay. */
  async function kill(ref) {
    const stateDir = stateDirOf(ref);
    if (!stateDir) return;
    try {
      await host.call(stateDir, 'kill', { key: keyOf(ref) });
    } catch (e) {
      if (!hostDown(e)) throw e;
    }
    dropPointer(ref);
    memo.delete(memoKey(ref));
  }

  /** onTurnEnd(ref, hook, opts?) — the shared tail of <key>.turnend.jsonl, which the host appends to. */
  function onTurnEnd(ref, hook, opts = {}) {
    const stateDir = stateDirOf(ref, opts);
    return s.onTurnEnd(ref, hook, stateDir ? { ...opts, stateDir } : opts);
  }

  function brief(ref, opts = {}) {
    const stateDir = stateDirOf(ref, opts);
    if (!stateDir) return null;
    const file = path.join(stateDir, `${keyOf(ref)}.prompt`);
    return fs.existsSync(file) ? file : null;
  }

  function advertised(ref, opts) {
    if (!ref) return [];
    const st = readState(stateDirOf(ref, opts), keyOf(ref));
    return st && Array.isArray(st.commands) ? st.commands.filter((c) => c && typeof c.name === 'string' && c.name) : [];
  }

  /** commands(ref?) — /status and /help, then what the agent advertised (available_commands_update). */
  function commands(ref, opts = {}) {
    const base = SLASH_COMMANDS.filter((c) => c.name !== '/compact').map((c) => ({ ...c }));
    const seen = new Set(base.map((c) => c.name));
    for (const c of advertised(ref, opts)) {
      const name = '/' + c.name.replace(/^\//, '');
      if (seen.has(name)) continue;
      seen.add(name);
      base.push({ name, description: c.description || (c.input && c.input.hint) || '' });
    }
    return base;
  }

  /** status(ref, opts?) -> { model?, contextUsed, contextWindow } | null — from the last usage_update. */
  async function status(ref, opts = {}) {
    const st = readState(stateDirOf(ref, opts), keyOf(ref));
    if (!st || !st.usage || !Number.isFinite(st.usage.used) || !Number.isFinite(st.usage.size)) return null;
    const out = { contextUsed: st.usage.used, contextWindow: st.usage.size };
    const m = (st.configOptions || []).find((o) => o && (o.category === 'model' || o.id === 'model'));
    if (m && typeof m.currentValue === 'string' && m.currentValue) out.model = m.currentValue;
    return out;
  }

  /** runCommand(ref, line, opts?) — /help and /status here; an advertised command is sent as a prompt. */
  function runCommand(ref, line, opts = {}) {
    return runSlashCommand(ref, line, opts, {
      key: keyOf(ref),
      commands: (r) => commands(r, opts), status, send,
      handlers: {},
      passthrough: advertised(ref, opts).map((c) => '/' + c.name.replace(/^\//, '')),
      noStatusHint: 'the agent has not reported usage yet',
    });
  }

  /** openPane(ref, { onFrame, intervalMs?, lines? }) -> { close() } — the event log, re-rendered when it grows. */
  function openPane(ref, opts = {}) {
    const onFrame = typeof opts.onFrame === 'function' ? opts.onFrame : () => {};
    const intervalMs = opts.intervalMs > 0 ? opts.intervalMs : 1000;
    const lines = opts.lines > 0 ? opts.lines : 200;
    const stateDir = stateDirOf(ref, opts);
    const file = stateDir ? logFile(stateDir, keyOf(ref)) : null;
    let lastSize = -1;
    let lastFrame = null;
    let closed = false;
    let timer = null;
    function tick() {
      if (closed || !file) return;
      let size = 0;
      try { size = fs.statSync(file).size; } catch { size = 0; }
      if (size !== lastSize) {
        lastSize = size;
        const frame = lastLines(renderLog(readLog(file)), lines);
        if (frame !== lastFrame) {
          lastFrame = frame;
          try { onFrame(frame); } catch { /* a throwing subscriber must not kill the feed */ }
        }
      }
      timer = setTimeout(tick, intervalMs);
      timer.unref && timer.unref();
    }
    tick();
    return { close() { closed = true; clearTimeout(timer); } };
  }

  async function paneSnapshot(ref, opts = {}) {
    const stateDir = stateDirOf(ref, opts);
    if (!stateDir) return '';
    return lastLines(renderLog(readLog(logFile(stateDir, keyOf(ref)))), opts.lines > 0 ? opts.lines : 200);
  }

  /** profileInfo() — typed options: 'model' once the agent showed a model config option. */
  function profileInfo() {
    return {
      name: profile.name, adapter: 'acp', options: modelSeen ? ['model'] : [], permissionModes: [],
      requirements: { bins: [profile.command], tmux: false, rootBypass: false },
      installHint: profile.installHint || '', contextWindows: profile.contextWindows || [],
    };
  }

  return {
    spawn, send, alive, resumable, resume, kill, onTurnEnd,
    openPane, paneSnapshot, commands, runCommand, status, brief, profileInfo,
  };
}

module.exports = { acpAdapter, createHostClient, renderLog, readLog, expandEnv, stopHost: (stateDir) => createHostClient().stop(stateDir) };
