// voice3d.js — a lieutenant's voice comes from where the lieutenant is standing.
//
// The room does NOT have a speech path of its own, and must not grow one. Which
// messages get spoken, whose voice speaks them, one at a time in a queue, the
// engine, the transport, the failure that says so out loud — all of that is
// `../voice.js`, which the flat board has been using since long before there was
// a room. This file is two small things bolted onto it:
//
// **A gesture.** `enter the bridge` is the click that starts the music bed, and
// it is the same click that turns the speech on. A room the captain walked into
// on purpose, with a bed already playing, that stays mute because a toggle on
// another page is off, is a bug he would report — so the room asks for sound.
// It does not REMEMBER that: the flat board's toggle stays his.
//
// **A direction.** On a flat board a message comes from the screen, so there is
// nowhere for it to come from and voice.js sends the sound straight out. Here
// the one who said it is standing on the arc, two metres away, and the whole
// reason this is worth doing in a headset rather than in a tab is that the voice
// arrives from that berth. So the room hands voice.js a route (speech.js's
// `route` hook), and the route is a panner placed where that lieutenant is.
//
// The panner is in SPEECH.JS'S context, not the room's. It has to be — the sound
// is rendered there, into the MediaStream the <audio> element plays, which is
// the whole reason the OS treats the page as a media player. Nothing about that
// element is touched. What it costs is that its context's listener has to be
// moved with the head too, which is `sound.alsoHear()`.
//
// Distance does NOT attenuate: `rolloffFactor = 0`. The berths are fixed and
// close, so distance carries no information here, and the only thing an inverse
// curve would buy is a crew that is quieter in a headset than on the board for
// no reason. Direction is the whole point; loudness stays exactly as it was.

import * as THREE from 'three';
import { setSpeechRoute, setVoiceOn, setSilenceReport, speakingAuthor, skipSpeaking } from '../voice.js';
import { isActor } from '../state.js';

const _at = new THREE.Vector3();

// `report` is how the room says something out loud in the only medium a person
// in a headset has: type on a surface he is standing in front of. voice.js's own
// answer is a toast, and a toast is a page element — this page has no CSS for
// one and an immersive session composites no page at all, so every way the board
// can fail to speak would fail silently in here. It is passed in rather than
// looked up because a file about panners has no business knowing about the DOM.
export function installVoice(sound, agents, report) {
  if (report) setSilenceReport(report);
  // One panner per author, kept because the berths never move and eight nodes
  // are cheaper than one per message. Dropped whole whenever the graph under
  // them changes — a context replaced after an audio-session interruption, or a
  // sink that fell back to the bare speakers — because a node of a dead context
  // renders nothing and would be silence that reports success.
  let ctx = null, dest = null;
  const panners = new Map();

  setSpeechRoute((who) => {
    if (!agents.placeOf(who, _at)) return null;   // not on the arc: from everywhere
    return (c, out) => {
      if (c !== ctx || out !== dest) {
        for (const p of panners.values()) { try { p.disconnect(); } catch (e) {} }
        panners.clear();
        ctx = c; dest = out;
        sound.alsoHear(c);
      }
      let pan = panners.get(who);
      if (!pan) {
        pan = c.createPanner();
        pan.panningModel = 'HRTF';
        pan.distanceModel = 'inverse';
        pan.refDistance = 1;
        pan.rolloffFactor = 0;        // direction, never volume — see the header
        pan.connect(out);
        panners.set(who, pan);
      }
      const at = agents.placeOf(who, _at) || _at;
      if (pan.positionX) {
        pan.positionX.value = at.x; pan.positionY.value = at.y; pan.positionZ.value = at.z;
      } else if (pan.setPosition) {
        pan.setPosition(at.x, at.y, at.z);   // Safari still ships only this one
      }
      return pan;
    };
  });
}

// Press the one that is talking and it shuts up. Entering the room turns speech
// on for the visit and there is nothing in here to turn it back off — no
// toolbar, and no keyboard on a face wearing a headset — so the lieutenant
// himself is the control. The press keeps its old meaning as well: the chat it
// opens is where the message he just silenced is written down. Matched by
// state.js's isActor (id OR name), because either can be the author stamped
// on a message. It cuts THAT message and nothing else — a reply from
// somebody on another berth is still waiting to be heard, and pressing this one
// is not a decision about it.
export function hush(lt) {
  const who = speakingAuthor();
  if (!isActor(lt, who)) return false;
  skipSpeaking();
  return true;
}

// The crew shuts up while he is dictating, and starts again when he stops.
//
// `hush` above is not enough for this and was never meant to be: it cuts ONE
// author's current message, because pressing a lieutenant is a decision about
// that lieutenant. A microphone is open to the whole room — anybody's voice
// arriving mid-sentence gets transcribed as if he had said it — so this is the
// blunt one, and it is the whole queue.
//
// Not remembered, same as askForSound: this is a state that lasts as long as
// his finger is on the trigger, and the flat board's toggle is his.
let held = false;
export function silence(on) {
  if (on && !held) { held = true; setVoiceOn(false, false); }
  else if (!on && held) { held = false; setVoiceOn(true, false); }
}

// The room asking for sound, from inside the gesture that entered it. Separate
// from installVoice because the route is wired at load — a message that arrives
// while he is still at the gate should already know where it is coming from —
// and this is a decision, made once, by a hand on a button.
export function askForSound() {
  setVoiceOn(true, false);   // not remembered — see the header
}
