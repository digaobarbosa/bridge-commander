// main.js — the board as a world you stand inside.
//
// The first room was a wall of live terminals and the captain killed it in one
// sentence. The second was panels — pictures of the board hanging in the air.
// The third was shelves of card-shaped slabs, and he could point at them but
// could not read a word: they were 1.19:1 against the surface they stood on,
// which is not "small", it is invisible.
//
// This is the fourth, and the difference is that it is a room he can WORK in.
// What is permanently there is small and legible: the crew, an aligned floor,
// and a mat. Everything else arrives when he asks for it and leaves when he is
// done — a chat, the board, a card — and lives wherever he puts it.
//
// It is now a room he can work in rather than look at. The lieutenants are the
// arc above: point at one and its conversation opens as a panel he can read,
// type into and put where he likes. The mat on the floor opens the board —
// every card, filterable, one press deep — and a press on a card brings its
// body and its thread forward on a surface of their own. Squeeze a title bar to
// pick a window up; once he has placed it, the room never moves it again.
//
// Every number is authored in DEGREES and lives in `world.js`; why those are the
// numbers lives in the `vr-design` skill and nowhere else. See the README beside
// this file for how to run and photograph it without a headset.

import * as THREE from 'three';
import * as W from './world.js';
import { Agents } from './agents.js';
import { ListPlate } from './list.js';
import { Rays, setVoice } from './hover.js';
import { Windows } from './windows.js';
import { ChatPanel } from './chat.js';
import { BoardWall, CardPanel } from './board.js';
import { routeKey, setKeyboard } from './keys.js';
import { SystemKeyboard, crumb, crumbs, clearCrumbs, beat, lastBeat } from './syskb.js';
import { Grabs } from './grab.js';
import { Sound } from './sound.js';
import { installVoice, askForSound, hush, silence } from './voice3d.js';
import * as talk from './talk.js';
import { trackMessages } from '../voice.js';
import { S, onBoard, onRender, lieutenants, lieutenant, cards, card, columnTitle } from '../state.js';
import { startLive } from '../live.js';
import { installSky, installToneMapping } from './sky.js';
import { buildTerrace, crewInlay, setAnisotropy } from './place.js';
import { updateRoots, sortTransparent, rootCount, COL } from './kit.js';

// What the room says out loud in type. #status is the gate's line, which is
// worth nothing once he is inside: it is hidden on entering and no page DOM
// composites into an immersive session anyway. So the same words also go on the
// mat, which is a surface he is standing in front of — see ListPlate.setNote.
// Declared before the mat exists because the WebGL failure below speaks first.
let plate = null;
const say = (m) => {
  const el = document.getElementById('status');
  if (el) el.textContent = m;
  if (plate) plate.setNote(m);
};

// The dev loop's two switches, both off unless the URL asks — see README.md.
// `?capture=1` keeps the drawing buffer so a screenshot is not an empty PNG;
// `?xr=emulate` puts a headset that is not there behind navigator.xr. Neither
// costs the normal room anything: false IS WebGLRenderer's default for
// preserveDrawingBuffer, and devxr.js is not so much as fetched without the flag.
const DEV = new URLSearchParams(location.search);

let renderer;
try {
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: DEV.has('capture') });
} catch (e) {
  say('no WebGL in this browser — ' + ((e && e.message) || e));
  throw e;
}
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
// three.js ships foveation at 1.0 — MAXIMUM — which renders the edges of the
// view at reduced resolution. The board runs out to ±28° and a window he has
// placed himself can be anywhere, so the default would blur exactly the prose
// he is reading. A room of small type pays the GPU instead.
renderer.xr.setFoveation(0);
installToneMapping(renderer);
sortTransparent(renderer);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
// Near at 0.3 m: closer than that a thing is intersecting his face, and nothing
// he reads is ever meant to be inside 0.5 m anyway.
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.3, 100);
camera.position.set(0, W.EYE, 0);
scene.add(camera);

// The sky, and the light it casts. Drawn into a canvas at startup and run
// through PMREM, so every surface here is lit BY somewhere rather than by
// lights we placed — see sky.js. One directional sun, one weak bounce, no
// shadow maps: a shadow map is the most expensive thing a mobile GPU can be
// asked for and the room buys nothing with it that a baked contact gradient
// does not.
const sky = installSky(renderer, scene);

// ---- the place, aligned to the real floor -----------------------------------
//
// Non-negotiable for orientation, and free: the session is `local-floor`, so
// y = 0 IS the floor he is standing on — and the terrace is built on it rather
// than floating over it.
setAnisotropy(renderer);
const terrace = buildTerrace(scene);
scene.add(crewInlay());

// ---- the room's contents ---------------------------------------------------

// The board as last pushed. state.js holds it (applyBoard, fed by live.js):
// voice.js reads the roster from there, so the room keeps no copy of its own.
const EMPTY = { cards: [], lieutenants: [], columns: [] };
const board = () => S.doc || EMPTY;

const agents = new Agents();
scene.add(agents.group);

// The mat on the floor ahead. It opens the BOARD — the one surface with every
// card on it, filterable, one press deep. There is no second flat list any
// more: two "every card" surfaces in one room is clutter he would have to
// learn his way around for no gain.
plate = new ListPlate(() => openBoard());
scene.add(plate.group);

const rays = new Rays(renderer, scene, camera, renderer.domElement);

// ---- the windows -----------------------------------------------------------
//
// Panels are the readable half of the room. They are created on demand, they
// remember where he put them, and they are the only surfaces in here carrying
// prose — everything else is a thing you recognise rather than read.

const windows = new Windows(scene);
const grabs = new Grabs(scene);

// The room's sound. Armed by the gesture that enters it, because every browser
// refuses audio until the page has been touched once — which is why this is
// created here and started in enter() rather than on load.
const sound = new Sound();
setVoice(sound);

// The system keyboard. It has nothing to do until a session starts and tells it
// whether this browser advertises one — before then, and on any browser that
// does not, every call into it is a no-op and text arrives the way it always
// has, from a paired bluetooth keyboard through the window's keydown.
//
// It is switched OFF in the room (MNC-87 — raising it takes a real headset
// down). `?syskb=1` turns it back on for one deliberate attempt, with the trail
// below to say where it died.
const PROBE = DEV.get('syskb') === '1';
const syskb = new SystemKeyboard(document, { enabled: PROBE });
setKeyboard(syskb);

// The crash log, printed on the gate of the NEXT load — the only place a man in
// a headset can read it, because whatever took the room down took its surfaces
// with it. Shown before anything else so it is the first thing on the page, and
// cleared when he enters again so a fresh attempt starts on a clean sheet.
// It has a box of its own rather than #status, which `say` overwrites with
// whatever the room is doing next.
const trail = crumbs();
if (trail.length) {
  const el = document.getElementById('crumbs');
  const pulse = lastBeat();
  if (el) {
    el.hidden = false;
    el.textContent = 'last attempt —\n' + trail.join('\n') + (pulse ? '\n' + pulse : '');
  }
}
window.addEventListener('error', (e) => crumb('ERROR ' + ((e && e.message) || e)));
window.addEventListener('unhandledrejection', (e) => crumb('REJECTED ' + ((e && e.reason && e.reason.message) || (e && e.reason) || '?')));

// And the crew is audible. The room speaks a lieutenant's message the same way
// the flat board does — same file, same voices, same queue — with one thing the
// flat board has no answer to: the voice comes from the berth the lieutenant is
// standing in. And when it cannot speak it says so on the mat, because a toast
// is invisible to a man in a headset. See voice3d.js.
installVoice(sound, agents, say);

// ...and they shut up while he is dictating. The crew speaks out loud now, the
// microphone is in the same room, and a lieutenant talking over him lands in
// the transcript as if he had said it. See voice3d.js.
talk.setHush(silence);

// Click a lieutenant, get its chat. This is the shortest path between "I can
// see my crew" and "I am talking to them", and it is the whole reason the
// spheres were worth drawing.
function openChat(lt) {
  // And if that is the one currently talking, the press shuts it up first — the
  // only stop control a person wearing a headset has. See voice3d.js.
  hush(lt);
  const key = 'lieutenant:' + lt.id;
  const p = windows.show(key, () => new ChatPanel({
    target: key,
    title: lt.name || lt.id,
    subtitle: 'chat',
    tint: W.agentColour(lt.color),
    onClose: (panel) => { sound.close(panel.group.position); windows.close(panel); },
  }));
  p.setTitle(lt.name || lt.id, 'chat');
  p.setTint(W.agentColour(lt.color));
  p.setFace(lt.avatar);
  p.paint(lt.chat);
  sound.open(p.group.position);
  return p;
}
agents.onSelect = openChat;

// The wall: sixty-odd cards at once across six tiles on a 120° arc, filtered by
// pressing a face rather than by typing a name, and one press deep. It is not a
// panel and it never was one — see board.js.
function openBoard() {
  const fresh = !windows.find('board');
  const p = windows.show('board', () => new BoardWall({
    onCard: openCard,
    onClose: (panel) => { sound.close(panel.group.position); windows.close(panel); },
  }));
  p.paint(board());
  if (fresh) sound.open(p.group.position);
  return p;
}

// A card, with its body and its thread on one surface — the deliverable and the
// way to answer it, which are one thing.
function openCard(c) {
  const lt = lieutenant(c.owner);
  const p = windows.show('card:' + c.id, () => new CardPanel({
    card: c, tint: W.agentColour(lt && lt.color),
    onClose: (panel) => { sound.close(panel.group.position); windows.close(panel); },
  }));
  p.setTint(W.agentColour(lt && lt.color));
  p.setFace(lt && lt.avatar);
  p.paintCard(c, lt, columnTitle(c.column));
  sound.open(p.group.position);
  return p;
}

function repaint() {
  const doc = board();
  agents.paint(doc);
  agents.paintLiveness(doc);
  // An open chat follows the board: the pushed board is what makes a reply arrive
  // while he is standing there, rather than on the next time he opens it.
  for (const p of windows) {
    if (!p.open) continue;
    if (p.key === 'board') { p.paint(doc); continue; }
    let m = /^lieutenant:(.+)$/.exec(p.key || '');
    if (m) { const lt = lieutenant(m[1]); if (lt) p.paint(lt.chat); continue; }
    m = /^card:(.+)$/.exec(p.key || '');
    if (m) {
      const c = card(m[1]);
      if (c) p.paintCard(c, lieutenant(c.owner), columnTitle(c.column));
    }
  }
}

// The room is on the same SSE stream as the flat board (live.js). A pushed doc
// marks the room dirty; the loop repaints at most every REPAINT_MS, because a
// burst of broadcasts re-laying out a wall of MSDF text would cost Quest frames.
const REPAINT_MS = 250;
let dirty = false, repainted = 0;
onRender(() => { dirty = true; });
// Whatever arrived since the last doc gets spoken. The first call is the one
// that seeds what has already been said, so walking in never replays the
// backlog — the same firstLoad the flat board has, and the same file.
onBoard(trackMessages);

// ---- entering --------------------------------------------------------------

const gate = document.getElementById('gate');

// The emulated headset installs itself over navigator.xr before anything asks
// navigator.xr a question, which is why this is started here and awaited in
// enter() rather than raced against the first click.
const emulated = DEV.get('xr') === 'emulate'
  ? import('./devxr.js').then((m) => m.install())
    .catch((e) => { say('the emulated headset did not install: ' + ((e && e.message) || e)); })
  : null;

// The live session, for the heartbeat in the loop. Null at a desk.
let xrsession = null;

async function enter() {
  // A fresh sheet: what is on the gate is the LAST attempt, and he has read it
  // by now. Everything from here belongs to this one.
  clearCrumbs();
  // Inside the gesture, before any await: a browser only allows audio to start
  // from a real user action, and an await here would put us outside it.
  sound.start(DEV.get('track'));
  askForSound();
  // The microphone, HERE, on the flat page. A permission prompt is a browser
  // surface and an immersive session composites none of them — asking once he
  // is inside suspends or ends it. So the stream is taken at the gate and
  // carried in, and a refusal is a line on the gate rather than a dead bar he
  // presses in the room and nothing happens. See talk.js.
  const asked = performance.now();
  const noMic = await talk.arm();
  // Granting the permission spends the press: `requestSession` wants a fresh
  // user gesture and the prompt outlived it. That only ever happens on the very
  // first entry, and the answer is one more press — said in those words rather
  // than as "the headset refused", which is what it looks like from here.
  const prompted = performance.now() - asked > 800;
  const mic = document.getElementById('mic');
  if (mic) {
    mic.hidden = !noMic;
    mic.textContent = noMic ? 'no microphone: ' + noMic + ' — everything else in the room works, but you cannot talk to a lieutenant' : '';
  }
  if (noMic) say('no microphone — ' + noMic);
  if (emulated) await emulated;
  const flat = (why) => { say(why); gate.hidden = true; };
  if (!navigator.xr) return flat('no WebXR in this browser — flat view: drag to look, click to point');
  const ok = await navigator.xr.isSessionSupported('immersive-vr').catch(() => false);
  if (!ok) return flat('no headset here — flat view: drag to look, click to point');
  let session;
  try {
    session = await navigator.xr.requestSession('immersive-vr', {
      optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'],
    });
  } catch (e) {
    if (prompted) return flat('the microphone question used up the press — press enter again');
    return flat('the headset refused the session: ' + ((e && e.message) || e));
  }
  await renderer.xr.setSession(session);
  gate.hidden = true;
  rays.setPresenting(true);
  // The keyboard's DOM field exists only for the length of the session. Meta's
  // doc asks for exactly that, and it is right to: an input left behind on the
  // flat board is a focus trap on a page he is about to be looking at again.
  xrsession = session;
  syskb.attach(session);
  // The two session-level facts the crash question turns on: whether the session
  // ENDED (he lands back on the gate) or the tab died (no crumb at all, and the
  // trail simply stops), and whether visibility went to `visible-blurred` the way
  // the doc says it does.
  session.addEventListener('visibilitychange', () => crumb('session visibility=' + session.visibilityState));
  session.addEventListener('end', () => {
    crumb('session END');
    xrsession = null;
    gate.hidden = false;
    rays.setPresenting(false);
    syskb.detach();
    talk.disarm();
  });
}

// ---- squeeze to pick a window up -------------------------------------------
//
// Squeeze, not trigger: the trigger presses things and the grip moves them, and
// only a window's title bar answers a squeeze at all. Wired here rather than in
// grab.js because the controllers belong to the renderer's session and the ray
// that says what is under the hand belongs to `rays`.
for (const c of rays.controllers) {
  c.addEventListener('squeezestart', () => {
    const p = grabs.start(c, rays.hits.get(c));
    if (p) { windows.touch(p); sound.grab(p.group.getWorldPosition(new THREE.Vector3())); }
  });
  c.addEventListener('squeezeend', () => {
    const p = grabs.end(c);
    if (p) sound.drop(p.group.getWorldPosition(new THREE.Vector3()));
  });
  // Letting go of the trigger stops the recording, WHEREVER the ray has
  // wandered to since it started. The talk bar's own pointerup would only
  // arrive if the ray were still on it, and a man speaking a sentence moves his
  // hand — a microphone that stays open because he drifted off the bar is the
  // one failure with no way out from inside a headset. talk.end() is a no-op
  // unless something is recording, so this costs every other press nothing.
  c.addEventListener('selectend', () => talk.end());
}
document.getElementById('enter').addEventListener('click', enter);

// ---- a desk, so this can be driven without a headset ------------------------
//
// Dragging turns the head; the mouse is the ray, through the same pointer
// library the controller uses, so a click at a desk and a trigger in a headset
// arrive at a target by the same route.

let dragging = false, yaw = 0, pitch = 0;
renderer.domElement.addEventListener('pointerdown', () => { dragging = true; });
window.addEventListener('pointerup', () => { dragging = false; talk.end(); });
window.addEventListener('pointermove', (e) => {
  if (!dragging || renderer.xr.isPresenting) return;
  yaw -= e.movementX * 0.003;
  pitch = Math.max(-1.3, Math.min(1.0, pitch - e.movementY * 0.003));
  camera.rotation.set(pitch, yaw, 0, 'YXZ');
});
// Keystrokes belong to whatever composer holds the keys — a chat panel takes
// them when it opens, and Enter inside it sends. `routeKey` is the room's own
// notion of that, and it runs first, which is what keeps the shortcuts below
// off while he is typing. The room DOES focus a DOM node, deliberately: the one
// in-viewport field in `syskb.js`, which is how the system keyboard is raised.
// While that field is focused `routeKey` leaves the characters to its `input`
// event. Why, and what the old crash really was, is in `keys.js` and `syskb.js`.
window.addEventListener('keydown', (e) => {
  if (routeKey(e)) return;
  if (e.key === 'b') openBoard();
  if (e.key === 'c') { const lts = lieutenants(); if (lts[0]) openChat(lts[0]); }
  if (e.key === 'x') windows.closeFront();
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---- loop -------------------------------------------------------------------

// Scratch vectors for the ear update, allocated once: the loop runs 90 times a
// second and three Vector3s a frame is garbage the frame budget will notice.
const _ear = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _q = new THREE.Quaternion();

let last = 0;
let pulsed = 0;
renderer.setAnimationLoop((t) => {
  const dt = last ? Math.min(0.1, (t - last) / 1000) : 0.016;
  last = t;
  // One line a second while the probe is on, overwritten rather than appended.
  if (PROBE && t - pulsed > 1000) {
    pulsed = t;
    beat('loop alive at ' + Math.round(t) + 'ms, visibility=' + (xrsession ? xrsession.visibilityState : 'no session'));
  }
  rays.update();
  const now = performance.now();
  if (dirty && now - repainted >= REPAINT_MS) { dirty = false; repainted = now; repaint(); }
  agents.tick(now);
  plate.tick(now);
  windows.tick(now);
  grabs.tick(dt);
  updateRoots(dt);
  // Inside a session the camera three.js renders with is the XR one, and it is
  // that transform the ears have to follow — the room's sounds are placed in
  // world coordinates and mean nothing without a listener that turns with him.
  const eye = renderer.xr.isPresenting ? renderer.xr.getCamera() : camera;
  eye.getWorldPosition(_ear);
  eye.getWorldDirection(_fwd);
  _up.set(0, 1, 0).applyQuaternion(eye.getWorldQuaternion(_q));
  sound.setEars(_ear, _fwd, _up);
  renderer.render(scene, camera);
});

// The handle the capture script and a console drive the room through.
window.__bridge = {
  agents, plate, scene, camera, rays, windows, grabs, sound, sky,
  openBoard: () => !!openBoard(),
  // The capture script and a console drive the panels through these — a chat
  // that can only be reached by aiming a ray is a chat no test can photograph.
  // Named, or else whoever has actually been talked to — a photograph of an
  // empty chat proves the frame renders and nothing about the prose in it.
  openChat: (id) => {
    const lt = (id && lieutenant(id))
      || lieutenants().slice().sort((a, b) => (b.chat || []).length - (a.chat || []).length)[0];
    return lt ? !!openChat(lt) : false;
  },
  // Named, or else the card with the most body on it — a photograph of an empty
  // card proves the frame renders and nothing about the prose in it.
  openCard: (id) => {
    const c = (id && card(id))
      || cards().slice().sort((a, b) => (b.body || '').length - (a.body || '').length)[0];
    return c ? !!openCard(c) : false;
  },
  // Hold to talk, by name. The bar answers a RAY and nothing else, and a ray is
  // the one thing a script cannot aim — so the press, the release and what came
  // back are here, on the chat that is open. Same reason openChat is.
  hold: () => { const p = frontChat(); if (p) p.startTalking(); return !!p; },
  letGo: () => { talk.end(); return talk.state(); },
  take: () => { const p = frontChat(); return (p && p.take) || null; },
  sendTake: () => { const p = frontChat(); if (p) p.sendTake(); return !!p; },
  panels: () => [...windows].filter((p) => p.open).map((p) => ({
    key: p.key, slot: p.slot, placed: p.placed,
    at: W.angleOf(p.group.position),
  })),
  // The wall, for the capture run and for a console: what it is showing, what
  // is filtering it, and how many uikit nodes it is made of — the last of which
  // is the number that has to be the same before and after a scroll.
  wall: () => { const p = windows.find('board'); return p && p.report ? p.report() : null; },
  wallFilter: (owner) => {
    const p = windows.find('board');
    if (!p || !p.toggleOwner) return null;
    p.toggleOwner(owner || (cards().find((c) => c.owner) || {}).owner);
    return p.report();
  },
  wallScroll: () => { const p = windows.find('board'); return p && p.scrollDeepestToEnd ? p.scrollDeepestToEnd() : null; },
  stats: () => ({
    roots: rootCount(),
    calls: renderer.info.render.calls,
    triangles: renderer.info.render.triangles,
    targets: targets().length,
  }),
  // What the ray is currently on, and how it is behaving about it. The capture
  // run reads this to prove the room is still pointable-at, which no photograph
  // can show.
  lit: () => targets().filter((t) => t.state !== 'idle')
    .map((t) => ({ name: t.name, state: t.state, distance: +t.distance.toFixed(2) })),
  get doc() { return board(); },
};

function frontChat() {
  return [...windows].reverse().find((p) => p.open && /^lieutenant:/.test(p.key || '')) || null;
}

function targets() {
  const out = [];
  scene.traverse((o) => { if (o.userData && o.userData.target) out.push(o.userData.target); });
  return out;
}

startLive({
  onConnection: (on) => {
    gate.classList.add('ready');
    say(on ? '' : 'the board is not answering - reconnecting');
  },
});
