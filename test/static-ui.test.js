'use strict';
// Static checks: Finnish flags, intended scope only, existing worker UI preserved.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const REPO = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');

function decodePng(file) {
  const b = fs.readFileSync(file); let i = 8, w, h, ch; const idat = [];
  while (i < b.length) { const len = b.readUInt32BE(i), type = b.toString('ascii', i + 4, i + 8), d = b.slice(i + 8, i + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); ch = d[9] === 6 ? 4 : 3; } if (type === 'IDAT') idat.push(d); i += 12 + len; }
  const raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * ch, out = Buffer.alloc(w * h * ch); let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) { const f = raw[y * (stride + 1)], line = raw.slice(y * (stride + 1) + 1, (y + 1) * (stride + 1)), cur = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) { const a = x >= ch ? cur[x - ch] : 0, up = prev[x], c = x >= ch ? prev[x - ch] : 0; let v = line[x];
      if (f === 1) v += a; else if (f === 2) v += up; else if (f === 3) v += (a + up) >> 1; else if (f === 4) { const p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c; } cur[x] = v & 255; }
    cur.copy(out, y * stride); prev = cur; }
  return { w, h, ch, out };
}
const countColor = (img, [r, g, b]) => { let n = 0; for (let i = 0; i < img.out.length; i += img.ch) if (img.out[i] === r && img.out[i + 1] === g && img.out[i + 2] === b) n++; return n; };

// Connected components of the Finnish-flag blue; the Nordic cross spans the whole flag,
// so each component's bounding box is the flag's full size.
function blueComponents(img) {
  const key = (x, y) => y * img.w + x;
  const isBlue = (x, y) => { const o = key(x, y) * img.ch; return img.out[o] === 0x00 && img.out[o + 1] === 0x35 && img.out[o + 2] === 0x80; };
  const seen = new Set(); const comps = [];
  for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) {
    if (!isBlue(x, y) || seen.has(key(x, y))) continue;
    const c = { minx: x, maxx: x, miny: y, maxy: y }; const q = [[x, y]]; seen.add(key(x, y));
    while (q.length) { const [a, b] = q.pop(); c.minx = Math.min(c.minx, a); c.maxx = Math.max(c.maxx, a); c.miny = Math.min(c.miny, b); c.maxy = Math.max(c.maxy, b);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const X = a + dx, Y = b + dy; if (X >= 0 && Y >= 0 && X < img.w && Y < img.h && !seen.has(key(X, Y)) && isBlue(X, Y)) { seen.add(key(X, Y)); q.push([X, Y]); } } }
    comps.push(c);
  }
  return { comps, isBlue };
}

test('every Oval Office flag is a rectangular Finnish flag (~11:18) with the official cross geometry', () => {
  const src = read('tools/build-office-map.js');
  assert.doesNotMatch(src, /stars & stripes|#b22234|#3c3b6e/i, 'no US flag drawing code');
  const png = decodePng(path.join(REPO, 'assets/office-openclaw.png'));
  assert.equal(countColor(png, [0xb2, 0x22, 0x34]), 0, 'no US-flag red pixels');
  assert.equal(countColor(png, [0x3c, 0x3b, 0x6e]), 0, 'no US-flag canton pixels');
  const { comps, isBlue } = blueComponents(png);
  const spec = JSON.parse(read('tools/office-spec.json'));
  const flagCount = Object.values(spec.rooms).reduce((n, r) => n + r.template.reduce((m, row) => m + (row.match(/(?<!f)f/g) || []).length, 0), 0);
  assert.equal(comps.length, flagCount, 'one Finnish flag per flag stand in the spec');
  assert.ok(flagCount >= 2);
  const runs = (cells) => cells.join('').match(/(.)\1*/g).map((r) => r.length / 2); // screen px -> art px
  for (const c of comps) {
    const W = c.maxx - c.minx + 1, H = c.maxy - c.miny + 1;
    assert.equal(W, 26, 'width 13 art px'); assert.equal(H, 16, 'height 8 art px');
    assert.ok(W > H, 'rectangular, wider than tall');
    assert.ok(Math.abs(H / W - 11 / 18) < 0.01, `H:W ${H / W} ~ 11:18`);
    const top = []; for (let x = c.minx; x <= c.maxx; x++) top.push(isBlue(x, c.miny) ? 'B' : 'w');
    const left = []; for (let y = c.miny; y <= c.maxy; y++) left.push(isBlue(c.minx, y) ? 'B' : 'w');
    assert.deepEqual(runs(top), [4, 2, 7], 'horizontal 5+3+10 scaled to 13');
    assert.deepEqual(runs(left), [3, 2, 3], 'vertical 4+3+4 scaled to 8');
    // white field in all four corners
    for (const [x, y] of [[c.minx, c.miny], [c.maxx, c.miny], [c.minx, c.maxy], [c.maxx, c.maxy]]) {
      const o = (y * png.w + x) * png.ch; assert.deepEqual([png.out[o], png.out[o + 1], png.out[o + 2]], [0xf7, 0xf7, 0xf4]);
    }
  }
  const L = JSON.parse(read('assets/office-layout.json'));
  const oval = L.rooms.find((r) => r.name === 'Command Center');
  for (const c of comps) assert.ok(oval.tiles.some((t) => t.x === Math.floor(c.minx / 32) && t.y === Math.floor(c.miny / 32)), 'flag inside the Oval Office');
});

test('no US flag emoji anywhere in served UI files; unrelated en-US locale untouched', () => {
  for (const f of ['index.html', 'dashboard.html', 'nuclear-option.js', 'server.js']) {
    const text = read(f);
    assert.ok(!text.includes('\u{1F1FA}\u{1F1F8}'), `${f} contains the US flag emoji`);
  }
  assert.match(read('index.html'), /recognition\.lang = 'en-US'/, 'speech-recognition locale is not a flag and stays');
});

test('index.html: nuclear-option script added once; existing worker controls preserved', () => {
  const html = read('index.html');
  assert.equal(html.split('<script src="nuclear-option.js"></script>').length - 1, 1);
  for (const s of ['TURN OFF', 'TURN ON', 'TEST POLL', 'TEST ALERT', "postWorkerControl('aalto_seat_watcher',{enabled:false})", "postWorkerControl('aalto_seat_watcher',{enabled:true})", "action:'test_poll'", "action:'test_alert'", 'TEST CODEX HANDOFF', 'function renderWorkers()']) {
    assert.ok(html.includes(s), `missing existing UI: ${s}`);
  }
});

test('server.js and new modules parse', () => {
  const { execFileSync } = require('child_process');
  for (const f of ['server.js', 'killswitch-bridge.js', 'business-bridge.js', 'activity.js', 'command-center.js', 'nuclear-option.js', 'tools/build-office-map.js', 'openclaw-pixel-sync.js']) {
    execFileSync(process.execPath, ['--check', path.join(REPO, f)]);
  }
});
