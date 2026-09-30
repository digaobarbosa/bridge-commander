'use strict';
// filegate — which files the artifact routes (GET /artifacts/<dir>/<rel>,
// GET and PUT /api/artifact) may read and write, and how. The board has no auth
// of its own (the network boundary is the auth boundary), so this module is the
// whole difference between an artifact editor and remote arbitrary-file access
// on this machine. Every guard below is load-bearing; there is no flag to turn
// any of them off.
//
// The allow-list, in one place:
//   card       a uri listed verbatim in some live card's attributes.artifacts
//   attachment the same, for an attachment:// uri (read-only: an upload is the
//              record of what was sent)
//   playbook   `<workspace playbooks dir>/<name>.md`, one level, no symlink
//   packaged   the same in the packaged playbooks dir — readable, never written
//   charter    `<workspace>/lieutenants/<registered id>/README.md`
//   hook       an executable under `.bridge-commander/hooks/`, one or two deep
// Every directory is BUILT here and compared for equality — never taken from
// the client. A charter and a hook are BOARD-OWNED: the board built the path,
// so a missing file is a state (read as empty, created on the first write),
// not a 404.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { charterPath, isId, STATE_DIR_NAME } = require(path.join(__dirname, 'layout.js'));
const { hooksDir, LIFECYCLE_EVENTS } = require(path.join(__dirname, 'hooks.js'));
const { playbooksDir, PACKAGED_PLAYBOOKS_DIR } = require(path.join(__dirname, 'playbooks.js'));

// Extension → Content-Type for raw artifact byte serving. Images, video, and
// audio render inline in the viewer; pdf may render inline; everything else
// downloads.
const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.avif': 'image/avif',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav',
  '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.flac': 'audio/flac',
  // A rendered page and the things it pulls in beside itself.
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
};

// Content-derived version for a file the UI may edit: read hands it out, write
// demands it back, and a mismatch is a 409 instead of a lost edit. mtime+size
// would miss two writes in the same second at the same length.
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const err = (code, error) => ({ code, error });

// path.resolve is idempotent on a clean absolute path — a `..` segment or a
// relative path changes it, so `<dir>/../../board.json` never gets past this.
const clean = (file) => path.resolve(file) === file;
// A symlink AT the leaf is not the file: what it points at is what would be
// read or written. ENOENT is fine — that is the create.
function notALink(file) {
  try { return !fs.lstatSync(file).isSymbolicLink(); }
  catch (e) { return e.code === 'ENOENT'; }
}

/**
 * createFileGate(opts) -> { classify, read, write, dirServable, readDir }
 *   workspace       the board's workspace, already realpath'd
 *   cards()         the live cards (their attributes.artifacts are the allow-list)
 *   lieutenants()   the registered lieutenants (their charters are writable)
 *   attachment(id)  stored attachment meta {path, name, mime} or null
 *   maxBytes        the byte cap for a raw read and for a write
 */
function createFileGate({ workspace, cards, lieutenants, attachment, maxBytes }) {
  const stateDir = path.join(workspace, STATE_DIR_NAME);

  function listedOnCard(uri) {
    return cards().some((c) => Array.isArray(c.attributes && c.attributes.artifacts) &&
      c.attributes.artifacts.some((a) => a && a.uri === uri));
  }

  // A playbook: `<playbooks dir>/<name>.md`, one level deep, no symlink.
  // 'workspace' | 'packaged' | '' — the two populations resolvePlaybook picks
  // between; the packaged set is a git checkout of this repo, never written.
  function playbookSource(file) {
    if (path.extname(file) !== '.md') return '';
    const dir = path.dirname(file);
    const source = dir === playbooksDir(stateDir) ? 'workspace'
      : dir === PACKAGED_PLAYBOOKS_DIR ? 'packaged' : '';
    return source && notALink(file) ? source : '';
  }

  // A charter: charterPath() BUILDS the only acceptable path from the workspace
  // and a REGISTERED id, and the file has to equal it — which refuses an
  // unregistered id, another file in that folder, a subdirectory and a client
  // directory prefix all at once.
  function isCharter(file) {
    return lieutenants().some((l) => charterPath(workspace, l.id) === file) && notALink(file);
  }

  // A hook: the namespace hooks.js defines — ONE level deep (a named hook) or
  // TWO (a lifecycle hook, in its event's directory), both names id-shaped.
  //   null     not a hook path; the other allow-lists decide
  //   true     a hook path the board reads and writes
  //   {error}  a LEGAL hook path whose event directory is not there. Answering
  //            "unknown artifact" to it would be a lie: the name is fine, only
  //            a directory is missing — so it says which, and what fires.
  function hookTarget(file) {
    if (!isId(path.basename(file))) return null;
    const dir = path.dirname(file);
    const root = hooksDir(workspace);
    let event = ''; // '' = a named hook; otherwise the event directory it sits in
    if (dir !== root) {
      if (path.dirname(dir) !== root || !isId(path.basename(dir))) return null;
      event = path.basename(dir);
    }
    let real;
    try { real = fs.realpathSync(dir); }
    catch (e) {
      if (e.code !== 'ENOENT') return null;
      // `hooks/` is a constant the board owns, so write() makes it — the same
      // one level it makes for a charter nobody has written yet.
      if (!event) return true;
      // An event directory is NOT a constant: creating one invents a lifecycle
      // event, and a typo'd event is a hook that silently never fires.
      return err(400, 'no hook event directory "' + event + '" — the board fires '
        + LIFECYCLE_EVENTS.join(', ') + '. Create ' + dir + ' yourself if that is really the event: '
        + 'one invented here would be a hook that never runs');
    }
    // Reached without following a link: a symlinked hooks/ (or event dir)
    // points somewhere else, and somewhere else is what this refuses. A leaf
    // that is not a regular file (symlink, directory, socket) is refused too.
    if (real !== dir) return null;
    try { if (!fs.lstatSync(file).isFile()) return null; }
    catch (e) { if (e.code !== 'ENOENT') return null; }
    return true;
  }

  /**
   * classify(uri) -> {kind, file, writable, boardOwned} | {error, code}
   * kind: hook | charter | playbook | packaged | attachment | card. `file` is
   * the on-disk path for a file:// or bare card uri, '' for an attachment
   * (read() resolves it). An unknown uri is {code: 404}.
   */
  function classify(uri) {
    uri = typeof uri === 'string' ? uri : '';
    const local = uri.startsWith('file://') && clean(uri.slice('file://'.length))
      ? uri.slice('file://'.length) : '';
    // The hook refusal comes first: it answers a legal path, card-listed or not.
    const hook = local ? hookTarget(local) : null;
    if (hook && hook.error) return hook;
    const charter = !!local && isCharter(local);
    const playbook = local ? playbookSource(local) : '';
    const card = listedOnCard(uri);
    if (!hook && !charter && !playbook && !card) return err(404, 'unknown artifact');
    const attached = /^attachment:\/\/(.+)$/.test(uri);
    // One kind per uri: the shapes are disjoint on disk, except a card may also
    // list one of the others — the board-owned kind wins, `writable` keeps both.
    const kind = hook ? 'hook' : charter ? 'charter'
      : playbook === 'workspace' ? 'playbook' : playbook ? 'packaged'
      : attached ? 'attachment' : 'card';
    return {
      kind,
      file: attached ? '' : uri.startsWith('file://') ? uri.slice('file://'.length) : uri,
      // Only a clean file:// path is ever written; an attachment never is.
      writable: !!local && (card || !!hook || charter || playbook === 'workspace'),
      boardOwned: !!hook || charter,
    };
  }

  /**
   * read(uri, {raw}) -> {error, code}
   *   | raw:  {bytes, headers}   the file's bytes with a real Content-Type
   *   | text: {name, content, version}
   */
  function read(uri, { raw } = {}) {
    const c = classify(uri);
    if (c.error) return c;
    let file = c.file;
    let name = path.basename(file);
    let attMime = '';
    if (c.kind === 'attachment') {
      const meta = attachment(/^attachment:\/\/(.+)$/.exec(uri)[1]);
      if (!meta) return err(404, 'unknown attachment');
      file = meta.path; name = meta.name; attMime = meta.mime || '';
    }
    if (!raw) {
      let data;
      try { data = fs.readFileSync(file); }
      catch (e) {
        // A board-owned file not written yet is the empty document at version
        // '' — exactly what write() reads as "I expect no file", so the first
        // save creates it. A card's missing file is genuinely unreadable.
        if (c.boardOwned && e.code === 'ENOENT') return { name, content: '', version: '' };
        return err(404, 'unreadable: ' + e.message);
      }
      if (data.length > 2e6) return err(413, 'file too large to preview');
      if (data.includes(0)) return err(415, 'binary file');
      return { name, content: data.toString('utf8'), version: sha256(data) };
    }
    // Byte mode. An attachment path is already vetted by its sidecar; anything
    // else must be a clean absolute file:// path.
    if (c.kind !== 'attachment') {
      if (!uri.startsWith('file://')) return err(400, 'not a file artifact');
      if (!clean(file)) return err(400, 'unsafe artifact path');
    }
    let st;
    try { st = fs.statSync(file); }
    catch (e) { return err(404, 'unreadable: ' + e.message); }
    if (!st.isFile()) return err(404, 'not a file');
    if (st.size > maxBytes) return err(413, 'artifact too large (max ' + maxBytes + ' bytes)');
    const ext = path.extname(name).toLowerCase();
    // A curated .html/.htm artifact (teach-me page, report) is meant to be
    // RENDERED. Never an attachment (an uploaded .html keeps its neutralized
    // download) and never a HOOK: a hook's basename is the writer's choice, so
    // rendering `hooks/report.html` would turn the hook editor into script on
    // the board's origin.
    const isHtml = c.kind !== 'attachment' && c.kind !== 'hook' && (ext === '.html' || ext === '.htm');
    const ctype = isHtml ? 'text/html; charset=utf-8'
      : c.kind === 'attachment' ? (attMime || 'application/octet-stream')
      : (MIME[ext] || 'application/octet-stream');
    // Images, video, audio, pdf and rendered html show inline; other binaries
    // download. nosniff pins the Content-Type; the sandbox CSP neutralizes an
    // uploaded SVG/HTML navigated to as a document. A curated .html artifact is
    // exempt — sandboxing the captain's own page on a board anyone on the
    // tailnet can drive defends nothing.
    const inline = isHtml || /^(image|video|audio)\//.test(ctype) || ctype === 'application/pdf';
    let bytes;
    try { bytes = fs.readFileSync(file); }
    catch (e) { return err(404, 'unreadable: ' + e.message); }
    return {
      bytes,
      headers: {
        'Content-Type': ctype,
        'Cache-Control': 'private, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
        ...(isHtml ? {} : { 'Content-Security-Policy': 'sandbox' }),
        'Content-Disposition': (inline ? 'inline' : 'attachment') + '; filename="' + name.replace(/["\\\r\n]/g, '_') + '"',
      },
    };
  }

  /**
   * write(uri, content, version) -> {version, bytes} | {conflict: {version, content}} | {error, code}
   * `version` is what the writer read ('' = "I expect no file"). A file that
   * moved since is a conflict and nothing is written — for EVERY writer, agent
   * included: the door is locked on both sides or it is not locked.
   */
  function write(uri, content, version) {
    const c = classify(uri);
    if (c.error) return c.code === 404 ? err(403, 'not an artifact of any card — refusing to write') : c;
    if (!c.writable) {
      // A packaged playbook is a git checkout of this repo: the edit is a copy.
      if (c.kind === 'packaged') return err(403, 'a packaged playbook is never written — copy it to the workspace first');
      return err(403, uri.startsWith('file://') ? 'unsafe artifact path' : 'only file:// artifacts are writable');
    }
    const file = c.file;
    const expected = String(version || '');
    // A listed file not on disk yet is CREATED (a drawing's .svg beside its
    // source) under the same lost-update rule: '' means "I expect no file".
    // The directory has to be real, for the same reason the file does.
    let st = null, real;
    try { st = fs.statSync(file); real = fs.realpathSync(file); }
    catch (e) {
      if (e.code !== 'ENOENT' || expected !== '') return err(404, 'unreadable: ' + e.message);
      const dir = path.dirname(file);
      // A charter's folder and the workspace's `hooks/` are the board's to make
      // (never an EVENT dir — hookTarget refused that above). mkdir is a no-op
      // on a symlink, which the realpath check below still refuses.
      if (c.boardOwned) { try { fs.mkdirSync(dir, { recursive: true }); } catch (e2) { /* the check below answers */ } }
      try { if (fs.realpathSync(dir) !== dir) throw new Error('symlink'); }
      catch (e2) { return err(403, 'artifact path resolves elsewhere (symlink) — refusing to write'); }
    }
    if (st) {
      if (!st.isFile()) return err(403, 'not a regular file');
      if (real !== file) return err(403, 'artifact path resolves elsewhere (symlink) — refusing to write');
      let cur;
      try { cur = fs.readFileSync(file); }
      catch (e) { return err(404, 'unreadable: ' + e.message); }
      if (cur.includes(0)) return err(415, 'binary file');
      const now = sha256(cur);
      if (expected !== now) return { conflict: { version: now, content: cur.toString('utf8') } };
    }
    const next = Buffer.from(content, 'utf8');
    if (next.length > maxBytes) return err(413, 'content too large (max ' + maxBytes + ' bytes)');
    // Atomic swap: a sibling temp file renamed over the original. A rename
    // either happened or it didn't; a truncate-and-write can die half-written.
    const tmp = path.join(path.dirname(file), '.' + path.basename(file) + '.bc-' + process.pid + '-' + Date.now() + '.tmp');
    try {
      // An existing file keeps its mode. A hook created here is born
      // EXECUTABLE — the runner skips one that is not, and a phone has no chmod.
      fs.writeFileSync(tmp, next, st ? { mode: st.mode & 0o777 } : (c.kind === 'hook' ? { mode: 0o755 } : {}));
      fs.renameSync(tmp, file);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (e2) {}
      return err(500, 'write failed: ' + e.message);
    }
    return { version: sha256(next), bytes: next.length };
  }

  /**
   * dirServable(dir) -> true when `dir` is the directory of a file:// artifact
   * listed on a live card. That folder is what a page's relative paths mean.
   */
  function dirServable(dir) {
    return !!dir && clean(dir) &&
      cards().some((c) => Array.isArray(c.attributes && c.attributes.artifacts) &&
        c.attributes.artifacts.some((a) => a && typeof a.uri === 'string' && a.uri.startsWith('file://') &&
          path.dirname(a.uri.slice('file://'.length)) === dir));
  }

  /**
   * readDir(dir, rel) -> {bytes, headers} | {error, code} — a sibling of a
   * listed artifact, for GET /artifacts/<dir>/<rel>. The file must stay inside
   * <dir>: not as a security claim, but because "this URL means this folder"
   * is what makes a relative path mean anything.
   */
  function readDir(dir, rel) {
    if (!dirServable(dir)) return err(404, 'unknown artifact directory');
    const file = path.resolve(dir, rel);
    if (!file.startsWith(dir + path.sep)) return err(403, 'outside the artifact directory');
    let st;
    try { st = fs.statSync(file); }
    catch (e) { return err(404, 'unreadable: ' + e.message); }
    if (!st.isFile()) return err(404, 'not a file');
    if (st.size > maxBytes) return err(413, 'artifact too large (max ' + maxBytes + ' bytes)');
    // No sandbox CSP: the board has no auth and binds to the tailnet, so anyone
    // who reaches it can already ask a lieutenant to run anything. Hardening
    // this page against that board defends nothing.
    return {
      bytes: fs.readFileSync(file),
      headers: {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    };
  }

  return { classify, read, write, dirServable, readDir };
}

module.exports = { createFileGate };
