'use strict';
// An external engine (TTS, STT), served from the board's own origin. The board
// is behind https through a tunnel, so a page it served cannot talk to a
// plain-http engine on the tailnet — and a microphone needs a secure context.
//
// `<prefix>/<rest>` goes to `<engine>/<rest>` and nothing else happens: same
// method, same path, same query, same headers, same status, same bytes. No
// cache, no retry, no defaults filled in, no knowledge of which paths the
// engine has. A condition on a path or a body in this file is a bug.
//
// Both directions STREAM. Audio starts playing while synthesis is still
// running, so buffering a response here would put the whole 30-second wait back.
//
// A client that hangs up kills the upstream request. That is load-bearing, not
// tidiness: the browser aborts a fetch precisely so the ENGINE stops
// synthesizing, and an abandoned synthesis that overlaps the next request takes
// voxcpm2's CUDA context down with it (see ui/js/speech.js).
//
// The one deadline: an idle-byte-gap hangup, and nothing else. It knows nothing
// about audio, speech, synthesis, or which path is in flight — it is the gap
// between two bytes from upstream, armed before the first one and re-armed by
// every one after it. A request may legitimately run for minutes as long as
// bytes keep arriving; a total-time cap would truncate every long response and
// is exactly the wrong shape here.
//
// It measures ONE thing: the upstream has gone quiet. It deliberately does not
// measure a slow CLIENT. A client behind on its reading pauses the upstream
// stream (backpressure), and a client still uploading its request has not asked
// the upstream for anything yet — in both cases the silence is ours, not the
// engine's, so the deadline re-arms instead of firing. The connection is cut
// only when the upstream is quiet AND the client is keeping up.
const http = require('http');
const https = require('https');

/**
 * engineUrl(block) -> the engine's base url (no trailing slash), or null.
 * `block` is a config.json section like `{ "url": "http://127.0.0.1:8883" }`;
 * anything malformed (or a missing url) reads as "not configured".
 */
function engineUrl(block) {
  if (!block || typeof block !== 'object' || Array.isArray(block)) return null;
  const url = typeof block.url === 'string' ? block.url.trim().replace(/\/+$/, '') : '';
  return /^https?:\/\/\S+$/.test(url) ? url : null;
}

/**
 * makeProxy({ prefix, idleEnv, urlOf }) -> { handle, upgrade }
 *   prefix   the route prefix the proxy owns, e.g. '/api/tts'
 *   idleEnv  env var holding the idle-byte-gap in ms (default 20000)
 *   urlOf()  the engine base url right now, or null when not configured
 * handle(req, res, pathname, search) and upgrade(req, socket, head, pathname,
 * search) return true when they took the request. A path outside the prefix,
 * or no engine configured, returns false: the caller falls through to its
 * ordinary 404, and the board is as silent as it is with no engine at all.
 */
function makeProxy({ prefix, idleEnv, urlOf }) {
  const idleMs = parseInt(process.env[idleEnv], 10) > 0 ? parseInt(process.env[idleEnv], 10) : 20000;
  // pathname, not a decoded path: what the browser encoded is what the engine gets.
  const target = (p, search) => {
    if (p !== prefix && !p.startsWith(prefix + '/')) return null;
    const engine = urlOf();
    return engine ? engine + p.slice(prefix.length) + search : null;
  };
  return {
    handle(req, res, p, search) {
      const t = target(p, search);
      if (t) relay(req, res, t, idleMs);
      return !!t;
    },
    upgrade(req, socket, head, p, search) {
      const t = target(p, search);
      if (t) relayUpgrade(req, socket, head, t);
      return !!t;
    },
  };
}

/** relay(req, res, target, idleMs) — stream one request to `target` and its answer back. */
function relay(req, res, target, idleMs) {
  const mod = target.startsWith('https:') ? https : http;
  const headers = Object.assign({}, req.headers);
  delete headers.host; // the engine's host, not the board's — everything else rides along
  // Upstream is done the moment its response ends; only a hangup BEFORE that is
  // worth aborting, and aborting after it would take a pooled socket with it.
  let done = false;
  let timer = null;
  const disarm = () => { if (timer) { clearTimeout(timer); timer = null; } };
  // Nothing to say once the status line is out (or once the client is gone —
  // which is how a deliberate abort comes back here): drop the connection and
  // let the browser see the truncation, the same as talking to the engine direct.
  const fail = (e) => {
    disarm();
    up.destroy();
    if (res.headersSent || res.destroyed) return res.destroy();
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: String((e && e.message) || e) }));
  };
  // Silence that is ours, not the engine's: a request still uploading, or a
  // client too slow to drain. Neither one is the engine going quiet.
  const ourSilence = () => !req.readableEnded || res.writableNeedDrain || res.writableLength > 0;
  const arm = () => {
    disarm();
    timer = setTimeout(() => {
      if (ourSilence()) return arm();
      fail(new Error('no bytes from upstream for ' + idleMs + 'ms'));
    }, idleMs);
  };
  const up = mod.request(target, { method: req.method, headers }, (r) => {
    res.writeHead(r.statusCode, r.headers);
    r.on('data', arm);
    r.once('end', () => { done = true; disarm(); });
    r.on('error', () => { disarm(); res.destroy(); });
    r.pipe(res);
  });
  up.on('error', fail);
  res.on('close', () => { disarm(); if (!done) up.destroy(); });
  arm();
  req.pipe(up);
}

// The websocket half (dictation: `/api/stt/ws/transcribe` has to reach
// `ws://<engine>/ws/transcribe`). The cheapest correct way is to stay below
// the protocol: hand the engine the client's own handshake headers (its
// Sec-WebSocket-Key included, so the browser validates the engine's own
// accept), relay the engine's 101 back byte for byte, and then pipe the two
// sockets at each other until one of them closes.
//
// Nothing here parses a frame. Audio going up and JSON coming down are the
// same thing to this function: bytes, in order, in both directions.
/** relayUpgrade(req, socket, head, target) — splice a websocket to `target`. */
function relayUpgrade(req, socket, head, target) {
  const url = new URL(target);
  const mod = url.protocol === 'https:' ? https : http;
  const headers = Object.assign({}, req.headers);
  delete headers.host;
  const bail = () => { socket.destroy(); };
  const up = mod.request({
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port,
    path: url.pathname + url.search,
    method: req.method,
    headers,
  });
  up.on('upgrade', (r, upSocket, upHead) => {
    // The engine's own status line and headers, verbatim — the accept hash in
    // there is the one the browser is about to check.
    socket.write(statusBlock(r));
    // Frames either side already sent past its handshake go first, in order.
    if (upHead && upHead.length) socket.write(upHead);
    if (head && head.length) upSocket.write(head);
    // Dictation is measured in milliseconds here; Nagle would add tens of them
    // to every small frame in both directions.
    socket.setNoDelay(true);
    upSocket.setNoDelay(true);
    // Either end closing takes the other with it. Piping alone does not: a
    // browser tab that vanishes destroys its socket without ever sending a
    // close frame or an EOF, and the engine would sit holding a transcription
    // session for a page that is gone.
    const drop = () => { socket.destroy(); upSocket.destroy(); };
    socket.on('error', drop);
    socket.on('close', drop);
    upSocket.on('error', drop);
    upSocket.on('close', drop);
    // A FIN from one end finishes that end too. Both of these sockets came off
    // an http.Server, which leaves them half-open capable so a response can
    // still be written after the request's FIN — a websocket has no use for
    // that, and without this the connection would sit half-dead forever
    // instead of closing and taking the other side with it (above).
    socket.on('end', () => socket.end());
    upSocket.on('end', () => upSocket.end());
    socket.pipe(upSocket);
    upSocket.pipe(socket);
  });
  // The engine answered with an ordinary response instead of upgrading (a 404,
  // a refusal). That answer is the client's to see, so it goes down the raw
  // socket as it stands.
  up.on('response', (r) => {
    socket.write(statusBlock(r));
    r.on('error', bail);
    r.pipe(socket);
  });
  up.on('error', bail);
  socket.on('error', () => up.destroy());
  socket.on('close', () => up.destroy());
  up.end();
}

/** statusBlock(r) — the upstream's status line and raw headers, ready for a raw socket. */
function statusBlock(r) {
  const lines = ['HTTP/1.1 ' + r.statusCode + ' ' + r.statusMessage];
  for (let i = 0; i < r.rawHeaders.length; i += 2) lines.push(r.rawHeaders[i] + ': ' + r.rawHeaders[i + 1]);
  return lines.join('\r\n') + '\r\n\r\n';
}

module.exports = { makeProxy, engineUrl };
