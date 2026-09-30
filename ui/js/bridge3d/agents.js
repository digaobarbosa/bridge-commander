// agents.js — the lieutenants, as eight spheres that never move.
//
// Eight is small enough that a stable arc becomes a memorised landmark set for
// free, and that is the entire win here — so the positions are FIXED and are
// never sorted, reflowed or reordered for any reason. The roster fills the arc
// from the middle outward in a permanent order, which means a lieutenant joining
// never shifts one that is already there, and a half-crewed board is still
// centred rather than piled against one wall.
//
// The arc runs from 0° at the ends to +5° in the middle, above the shelves and
// never higher: looking up is the fastest route to a sore neck.
//
// And they are ALIVE. Each berth reads the board's own liveness — a running
// worker, a card waiting on the captain, an unanswered reply — and moves on it:
// a bob while a worker of theirs is running, a lift and a pulse when something
// of theirs wants him, and dead stillness otherwise. Motion driven by real
// state, never by a spinner: `world.md` is blunt that an object which never
// moves is furniture, and that a dead process is a still object, which beats
// any status string because it cannot go stale.
//
// Walking in and looking once should answer "who needs me", which is the only
// question he ever really asks this board.

import * as THREE from 'three';
import * as W from './world.js';
import { root, Container, Text, Image, COL, cm, fontFor, inert, safe } from './kit.js';
import { avatarTexture, hasAvatar } from './avatars3d.js';
import { crewLiveness, motionAt, SETTLE_S } from './liveness.js';
import { Target } from './hover.js';
import { isActor } from '../state.js';

export class Agents {
  constructor() {
    this.group = new THREE.Group();
    this.onSelect = null;          // set by main.js: what a press on a sphere does
    this.slots = [];
    for (let i = 0; i < W.AGENT.slots; i++) this.slots.push(this._slot(i));
  }

  _slot(i) {
    const at = W.agentAt(i);
    const g = new THREE.Group();
    g.position.set(at.pos.x, at.pos.y, at.pos.z);
    g.lookAt(0, W.EYE, 0);
    this.group.add(g);

    // A PORTRAIT, not a ball. The berth used to be a shaded sphere, which was
    // an improvement on a flat disc and still a thing rather than a person —
    // and a sphere cannot tell you which way it is turned, so it bought no
    // orientation either. A face looking back does both jobs: it says who, and
    // it says it is facing you.
    //
    // The disc is `ball` throughout because the hover machinery scales and
    // brightens whatever is called that, and renaming it would have been a
    // change to six other places for no gain.
    const R = W.AGENT.diaM / 2;
    const ball = new THREE.Group();
    g.add(ball);

    // The lieutenant's colour, as the rim around the portrait. Colour never
    // travels alone and here it is the one that never goes missing: an avatar
    // is optional, a colour is not, so the ring is what a crewless-of-avatars
    // board still reads by.
    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(R * 0.99, R * 0.13, 10, 40),
      new THREE.MeshStandardMaterial({ color: COL.faint, roughness: 0.35, metalness: 0.1, envMapIntensity: 1.1 }),
    );
    ball.add(rim);

    // The plate behind the face, so a berth with no avatar is still an object
    // and not a floating ring — and so the portrait has something opaque under
    // it rather than the sky.
    const backing = new THREE.Mesh(
      new THREE.CircleGeometry(R * 0.95, 32),
      new THREE.MeshStandardMaterial({ color: COL.panel, roughness: 0.6, metalness: 0.0 }),
    );
    backing.position.z = -0.002;
    ball.add(backing);

    const portrait = new THREE.Mesh(
      new THREE.CircleGeometry(R * 0.9, 32),
      // Basic, not standard: a photograph of a face lit AGAIN by the room's sun
      // comes out with a bright side and a dark side, which reads as a badly
      // exposed picture rather than as a person. It is already lit; it wants to
      // be shown, not shaded.
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true }),
    );
    portrait.visible = false;
    ball.add(portrait);

    // The drawn sphere is 5.16° and the thing that answers a ray is 6.06°, so
    // the collider is its own geometry rather than the ball itself. It draws
    // nothing at all — no colour, no depth — it only exists to be hit.
    const hitR = W.sphereForArc(W.BUILD.hit, at.dist);
    const hit = new THREE.Mesh(
      new THREE.SphereGeometry(hitR, 12, 8),
      new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }),
    );
    g.add(hit);

    // The proximity ring, on the plane facing the eye, closing to a dot as the
    // pointer comes in.
    const spot = new THREE.Mesh(
      new THREE.RingGeometry(hitR * 0.92, hitR, 32),
      new THREE.MeshBasicMaterial({ color: '#7fd8ff', transparent: true, opacity: 0.8, side: THREE.DoubleSide }),
    );
    spot.visible = false;
    g.add(spot);

    // Colour never travels alone: the name under the sphere is the second
    // channel, and it is what makes two lieutenants of similar hue two people.
    //
    // **It sits on a plate, and that is not decoration.** As bare type against
    // the sky it measured 1.3:1 to 2.2:1 on the rendered frame against a 4.5:1
    // floor — every single label, over sky and over parapet alike. Light type
    // has nothing to be light against once the room stopped being black, and
    // there is no colour that survives a background which changes as he turns
    // his head. So the label carries its own background with it, the same
    // grammar as every panel: dark plate, light type, a rim for the shape.
    // Darkening the sky would have been the other fix and it is the wrong one —
    // the sky is the thing that made this a place.
    const ui = root({
      sizeX: W.sizeForArc(W.AGENT.pitchDeg - W.BUILD.gap, at.dist),
      sizeY: W.sizeForArc(W.TYPE.body * 2.0, at.dist),
      justifyContent: 'center', alignItems: 'center', backgroundOpacity: 0,
    });
    inert(ui);
    ui.position.y = -(W.AGENT.diaM / 2 + W.sizeForArc(W.TYPE.body * 1.5, at.dist));
    g.add(ui);
    // The plate hugs the name rather than filling the berth: a nameplate as wide
    // as its slot is a row of bars, and the arc between two of them is the thing
    // that keeps eight spheres reading as eight people.
    const plate = new Container({
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
      paddingX: cm(W.sizeForArc(0.9, at.dist)),
      paddingY: cm(W.sizeForArc(0.28, at.dist)),
      borderRadius: cm(0.010),
      backgroundColor: COL.panel, backgroundOpacity: 0.96,
      borderWidth: cm(0.0022), borderColor: COL.rim, borderOpacity: 0.75,
    });
    inert(plate);
    ui.add(plate);
    // The face, before the name. It answers "which one is Selma" from across
    // the terrace, where a five-letter word at 1.4° of em box does not — and it
    // is the second channel the colour is not allowed to travel without.
    // Square, the height of the type it sits beside, and hidden entirely when
    // the lieutenant has no avatar, because the documented absent value means
    // the colour dot and never a blank square.
    const face = new Image({
      width: cm(W.sizeForArc(W.TYPE.body * 1.45, at.dist)),
      height: cm(W.sizeForArc(W.TYPE.body * 1.45, at.dist)),
      marginRight: cm(W.sizeForArc(0.5, at.dist)),
      borderRadius: cm(0.006), flexShrink: 0, display: 'none',
      objectFit: 'fill',
      // A photograph is not a UI shape and cannot be held to the 3:1 floor — that
      // would mean recolouring somebody's portrait. What CAN be held to it is
      // the face's own edge, so it gets the same rim every other shape in this
      // room is delineated by. Measured against the plate: a dark avatar came
      // out at 1.53:1 and its rim is 5.9:1.
      borderWidth: cm(0.0012), borderColor: COL.rim, borderOpacity: 0.85,
    });
    inert(face);
    plate.add(face);
    const label = new Text({
      text: '', color: COL.text, fontWeight: 'semi-bold',
      fontSize: fontFor(W.TYPE.body, at.dist),
    });
    inert(label);
    plate.add(label);

    // Pointing at a lieutenant and pressing opens its chat. The sphere is the
    // shortest route to the thing he actually came here to do, so it is the one
    // target in the room that needed no other justification.
    const target = new Target({
      mesh: hit, mark: ball, spot, name: 'lieutenant', base: new THREE.Color(COL.faint),
      onSelect: () => { const s = this.slots[i]; if (s.lt && this.onSelect) this.onSelect(s.lt); },
    });
    // A collider that draws nothing has no colour to change, so the hover state
    // lives on the ball's rim instead — same six states, painted where they can
    // actually be seen.
    target._paint = () => {
      const s = target.state;
      const hot = s === 'contact' || s === 'held';
      const lit = s !== 'idle';
      target._want = s === 'idle' || s === 'released' ? 1 : (hot ? W.STEP * 1.03 : W.STEP);
      // The rim carries the hover, because it is the part that is always there.
      rim.material.emissive.set(hot ? '#2a5f7a' : (lit ? '#16303f' : '#000000'));
      spot.visible = lit;
    };

    return {
      i, at, group: g, ball, rim, backing, portrait, hit, spot, ui, plate, face, label, target,
      lt: null,
      // Fixed per berth so the crew never pulses in unison. Irrational stride so
      // no two of the eight land in step with each other either.
      phase: i * 2.399963,
      state: 'idle', lift: 0, baseY: at.pos.y,
    };
  }

  // Who sits where. `index` is the lieutenant's place in the board's own roster,
  // and the mapping from that to a slot is fixed for the life of the roster.
  paint(doc) {
    const lts = doc.lieutenants || [];
    for (const s of this.slots) { s.lt = null; }
    lts.forEach((lt, index) => {
      const slot = W.agentSlotFor(index);
      if (slot < 0) return;
      const s = this.slots[slot];
      s.lt = lt;
      s.rim.material.color.set(W.agentColour(lt.color));
      s.label.setProperties({ text: safe(lt.name || lt.id) });
      const tex = avatarTexture(lt.avatar);
      s.face.setProperties(tex ? { src: tex, display: 'flex' } : { display: 'none' });
      // No avatar means the plate shows through in the owner's colour — the
      // room as it was, which is exactly what "absent" is documented to mean.
      s.portrait.visible = !!tex;
      if (tex) s.portrait.material.map = tex;
      s.backing.material.color.set(tex ? COL.panel : W.agentColour(lt.color));
      s.portrait.material.needsUpdate = true;
    });
    for (const s of this.slots) {
      const on = !!s.lt;
      s.ball.visible = on;
      s.ui.visible = on;
      // An empty berth answers no ray — `pointerEvents`, not `visible`, because
      // that is the property the pointer library actually reads.
      s.hit.pointerEvents = on ? 'listener' : 'none';
      // An empty berth is still a place — it says the arc holds eight and four
      // of them are not crewed, which is information rather than a gap.
      // An empty berth shows no nameplate at all — a plate with no name on it
      // is a thing he would try to read.
      s.plate.setProperties({ display: on ? 'flex' : 'none' });
      if (!on) { s.label.setProperties({ text: '' }); s.spot.visible = false; }
    }
  }

  // Where a message's author is standing, in world coordinates — or null for
  // anybody who is not on the arc (the captain, a worker, a lieutenant past the
  // eighth berth). `actor` is matched by state.js's isActor — the same rule
  // voice.js resolves by, so the two can never disagree about who someone is.
  placeOf(actor, out) {
    const s = this.slots.find((x) => isActor(x.lt, actor));
    return s ? s.group.getWorldPosition(out || new THREE.Vector3()) : null;
  }

  tick(now) {
    const t = now / 1000;
    for (const s of this.slots) {
      s.target.tick(now);
      if (!s.lt) continue;
      const m = motionAt(s.state, t, s.phase);
      // The lift eases; the bob does not need to, because it is already a sine
      // and starts from zero. `dt` is taken from the frame rather than assumed,
      // so a dropped frame moves things the right distance instead of stalling.
      const dt = Math.min(0.1, (now - (this._last || now)) / 1000);
      const want = W.sizeForArc(m.liftDeg, s.at.dist);
      s.lift += (want - s.lift) * Math.min(1, dt / SETTLE_S);
      s.group.position.y = s.baseY + s.lift + W.sizeForArc(m.bobDeg, s.at.dist);
      // The pulse rides the rim, which is the part that is always there — an
      // avatar is optional and a colour is not.
      if (m.glow > 0) s.rim.material.emissive.setScalar(m.glow * 0.42);
      else if (s.target.state === 'idle') s.rim.material.emissive.setScalar(0);
    }
    this._last = now;
  }

  // Read the board's liveness into the berths. Called from the same repaint that
  // follows every pushed board, so the room is never more than a beat
  // behind what the board knows.
  paintLiveness(doc) {
    const live = crewLiveness(doc);
    for (const s of this.slots) s.state = s.lt ? (live.get(s.lt.id) || 'idle') : 'idle';
  }
}
