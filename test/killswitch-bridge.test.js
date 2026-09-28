'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createKillSwitchBridge, resolveCli, sanitiseStatus, childEnv, STATUS_ARGS, STOP_ARGS } = require('../killswitch-bridge');
const { fakeKillSwitch, tmp } = require('./helpers');

// Fake execFile: records calls, answers like the Business OS CLI would.
function fakeExec({ state = 'RUNNING', stop = { state: 'STOPPED', unresolved: [], results: [] }, stopCode = 0, statusText = null } = {}) {
  const calls = [];
  const execFile = (bin, args, opts, cb) => {
    calls.push({ bin, args, opts });
    setImmediate(() => {
      if (args[1] === 'status') return cb(null, statusText != null ? statusText : JSON.stringify({ state, execution_allowed: state === 'RUNNING', epoch: 1, external_workers: [{ id: 'startag_50k', status: 'EXTERNAL_PROPAGATION_PENDING' }] }));
      const err = stopCode ? Object.assign(new Error('exit'), { code: stopCode }) : null;
      return cb(err, JSON.stringify(stop));
    });
  };
  return { execFile, calls };
}

function bridgeWith(env, exec) {
  return createKillSwitchBridge({ env, execFile: exec.execFile, nodePath: '/usr/bin/node', statusCacheMs: 0 });
}

test('resolves the deployment CLI from env, never guessing; rejects wrong paths', () => {
  const k = fakeKillSwitch();
  assert.deepEqual(resolveCli({ BUSINESS_OS_KILLSWITCH_CLI: k.cli }), { ok: true, cli: fs.realpathSync(k.cli) });
  assert.equal(resolveCli({ BUSINESS_OS_ROOT: k.root }).ok, true, 'BUSINESS_OS_ROOT/killswitch/system-kill.js');
  assert.match(resolveCli({ BUSINESS_OS_KILLSWITCH_CLI: 'killswitch/system-kill.js' }).reason, /absolute/);
  const wrong = path.join(tmp('wrong-'), 'evil.js');
  fs.writeFileSync(wrong, '');
  assert.match(resolveCli({ BUSINESS_OS_KILLSWITCH_CLI: wrong }).reason, /not killswitch\/system-kill\.js/);
  assert.match(resolveCli({ BUSINESS_OS_ROOT: tmp('empty-') }).reason, /not installed/);
});

test('status uses the fixed argv, no shell, and a minimal env without Pixel Office secrets', async () => {
  const k = fakeKillSwitch();
  const exec = fakeExec();
  const s = await bridgeWith({ BUSINESS_OS_KILLSWITCH_CLI: k.cli, DASHBOARD_PASSWORD: 'hunter2', PATH: '/usr/bin', HOME: '/h' }, exec).status();
  assert.equal(s.state, 'RUNNING');
  const call = exec.calls[0];
  assert.deepEqual(call.args, [fs.realpathSync(k.cli), ...STATUS_ARGS]);
  assert.equal(call.opts.shell, false);
  assert.equal(call.opts.env.DASHBOARD_PASSWORD, undefined);
  assert.deepEqual(Object.keys(childEnv({ DASHBOARD_PASSWORD: 'x', OPENAI_API_KEY: 'y', PATH: '/b', HOME: '/h' })).sort(), ['HOME', 'PATH']);
});

test('sanitised status never exposes paths, PIDs, commands, process lists or raw config', () => {
  const raw = JSON.parse(require('child_process').execFileSync(process.execPath, [fakeKillSwitch({ state: 'DEGRADED' }).cli, 'status']).toString());
  const s = sanitiseStatus(raw);
  const text = JSON.stringify(s);
  for (const secret of ['27875', 'claude --secret-flag', '/home/mestari', 'mainPid', '11148', '.service', 'op_id', 'uncontrolled', '"by"']) {
    assert.ok(!text.includes(secret), `leaked ${secret}`);
  }
  assert.equal(s.state, 'DEGRADED');
  assert.deepEqual(s.unresolved.map((u) => u.id), ['openclaw-gateway']);
  assert.ok(s.externalWorkers.every((w) => w.status === 'EXTERNAL_PROPAGATION_PENDING' && w.controlledFromVps === false));
});

test('stop runs exactly the fixed allowlisted argv once; no escalation flag; no retry on failure', async () => {
  const k = fakeKillSwitch();
  const exec = fakeExec({ stop: { state: 'DEGRADED', unresolved: [{ id: 'business-os-bridge', reason: 'not armed' }], results: [] }, stopCode: 2 });
  const bridge = bridgeWith({ BUSINESS_OS_KILLSWITCH_CLI: k.cli }, exec);
  const r = await bridge.stop();
  assert.equal(r.httpStatus, 202);
  const last = await bridge._waitForStop();
  const stops = exec.calls.filter((c) => c.args[1] === 'stop');
  assert.equal(stops.length, 1, 'exactly one stop invocation, no automatic retry');
  assert.deepEqual(stops[0].args, [fs.realpathSync(k.cli), 'stop', '--reason', 'Pixel Office Nuclear Option', '--by', 'pixel-office-owner', '--json']);
  assert.deepEqual(STOP_ARGS, ['stop', '--reason', 'Pixel Office Nuclear Option', '--by', 'pixel-office-owner', '--json']);
  assert.ok(!stops[0].args.slice(1).some((a) => /escalation|force|kill|SIG|--dry-run/i.test(a)), 'no escalation/force flags after the script path');
  assert.equal(stops[0].opts.killSignal, 'SIGTERM');
  assert.equal(last.state, 'DEGRADED');
  assert.equal(last.exitCode, 2);
  const s = await bridge.status();
  assert.equal(s.lastPixelOfficeStop.state, 'DEGRADED');
});

test('STOPPED: no redundant stop is issued; STOPPING and in-flight stops are refused', async () => {
  const k = fakeKillSwitch();
  const stopped = fakeExec({ state: 'STOPPED' });
  const r = await bridgeWith({ BUSINESS_OS_KILLSWITCH_CLI: k.cli }, stopped).stop();
  assert.equal(r.body.noop, true);
  assert.equal(stopped.calls.filter((c) => c.args[1] === 'stop').length, 0);

  const stopping = fakeExec({ state: 'STOPPING' });
  assert.equal((await bridgeWith({ BUSINESS_OS_KILLSWITCH_CLI: k.cli }, stopping).stop()).httpStatus, 409);

  const running = fakeExec({ state: 'RUNNING' });
  const bridge = bridgeWith({ BUSINESS_OS_KILLSWITCH_CLI: k.cli }, running);
  assert.equal((await bridge.stop()).httpStatus, 202);
  assert.equal((await bridge.stop()).httpStatus, 409, 'second click while the first stop runs');
  await bridge._waitForStop();
  assert.equal(running.calls.filter((c) => c.args[1] === 'stop').length, 1);
});

test('errors: missing CLI -> 503 and nothing executed; unreadable output -> UNAVAILABLE/UNKNOWN', async () => {
  const exec = fakeExec();
  const missing = bridgeWith({ BUSINESS_OS_ROOT: tmp('nobos-') }, exec);
  assert.equal((await missing.status()).state, 'UNAVAILABLE');
  assert.equal((await missing.stop()).httpStatus, 503);
  assert.equal(exec.calls.length, 0);

  const k = fakeKillSwitch();
  const garbled = bridgeWith({ BUSINESS_OS_KILLSWITCH_CLI: k.cli }, fakeExec({ statusText: 'not json <html>' }));
  const s = await garbled.status();
  assert.equal(s.available, false);
  assert.match(s.reason, /unreadable/);
});
