'use strict';
// Canonical read-only API contract used by the Windows workers and Business OS (verified 2026-09-29).
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

test('read-only routes answer JSON; /api/workers/<id>/status is POST-only (a GET gets the HTML shell, never worker data)', async (t) => {
  const srv = await startServer({ BUSINESS_OS_KILLSWITCH_CLI: '/nonexistent/killswitch/system-kill.js' });
  t.after(() => srv.stop());
  const post = await fetch(srv.base + '/api/workers/aalto_seat_watcher/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Aalto Seat Watcher', status: 'WATCHING' }) });
  assert.equal(post.status, 200);
  assert.match(post.headers.get('content-type'), /^application\/json/);

  for (const p of ['/api/killswitch/status', '/api/workers', '/api/workers/aalto_seat_watcher', '/api/workers/aalto_seat_watcher/control', '/api/overview', '/api/health']) {
    const r = await fetch(srv.base + p);
    assert.equal(r.status, 200, p);
    assert.match(r.headers.get('content-type'), /^application\/json/, p);
  }
  const all = await (await fetch(srv.base + '/api/workers')).json();
  assert.ok(Array.isArray(all.workers), 'workers is an array');
  assert.equal(all.workers.find((w) => w.id === 'aalto_seat_watcher').status, 'WATCHING');
  const one = await (await fetch(srv.base + '/api/workers/aalto_seat_watcher')).json();
  assert.equal(one.status, 'WATCHING');

  const trap = await fetch(srv.base + '/api/workers/aalto_seat_watcher/status');
  assert.match(trap.headers.get('content-type'), /^text\/html/, 'GET on the POST-only route is the HTML shell');
  assert.doesNotMatch(await trap.text(), /"status"\s*:\s*"WATCHING"/);
});
