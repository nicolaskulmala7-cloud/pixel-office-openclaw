// Pixel Office -> Business OS GLOBAL kill switch bridge.
//
// Pixel Office does NOT implement any kill logic. It only invokes the existing
// Business OS CLI (killswitch/system-kill.js) with FIXED, allowlisted argument
// vectors via execFile (no shell), and returns a sanitised summary to the browser.
//
//   status: node <cli> status --json
//   stop  : node <cli> stop --reason "Pixel Office Nuclear Option" --by pixel-office-owner --json
//
// Never: --allow-systemd-escalation, force-kill, signals, PID/process-name targeting,
// automatic retries, or passing any browser-supplied value to the command line.
'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const STATES = ['RUNNING', 'STOPPING', 'STOPPED', 'STARTING', 'DEGRADED', 'UNKNOWN'];
const STOP_REASON = 'Pixel Office Nuclear Option';
const STOP_BY = 'pixel-office-owner';
const STATUS_ARGS = ['status', '--json'];
const STOP_ARGS = ['stop', '--reason', STOP_REASON, '--by', STOP_BY, '--json'];
const ACTION_HEADER = 'x-pixel-office-action';
const ACTION_VALUE = 'nuclear-option';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

const clip = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]+/g, ' ').slice(0, n);

// Deployment path: explicit env first, then the Business OS checkout root; never the
// Claude worktree unless configured. The file must be named exactly system-kill.js
// inside a killswitch/ directory.
function resolveCli(env = process.env) {
  const candidate = env.BUSINESS_OS_KILLSWITCH_CLI
    || path.join(env.BUSINESS_OS_ROOT || path.join(os.homedir(), 'business-os'), 'killswitch', 'system-kill.js');
  if (!path.isAbsolute(candidate)) return { ok: false, reason: 'kill switch path must be absolute' };
  let real;
  try {
    real = fs.realpathSync(candidate);
  } catch {
    return { ok: false, reason: 'kill switch not installed (Business OS branch not merged/deployed yet)' };
  }
  if (path.basename(real) !== 'system-kill.js' || path.basename(path.dirname(real)) !== 'killswitch') {
    return { ok: false, reason: 'configured kill switch path is not killswitch/system-kill.js' };
  }
  if (!fs.statSync(real).isFile()) return { ok: false, reason: 'kill switch path is not a file' };
  return { ok: true, cli: real };
}

// Minimal child environment: Pixel Office's own .env (dashboard password etc.) is
// never passed to the kill switch.
function childEnv(env = process.env) {
  const out = { PATH: env.PATH || '/usr/bin:/bin', HOME: env.HOME || os.homedir() };
  for (const k of ['USER', 'LANG', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'BUSINESS_OS_STATE_HOME']) {
    if (env[k]) out[k] = env[k];
  }
  return out;
}

// Browser-safe summary: states, component ids and short reasons only. No paths,
// commands, PIDs, process lists, config or raw output.
function sanitiseStatus(raw) {
  const state = STATES.includes(raw && raw.state) ? raw.state : 'UNKNOWN';
  const list = (v) => (Array.isArray(v) ? v : []);
  return {
    available: true,
    state,
    executionAllowed: raw && raw.execution_allowed === true && state === 'RUNNING',
    epoch: Number.isFinite(raw && raw.epoch) ? raw.epoch : null,
    since: clip(raw && raw.since, 40) || null,
    armed: raw && raw.armed === true,
    unresolved: list(raw && raw.unresolved).slice(0, 10).map((u) => ({ id: clip(u && u.id, 40), reason: clip(u && u.reason, 140) })),
    components: list(raw && raw.components).slice(0, 12).map((c) => ({ id: clip(c && c.id, 40), active: clip(c && c.active, 20), installed: c && c.load !== 'not-found' })),
    externalWorkers: list(raw && raw.external_workers).slice(0, 10).map((w) => ({ id: clip(w && w.id, 40), status: clip(w && w.status, 40), controlledFromVps: false })),
    lastOp: raw && raw.last_op ? { action: clip(raw.last_op.action, 12), finishedAt: clip(raw.last_op.finished_at, 40) || null } : null,
  };
}

function sanitiseStopResult(raw, exitCode) {
  const list = (v) => (Array.isArray(v) ? v : []);
  return {
    state: STATES.includes(raw && raw.state) ? raw.state : 'UNKNOWN',
    exitCode,
    unresolved: list(raw && raw.unresolved).slice(0, 10).map((u) => ({ id: clip(u && u.id, 40), reason: clip(u && u.reason, 140) })),
    steps: list(raw && raw.results).slice(0, 20).map((r) => ({ id: clip(r && r.id, 40), status: clip(r && r.status, 40) })),
  };
}

// Cross-site / accidental-request protection for the destructive endpoint.
function checkDangerousRequest(req) {
  const ct = String(req.get('content-type') || '');
  if (!ct.toLowerCase().startsWith('application/json')) return 'JSON request required';
  if (req.get(ACTION_HEADER) !== ACTION_VALUE) return 'missing action header';
  const host = String(req.get('host') || '').replace(/:\d+$/, '').toLowerCase();
  if (!LOCAL_HOSTS.has(host)) return 'non-local host';
  const origin = req.get('origin');
  if (origin) {
    let o;
    try { o = new URL(origin); } catch { return 'bad origin'; }
    if (o.host.toLowerCase() !== String(req.get('host') || '').toLowerCase()) return 'cross-origin request';
  }
  const site = req.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') return 'cross-site request';
  const body = req.body || {};
  if (body.confirm !== 'ACTIVATE') return 'explicit confirmation required';
  return null;
}

function createKillSwitchBridge({ env = process.env, execFile = childProcess.execFile, nodePath = process.execPath, now = Date.now, statusCacheMs = 4000, stopTimeoutMs = 20 * 60 * 1000 } = {}) {
  let cache = null;
  let stopInFlight = null;
  let lastStop = null;

  const run = (cli, args, timeout) => new Promise((resolve) => {
    execFile(nodePath, [cli, ...args], { timeout, killSignal: 'SIGTERM', maxBuffer: 1024 * 1024, env: childEnv(env), shell: false, windowsHide: true },
      (error, stdout) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout || ''), timedOut: !!(error && error.killed) }));
  });

  async function status({ fresh = false } = {}) {
    if (!fresh && cache && now() - cache.at < statusCacheMs) return cache.value;
    const cli = resolveCli(env);
    let value;
    if (!cli.ok) {
      value = { available: false, state: 'UNAVAILABLE', reason: cli.reason };
    } else {
      const r = await run(cli.cli, STATUS_ARGS, 20000);
      try {
        value = sanitiseStatus(JSON.parse(r.stdout));
      } catch {
        value = { available: false, state: 'UNAVAILABLE', reason: r.timedOut ? 'kill switch status timed out' : 'kill switch status unreadable' };
      }
    }
    value.stopInProgress = !!stopInFlight;
    value.lastPixelOfficeStop = lastStop;
    cache = { at: now(), value };
    return value;
  }

  // Starts ONE stop. Returns immediately; the browser follows progress via status.
  async function stop() {
    if (stopInFlight) return { httpStatus: 409, body: { accepted: false, reason: 'a Nuclear Option stop is already in progress' } };
    const current = await status({ fresh: true });
    if (!current.available) return { httpStatus: 503, body: { accepted: false, reason: current.reason } };
    if (current.state === 'STOPPED') {
      return { httpStatus: 200, body: { accepted: false, noop: true, state: 'STOPPED', reason: 'AI execution is already stopped' } };
    }
    if (current.state === 'STOPPING') {
      return { httpStatus: 409, body: { accepted: false, state: 'STOPPING', reason: 'a global stop is already in progress' } };
    }
    const cli = resolveCli(env);
    if (!cli.ok) return { httpStatus: 503, body: { accepted: false, reason: cli.reason } };

    const startedAt = new Date(now()).toISOString();
    stopInFlight = run(cli.cli, STOP_ARGS, stopTimeoutMs).then((r) => {
      let parsed = null;
      try { parsed = JSON.parse(r.stdout); } catch { /* summarised below */ }
      lastStop = parsed
        ? { startedAt, finishedAt: new Date(now()).toISOString(), ...sanitiseStopResult(parsed, r.code) }
        : { startedAt, finishedAt: new Date(now()).toISOString(), state: 'UNKNOWN', exitCode: r.code, error: r.timedOut ? 'stop command timed out' : 'stop result unreadable' };
      stopInFlight = null;
      cache = null;
      return lastStop;
    });
    cache = null;
    return { httpStatus: 202, body: { accepted: true, startedAt, previousState: current.state } };
  }

  function register(app) {
    app.get('/api/killswitch/status', async (req, res) => {
      try {
        res.json(await status());
      } catch {
        res.status(500).json({ available: false, state: 'UNAVAILABLE', reason: 'status error' });
      }
    });
    app.post('/api/killswitch/stop', async (req, res) => {
      const rejected = checkDangerousRequest(req);
      if (rejected) return res.status(403).json({ accepted: false, reason: rejected });
      try {
        const r = await stop();
        res.status(r.httpStatus).json(r.body);
      } catch {
        res.status(500).json({ accepted: false, reason: 'stop error' });
      }
    });
  }

  return { status, stop, register, _waitForStop: () => stopInFlight };
}

module.exports = { createKillSwitchBridge, resolveCli, sanitiseStatus, sanitiseStopResult, checkDangerousRequest, childEnv, STATUS_ARGS, STOP_ARGS, STOP_REASON };
