// The room, measured. Not "the constants say 6°" — the constants saying 6° is
// exactly what cannot fail when the box built from them arrives at 4.7°, and
// that is what shipped once already.
//
// So everything below builds the room's real geometry, puts the four corners of
// every responsive region into world coordinates, and re-derives the arc from
// the angle between direction vectors out of the eye — acos of a dot product,
// which is a different formula from the atan construction under test. A
// measurement taken with the code under test is not a measurement.
//
// The floors themselves live in the `vr-design` skill and are not restated here
// beyond the names world.js gives them.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const UI = path.join(ROOT, 'ui', 'js', 'bridge3d');
const load = (f) => import(path.join(UI, f));

const DEG = 180 / Math.PI;
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const between = (a, b) => Math.acos(Math.max(-1, Math.min(1, dot(a, b) / (len(a) * len(b))))) * DEG;
const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];

// ---- the room, built ------------------------------------------------------
//
// Every responsive region in the standing world, as four world-space corners
// plus the eye it is seen from. `kind` is only for the failure message.

async function room() {
  const W = await load('world.js');
  const eye = [0, W.EYE, 0];
  const out = [];

  // The lieutenants. A sphere's region is a sphere: it subtends 2·asin(r/d) in
  // every direction at once, so it is described by its own angular radius
  // rather than by four corners that would only ever approximate one.
  for (let i = 0; i < W.AGENT.slots; i++) {
    const a = W.agentAt(i);
    const c = [a.pos.x, a.pos.y, a.pos.z];
    const d = len(sub(c, eye));
    const half = (R) => 2 * Math.asin(R / d) * DEG;
    out.push({
      kind: `lieutenant ${i}`, eye, hit: true, sphere: true, centre: c, dist: d,
      arc: half(W.sphereForArc(W.BUILD.hit, a.dist)),
      markArc: half(W.AGENT.diaM / 2),
    });
  }

  // The mat that opens the board, lying flat on the floor.
  const p = W.plate();
  const pc = [p.pos.x, p.pos.y, p.pos.z];
  out.push({
    kind: 'board mat', eye, hit: true, floor: true,
    corners: [[pc[0] - p.widthM / 2, 0, pc[2] - p.depthM / 2], [pc[0] + p.widthM / 2, 0, pc[2] - p.depthM / 2],
      [pc[0] - p.widthM / 2, 0, pc[2] + p.depthM / 2], [pc[0] + p.widthM / 2, 0, pc[2] + p.depthM / 2]],
  });
  return { W, eye, regions: out };
}

// The region's arc, from the angle between the directions to the midpoints of
// its opposite edges — top-left/top-right/bottom-left/bottom-right order. This
// is acos of a dot product, which is a different derivation from the atan
// construction under test, which is the whole point of doing it here.
function arcOf(r, which) {
  if (r.sphere) { const a = which === 'mark' ? r.markArc : r.arc; return { w: a, h: a }; }
  const [tl, tr, bl, br] = which === 'mark' ? r.mark : r.corners;
  const l = sub(mid(tl, bl), r.eye), rt = sub(mid(tr, br), r.eye);
  const t = sub(mid(tl, tr), r.eye), b = sub(mid(bl, br), r.eye);
  return { w: between(l, rt), h: between(t, b) };
}

const hasMark = (r) => (r.sphere ? r.markArc != null : !!r.mark);

// Where a region sits, as a box in azimuth and elevation, plus how far away it
// is. Two targets have to be 1.6° of ARC apart, and a degree of azimuth is only
// cos(elevation) of a degree of arc — so the horizontal gap is converted where
// it is compared, further down.
function extent(r) {
  if (r.sphere) {
    const v = sub(r.centre, r.eye);
    const flat = Math.hypot(v[0], v[2]);
    const el = Math.atan2(v[1], flat) * DEG;
    const az = Math.atan2(v[0], -v[2]) * DEG;
    const halfAz = r.arc / 2 / Math.cos(el * Math.PI / 180);
    return {
      l: az - halfAz, r: az + halfAz, b: el - r.arc / 2, t: el + r.arc / 2,
      near: r.dist, far: r.dist, mid: r.dist, el,
    };
  }
  const az = [], el = [], d = [];
  for (const c of r.corners) {
    const v = sub(c, r.eye);
    const flat = Math.hypot(v[0], v[2]);
    az.push(Math.atan2(v[0], -v[2]) * DEG);
    el.push(Math.atan2(v[1], flat) * DEG);
    d.push(len(v));
  }
  return {
    l: Math.min(...az), r: Math.max(...az), b: Math.min(...el), t: Math.max(...el),
    near: Math.min(...d), far: Math.max(...d), mid: (Math.min(...d) + Math.max(...d)) / 2,
    el: (Math.min(...el) + Math.max(...el)) / 2,
  };
}

// A region's boundary, as world points all the way round it — enough of them
// that the smallest gap between two regions is found where it really is rather
// than only at the four corners.
const STEPS = 8;
function outline(r) {
  const out = [];
  if (r.sphere) {
    // A sphere's outline is its silhouette circle, drawn on the plane facing the
    // eye at the radius that actually subtends its arc.
    const v = sub(r.centre, r.eye);
    const R = r.dist * Math.sin(r.arc / 2 * Math.PI / 180);
    const right = [-v[2], 0, v[0]];
    const rl = len(right);
    const rn = [right[0] / rl, 0, right[2] / rl];
    const up = [rn[1] * v[2] - rn[2] * v[1], rn[2] * v[0] - rn[0] * v[2], rn[0] * v[1] - rn[1] * v[0]];
    const ul = len(up);
    const un = [up[0] / ul, up[1] / ul, up[2] / ul];
    for (let k = 0; k < 4 * STEPS; k++) {
      const t = (k / (4 * STEPS)) * Math.PI * 2;
      out.push([
        r.centre[0] + R * (Math.cos(t) * rn[0] + Math.sin(t) * un[0]),
        r.centre[1] + R * Math.sin(t) * un[1],
        r.centre[2] + R * (Math.cos(t) * rn[2] + Math.sin(t) * un[2]),
      ]);
    }
    return out;
  }
  const [tl, tr, bl, br] = r.corners;
  const walk = (a, b) => {
    for (let k = 0; k < STEPS; k++) {
      const t = k / STEPS;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
    }
  };
  walk(tl, tr); walk(tr, br); walk(br, bl); walk(bl, tl);
  return out;
}

// ---- the floors -----------------------------------------------------------

test('every responsive region is 6° where it sits — the padded hit box, not the mark', async () => {
  const { W, regions } = await room();
  // Eight berths and the mat. The room's permanent furniture is deliberately
  // small — everything else is a panel he opens, and a panel's own controls are
  // measured against the distance IT stands at, not this one.
  assert.ok(regions.length >= 9, `only ${regions.length} regions in the room`);
  for (const r of regions) {
    const a = arcOf(r, 'hit');
    assert.ok(a.w >= W.HIT, `${r.kind}: ${a.w.toFixed(2)}° wide, floor is ${W.HIT}°`);
    assert.ok(a.h >= W.HIT, `${r.kind}: ${a.h.toFixed(2)}° tall, floor is ${W.HIT}°`);
  }
});

test('and the mark drawn inside it still clears the 3° floor', async () => {
  const { W, regions } = await room();
  for (const r of regions) {
    if (!hasMark(r)) continue;
    const a = arcOf(r, 'mark');
    assert.ok(a.w >= W.MARK, `${r.kind}: the drawn mark is ${a.w.toFixed(2)}° wide, floor is ${W.MARK}°`);
    assert.ok(a.h >= W.MARK, `${r.kind}: the drawn mark is ${a.h.toFixed(2)}° tall, floor is ${W.MARK}°`);
    // ...and the padding is real padding: the region has to be bigger than what
    // it is padding, or "pad the hit box, not the drawing" has become a slogan.
    const hit = arcOf(r, 'hit');
    assert.ok(hit.w > a.w && hit.h > a.h, `${r.kind}: the region is not larger than the mark inside it`);
  }
});

test('no two of them are closer than 1.6° of clear air', async () => {
  const { W, regions } = await room();
  // Measured as the smallest angle between the two OUTLINES, sampled all the way
  // round each of them. Not between their bounding boxes: a cell lying on a
  // plane tilted away from the eye is a keystone in the eye's own angles rather
  // than a rectangle, two cells on one shelf lean the same way, and comparing
  // the bottom corner of one against the top corner of the other measures a
  // distance between two points that are nowhere near each other.
  const outlines = regions.map((r) => ({ kind: r.kind, pts: outline(r) }));
  for (let i = 0; i < outlines.length; i++) {
    for (let j = i + 1; j < outlines.length; j++) {
      const a = outlines[i], b = outlines[j];
      let apart = Infinity;
      for (const p of a.pts) for (const q of b.pts) {
        const d = between(sub(p, regions[i].eye), sub(q, regions[j].eye));
        if (d < apart) apart = d;
      }
      assert.ok(apart >= W.GAP,
        `${a.kind} and ${b.kind} are ${apart.toFixed(2)}° apart, floor is ${W.GAP}°`);
    }
  }
});

test('nothing is over the horizon, behind him, or past the shoulders', async () => {
  const { W, regions } = await room();
  for (const r of regions) {
    const e = extent(r);
    assert.ok(e.t <= W.RISE, `${r.kind} reaches ${e.t.toFixed(1)}° up — looking up is a sore neck`);
    assert.ok(Math.abs(e.l) <= 45 && Math.abs(e.r) <= 45,
      `${r.kind} runs to ${Math.max(Math.abs(e.l), Math.abs(e.r)).toFixed(1)}° off centre, past the ±45° bound`);
    // The floor is where floors are: a landmark lying on it cannot be raised into
    // the reading band, and it is glanced at rather than read.
    const floorOf = r.floor ? W.FLOOR_LOOK : W.SINK;
    assert.ok(e.b >= -floorOf, `${r.kind} runs down to ${e.b.toFixed(1)}°, past −${floorOf}°`);
  }
});

test('everything he stands in front of is inside the comfort band', async () => {
  const { W, regions } = await room();
  for (const r of regions) {
    const e = extent(r);
    assert.ok(e.near >= W.NEAR, `${r.kind} comes to ${e.near.toFixed(2)} m — too near the face`);
    assert.ok(e.mid <= W.FAR + 1e-9, `${r.kind} stands at ${e.mid.toFixed(2)} m — past the comfort band`);
  }
});


// ---- the panels, where prose is read ---------------------------------------
//
// The panels are the readable half of the room, and "readable" is a number
// rather than an impression: how many degrees the type covers at the distance
// the surface stands, and how many characters that buys.

test('a panel stands in the comfort band, below the horizon, and never on the floor', async () => {
  const W = await load('world.js');
  assert.ok(W.PANEL.distM >= W.NEAR && W.PANEL.distM <= W.FAR,
    `panels stand at ${W.PANEL.distM} m, outside the ${W.NEAR}–${W.FAR} m comfort band`);
  const centre = -W.PANEL.elevDeg;
  assert.ok(centre >= W.DROP[0] && centre <= W.DROP[1],
    `panels are centred ${centre.toFixed(1)}° below the horizon, not ${W.DROP.join('–')}°`);
  // Top and bottom edges, in the room's own bounds. A panel is tilted back, so
  // its extent in elevation is a little less than its height — checking the
  // untilted extent is the conservative version of the same assertion.
  const top = W.PANEL.elevDeg + W.PANEL.heightDeg / 2;
  const bottom = W.PANEL.elevDeg - W.PANEL.heightDeg / 2;
  assert.ok(top <= W.RISE, `a panel reaches ${top.toFixed(1)}°, over the +${W.RISE}° ceiling`);
  assert.ok(bottom >= -W.SINK, `a panel reaches ${bottom.toFixed(1)}°, under the -${W.SINK}° floor`);
  // Tilted TOWARD the face, never lying flat: a panel on the floor is
  // foreshortened into uselessness and makes him bow his head to read it.
  assert.ok(W.PANEL.tiltDeg > 0 && W.PANEL.tiltDeg <= 30,
    `a panel tilted ${W.PANEL.tiltDeg}° is either flat on the floor or falling over backwards`);
});

test('every panel slot is inside the shoulders, and the readable pair does not overlap', async () => {
  const W = await load('world.js');
  const half = W.PANEL.widthDeg / 2;
  for (const az of W.PANEL_SLOTS) {
    assert.ok(Math.abs(az) + half <= 45 + 1e-9,
      `a panel at ${az}° reaches ${(Math.abs(az) + half).toFixed(1)}°, past the ±45° bound`);
  }
  // The first two slots are the pair he can read at once. They may touch but
  // they may not overlap — a window hidden behind another is a window he has to
  // tidy before he can work.
  const [a, b] = W.PANEL_SLOTS;
  assert.ok(Math.abs(b - a) >= W.PANEL.widthDeg - 1e-9,
    `the two readable slots are ${Math.abs(b - a)}° apart and each is ${W.PANEL.widthDeg}° wide — they overlap`);
});

test('a panel holds enough prose to be worth reading', async () => {
  const W = await load('world.js');
  const cap = W.panelCapacity();
  // A measure under ~45 characters is a column of broken words; a panel that
  // shows fewer than ten lines is a peephole. Both floors are about whether a
  // real card body — median 2 196 characters on this board — can be read at
  // all rather than scrolled through a slot.
  assert.ok(cap.charsPerLine >= 45, `${cap.charsPerLine} characters per line is too narrow to read`);
  assert.ok(cap.lines >= 10, `${cap.lines} lines is a peephole, not a panel`);
  // And the bar and the composer are both targets, so they eat two hit floors
  // out of the height before a word is drawn. That has to still leave a body.
  const chrome = 2 * W.BUILD.hit;
  assert.ok(W.PANEL.heightDeg - chrome >= 15,
    `${(W.PANEL.heightDeg - chrome).toFixed(1)}° of body left after the bar and the composer`);
});

test('panel type clears the same floors as everything else, at the distance a panel stands', async () => {
  const W = await load('world.js');
  for (const [name, em] of Object.entries(W.TYPE)) {
    assert.ok(em * W.CAP >= 0.7, `${name} on a panel is ${(em * W.CAP).toFixed(2)}° of cap height`);
  }
  // The bar is a target — he has to hit it to move the window — so it is the
  // padded hit floor tall where the panel stands, not merely tall enough to
  // hold its title.
  const { widthM, heightM } = W.panelSize();
  assert.ok(Math.abs(W.arcDeg(widthM, W.PANEL.distM) - W.PANEL.widthDeg) < 1e-9);
  assert.ok(Math.abs(W.arcDeg(heightM, W.PANEL.distM) - W.PANEL.heightDeg) < 1e-9);
});

// ---- the type -------------------------------------------------------------

test('the smallest type in the room clears the 0.7° cap-height floor everywhere it is used', async () => {
  const W = await load('world.js');
  for (const [name, em] of Object.entries(W.TYPE)) {
    assert.ok(em * W.CAP >= 0.7, `${name} type is ${(em * W.CAP).toFixed(2)}° of cap height — under the floor`);
  }
  assert.ok(W.TYPE.body >= 1.4, 'body text should be ~1.5° of em box');
  assert.ok(W.TYPE.head > W.TYPE.body && W.TYPE.body > W.TYPE.meta, 'the ladder is head > body > meta');
});

test('a font asked for in degrees comes out that many degrees at the distance it stands', async () => {
  // kit.js's fontFor cannot be imported here (it pulls three and uikit), so this
  // checks the world.js function it mirrors against an independent formula.
  const W = await load('world.js');
  for (const d of [1.2, 1.75, 1.97, 2.0]) {
    const cm = 2 * d * Math.tan(W.TYPE.body * Math.PI / 360) / 0.01;
    assert.ok(Math.abs(cm - W.sizeForArc(W.TYPE.body, d) * 100) < 1e-9);
    assert.ok(cm > 2.5, `body text at ${d} m would be ${cm.toFixed(1)} cm — check the unit`);
  }
});

test('arc and metres convert both ways', async () => {
  const { arcDeg, sizeForArc } = await load('world.js');
  for (const [size, dist] of [[0.12, 1.75], [0.18, 2.0], [0.8, 1.2]]) {
    assert.ok(Math.abs(sizeForArc(arcDeg(size, dist), dist) - size) < 1e-12, 'round trip');
  }
  assert.ok(Math.abs(arcDeg(0.12, 1.75) - 57.3 * 0.12 / 1.75) < 0.01, 'the small-angle rule of thumb');
});

// ---- the discipline -------------------------------------------------------



test('the lieutenants sit in fixed berths that never sort or reflow', async () => {
  const W = await load('world.js');
  const seen = new Set();
  for (let i = 0; i < W.AGENT.slots; i++) {
    const slot = W.agentSlotFor(i);
    assert.ok(slot >= 0 && slot < W.AGENT.slots, `roster place ${i} has no berth`);
    assert.ok(!seen.has(slot), `two lieutenants share berth ${slot}`);
    seen.add(slot);
  }
  assert.strictEqual(W.agentSlotFor(W.AGENT.slots), -1, 'a ninth lieutenant has nowhere to stand, and says so');
  // Adding one never moves one that is already there.
  const before = [0, 1, 2, 3].map(W.agentSlotFor);
  const after = [0, 1, 2, 3, 4].map(W.agentSlotFor).slice(0, 4);
  assert.deepStrictEqual(after, before, 'a lieutenant joining reflowed the arc');
  // And the half-crewed board is still centred rather than piled against a wall.
  const az = before.map((s) => W.agentSlotAzimuth(s));
  assert.ok(Math.abs(az.reduce((a, b) => a + b, 0)) < 1e-9, 'four lieutenants are not centred on the arc');
});

test('the arc of lieutenants is 8 × 18 cm at 2 m, 11.25° apart, and never above +5°', async () => {
  const W = await load('world.js');
  assert.strictEqual(W.AGENT.slots, 8);
  assert.ok(Math.abs(W.AGENT.diaM - 0.18) < 1e-9);
  assert.ok(Math.abs(W.AGENT.distM - 2.0) < 1e-9);
  for (let i = 0; i < W.AGENT.slots; i++) {
    const a = W.agentAt(i);
    assert.ok(a.el >= 0 && a.el <= W.AGENT.riseDeg + 1e-9, `lieutenant ${i} sits at ${a.el.toFixed(2)}°`);
    if (i) {
      const step = a.az - W.agentAt(i - 1).az;
      assert.ok(Math.abs(step - W.AGENT.pitchDeg) < 1e-9, `berths ${i - 1} and ${i} are ${step.toFixed(2)}° apart`);
    }
  }
});

test('full white is clamped', async () => {
  const W = await load('world.js');
  assert.strictEqual(W.agentColour('#ffffff'), '#ebebeb');
  assert.strictEqual(W.agentColour('#7c5cff'), '#7c5ceb');
  assert.strictEqual(W.agentColour(null), '#8aa0bb');
});


test('the wall is a wall: fifty-odd cards at once, and every one of them legible', async () => {
  const W = await load('world.js');
  assert.ok(W.WALL.distM >= W.NEAR && W.WALL.distM <= W.FAR,
    `the wall stands at ${W.WALL.distM} m, outside the comfort band`);
  // Measured after the turn and the tilt, not read off the two constants: a
  // flat 44° tile does not subtend 44° symmetrically, and the tilt moves the
  // whole thing. The authored numbers are the input, these are the room.
  const ext = W.wallExtent();
  assert.ok(ext.topDeg <= W.RISE, `the wall reaches ${ext.topDeg.toFixed(1)}°, over the +${W.RISE}° ceiling`);
  assert.ok(ext.bottomDeg >= -W.SINK, `the wall reaches ${ext.bottomDeg.toFixed(1)}°, under the -${W.SINK}° floor`);
  // And it stands IN FRONT of the crew. The tilt throws the top edge away from
  // the eye, and a wall whose top is behind the lieutenants is a wall they are
  // drawn through — which is exactly what the first rendered frame showed.
  assert.ok(ext.maxDistM < W.AGENT.distM - W.AGENT.diaM / 2,
    `the wall reaches ${ext.maxDistM.toFixed(2)} m and the crew's near side is ${(W.AGENT.distM - W.AGENT.diaM / 2).toFixed(2)} m`);
  // **Does a tile ever cover its neighbour?** A title cut at its own lane's
  // edge and a title hidden behind the next panel look identical in a
  // photograph, and this wall was read as the second when it was the first. So
  // it is measured: the gap between two neighbours, from the arc centre AND
  // from an eye leaned 20 cm along the wall, which is further than a seated
  // head goes. Negative would mean one really does eat the other.
  for (const lean of [0, 0.032, 0.10, 0.20]) {
    const gap = W.wallTileGap(lean);
    assert.ok(gap > 0.5,
      `leaning ${lean * 100} cm, two lanes leave ${gap.toFixed(2)}° between them`);
  }
  assert.ok(Math.abs(W.wallTileGap(0) - W.WALL.laneGapDeg) < 0.15,
    'from the arc centre the gap between two tiles is the gap they were built with');
  // It is deliberately wider than the ±45° a bounded region is held to — a
  // board you scan by turning your head is the whole point of it — but a tile
  // is still a flat surface and past about 34° off-normal a flat surface
  // turned to face the eye stops facing it, which is why it is SIX tiles.
  assert.ok(W.wallLaneDeg() <= 34, `a lane is ${W.wallLaneDeg().toFixed(1)}° of flat surface`);
  assert.ok(W.WALL.spanDeg >= 100 && W.WALL.spanDeg <= 120,
    `the wall spans ${W.WALL.spanDeg}°, and a neck does not`);

  // **The floor is the TITLE, and it is the thing this surface exists for.**
  // Sized the other way round — cap height first — the lane came out at 16
  // characters against a median card title of 53, and every row was cut to the
  // same opening words. This assertion is the one that stops that coming back.
  assert.ok(W.wallChars() >= W.WALL_CHARS,
    `a lane holds ${W.wallChars()} characters of title, under the ${W.WALL_CHARS} floor`);

  // The cap height it lands at, measured on the WORST row rather than on the
  // size the type is cut at — the top of a lane is further away and more turned
  // than its middle. It clears the room's own 0.7° floor and its 1.0° body
  // text; it does NOT clear the 1.3° this was first built to, and that is the
  // price of the 32 characters, on purpose.
  const cap = W.wallCap();
  assert.ok(cap.worstDeg >= W.CAP,
    `the worst row's cap is ${cap.worstDeg.toFixed(2)}°, under the ${W.CAP}° floor`);
  // Cut at the size the room's own prose is set at — that is where the type
  // stopped being pushed down for characters — and a third clear of the floor
  // once the worst row's foreshortening is taken off it.
  assert.ok(cap.cutDeg >= W.TYPE.body * W.CAP,
    `wall type is cut at ${cap.cutDeg.toFixed(2)}° of cap, under the room's own body prose`);
  assert.ok(cap.worstDeg >= W.CAP * 1.25,
    `the worst wall row is ${cap.worstDeg.toFixed(2)}°, too near the ${W.CAP}° floor to have any margin`);
  assert.ok(cap.worstDeg <= cap.bestDeg && cap.bestDeg <= cap.cutDeg + 1e-9,
    'the foreshortening runs the wrong way');
  assert.ok(W.WALL.rowDeg >= W.TYPE.wall * 1.15,
    `a ${W.WALL.rowDeg}° row cannot hold a ${(W.TYPE.wall * 1.15).toFixed(2)}° line`);

  // Seventy-two seats, and on the live shape of the board — 35 backlog, 4
  // working, 31 in review, 0 peer — forty are filled with no filter. One lane
  // per column is what caps it: a column shows at most `rows` of its own.
  assert.strictEqual(W.wallRows(), 18);
  assert.strictEqual(W.wallSeats(), 72);
  const live = [35, 4, 31, 0];
  const shown = live.reduce((n, c) => n + Math.min(c, W.wallRows()), 0);
  assert.strictEqual(shown, 40, `${shown} of the live board's cards are on the wall at once`);

  // And the trade is arguable rather than asserted: more characters is fewer
  // rows, every time, and the curve has to run the right way.
  // Characters and rows do NOT trade against each other — both come out of the
  // type size, and both are bought with cap height. So a wider character floor
  // buys MORE rows and smaller letters, and the only thing that stops it is the
  // floor above. That is why 32 is the number: one more character and the worst
  // row drops under the 1.0° cap the room's own body text carries.
  const wide = W.wallTrade(40), tight = W.wallTrade(24);
  assert.ok(wide.emDeg < tight.emDeg && wide.rows >= tight.rows,
    'the character/cap trade does not run the way the arithmetic says');
  // And the type really is pushed as far down as the body-prose rule allows:
  // one more character and the cut cap goes under it.
  assert.ok(W.wallTrade(W.wallChars() + 1).capCutDeg < W.TYPE.body * W.CAP,
    `${W.wallChars()} characters is not where the cap rule actually bites`);
});

test('the rail is under the wall, above the deck, and every control on it is a target', async () => {
  const W = await load('world.js');
  const top = W.RAIL.elevDeg + W.railHeightDeg() / 2;
  const bottom = W.RAIL.elevDeg - W.railHeightDeg() / 2;
  // It is below the wall with air between them, and it is a GLANCE down rather
  // than a neck — the same budget the mat on the floor spends.
  const wallBottom = W.wallExtent().bottomDeg;
  assert.ok(top <= wallBottom - W.BUILD.gap,
    `the rail's top edge is ${top.toFixed(1)}° and the wall's bottom is ${wallBottom.toFixed(1)}°`);
  assert.ok(bottom >= -W.FLOOR_LOOK, `the rail reaches ${bottom.toFixed(1)}°, past a glance`);
  // And it stands ABOVE the deck, which the wall's own distance cannot do down
  // there: 1.80 m at this elevation is underground.
  const low = W.pointAt(0, bottom, W.RAIL.distM);
  assert.ok(low.y > 0.05, `the rail's bottom edge is ${low.y.toFixed(2)} m off the floor`);
  assert.ok(W.pointAt(0, bottom, W.WALL.distM).y < low.y,
    'the rail gains nothing by being nearer, so it should not be');

  // Four faces to a strip at the full hit floor, and they have to fit.
  const perStrip = 4;
  const need = perStrip * W.BUILD.hit + (perStrip - 1) * W.BUILD.gap;
  assert.ok(need <= W.RAIL.widthDeg,
    `${perStrip} faces want ${need.toFixed(1)}° and a rail tile is ${W.RAIL.widthDeg}°`);
  // The crew all fits on the left tile, four to a strip, two strips.
  assert.ok(W.RAIL.rows * perStrip >= W.AGENT.slots,
    `${W.RAIL.rows * perStrip} face slots for ${W.AGENT.slots} berths`);
  assert.ok(W.RAIL.rows * W.BUILD.hit + (W.RAIL.rows - 1) * W.BUILD.gap <= W.railHeightDeg() + 1e-9,
    'the strips do not fit in the rail');
});

// ---- the crew is alive, and on real state ----------------------------------

test('a berth reads the board rather than a spinner', async () => {
  const L = await load('liveness.js');
  const lt = { id: 'monica', chat: [] };
  const card = (over) => Object.assign({ owner: 'monica', status: { worker: {}, unread: false } }, over);

  assert.strictEqual(L.livenessOf(lt, { cards: [] }), 'idle',
    'nothing happening is idle, and idle is the state the others are legible against');

  assert.strictEqual(L.livenessOf(lt, {
    cards: [card({ status: { worker: { state: 'working' }, unread: false } })],
  }), 'working');

  assert.strictEqual(L.livenessOf(lt, {
    cards: [card({ status: { worker: { state: 'needs-you' }, unread: false } })],
  }), 'wants-you');

  assert.strictEqual(L.livenessOf(lt, {
    cards: [card({ status: { worker: {}, unread: true } })],
  }), 'wants-you', 'a timeline he has not read is a thing waiting on him');

  // Precedence, and it is not alphabetical: a lieutenant both running a worker
  // AND sitting on something unread is one he needs to look at. The louder
  // state is never masked by the busier one.
  assert.strictEqual(L.livenessOf(lt, {
    cards: [
      card({ status: { worker: { state: 'working' }, unread: false } }),
      card({ status: { worker: { state: 'needs-you' }, unread: false } }),
    ],
  }), 'wants-you');

  // Another lieutenant's card is another lieutenant's problem.
  assert.strictEqual(L.livenessOf(lt, {
    cards: [Object.assign(card({ status: { worker: { state: 'working' }, unread: false } }), { owner: 'rex' })],
  }), 'idle');
});

test('the last word being theirs is a thing waiting on him — until he has read it', async () => {
  const { unansweredReply } = await load('liveness.js');
  const lt = (last) => ({ id: 'monica', chat: [{ author: 'user', text: 'x', ts: '2026-01-01T00:00:00Z' }, last] });
  const said = { author: 'Monica', text: 'y', ts: '2026-01-02T00:00:00Z' };
  const reads = (ts) => ({ user: { threads: { 'lieutenant:monica': ts } } });

  assert.ok(unansweredReply(lt(said), reads('2026-01-01T12:00:00Z')), 'unread reply');
  assert.ok(!unansweredReply(lt(said), reads('2026-01-03T00:00:00Z')), 'he has read it');
  // Never opened at all counts as unread, which is the honest reading: he has
  // not seen it, and a thread he has never looked at is exactly the one most
  // likely to be waiting on him.
  assert.ok(unansweredReply(lt(said), {}), 'a thread with no read marker is unread');
  // The captain having the last word is never something waiting on the captain.
  assert.ok(!unansweredReply(lt({ author: 'user', text: 'z', ts: '2026-01-02T00:00:00Z' }), reads('2026-01-01T00:00:00Z')));
  assert.ok(!unansweredReply({ id: 'x', chat: [] }, reads('2026-01-01T00:00:00Z')), 'an empty chat says nothing');
});

test('nothing in the crew flickers, and idle really is still', async () => {
  const L = await load('liveness.js');
  for (const [state, m] of Object.entries(L.MOTION)) {
    // The periphery is where flicker is felt hardest and this room is mostly
    // periphery, so everything stays an order of magnitude under 3 Hz.
    assert.ok(m.hz <= 0.3 * 3, `${state} moves at ${m.hz} Hz, too near the flicker floor`);
  }
  assert.strictEqual(L.MOTION.idle.hz, 0, 'idle has to be STILL — it is the signal');
  assert.strictEqual(L.MOTION.idle.liftDeg, 0);
  // Only the state that wants him leaves the rank. That break in the line is
  // what makes it findable without reading anything.
  assert.ok(L.MOTION['wants-you'].liftDeg > 0);
  assert.strictEqual(L.MOTION.working.liftDeg, 0);
  assert.ok(L.MOTION['wants-you'].pulse > 0 && L.MOTION.working.pulse === 0);

  // A berth at rest sits exactly where world.js puts it — the motion is an
  // offset from the geometry, never a replacement for it.
  const at0 = L.motionAt('idle', 12.34, 1.1);
  assert.strictEqual(at0.bobDeg, 0);
  assert.strictEqual(at0.liftDeg, 0);
  assert.strictEqual(at0.glow, 0);

  // And two berths never move in unison, which is the difference between eight
  // individuals and one system animation.
  const a = L.motionAt('working', 3.0, 0);
  const b = L.motionAt('working', 3.0, 2.399963);
  assert.ok(Math.abs(a.bobDeg - b.bobDeg) > 1e-6, 'two berths in step reads as a spinner');

  // Every amplitude is small enough to be peripheral rather than distracting:
  // under a degree and a half of arc at the berth's own distance.
  for (const [state, m] of Object.entries(L.MOTION)) {
    assert.ok(m.bobDeg <= 1.5, `${state} bobs ${m.bobDeg}°, which is waving`);
    assert.ok(m.liftDeg <= 3.0, `${state} lifts ${m.liftDeg}°, which is leaving`);
  }
});

// ---- the six states -------------------------------------------------------

test('every interactive thing has six states and a spotlight that closes', async () => {
  const W = await load('world.js');
  assert.deepStrictEqual(W.STATE,
    ['idle', 'hovered-far', 'hovered-near', 'contact', 'held', 'released'],
    'six states, not three — there is no haptic channel to carry the affordance');
  const far = W.spotlight(W.REACH_M[1]);
  const near = W.spotlight(W.REACH_M[0]);
  assert.ok(far > near, 'the spotlight has to SHRINK as the pointer comes in');
  assert.ok(near <= 0.15, 'and converge to something like a dot on contact');
  for (const d of [0, 0.1, 5, 50]) {
    const k = W.spotlight(d);
    assert.ok(k >= 0.14 && k <= 1, `spotlight(${d}) is ${k}`);
  }
  assert.ok(W.ACK_MS <= 300 && W.STEP > 1 && W.STEP < 1.1, 'a ~5% step, acknowledged fast');
});

// ---- the headset stays in the session ---------------------------------------

test('a composer holds the keys: its letters are not shortcuts, and releasing gives them back', async () => {
  // keys.js imports nothing, which is what lets it be loaded here at all — the
  // rest of the room pulls in three.js and uikit and cannot be.
  const { Composer, routeKey, keysHeld } = await load('keys.js');
  const sent = [];
  const seen = [];
  const chat = new Composer({ onSubmit: (v) => sent.push(v) });
  const wall = new Composer({ onChange: (v) => seen.push(v) });

  // Nothing holds the keys until something takes them, and then b/c/x are the
  // composer's letters rather than the room's shortcuts.
  const key = (k, over) => Object.assign({ key: k, preventDefault() {} }, over);
  assert.equal(keysHeld(), null);
  assert.equal(routeKey(key('b')), false, 'a key was swallowed with no composer holding it');
  chat.take();
  assert.equal(keysHeld(), chat);
  for (const k of ['h', 'b', 'x', 'c']) assert.equal(routeKey(key(k)), true);
  assert.equal(chat.value, 'hbxc', 'the letters did not land in the composer');
  routeKey(key('Backspace'));
  assert.equal(chat.value, 'hbx');
  routeKey(key('Enter'));
  assert.deepEqual(sent, ['hbx'], 'Enter did not send');
  routeKey(key('Enter', { shiftKey: true }));
  assert.deepEqual(sent, ['hbx'], 'shift-Enter sent anyway');
  routeKey(key('ArrowLeft'));
  assert.equal(chat.value, 'hbx', 'a named key was typed as a character');

  // One keyboard, one composer: pressing the wall's field takes them off the
  // chat, and the wall filters as the characters arrive.
  wall.take();
  assert.equal(keysHeld(), wall);
  routeKey(key('a'));
  assert.deepEqual(seen, ['a'], 'the wall did not narrow as a character arrived');
  assert.equal(chat.value, 'hbx', 'the chat kept taking keys it no longer holds');

  // And releasing gives them back to the room — what closing a panel does.
  wall.release();
  assert.equal(keysHeld(), null);
  assert.equal(routeKey(key('b')), false, 'the shortcuts are still dead after the panel closed');
});

// A browser, in as much detail as syskb.js can tell. `type()` is what the
// system keyboard and a paired bluetooth keyboard both do to a focused field:
// set the value and fire `input`. There are no key events to fake, because the
// system keyboard does not send any — that is the whole shape of the thing.
// A Quest Browser well past Meta's 26.1 floor — what his headset almost
// certainly was when it died. The tests below are about the mechanism, so they
// hand this in rather than being a browser.
const QUEST = 'Mozilla/5.0 (X11; Linux x86_64; Quest 3) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) OculusBrowser/42.0.0.1.1.1 Chrome/126.0.6478.122 VR Safari/537.36';

function fakeDom() {
  const win = { scrollX: 0, scrollY: 0, scrollTo(x, y) { win.scrollX = x; win.scrollY = y; } };
  const doc = {
    defaultView: win,
    activeElement: null,
    body: { children: [], appendChild(el) { doc.body.children.push(el); } },
    createElement() {
      const handlers = {};
      const fire = (t) => { for (const fn of handlers[t] || []) fn(); };
      const el = {
        style: { cssText: '' }, value: '', attrs: {},
        setAttribute(k, v) { el.attrs[k] = v; },
        addEventListener(t, fn) { (handlers[t] = handlers[t] || []).push(fn); },
        focus() { doc.activeElement = el; },
        blur() { if (doc.activeElement === el) doc.activeElement = null; fire('blur'); },
        remove() { doc.body.children = doc.body.children.filter((c) => c !== el); },
        // Named away from `type`: syskb.js sets `el.type = 'text'` on the real
        // element, and a fake whose method shares that name loses it.
        typed(v) { el.value = v; fire('input'); },
      };
      return el;
    },
  };
  return { doc, win };
}

test('the system keyboard drives the composer, and never types a letter twice', async () => {
  const { Composer, routeKey, setKeyboard, keysHeld } = await load('keys.js');
  const { SystemKeyboard, seamOf } = await load('syskb.js');
  const key = (k, over) => Object.assign({ key: k, preventDefault() {} }, over);

  // ---- a browser that does not offer one -----------------------------------
  //
  // The guard is the part that must not be clever: no session, an old browser,
  // or a session that does not advertise the keyboard, and the room is exactly
  // what it was — bluetooth through the window, no element, no half-raised
  // anything.
  const off = fakeDom();
  const quiet = new SystemKeyboard(off.doc, { enabled: true, ua: QUEST });
  setKeyboard(quiet);
  const flat = new Composer();
  flat.take();
  assert.equal(off.doc.body.children.length, 0, 'a field was built with no session at all');
  assert.equal(quiet.driving(), false);
  routeKey(key('h')); routeKey(key('i'));
  assert.equal(flat.value, 'hi', 'the bluetooth path stopped working without a system keyboard');
  quiet.attach({ isSystemKeyboardSupported: false });
  assert.equal(off.doc.body.children.length, 0, 'a browser that says no still got a field');
  assert.equal(quiet.raise(flat), false, 'the keyboard was raised on a browser that has none');
  flat.release();

  // ---- and one that does ----------------------------------------------------
  const { doc, win } = fakeDom();
  const kb = new SystemKeyboard(doc, { enabled: true, ua: QUEST });
  setKeyboard(kb);
  kb.attach({ isSystemKeyboardSupported: true });
  assert.equal(doc.body.children.length, 1, 'the session started and no field was built');
  const el = doc.body.children[0];
  assert.match(el.style.cssText, /position:fixed/);
  assert.ok(!/left:-/.test(el.style.cssText), 'the field is off-screen — the page will scroll to it');

  const sent = [];
  const chat = new Composer({ onSubmit: (v) => sent.push(v) });

  // Opening a panel takes the keys WITHOUT raising the keyboard: he gets the
  // caret and his bluetooth keyboard, and the shell surface only when he asks.
  chat.take({ raise: false });
  assert.equal(keysHeld(), chat);
  assert.equal(kb.driving(), false, 'opening a panel raised the system keyboard by itself');
  routeKey(key('o'));
  assert.equal(chat.value, 'o', 'bluetooth stopped working before the keyboard was raised');

  // Pressing the field is what raises it, and it opens onto what he has already
  // written rather than onto a blank.
  chat.take();
  assert.equal(kb.driving(), true, 'pressing the field did not raise the keyboard');
  assert.equal(el.value, 'o', 'the field was not seeded with the composer text');

  // The documented behaviour: a new editing session, whose first key press
  // overwrites the whole value. What arrives is a delta, and the composer keeps
  // what it had.
  el.typed('l');
  assert.equal(chat.value, 'ol', 'the first keystroke wiped the text he had already written');
  el.typed('lá');
  assert.equal(chat.value, 'olá', 'the accented letter did not arrive intact');

  // While that field is focused it is the only source of characters. A
  // bluetooth keystroke reaches it AND the window; applying both would type
  // everything twice. The shortcuts still stay dead, and Enter still sends —
  // neither of those changes the field's value, so neither arrives twice.
  assert.equal(routeKey(key('x')), true, 'a shortcut woke up while he was typing');
  assert.equal(chat.value, 'olá', 'the keystroke was applied twice');
  assert.equal(routeKey(key('Backspace')), true);
  assert.equal(chat.value, 'olá', 'backspace deleted two characters, one per path');
  routeKey(key('Enter'));
  assert.deepEqual(sent, ['olá'], 'Enter did not send with the keyboard up');

  // Sending clears the composer, and the field has to be told — otherwise it
  // still holds the sent message and hands it back with the next letter.
  chat.setValue('');
  assert.equal(el.value, '', 'the field kept the message that was already sent');
  el.typed('t');
  assert.equal(chat.value, 't', 'the sent message came back attached to the next letter');

  // Dismissing the keyboard — Done, the Meta button, a press outside it — blurs
  // the field. He KEEPS the keys: bluetooth still types, the shortcuts stay
  // dead, and pressing the field is how he asks for the keyboard back.
  el.blur();
  assert.equal(kb.driving(), false);
  assert.equal(keysHeld(), chat, 'dismissing the keyboard let go of the keys');
  routeKey(key('u'));
  assert.equal(chat.value, 'tu', 'bluetooth stopped working after the keyboard was dismissed');
  chat.take();
  assert.equal(kb.driving(), true, 'pressing the field again did not bring the keyboard back');
  assert.equal(el.value, 'tu', 'it came back onto a blank instead of onto what he had written');

  // The page never scrolls. The field is in the viewport so there should be
  // nothing to scroll to; if the browser finds something anyway, the flat board
  // is put back where it was, because that is the page he leaves the session
  // onto.
  win.scrollY = 500;
  el.typed('tudo');
  assert.equal(win.scrollY, 0, 'the page was left scrolled somewhere he did not put it');

  // Releasing lets go of everything, and the session ending takes the field out
  // of the page — an input left behind is a focus trap on the flat board.
  chat.release();
  assert.equal(keysHeld(), null);
  assert.equal(kb.driving(), false, 'the field is still focused with nobody holding the keys');
  kb.detach();
  assert.equal(doc.body.children.length, 0, 'the field outlived the session');

  // The seam itself, which is the one decision this design cannot read off the
  // API: whether the first value of an editing session replaced what he had
  // written or was typed after it. All five branches, because the seed survives
  // an edit in EITHER direction — typing after it and backspacing into it —
  // and the second is the whole reason the field is seeded at all.
  assert.equal(seamOf('olá', ' '), 'olá', 'an overwritten field threw away his sentence');
  assert.equal(seamOf('olá', 'olá tudo'), '', 'a surviving seed was pasted in front of itself');
  assert.equal(seamOf('olá', 'ol'), '', 'a first backspace was read as an overwrite');
  assert.equal(seamOf('olá', ''), null, 'an empty first value decided a seam it cannot know');
  assert.equal(seamOf('', 'a'), '', 'an empty composer grew a prefix');

  setKeyboard(null);
});

test('the keyboard survives a first backspace, an empty field, and the keys moving', async () => {
  const { Composer, routeKey, setKeyboard, keysHeld } = await load('keys.js');
  const { SystemKeyboard } = await load('syskb.js');
  const key = (k, over) => Object.assign({ key: k, preventDefault() {} }, over);

  // ---- his first action is a backspace --------------------------------------
  //
  // The seed is there so he can delete back into what he already wrote. Reading
  // that first shorter value as an overwrite pastes the whole sentence back in
  // front of the edit, and it stays wrong for the rest of the showing.
  const { doc } = fakeDom();
  const kb = new SystemKeyboard(doc, { enabled: true, ua: QUEST });
  setKeyboard(kb);
  kb.attach({ isSystemKeyboardSupported: true });
  const el = doc.body.children[0];
  const a = new Composer();
  a.setValue('ola');
  a.take();
  el.typed('ol');
  assert.equal(a.value, 'ol', 'a first backspace pasted the seed back in front of the edit');
  el.typed('o');
  assert.equal(a.value, 'o', 'the seam was re-decided after the first value');

  // ---- and a field that goes empty ------------------------------------------
  //
  // An empty value is the one that says nothing: the overwrite model can empty
  // the field on its own. The composer keeps what it had and the next value
  // decides.
  a.setValue('ola');
  a.take();
  el.typed('');
  assert.equal(a.value, 'ola', 'an empty first value wiped text it knew nothing about');
  el.typed('ol');
  assert.equal(a.value, 'ol', 'the deferred seam decided wrong on the next value');

  // ---- the keys move to another composer without asking for the keyboard ----
  //
  // `take({ raise: false })` is what opening a chat does. If the keyboard were
  // left driving the composer that no longer holds the keys, `routeKey` would
  // swallow every bluetooth character while the field wrote into the old one.
  const b = new Composer();
  a.take();
  assert.equal(kb.driving(), true);
  b.take({ raise: false });
  assert.equal(keysHeld(), b);
  assert.equal(kb.driving(), false, 'the keyboard is still editing the composer that lost the keys');
  const before = a.value;
  routeKey(key('z'));
  assert.equal(b.value, 'z', 'bluetooth did not resume into the composer that took the keys');
  assert.equal(a.value, before, 'the old composer was still being written into');

  kb.detach();
  setKeyboard(null);
});

test('the room gets the system keyboard switched off (MNC-87)', async () => {
  // It crashes a real headset. Until that is understood, the room's own
  // SystemKeyboard — built with no options, the way main.js builds it — must
  // stay a no-op even on a session that advertises support. The tests above
  // pass `{ enabled: true, ua: QUEST }` to keep the mechanism itself exercised.
  const { SystemKeyboard } = await load('syskb.js');
  const { doc } = fakeDom();
  const kb = new SystemKeyboard(doc);
  kb.attach({ isSystemKeyboardSupported: true });
  assert.equal(doc.body.children.length, 0, 'the room built the field the headset crashes on');
  assert.equal(kb.raise({ value: 'olá' }), false, 'pressing a composer still raises the keyboard');
  assert.equal(kb.driving(), false);
});

test('the raise path refuses a browser below Meta\'s 26.1 floor, and any it cannot read', async () => {
  // A belt on top of `isSystemKeyboardSupported`, not the fix — his browser was
  // almost certainly on 42.x, far past this. It is here because a browser that
  // advertises a capability it does not have is exactly what a crash on the
  // press looks like, and refusing to guess is free.
  const { SystemKeyboard, questBrowserAtLeast } = await load('syskb.js');
  assert.equal(questBrowserAtLeast(QUEST), true, '42.x was refused');
  assert.equal(questBrowserAtLeast('OculusBrowser/26.1.0.1'), true, 'the floor itself was refused');
  assert.equal(questBrowserAtLeast('OculusBrowser/27.0.0.1'), true);
  assert.equal(questBrowserAtLeast('OculusBrowser/26.0.9.9'), false, 'a build below the floor got through');
  assert.equal(questBrowserAtLeast('OculusBrowser/25.9.9.9'), false);
  // No version to read is not permission to guess — and that is every browser
  // that is not Quest Browser, including whatever ships the day the token
  // changes name.
  assert.equal(questBrowserAtLeast('Chrome/126.0.6478.122'), false);
  assert.equal(questBrowserAtLeast(''), false);
  assert.equal(questBrowserAtLeast(undefined), false);

  // And it is wired into the guard, not just exported beside it.
  const { doc } = fakeDom();
  const old = new SystemKeyboard(doc, { enabled: true, ua: 'OculusBrowser/25.0.0.1' });
  old.attach({ isSystemKeyboardSupported: true });
  assert.equal(doc.body.children.length, 0, 'an old browser that claims support still got a field');
  assert.equal(old.raise({ value: '' }), false);
});

// ---- the old room is gone --------------------------------------------------

test('the canvas-painted room is gone, not left standing beside the new one', async () => {
  for (const f of ['surface.js', 'panels.js', 'room.js', 'faces.js']) {
    assert.ok(!fs.existsSync(path.join(UI, f)), `${f} is still here — there is meant to be one room`);
  }
  // The rule this protects is about the INTERFACE, not about pixels: the old
  // room painted its panels onto canvases and then had to convert every size
  // back to degrees to know whether it was readable. uikit's MSDF text replaced
  // that, and no surface he reads may go back to it.
  //
  // Environment textures are a different thing and are allowed — a sky gradient
  // and a stone floor are images, not interface, and drawing them beats adding
  // an HDRI and a texture folder to a repo with no build step. The line is
  // drawn where it actually matters, below.
  const UI_MODULES = ['panel.js', 'chat.js', 'board.js', 'list.js', 'agents.js', 'kit.js', 'hover.js'];
  for (const f of UI_MODULES) {
    const src = fs.readFileSync(path.join(UI, f), 'utf8');
    assert.ok(!/getContext\(['"]2d['"]\)/.test(src), `${f} paints a surface he reads by hand`);
    assert.ok(!/CanvasTexture/.test(src), `${f} hangs a hand-painted canvas on a plane`);
  }
  // And nothing anywhere paints TYPE into a texture. That is the actual failure
  // mode — a label baked into an image has no arc, no font metrics and no way
  // to be measured, and it is how the old room's text ended up unreadable.
  for (const f of fs.readdirSync(UI)) {
    if (!f.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(UI, f), 'utf8');
    assert.ok(!/\.fillText\(|\.strokeText\(/.test(src), `${f} paints type into a texture`);
  }
});

// ---- the stack -------------------------------------------------------------

function importMap() {
  const html = fs.readFileSync(path.join(ROOT, 'ui', 'bridge3d.html'), 'utf8');
  const m = /<script type="importmap">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m, 'the page has no import map');
  return JSON.parse(m[1]).imports;
}

test('every bare specifier the room reaches for is in the import map, and resolves to a file', async () => {
  const imports = importMap();
  const seen = new Set();
  const missing = [];
  const resolve = (spec) => {
    if (imports[spec]) return path.join(ROOT, 'ui', imports[spec]);
    for (const k of Object.keys(imports)) {
      if (k.endsWith('/') && spec.startsWith(k)) return path.join(ROOT, 'ui', imports[k], spec.slice(k.length));
    }
    return null;
  };
  const walk = (file, from) => {
    if (!fs.existsSync(file)) return missing.push(`${file} (from ${from})`);
    if (seen.has(file) || path.basename(file) === 'three.module.min.js') { seen.add(file); return; }
    seen.add(file);
    const src = fs.readFileSync(file, 'utf8');
    const specs = [];
    for (const m of src.matchAll(/(?:^|[\s;}])(?:import|export)\s*(?:[\w*{}\s,]*?\s*from\s*)?['"]([^'"]+)['"]/gm)) specs.push(m[1]);
    for (const m of src.matchAll(/import\s*\(\s*['"]([^'"]+)['"]/g)) specs.push(m[1]);
    for (const s of specs) {
      if (s.startsWith('.') || s.startsWith('/')) { walk(path.resolve(path.dirname(file), s), file); continue; }
      const r = resolve(s);
      if (!r) missing.push(`unmapped bare specifier "${s}" (from ${file})`);
      else walk(r, file);
    }
  };
  walk(path.join(UI, 'main.js'), 'the page');
  assert.deepStrictEqual(missing, [], 'the room reaches for something the page cannot give it');
  assert.ok(seen.size > 150, `only ${seen.size} modules reachable — the vendored stack is not wired up`);
  // No CDN, no bundler, no build step: every target is a file in this repo.
  for (const [spec, target] of Object.entries(imports)) {
    assert.ok(/^\.\//.test(target), `"${spec}" points at ${target}, which is not in this repo`);
    assert.ok(fs.existsSync(path.join(ROOT, 'ui', target)), `"${spec}" points at a file that is not there`);
  }
});

test('every module in the room actually parses', async () => {
  // A syntax error in here costs a four-minute capture run to find, because the
  // room's modules import three.js and uikit and so cannot be imported from a
  // test. `node --check` can read them without running them — through a copy
  // with an .mjs extension, which is how node is told they are modules.
  const { execFileSync } = require('node:child_process');
  const os = require('node:os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'room-parse-'));
  try {
    for (const f of fs.readdirSync(UI)) {
      if (!f.endsWith('.js')) continue;
      const copy = path.join(tmp, f.replace(/\.js$/, '.mjs'));
      fs.writeFileSync(copy, fs.readFileSync(path.join(UI, f)));
      try {
        execFileSync(process.execPath, ['--check', copy], { stdio: 'pipe' });
      } catch (e) {
        assert.fail(`${f} does not parse:\n${e.stderr || e.message}`);
      }
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('the room the captain opens never loads the dev loop', async () => {
  // The flags are OFF by default, and "off" has to mean not fetched rather than
  // merely not used: the emulator is reachable only through a dynamic import
  // behind the query parameter.
  for (const f of fs.readdirSync(UI)) {
    if (!f.endsWith('.js') || f === 'devxr.js') continue;
    const src = fs.readFileSync(path.join(UI, f), 'utf8');
    for (const m of src.matchAll(/^\s*import\s[^;]*?from\s*['"]([^'"]+)['"]/gm)) {
      assert.ok(!/devxr|iwer/i.test(m[1]), `${f} imports ${m[1]} at the top level`);
    }
  }
});

// ---- the dev loop ----------------------------------------------------------

test('every viewpoint is aimed at something the room really stands there', async () => {
  const { VIEWPOINTS, places } = await load('viewpoints.js');
  const where = places();
  assert.ok(VIEWPOINTS.length >= 6, 'a loop with two viewpoints is a loop with four blind sides');
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  for (const v of VIEWPOINTS) {
    const at = v.frames.at;
    assert.ok(where.some((p) => near(p.x || 0, at.x || 0) && near(p.y, at.y) && near(p.z, at.z)),
      `${v.name} frames (${at.x}, ${at.y}, ${at.z}) and nothing stands there`);
    assert.ok(['world', 'board', 'chat', 'card'].includes(v.scene), `${v.name} wants an unknown scene`);
    assert.ok(v.why && v.why.length > 20, `${v.name} does not say what it is for`);
  }
  assert.ok(VIEWPOINTS.some((v) => v.scene === 'board'), 'nothing photographs the escape hatch');
  assert.ok(VIEWPOINTS.some((v) => v.scene === 'chat'),
    'nothing photographs a conversation, which is the thing he actually came here to do');
  assert.ok(VIEWPOINTS.some((v) => v.floor), 'nothing photographs the landmarks, which is the thing most likely to be missing');
});

test('no viewpoint asks for a turn of the head the room does not', async () => {
  const { VIEWPOINTS, aimAt, gazeDistance } = await load('viewpoints.js');
  const W = await load('world.js');
  for (const v of VIEWPOINTS) {
    const a = aimAt(v.eye, v.look);
    // 45° unless the viewpoint declares otherwise, and the only thing that
    // does is the wall's outer lane — a surface built to be read by turning
    // has to be photographed turned. Declared, not assumed: `turn` is on the
    // viewpoint so the exception is visible where it is taken.
    const turn = v.turn || 45;
    assert.ok(Math.abs(a.yaw) <= turn, `${v.name} turns the head ${a.yaw.toFixed(1)}° off centre, past ${turn}°`);
    assert.ok(a.pitch <= W.RISE, `${v.name} looks ${a.pitch.toFixed(1)}° up`);
    const down = v.floor ? W.FLOOR_LOOK : 45;
    assert.ok(a.pitch >= -down, `${v.name} looks ${a.pitch.toFixed(1)}° down — that is a neck, not a glance`);
    const d = gazeDistance(v);
    assert.ok(d >= W.NEAR && d <= W.FAR + 1e-9, `${v.name} looks ${d.toFixed(2)} m out, outside ${W.NEAR}–${W.FAR} m`);
  }
});

test('what a shot is named after fits inside the shot, in arc', async () => {
  const { VIEWPOINTS, aimAt, FOVY } = await load('viewpoints.js');
  const W = await load('world.js');
  const MARGIN = 5;
  for (const v of VIEWPOINTS) {
    const gaze = aimAt(v.eye, v.look);
    const at = v.frames.at;
    const centre = aimAt(v.eye, [at.x || 0, at.y, at.z]);
    const d = W.eyeDistance(at);
    const half = FOVY / 2 - MARGIN;
    const across = Math.abs(gaze.yaw - centre.yaw) + W.arcDeg(v.frames.panel.widthM, d) / 2;
    const down = Math.abs(gaze.pitch - centre.pitch) + W.arcDeg(v.frames.panel.heightM, d) / 2;
    assert.ok(across <= half, `${v.name}: what it frames runs ${across.toFixed(1)}° across, past the ${half}° edge`);
    assert.ok(down <= half, `${v.name}: what it frames runs ${down.toFixed(1)}° up/down, past the ${half}° edge`);
  }
});

test('aiming the head at a point really does point it at that point', async () => {
  const { aimAt } = await load('viewpoints.js');
  const D = Math.PI / 180;
  // The independent derivation: rebuild the forward vector from the yaw and
  // pitch aimAt handed back — WebXR's own convention, forward at -Z — and check
  // it lands back on the target. A sign flip here is a whole run of screenshots
  // pointed at the opposite wall, and it is the one bug a PNG cannot report
  // because the PNG looks perfectly fine.
  const W = await load('world.js');
  const cases = [
    [[0, W.EYE, 0], [0, 1.15, -1.55]],
    [[0, W.EYE, 0], Object.values(W.panelAt(W.PANEL_SLOTS[0]).pos)],
    [[0, W.EYE, 0], Object.values(W.agentAt(0).pos)],
    [[0, W.EYE, 0], Object.values(W.agentAt(7).pos)],
    [[0.2, 1.5, 0.3], [-1.0, 2.0, -2.0]],
  ];
  for (const [eye, target] of cases) {
    const { yaw, pitch } = aimAt(eye, target);
    const fwd = [
      -Math.sin(yaw * D) * Math.cos(pitch * D),
      Math.sin(pitch * D),
      -Math.cos(yaw * D) * Math.cos(pitch * D),
    ];
    const to = sub(target, eye);
    const l = len(to);
    for (let i = 0; i < 3; i++) {
      assert.ok(Math.abs(fwd[i] - to[i] / l) < 1e-9, `aimAt(${eye}, ${target}) points at ${fwd}`);
    }
  }
});

// ---- the room can spell ----------------------------------------------------
//
// Two defects in one surface, and they compounded: markdown that rendered as
// its own source, in a font that could not spell Portuguese.

const sheet = () => import(path.join(ROOT, 'ui', 'vendor', 'msdfonts', 'inter-latin1.js'));
const type = () => import(path.join(UI, 'type.js'));

test('GLYPHS is what the vendored sheet really carries — every weight of it', async () => {
  // The list in type.js is a promise about a binary blob, and a promise about a
  // binary blob is exactly the kind that rots. `safe()` DELETES what the sheet
  // cannot draw, so a sheet swap that drops a letter does not throw, does not
  // warn, and does not look like a bug: it looks like a typo in his card.
  const { inter } = await sheet();
  const { GLYPHS } = await type();
  const weights = Object.keys(inter);
  assert.deepStrictEqual(weights, ['light', 'medium', 'semi-bold', 'bold'],
    'uikit resolves the unstyled weight 400 by nearest match over these four keys');

  for (const w of weights) {
    const drawn = new Set(inter[w].chars.map((c) => c.char));
    for (const ch of GLYPHS) {
      assert.ok(drawn.has(ch), `GLYPHS claims ${JSON.stringify(ch)} and the ${w} sheet has no such glyph`);
    }
    const extra = [...drawn].filter((c) => c !== ' ' && !GLYPHS.includes(c));
    assert.deepStrictEqual(extra, [], `the ${w} sheet draws glyphs GLYPHS does not list, so safe() throws them away`);
  }
});

test('the sheet puts type where the room was built for it, not where the generator likes', async () => {
  // The trap that nearly shipped. uikit places a glyph at
  // `(yoffset - (lineHeight - size)) / size` and NEVER reads `common.base`
  // (ui/vendor/uikit/text/font.js) — so a regenerated atlas with a different
  // baseline moves every line of type in the room and no test would see it.
  // msdf-bmfont-xml's own baseline for Inter 4.1 came out 4 px above the sheet
  // this replaced (measured: all 104 shared glyphs, identical xadvance), so
  // the recipe in ui/vendor/README.md shifts yoffset and base by +4. These are
  // the anchors that shift lands on.
  const { inter } = await sheet();
  for (const [w, f] of Object.entries(inter)) {
    assert.strictEqual(f.info.size, 44, `${w}: em box moved`);
    assert.strictEqual(f.common.lineHeight, 53, `${w}: line height moved`);
    assert.strictEqual(f.common.base, 47, `${w}: baseline moved — every line in the room moves with it`);
    const A = f.chars.find((c) => c.char === 'A');
    assert.strictEqual(A.yoffset, 13, `${w}: 'A' sits at a different height than the room was laid out for`);
  }
  assert.strictEqual(inter.medium.chars.find((c) => c.char === 'A').xadvance, 31,
    'the advance changed, so the 49-characters-a-line figure the panel is designed around is wrong');
});

test('the room spells Portuguese', async () => {
  // The whole point, in one assertion. `França` used to come back `Frana`.
  const { safe } = await type();
  for (const word of ['França', 'ação', 'três', 'coração', 'após', 'você', 'ínterim', 'órgão']) {
    assert.strictEqual(safe(word), word, `${word} lost letters on the way to the wall`);
  }
  // Not only Portuguese: the whole Latin-1 letter range survives, which is
  // French, Spanish, the Nordic languages and the German that already worked.
  for (let c = 0xC0; c <= 0xFF; c++) {
    const ch = String.fromCharCode(c);
    if (ch === '×') { assert.strictEqual(safe(ch), 'x'); continue; }
    if (ch === '÷') continue;
    assert.strictEqual(safe(ch), ch, `U+${c.toString(16).toUpperCase()} is still being dropped`);
  }
});

test('safe still throws away what the sheet cannot draw, rather than warning every frame', async () => {
  const { safe, safeBlock } = await type();
  // An emoji has no glyph and no stand-in. It goes, silently — a per-frame
  // console warning is the alternative, and the board's column titles start
  // with one.
  assert.strictEqual(safe('👀 Your review'), 'Your review');
  assert.strictEqual(safe('a … b'), 'a ... b', 'the fold table still folds');
  assert.strictEqual(safe('one\ntwo'), 'one two', 'a line break is a space, not a missing letter');
  // safeBlock is the same filter for text whose SHAPE is the content.
  assert.strictEqual(safeBlock('def f():\n\treturn 1\n'), 'def f():\n  return 1');
  assert.strictEqual(safeBlock('  keep   my indent  '), '  keep   my indent');
  assert.strictEqual(safeBlock('a\n\n\n\nb'), 'a\n\nb');
});
