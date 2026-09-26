// avatars3d.js — the crew's faces, out of the sheet the board already ships.
//
// `ui/img/avatars.png` is an 8x8 grid, index 0-63, row-major, and the flat board
// has read it since the beginning (`ui/js/avatars.js`, by CSS background
// position). Nothing new is downloaded here: the same file, the same indices,
// the same meaning.
//
// **Why a slice per index rather than one texture with UV offsets.** The obvious
// trick — one shared texture, `repeat` 1/8 and an `offset` per cell — cannot
// survive uikit. Its `Image` drives the texture through `texture.matrix`
// directly, resetting it to identity every layout pass and composing its own
// object-fit and border transform into it. Anything written to `repeat`/`offset`
// is either ignored or fights that matrix, and eight faces sharing one texture
// would be eight components fighting over one matrix. A cell cut into its own
// small texture has no such argument: its whole extent IS the avatar, so
// object-fit does the right thing without being told anything.
//
// It is cut **lazily and cached**, so only the handful of indices a board
// actually uses is ever made — eight lieutenants, eight little textures, rather
// than sixty-four cut on the chance somebody picks them.
//
// The sheet is an asset, not an interface: nothing here paints type, and the
// canvas is a pair of scissors rather than a drawing surface.

import * as THREE from 'three';
import { AVATAR_COLS as COLS, validAvatar } from '../avatars.js';

export const SHEET = '/ui/img/avatars.png';

// Cut at 192 px whatever the sheet's own cell size is. The biggest an avatar is
// ever drawn is the portrait disc — 0.155 m at 2.0 m, which is 4.4° — and at
// Quest 3's ~25 pixels per degree that is 111 px. 192 leaves headroom for him
// walking up to one and costs 147 KB of GPU memory per face.
const CELL = 192;

let sheet = null;
let failed = false;
const waiting = [];
const cache = new Map();

new THREE.ImageLoader().load(SHEET, (img) => {
  sheet = img;
  for (const entry of waiting.splice(0)) cut(entry);
}, undefined, () => {
  // A crew with no faces is the room as it was yesterday, which is a room. The
  // colour dot is still there underneath every one of these.
  failed = true;
  waiting.length = 0;
  console.warn('the avatar sheet did not load — falling back to colour alone');
});

function cut(entry) {
  const sw = sheet.width / COLS, sh = sheet.height / COLS;
  const col = entry.index % COLS, row = Math.floor(entry.index / COLS);
  const ctx = entry.canvas.getContext('2d');
  ctx.clearRect(0, 0, CELL, CELL);
  ctx.drawImage(sheet, col * sw, row * sh, sw, sh, 0, 0, CELL, CELL);
  entry.texture.needsUpdate = true;
}

// Whether an index is a real avatar. `null`/absent is the documented "no avatar"
// value and means the colour dot — so this is the gate every caller checks
// before asking for a face, and the reason nothing here ever degrades to a
// blank square.
export function hasAvatar(index) {
  return !failed && validAvatar(index) !== null;
}

// A texture for one cell. Returned immediately and filled in when the sheet
// lands, so a caller never has to be asynchronous about it.
export function avatarTexture(index) {
  if (!hasAvatar(index)) return null;
  const had = cache.get(index);
  if (had) return had;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = CELL;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const entry = { index, canvas, texture };
  cache.set(index, texture);
  if (sheet) cut(entry); else waiting.push(entry);
  return texture;
}
