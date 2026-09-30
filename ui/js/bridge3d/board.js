// board.js — the wall, and the card you took off it.
//
// Two surfaces, and the split between them is the one the whole room is built
// around: **what you HUNT for and what you READ are not the same thing.**
//
// The WALL is hunting, and it is a wall rather than a panel because eight rows
// out of sixty-eight is a peephole with a search box attached. It is FOUR flat
// tiles laid along a 120° arc at 1.50 m — one per board column, flat text on a
// curved surface — carrying eighteen rows each. Every figure in it is derived in
// world.js and the arithmetic is written out there; this file spends them.
//
// The lane is sized by the TITLE and not the other way round: 32 characters is
// the floor and it lands at 36, and that is what makes a lane 27.75° instead of
// 18.6°. The version that solved for cap height first fitted six lanes and
// sixteen characters, and sixteen characters of a fifty-three-character title
// is not a title.
//
// The RAIL under it is how you filter, and the point of it is that **filtering
// is one press and never a keystroke**. The lieutenants' faces are the control:
// press a face and the wall is that lieutenant's, press it again and it clears.
// A lane header does the same for its column. The text field is still there for
// free text and it ANDs with the rest.
//
// The CARD is reading. It is the hand panel — near, narrow, prose-shaped — and
// it carries the body, which is the deliverable, plus the thread, which is how
// you answer it.
//
// ---- the row pool, which is the part that is load-bearing ------------------
//
// Seventy-two rows are built ONCE at startup and never again. Scrolling a lane
// re-binds data into rows that already exist; it never makes or destroys a
// uikit node. The version of this that held a live node per card is the version
// that killed his headset browser at about sixty rows. `nodes()` is here so the
// claim can be checked rather than believed — dev/room-shots.js scrolls a lane
// to its end and asserts the count did not move by one.

import * as THREE from 'three';
import * as W from './world.js';
import { root, Container, Text, Image, COL, cm, fontFor, inert, safe } from './kit.js';
import { avatarTexture } from './avatars3d.js';
import { ChatPanel } from './chat.js';
import { addMarkdown } from './md3d.js';
import { Field } from './field.js';
import { Target } from './hover.js';
import { byId, byRecency, cardMatches } from '../state.js';

const D = W.WALL.distM;
const ROWS = W.wallRows();
const LANES = W.WALL.lanes;
const CHARS = W.wallChars();

// Everything on the wall, in metres at the distance the wall stands.
const ROW_M = W.sizeForArc(W.WALL.rowDeg, D);
const HEAD_M = W.sizeForArc(W.WALL.headDeg, D);
const PAD_M = W.sizeForArc(0.7, D);
// The row's own chrome, and it adds up to WALL_ROW_CHROME exactly — 0.5° of
// padding each side, a 0.9° owner bar, 0.3° of gap. What is left is the title,
// and the title is what the lane was sized for.
const ROW_PAD_M = W.sizeForArc(0.5, D);
const ROW_BAR_M = W.sizeForArc(0.9, D);
const ROW_GAP_M = W.sizeForArc(0.3, D);

// A tile: one flat uikit surface, turned to face the eye. Every tile stands at
// exactly WALL.distM and every one of them faces the head — the outer ones look
// bigger in a wide-angle frame because a 90° projection stretches its own
// edges, which is a property of the picture and not of the wall.
function tile(spec, properties) {
  const group = new THREE.Group();
  const ui = root({
    sizeX: spec.widthM, sizeY: spec.heightM, flexDirection: 'column',
    backgroundColor: COL.panel, backgroundOpacity: 0.98,
    borderRadius: cm(0.012),
    borderWidth: cm(0.0022), borderColor: COL.rim, borderOpacity: 0.5,
    ...properties,
  });
  group.add(ui);
  group.position.set(spec.pos.x, spec.pos.y, spec.pos.z);
  group.lookAt(0, W.EYE, 0);
  group.rotateX(-spec.tilt * Math.PI / 180);
  return { group, ui };
}

export class BoardWall {
  constructor({ onCard, onClose }) {
    this.name = 'wall';
    this.onCard = onCard;
    this.onClose = onClose;
    this.open = false;
    this.placed = false;
    this.slot = null;
    this.homeAz = 0;                 // furniture: it has a place, not a slot
    this.doc = { cards: [] };
    this.query = '';
    this.owner = null;               // a lieutenant id, or nothing
    this.column = null;              // a column id, or nothing
    this.spec = W.WALL;

    this.group = new THREE.Group();
    this.group.visible = false;
    this.targets = [];
    this.uis = [];
    this._nodes = 0;

    this.lanes = [];
    for (let i = 0; i < LANES; i++) this.lanes.push(this._lane(i));
    this._rail();
  }

  // ---- a lane: a header you press, and eighteen rows that recycle ----------
  _lane(i) {
    const spec = W.wallLaneAt(i);
    const t = tile(spec, {});
    this.group.add(t.group);
    this.uis.push(t.ui);

    const head = new Container({
      flexDirection: 'row', alignItems: 'center', flexShrink: 0,
      height: cm(HEAD_M), paddingX: cm(PAD_M), gap: cm(PAD_M),
      backgroundColor: COL.bar, backgroundOpacity: 1,
      borderTopLeftRadius: cm(0.012), borderTopRightRadius: cm(0.012),
      borderBottomWidth: cm(0.003), borderColor: COL.rim, borderOpacity: 0.5,
      hover: { backgroundColor: COL.barLit },
      active: { backgroundColor: '#2a5f7a' },
    });
    const title = new Text({
      text: '', flexGrow: 1, flexShrink: 1, flexBasis: 0, overflow: 'hidden',
      fontSize: fontFor(W.TYPE.wall, D), color: COL.text, fontWeight: 'semi-bold',
      wordBreak: 'keep-all',
    });
    const count = new Text({
      text: '', flexShrink: 0, fontSize: fontFor(W.TYPE.wall, D), color: COL.dim,
      wordBreak: 'keep-all',
    });
    inert(title); inert(count);
    head.add(title, count);
    t.ui.add(head);
    this._nodes += 3;

    // The lane body scrolls, and what scrolls inside it is TWO SPACERS and the
    // pool. The spacers carry the height of the rows that are not built, so the
    // scrollbar tells the truth about how much is under there while the node
    // count stays flat — which is the whole trick.
    const body = new Container({
      flexGrow: 1, flexDirection: 'column', overflow: 'scroll',
      scrollbarWidth: cm(W.sizeForArc(0.35, D)), scrollbarColor: COL.faint,
      scrollbarOpacity: 0.45, scrollbarBorderRadius: cm(0.003),
    });
    t.ui.add(body);
    const padTop = new Container({ width: '100%', height: 0, flexShrink: 0 });
    const padBottom = new Container({ width: '100%', height: 0, flexShrink: 0 });
    inert(padTop); inert(padBottom);
    body.add(padTop);
    this._nodes += 3;

    const lane = {
      i, tile: t, head, title, count, body, padTop, padBottom,
      rows: [], cards: [], first: 0, scrolled: 0, column: null, cont: false,
    };
    for (let r = 0; r < ROWS; r++) lane.rows.push(this._row(lane, r));
    body.add(padBottom);

    const headTarget = new Target({
      mesh: head, name: 'wall-head',
      onSelect: () => { if (lane.column) this.toggleColumn(lane.column.id); },
    });
    headTarget._paint = () => {};
    this.targets.push(headTarget);
    return lane;
  }

  // One row. A colour bar for the owner and a title, and the whole row is the
  // target — at 27.75° wide the horizontal scatter of a hand-held ray is
  // absorbed whole, and only the vertical is left to aim.
  _row(lane, r) {
    const box = new Container({
      width: '100%', height: cm(ROW_M), flexShrink: 0,
      flexDirection: 'row', alignItems: 'center',
      paddingX: cm(ROW_PAD_M), gap: cm(ROW_GAP_M),
      // Zebra rather than a rim: seventy-two rimmed boxes is a grid, and the shape
      // of a row at this density is carried better by an alternating fill. The
      // hover rim is what says "this one" — and it is the only affordance the
      // wall has, so it is loud.
      backgroundColor: r % 2 ? COL.slot : COL.panel, backgroundOpacity: 1,
      // The rim is always THERE and only ever changes COLOUR, so hovering a row
      // cannot reflow the seventy-two rows under it. It hides by matching the
      // plate rather than by going to zero opacity — `borderOpacity: 0` drew a
      // full-strength accent line on every row in the rendered frame, and a
      // wall where every row is lit is a wall with no hover state at all.
      borderWidth: cm(0.0025), borderColor: COL.panel,
      hover: { backgroundColor: COL.barLit, borderColor: COL.accent },
      active: { backgroundColor: '#2a5f7a' },
      display: 'none',
    });
    const bar = new Container({
      width: cm(ROW_BAR_M), height: '62%', flexShrink: 0,
      borderRadius: cm(0.002), backgroundColor: COL.faint,
    });
    const title = new Text({
      text: '', flexGrow: 1, flexShrink: 1, flexBasis: 0, overflow: 'hidden',
      fontSize: fontFor(W.TYPE.wall, D), lineHeight: 1.15,
      color: COL.text, wordBreak: 'keep-all',
    });
    inert(bar); inert(title);
    box.add(bar, title);
    lane.body.add(box);
    this._nodes += 3;

    const row = { box, bar, title, card: null };
    const t = new Target({
      mesh: box, name: 'wall-row',
      onSelect: () => {
        // A drag that scrolled the lane is not a press. uikit's scroll and this
        // row's pointerup arrive from the same gesture, so the guard is time:
        // if the lane moved in the last quarter second, he was scrolling.
        if (performance.now() - lane.scrolled < 250) return;
        if (row.card && this.onCard) this.onCard(row.card);
      },
    });
    t._paint = () => {};
    this.targets.push(t);
    return row;
  }

  // ---- the rail: eight faces, a field, and a way out -----------------------
  _rail() {
    const RD = W.RAIL.distM;
    const barM = W.sizeForArc(W.BUILD.hit, RD);
    const gapM = W.sizeForArc(W.BUILD.gap, RD);
    const padM = W.sizeForArc(W.RAIL.padDeg, RD);

    const left = tile(W.railTileAt(0), { padding: cm(padM), gap: cm(gapM) });
    const right = tile(W.railTileAt(1), { padding: cm(padM), gap: cm(gapM) });
    this.group.add(left.group, right.group);
    this.uis.push(left.ui, right.ui);

    // Eight faces, in the crew's own fixed order, four to a row. The order is
    // the arc's order and it never sorts — a control that moves is a control
    // you have to read every time instead of reaching for.
    this.faces = [];
    for (let r = 0; r < 2; r++) {
      // NOT `inert`. `pointerEvents: 'none'` is inherited the way CSS inherits
      // it, so a strip marked inert takes the eight faces inside it down with
      // it — which is exactly how the rail shipped dead the first time. A
      // container holding targets stays pointable and lets them answer.
      const strip = new Container({
        flexDirection: 'row', alignItems: 'center', gap: cm(gapM), height: cm(barM), flexShrink: 0,
      });
      left.ui.add(strip);
      this._nodes += 1;
      for (let k = 0; k < 4; k++) this.faces.push(this._face(strip, r * 4 + k, barM));
    }

    // The field: still here, still free text, and it ANDs with the faces rather
    // than replacing them. A Composer rather than uikit's Input, for the two
    // reasons in kit.js — and pressing it raises the system keyboard, so the
    // wall can be filtered by voice as well as by a face. Every character it
    // gets goes through `onChange` below, which is the same door a bluetooth
    // keystroke comes through, so a dictated word filters exactly like a typed
    // one. MNC-4 — "search all cards crashed the headset browser" — was the
    // off-screen element, not this press. See syskb.js.
    this.field = new Field({
      box: {
        width: '100%', height: cm(barM), flexShrink: 0,
        borderRadius: cm(0.008), paddingX: cm(padM),
      },
      fontSize: fontFor(W.TYPE.body, RD),
      placeholder: 'or type a word',
      chars: 26,                     // what a rail tile holds at body size
      onChange: (v) => { this.query = v; this.repaint(); },
    });
    right.ui.add(this.field.box);
    this._nodes += 2;
    const fieldTarget = new Target({
      mesh: this.field.box, name: 'wall-field', onSelect: () => this.field.take(),
    });
    fieldTarget._paint = () => {};
    this.targets.push(fieldTarget);

    const foot = new Container({
      flexDirection: 'row', alignItems: 'center', gap: cm(gapM), height: cm(barM), flexShrink: 0,
    });
    right.ui.add(foot);          // holds the two buttons, so never inert
    // What the wall is showing and what is filtering it, in words. A state you
    // cannot read is a state you cannot undo — and every filter named here is
    // undone by pressing the thing that set it, or all of them by `clear`.
    this.status = new Text({
      text: '', flexGrow: 1, flexShrink: 1, flexBasis: 0, overflow: 'hidden',
      fontSize: fontFor(W.TYPE.body, RD), color: COL.dim, wordBreak: 'keep-all',
    });
    inert(this.status);
    foot.add(this.status);
    this._nodes += 2;
    this.clearBox = this._button(foot, 'clear', barM, RD, () => this.clearFilters());
    this.closeBox = this._button(foot, 'x', barM, RD, () => {
      this.setOpen(false);
      if (this.onClose) this.onClose(this);
    });
  }

  _face(strip, slot, barM) {
    const RD = W.RAIL.distM;
    const box = new Container({
      width: cm(barM), height: cm(barM), flexShrink: 0,
      flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      borderRadius: cm(0.008), backgroundColor: COL.slot, backgroundOpacity: 1,
      borderWidth: cm(0.002), borderColor: COL.rim, borderOpacity: 0.5,
      hover: { borderColor: COL.accent, borderOpacity: 1 },
      active: { backgroundColor: '#2a5f7a' },
    });
    const face = new Image({
      width: '76%', height: '76%', flexShrink: 0, objectFit: 'fill',
      borderRadius: cm(0.005), display: 'none',
    });
    // The colour under the face, so a lieutenant is never only a colour and
    // never only a picture — and it is the same colour the rows carry.
    const chip = new Container({
      width: '76%', height: cm(W.sizeForArc(0.8, RD)), flexShrink: 0,
      marginTop: cm(W.sizeForArc(0.3, RD)),
      borderRadius: cm(0.002), backgroundColor: COL.faint,
    });
    inert(face); inert(chip);
    box.add(face, chip);
    strip.add(box);
    this._nodes += 3;

    const seat = { box, face, chip, lt: null };
    const t = new Target({
      mesh: box, name: 'wall-face',
      onSelect: () => { if (seat.lt) this.toggleOwner(seat.lt.id); },
    });
    t._paint = () => {};
    this.targets.push(t);
    return seat;
  }

  _button(parent, label, barM, distM, onSelect) {
    const box = new Container({
      height: cm(barM), paddingX: cm(W.sizeForArc(1.4, distM)), flexShrink: 0,
      justifyContent: 'center', alignItems: 'center',
      borderRadius: cm(0.008), backgroundColor: COL.slot, backgroundOpacity: 1,
      borderWidth: cm(0.002), borderColor: COL.rim, borderOpacity: 0.5,
      hover: { backgroundColor: '#2a5f7a', borderColor: COL.accent },
      active: { backgroundColor: COL.accent },
    });
    const t = new Text({ text: safe(label), fontSize: fontFor(W.TYPE.body, distM), color: COL.text });
    inert(t);
    box.add(t);
    parent.add(box);
    this._nodes += 2;
    const target = new Target({ mesh: box, name: 'wall-' + label, onSelect });
    target._paint = () => {};
    this.targets.push(target);
    return box;
  }

  // ---- filtering, which is pressing ----------------------------------------

  toggleOwner(id) { this.owner = this.owner === id ? null : id; this.repaint(); }
  toggleColumn(id) { this.column = this.column === id ? null : id; this.repaint(); }
  clearFilters() {
    this.owner = null; this.column = null; this.query = '';
    if (this.field) this.field.setValue('');
    this.repaint();
  }
  filters() {
    const on = [];
    if (this.owner) on.push((byId(this.doc.lieutenants).get(this.owner) || {}).name || this.owner);
    if (this.column) on.push(shortColumn((byId(this.doc.columns).get(this.column) || {}).title || this.column));
    if (this.query.trim()) on.push('"' + this.query.trim() + '"');
    return on;
  }

  // ---- painting -------------------------------------------------------------

  paint(doc) {
    this.doc = doc || { cards: [] };
    if (this.open) this.repaint();
  }

  // Which lanes belong to which column. Recomputed on OPEN and never while he
  // is standing in front of it — see world.js.
  repaint() {
    const lts = byId(this.doc.lieutenants);
    const all = this.doc.cards || [];
    // The flat board's filter rule, with the wall's three controls as its filter.
    const filter = {
      text: this.query,
      sel: this.owner ? [{ kind: 'owner', value: this.owner, mode: 'in' }] : [],
      columns: this.column ? [this.column] : [],
    };
    const kept = all.filter((c) => cardMatches(c, filter, this.doc));

    // **One lane per board column.** That is what makes a column a column, and
    // it is the whole reason a lane is 27.75° wide and a title is 36 characters
    // rather than 16: sharing lanes out by how full a column was bought twenty
    // more rows and cost half of every title.
    const frame = this.doc.columns || [];
    let shown = 0;
    this.lanes.forEach((lane, i) => {
      lane.column = frame[i] || null;
      const id = lane.column && lane.column.id;
      const mine = id ? kept.filter((c) => c.column === id).sort(byRecency) : [];
      lane.cards = mine;
      lane.title.setProperties({ text: safe(shortColumn((lane.column && lane.column.title) || id || '')) });
      lane.count.setProperties({ text: safe(String(mine.length)) });
      lane.head.setProperties({ backgroundColor: this.column && this.column === id ? '#2a5f7a' : COL.bar });
      lane.first = Math.max(0, Math.min(lane.first, lane.cards.length - ROWS));
      this._bind(lane, lts);
      shown += Math.max(0, Math.min(lane.cards.length - lane.first, ROWS));
    });

    const on = this.filters();
    this.status.setProperties({
      text: safe(on.length ? shown + ' of ' + all.length + ' - ' + on.join(', ') : shown + ' of ' + all.length),
    });
    this.clearBox.setProperties({ backgroundOpacity: on.length ? 1 : 0.25 });

    // The crew, in the arc's own fixed order: face `i` on the rail is the
    // lieutenant standing in berth `i` above it, so reaching for a face is the
    // same reach as reaching for the sphere.
    const roster = this.doc.lieutenants || [];
    this.faces.forEach((seat, i) => {
      const lt = roster[W.AGENT_ORDER.indexOf(i)] || null;
      seat.lt = lt;
      // An empty berth KEEPS ITS PLACE. Hiding it slides every face left, and a
      // control that moves when the crew changes is a control he has to read
      // instead of reach for — the same rule the arc of spheres is built on.
      seat.box.setProperties({
        backgroundOpacity: !lt ? 0.25 : (!this.owner || this.owner === lt.id ? 1 : 0.3),
        borderColor: lt && this.owner === lt.id ? COL.accent : COL.rim,
        borderOpacity: lt ? (this.owner === lt.id ? 1 : 0.5) : 0.2,
      });
      if (!lt) { seat.face.setProperties({ display: 'none' }); seat.chip.setProperties({ backgroundColor: COL.slot }); return; }
      // A crew that is not the filter goes quiet — on the FACE and not only on
      // the box behind it, or the picture stays at full strength and the state
      // is carried by a rim alone.
      const dim = this.owner && this.owner !== lt.id ? 0.35 : 1;
      const tex = avatarTexture(lt.avatar);
      seat.face.setProperties(tex ? { src: tex, display: 'flex', opacity: dim } : { display: 'none' });
      seat.chip.setProperties({ backgroundColor: W.agentColour(lt.color) });
    });
  }

  // The recycling itself: every row already exists, so this only ever rewrites
  // text and colour. The two spacers carry the height of what is not built.
  _bind(lane, lts) {
    const first = lane.first;
    lane.rows.forEach((row, r) => {
      const c = lane.cards[first + r];
      row.card = c || null;
      row.box.setProperties({ display: c ? 'flex' : 'none' });
      if (!c) return;
      const lt = lts.get(c.owner);
      row.bar.setProperties({ backgroundColor: W.agentColour(lt && lt.color) });
      const full = safe(c.title || c.id);
      row.whole = full.length <= CHARS;
      // Cut in JS with an ellipsis rather than letting the glyphs run into the
      // lane's edge. A title that stops dead at the panel boundary reads as a
      // title hidden BEHIND the next panel — that is exactly how this surface
      // was read on review, and the tiles were never overlapping. Three dots
      // inside the plate say "shortened here" and cannot be mistaken for it.
      row.title.setProperties({ text: row.whole ? full : full.slice(0, CHARS - 3).trimEnd() + '...' });
    });
    const rowU = cm(ROW_M);
    lane.padTop.setProperties({ height: first * rowU });
    lane.padBottom.setProperties({ height: Math.max(0, lane.cards.length - first - ROWS) * rowU });
  }

  // ---- the room's panel contract -------------------------------------------

  place() { return this; }           // a wall has a place, and this is it

  setOpen(on) {
    this.open = on;
    this.group.visible = on;
    for (const ui of this.uis) ui.setProperties({ display: on ? 'flex' : 'none' });
    // The wall does not take the keys on open — opening the board is looking,
    // not typing — but a wall that closes while its field holds them would take
    // `b`/`c`/`x` down with it.
    if (on) this.repaint(); else if (this.field) this.field.release();
  }

  // How many uikit components the wall is made of. Constant from construction
  // to close — that is the assertion, and dev/room-shots.js makes it.
  nodes() { return this._nodes; }

  // What the wall is currently showing, for the capture run and for a console.
  //
  // **`legible` is the number, and `shown` is not.** Counting rows that exist
  // is what put "53 of 70" on a wall of sixteen-character stubs. A title counts
  // as legible only when all three hold: it is BOUND to a row, its text is
  // WHOLE — no ellipsis, the card's own title end to end — and nothing covers
  // it, which `wallTileGap` decides for the whole wall at once because the
  // tiles either clear each other or they do not.
  report() {
    const gap = W.wallTileGap(0);
    const clear = gap > 0;
    let shown = 0, legible = 0;
    const lens = [];
    for (const lane of this.lanes) {
      const n = Math.max(0, Math.min(lane.cards.length - lane.first, ROWS));
      shown += n;
      for (const row of lane.rows) if (row.card) { if (row.whole && clear) legible++; }
    }
    for (const c of this.doc.cards || []) lens.push(safe(c.title || c.id).length);
    lens.sort((a, b) => a - b);
    return {
      nodes: this._nodes,
      rows: ROWS, lanes: LANES, seats: W.wallSeats(), chars: CHARS,
      cards: (this.doc.cards || []).length,
      shown,
      legible,
      tileGapDeg: +gap.toFixed(2),
      tileGapLeaningDeg: +W.wallTileGap(0.20).toFixed(2),
      titleLen: lens.length ? { min: lens[0], median: lens[Math.floor(lens.length / 2)], max: lens[lens.length - 1] } : null,
      filters: this.filters(),
      lane: this.lanes.map((l) => ({
        column: (l.column && l.column.id) || null, held: l.cards.length, first: l.first,
      })),
    };
  }

  // Drive the deepest lane to the bottom of its own column. The node count is
  // read either side of this in dev/room-shots.js, and the whole design of the
  // pool is the claim that it does not move.
  scrollDeepestToEnd() {
    let lane = null;
    for (const l of this.lanes) if (!lane || l.cards.length > lane.cards.length) lane = l;
    if (!lane) return null;
    const max = lane.body.maxScrollPosition && lane.body.maxScrollPosition.value;
    lane.body.scrollPosition.value = [0, max ? max[1] : 0];
    return { lane: lane.i, held: lane.cards.length, to: max ? max[1] : 0 };
  }

  tick(now) {
    for (const t of this.targets) t.tick(now);
    // Scrolling is the only thing that moves a card into a row, and it is read
    // rather than subscribed to: one number per lane per frame against a signal
    // subscription per lane is not a trade worth making.
    for (const lane of this.lanes) {
      const pos = lane.body.scrollPosition && lane.body.scrollPosition.value;
      if (!pos) continue;
      const first = Math.max(0, Math.min(Math.round(pos[1] / cm(ROW_M)),
        Math.max(0, lane.cards.length - ROWS)));
      if (first === lane.first) continue;
      lane.first = first;
      lane.scrolled = now;
      this._bind(lane, byId(this.doc.lieutenants));
    }
  }
}

// ---- the card ---------------------------------------------------------------

// The card body AND its thread on one surface, because they are one thing: the
// body is what the work IS and the thread is how he changes it. It is a
// ChatPanel because the composer, the sending and the tail-painting are all
// identical — the only difference is that a card's prose sits above its
// conversation.
export class CardPanel extends ChatPanel {
  constructor({ card, tint, onClose }) {
    super({ target: 'card:' + card.id, title: card.title || card.id, subtitle: '', tint, onClose });
    this.card = card;
  }

  paintCard(card, lt, columnTitle) {
    this.setFace(lt && lt.avatar);
    // A card he has just opened starts at the TOP: the body is the deliverable
    // and he came to read it from the beginning. A chat starts at the bottom
    // because the newest line is the point of it. Same panel, opposite ends,
    // and only on the first paint — after that the scroll is his.
    if (this.card !== card || !this._seen) { this._toTop = 3; this._seen = true; }
    this.card = card;
    this.setTitle(card.title || card.id, [columnTitle, lt && (lt.name || lt.id), card.type].filter(Boolean).join('  -  '));
    this._lastPainted = '';       // the body changed, so the tail has to repaint
    this.paint(card.thread);
  }

  // The card's own prose goes in first, then the conversation under it. Both
  // land in the same scrolling body, so reading a long card and then reading
  // what was said about it is one gesture rather than two surfaces.
  paint(messages) {
    const list = (messages || []).slice(-12);
    const stamp = (this.card ? this.card.id + ':' + (this.card.updated || '') : '')
      + '|' + list.length + '|' + (list.length ? list[list.length - 1].ts : '');
    if (stamp === this._lastPainted) return;
    this._lastPainted = stamp;

    this.clearBody();
    const c = this.card || {};
    if (c.id) this.addText(c.id, { size: W.TYPE.meta, color: COL.faint });
    const prs = ((c.attributes && c.attributes.prs) || []).map((p) => p.state).join(', ');
    if (prs) this.addText('pr: ' + prs, { size: W.TYPE.meta, color: COL.dim });
    // The body is markdown, and it is the deliverable — so it is BUILT rather
    // than printed. `addText` here meant `##` arrived as two hash marks.
    if (c.body) addMarkdown(this, c.body);
    else this.addText('no body yet', { color: COL.dim });
    if (list.length) {
      this.addText('- the thread -', { size: W.TYPE.meta, color: COL.faint });
      for (const m of list) this.addMessage(m);
    }
    if (!this._toTop) this.scrollToEnd();
  }

  tick(now) {
    super.tick(now);
    if (!this._toTop) return;
    if (this.body.maxScrollPosition && this.body.maxScrollPosition.value) {
      this.body.scrollPosition.value = [0, 0];
      this._toTop--;
    }
  }
}

// "Your review" is the useful half of "👀 Your review", and the emoji is not in
// the font's atlas anyway — it carries 172 glyphs and not one emoji.
function shortColumn(title) {
  return String(title || '').replace(/^[^\w]+/, '').trim();
}
