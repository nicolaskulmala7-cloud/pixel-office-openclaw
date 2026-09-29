'use strict';
// External Windows worker rooms (Aalto Watch Room, STARTAG Lead Factory): layout + live status.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer, tmp, REPO } = require('./helpers');
const CC = require('../command-center');

const L = JSON.parse(fs.readFileSync(path.join(REPO, 'assets/office-layout.json'), 'utf8'));
const room = (name) => L.rooms.find((r) => r.name === name);
const walkable = (r) => r.tiles.filter((t) => L.collision[t.y][t.x] !== 1).length;
const inRoom = (r, x, y) => r.tiles.some((t) => t.x === x && t.y === y);
const NOKS = { BUSINESS_OS_KILLSWITCH_CLI: '/nonexistent/killswitch/system-kill.js' };

test('both external-worker rooms exist, tagged with their worker id, in a 36x21 map', () => {
  assert.deepEqual([L.cols, L.rows], [36, 21]);
  assert.deepEqual([room('Aalto Watch Room').kind, room('Aalto Watch Room').workerId], ['external-worker', 'aalto_seat_watcher']);
  assert.deepEqual([room('STARTAG Lead Factory').kind, room('STARTAG Lead Factory').workerId], ['external-worker', 'startag_50k']);
  assert.deepEqual(L.ui.external.map((e) => e.worker).sort(), ['aalto_seat_watcher', 'startag_50k']);
});

test('Aalto booth is tiny (~2x3 walkable); the factory is substantial and larger than any single-agent office', () => {
  const a = room('Aalto Watch Room'), f = room('STARTAG Lead Factory');
  assert.ok(walkable(a) <= 6 && a.tiles.length <= 8, `Aalto ${a.tiles.length} tiles, ${walkable(a)} walkable`);
  assert.ok(f.tiles.length >= 4 * a.tiles.length, 'factory at least 4x the booth');
  assert.ok(walkable(f) >= 24, `factory walkable ${walkable(f)}`);
  for (const n of ['Research Lab', 'Writing Studio', 'Review Room', 'Operations Room', 'Trading Floor', 'Crypto Lab', 'Memecoin War Room', 'Sports Analytics Room']) {
    assert.ok(f.tiles.length > room(n).tiles.length, `factory larger than ${n}`);
  }
  assert.equal(Math.min(...L.rooms.map((r) => r.tiles.length)), a.tiles.length, 'Aalto booth is the smallest room');
});

test('stations are anchored inside their rooms (board, checkpoint, Codex, Proofreader, conveyor; monitor, lamp)', () => {
  for (const e of L.ui.external) {
    const r = room(e.room);
    for (const [name, s] of Object.entries(e.stations)) assert.ok(inRoom(r, s.x, s.y), `${e.worker}.${name}`);
  }
  const s = L.ui.external.find((e) => e.worker === 'startag_50k').stations;
  for (const k of ['board', 'checkpoint', 'codex', 'proofreader', 'conveyor']) assert.ok(s[k], k);
  const a = L.ui.external.find((e) => e.worker === 'aalto_seat_watcher').stations;
  for (const k of ['monitor', 'lamp']) assert.ok(a[k], k);
});

test('external workers are not agents; all 16 agents keep valid seats outside the external rooms', () => {
  const ids = L.agents.map((a) => a.id);
  assert.equal(ids.length, 16);
  assert.ok(!ids.some((id) => /aalto|startag|codex|proofread/i.test(id)));
  const ext = L.rooms.filter((r) => r.kind === 'external-worker');
  for (const a of L.agents) {
    const t = L.targets.work[a.id];
    assert.ok(t && [0, 3].includes(L.collision[t.y][t.x]), a.id);
    assert.ok(!ext.some((r) => inRoom(r, t.x, t.y)), `${a.id} not seated in an external room`);
  }
  for (const t of L.targets.idle) assert.ok(!ext.some((r) => inRoom(r, t.x, t.y)));
});

test('view model: stale STARTAG renders STALE/OFFLINE with no Codex/Proofreader state and no progress bar', () => {
  const m = CC.externalRoomModel('startag_50k', { id: 'startag_50k', status: 'OFFLINE', stale: true, lastSeenAt: 1, progress: { current: 500, target: 50000 }, details: { codex: { state: 'RUNNING' }, proofreader: { state: 'PROOFREADING' } } });
  assert.deepEqual([m.status, m.tone, m.board, m.codex, m.proofreader, m.fraction, m.alert], ['OFFLINE', 'stale', 'STALE / OFFLINE', '—', '—', null, null]);
  assert.match(Object.fromEntries(m.rows).Progress, /last reported 500 \/ 50,000 \(stale\)/);
  assert.equal(CC.externalRoomModel('startag_50k', null).status, 'NO DATA');
});

test('view model: fresh STARTAG states come only from the report (RUNNING, WAITING_LIMIT, WAITING_APPROVAL, ERROR)', () => {
  const base = { id: 'startag_50k', stale: false, lastSeenAt: Date.now(), progress: { current: 12500, target: 50000 } };
  const r = CC.externalRoomModel('startag_50k', { ...base, status: 'RUNNING', details: { codex: { state: 'RUNNING' }, checkpoint: { id: 'CP-6' }, lastBatch: { id: 'b-9', count: 100 } } });
  assert.deepEqual([r.board, r.fraction, r.codex, r.proofreader, r.checkpoint, r.lastBatch], ['12,500 / 50,000', 0.25, 'RUNNING', 'not reported', 'CP-6', 'b-9 (100)']);
  const w = CC.externalRoomModel('startag_50k', { ...base, status: 'WAITING_LIMIT', details: { codex: { state: 'WAITING_LIMIT', nextRetryAt: Date.now() + 3600e3 }, proofreader: { state: 'PROOFREADING' } } });
  assert.match(w.alert, /^WAITING_LIMIT · retry \d\d:\d\d$/);
  assert.equal(w.proofreader, 'PROOFREADING');
  assert.match(CC.externalRoomModel('startag_50k', { ...base, status: 'WAITING_APPROVAL', message: 'New paid dataset needs human approval: X' }).alert, /WAITING_APPROVAL · New paid dataset/);
  assert.match(CC.externalRoomModel('startag_50k', { ...base, status: 'ERROR', details: { errorSummary: 'disk full' } }).alert, /ERROR · disk full/);
});

test('view model: Aalto WATCHING, OFF, stale', () => {
  const now = Date.now();
  const m = CC.externalRoomModel('aalto_seat_watcher', { id: 'aalto_seat_watcher', status: 'WATCHING', stale: false, enabled: true, lastSeenAt: now, lastCheckAt: now - 30e3, nextCheckAt: now + 60e3 }, now);
  const rows = Object.fromEntries(m.rows);
  assert.deepEqual([m.label, m.tone, rows['Enabled (TURN ON/OFF)']], ['WATCHING', 'ok', 'ON']);
  assert.match(rows['Next poll'], /^\d\d:\d\d$/);
  assert.equal(CC.externalRoomModel('aalto_seat_watcher', { status: 'OFF', stale: false, enabled: false, lastSeenAt: now }).tone, 'off');
  const s = CC.externalRoomModel('aalto_seat_watcher', { status: 'OFFLINE', stale: true, lastSeenAt: 1 });
  assert.deepEqual([s.label, Object.fromEntries(s.rows)['Next poll']], ['STALE', '—']);
});

test('live server: /api/workers + /api/overview drive the rooms; old STARTAG data is OFFLINE, Aalto WATCHING', async (t) => {
  const d = tmp('pixel-ext-');
  fs.writeFileSync(path.join(d, 'workers.json'), JSON.stringify({ updatedAt: 1, workers: { startag_50k: { id: 'startag_50k', name: 'STARTAG 50K', status: 'RUNNING', lastSeenAt: 1000, progress: { current: 500, target: 50000 }, details: { codex: { state: 'RUNNING' } } } } }));
  const srv = await startServer({ ...NOKS, PIXEL_DATA_DIR_OVERRIDE: d });
  t.after(() => srv.stop());
  const now = Date.now();
  await fetch(srv.base + '/api/workers/aalto_seat_watcher/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Aalto Seat Watcher', status: 'WATCHING', lastCheckAt: now, nextCheckAt: now + 60000 }) });
  const ov = await (await fetch(srv.base + '/api/overview')).json();
  const st = ov.workers.find((w) => w.id === 'startag_50k');
  const aa = ov.workers.find((w) => w.id === 'aalto_seat_watcher');
  assert.deepEqual([st.status, st.stale], ['OFFLINE', true], 'stale report is never RUNNING');
  assert.equal(CC.externalRoomModel('startag_50k', st).board, 'STALE / OFFLINE');
  assert.deepEqual([aa.status, aa.nextCheckAt, aa.lastCheckAt], ['WATCHING', now + 60000, now]);
  assert.equal(CC.externalRoomModel('aalto_seat_watcher', aa).label, 'WATCHING');
  const cfg = await (await fetch(srv.base + '/api/config')).json();
  assert.ok(!cfg.agents.some((a) => /aalto|startag/i.test(a.id)), 'not OpenClaw/Pixel agents');
});

test('UI never GETs /api/workers/<id>/status and builds the external rooms without innerHTML', () => {
  for (const f of ['index.html', 'dashboard.html', 'command-center.js', 'nuclear-option.js']) {
    const src = fs.readFileSync(path.join(REPO, f), 'utf8');
    for (const m of src.matchAll(/fetch\(([^)]*)\)/g)) assert.doesNotMatch(m[1], /\/status['"`]/, `${f}: ${m[0].slice(0, 80)}`);
  }
  const cc = fs.readFileSync(path.join(REPO, 'command-center.js'), 'utf8');
  assert.doesNotMatch(cc, /innerHTML|insertAdjacentHTML/);
  assert.match(cc, /not an OpenClaw agent · not controlled from the VPS/);
});

// ---- Real UI pathfinding (the Pathfinder class from index.html, unmodified) ----
function realPathfinder(collision) {
  const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
  const start = html.indexOf('class Pathfinder {');
  const end = html.indexOf('return []; // Sin ruta', start);
  assert.ok(start > 0 && end > start, 'Pathfinder class found in index.html');
  const src = html.slice(start, html.indexOf('}', html.indexOf('}', end) + 1) + 1);
  return new Function('COLLISION_MAP', 'COLS', 'ROWS', 'DOORS_OPEN', `${src}; return Pathfinder;`)(collision, collision[0].length, collision.length, {});
}

test('real UI Pathfinder: every agent seat, spawn, idle seat and every room (incl. both external rooms) is reachable from the lift', () => {
  const PF = realPathfinder(L.collision);
  const lift = { x: L.ui.shaft.x, y: Math.floor(L.rows / 2) };
  assert.equal(L.collision[lift.y][lift.x], 0);
  const reach = (t, what) => {
    if (t.x === lift.x && t.y === lift.y) return;
    const p = PF.findPath(lift.x, lift.y, t.x, t.y);
    assert.ok(p.length > 0, `${what} (${t.x},${t.y}) reachable`);
    const last = p[p.length - 1];
    assert.deepEqual([last.x, last.y], [t.x, t.y]);
    for (const s of p.slice(0, -1)) assert.notEqual(L.collision[s.y][s.x], 1, `${what}: path never crosses a wall`);
  };
  for (const a of L.agents) reach(L.targets.work[a.id], `seat of ${a.id}`);
  for (const [id, s] of Object.entries(L.spawns)) reach(s, `spawn of ${id}`);
  L.targets.idle.forEach((t, i) => reach(t, `idle seat ${i}`));
  for (const r of L.rooms) {
    const floor = r.tiles.find((t) => L.collision[t.y][t.x] === 0);
    assert.ok(floor, `${r.name} has walkable floor`);
    reach(floor, r.name);
  }
  assert.equal(Object.keys(L.spawns).length, 16, 'a spawn per agent');
  for (const s of Object.values(L.spawns)) assert.notEqual(L.collision[s.y][s.x], 1, 'no spawn in a wall');
});

test('usable-area hierarchy: STARTAG >= 4x Aalto; Aalto the smallest room; STARTAG among the largest work areas', () => {
  const usable = (r) => r.tiles.filter((t) => L.collision[t.y][t.x] !== 1).length;
  const a = usable(room('Aalto Watch Room')), f = usable(room('STARTAG Lead Factory'));
  assert.ok(f >= 4 * a, `STARTAG ${f} vs Aalto ${a}`);
  assert.ok(f >= 3 * a);
  assert.equal(Math.min(...L.rooms.map(usable)), a, 'Aalto is the smallest usable area');
  const bigger = L.rooms.filter((r) => usable(r) > f).map((r) => r.name);
  assert.ok(bigger.length <= 3, `rooms larger than the factory: ${bigger.join(', ')}`);
});

test('stale STARTAG history is labelled, never shown as current; missing fields render as UNKNOWN/—, never 0%', () => {
  const st = CC.externalRoomModel('startag_50k', { id: 'startag_50k', status: 'OFFLINE', stale: true, lastSeenAt: 1, phase: 'Domain discovery', message: 'Waiting for Proofreader', progress: { current: 500, target: 50000 }, details: { checkpoint: { id: 'STEP5I_CHECKPOINT500' }, lastBatch: { id: 'b5' }, codex: { state: 'WAITING_LIMIT' }, proofreader: { state: 'WAITING_HUMAN' } } });
  const rows = Object.fromEntries(st.rows);
  for (const k of ['Phase', 'Message', 'Checkpoint', 'Last batch']) assert.match(rows[k], /^last reported: .* \(stale\)$/, k);
  assert.deepEqual([rows.Codex, rows.Proofreader, st.alert, st.fraction], ['—', '—', null, null]);
  assert.doesNotMatch(JSON.stringify(st), /WAITING_LIMIT/, 'no stale Codex limit shown');
  const bare = CC.externalRoomModel('startag_50k', { id: 'startag_50k', status: 'RUNNING', stale: false, lastSeenAt: Date.now() });
  assert.equal(bare.board, 'NO PROGRESS REPORTED');
  assert.equal(bare.fraction, null);
  assert.doesNotMatch(JSON.stringify(bare), /0%/);
  const ba = CC.externalRoomModel('aalto_seat_watcher', { id: 'aalto_seat_watcher', status: 'IDLE', stale: false, lastSeenAt: Date.now(), phase: 'Paused by Business OS global gate (gate STOPPED)', globalStop: { epoch: 2, state: 'STOPPED' } });
  const br = Object.fromEntries(ba.rows);
  assert.deepEqual([ba.label, ba.tone, br['Last check'], br['Next poll'], br['Last stop ack']], ['IDLE', 'idle', 'UNKNOWN', 'UNKNOWN', 'epoch 2']);
  assert.match(br.Phase, /Paused by Business OS global gate/);
});

test('saved rooms from before the kind field still get kind/workerId from the generated layout', async (t) => {
  const d = tmp('pixel-kind-');
  const SIG = require('crypto').createHash('sha256').update(JSON.stringify(L.collision)).digest('hex').slice(0, 16);
  const legacyRooms = L.rooms.map(({ kind, workerId, ...r }) => (r.name === 'Aalto Watch Room' ? { ...r, external: 'aalto_seat_watcher' } : r));
  fs.writeFileSync(path.join(d, 'map.json'), JSON.stringify({ collision: L.collision, rooms: legacyRooms, layoutSignature: SIG, updatedAt: 'x' }));
  const srv = await startServer({ ...NOKS, PIXEL_DATA_DIR_OVERRIDE: d });
  t.after(() => srv.stop());
  const rooms = await (await fetch(srv.base + '/api/rooms')).json();
  const a = rooms.find((r) => r.name === 'Aalto Watch Room');
  assert.deepEqual([a.kind, a.workerId], ['external-worker', 'aalto_seat_watcher']);
  assert.equal(rooms.find((r) => r.name === 'STARTAG Lead Factory').workerId, 'startag_50k');
  assert.equal(rooms.find((r) => r.name === 'Research Lab').kind, 'agent');
  assert.equal(rooms.filter((r) => r.kind === 'external-worker').length, 2);
});
