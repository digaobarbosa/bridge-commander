'use strict';
// Board permission approvals — the server half. A PermissionRequest hook
// (harness/permission-hook.js) POSTs what an agent is about to ask, and
// its HTTP request IS the question: we hold the response open until the
// captain decides, the cap runs out, or the hook goes away. Nothing here is
// persisted — a held request cannot outlive the process that holds it.

// Which launch modes exist, and what a tool's input means, are harness facts
// (profile.permissions); the core gets them injected and names no tool.

// permissionModes(lists) — the union of the harnesses' mode lists, in order,
// so the default harness's first mode is the board default.
function permissionModes(lists) {
  const out = [];
  for (const l of lists || []) for (const m of l || []) if (typeof m === 'string' && !out.includes(m)) out.push(m);
  return out;
}

// permissionMode(v, modes) — v when a harness knows it, else the default. A
// typo must not turn into a flag a CLI refuses to start on.
function permissionMode(v, modes) {
  const list = modes || [];
  return list.includes(v) ? v : list[0];
}

// One line the captain can judge from: what the harness's describe() picks
// (the field that carries the risk), else the input itself, trimmed.
function summarize(tool, input, describe) {
  const i = input && typeof input === 'object' ? input : {};
  let s = '';
  if (typeof describe === 'function') {
    try { s = String(describe({ tool_name: tool, tool_input: i }) || ''); } catch (e) { s = ''; }
  }
  if (!s) { try { s = JSON.stringify(i); } catch (e) { s = ''; } }
  s = s.replace(/\s+/g, ' ');
  return s.length > 200 ? s.slice(0, 199) + '…' : s;
}

// createPermissions({ capMs, onChange }) -> { hold, decide, list, has }
//   hold(res, item)  keep `res` open under a fresh id; replies {decision:null}
//                    at capMs; drops the item if the client hangs up first.
//   decide(id, decision, message) -> the item, or null for an unknown id.
//   onChange(item, outcome) fires on every add and removal —
//   outcome: 'asked' | 'allow' | 'deny' | 'timeout' | 'gone'.
function createPermissions({ capMs, onChange }) {
  const pending = new Map(); // id -> { item, res, timer }
  let n = 0;

  function reply(res, obj) {
    if (res.writableEnded || res.destroyed) return;
    const body = JSON.stringify(obj);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  }
  function settle(id, answer, outcome) {
    const p = pending.get(id);
    if (!p) return null;
    pending.delete(id);
    clearTimeout(p.timer);
    if (answer) reply(p.res, answer);
    onChange(p.item, outcome);
    return p.item;
  }

  function hold(res, fields) {
    const id = 'perm-' + Date.now().toString(36) + '-' + (++n);
    const item = Object.assign({ id }, fields);
    const timer = setTimeout(() => settle(id, { decision: null }, 'timeout'), capMs);
    pending.set(id, { item, res, timer });
    // 'close' before our reply = the hook was killed, Claude timed it out, or
    // the agent was interrupted: nobody is left to answer.
    res.on('close', () => settle(id, null, 'gone'));
    onChange(item, 'asked');
    return item;
  }
  function decide(id, decision, message) {
    const answer = { decision };
    if (message) answer.message = message;
    return settle(id, answer, decision);
  }
  function list() {
    return [...pending.values()].map((p) => p.item).sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  }
  function has(pred) {
    for (const p of pending.values()) if (pred(p.item)) return true;
    return false;
  }
  return { hold, decide, list, has };
}

module.exports = { permissionModes, permissionMode, summarize, createPermissions };
