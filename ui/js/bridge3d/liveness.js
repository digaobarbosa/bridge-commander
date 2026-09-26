// liveness.js — which of the crew is working, and which one wants him.
//
// The roadmap's headline finding was that the room read **none** of the state
// the board already serves: `status.worker.state`, `owed`, `owedState`,
// `unread`, `activity`, `chatOwed`. The server derives all of it on every
// payload and the room threw it away at the door, then drew the board's
// structure — which is the part a flat kanban already does better.
//
// This is the door opening. `world.md`: *an object that never moves is
// furniture*, and a dead process is a still object, which beats any status
// string because it cannot go stale.
//
// Three states and no more, because the question he actually asks this board is
// "who needs me", and a vocabulary with six answers does not answer it faster:
//
//   wants-you  something of theirs is waiting on HIM
//   working    a worker of theirs is running right now
//   idle       neither — and idle is STILL, which is what makes the other two
//              legible at all
//
// Pure: no three.js, no DOM, one function of the board payload. That is
// deliberate — what "working" means is a rule about the board, and a rule about
// the board should be arguable in a test rather than only in a headset.

import { USER, readMarker, unreadCount } from '../state.js';

// Whether the captain has seen the last thing this lieutenant said. The read
// markers and the unread rule are the flat board's own (state.js), so the room
// agrees with the board about what is unread rather than inventing a second
// opinion. One deliberate addition: the room never marks a chat read, so the
// captain having the last word counts as having read it.
export function unansweredReply(lt, reads) {
  const chat = (lt && lt.chat) || [];
  const last = chat[chat.length - 1];
  if (!last || last.author === USER) return false;
  return unreadCount([last], readMarker(reads, 'lieutenant:' + (lt.id || ''))) > 0;
}

// One lieutenant's state, from the whole payload. Precedence matters and it is
// not alphabetical: a lieutenant who is both running a worker AND sitting on
// something unread is one he needs to look at, so wants-you wins. The louder
// state is never masked by the busier one.
export function livenessOf(lt, doc) {
  if (!lt) return 'idle';
  const cards = (doc && doc.cards) || [];
  const mine = cards.filter((c) => c.owner === lt.id);
  const worker = (c) => ((c.status && c.status.worker) || {}).state;

  // Waiting on him: a worker that has stopped and asked for him, a card whose
  // timeline he has not read, or the last word in their chat being theirs.
  const needs = mine.some((c) => worker(c) === 'needs-you')
    || mine.some((c) => c.status && c.status.unread)
    || unansweredReply(lt, doc && doc.reads);
  if (needs) return 'wants-you';

  // Actually running. `working` is a LEASE the worker refreshes and the server
  // decays on read, so this cannot be stale in the way a flag would be.
  if (mine.some((c) => worker(c) === 'working')) return 'working';

  return 'idle';
}

// The whole crew at once, as id → state.
export function crewLiveness(doc) {
  const out = new Map();
  for (const lt of (doc && doc.lieutenants) || []) out.set(lt.id, livenessOf(lt, doc));
  return out;
}

// ---- what each state looks like --------------------------------------------
//
// All of it is ~10x under the 3 Hz flicker floor: the periphery is where flicker
// is felt hardest and this room is mostly periphery. Amplitudes are in DEGREES
// at the berth's own distance, like everything else here — a 1° bob at 2.0 m is
// 35 mm.
export const MOTION = {
  // Working: a slow bob. Rate carries the information and needs no glyph — a
  // busy thing moves, a quiet one does not, and you notice when it stops.
  working: { hz: 0.5, bobDeg: 0.55, liftDeg: 0, pulse: 0 },
  // Wants you: LIFTS out of the rank, and pulses. The lift is what makes it
  // findable in peripheral vision without reading anything, because it breaks
  // the line the other seven make.
  'wants-you': { hz: 0.85, bobDeg: 0.22, liftDeg: 1.7, pulse: 0.55 },
  // Idle: nothing at all. This is not an omission — stillness is the state, and
  // it is what the other two are legible against.
  idle: { hz: 0, bobDeg: 0, liftDeg: 0, pulse: 0 },
};

// Where a berth should sit and how brightly it should glow, right now.
// `phase` is per-berth so the crew reads as individuals: eight things rising and
// falling in unison is a system animation, and eight offset is eight people.
export function motionAt(state, seconds, phase = 0) {
  const m = MOTION[state] || MOTION.idle;
  const t = seconds * m.hz * Math.PI * 2 + phase;
  return {
    // Eased into over LIFT_S rather than snapped, so a state change is a thing
    // that happens rather than a thing that has happened.
    liftDeg: m.liftDeg,
    bobDeg: m.hz ? Math.sin(t) * m.bobDeg : 0,
    glow: m.pulse ? (0.5 + 0.5 * Math.sin(t)) * m.pulse : 0,
  };
}

// How long a berth takes to move between states. Above the 300 ms that reads as
// a snap and well under the 500 ms that reads as a drag.
export const SETTLE_S = 0.45;
