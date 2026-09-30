'use strict';
// Append-only JSON-lines files: the archive, the delivery queues, the chat logs.
// A crash mid-append can leave one torn line. It costs that line only, never the
// rest of the file: readers skip it, and sealJsonl ends it at boot so the next
// append does not glue a good record onto the torn one.
const fs = require('fs');

/**
 * Every parsable line of a jsonl file, in order. Missing file -> [].
 * @param {string} file
 * @param {(line: string) => void} [onBad] called with each line that did not parse
 * @returns {any[]}
 */
function readJsonl(file, onBad) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch (e) { if (onBad) onBad(line); }
  }
  return out;
}

/**
 * Terminate a torn last line with a newline. Appends only; never rewrites.
 * @param {string} file
 * @returns {boolean} true when the file ended mid-line and was sealed
 */
function sealJsonl(file) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch (e) { return false; }
  try {
    const size = fs.fstatSync(fd).size;
    if (!size) return false;
    const last = Buffer.alloc(1);
    fs.readSync(fd, last, 0, 1, size - 1);
    if (last[0] === 0x0a) return false;
  } finally { fs.closeSync(fd); }
  fs.appendFileSync(file, '\n');
  return true;
}

module.exports = { readJsonl, sealJsonl };
