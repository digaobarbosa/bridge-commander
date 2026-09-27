#!/usr/bin/env node
'use strict';
// acp-host — the long-lived sidecar that owns ACP agent processes, one host
// per stateDir.
//
// Why a sidecar: an ACP agent is a stdio child, and a stdio child dies with
// its parent. BC restarts often and a restart must be a non-event, so the
// agents belong to this detached process instead of the server. The adapter
// (acp-adapter.js) starts it on demand and talks to it over a unix socket at
// <stateDir>/acp-host.sock, in the same newline-delimited JSON-RPC the agents
// speak (acp-rpc.js).
//
// Per session (keyed by the BC state key) the host:
//   - spawns `command args` with env and cwd, then initialize + session/new
//     (or session/resume / session/load when the agent advertised them);
//   - serializes prompts: one session/prompt in flight, the rest queued;
//   - appends every session/update to <stateDir>/<key>.acp.jsonl, the log the
//     adapter renders as a read-only pane;
//   - keeps <key>.acp-state.json (capabilities, commands, usage, config
//     options) so the adapter's synchronous verbs never need the socket;
//   - on each stopReason records and POSTs a TurnEndEvent (turnend-relay.js);
//   - relays session/request_permission to <origin>/api/permission with the
//     body permission-hook.js sends, and maps allow/deny onto the agent's
//     allow_once/reject_once option.
//
// Socket methods: ping, spawn, prompt, cancel, kill, info, shutdown.
//
// Usage: node acp-host.js <stateDir>

const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const { createRpc, RpcError, ERR } = require('./acp-rpc.js');
const relay = require('./turnend-relay.js');

const PROTOCOL_VERSION = 1;
const INIT_TIMEOUT_MS = Number(process.env.BC_ACP_INIT_TIMEOUT_MS) || 120 * 1000; // npx may download first
const SETUP_TIMEOUT_MS = Number(process.env.BC_ACP_SETUP_TIMEOUT_MS) || 60 * 1000;
const CLOSE_TIMEOUT_MS = 3000;
const KILL_GRACE_MS = 2000;
// Just under permission-hook's own wait, so both relays give up alike.
const PERMISSION_WAIT_MS = 3550 * 1000;
// A BC restart drops the held /api/permission request; the ask is re-posted
// until the server is back, instead of denying behind the captain's back.
const PERMISSION_RETRY_MS = 10 * 60 * 1000;
const STDERR_KEEP = 4096;
const STDERR_LOG_MAX = 1024 * 1024;
const NOT_ALIVE = -32001; // host-level: the session is gone or was never here

// A unix socket path is capped (104 bytes on macOS, 108 on Linux). A deep
// workspace would overflow it, so a long stateDir gets a hashed name in the
// temp dir instead — still one per stateDir.
function socketPathFor(stateDir) {
  const p = path.join(stateDir, 'acp-host.sock');
  if (Buffer.byteLength(p) <= 100) return p;
  const h = crypto.createHash('sha1').update(path.resolve(stateDir)).digest('hex').slice(0, 16);
  return path.join(os.tmpdir(), `bc-acp-${h}.sock`);
}
const pidFileFor = (stateDir) => path.join(stateDir, 'acp-host.pid');
const logFile = (stateDir, key) => path.join(stateDir, `${key}.acp.jsonl`);
const stateFile = (stateDir, key) => path.join(stateDir, `${key}.acp-state.json`);

/** permissionUrl(callbackUrl) -> '<origin>/api/permission' | null. */
function permissionUrl(callbackUrl) {
  if (!callbackUrl) return null;
  try { return new URL(callbackUrl).origin + '/api/permission'; } catch { return null; }
}

/** pickOption(options, decision) -> optionId | null — allow → allow_once first, deny/none → reject_once first. */
function pickOption(options, decision) {
  const kinds = decision === 'allow' ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always'];
  for (const k of kinds) {
    const o = (options || []).find((x) => x && x.kind === k);
    if (o) return o.optionId;
  }
  return null;
}

/**
 * postPermission(url, body, { signal }) -> { reply } | { unreachable: true }.
 * Not fetch: undici drops a response whose headers take over 300s, and the
 * captain may take longer (the same reason permission-hook.js uses http).
 * `unreachable` is a connection failure (retryable); a non-2xx or a body that
 * is not JSON is `{ reply: null }` — the server said no decision.
 */
function postPermission(url, body, { signal } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    try {
      const data = JSON.stringify(body);
      const mod = url.startsWith('https:') ? https : http;
      const req = mod.request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
        signal,
      }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) return done({ reply: null });
          try { done({ reply: JSON.parse(text) }); } catch { done({ reply: null }); }
        });
        // headers arrived: a drop now is the server going away mid-hold
        res.on('error', () => done({ unreachable: true }));
        res.on('aborted', () => done({ unreachable: true }));
      });
      req.setTimeout(PERMISSION_WAIT_MS, () => req.destroy());
      req.on('error', () => done({ unreachable: true }));
      req.end(data);
    } catch {
      done({ unreachable: true });
    }
  });
}

// signalTree(child, sig) — the child's whole process group, else the child.
function signalTree(child, sig) {
  if (!child || !child.pid) return;
  try { process.kill(-child.pid, sig); return; } catch { /* no group (or already gone) */ }
  try { child.kill(sig); } catch { /* gone */ }
}

function toolInputOf(raw, tc) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (raw !== undefined && raw !== null) return { input: raw };
  return tc && tc.title ? { title: tc.title } : {};
}

/**
 * createHost(deps) -> host
 *   stateDir                     required
 *   spawn(cmd, args, opts)       child_process.spawn
 *   postPermission(url, body, {signal})   see above
 *   postTurnEnd(url, event)      turnend-relay post
 *   log(msg), now() -> ISO, sleep(ms)
 *   baseEnv                      the env every agent starts from
 *   idleExitMs, exit()           exit after this long with no session and no client (0 = never)
 *   permissionRetryMs
 */
function createHost(deps) {
  const stateDir = deps.stateDir;
  if (!stateDir) throw new TypeError('acp-host needs a stateDir');
  const spawn = deps.spawn || cp.spawn;
  const post = deps.postPermission || postPermission;
  const postTurnEnd = deps.postTurnEnd || relay.post;
  const log = deps.log || (() => {});
  const now = deps.now || (() => new Date().toISOString());
  const sleep = deps.sleep || ((ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref && t.unref(); }));
  const baseEnv = deps.baseEnv || process.env;
  const retryMs = deps.permissionRetryMs !== undefined ? deps.permissionRetryMs : PERMISSION_RETRY_MS;
  const version = deps.version || '1';
  fs.mkdirSync(stateDir, { recursive: true });

  const sessions = new Map(); // key -> session record
  let server = null;
  let clients = 0;
  let idleSince = Date.now();
  let idleTimer = null;

  function append(key, entry) {
    try { fs.appendFileSync(logFile(stateDir, key), JSON.stringify({ ts: now(), ...entry }) + '\n'); } catch (e) {
      log(`append ${key}: ${e.message}`);
    }
  }

  function saveState(s) {
    const st = {
      harness: s.harness, key: s.key, sessionId: s.sessionId || null, cwd: s.cwd, alive: s.alive,
      pid: s.child ? s.child.pid : null, caps: s.caps, commands: s.commands, usage: s.usage,
      configOptions: s.configOptions, mode: s.mode, busy: s.busy, queued: s.queue.length, updatedAt: now(),
    };
    const file = stateFile(stateDir, s.key);
    try {
      const tmp = file + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(st) + '\n');
      fs.renameSync(tmp, file);
    } catch (e) { log(`state ${s.key}: ${e.message}`); }
  }

  function stderrLog(s, chunk) {
    s.stderrTail = (s.stderrTail + chunk).slice(-STDERR_KEEP);
    const f = path.join(stateDir, `${s.key}.acp.stderr.log`);
    try {
      let size = 0;
      try { size = fs.statSync(f).size; } catch { size = 0; }
      if (size < STDERR_LOG_MAX) fs.appendFileSync(f, chunk);
    } catch { /* diagnostics only */ }
  }

  // ---------- agent → client ----------
  function onUpdate(s, params) {
    const u = params && params.update;
    if (!u || typeof u !== 'object') return;
    const kind = u.sessionUpdate;
    if (kind === 'tool_call' || kind === 'tool_call_update') {
      s.tools.set(u.toolCallId, { ...(s.tools.get(u.toolCallId) || {}), ...u });
    }
    let stateChanged = false;
    if (kind === 'available_commands_update') { s.commands = Array.isArray(u.availableCommands) ? u.availableCommands : []; stateChanged = true; }
    if (kind === 'usage_update') { s.usage = { used: u.used, size: u.size, ...(u.cost ? { cost: u.cost } : {}) }; stateChanged = true; }
    if (kind === 'config_option_update' && Array.isArray(u.configOptions)) { s.configOptions = u.configOptions; stateChanged = true; }
    if (kind === 'current_mode_update') { s.mode = u.currentModeId || null; stateChanged = true; }
    if (stateChanged) saveState(s);
    // A session/load replays history the log already holds; appending it again
    // would double the pane on every resume.
    if (s.replaying) return;
    if (kind === 'agent_message_chunk' && u.content && u.content.type === 'text') s.turnText += u.content.text || '';
    append(s.key, { kind: 'update', update: u });
  }

  async function askPermission(s, params) {
    const p = params || {};
    const asked = p.toolCall || {};
    const tc = { ...(s.tools.get(asked.toolCallId) || {}), ...asked };
    const toolName = String(tc.title || tc.name || tc.kind || 'tool');
    const toolInput = toolInputOf(tc.rawInput, tc);
    const body = {
      ts: now(), session: s.key, session_id: s.sessionId || null, cwd: s.cwd, tmux_session: '',
      tool_name: toolName, tool_input: toolInput, permission_mode: null,
    };
    append(s.key, { kind: 'permission', status: 'asked', toolCallId: tc.toolCallId || null, tool_name: toolName,
      tool_input: toolInput, options: p.options || [] });
    const ac = new AbortController();
    s.asks.add(ac);
    let reply = null;
    try {
      const url = permissionUrl(s.callbackUrl);
      const started = Date.now();
      while (url && !ac.signal.aborted) {
        const r = await post(url, body, { signal: ac.signal });
        if (!r.unreachable) { reply = r.reply; break; }
        if (Date.now() - started >= retryMs) break;
        await sleep(2000);
      }
    } finally {
      s.asks.delete(ac);
    }
    if (ac.signal.aborted) {
      append(s.key, { kind: 'permission', status: 'cancelled', toolCallId: tc.toolCallId || null, tool_name: toolName });
      return { outcome: { outcome: 'cancelled' } };
    }
    const decision = reply && (reply.decision === 'allow' || reply.decision === 'deny') ? reply.decision : null;
    // No decision (no server, a cap, a bad body) rejects: there is no terminal
    // dialog to fall back to, and a broken relay must never approve.
    const optionId = pickOption(p.options, decision);
    append(s.key, { kind: 'permission', status: decision || 'no-decision', toolCallId: tc.toolCallId || null,
      tool_name: toolName, optionId, ...(reply && reply.message ? { message: String(reply.message) } : {}) });
    if (!optionId) return { outcome: { outcome: 'cancelled' } };
    return { outcome: { outcome: 'selected', optionId } };
  }

  function onAgentRequest(s, method, params) {
    if (method === 'session/request_permission') return askPermission(s, params);
    // fs/* and terminal/* are not advertised in clientCapabilities.
    throw new RpcError(ERR.METHOD_NOT_FOUND, 'method not found: ' + method);
  }

  // ---------- turns ----------
  function turnEnd(s, stopReason, errText) {
    append(s.key, { kind: 'turn-end', stopReason, ...(errText ? { error: errText } : {}) });
    const event = {
      ts: now(), session: s.key, harness: s.harness, event: 'turn-end', session_id: s.sessionId || null,
      cwd: s.cwd, tmux_session: '', stop_reason: stopReason,
    };
    const said = (errText ? 'error: ' + errText : s.turnText).trim();
    if (said) event.text = said.slice(0, relay.TEXT_MAX);
    relay.record(stateDir, s.key, event);
    return Promise.resolve(postTurnEnd(s.callbackUrl, event)).catch(() => {});
  }

  function pump(s) {
    if (s.busy || !s.alive || !s.queue.length) return;
    const text = s.queue.shift();
    s.busy = true;
    s.turnText = '';
    append(s.key, { kind: 'prompt', text });
    saveState(s);
    s.rpc.request('session/prompt', { sessionId: s.sessionId, prompt: [{ type: 'text', text }] })
      .then((r) => turnEnd(s, (r && r.stopReason) || 'end_turn'))
      .catch(async (e) => {
        // A dead child is not a turn end: supervision reads alive() instead.
        // stdout closes before 'exit' fires, so a closed connection is death
        // even while the process lingers — and one that lingers is ended.
        if (!s.rpc.closed) return turnEnd(s, 'error', e.message);
        await Promise.race([s.exited, sleep(1000)]);
        if (s.alive) signalTree(s.child, 'SIGKILL');
        return undefined;
      })
      .finally(() => {
        s.busy = false;
        saveState(s);
        pump(s);
      });
  }

  // ---------- lifecycle ----------
  function startChild(s, command, args, env) {
    // Its own process group, so a kill reaches the whole tree: `npx <agent>`
    // does not forward SIGTERM, and the real agent was left orphaned under it.
    const child = spawn(command, args, {
      cwd: s.cwd, env: { ...baseEnv, ...env }, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32',
    });
    s.child = child;
    s.exited = new Promise((resolve) => {
      let fired = false;
      const onExit = (code, signal, err) => {
        if (fired) return;
        fired = true;
        s.alive = false;
        s.exitInfo = { code, signal, error: err };
        for (const ac of s.asks) ac.abort();
        s.queue = [];
        append(s.key, { kind: 'exit', code: code === undefined ? null : code, signal: signal || null,
          ...(s.closing ? { reason: 'killed' } : {}), ...(err ? { error: err } : {}) });
        if (s.rpc) s.rpc.close();
        saveState(s);
        resolve();
      };
      child.on('exit', (code, signal) => onExit(code, signal));
      child.on('error', (e) => onExit(null, null, e.message));
    });
    child.stderr && child.stderr.setEncoding('utf8');
    child.stderr && child.stderr.on('data', (c) => stderrLog(s, c));
    child.stdin && child.stdin.on('error', () => { /* the child went away; exit handles it */ });
    s.rpc = createRpc({
      input: child.stdout, output: child.stdin, log: (m) => log(`${s.key}: ${m}`),
      onRequest: (m, p) => onAgentRequest(s, m, p),
      onNotification: (m, p) => { if (m === 'session/update') onUpdate(s, p); },
    });
    s.alive = true;
  }

  // A request that, when the child dies under it, fails with why it died and
  // its stderr — "connection closed" alone diagnoses nothing.
  async function call(s, method, params, timeoutMs) {
    try {
      return await s.rpc.request(method, params, { timeoutMs });
    } catch (e) {
      if (!s.rpc.closed) throw e;
      await Promise.race([s.exited, sleep(1000)]);
      const x = s.exitInfo || {};
      const why = x.error || (x.signal ? 'signal ' + x.signal : x.code !== undefined && x.code !== null ? 'code ' + x.code : 'closed its stdout');
      const tail = s.stderrTail.trim();
      throw new Error(`agent exited during ${method} (${why})` + (tail ? '; stderr:\n' + tail.slice(-1000) : ''));
    }
  }

  function publicInfo(s) {
    return {
      key: s.key, alive: s.alive, sessionId: s.sessionId || null, caps: s.caps, busy: s.busy, queued: s.queue.length,
      configOptions: s.configOptions || null, restored: !!s.restored, pid: s.child ? s.child.pid : null,
    };
  }

  function modelOption(options) {
    return (options || []).find((o) => o && o.type !== 'boolean' && (o.category === 'model' || o.id === 'model')) || null;
  }

  /**
   * spawn({ key, harness, command, args, env, cwd, prompt?, callbackUrl?, mode: 'new'|'resume', resumeId?, model? })
   * -> info. Resume restores memory when the agent can (session/resume, then
   * session/load); otherwise it starts a new session and says restored: false.
   */
  async function spawnSession(p) {
    if (!p || !p.key || !p.command || !p.cwd) throw new RpcError(ERR.INVALID_PARAMS, 'spawn needs key, command and cwd');
    const existing = sessions.get(p.key);
    if (existing && existing.alive) {
      if (p.mode === 'resume') {
        if (p.callbackUrl) existing.callbackUrl = p.callbackUrl;
        return publicInfo(existing);
      }
      throw new RpcError(ERR.INVALID_REQUEST, `acp session ${p.key} already exists`);
    }
    if (existing) sessions.delete(p.key);
    const s = {
      key: p.key, harness: p.harness || 'acp', cwd: p.cwd, callbackUrl: p.callbackUrl || '',
      child: null, rpc: null, exited: null, alive: false, closing: false, sessionId: null,
      caps: { loadSession: false, resume: false, close: false }, commands: [], usage: null, configOptions: null,
      mode: null, queue: [], busy: false, turnText: '', tools: new Map(), asks: new Set(), stderrTail: '',
      replaying: false, restored: false,
    };
    sessions.set(p.key, s);
    touch();
    try {
      startChild(s, p.command, (p.args || []).map(String), p.env || {});
      const init = await call(s, 'initialize', {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: 'bridge-commander', title: 'Bridge Commander', version },
      }, INIT_TIMEOUT_MS);
      if (!init || init.protocolVersion !== PROTOCOL_VERSION) {
        throw new Error(`agent speaks ACP protocol ${init && init.protocolVersion}, this host speaks ${PROTOCOL_VERSION}`);
      }
      const ac = init.agentCapabilities || {};
      const sc = ac.sessionCapabilities || {};
      s.caps = { loadSession: !!ac.loadSession, resume: !!sc.resume, close: !!sc.close };
      const setup = { cwd: p.cwd, mcpServers: [] };
      let res = null;
      if (p.mode === 'resume' && p.resumeId && (s.caps.resume || s.caps.loadSession)) {
        const method = s.caps.resume ? 'session/resume' : 'session/load';
        s.replaying = method === 'session/load';
        try {
          res = (await call(s, method, { sessionId: p.resumeId, ...setup }, SETUP_TIMEOUT_MS)) || {};
          s.sessionId = p.resumeId;
          s.restored = true;
        } catch (e) {
          if (!s.alive) throw e;
          // The agent forgot the session: fresh, and the caller hears restored: false.
          append(s.key, { kind: 'error', message: `${method} ${p.resumeId} failed: ${e.message}; starting fresh` });
        } finally {
          s.replaying = false;
        }
      }
      if (!s.sessionId) {
        try {
          res = await call(s, 'session/new', setup, SETUP_TIMEOUT_MS);
        } catch (e) {
          if (e.code === ERR.AUTH_REQUIRED) {
            const methods = (init.authMethods || []).map((m) => m.name || m.id).join(', ');
            throw new Error('agent requires authentication; log in with the agent\'s own CLI first'
              + (methods ? ' (methods: ' + methods + ')' : ''));
          }
          throw e;
        }
        if (!res || typeof res.sessionId !== 'string' || !res.sessionId) throw new Error('session/new returned no sessionId');
        s.sessionId = res.sessionId;
      }
      if (res && Array.isArray(res.configOptions)) s.configOptions = res.configOptions;
      if (p.model) {
        const opt = modelOption(s.configOptions);
        if (!opt) throw new Error(`agent ${s.harness} exposes no model option; cannot pin model ${p.model}`);
        const r = await call(s, 'session/set_config_option', { sessionId: s.sessionId, configId: opt.id, value: String(p.model) }, SETUP_TIMEOUT_MS);
        if (r && Array.isArray(r.configOptions)) s.configOptions = r.configOptions;
      }
      append(s.key, { kind: 'session', sessionId: s.sessionId, mode: p.mode === 'resume' ? (s.restored ? 'restored' : 'fresh') : 'new' });
      saveState(s);
      if (typeof p.prompt === 'string' && p.prompt) {
        s.queue.push(p.prompt);
        pump(s);
      }
      return publicInfo(s);
    } catch (e) {
      await stop(s);
      sessions.delete(p.key);
      throw e instanceof RpcError ? e : new RpcError(ERR.INTERNAL, e.message);
    }
  }

  function liveSession(key) {
    const s = sessions.get(key);
    if (!s || !s.alive) throw new RpcError(NOT_ALIVE, `session ${key} is not alive`);
    return s;
  }

  function prompt(p) {
    const s = liveSession(p && p.key);
    if (typeof p.text !== 'string' || !p.text) throw new RpcError(ERR.INVALID_PARAMS, 'prompt needs text');
    s.queue.push(p.text);
    pump(s);
    return { accepted: true, busy: s.busy, queued: s.queue.length };
  }

  function cancel(p) {
    const s = liveSession(p && p.key);
    for (const ac of s.asks) ac.abort();
    s.rpc.notify('session/cancel', { sessionId: s.sessionId });
    return { ok: true };
  }

  // stop(s) — close the session when the agent can, then end the child: stdin
  // EOF first, SIGTERM, then SIGKILL after a grace period.
  async function stop(s) {
    s.closing = true;
    s.queue = [];
    for (const ac of s.asks) ac.abort();
    if (!s.child) return;
    if (s.alive && s.sessionId) {
      if (s.caps.close) {
        await call(s, 'session/close', { sessionId: s.sessionId }, CLOSE_TIMEOUT_MS).catch(() => {});
      } else if (s.busy) s.rpc.notify('session/cancel', { sessionId: s.sessionId });
    }
    if (s.alive) {
      try { s.child.stdin && s.child.stdin.end(); } catch { /* gone */ }
      signalTree(s.child, 'SIGTERM');
      const t = setTimeout(() => signalTree(s.child, 'SIGKILL'), KILL_GRACE_MS);
      t.unref && t.unref();
      await Promise.race([s.exited, sleep(KILL_GRACE_MS + 1000)]);
      clearTimeout(t);
    }
    // The wrapper may be gone while the agent it launched lingers in the group.
    signalTree(s.child, 'SIGKILL');
  }

  async function kill(p) {
    const s = sessions.get(p && p.key);
    if (!s) return { ok: true, existed: false };
    await stop(s);
    sessions.delete(s.key);
    touch();
    return { ok: true, existed: true };
  }

  function info(p) {
    const s = sessions.get(p && p.key);
    return s ? publicInfo(s) : { key: p && p.key, alive: false };
  }

  async function shutdown() {
    await Promise.all([...sessions.values()].map((s) => stop(s)));
    sessions.clear();
    setImmediate(() => close().then(() => (deps.exit || (() => {}))(0)));
    return { ok: true };
  }

  async function handle(method, params) {
    switch (method) {
      case 'ping': return { pid: process.pid, version, sessions: [...sessions.keys()] };
      case 'spawn': return spawnSession(params);
      case 'prompt': return prompt(params);
      case 'cancel': return cancel(params);
      case 'kill': return kill(params);
      case 'info': return info(params);
      case 'shutdown': return shutdown();
      default: throw new RpcError(ERR.METHOD_NOT_FOUND, 'unknown host method ' + method);
    }
  }

  // ---------- idle exit ----------
  function touch() { idleSince = Date.now(); }
  function checkIdle() {
    const live = [...sessions.values()].some((s) => s.alive);
    if (live || clients > 0) { touch(); return; }
    if (Date.now() - idleSince >= deps.idleExitMs) {
      log('idle: no sessions and no clients, exiting');
      close().then(() => (deps.exit || (() => {}))(0));
    }
  }

  function listen(sockPath) {
    return new Promise((resolve, reject) => {
      server = net.createServer((conn) => {
        clients++;
        touch();
        conn.on('close', () => { clients--; touch(); });
        conn.on('error', () => { /* a client hung up */ });
        createRpc({ input: conn, output: conn, onRequest: handle, log });
      });
      server.once('error', reject);
      server.listen(sockPath, () => {
        server.off('error', reject);
        if (deps.idleExitMs > 0) {
          idleTimer = setInterval(checkIdle, Math.min(deps.idleExitMs, 30 * 1000));
          idleTimer.unref && idleTimer.unref();
        }
        resolve(sockPath);
      });
    });
  }

  function close() {
    clearInterval(idleTimer);
    return new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()));
  }

  return { handle, listen, close, sessions, stop };
}

// ---------- entry point ----------
function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// claimPidFile(stateDir) -> true when this process is THE host. Exclusive
// create, so two adapters racing to start a host end with one.
function claimPidFile(stateDir) {
  const file = pidFileFor(stateDir);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    let pid = NaN;
    try { pid = parseInt(fs.readFileSync(file, 'utf8'), 10); } catch { /* vanished */ }
    if (Number.isNaN(pid)) {
      // the winner may not have written its pid yet
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
      try { pid = parseInt(fs.readFileSync(file, 'utf8'), 10); } catch { /* vanished */ }
    }
    if (processAlive(pid) && pid !== process.pid) return false;
    try { fs.unlinkSync(file); } catch { /* raced */ }
  }
  return false;
}

async function main() {
  const stateDir = process.argv[2];
  if (!stateDir) { process.stderr.write('usage: acp-host.js <stateDir>\n'); process.exit(2); }
  // The host outlives the pane it was started from; a TMUX variable would
  // attribute its agents to someone else's tmux session.
  delete process.env.TMUX;
  delete process.env.TMUX_PANE;
  fs.mkdirSync(stateDir, { recursive: true });
  const log = (m) => { try { process.stderr.write(new Date().toISOString() + ' ' + m + '\n'); } catch { /* no log */ } };
  if (!claimPidFile(stateDir)) { log('another acp-host owns ' + stateDir); process.exit(0); }
  const sock = socketPathFor(stateDir);
  try { fs.unlinkSync(sock); } catch { /* none */ }
  const idleEnv = process.env.BC_ACP_HOST_IDLE_MS;
  const cleanup = () => {
    try { fs.unlinkSync(sock); } catch { /* gone */ }
    try { if (parseInt(fs.readFileSync(pidFileFor(stateDir), 'utf8'), 10) === process.pid) fs.unlinkSync(pidFileFor(stateDir)); } catch { /* gone */ }
  };
  let host = null;
  const exit = (code) => { cleanup(); process.exit(code); };
  host = createHost({
    stateDir, log, exit,
    idleExitMs: idleEnv !== undefined ? Number(idleEnv) : 30 * 60 * 1000,
  });
  // The host is the agents' lifeline: a bug in one session must not take
  // every other session down with it.
  process.on('uncaughtException', (e) => log('uncaught: ' + (e && e.stack || e)));
  process.on('unhandledRejection', (e) => log('unhandled: ' + (e && e.stack || e)));
  const onSignal = () => {
    Promise.all([...host.sessions.values()].map((s) => host.stop(s))).finally(() => exit(0));
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  process.on('SIGHUP', () => { /* detached: a closing terminal is not our signal */ });
  await host.listen(sock);
  log(`acp-host ${process.pid} listening on ${sock}`);
}

if (require.main === module) {
  main().catch((e) => { process.stderr.write('acp-host: ' + (e && e.stack || e) + '\n'); process.exit(1); });
}

module.exports = { createHost, socketPathFor, pidFileFor, permissionUrl, pickOption, postPermission, NOT_ALIVE,
  logFile, stateFile };
