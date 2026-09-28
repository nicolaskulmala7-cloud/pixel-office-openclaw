'use strict';
// End-to-end against a SEPARATE server.js instance (free port, temp data dir, fake
// kill-switch CLI). The live Pixel Office on :19000 is never contacted.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, fakeKillSwitch } = require('./helpers');

const H = (extra = {}) => ({ 'Content-Type': 'application/json', 'X-Pixel-Office-Action': 'nuclear-option', ...extra });
const post = (base, path, headers, body) => fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) });

test('server starts; kill-switch status and guarded stop work end-to-end with the fixed argv', async (t) => {
  const k = fakeKillSwitch({ state: 'RUNNING' });
  const srv = await startServer({ BUSINESS_OS_KILLSWITCH_CLI: k.cli, DASHBOARD_PASSWORD: 'pixel-secret-123' });
  t.after(() => srv.stop());
  assert.equal((await fetch(srv.base + '/api/health')).status, 200, srv.output());

  const status = await (await fetch(srv.base + '/api/killswitch/status')).json();
  assert.equal(status.state, 'RUNNING');
  const statusText = JSON.stringify(status);
  for (const leak of ['pixel-secret-123', '27875', '/home/', 'mainPid', 'op_id']) assert.ok(!statusText.includes(leak), leak);

  // Rejected requests execute nothing.
  const before = k.calls().filter((c) => c.argv[0] === 'stop').length;
  const rejections = [
    ['no action header', { 'Content-Type': 'application/json' }, { confirm: 'ACTIVATE' }],
    ['text/plain (CSRF form)', { 'Content-Type': 'text/plain', 'X-Pixel-Office-Action': 'nuclear-option' }, { confirm: 'ACTIVATE' }],
    ['foreign Origin', H({ Origin: 'https://evil.example' }), { confirm: 'ACTIVATE' }],
    ['cross-site fetch', H({ 'Sec-Fetch-Site': 'cross-site' }), { confirm: 'ACTIVATE' }],
    ['no confirmation', H(), {}],
    ['wrong confirmation', H(), { confirm: 'yes' }],
  ];
  for (const [name, headers, body] of rejections) {
    const r = await post(srv.base, '/api/killswitch/stop', headers, body);
    assert.equal(r.status, 403, name);
  }
  // DNS-rebinding style Host header (fetch() cannot override Host, so use node:http).
  const rebindingStatus = await new Promise((resolve, reject) => {
    const body = JSON.stringify({ confirm: 'ACTIVATE' });
    const req = require('http').request({ host: '127.0.0.1', port: srv.port, path: '/api/killswitch/stop', method: 'POST',
      headers: { ...H(), Host: 'attacker.example:19000', 'Content-Length': Buffer.byteLength(body) } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end(body);
  });
  assert.equal(rebindingStatus, 403, 'non-local Host');
  assert.equal(k.calls().filter((c) => c.argv[0] === 'stop').length, before, 'no stop executed by rejected requests');

  // Injection attempts in body/query never reach the command line.
  const ok = await post(srv.base, '/api/killswitch/stop?reason=%3Brm%20-rf%20%2F&by=root', H({ Origin: srv.base }), {
    confirm: 'ACTIVATE', reason: '"; rm -rf / #', by: 'coordinator', args: ['--allow-systemd-escalation'], cli: '/bin/sh',
  });
  assert.equal(ok.status, 202, await ok.clone().text());
  for (let i = 0; i < 50 && !k.calls().some((c) => c.argv[0] === 'stop'); i += 1) await new Promise((r) => setTimeout(r, 50));
  const stops = k.calls().filter((c) => c.argv[0] === 'stop');
  assert.equal(stops.length, 1);
  assert.deepEqual(stops[0].argv, ['stop', '--reason', 'Pixel Office Nuclear Option', '--by', 'pixel-office-owner', '--json']);
  assert.ok(!stops[0].env.includes('DASHBOARD_PASSWORD'), 'Pixel Office secrets are not passed to the kill switch');

  // Result summary is sanitised.
  let last = null;
  for (let i = 0; i < 50 && !last; i += 1) {
    last = (await (await fetch(srv.base + '/api/killswitch/status')).json()).lastPixelOfficeStop;
    if (!last) await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(last.state, 'STOPPED');
  assert.ok(!JSON.stringify(last).includes('secret detail'), 'step details are not returned');
});

test('kill switch not deployed: status UNAVAILABLE, stop 503, nothing executed', async (t) => {
  const srv = await startServer({ BUSINESS_OS_KILLSWITCH_CLI: '/nonexistent/killswitch/system-kill.js' });
  t.after(() => srv.stop());
  const s = await (await fetch(srv.base + '/api/killswitch/status')).json();
  assert.equal(s.state, 'UNAVAILABLE');
  const r = await post(srv.base, '/api/killswitch/stop', H(), { confirm: 'ACTIVATE' });
  assert.equal(r.status, 503);
});

test('Aalto Seat Watcher control regression: TURN ON/OFF persist across heartbeats; TEST POLL/ALERT', async (t) => {
  const srv = await startServer({ BUSINESS_OS_KILLSWITCH_CLI: '/nonexistent/killswitch/system-kill.js' });
  t.after(() => srv.stop());
  const W = '/api/workers/aalto_seat_watcher';
  const json = { 'Content-Type': 'application/json' };
  const heartbeat = () => post(srv.base, W + '/status', json, { name: 'Aalto Seat Watcher', status: 'WATCHING', message: 'watching 2 courses' });
  const get = async () => (await fetch(srv.base + W)).json();

  await heartbeat();
  assert.equal((await get()).status, 'WATCHING');

  await post(srv.base, W + '/control', json, { enabled: false });                  // TURN OFF
  let w = await get();
  assert.equal(w.status, 'OFF');
  assert.equal(w.control.enabled, false);

  await heartbeat();                                                                // worker keeps reporting
  w = await get();
  assert.equal(w.control.enabled, false, 'heartbeat preserved control');
  assert.equal(w.status, 'OFF');

  await post(srv.base, W + '/control', json, { enabled: true });                   // TURN ON
  await heartbeat();
  w = await get();
  assert.equal(w.control.enabled, true);
  assert.equal(w.status, 'WATCHING');

  for (const action of ['test_poll', 'test_alert']) {                               // TEST POLL / TEST ALERT
    const r = await (await post(srv.base, W + '/control', json, { action })).json();
    assert.equal(r.control.pendingAction.action, action);
    await heartbeat();
    const ctl = await (await fetch(srv.base + W + '/control')).json();
    assert.equal(ctl.pendingAction.action, action, 'pending action survives heartbeat');
    await post(srv.base, W + '/control/ack', json, { actionId: ctl.pendingAction.id });
    assert.equal((await (await fetch(srv.base + W + '/control')).json()).pendingAction, null);
  }
});

// Raw GET that does not normalise the path (fetch() would resolve "../").
function rawGet(port, rawPath) {
  return new Promise((resolve, reject) => {
    const req = require('http').request({ host: '127.0.0.1', port, path: rawPath, method: 'GET' }, (res) => {
      let body = ''; res.setEncoding('latin1'); res.on('data', (d) => { body += d; }); res.on('end', () => resolve({ status: res.statusCode, body, type: res.headers['content-type'] || '' }));
    });
    req.on('error', reject); req.end();
  });
}

test('static allowlist: UI files and map assets are served', async (t) => {
  const srv = await startServer({ BUSINESS_OS_KILLSWITCH_CLI: '/nonexistent/killswitch/system-kill.js' });
  t.after(() => srv.stop());
  const ok = [
    ['/', /<script src="nuclear-option.js"><\/script>/],
    ['/index.html', /gameCanvas/],
    ['/dashboard.html', /<html/i],
    ['/nuclear-option.js', /Do you want to obliterate Russia\?/],
    ['/assets/office-layout.json', /"collision"/],
  ];
  for (const [p, re] of ok) {
    const r = await rawGet(srv.port, p);
    assert.equal(r.status, 200, p);
    assert.match(r.body, re, p);
  }
  for (const p of ['/assets/office-openclaw.png', '/assets/oficina-placeholder.png', '/assets/characters/char_0.png', '/assets/characters/char_5.png']) {
    const r = await rawGet(srv.port, p);
    assert.equal(r.status, 200, p);
    assert.match(r.type, /image\/png/, p);
  }
  assert.equal((await rawGet(srv.port, '/assets/oficina.png')).status, 404, 'missing optional background -> 404, not index.html');
});

test('static allowlist: sensitive, runtime, backup and server-side paths cannot be fetched', async (t) => {
  const srv = await startServer({ BUSINESS_OS_KILLSWITCH_CLI: '/nonexistent/killswitch/system-kill.js' });
  t.after(() => srv.stop());
  const fs = require('fs');
  const path = require('path');
  const REPO = path.join(__dirname, '..');
  // Real probe files (created here, removed after) so the check proves content is not served.
  const probes = ['index.html.bak-test-probe', 'server.js.bak-test-probe', 'assets/office-layout.json.bak-test-probe', 'assets/office-openclaw.png.bak-test-probe'];
  for (const p of probes) fs.writeFileSync(path.join(REPO, p), p.endsWith('.png.bak-test-probe') ? 'PNGPROBE "workers": [core]' : '"dependencies" require(\'express\') [core] DASHBOARD_PASSWORD=probe');
  t.after(() => { for (const p of probes) fs.rmSync(path.join(REPO, p), { force: true }); });
  const baks = probes.filter((p) => !p.startsWith('assets/')).map((p) => '/' + p);
  const assetBaks = probes.filter((p) => p.startsWith('assets/')).map((p) => '/' + p);
  const blocked = [
    '/.env', '/.env.example', '/.git/config', '/.gitignore',
    '/server.js', '/killswitch-bridge.js', '/openclaw-pixel-sync.js', '/package.json', '/package-lock.json',
    '/data/workers.json', '/data/pixel-config.json', '/data/agents.json', '/data/tasks.json', '/data/map.json',
    '/test/helpers.js', '/test/server-http.test.js', '/tools/build-office-map.js', '/CREDITS.md', '/README.md', '/SKILL.md',
    '/start.sh', '/pep_email_checker.sh', '/node_modules/express/package.json',
    ...baks, ...assetBaks,
    '/assets/../server.js', '/assets/characters/../../.env', '/assets/%2e%2e/server.js', '/assets/..%2fserver.js',
    '/%2e%2e/%2e%2e/etc/passwd', '/assets/office-layout.json.bak-20260929-000252-nuclear', '/assets/x.png/../../.env',
    '/data', '/data/', '/test/', '/.git/',
  ];
  const secrets = [/DASHBOARD_PASSWORD\s*=/, /require\('express'\)/, /"workers"\s*:/, /createKillSwitchBridge/, /"dependencies"/, /\[core\]/, /root:x:0:0/, /node:test/];
  for (const p of blocked) {
    const r = await rawGet(srv.port, p);
    const leaked = secrets.find((re) => re.test(r.body));
    assert.ok(!leaked, `${p} leaked content matching ${leaked}`);
    assert.ok(r.status === 404 || r.status === 400 || (r.status === 200 && /<!DOCTYPE html>/i.test(r.body) && /gameCanvas/.test(r.body)), `${p}: unexpected ${r.status}`);
  }
  // File-like paths are refused outright (no index.html fallback).
  for (const p of ['/.env', '/.git/', '/.git/config', '/data', '/data/', '/test/', '/tools/', '/server.js', '/data/workers.json', '/package.json', '/assets/../server.js', '/assets/nope/x'].concat(baks.slice(0, 2))) {
    assert.equal((await rawGet(srv.port, p)).status, 404, p);
  }
  // Existing behaviour kept: extension-less routes still get the SPA page; API still works.
  assert.match((await rawGet(srv.port, '/some/app/route')).body, /gameCanvas/);
  assert.equal((await rawGet(srv.port, '/api/health')).status, 200);
});
