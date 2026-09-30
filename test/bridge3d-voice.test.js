'use strict';
// The room speaks. Two things stand between "voice.js works on the flat board"
// and "a lieutenant is heard in the headset", and neither shows up in any
// screenshot:
//
// **The page has no voice toolbar.** A <select> and two buttons are furniture
// nobody inside an immersive session can see or press, so bridge3d.html does not
// carry them — and voice.js is a module the room imports at load. A missing
// element it reaches for at module scope is not a quiet degradation: it throws
// during evaluation, main.js never runs, and the room is a black screen. So the
// first half here loads voice.js against a page with NOTHING on it.
//
// **The ears are in two contexts.** The voice is rendered in speech.js's own
// AudioContext — it has to be, that is the one feeding the <audio> element the
// OS sees as a media player — so a panner placed in the crew's arc there is deaf
// to the room's listener. bridge3d/sound.js has to move both.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const load = (...p) => import(pathToFileURL(path.join(ROOT, 'ui', 'js', ...p)).href);
const tick = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, why, ms = 2000) {
  for (let waited = 0; waited < ms; waited += 2) {
    if (what()) return;
    await tick(2);
  }
  assert.fail('timed out waiting for ' + why);
}
// toast.js arms a 6s dismiss timer per toast; a live one holds the runner open.
const realSetTimeout = global.setTimeout;
global.setTimeout = (fn, ms, ...rest) => {
  const t = realSetTimeout(fn, ms, ...rest);
  if (ms >= 1000) t.unref?.();
  return t;
};

// ── the room's page: a canvas and nothing else ────────────────────────────
// getElementById answers null for everything, which is the truth about
// bridge3d.html — it has a gate and a button called `enter`, and not one of the
// four ids voice.js looks for on the flat board.
const made = [];
function el(tag) {
  const n = {
    tag, textContent: '', className: '', hidden: true, paused: true, srcObject: null,
    children: [], classList: { toggle() {}, add() {}, remove() {} },
    play() { n.paused = false; return Promise.resolve(); },
    pause() { n.paused = true; },
    appendChild: (c) => { n.children.push(c); return c; },
    querySelectorAll: () => [el('button'), el('button'), el('button')],
    querySelector: () => el('span'),
  };
  Object.defineProperty(n, 'firstChild', { get: () => n.children[0] || null });
  return n;
}
const asked = [];                 // {input, voice} per engine request
const ENGINE = 'http://127.0.0.1:8884';
const json = (o) => Promise.resolve(new Response(JSON.stringify(o), { status: 200 }));
const wiredTo = [];
let theSink = null;
class FakeCtx {
  constructor() { this.state = 'running'; this.destination = {}; this.listener = listener(); }
  get currentTime() { return 0; }
  resume() { this.state = 'running'; return Promise.resolve(); }
  suspend() { this.state = 'suspended'; return Promise.resolve(); }
  createMediaStreamDestination() { return (theSink = { stream: { id: 'live' } }); }
  createBuffer(ch, len, rate) {
    const data = new Float32Array(len);
    return { length: len, duration: len / rate, getChannelData: () => data };
  }
  createBufferSource() {
    let cb = null;
    return {
      connect(n) { wiredTo.push(n); }, start() { setTimeout(() => cb && cb(), 1); },
      set onended(f) { cb = f; }, get onended() { return cb; },
    };
  }
}
// The modern listener: nine AudioParams. sound.js also handles Safari's
// deprecated setPosition pair, which is covered below by a second shape.
const listener = () => ({
  positionX: { value: 0 }, positionY: { value: 0 }, positionZ: { value: 0 },
  forwardX: { value: 0 }, forwardY: { value: 0 }, forwardZ: { value: -1 },
  upX: { value: 0 }, upY: { value: 1 }, upZ: { value: 0 },
});

test.before(() => {
  global.window = { AudioContext: FakeCtx, addEventListener() {} };
  global.document = {
    createElement: (tag) => { const n = el(tag); made.push(n); return n; },
    getElementById: () => null,          // the room has none of them
    head: { appendChild: (n) => n },
    body: { appendChild: (n) => n },
  };
  const store = { 'bc-tts-voice': 'selma-br' };   // a voice chosen on the flat board
  global.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  global.fetch = (url, opts = {}) => {
    if (url === '/api/config') {
      return json({ voices: null, tts: { enabled: true, url: ENGINE, lang: 'pt', voice: null, params: {} } });
    }
    if (url === ENGINE + '/v1/voices') {
      return json({ voices: [{ id: 'selma-br', name: 'Selma', langs: ['pt-BR'] }] });
    }
    if (url === ENGINE + '/v1/audio/speech') {
      const b = JSON.parse(opts.body);
      asked.push({ input: b.input, voice: b.voice });
      return Promise.resolve(new Response(new ReadableStream({
        start(c) { c.enqueue(new Uint8Array(480)); c.close(); },
      }), { status: 200, headers: { 'x-sample-rate': '24000' } }));
    }
    return Promise.reject(new Error('unexpected fetch: ' + url));
  };
});

// ── the page with no toolbar ──────────────────────────────────────────────

test('voice.js loads on a page with no voice toolbar at all', async () => {
  const v = await load('voice.js');
  assert.equal(typeof v.speak, 'function',
    'the module evaluated — a throw here is the room never starting');
  assert.equal(typeof v.setSpeechRoute, 'function');
  assert.equal(typeof v.setVoiceOn, 'function');
});

test('the room speaks with the voice the flat board saved, and does not steal its toggle', async () => {
  const { speak, setVoiceOn, voiceOptions } = await load('voice.js');
  // The catalogue lands a few promises after import, and a voice that is not in
  // it is refused — so every assertion below would otherwise be about the race.
  await voiceOptions();
  // Nothing was persisted, so nothing turned it on: the room starts silent.
  speak('não me ouve', 'selma');
  await tick(20);
  assert.equal(asked.length, 0, 'speech off means silence, exactly as on the board');

  setVoiceOn(true, false);          // what entering the bridge does
  speak('a carga foi para o card', 'selma');
  await until(() => asked.length >= 1, 'the message to reach the engine');
  assert.equal(asked[0].input, 'a carga foi para o card');
  assert.equal(asked[0].voice, 'selma-br',
    'no picker to read, so the board’s own saved voice is the one that speaks');
  assert.equal(localStorage.getItem('bc-voice-on'), null,
    'and the flat board’s toggle was NOT switched on behind the captain’s back');
});

// ── the ears, in both graphs ──────────────────────────────────────────────

test('the ears follow the head into the speech path’s own context', async () => {
  const { Sound } = await load('bridge3d', 'sound.js');
  const s = new Sound();
  s.ctx = new FakeCtx();            // the room's own, as start() would have made it
  const speechCtx = new FakeCtx();  // speech.js's, learned when the first voice is routed
  s.alsoHear(speechCtx);
  s.alsoHear(speechCtx);            // twice is once
  assert.equal(s.heard.length, 1);

  s.setEars({ x: 0, y: 1.6, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
  for (const [what, c] of [['the room', s.ctx], ['the speech path', speechCtx]]) {
    assert.equal(c.listener.positionY.value, 1.6, what + ' has the head’s height');
    assert.equal(c.listener.forwardX.value, 1,
      what + ' is turned with him — a panner facing the default -Z puts every '
      + 'voice on the wrong side of the room');
  }
});

test('a Safari listener, which has only the deprecated pair, is moved too', async () => {
  const { Sound } = await load('bridge3d', 'sound.js');
  const old = { at: null, facing: null,
    setPosition(x, y, z) { this.at = [x, y, z]; },
    setOrientation(fx, fy, fz) { this.facing = [fx, fy, fz]; } };
  const s = new Sound();
  s.alsoHear({ listener: old });
  s.setEars({ x: 0, y: 1.6, z: 0 }, { x: 0, y: 0, z: -1 }, { x: 0, y: 1, z: 0 });
  assert.deepEqual(old.at, [0, 1.6, 0]);
  assert.deepEqual(old.facing, [0, 0, -1]);
});

test('the room’s own context is never listed twice as somewhere else to hear', async () => {
  const { Sound } = await load('bridge3d', 'sound.js');
  const s = new Sound();
  s.ctx = new FakeCtx();
  s.alsoHear(s.ctx);
  assert.deepEqual(s.heard, [], 'it is already the one setEars starts with');
});

test('a context that died is forgotten, not written to for the rest of the visit', async () => {
  const { Sound } = await load('bridge3d', 'sound.js');
  const s = new Sound();
  s.ctx = new FakeCtx();
  // An iOS audio-session interruption leaves speech.js's context closed; it
  // builds another, routes the next voice into it, and calls alsoHear again.
  const corpse = new FakeCtx();
  s.alsoHear(corpse);
  corpse.state = 'closed';
  const fresh = new FakeCtx();
  s.alsoHear(fresh);

  s.setEars({ x: 0, y: 1.6, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
  assert.equal(fresh.listener.positionY.value, 1.6, 'the context the voice is really in got the head');
  assert.deepEqual(s.heard, [fresh],
    'and the dead one was dropped the first frame after it died, rather than written to '
    + 'ninety times a second for the rest of the visit');
});
