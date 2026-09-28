// panescroll.js — keep a scrolled-up reader on the same text across 👁 frames.
//
// A frame is the pane's last N lines of history plus its screen. Once history
// is deeper than N, every new line of output pushes one line off the top of the
// frame, so keeping scrollTop alone lets the text drift under the reader. The
// fix is to measure how far the frame slid and scroll back by that much.

// How many non-blank lines must agree before a slide counts. Blank lines are
// skipped: a run of them matches anywhere and would anchor to the wrong place.
const PROBE = 3;

// frameSlide(oldLines, newLines) -> how many lines the new frame's head moved
// UP relative to the old one (>= 0), or null when the head is not in the old
// frame at all (a /clear, or more new output than a frame holds).
//
// The head is measured, not the reader's own row: the head is settled history,
// while the rows near the bottom repaint every frame (spinner, composer) and
// would never match. A reader whose text slid off the top gets a scrollTop
// below 0, which the browser clamps to the oldest line still there.
export function frameSlide(oldLines, newLines) {
  const probe = [];
  for (let j = 0; j < newLines.length && probe.length < PROBE; j++) {
    if (newLines[j].trim()) probe.push(j);
  }
  if (!probe.length) return null;
  for (let d = 0; d < oldLines.length; d++) {
    if (probe.every((j) => oldLines[j + d] === newLines[j])) return d;
  }
  return null;
}
