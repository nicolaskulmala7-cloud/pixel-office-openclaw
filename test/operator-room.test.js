'use strict';
// Operator agent + Operations Room: layout, integration, determinism, no 8-agent assumptions.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { startServer, tmp, REPO } = require('./helpers');

const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');
const L = JSON.parse(read('assets/office-layout.json'));
const room = (name) => L.rooms.find((r) => r.name === name);
const inRoom = (name, t) => room(name).tiles.some((x) => x.x === t.x && x.y === t.y);
const cell = (t) => L.collision[t.y][t.x];

const EXISTING = [
  ['coordinator', 'Diktator', 0, 'Command Center'], ['researcher', 'Researcher', 1, 'Research Lab'], ['writer', 'Writer', 2, 'Writing Studio'],
  ['reviewer', 'Reviewer', 3, 'Review Room'], ['market_trader', 'Trader', 4, 'Trading Floor'], ['crypto_analyst', 'Crypto', 5, 'Crypto Lab'],
  ['memecoin_scout', 'Memecoin Scout', 6, 'Memecoin War Room'], ['sports_analyst', 'Sports Analyst', 7, 'Sports Analytics Room'],
];

test('Operations Room is a real room in the generated layout; all existing rooms preserved', () => {
  const ops = room('Operations Room');
  assert.ok(ops, 'room exists');
  assert.equal(ops.tiles.length, 34 * 5);
  const xs = ops.tiles.map((t) => t.x), ys = ops.tiles.map((t) => t.y);
  assert.deepEqual([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)], [1, 34, 25, 29]);
  for (const n of ['Command Center', 'Research Lab', 'Writing Studio', 'Review Room', 'Hangout Room', 'Trading Floor', 'Crypto Lab', 'Memecoin War Room', 'Sports Analytics Room']) assert.ok(room(n), n);
  assert.equal(new Set(L.rooms.map((r) => r.name)).size, L.rooms.length, 'room names unique');
  assert.deepEqual([L.cols, L.rows], [36, 31]);
  assert.equal(L.collision.length, 31);
  assert.ok(L.collision.every((r) => r.length === 36));
  assert.deepEqual([L.collision[24][12], L.collision[24][23]], [2, 2], 'two doors from the side hallways');
  const src = read('tools/build-office-map.js');
  assert.match(src, /label: 'OPERATIONS'/);
  assert.doesNotMatch(src.slice(src.indexOf("case 'V'"), src.indexOf("case 'G'")), /#b22234|stars/i, 'no American flag art in the NOC');
});

test('Operator work target is a walkable seat inside the Operations Room; idle seat is a distinct Hangout seat', () => {
  const work = L.targets.work.operations;
  assert.deepEqual(work, { x: 16, y: 28, room: 'Operations Room' });
  assert.ok(inRoom('Operations Room', work));
  assert.equal(cell(work), 3, 'seat tile');
  assert.equal(L.targets.agentOrder.indexOf('operations'), 8);
  assert.equal(new Set(L.targets.agentOrder).size, L.targets.agentOrder.length);
  const idle = L.targets.idle[8];
  assert.deepEqual(idle, { x: 18, y: 22 });
  assert.ok(inRoom('Hangout Room', idle));
  assert.equal(cell(idle), 3);
  assert.equal(new Set(L.targets.idle.map((t) => `${t.x},${t.y}`)).size, L.targets.idle.length, 'every agent has its own idle seat');
  assert.ok(L.targets.idle.length >= L.targets.agentOrder.length);
  assert.equal(L.targets.idleOverrides.operations, undefined, 'Operator idles in the Hangout like the other specialists');
  assert.deepEqual(L.targets.idleOverrides.coordinator, { x: 17, y: 10, room: 'Command Center' }, 'Diktator stays in the Oval Office');
});

test('Operations Room is reachable on foot from the Oval Office desk and the Hangout', () => {
  const walk = (x, y) => [0, 2].includes(L.collision[y] && L.collision[y][x]);
  const reach = (from, to) => {
    const seen = new Set([`${from.x},${from.y}`]); const q = [from];
    while (q.length) {
      const { x, y } = q.shift();
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const X = x + dx, Y = y + dy, k = `${X},${Y}`;
        if (X === to.x && Y === to.y) return true;
        if (!seen.has(k) && walk(X, Y)) { seen.add(k); q.push({ x: X, y: Y }); }
      }
    }
    return false;
  };
  assert.ok(reach(L.targets.work.operations, L.targets.work.coordinator), 'NOC console -> Oval Office desk');
  assert.ok(reach(L.targets.work.operations, L.targets.idle[8]), 'NOC console -> Hangout seat');
});

test('map generation is deterministic: a fresh build reproduces the committed art and layout byte-for-byte', () => {
  const d = tmp('build-');
  fs.mkdirSync(path.join(d, 'tools')); fs.mkdirSync(path.join(d, 'assets'));
  fs.copyFileSync(path.join(REPO, 'tools/build-office-map.js'), path.join(d, 'tools/build-office-map.js'));
  execFileSync(process.execPath, [path.join(d, 'tools/build-office-map.js')], { stdio: 'ignore' });
  assert.ok(fs.readFileSync(path.join(d, 'assets/office-openclaw.png')).equals(fs.readFileSync(path.join(REPO, 'assets/office-openclaw.png'))));
  assert.equal(fs.readFileSync(path.join(d, 'assets/office-layout.json'), 'utf8'), read('assets/office-layout.json'));
});

test('no 8-agent assumptions: UI/dashboard map size, colours and sprite identity scale to 9 agents', () => {
  const html = read('index.html'), dash = read('dashboard.html');
  assert.match(html, /const COLS = 36;/); assert.match(html, /const ROWS = 31;/);
  assert.match(html, /<canvas id="gameCanvas" width="1152" height="992"><\/canvas>/);
  assert.equal(L.cols * 32, 1152); assert.equal(L.rows * 32, 992);
  assert.match(dash, /const ROWS = 31;/); assert.match(dash, /grid-template-rows: repeat\(31, 16px\)/); assert.match(dash, /height: 496px/);
  // Every collision assignment in both pages goes through padCollision (the built-in
  // default literal is padded on the next statement, asserted separately).
  assert.match(html, /default_COLLISION_MAP = padCollision\(default_COLLISION_MAP\);/);
  for (const [name, text, re] of [['index', html, /(?<![A-Za-z_])COLLISION_MAP = (?!default_COLLISION_MAP;)([^\n;]+);/g], ['dashboard', dash, /(?<![A-Za-z_])collisionMap = (?!\[\])([^\n;]+);/g]]) {
    for (const m of text.matchAll(re)) assert.match(m[1], /^padCollision\(/, `${name}: ${m[0]}`);
  }
  const colors = html.slice(html.indexOf('const AGENT_COLORS = ['), html.indexOf('];', html.indexOf('const AGENT_COLORS = [')));
  assert.ok((colors.match(/\{ color:/g) || []).length >= 9, 'a log colour per agent (no modulo aliasing)');
  assert.doesNotMatch(html, /slot % 8/);
  assert.match(dash, /char_\$\{sheet\}\.png/, 'dashboard uses slot % NUM_CHARS (char_6..8 do not exist)');
  // Sprite identity = (sheet slot % 6, hue cycle floor(slot / 6)) must be unique for every agent.
  const ids = new Set(Array.from({ length: 9 }, (_, s) => `${s % 6}/${Math.floor(s / 6)}`));
  assert.equal(ids.size, 9);
});

test('padCollision makes an old 25-row grid safe (live server not yet restarted)', () => {
  const html = read('index.html');
  const fnSrc = html.slice(html.indexOf('function padCollision(map)'), html.indexOf('default_COLLISION_MAP = padCollision'));
  const padCollision = new Function('ROWS', 'COLS', `${fnSrc}; return padCollision;`)(31, 36);
  const old = Array.from({ length: 25 }, () => Array(36).fill(0));
  const padded = padCollision(old);
  assert.equal(padded.length, 31);
  assert.ok(padded.slice(25).every((r) => r.length === 36 && r.every((c) => c === 1)), 'new rows are walls');
  assert.deepEqual(padCollision(null).length, 31);
});

test('agent map: Operator added everywhere with its own slot; existing agents unchanged; workers are not agents', async (t) => {
  const srv = await startServer({ BUSINESS_OS_KILLSWITCH_CLI: '/nonexistent/killswitch/system-kill.js' });
  t.after(() => srv.stop());
  const cfg = await (await fetch(srv.base + '/api/config')).json();
  const agents = cfg.agents;
  assert.equal(agents.length, 9);
  assert.equal(new Set(agents.map((a) => a.id)).size, 9, 'unique ids');
  assert.equal(new Set(agents.map((a) => a.color)).size, 9, 'unique sprite slots');
  for (const [id, name, color, rm] of EXISTING) {
    const a = agents.find((x) => x.id === id);
    assert.deepEqual([a.name, a.color, a.room], [name, color, rm], id);
  }
  const op = agents.find((a) => a.id === 'operations');
  assert.deepEqual([op.name, op.color, op.room], ['Operator', 8, 'Operations Room']);
  assert.ok(!agents.some((a) => /startag|aalto/i.test(a.id)), 'external workers are not agents');
  const rooms = await (await fetch(srv.base + '/api/rooms')).json();
  assert.ok(rooms.some((r) => r.name === 'Operations Room'));

  const html = read('index.html');
  assert.match(html, /\{ id: 'operations', name: 'Operator', role: 'Operations \(runtime visibility, read-only\)', color: 8, room: 'Operations Room' \}/);
  const sync = read('openclaw-pixel-sync.js');
  const map = [...sync.matchAll(/\{ openclaw: '([a-z_]+)', pixel: '([a-z_]+)', slot: (\d+), name: '([^']+)', room: '([^']+)' \}/g)].map((m) => ({ oc: m[1], pixel: m[2], slot: Number(m[3]), name: m[4], room: m[5] }));
  assert.equal(map.length, 9);
  assert.deepEqual(map.map((m) => m.slot), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(map.find((m) => m.oc === 'operations'), { oc: 'operations', pixel: 'operations', slot: 8, name: 'Operator', room: 'Operations Room' });
  for (const m of map) assert.ok(room(m.room), `sync room ${m.room} exists in layout`);
  assert.match(sync, /if \(task\.agentId === 'operations'\) return 'system_report';/);
  assert.ok(!map.some((m) => /startag|aalto/i.test(m.oc)));
});

test('server replaces an obsolete (smaller) persisted map with the generated layout, with a backup', async (t) => {
  const old = JSON.parse(read('test/fixtures/original-office-layout.json')); // original committed map (pre-change)
  const dataDir = tmp('pixel-old-');
  fs.writeFileSync(path.join(dataDir, 'map.json'), JSON.stringify({ collision: old.collision, rooms: old.rooms, updatedAt: 'x' }));
  fs.writeFileSync(path.join(dataDir, 'pixel_collision.json'), JSON.stringify(old.collision));
  const srv = await startServer({ BUSINESS_OS_KILLSWITCH_CLI: '/nonexistent/killswitch/system-kill.js', PIXEL_DATA_DIR_OVERRIDE: dataDir });
  t.after(() => srv.stop());
  const collision = await (await fetch(srv.base + '/api/collision')).json();
  assert.deepEqual(collision, L.collision, 'served collision matches the generated layout');
  assert.ok((await (await fetch(srv.base + '/api/rooms')).json()).some((r) => r.name === 'Operations Room'));
  assert.ok(fs.existsSync(path.join(dataDir, 'map.pre-layout-resize-backup.json')), 'old map backed up');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'map.pre-layout-resize-backup.json'), 'utf8')).collision.length, 25);
});

test('a same-size edited map (user edits) is kept, not overwritten', async (t) => {
  const edited = JSON.parse(JSON.stringify(L.collision));
  edited[26][5] = 1; // a user-placed obstacle in the NOC
  const dataDir = tmp('pixel-edit-');
  fs.writeFileSync(path.join(dataDir, 'map.json'), JSON.stringify({ collision: edited, rooms: L.rooms, updatedAt: 'x' }));
  const srv = await startServer({ BUSINESS_OS_KILLSWITCH_CLI: '/nonexistent/killswitch/system-kill.js', PIXEL_DATA_DIR_OVERRIDE: dataDir });
  t.after(() => srv.stop());
  assert.equal((await (await fetch(srv.base + '/api/collision')).json())[26][5], 1);
  assert.equal(fs.existsSync(path.join(dataDir, 'map.pre-layout-resize-backup.json')), false);
});

test('a 31-row grid saved from an old padded map (Operations Room all walls) is treated as stale', async (t) => {
  const old = JSON.parse(read('test/fixtures/original-office-layout.json')); // original committed map (pre-change)
  const padded = [...old.collision.map((r) => r.slice()), ...Array.from({ length: 6 }, () => Array(36).fill(1))];
  assert.equal(padded.length, 31);
  const dataDir = tmp('pixel-padded-');
  fs.writeFileSync(path.join(dataDir, 'map.json'), JSON.stringify({ collision: padded, rooms: old.rooms, updatedAt: 'x' }));
  const srv = await startServer({ BUSINESS_OS_KILLSWITCH_CLI: '/nonexistent/killswitch/system-kill.js', PIXEL_DATA_DIR_OVERRIDE: dataDir });
  t.after(() => srv.stop());
  const collision = await (await fetch(srv.base + '/api/collision')).json();
  assert.equal(collision[28][16], 3, 'Operator console seat walkable again');
  assert.deepEqual(collision, L.collision);
  assert.ok(fs.existsSync(path.join(dataDir, 'map.pre-layout-resize-backup.json')));
});
