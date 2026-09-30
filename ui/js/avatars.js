// lieutenant avatars: 8x8 sprite sheet (ui/img/avatars.png), index 0-63, row-major.
// CSS-sprite technique: background-size 800% 800% is relative to the element's
// OWN box, so the same percentage background-position works at any element
// size — no per-size pixel math, and no 64-file slice to maintain.
export const AVATAR_COUNT = 64;
export const AVATAR_COLS = 8;

/** The avatar index if `a` is a real one (integer in the sheet), else null — the colour dot. */
export function validAvatar(a) {
  return Number.isInteger(a) && a >= 0 && a < AVATAR_COUNT ? a : null;
}

export function avatarPosition(idx) {
  const col = idx % AVATAR_COLS, row = Math.floor(idx / AVATAR_COLS);
  return (col * 100 / (AVATAR_COLS - 1)).toFixed(3) + '% ' + (row * 100 / (AVATAR_COLS - 1)).toFixed(3) + '%';
}
// position is computed from a validated index, never interpolated from user
// input — no esc() needed.
export function avatarHtml(idx, cls) {
  if (validAvatar(idx) === null) return '';
  return '<span class="avatar' + (cls ? ' ' + cls : '') + '" style="background-position:' + avatarPosition(idx) + '"></span>';
}
// picker grid: a "none" cell (clears the avatar) + all 64 heads. Selection is
// read back via the clicked button's data-avatar, so the caller never needs to
// track index -> DOM mapping.
export function avatarGridHtml(selected) {
  let cells = '<button type="button" class="avatar-cell none' + (selected == null ? ' sel' : '') +
    '" data-avatar="" title="no avatar">✕</button>';
  for (let i = 0; i < AVATAR_COUNT; i++) {
    cells += '<button type="button" class="avatar-cell' + (selected === i ? ' sel' : '') +
      '" data-avatar="' + i + '" style="background-position:' + avatarPosition(i) + '" title="avatar ' + i + '"></button>';
  }
  return '<div class="avatar-grid">' + cells + '</div>';
}
// wire a freshly-rendered grid; onSelect(idx|null) fires on click and the
// clicked cell gets .sel (caller owns persisting the choice).
export function wireAvatarGrid(root, onSelect) {
  root.querySelectorAll('.avatar-cell').forEach((btn) => {
    btn.onclick = () => {
      root.querySelectorAll('.avatar-cell').forEach((b) => b.classList.remove('sel'));
      btn.classList.add('sel');
      const v = btn.dataset.avatar;
      onSelect(v === '' ? null : parseInt(v, 10));
    };
  });
}
