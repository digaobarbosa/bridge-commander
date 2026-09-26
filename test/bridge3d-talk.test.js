'use strict';
// Hold to talk, from inside the room. The button and the bar it is drawn on are
// a photograph's problem; this is the part underneath, which fails in ways no
// photograph shows — a microphone left open because the ray wandered off the
// bar, a crew left mute because a socket died mid-sentence, a permission prompt
// raised inside an immersive session.
//
// talk.js imports NOTHING, which is the whole reason this test can exist: the
// rest of the room pulls in three.js and uikit and cannot be loaded here. What
// it touches instead — getUserMedia, MediaRecorder, WebSocket — is stubbed
// below, so the state machine is driven rather than read.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const MOD = pathToFileURL(path.join(__dirname, '..', 'ui', 'js', 'bridge3d', 'talk.js')).href;
const tick = () => new Promise((r) => setTimeout(r, 0));

// ---- the browser, as far as talk.js can tell -------------------------------

let sockets = [];
let recorders = [];
let tracksStopped = 0;

class FakeSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.closed = false;
    sockets.push(this);
  }
  send(d) { this.sent.push(d); }
  close() { this.closed = true; this.readyState = 3; }
  // What the engine does, from the test's side.
  open() { this.readyState = 1; if (this.onopen) this.onopen(); }
  say(obj) { if (this.onmessage) this.onmessage({ data: JSON.stringify(obj) }); }
}

class FakeRecorder {
  constructor(stream, opts) {
    this.stream = stream;
    this.opts = opts;
    this.state = 'inactive';
    this.interval = null;
    recorders.push(this);
  }
  static isTypeSupported() { return true; }
  start(ms) { this.state = 'recording'; this.interval = ms; }
  stop() { this.state = 'inactive'; this.emit('FLUSH'); }
  emit(bytes) { if (this.ondataavailable) this.ondataavailable({ data: { size: bytes.length, bytes } }); }
}

function install({ mic = true, why = 'Permission denied' } = {}) {
  sockets = []; recorders = []; tracksStopped = 0;
  global.location = { protocol: 'https:', host: 'board.example' };
  global.WebSocket = FakeSocket;
  global.MediaRecorder = FakeRecorder;
  // node ships its own `navigator`, and it is a getter with no setter.
  Object.defineProperty(global, 'navigator', {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia: async () => {
          if (!mic) throw new Error(why);
          return { getTracks: () => [{ stop() { tracksStopped++; } }] };
        },
      },
    },
  });
}

// A fresh module per test: talk.js holds one microphone and one take, which is
// the truth about a room with one person in it, and makes the module itself the
// state under test.
let n = 0;
const fresh = () => import(MOD + '?t=' + (++n));

// ---- what it does ----------------------------------------------------------

test('the microphone is asked for once, at the gate, and kept for the visit', async () => {
  install();
  const talk = await fresh();
  assert.equal(talk.armed(), false);
  assert.equal(await talk.arm(), '');
  assert.equal(talk.armed(), true);
  assert.equal(talk.armedWhy(), '');
  // Asking again is free and asks nobody: a second prompt is the thing that
  // cannot happen inside a session.
  let asked = 0;
  navigator.mediaDevices.getUserMedia = async () => { asked++; return null; };
  assert.equal(await talk.arm(), '');
  assert.equal(asked, 0);
});

test('a refused microphone is a reason in words, not a throw', async () => {
  install({ mic: false, why: 'Permission dismissed' });
  const talk = await fresh();
  const why = await talk.arm();
  assert.match(why, /Permission dismissed/);
  assert.equal(talk.armed(), false);
  assert.equal(talk.armedWhy(), why);

  // And pressing the bar anyway says so on the panel rather than opening a
  // socket to an engine that has nothing to transcribe.
  const seen = [];
  talk.begin((s) => seen.push(s));
  assert.equal(sockets.length, 0);
  const last = seen[seen.length - 1];
  assert.equal(last.state, 'error');
  assert.match(last.why, /Permission dismissed/);
});

test('a take: hold, partials while he speaks, and the first word after the flush is the final', async () => {
  install();
  const talk = await fresh();
  await talk.arm();

  const seen = [];
  talk.begin((s) => seen.push({ ...s }));
  assert.equal(seen[0].state, 'recording');
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].url, 'wss://board.example/api/stt/ws/transcribe');

  sockets[0].open();
  assert.equal(recorders.length, 1);
  assert.equal(recorders[0].state, 'recording');
  assert.equal(recorders[0].interval, 1000);

  // Audio goes up as it is produced...
  recorders[0].emit('CHUNK-1');
  recorders[0].emit('CHUNK-2');
  assert.deepEqual(sockets[0].sent.map((d) => d.bytes), ['CHUNK-1', 'CHUNK-2']);

  // ...and the engine sends back the whole transcript so far, never the newest
  // words, so it is REPLACED and never appended.
  sockets[0].say({ text: 'capitão' });
  sockets[0].say({ text: 'capitão, o servidor caiu' });
  assert.equal(talk.state(), 'recording');
  assert.equal(seen[seen.length - 1].text, 'capitão, o servidor caiu');

  // He lets go: one last chunk is flushed and the take waits for a final.
  talk.end();
  assert.equal(recorders[0].state, 'inactive');
  assert.equal(sockets[0].sent[sockets[0].sent.length - 1].bytes, 'FLUSH');
  assert.equal(talk.state(), 'settling');

  sockets[0].say({ text: 'capitão, o servidor caiu de novo' });
  assert.equal(talk.state(), 'heard');
  assert.equal(talk.heard(), 'capitão, o servidor caiu de novo');
  assert.equal(sockets[0].closed, true, 'a finished take holds no socket open');
});

test('the crew is mute for exactly as long as he is talking', async () => {
  install();
  const talk = await fresh();
  await talk.arm();
  const hushes = [];
  talk.setHush((on) => hushes.push(on));

  talk.begin(() => {});
  assert.deepEqual(hushes, [true], 'a lieutenant talking over him lands in the transcript');
  sockets[0].open();
  talk.end();
  assert.deepEqual(hushes, [true, false], 'he stopped — they may speak again');
  sockets[0].say({ text: 'pronto' });
  assert.deepEqual(hushes, [true, false]);
});

test('a socket that dies mid-sentence says so and leaves nobody mute', async () => {
  install();
  const talk = await fresh();
  await talk.arm();
  const hushes = [];
  talk.setHush((on) => hushes.push(on));

  const seen = [];
  talk.begin((s) => seen.push({ ...s }));
  sockets[0].open();
  if (sockets[0].onerror) sockets[0].onerror();

  const last = seen[seen.length - 1];
  assert.equal(last.state, 'error');
  assert.match(last.why, /transcription engine/);
  assert.deepEqual(hushes, [true, false], 'a dead socket must not leave the room silent for good');
  assert.equal(recorders[0].state, 'inactive', 'and it must not leave the microphone running');
});

test('an engine error is the engine\'s words, in front of his face', async () => {
  install();
  const talk = await fresh();
  await talk.arm();
  const seen = [];
  talk.begin((s) => seen.push({ ...s }));
  sockets[0].open();
  sockets[0].say({ error: 'model not loaded' });
  assert.equal(seen[seen.length - 1].state, 'error');
  assert.match(seen[seen.length - 1].why, /model not loaded/);
});

test('letting go before the socket opened still stops the recording', async () => {
  // A short "sim" is the normal case, not an edge one: the trigger can easily
  // be released before the handshake finishes, and a stop that was dropped on
  // the floor would leave the microphone open with no way to close it.
  install();
  const talk = await fresh();
  await talk.arm();
  talk.begin(() => {});
  talk.end();
  assert.equal(talk.state(), 'recording', 'there is no recorder yet to flush');
  sockets[0].open();
  assert.equal(talk.state(), 'settling', 'the stop was remembered and run');
  assert.equal(recorders[0].state, 'inactive');
  talk.drop();          // a settling take is holding the final-wait timer
});

test('again throws the take away, and starting another one drops the first', async () => {
  install();
  const talk = await fresh();
  await talk.arm();

  const first = [];
  talk.begin((s) => first.push({ ...s }));
  sockets[0].open();
  sockets[0].say({ text: 'errado' });
  talk.drop();
  assert.equal(talk.state(), 'idle');
  assert.equal(talk.heard(), '');
  assert.equal(sockets[0].closed, true);
  assert.equal(first[first.length - 1].state, 'idle', 'the panel is told its take is gone');

  // And the panel that was showing the old one is told, so it cannot sit there
  // saying "listening" forever.
  const second = [];
  talk.begin((s) => second.push({ ...s }));
  talk.begin(() => {});
  assert.equal(second[second.length - 1].state, 'idle');
});

test('leaving the room takes the microphone with it', async () => {
  install();
  const talk = await fresh();
  await talk.arm();
  talk.begin(() => {});
  sockets[0].open();
  talk.disarm();
  assert.equal(tracksStopped, 1, 'no capture indicator on a headset he has taken off');
  assert.equal(talk.armed(), false);
  assert.equal(talk.state(), 'idle');
  assert.equal(sockets[0].closed, true);
  await tick();
});
