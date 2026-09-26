#!/usr/bin/env node
// dev/room-shots.js — photograph the room, with no headset and no display.
//
//   node dev/room-shots.js [--out DIR] [--size WxH] [--url URL] [--keep]
//
// One command. It starts the frontend playground (dev/ui-server.js, the same
// fixture board), drives a headless Chrome at ui/bridge3d.html with the dev
// flags on, enters a REAL immersive session through the emulated runtime, poses
// the head at each viewpoint in ui/js/bridge3d/viewpoints.js, and writes a PNG
// per viewpoint plus a manifest. Default output: dev/shots/.
//
// Node built-ins only — no Playwright, no Puppeteer, nothing to install. Chrome
// speaks the DevTools Protocol over a WebSocket and Node has had a WebSocket
// client since 22; the whole driver below is that plus JSON.
//
// What it can and cannot tell you: a photograph proves the room did not go
// blank and shows what it looks like. It does NOT prove a target is 6° — exact
// pixels differ across drivers and would only train you to ignore the check.
// The arc is measured in test/bridge3d.test.js.
//
// So this run asserts two things and no more. Structural: every frame has
// colour in it. And POINTABLE: it aims the head at one of each kind of thing in
// the room and checks the ray lights it up, because a room where the ray reaches
// nothing photographs perfectly and is completely dead — which it was, once,
// behind a glyph layer two millimetres in front of the colliders.
//
// See ui/js/bridge3d/README.md, and `vr-design` for every design number.
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');

// ---------- arguments ----------

function parseArgs(argv) {
  const a = { out: path.join(ROOT, 'dev', 'shots'), width: 1280, height: 960, url: '', keep: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--out') a.out = path.resolve(argv[++i] || '');
    else if (k === '--url') a.url = String(argv[++i] || '');
    else if (k === '--keep') a.keep = true;
    else if (k === '--size') {
      const m = /^(\d+)x(\d+)$/.exec(argv[++i] || '');
      if (!m) throw new Error('bad --size (want WxH, e.g. 1280x960)');
      a.width = +m[1]; a.height = +m[2];
    } else if (k === '--help' || k === '-h') a.help = true;
    else throw new Error('unknown argument: ' + k);
  }
  return a;
}

// ---------- chrome ----------

const CHROME_CANDIDATES = [
  process.env.CHROME, process.env.CHROME_PATH,
  'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser',
].filter(Boolean);

function findChrome() {
  for (const c of CHROME_CANDIDATES) {
    if (c.includes('/')) { if (fs.existsSync(c)) return c; continue; }
    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
      const p = path.join(dir, c);
      if (fs.existsSync(p)) return p;
    }
  }
  throw new Error('no Chrome found — install one or set CHROME=/path/to/chrome');
}

// Launch headless and hand back the DevTools endpoint it prints to stderr. The
// port is 0 (let the OS pick) so two runs never collide.
function launchChrome(bin, profileDir, width, height) {
  const child = spawn(bin, [
    '--headless=new',
    '--remote-debugging-port=0',
    '--user-data-dir=' + profileDir,
    '--no-sandbox', '--no-first-run', '--no-default-browser-check',
    '--disable-dev-shm-usage', '--hide-scrollbars', '--mute-audio',
    '--force-device-scale-factor=1',
    '--window-size=' + width + ',' + height,
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  return new Promise((resolve, reject) => {
    let err = '';
    const timer = setTimeout(() => reject(new Error('chrome never printed a debugger url:\n' + err)), 30000);
    child.stderr.on('data', (d) => {
      err += d;
      const m = /ws:\/\/[^\s]+/.exec(err);
      if (!m) return;
      clearTimeout(timer);
      child.stderr.removeAllListeners('data');
      child.stderr.resume();
      resolve({ child, wsUrl: m[0], port: (/127\.0\.0\.1:(\d+)/.exec(m[0]) || [])[1] });
    });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error('chrome exited (' + code + '):\n' + err)); });
  });
}

// ---------- the devtools protocol, in about thirty lines ----------

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('devtools socket refused: ' + wsUrl)), { once: true });
  });
  let id = 0;
  const pending = new Map();
  const listeners = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (!m.id) return (listeners.get(m.method) || (() => {}))(m.params);
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.error) p.reject(new Error(m.error.message));
    else p.resolve(m.result);
  });
  const send = (method, params) => new Promise((resolve, reject) => {
    const i = ++id;
    pending.set(i, { resolve, reject });
    ws.send(JSON.stringify({ id: i, method, params: params || {} }));
  });
  return { send, on: (method, fn) => listeners.set(method, fn), close: () => ws.close() };
}

async function evaluate(cdp, expression, opts) {
  const r = await cdp.send('Runtime.evaluate',
    Object.assign({ expression, awaitPromise: true, returnByValue: true }, opts || {}));
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error('in the page: ' + ((d.exception && d.exception.description) || d.text));
  }
  return r.result.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cdp, expression, what, ms = 30000) {
  const until = Date.now() + ms;
  for (;;) {
    if (await evaluate(cdp, '!!(' + expression + ')').catch(() => false)) return;
    if (Date.now() > until) throw new Error('gave up waiting for ' + what);
    await sleep(150);
  }
}

// ---------- the run ----------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('node dev/room-shots.js [--out DIR] [--size WxH] [--url URL] [--keep]');
    return 0;
  }

  const { VIEWPOINTS, PROBES } = await import(pathToFileURL(path.join(ROOT, 'ui', 'js', 'bridge3d', 'viewpoints.js')));

  // The board behind the room: the frontend playground, unless a URL was given
  // (point --url at a live server to photograph a real board instead).
  let dev = null;
  let base = args.url;
  if (!base) {
    const { startPlayground } = require(path.join(ROOT, 'dev', 'ui-server.js'));
    dev = await startPlayground({});
    base = dev.base;
  }
  const url = base.replace(/\/+$/, '') + '/ui/bridge3d.html?capture=1&xr=emulate';

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'room-shots-'));
  const bin = findChrome();
  const { child, port } = await launchChrome(bin, profile, args.width, args.height);

  let cdp = null;
  const shots = [];
  const probes = [];
  try {
    // The page target, found through the http side of the protocol.
    const list = await (async () => {
      for (let i = 0; i < 60; i++) {
        try {
          const r = await fetch('http://127.0.0.1:' + port + '/json/list').then((x) => x.json());
          const t = r.find((x) => x.type === 'page');
          if (t) return t;
        } catch (e) { /* still starting */ }
        await sleep(150);
      }
      throw new Error('chrome never offered a page target');
    })();
    cdp = await connect(list.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    // Anything the room says to a console it thinks nobody is reading. Without
    // this a broken import is "gave up waiting" and nothing else, which is a
    // miserable half hour.
    const errors = [];
    cdp.on('Runtime.exceptionThrown', (p) => {
      const d = p.exceptionDetails || {};
      errors.push((d.exception && d.exception.description) || d.text || 'exception');
    });
    cdp.on('Runtime.consoleAPICalled', (p) => {
      if (p.type !== 'error') return;
      errors.push((p.args || []).map((a) => a.value || a.description || a.type).join(' '));
    });

    await cdp.send('Page.navigate', { url });
    const complain = (e) => {
      if (errors.length) console.error('the page complained:\n  ' + errors.join('\n  '));
      throw e;
    };
    // The sky is 5.4 MB and arrives after the first frame. Shooting before it
    // lands photographs the holding colour, which looks exactly like a
    // regression and is not one.
    await waitFor(cdp, 'window.__bridge && document.getElementById("gate").classList.contains("ready")',
      'the room to load and the board to answer').catch(complain);
    await waitFor(cdp, 'window.__xr', 'the emulated headset to install').catch(complain);

    // Enter, as a person does: the same button, with a user gesture behind it,
    // so this exercises requestSession and not a private back door.
    await evaluate(cdp, 'document.getElementById("enter").click()', { userGesture: true });
    await waitFor(cdp, 'window.__xr.presenting', 'the immersive session to start').catch(complain);
    console.log('· immersive session running (emulated) at ' + url);

    fs.mkdirSync(args.out, { recursive: true });

    let scene = '';
    for (const v of VIEWPOINTS) {
      if (v.scene !== scene) {
        scene = v.scene;
        await evaluate(cdp, setScene(scene));
        await evaluate(cdp, 'window.__xr.frames(3)');
      }
      const aim = await evaluate(cdp, 'window.__xr.look(' + JSON.stringify(v.name) + ')');
      await evaluate(cdp, 'window.__xr.frames(4)');       // let the room settle and repaint
      const stats = await evaluate(cdp, 'window.__xr.frameStats()');
      // What the room costs to draw, per shot — the figure that says whether a
      // world built out of real objects still fits an 11 ms frame.
      const room = await evaluate(cdp, 'window.__bridge.stats()');
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const file = path.join(args.out, v.name + '.png');
      fs.writeFileSync(file, Buffer.from(data, 'base64'));
      // Structural only: did anything land on the canvas. Not a pixel compare.
      const blank = !stats || stats.colours < 12 || stats.litFraction < 0.005;
      shots.push({ name: v.name, scene: v.scene, why: v.why, file: path.relative(ROOT, file), aim, stats, room, ok: !blank });
      console.log((blank ? '✗ ' : '· ') + v.name.padEnd(14)
        + 'yaw ' + aim.yaw.toFixed(1).padStart(6) + '°  pitch ' + aim.pitch.toFixed(1).padStart(6) + '°  '
        + (stats ? stats.colours + ' colours, ' + (stats.litFraction * 100).toFixed(1) + '% lit' : 'NO FRAME')
        + (room ? ', ' + room.calls + ' draws' : '')
        + '  → ' + path.relative(ROOT, file));
    }

    // Can the ray still land? A photograph never shows this, and the ways it
    // breaks are all invisible — a glyph layer in front of the colliders, a
    // hidden panel that is still pointable at, a pointer flag the library
    // rewrites the moment you set it. So the run points at one of each kind of
    // thing and checks it lights up.
    let probeScene = '';
    for (const p of PROBES) {
      const want = p.scene || 'world';
      if (want !== probeScene) {
        probeScene = want;
        await evaluate(cdp, setScene(want));
        await evaluate(cdp, 'window.__xr.frames(3)');
      }
      // The hand converges with the gaze at 1.75 m unless it is told otherwise,
      // and a ray converging out there sails straight past the rail at 1.20 m.
      if (p.reach) await evaluate(cdp, `window.__xr.reach(${p.reach})`);
      await evaluate(cdp, `window.__xr.aim(${p.yaw}, ${p.pitch})`);
      await evaluate(cdp, 'window.__xr.frames(4)');
      const lit = await evaluate(cdp, 'window.__bridge.lit()');
      const on = (lit || []).find((t) => t.name === p.expect);
      probes.push({ ...p, lit, ok: !!on });
      console.log((on ? '· ' : '✗ ') + ('ray on ' + p.name).padEnd(24)
        + (on ? on.state + ' at ' + on.distance.toFixed(2) + ' m' : 'NOTHING — the ray reaches nothing there'));
    }

    // ---- the wall, worked ------------------------------------------------
    //
    // Three things a still photograph of the wall cannot tell you, and the
    // third one is the reason the wall is built the way it is.
    //
    //   · how many titles are LEGIBLE at once — bound to a row, shown whole
    //     with no ellipsis, and with nothing covering them. Counting rows that
    //     merely exist is what put "53 of 70" on a wall of 16-character stubs
    //   · that pressing a lieutenant's FACE filters it, with no typing
    //   · that scrolling a lane to the bottom of its column changes the uikit
    //     node count by exactly zero
    //
    // The last one is not a nicety. The version of this surface that held one
    // live node per card killed his headset browser at about sixty rows, and
    // the wall holds ninety. So the pool is fixed and this is the proof.
    //
    // The frame time here is measured on whatever GPU this machine has, which
    // in CI is a software rasteriser — an absolute figure off it means nothing
    // against a 13.9 ms budget. What DOES travel is the ratio: the same room
    // with the wall shut and with the wall open, on the same renderer, plus
    // the draw calls and triangles, which are the same numbers everywhere.
    const BEAT = `(async () => {
      const t = [];
      let last = performance.now();
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => requestAnimationFrame(r));
        const now = performance.now(); t.push(now - last); last = now;
      }
      t.sort((a, b) => a - b);
      return { median: t[Math.floor(t.length / 2)], p95: t[Math.floor(t.length * 0.95)], frames: t.length };
    })()`;
    let wall = null;
    try {
      await evaluate(cdp, setScene('world'));
      await evaluate(cdp, 'window.__xr.frames(4)');
      const shut = await evaluate(cdp, BEAT);
      const shutRoom = await evaluate(cdp, 'window.__bridge.stats()');
      await evaluate(cdp, setScene('board'));
      await evaluate(cdp, 'window.__xr.look("board")');
      await evaluate(cdp, 'window.__xr.frames(4)');
      const full = await evaluate(cdp, 'window.__bridge.wall()');
      const openRoom = await evaluate(cdp, 'window.__bridge.stats()');
      const beat = await evaluate(cdp, BEAT);
      const scrolled = await evaluate(cdp, 'window.__bridge.wallScroll()');
      await evaluate(cdp, 'window.__xr.frames(6)');
      const after = await evaluate(cdp, 'window.__bridge.wall()');
      await evaluate(cdp, `window.__xr.look("board")`);
      await evaluate(cdp, 'window.__xr.frames(3)');
      let { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(args.out, 'wall-scrolled.png'), Buffer.from(data, 'base64'));

      const filtered = await evaluate(cdp, 'window.__bridge.wallFilter()');
      await evaluate(cdp, 'window.__xr.frames(4)');
      ({ data } = await cdp.send('Page.captureScreenshot', { format: 'png' }));
      fs.writeFileSync(path.join(args.out, 'wall-filtered.png'), Buffer.from(data, 'base64'));
      const afterFilter = await evaluate(cdp, 'window.__bridge.wall()');

      const flat = !!(full && after && afterFilter
        && full.nodes === after.nodes && full.nodes === afterFilter.nodes);
      wall = { full, scrolled, after, filtered: afterFilter, beat, shut, shutRoom, openRoom, poolHeldFlat: flat };
      console.log('· ' + 'the wall'.padEnd(24) + full.legible + ' of ' + full.cards
        + ' titles LEGIBLE at once (' + full.shown + ' rows bound, ' + full.chars
        + ' chars a lane, titles run ' + full.titleLen.min + '-' + full.titleLen.max
        + ', median ' + full.titleLen.median + ')');
      console.log('· ' + 'do tiles cover tiles'.padEnd(24)
        + full.tileGapDeg + '° between neighbours from the arc centre, '
        + full.tileGapLeaningDeg + '° leaning 20 cm — '
        + (Math.min(full.tileGapDeg, full.tileGapLeaningDeg) > 0 ? 'no tile covers another' : 'OCCLUDED'));
      console.log('· ' + 'what it costs'.padEnd(24)
        + shutRoom.calls + ' -> ' + openRoom.calls + ' draws, '
        + shut.median.toFixed(1) + ' -> ' + beat.median.toFixed(1) + ' ms median frame ('
        + (beat.median / shut.median).toFixed(2) + 'x, on THIS machine\'s renderer, not a headset)');
      console.log((flat ? '· ' : '✗ ') + 'the row pool'.padEnd(24)
        + (flat
          ? 'scrolled lane ' + scrolled.lane + ' (' + scrolled.held + ' cards) to its end and filtered — '
            + after.nodes + ' nodes throughout, unchanged'
          : 'GREW: ' + full.nodes + ' -> ' + after.nodes + ' -> ' + afterFilter.nodes));
      console.log((afterFilter.shown < full.shown ? '· ' : '✗ ') + 'a face filters'.padEnd(24)
        + 'pressing a face left ' + afterFilter.shown + ' of ' + afterFilter.cards
        + ' showing (' + (afterFilter.filters.join(', ') || 'nothing') + ')');
    } catch (e) {
      wall = { error: String((e && e.message) || e) };
      console.log('✗ the wall'.padEnd(26) + 'could not be driven: ' + wall.error);
    }

    // And can he MOVE a window? Grabbing is the one interaction the captain
    // named as a requirement rather than a nicety, and it is invisible in every
    // photograph: a panel that never budges looks exactly like a panel he has
    // not tried to move yet. So the run opens a chat, aims at its title bar,
    // squeezes, turns its head, releases, and checks the panel came along.
    let grab = null;
    try {
      await evaluate(cdp, setScene('chat'));
      await evaluate(cdp, 'window.__xr.frames(4)');
      const before = await evaluate(cdp, 'window.__bridge.panels()[0]');
      // The hand converges with the gaze at whatever it is aiming at, so it has
      // to be told the panel is nearer than the room — held at the shelf
      // radius, the ray sails past a surface standing at 1.10 m.
      await evaluate(cdp, `window.__xr.reach(${before && before.at ? before.at.dist : 1.1})`);
      // The bar sits at the top of the panel — its own slot's azimuth, and a
      // little above the panel's centre.
      await evaluate(cdp, `window.__xr.aim(${-(before && before.at ? before.at.az : 0)}, -3.0)`);
      await evaluate(cdp, 'window.__xr.frames(4)');
      const onBar = await evaluate(cdp, 'window.__bridge.lit().some((t) => /-bar$/.test(t.name))');
      await evaluate(cdp, 'window.__xr.device.controllers.right.updateButtonValue("squeeze", 1)');
      await evaluate(cdp, 'window.__xr.frames(3)');
      await evaluate(cdp, 'window.__xr.aim(-8, -22)');
      await evaluate(cdp, 'window.__xr.frames(6)');
      await evaluate(cdp, 'window.__xr.device.controllers.right.updateButtonValue("squeeze", 0)');
      await evaluate(cdp, 'window.__xr.frames(4)');
      const after = await evaluate(cdp, 'window.__bridge.panels()[0]');
      const moved = !!(before && after
        && Math.hypot(after.at.az - before.at.az, after.at.el - before.at.el) > 2);
      grab = { onBar, before, after, moved, placed: !!(after && after.placed) };
      console.log((moved ? '· ' : '✗ ') + 'grab a window'.padEnd(24)
        + (moved
          ? 'moved ' + Math.hypot(after.at.az - before.at.az, after.at.el - before.at.el).toFixed(1)
            + '° and stayed put' + (after.placed ? ' (his placement now)' : '')
          : 'DID NOT MOVE — squeeze reached nothing'));
    } catch (e) {
      grab = { error: String((e && e.message) || e) };
      console.log('✗ grab a window'.padEnd(26) + 'could not be driven: ' + grab.error);
    }

    const manifest = {
      generatedAt: new Date().toISOString(),
      grab, wall,
      url, size: args.width + 'x' + args.height,
      chrome: bin, board: args.url ? 'live server' : 'dev/ui-server.js fixture',
      note: 'Screenshots are structural evidence only — every arc figure is asserted in test/bridge3d.test.js, and every design number lives in the vr-design skill.',
      shots, probes,
    };
    fs.writeFileSync(path.join(args.out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

    if (errors.length) console.error('\nthe page complained:\n  ' + errors.join('\n  '));
    const bad = shots.filter((s) => !s.ok);
    const dead = probes.filter((p) => !p.ok);
    if (bad.length) console.log('\n' + bad.length + ' blank frame(s): ' + bad.map((s) => s.name).join(', '));
    if (dead.length) console.log((bad.length ? '' : '\n') + 'the ray lands on nothing at: ' + dead.map((p) => p.name).join(', '));
    if (!bad.length && !dead.length) {
      console.log('\n' + shots.length + ' shots in ' + path.relative(ROOT, args.out)
        + '/ (+ manifest.json), and the ray lands on all ' + probes.length + ' kinds of thing');
    }
    return bad.length || dead.length ? 1 : 0;
  } finally {
    if (cdp) try { cdp.close(); } catch (e) { /* going away anyway */ }
    child.kill();
    // Chrome is still flushing its profile while it dies, so wait for it to be
    // gone before deleting underneath it — otherwise cleanup throws ENOTEMPTY
    // and buries whatever really went wrong.
    await new Promise((r) => (child.exitCode === null ? child.once('exit', r) : r()));
    if (dev) await dev.stop();
    if (!args.keep) {
      try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
      catch (e) { console.error('(left ' + profile + ' behind: ' + e.message + ')'); }
    }
  }
}

// What has to be true for a scene's shots to be of anything. Driven through the
// room's own handles (window.__bridge), so the photograph is of the room doing
// its ordinary thing rather than of a rig posing it.
//
// 'world' is the room standing still. 'board' opens the board, 'chat' a
// lieutenant's conversation, 'card' a card brought forward. The last three are
// what a camera pointed at the room can never catch on its own, because they do
// not exist until somebody asks for them.
function setScene(scene) {
  return `(() => {
    const b = window.__bridge;
    for (const p of [...b.windows]) if (p.open) b.windows.close(p);
    ${scene === 'board' ? 'b.openBoard();' : ''}
    ${scene === 'chat' ? 'b.openChat();' : ''}
    ${scene === 'card' ? 'b.openCard();' : ''}
    return b.stats();
  })()`;
}

main().then((code) => process.exit(code), (e) => {
  console.error('room-shots: ' + ((e && e.stack) || e));
  process.exit(1);
});
