// Test helpers: isolated temp dirs, a fake Business OS kill-switch CLI, a free port,
// and a second Pixel Office instance that can never collide with the live one.
'use strict';
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const REPO = path.join(__dirname, '..');

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// A stand-in for ~/business-os/killswitch/system-kill.js. It records argv and prints
// canned JSON; it never touches systemd or OpenClaw.
function fakeKillSwitch({ state = 'RUNNING', stopState = 'STOPPED', stopExit = 0, raw = null } = {}) {
  const root = tmp('fake-bos-');
  const dir = path.join(root, 'killswitch');
  fs.mkdirSync(dir);
  const log = path.join(root, 'calls.jsonl');
  const cli = path.join(dir, 'system-kill.js');
  const status = raw || {
    state, execution_allowed: state === 'RUNNING', epoch: 3, since: '2026-09-29T00:00:00Z', armed: false,
    unresolved: state === 'DEGRADED' ? [{ id: 'openclaw-gateway', reason: 'graceful stop did not complete within 360s' }] : [],
    components: [{ id: 'openclaw-gateway', unit: 'openclaw-gateway.service', active: 'active', load: 'loaded', mainPid: 11148 }],
    external_workers: [{ id: 'startag_50k', status: state === 'RUNNING' ? 'NOT_CONTROLLED' : 'EXTERNAL_PROPAGATION_PENDING' }, { id: 'aalto_seat_watcher', status: state === 'RUNNING' ? 'NOT_CONTROLLED' : 'EXTERNAL_PROPAGATION_PENDING' }],
    uncontrolled_ai_processes: [{ pid: 27875, cmd: 'claude --secret-flag', action: 'REPORTED_ONLY' }],
    runtime: { root: '/home/mestari/.local/state/ai-router' },
    last_op: { action: 'stop', by: 'human', reason: 'x', finished_at: '2026-09-29T00:01:00Z', op_id: 'stop-1' },
  };
  fs.writeFileSync(cli, `#!/usr/bin/env node
const fs = require('fs');
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), env: Object.keys(process.env).sort() }) + '\\n');
const cmd = process.argv[2];
if (cmd === 'status') { console.log(${JSON.stringify(JSON.stringify(status))}); process.exit(0); }
if (cmd === 'stop') { console.log(JSON.stringify({ op_id: 'stop-x', state: ${JSON.stringify(stopState)}, unresolved: ${JSON.stringify(stopState === 'DEGRADED' ? [{ id: 'business-os-bridge', reason: 'not armed' }] : [])}, results: [{ id: 'openclaw-gateway', status: 'STOPPED', detail: 'secret detail /home/x' }] })); process.exit(${stopExit}); }
process.exit(64);
`);
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { root, cli, calls };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

// Starts server.js as a separate process on a free port with a temp data dir.
async function startServer(env = {}) {
  const port = await freePort();
  const dataDir = env.PIXEL_DATA_DIR_OVERRIDE || tmp('pixel-data-');
  const child = spawn(process.execPath, [path.join(REPO, 'server.js')], {
    cwd: REPO,
    env: { ...process.env, ...env, PORT: String(port), HOST: '127.0.0.1', PIXEL_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i += 1) {
    try { if ((await fetch(base + '/api/health')).ok) break; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return { base, port, dataDir, child, output: () => out, stop: () => new Promise((r) => { child.once('exit', r); child.kill('SIGTERM'); }) };
}

module.exports = { REPO, tmp, fakeKillSwitch, freePort, startServer };
