#!/usr/bin/env node
'use strict';
// fake-acp-agent — a scriptable ACP v1 agent over stdio, for the acp tests.
//
// Capabilities come from env; what a turn does comes from the prompt text, so
// one agent process can play every scenario a test needs in sequence.
//
// env:
//   FAKE_ACP_DIR      where sessions persist (<id>.json) and every call is
//                     logged (calls.jsonl) — required
//   FAKE_ACP_LOAD=1   advertise loadSession (session/load replays history)
//   FAKE_ACP_RESUME=1 advertise sessionCapabilities.resume
//   FAKE_ACP_CLOSE=1  advertise sessionCapabilities.close
//   FAKE_ACP_MODEL=1  expose a `model` select config option
//   FAKE_ACP_EFFORT=1 expose an `effort` select option of category thought_level
//   FAKE_ACP_AUTH=1   refuse session/new with auth_required
//
// prompt text:
//   CRASH             exit(3) at once, mid-turn
//   HANG              never finish until session/cancel
//   SLOW <ms>         finish after ms
//   PERMISSION        a tool call that asks session/request_permission first
//   RECALL            reply with every earlier prompt of the session
//   PLAN              emit a plan
//   anything else     reply "echo: <text>" in two chunks

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRpc, RpcError, ERR } = require('../acp-rpc.js');

const DIR = process.env.FAKE_ACP_DIR || path.join(require('node:os').tmpdir(), 'fake-acp');
fs.mkdirSync(DIR, { recursive: true });
const on = (k) => process.env[k] === '1';

function logCall(method, params) {
  fs.appendFileSync(path.join(DIR, 'calls.jsonl'), JSON.stringify({ pid: process.pid, method, params }) + '\n');
}
const file = (id) => path.join(DIR, id.replace(/[^A-Za-z0-9_-]/g, '_') + '.json');
function load(id) {
  try { return JSON.parse(fs.readFileSync(file(id), 'utf8')); } catch { return null; }
}
// The running turn is process state, never persisted.
function save(s) { fs.writeFileSync(file(s.id), JSON.stringify({ ...s, turn: undefined })); }

const sessions = new Map(); // id -> { id, cwd, history: [{role, text}], model, turn? }

const SELECTS = {
  model: { env: 'FAKE_ACP_MODEL', category: 'model', values: ['fake-small', 'fake-large'] },
  effort: { env: 'FAKE_ACP_EFFORT', category: 'thought_level', values: ['low', 'high'] },
};

function configOptions(s) {
  const out = Object.entries(SELECTS).filter(([, c]) => on(c.env)).map(([id, c]) => ({
    id, name: id, category: c.category, type: 'select', currentValue: s[id] || c.values[0],
    options: c.values.map((value) => ({ value, name: value })),
  }));
  return out.length ? out : undefined;
}

const rpc = createRpc({
  input: process.stdin,
  output: process.stdout,
  onRequest: handle,
  onNotification(method, params) {
    logCall(method, params);
    if (method === 'session/cancel') {
      const s = sessions.get(params && params.sessionId);
      if (s && s.turn) s.turn.cancel();
    }
  },
  onClose() { process.exit(0); },
});

function update(sessionId, u) { rpc.notify('session/update', { sessionId, update: u }); }
function say(sessionId, text) { update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }); }

function sessionOf(params) {
  const s = sessions.get(params && params.sessionId);
  if (!s) throw new RpcError(ERR.INVALID_PARAMS, 'unknown session ' + (params && params.sessionId));
  return s;
}

async function handle(method, params) {
  logCall(method, params);
  switch (method) {
    case 'initialize': {
      const sessionCapabilities = {};
      if (on('FAKE_ACP_RESUME')) sessionCapabilities.resume = {};
      if (on('FAKE_ACP_CLOSE')) sessionCapabilities.close = {};
      return {
        protocolVersion: 1,
        agentCapabilities: { loadSession: on('FAKE_ACP_LOAD'), sessionCapabilities, promptCapabilities: {} },
        agentInfo: { name: 'fake-acp-agent', version: '0.0.1' },
        authMethods: on('FAKE_ACP_AUTH') ? [{ id: 'login', name: 'Log in' }] : [],
      };
    }
    case 'session/new': {
      if (on('FAKE_ACP_AUTH')) throw new RpcError(ERR.AUTH_REQUIRED, 'Authentication required');
      const s = { id: 'sess_' + crypto.randomBytes(4).toString('hex'), cwd: params.cwd, history: [] };
      sessions.set(s.id, s);
      save(s);
      setImmediate(() => update(s.id, {
        sessionUpdate: 'available_commands_update',
        availableCommands: [{ name: 'review', description: 'review the diff' }, { name: 'web', description: 'search', input: { hint: 'query' } }],
      }));
      const out = { sessionId: s.id };
      if (configOptions(s)) out.configOptions = configOptions(s);
      return out;
    }
    case 'session/load':
    case 'session/resume': {
      if (method === 'session/load' && !on('FAKE_ACP_LOAD')) throw new RpcError(ERR.METHOD_NOT_FOUND, 'method not found');
      if (method === 'session/resume' && !on('FAKE_ACP_RESUME')) throw new RpcError(ERR.METHOD_NOT_FOUND, 'method not found');
      const s = load(params.sessionId);
      if (!s) throw new RpcError(-32002, 'Resource not found: session ' + params.sessionId);
      sessions.set(s.id, s);
      if (method === 'session/load') {
        for (const h of s.history) {
          update(s.id, {
            sessionUpdate: h.role === 'user' ? 'user_message_chunk' : 'agent_message_chunk',
            content: { type: 'text', text: h.text },
          });
        }
      }
      const out = {};
      if (configOptions(s)) out.configOptions = configOptions(s);
      return out;
    }
    case 'session/set_config_option': {
      const s = sessionOf(params);
      const c = Object.prototype.hasOwnProperty.call(SELECTS, params.configId) ? SELECTS[params.configId] : null;
      if (!c || !on(c.env)) throw new RpcError(ERR.INVALID_PARAMS, 'unknown config ' + params.configId);
      if (!c.values.includes(params.value)) throw new RpcError(ERR.INVALID_PARAMS, 'unknown ' + params.configId + ' ' + params.value);
      s[params.configId] = params.value;
      save(s);
      return { configOptions: configOptions(s) };
    }
    case 'session/close': {
      const s = sessionOf(params);
      if (s.turn) s.turn.cancel();
      sessions.delete(s.id);
      return {};
    }
    case 'session/prompt':
      return prompt(sessionOf(params), params);
    default:
      throw new RpcError(ERR.METHOD_NOT_FOUND, 'method not found: ' + method);
  }
}

async function prompt(s, params) {
  const text = (params.prompt || []).filter((b) => b && b.type === 'text').map((b) => b.text).join('');
  if (s.turn) throw new RpcError(ERR.INVALID_REQUEST, 'a turn is already running');
  let cancel;
  const cancelled = new Promise((resolve) => { cancel = resolve; });
  s.turn = { cancel: () => cancel('cancelled') };
  const wait = (ms) => Promise.race([new Promise((r) => setTimeout(() => r('done'), ms)), cancelled]);
  try {
    const earlier = s.history.filter((h) => h.role === 'user').map((h) => h.text);
    s.history.push({ role: 'user', text });
    save(s);
    let reply;
    if (text.includes('CRASH')) process.exit(3);
    if (text.includes('HANG')) {
      await cancelled;
      return { stopReason: 'cancelled' };
    }
    const slow = /SLOW (\d+)/.exec(text);
    if (slow && (await wait(Number(slow[1]))) === 'cancelled') return { stopReason: 'cancelled' };
    if (text.includes('PLAN')) {
      update(s.id, { sessionUpdate: 'plan', entries: [
        { content: 'read the code', priority: 'high', status: 'completed' },
        { content: 'write the fix', priority: 'medium', status: 'in_progress' },
      ] });
    }
    if (text.includes('PERMISSION')) {
      update(s.id, { sessionUpdate: 'tool_call', toolCallId: 'call_1', title: 'Run echo hi', kind: 'execute',
        status: 'pending', rawInput: { command: 'echo hi' } });
      const ask = rpc.request('session/request_permission', {
        sessionId: s.id,
        toolCall: { toolCallId: 'call_1' },
        options: [
          { optionId: 'opt-allow-always', name: 'Always allow', kind: 'allow_always' },
          { optionId: 'opt-allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'opt-reject', name: 'Reject', kind: 'reject_once' },
          { optionId: 'opt-reject-always', name: 'Never', kind: 'reject_always' },
        ],
      });
      const answer = await Promise.race([ask, cancelled]);
      if (answer === 'cancelled' || !answer || answer.outcome.outcome === 'cancelled') {
        update(s.id, { sessionUpdate: 'tool_call_update', toolCallId: 'call_1', status: 'failed' });
        return { stopReason: 'cancelled' };
      }
      const chosen = answer.outcome.optionId;
      if (chosen === 'opt-allow' || chosen === 'opt-allow-always') {
        update(s.id, { sessionUpdate: 'tool_call_update', toolCallId: 'call_1', status: 'in_progress' });
        update(s.id, { sessionUpdate: 'tool_call_update', toolCallId: 'call_1', status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: 'hi' } }] });
      } else {
        update(s.id, { sessionUpdate: 'tool_call_update', toolCallId: 'call_1', status: 'failed' });
      }
      reply = 'permission: ' + chosen;
    } else if (text.includes('RECALL')) {
      reply = 'history: ' + earlier.join('|');
    } else {
      reply = 'echo: ' + text;
    }
    const mid = Math.ceil(reply.length / 2);
    say(s.id, reply.slice(0, mid));
    say(s.id, reply.slice(mid));
    update(s.id, { sessionUpdate: 'usage_update', used: 100 * s.history.length, size: 1000 });
    s.history.push({ role: 'agent', text: reply });
    save(s);
    return { stopReason: 'end_turn' };
  } finally {
    s.turn = null;
  }
}
