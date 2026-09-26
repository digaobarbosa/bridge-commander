'use strict';
// External engines (TTS, STT), served from the board's own origin by one
// proxy (server/proxy.js). /api/<engine>/<rest> is a dumb passthrough to
// <engine>/<rest> — same method, same path, same headers, same status, same
// bytes, streamed both ways, and a client that hangs up hangs up on the
// engine. /api/stt/ws/<rest> is the same passthrough one layer down: the
// handshake and then raw bytes. /api/config hands the browser the TTS proxy
// prefix instead of the engine's address.
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { startServer, sleep } = require('./helper');

// Seed <dir>/.bridge-commander/config.json before the server boots.
function seedConfig(cfg) {
  return (dir) => {
    const sd = path.join(dir, '.bridge-commander');
    fs.mkdirSync(sd, { recursive: true });
    fs.writeFileSync(path.join(sd, 'config.json'), JSON.stringify(cfg));
  };
}

// A stand-in engine: whatever the handler does is what the board must relay.
// `onUpgrade` is optional: only the websocket test needs one.
function startEngine(handler, onUpgrade) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler || ((req, res) => res.end()));
    if (onUpgrade) srv.on('upgrade', onUpgrade);
    srv.listen(0, '127.0.0.1', () => resolve({
      url: 'http://127.0.0.1:' + srv.address().port,
      stop: () => new Promise((r) => srv.close(r)),
    }));
  });
}

test('no tts in config: /api/config is unchanged', async () => {
  const s = await startServer({ seed: seedConfig({ voices: ['Luciana'] }) });
  try {
    const r = await s.api('GET', '/api/config');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { voices: ['Luciana'], permissionMode: 'auto' });
    assert.ok(!('tts' in r.body));
  } finally { await s.stop(); }
});

// The handshake an engine owes a client, computed from the client's own key.
function accept(key) {
  return crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
}

// ---------- both engines: the same proxy, the same promises ----------
for (const engineName of ['tts', 'stt']) {
  const prefix = '/api/' + engineName;

  // Method, path, query, headers and body go up; status, headers and body come
  // back. The proxy knows none of the names involved.
  test(engineName + ': the passthrough relays the request up and the answer back, whole', async () => {
    let seen = null;
    const engine = await startEngine((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen = { method: req.method, url: req.url, ctype: req.headers['content-type'], mark: req.headers['x-mark'], body };
        res.writeHead(418, { 'Content-Type': 'audio/wav', 'x-engine': 'large-v3-turbo' });
        res.end('{"text":"olá capitão"}');
      });
    });
    const s = await startServer({ seed: seedConfig({ [engineName]: { url: engine.url } }) });
    try {
      const r = await fetch(s.base + prefix + '/v1/audio/speech?fast=1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-mark': 'up' },
        body: JSON.stringify({ input: 'olá' }),
      });
      assert.deepEqual(seen, {
        method: 'POST',
        url: '/v1/audio/speech?fast=1',                    // prefix stripped, query kept
        ctype: 'application/json',
        mark: 'up',
        body: '{"input":"olá"}',
      });
      assert.equal(r.status, 418);                       // the engine's status, not ours
      assert.equal(r.headers.get('content-type'), 'audio/wav');
      assert.equal(r.headers.get('x-engine'), 'large-v3-turbo');
      assert.equal(await r.text(), '{"text":"olá capitão"}');
    } finally { await s.stop(); await engine.stop(); }
  });

  // Any path, any method, and an engine error is an engine error — the proxy
  // does not turn a 500 into something friendlier.
  test(engineName + ': an unknown path and a failing engine both pass straight through', async () => {
    const engine = await startEngine((req, res) => {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('boom ' + req.method + ' ' + req.url);
    });
    const s = await startServer({ seed: seedConfig({ [engineName]: { url: engine.url } }) });
    try {
      const r = await fetch(s.base + prefix + '/anything/at/all', { method: 'DELETE' });
      assert.equal(r.status, 500);
      assert.equal(await r.text(), 'boom DELETE /anything/at/all');
    } finally { await s.stop(); await engine.stop(); }
  });

  // No engine, no route: the board is exactly as silent as it is without one,
  // and /api/config is untouched.
  test(engineName + ': no block in config: the proxy path is a plain 404', async () => {
    const s = await startServer({ seed: seedConfig({ voices: ['Luciana'] }) });
    try {
      assert.equal((await s.api('GET', prefix + '/v1/voices')).status, 404);
      assert.equal((await s.api('POST', prefix + '/v1/audio/speech', { input: 'olá' })).status, 404);
      assert.equal((await s.api('GET', prefix)).status, 404);
      assert.deepEqual((await s.api('GET', '/api/config')).body, { voices: ['Luciana'], permissionMode: 'auto' });
    } finally { await s.stop(); }
  });
}

// ---------- TTS: what the browser is handed ----------
// The engine's address is the server's business now. The browser gets a path,
// which resolves against the origin the page came from — the whole point: an
// https page, or a phone off the tailnet, can reach it.
test('tts in config: the browser is handed the proxy prefix, defaults and all', async () => {
  const s = await startServer({
    seed: seedConfig({ tts: { url: 'http://127.0.0.1:8883/', lang: 'pt', voice: null, params: { speed: 1.2 } } }),
  });
  try {
    const r = await s.api('GET', '/api/config');
    assert.deepEqual(r.body.tts, {
      enabled: true,
      url: '/api/tts',                            // never the tailnet address
      lang: 'pt',
      voice: null,
      params: { speed: 1.2 },
    });
  } finally { await s.stop(); }
});

test('malformed tts config reads as not configured', async () => {
  for (const tts of [{ lang: 'pt' }, { url: '' }, 'nope', []]) {
    const s = await startServer({ seed: seedConfig({ tts }) });
    try {
      const r = await s.api('GET', '/api/config');
      assert.ok(!('tts' in r.body), 'tts=' + JSON.stringify(tts) + ' should be off');
    } finally { await s.stop(); }
  }
});

// ---------- streaming, aborts and the idle gap (shown on TTS; one relay) ----------
// Sound has to start while synthesis is still running. If the proxy buffered,
// both chunks would land together at the end.
test('the response streams: the first chunk arrives before the second is written', async () => {
  const engine = await startEngine((req, res) => {
    res.writeHead(200, { 'Content-Type': 'audio/wav' });
    res.write('first');
    setTimeout(() => res.end('second'), 300);
  });
  const s = await startServer({ seed: seedConfig({ tts: { url: engine.url } }) });
  try {
    const r = await fetch(s.base + '/api/tts/v1/audio/speech', { method: 'POST', body: '{}' });
    const reader = r.body.getReader();
    const t0 = Date.now();
    const chunks = [];
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push({ text: Buffer.from(value).toString(), at: Date.now() - t0 });
    }
    assert.ok(chunks.length >= 2, 'arrived in one lump: ' + JSON.stringify(chunks));
    assert.ok(chunks[0].at < 150, 'first chunk waited for the rest: ' + JSON.stringify(chunks));
    assert.equal(chunks.map((c) => c.text).join(''), 'firstsecond');
  } finally { await s.stop(); await engine.stop(); }
});

// The load-bearing one. speech.js aborts its fetch so the ENGINE stops
// synthesizing — an abandoned synthesis overlapping the next request takes
// voxcpm2's CUDA context down with it.
test('a client abort reaches the engine', async () => {
  let hangup = null;
  const seenHangup = new Promise((r) => (hangup = r));
  const engine = await startEngine((req, res) => {
    res.writeHead(200, { 'Content-Type': 'audio/wav' });
    res.write('first');
    const timer = setInterval(() => res.write('.'), 50); // synthesis, still going
    res.on('close', () => { clearInterval(timer); hangup(res.writableFinished); });
  });
  const s = await startServer({ seed: seedConfig({ tts: { url: engine.url } }) });
  try {
    const ac = new AbortController();
    const r = await fetch(s.base + '/api/tts/v1/audio/speech', { method: 'POST', body: '{}', signal: ac.signal });
    await r.body.getReader().read();          // sound is playing
    ac.abort();
    const finished = await Promise.race([seenHangup, sleep(3000).then(() => 'timeout')]);
    assert.equal(finished, false, 'the engine kept synthesizing after the client hung up');
  } finally { await s.stop(); await engine.stop(); }
});

// An engine that dies mid-response is a truncation, not a hang: the error lands
// on the upstream RESPONSE, not on the request, and the browser has to see it —
// a stuck fetch would leave the speech queue draining forever.
test('an engine that dies after the headers truncates the client, it does not hang it', async () => {
  const engine = await startEngine((req, res) => {
    res.writeHead(200, { 'Content-Type': 'audio/wav' });
    res.write('first');
    setTimeout(() => req.socket.destroy(), 100);        // synthesis dies mid-stream
  });
  const s = await startServer({ seed: seedConfig({ tts: { url: engine.url } }) });
  try {
    const r = await fetch(s.base + '/api/tts/v1/audio/speech', { method: 'POST', body: '{}' });
    const reader = r.body.getReader();
    assert.equal(Buffer.from((await reader.read()).value).toString(), 'first');
    const ended = reader.read().then(() => 'closed', () => 'errored');
    assert.notEqual(await Promise.race([ended, sleep(3000).then(() => 'hung')]), 'hung');
  } finally { await s.stop(); await engine.stop(); }
});

// The gap is between BYTES, never a cap on the whole request.
test('an engine that goes quiet past the gap is hung up on', async () => {
  const engine = await startEngine((req, res) => {
    res.writeHead(200, { 'Content-Type': 'audio/wav' });
    res.write('first');                                  // ...and then nothing, ever
  });
  const s = await startServer({
    seed: seedConfig({ tts: { url: engine.url } }),
    env: { BC_TTS_IDLE_MS: '400' },
  });
  try {
    const t0 = Date.now();
    const r = await fetch(s.base + '/api/tts/v1/audio/speech', { method: 'POST', body: '{}' });
    const reader = r.body.getReader();
    assert.equal(Buffer.from((await reader.read()).value).toString(), 'first');
    const ended = reader.read().then(() => 'closed', () => 'errored');
    assert.notEqual(await Promise.race([ended, sleep(5000).then(() => 'hung')]), 'hung');
    assert.ok(Date.now() - t0 >= 400, 'hung up before the gap had elapsed');
  } finally { await s.stop(); await engine.stop(); }
});

// The other half of the same rule: a slow engine that keeps trickling runs well
// past the gap and is left alone. A total-time cap would cut this one off.
test('an engine that keeps trickling past the gap is not cut off', async () => {
  const engine = await startEngine((req, res) => {
    res.writeHead(200, { 'Content-Type': 'audio/wav' });
    let n = 0;
    const timer = setInterval(() => {
      if (++n > 10) { clearInterval(timer); return res.end('done'); }
      res.write('.');                                    // every 150ms, for 1.5s
    }, 150);
    res.on('close', () => clearInterval(timer));
  });
  const s = await startServer({
    seed: seedConfig({ tts: { url: engine.url } }),
    env: { BC_TTS_IDLE_MS: '1000' },
  });
  try {
    const t0 = Date.now();
    const r = await fetch(s.base + '/api/tts/v1/audio/speech', { method: 'POST', body: '{}' });
    assert.equal(await r.text(), '..........done');
    assert.ok(Date.now() - t0 > 1000, 'the engine did not actually outlast the gap');
  } finally { await s.stop(); await engine.stop(); }
});

// The deadline is about the ENGINE going quiet, never about a slow client. A
// phone on a thin link stops draining, backpressure pauses the upstream stream,
// and no bytes arrive for seconds — that is our silence, not the engine's, and
// hanging up on it would kill exactly the case this proxy exists for.
test('a client that stops draining is not mistaken for a quiet engine', async () => {
  const CHUNK = 64 * 1024;
  const CHUNKS = 128;
  const engine = await startEngine((req, res) => {
    res.writeHead(200, { 'Content-Type': 'audio/wav' });
    let n = 0;
    const timer = setInterval(() => {
      if (++n > CHUNKS) { clearInterval(timer); return res.end(); }
      res.write(Buffer.alloc(CHUNK, 'a'));               // still synthesizing, happily
    }, 2);
    res.on('close', () => clearInterval(timer));
  });
  const s = await startServer({
    seed: seedConfig({ tts: { url: engine.url } }),
    env: { BC_TTS_IDLE_MS: '500' },
  });
  try {
    const r = await fetch(s.base + '/api/tts/v1/audio/speech', { method: 'POST', body: '{}' });
    const reader = r.body.getReader();
    let got = (await reader.read()).value.length;
    await sleep(2000);                                   // four gaps, reading nothing
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      got += value.length;
    }
    assert.equal(got, CHUNK * CHUNKS);
  } finally { await s.stop(); await engine.stop(); }
});

// ---------- STT: the websocket half ----------
// The half only STT has: the upgrade goes up, the 101 comes
// back, and then it is raw bytes each way — audio up, JSON down, neither of
// them anything the proxy looks at.
test('the websocket reaches the engine and carries bytes both ways', async () => {
  let seenPath = null;
  const engine = await startEngine(null, (req, sock) => {
    seenPath = req.url;
    sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
      + 'Sec-WebSocket-Accept: ' + accept(req.headers['sec-websocket-key']) + '\r\n\r\n');
    sock.write('HELLO');                                    // the engine speaks first
    sock.on('data', (d) => sock.write('ECHO:' + d));        // ...and answers what it is sent
    sock.on('end', () => sock.destroy());                   // ...and lets go when the proxy does
  });
  const s = await startServer({ seed: seedConfig({ stt: { url: engine.url } }) });
  try {
    const key = crypto.randomBytes(16).toString('base64');
    const up = await new Promise((resolve, reject) => {
      const req = http.request({
        port: s.port, host: '127.0.0.1', path: '/api/stt/ws/transcribe?lang=pt',
        headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13' },
      });
      req.on('upgrade', (res, socket, head) => resolve({ res, socket, head }));
      req.on('response', (res) => reject(new Error('no upgrade, HTTP ' + res.statusCode)));
      req.on('error', reject);
      req.end();
    });
    assert.equal(seenPath, '/ws/transcribe?lang=pt');        // prefix stripped, query kept
    assert.equal(up.res.statusCode, 101);
    // The accept hash is the ENGINE's, computed from the client's own key — the
    // browser checks it, so a proxy that invented one would be caught here.
    assert.equal(up.res.headers['sec-websocket-accept'], accept(key));

    const said = [];
    if (up.head && up.head.length) said.push(up.head.toString());
    const heard = new Promise((resolve) => {
      up.socket.on('data', (d) => {
        said.push(d.toString());
        if (said.join('').includes('ECHO:AUDIO')) resolve(said.join(''));
      });
      if (said.join('').includes('ECHO:AUDIO')) resolve(said.join(''));
    });
    up.socket.write('AUDIO');
    assert.equal(await heard, 'HELLOECHO:AUDIO');
    up.socket.destroy();
  } finally { await s.stop(); await engine.stop(); }
});

// No engine, no websocket: the upgrade is dropped rather than answered.
test('no stt block: an upgrade on the prefix is refused', async () => {
  const s = await startServer({ seed: seedConfig({}) });
  try {
    const outcome = await new Promise((resolve) => {
      const req = http.request({
        port: s.port, host: '127.0.0.1', path: '/api/stt/ws/transcribe',
        headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'), 'Sec-WebSocket-Version': '13' },
      });
      req.on('upgrade', () => resolve('upgraded'));
      req.on('response', (res) => resolve('http ' + res.statusCode));
      req.on('error', () => resolve('dropped'));
      req.end();
    });
    assert.equal(outcome, 'dropped');
  } finally { await s.stop(); }
});
