// list.js — the mat on the floor that opens the board.
//
// This file used to hold a flat list of every card as well: rows you could read
// but not press, on a panel of its own. The board panel replaced it outright —
// same cards, readable titles, a filter, and every row one press deep — and two
// surfaces answering "where is that card" is a room he has to learn twice.
//
// What survives is the mat, which was always the good half: a control you
// glance DOWN at, below the band everything readable is held to, in the lane
// between the middle shelves where nothing else lives. It is deliberately not a
// surface you read, which is the only reason it is allowed to sit down there —
// still inside the 60° a neck will comfortably go to.

import * as THREE from 'three';
import * as W from './world.js';
import { root, Text, COL, fontFor, inert, safe } from './kit.js';
import { Target } from './hover.js';

// ---- the mat that summons the board ---------------------------------------

// How long a note stays up. Long enough to be read after he has looked down for
// it, short enough that it never becomes part of the furniture.
const NOTE_MS = 12000;

// And how much of one there can be. The mat is 0.41 m across and 0.25 m deep,
// meta type at that distance is ~0.039 m per em, so a line holds about twenty
// characters and 'the board' has already taken a line's worth of the depth —
// which leaves four lines, eighty characters. 'speech failed: ' plus whatever
// the engine said is unbounded, and type that runs off the plate is orange on
// pale stone, which is none of the contrast the colour was chosen for.
const NOTE_CHARS = 80;

// On the floor, dead ahead, in the lane where nothing else lives. A control you
// glance DOWN at rather than something you read — which is the only reason it is
// allowed to sit below the band everything readable is held to, and it is still
// inside the 60° a neck will comfortably go to.
//
// It was a translucent dark plate with dim type, which was right in a black room
// and became invisible the moment the room got a stone floor: measured on the
// rendered frame it was 1.24:1 against the deck and its own label was 1.78:1
// against it. So it takes the same grammar as every panel — an opaque dark
// plate, light type, and a bright rim carrying the shape — which is high
// contrast against pale stone in both directions.
export class ListPlate {
  constructor(onToggle) {
    const p = W.plate();
    this.at = p;
    this.group = new THREE.Group();
    this.group.position.set(p.pos.x, 0.002, p.pos.z);
    this.group.rotation.x = -Math.PI / 2;

    const face = new THREE.Mesh(
      new THREE.PlaneGeometry(p.widthM, p.depthM),
      new THREE.MeshBasicMaterial({ color: COL.panel }),
    );
    this.group.add(face);

    // The rim: an inlaid edge, which is what makes a dark plate on a pale floor
    // read as something set INTO the deck rather than as a hole in it.
    const rim = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.PlaneGeometry(p.widthM, p.depthM)),
      new THREE.LineBasicMaterial({ color: COL.rim }),
    );
    rim.position.z = 0.0006;
    this.group.add(rim);

    const spot = new THREE.Mesh(
      new THREE.RingGeometry(p.widthM * 0.44, p.widthM * 0.5, 28),
      new THREE.MeshBasicMaterial({ color: '#7fd8ff', transparent: true, opacity: 0.85, side: THREE.DoubleSide }),
    );
    spot.position.z = 0.001;
    spot.visible = false;
    this.group.add(spot);

    this.ui = root({
      sizeX: p.widthM, sizeY: p.depthM,
      justifyContent: 'center', alignItems: 'center', backgroundOpacity: 0,
    });
    inert(this.ui);
    this.ui.position.z = 0.002;
    this.group.add(this.ui);
    this.ui.add(new Text({
      text: 'the board', color: COL.text, fontWeight: 'semi-bold',
      fontSize: fontFor(W.TYPE.body, p.dist),
    }));
    // A second line, under it, empty until something has to be said to a person
    // who cannot see a toast — the speech engine refusing, the board not
    // answering. The mat is the surface for it: it is already in his view, it
    // already carries one line of type, and it is the only readable thing in
    // the room that is not a window he has to have opened.
    this.note = new Text({
      text: '', display: 'none', color: COL.warn, fontWeight: 'medium',
      fontSize: fontFor(W.TYPE.meta, p.dist),
    });
    this.ui.add(this.note);
    this.noteUntil = 0;

    this.target = new Target({
      mesh: face, spot, name: 'list-plate',
      base: new THREE.Color(COL.panel), onSelect: onToggle,
    });
  }

  // Nothing to say is NOT "clear it": the room writes its status line empty
  // whenever the stream reconnects, and a warning wiped by the next tick of a
  // clock is a warning he never read. A note times itself out instead.
  setNote(text) {
    // Through the same door every string the room paints goes through: the
    // atlas has the glyphs it has, and an em dash it cannot draw is a hole in
    // the middle of the sentence explaining why the room went quiet.
    const full = safe(text);
    if (!full) return;
    const t = full.length <= NOTE_CHARS ? full : full.slice(0, NOTE_CHARS - 3).trimEnd() + '...';
    this.note.setProperties({ text: t, display: 'flex' });
    this.noteUntil = performance.now() + NOTE_MS;
  }

  tick(now) {
    this.target.tick(now);
    if (this.noteUntil && now >= this.noteUntil) {
      this.noteUntil = 0;
      this.note.setProperties({ text: '', display: 'none' });
    }
  }
}
