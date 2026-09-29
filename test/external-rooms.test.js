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
  assert.equal(room('Aalto Watch Room').external, 'aalto_seat_watcher');
  assert.equal(room('STARTAG Lead Factory').external, 'startag_50k');
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
  const ext = L.rooms.filter((r) => r.external);
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
