'use strict';
// Compact, data-driven layout (tools/office-spec.json): invariants that hold for ANY spec.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { startServer, tmp, REPO } = require('./helpers');

const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');
const L = JSON.parse(read('assets/office-layout.json'));
const SPEC = JSON.parse(read('tools/office-spec.json'));
const O = JSON.parse(read('test/fixtures/original-office-layout.json')); // original committed map
const room = (name) => L.rooms.find((r) => r.name === name);
const inRoom = (name, t) => room(name).tiles.some((x) => x.x === t.x && x.y === t.y);
const cell = (t) => L.collision[t.y][t.x];
const LOGICAL = ['Command Center', 'Research Lab', 'Writing Studio', 'Review Room', 'Trading Floor', 'Crypto Lab', 'Memecoin War Room', 'Sports Analytics Room', 'Operations Room', 'Hangout Room', 'Achievement Hall'];

test('every logical room exists exactly once; sizes and counts come from the spec (no fixed room count/map size)', () => {
  for (const n of LOGICAL) assert.ok(room(n), n);
  assert.equal(L.rooms.length, Object.keys(SPEC.rooms).length);
  assert.equal(new Set(L.rooms.map((r) => r.name)).size, L.rooms.length);
  const sideW = (list) => (list.length ? list.reduce((s, k) => s + SPEC.rooms[k].template[0].length, 0) + list.length + 1 : 1);
  const cols = Math.max(...SPEC.floors.map((f) => sideW(f.left))) + SPEC.shaft_width + Math.max(...SPEC.floors.map((f) => sideW(f.right)));
  assert.deepEqual([L.cols, L.rows], [cols, SPEC.floors.length * (SPEC.room_height + 1) + 1]);
  assert.equal(L.collision.length, L.rows);
  assert.ok(L.collision.every((r) => r.length === L.cols));
});

test('rooms are compact: specialist rooms shrink 40-60% vs the original office', () => {
  for (const n of ['Research Lab', 'Writing Studio', 'Review Room', 'Trading Floor', 'Crypto Lab', 'Memecoin War Room']) {
    const before = O.rooms.find((r) => r.name === n).tiles.length;
    const after = room(n).tiles.length;
    const cut = 1 - after / before;
    assert.ok(cut >= 0.4 - 1e-9 && cut <= 0.6 + 1e-9, `${n}: ${before} -> ${after} tiles (${Math.round(cut * 100)}% smaller)`);
  }
  // Same rooms, less area; and the whole map is shorter despite adding Operations + Achievement Hall.
  const common = O.rooms.filter((r) => room(r.name));
  const area = (rs, get) => rs.reduce((s, r) => s + get(r).tiles.length, 0);
  assert.ok(area(common, (r) => room(r.name)) < area(common, (r) => r) * 0.7, 'shared rooms >=30% smaller overall (measured 35%)');
  assert.ok(L.cols * L.rows < O.collision.length * O.collision[0].length, 'map footprint smaller despite two added rooms');
});

test('every walkable tile is reachable; every room connects to the lift shaft', () => {
  const pass = (x, y) => L.collision[y] && [0, 2].includes(L.collision[y][x]);
  const shaft = { x: L.ui.shaft.x, y: 1 };
  const seen = new Set([`${shaft.x},${shaft.y}`]); const q = [shaft];
  while (q.length) {
    const { x, y } = q.shift();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const X = x + dx, Y = y + dy, k = `${X},${Y}`;
      if (!seen.has(k) && pass(X, Y)) { seen.add(k); q.push({ x: X, y: Y }); }
    }
  }
  for (const r of L.rooms) assert.ok(r.tiles.some((t) => seen.has(`${t.x},${t.y}`)), `${r.name} reachable from the shaft`);
  for (let y = 0; y < L.rows; y++) for (let x = 0; x < L.cols; x++) if (L.collision[y][x] === 0) assert.ok(seen.has(`${x},${y}`), `floor ${x},${y} reachable`);
});

test('agents: unique ids and sprite slots, enabled agents seated in their rooms, planned subagents reserved', () => {
  const ids = L.agents.map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(new Set(L.agents.map((a) => a.color)).size, L.agents.length, 'no aliased sprite slots');
  const ident = new Set(L.agents.map((a) => `${a.color % 6}/${Math.floor(a.color / 6)}`));
  assert.equal(ident.size, L.agents.length, 'unique (sheet, hue-cycle) identity per agent incl. subagents');
  for (const a of L.agents) {
    const t = L.targets.work[a.id];
    assert.ok(t && inRoom(a.room, t), `${a.id} seat inside ${a.room}`);
    assert.ok([0, 3].includes(cell(t)), `${a.id} seat walkable/seat`);
    if (a.parent) {
      const p = L.agents.find((x) => x.id === a.parent);
      assert.equal(p.room, a.room, `${a.id} shares its parent's room`);
      const specA = SPEC.agents.find((x) => x.id === a.id);
      assert.equal(a.enabled, specA.enabled === true, 'enabled only when the spec enables it (after OpenClaw provisioning)');
      if (a.enabled) assert.deepEqual(L.targets.idleOverrides[a.id], L.targets.work[a.id], 'enabled subagents idle at their own desk');
    }
  }
  const seats = Object.values(L.targets.work).map((t) => `${t.x},${t.y}`);
  assert.equal(new Set(seats).size, seats.length, 'no shared work seats');
  assert.deepEqual(L.targets.agentOrder, L.agents.filter((a) => a.enabled).map((a) => a.id));
  assert.equal(L.targets.agentOrder.length, SPEC.agents.filter((a) => a.enabled).length);
  assert.ok(L.targets.agentOrder.length >= 9, 'the 9 core agents are always enabled');
  assert.equal(L.targets.work.coordinator.room, 'Command Center');
  assert.deepEqual(L.targets.idleOverrides.coordinator, L.targets.work.coordinator, 'Diktator stays in the Oval Office');
  assert.equal(L.targets.work.operations.room, 'Operations Room');
  const perRoom = (r) => L.agents.filter((a) => a.room === r).map((a) => a.id);
  assert.deepEqual(perRoom('Sports Analytics Room'), ['sports_analyst', 'sports_bettor', 'odds_scout']);
  assert.deepEqual(perRoom('Trading Floor'), ['market_trader', 'equities_scout', 'macro_scout']);
  assert.deepEqual(perRoom('Crypto Lab'), ['crypto_analyst', 'crypto_trader', 'onchain_scout']);
  assert.ok(!ids.some((id) => /startag|aalto/i.test(id)), 'external workers are not agents');
});

test('idle seats are distinct Hangout seats, enough for every enabled agent', () => {
  const needIdle = SPEC.agents.filter((a) => a.enabled && a.idle !== 'work').length;
  assert.ok(L.targets.idle.length >= needIdle, `${L.targets.idle.length} idle seats for ${needIdle} agents`);
  assert.equal(new Set(L.targets.idle.map((t) => `${t.x},${t.y}`)).size, L.targets.idle.length);
  for (const t of L.targets.idle) { assert.ok(inRoom('Hangout Room', t)); assert.equal(cell(t), 3); }
});

test('UI anchors: lever on free Oval Office floor; generated plaque anchors match the Achievement Hall spec', () => {
  assert.ok(inRoom('Command Center', L.ui.lever));
  assert.equal(cell(L.ui.lever), 0);
  const plaqueSlots = SPEC.rooms.achievement_hall.template.join('').split('').filter((ch) => ch === SPEC.ui.plaques.char).length;
  assert.equal(L.ui.plaques.length, plaqueSlots, 'layout exposes one anchor per plaque slot in the local spec');
  for (const p of L.ui.plaques) assert.ok(inRoom('Achievement Hall', p));
});

test('generation is deterministic: a fresh build from the spec reproduces art and layout byte-for-byte', () => {
  const d = tmp('build-');
  fs.mkdirSync(path.join(d, 'tools')); fs.mkdirSync(path.join(d, 'assets'));
  for (const f of ['build-office-map.js', 'office-spec.json']) fs.copyFileSync(path.join(REPO, 'tools', f), path.join(d, 'tools', f));
  execFileSync(process.execPath, [path.join(d, 'tools/build-office-map.js')], { stdio: 'ignore' });
  assert.ok(fs.readFileSync(path.join(d, 'assets/office-openclaw.png')).equals(fs.readFileSync(path.join(REPO, 'assets/office-openclaw.png'))));
  assert.equal(fs.readFileSync(path.join(d, 'assets/office-layout.json'), 'utf8'), read('assets/office-layout.json'));
});

test('no hard-coded map size / agent list / room coordinates in the UI, server or sync', () => {
  const html = read('index.html'), dash = read('dashboard.html'), server = read('server.js'), sync = read('openclaw-pixel-sync.js');
  assert.match(html, /let COLS = 36;.*office-layout\.json/);
  assert.match(html, /COLS = layout\.cols;/); assert.match(html, /ROWS = layout\.rows;/);
  assert.match(html, /canvas\.height = ROWS \* GRID_SIZE;/);
  assert.match(dash, /COLS = layout\.cols; ROWS = layout\.rows;/);
  assert.doesNotMatch(html, /rectTiles\(\d+, \d+, \d+, \d+\)/, 'no fixed room rectangles in the UI');
  assert.doesNotMatch(server, /rectTiles\(\d+, \d+, \d+, \d+\)/, 'no fixed room rectangles in the server');
  assert.doesNotMatch(html, /\{ id: 'researcher', name: 'Researcher'/, 'no hard-coded agent list in the UI');
  assert.doesNotMatch(server, /\{ id: 'researcher', name: 'Researcher'/, 'no hard-coded agent list in the server');
  assert.doesNotMatch(sync, /openclaw: 'researcher'/, 'no hard-coded agent list in the sync bridge');
  assert.match(sync, /AGENT_MAP = agents/);
  assert.doesNotMatch(html, /slot % 8/);
  for (const [name, text, re] of [['index', html, /(?<![A-Za-z_])COLLISION_MAP = (?!default_COLLISION_MAP;)([^\n;]+);/g], ['dashboard', dash, /(?<![A-Za-z_])collisionMap = (?!\[\])([^\n;]+);/g]]) {
    for (const m of text.matchAll(re)) assert.match(m[1], /^padCollision\(/, `${name}: ${m[0]}`);
  }
});

test('padCollision makes any older/shorter grid safe', () => {
  const html = read('index.html');
  const fnSrc = html.slice(html.indexOf('function padCollision(map)'), html.indexOf('default_COLLISION_MAP = padCollision'));
  const padCollision = new Function('ROWS', 'COLS', `${fnSrc}; return padCollision;`)(L.rows, L.cols);
  const padded = padCollision(Array.from({ length: 3 }, () => Array(5).fill(0)));
  assert.equal(padded.length, L.rows);
  assert.ok(padded.every((r) => r.length === L.cols));
  assert.equal(padded[L.rows - 1][L.cols - 1], 1);
});

test('server: agents/rooms from the layout; planned subagents hidden; workers are not agents', async (t) => {
  const srv = await startServer({ BUSINESS_OS_KILLSWITCH_CLI: '/nonexistent/killswitch/system-kill.js' });
  t.after(() => srv.stop());
  const cfg = await (await fetch(srv.base + '/api/config')).json();
  assert.deepEqual(cfg.agents.map((a) => a.id), L.agents.filter((a) => a.enabled).map((a) => a.id));
  assert.equal(new Set(cfg.agents.map((a) => a.color)).size, cfg.agents.length);
  const bettorEnabled = SPEC.agents.find((a) => a.id === 'sports_bettor').enabled === true;
  assert.equal(cfg.agents.some((a) => a.id === 'sports_bettor'), bettorEnabled, 'subagent shown only when enabled in the spec');
  assert.ok(!cfg.agents.some((a) => /startag|aalto/i.test(a.id)));
  const rooms = await (await fetch(srv.base + '/api/rooms')).json();
  for (const n of LOGICAL) assert.ok(rooms.some((r) => r.name === n), n);
  assert.deepEqual(await (await fetch(srv.base + '/api/collision')).json(), L.collision);
});

test('server: an obsolete persisted map (different size) is replaced with a backup', async (t) => {
  const dataDir = tmp('pixel-old-');
  fs.writeFileSync(path.join(dataDir, 'map.json'), JSON.stringify({ collision: O.collision, rooms: O.rooms, updatedAt: 'x' }));
  const srv = await startServer({ BUSINESS_OS_KILLSWITCH_CLI: '/nonexistent/killswitch/system-kill.js', PIXEL_DATA_DIR_OVERRIDE: dataDir });
  t.after(() => srv.stop());
  assert.deepEqual(await (await fetch(srv.base + '/api/collision')).json(), L.collision);
  assert.ok(fs.existsSync(path.join(dataDir, 'map.pre-layout-resize-backup.json')));
});

test('server: a walled-off room or a map saved for another layout is stale; an edit saved for the current layout is kept', async (t) => {
  const walled = JSON.parse(JSON.stringify(L.collision));
  for (const tt of room('Operations Room').tiles) walled[tt.y][tt.x] = 1;
  const d1 = tmp('pixel-walled-');
  fs.writeFileSync(path.join(d1, 'map.json'), JSON.stringify({ collision: walled, rooms: L.rooms, updatedAt: 'x' }));
  const s1 = await startServer({ BUSINESS_OS_KILLSWITCH_CLI: '/nonexistent/killswitch/system-kill.js', PIXEL_DATA_DIR_OVERRIDE: d1 });
  t.after(() => s1.stop());
  assert.deepEqual(await (await fetch(s1.base + '/api/collision')).json(), L.collision);

  const edited = JSON.parse(JSON.stringify(L.collision));
  const free = room('Hangout Room').tiles.find((tt) => edited[tt.y][tt.x] === 0);
  edited[free.y][free.x] = 1;
  const d2 = tmp('pixel-edit-');
  const SIG = require('crypto').createHash('sha256').update(JSON.stringify(L.collision)).digest('hex').slice(0, 16);
  fs.writeFileSync(path.join(d2, 'map.json'), JSON.stringify({ collision: edited, rooms: L.rooms, layoutSignature: SIG, updatedAt: 'x' }));
  const s2 = await startServer({ BUSINESS_OS_KILLSWITCH_CLI: '/nonexistent/killswitch/system-kill.js', PIXEL_DATA_DIR_OVERRIDE: d2 });
  t.after(() => s2.stop());
  assert.equal((await (await fetch(s2.base + '/api/collision')).json())[free.y][free.x], 1, 'edit saved for the current layout is kept');

  // Same size, but saved for an older generated layout (unsigned or other signature): stale.
  for (const [name, extra] of [['unsigned', {}], ['old-sig', { layoutSignature: '0000000000000000' }]]) {
    const d3 = tmp(`pixel-${name}-`);
    fs.writeFileSync(path.join(d3, 'map.json'), JSON.stringify({ collision: edited, rooms: L.rooms, updatedAt: 'x', ...extra }));
    const s3 = await startServer({ BUSINESS_OS_KILLSWITCH_CLI: '/nonexistent/killswitch/system-kill.js', PIXEL_DATA_DIR_OVERRIDE: d3 });
    t.after(() => s3.stop());
    assert.deepEqual(await (await fetch(s3.base + '/api/collision')).json(), L.collision, `${name}: replaced by the generated layout`);
    assert.ok(fs.existsSync(path.join(d3, `map.pre-layout-${SIG}-backup.json`)), `${name}: backed up`);
    assert.equal(JSON.parse(fs.readFileSync(path.join(d3, 'map.json'), 'utf8')).layoutSignature, SIG, 'saved with the current signature');
  }
  assert.equal(fs.existsSync(path.join(d2, 'map.pre-layout-resize-backup.json')), false);
});
