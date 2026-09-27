'use strict';
// acp-rpc — minimal JSON-RPC 2.0 over newline-delimited streams, zero deps.
//
// ACP's stdio transport is exactly this: one JSON message per line, UTF-8, no
// embedded newlines. Both peers may send requests, so one connection carries
// our requests (with ids we mint), the peer's requests (answered through
// onRequest), notifications both ways, and error objects.
//
// The acp-host also speaks it to the adapter over its unix socket: one framing,
// one parser, one set of bugs.

// JSON-RPC and ACP error codes the harness produces or reads.
const ERR = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  CANCELLED: -32800,
  AUTH_REQUIRED: -32000,
};

class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

/**
 * createRpc({ input, output, onRequest?, onNotification?, onClose?, log? }) -> rpc
 *   input            Readable of newline-delimited JSON (agent stdout, a socket)
 *   output           Writable (agent stdin, the same socket)
 *   onRequest(method, params) -> result | Promise<result>; throw RpcError for a
 *                    typed error. Absent = every peer request is "method not found".
 *   onNotification(method, params)
 *   onClose()        the input ended; every pending request was rejected first
 *
 * rpc.request(method, params, { timeoutMs? }) -> Promise<result> (rejects RpcError)
 * rpc.notify(method, params)
 * rpc.close()       stop reading and reject what is pending
 */
function createRpc({ input, output, onRequest, onNotification, onClose, log = () => {} }) {
  let nextId = 1;
  let closed = false;
  let buf = '';
  const pending = new Map(); // id -> { resolve, reject, timer, method }

  function write(msg) {
    if (closed || !output || output.destroyed || output.writableEnded) return false;
    try {
      output.write(JSON.stringify(msg) + '\n');
      return true;
    } catch (e) {
      log('rpc write failed: ' + e.message);
      return false;
    }
  }

  function reply(id, result) { write({ jsonrpc: '2.0', id, result: result === undefined ? null : result }); }
  function replyError(id, code, message, data) {
    const error = { code, message: String(message || 'error') };
    if (data !== undefined) error.data = data;
    write({ jsonrpc: '2.0', id, error });
  }

  async function handleRequest(msg) {
    if (!onRequest) return replyError(msg.id, ERR.METHOD_NOT_FOUND, 'method not found: ' + msg.method);
    try {
      reply(msg.id, await onRequest(msg.method, msg.params));
    } catch (e) {
      if (e instanceof RpcError) replyError(msg.id, e.code, e.message, e.data);
      else replyError(msg.id, ERR.INTERNAL, (e && e.message) || String(e));
    }
  }

  function handleMessage(msg) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return; // batches are not part of ACP
    const hasId = msg.id !== undefined && msg.id !== null;
    if (typeof msg.method === 'string') {
      if (hasId) { handleRequest(msg); return; }
      try { onNotification && onNotification(msg.method, msg.params); } catch (e) { log('notification handler threw: ' + e.message); }
      return;
    }
    if (!hasId) return;
    const p = pending.get(msg.id);
    if (!p) return; // a late answer to a request that already timed out
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) {
      const e = msg.error;
      p.reject(new RpcError(Number.isInteger(e.code) ? e.code : ERR.INTERNAL, e.message || 'error', e.data));
    } else p.resolve(msg.result);
  }

  function onData(chunk) {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch {
        // Agents launched through npx may print a banner to stdout; one bad
        // line must not end the conversation.
        log('rpc: skipped a non-JSON line: ' + line.slice(0, 200));
        continue;
      }
      handleMessage(msg);
    }
  }

  function end() {
    if (closed) return;
    closed = true;
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new RpcError(ERR.INTERNAL, 'connection closed before ' + p.method + ' answered'));
      pending.delete(id);
    }
    try { onClose && onClose(); } catch (e) { log('close handler threw: ' + e.message); }
  }

  input.setEncoding && input.setEncoding('utf8');
  input.on('data', onData);
  input.on('end', end);
  input.on('close', end);
  input.on('error', (e) => { log('rpc input error: ' + e.message); end(); });
  if (output && output !== input) output.on('error', (e) => log('rpc output error: ' + e.message));

  function request(method, params, opts = {}) {
    if (closed) return Promise.reject(new RpcError(ERR.INTERNAL, 'connection closed'));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const p = { resolve, reject, method, timer: null };
      if (opts.timeoutMs > 0) {
        p.timer = setTimeout(() => {
          pending.delete(id);
          reject(new RpcError(ERR.INTERNAL, method + ' timed out after ' + opts.timeoutMs + 'ms'));
        }, opts.timeoutMs);
        p.timer.unref && p.timer.unref();
      }
      pending.set(id, p);
      const msg = { jsonrpc: '2.0', id, method };
      if (params !== undefined) msg.params = params;
      if (!write(msg)) {
        pending.delete(id);
        clearTimeout(p.timer);
        reject(new RpcError(ERR.INTERNAL, 'connection closed'));
      }
    });
  }

  function notify(method, params) {
    const msg = { jsonrpc: '2.0', method };
    if (params !== undefined) msg.params = params;
    return write(msg);
  }

  function close() {
    input.off('data', onData);
    end();
  }

  return { request, notify, close, get closed() { return closed; }, get pendingCount() { return pending.size; } };
}

module.exports = { createRpc, RpcError, ERR };
