// Pixel Office -> Business OS read-only status bridge.
// Runs ONE fixed command (node <BOS>/ops/bos-ui-status.js) via execFile (no shell),
// with a minimal environment, caches the result, and returns a sanitised subset.
'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const clip = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]+/g, ' ').slice(0, n);
const STATES = ['RUNNING', 'STOPPING', 'STOPPED', 'STARTING', 'DEGRADED', 'UNKNOWN'];
const USAGE_STATES = ['AVAILABLE', 'LOW', 'CRITICAL', 'LIMITED', 'WAITING_LIMIT', 'STALE', 'ERROR', 'UNKNOWN'];

function resolveCli(env = process.env) {
  const p = env.BUSINESS_OS_UI_STATUS_CLI || path.join(env.BUSINESS_OS_ROOT || path.join(os.homedir(), 'business-os'), 'ops', 'bos-ui-status.js');
  if (!path.isAbsolute(p)) return null;
  try {
    const real = fs.realpathSync(p);
    return path.basename(real) === 'bos-ui-status.js' && path.basename(path.dirname(real)) === 'ops' ? real : null;
  } catch { return null; }
}

function childEnv(env = process.env) {
  const out = { PATH: env.PATH || '/usr/bin:/bin', HOME: env.HOME || os.homedir() };
  for (const k of ['USER', 'LANG', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'BUSINESS_OS_STATE_HOME', 'BUSINESS_OS_EXEC_HOME', 'BUSINESS_OS_LEDGER_DIR']) if (env[k]) out[k] = env[k];
  return out;
}

const num = (v) => (Number.isFinite(v) ? v : null);
function sanitise(raw) {
  const g = raw.global || {};
  const lvl = raw.level || {};
  const usage = (u) => (u && USAGE_STATES.includes(u.status)
    ? { status: u.status, percent_used: Number.isFinite(u.percent_used) ? Math.max(0, Math.min(100, Math.round(u.percent_used))) : null, reset_at: clip(u.reset_at, 40) || null, reason: clip(u.reason, 140) || null, detected_at: clip(u.detected_at, 40) || null, source: clip(u.source, 40) || null,
      windows: (Array.isArray(u.windows) ? u.windows : []).slice(0, 4).map((w) => ({ name: clip(w && w.name, 20), used_pct: Number.isFinite(w && w.used_pct) ? Math.max(0, Math.min(100, Math.round(w.used_pct))) : null, resets_at: clip(w && w.resets_at, 40) || null })) }
    : { status: 'UNKNOWN', percent_used: null, reset_at: null, reason: 'no data', detected_at: null, source: null, windows: [] });
  const board = (b) => ({ board: b && (b.board === 'PAPER' || b.board === 'REAL') ? b.board : 'UNKNOWN', unit: clip(b && b.unit, 20), ranking: clip(b && b.ranking, 20), rows: (b && Array.isArray(b.rows) ? b.rows : []).slice(0, 20).map((r) => ({ agent: clip(r.agent, 40), n: num(r.n), pnl: num(r.pnl), roi: num(r.roi), win_rate: num(r.win_rate), max_drawdown: num(r.max_drawdown), opportunities_found: num(r.opportunities_found), approved_executions: num(r.approved_executions), sample: clip(r.sample, 40) })) });
  const pr = raw.paper_race || {};
  const raceRow = (r) => ({ agent: clip(r && r.agent, 40), start: num(r && r.start), balance: num(r && r.balance), verified_balance: num(r && r.verified_balance), pnl: num(r && r.pnl), settled: num(r && r.settled), progress: num(r && r.progress), state: clip(r && r.state, 40) });
  return {
    available: true,
    generated_at: clip(raw.generated_at, 40),
    global: { system: STATES.includes(g.system) ? g.system : 'UNKNOWN', execution_allowed: g.execution_allowed === true, kill_switch: ['ARMED', 'UNARMED'].includes(g.kill_switch) ? g.kill_switch : 'UNKNOWN', epoch: num(g.epoch), unresolved: (g.unresolved || []).slice(0, 10).map((x) => clip(x, 40)) },
    mode: { summary: clip(raw.mode && raw.mode.summary, 40) || 'UNKNOWN' },
    services: Object.fromEntries(Object.entries(raw.services || {}).slice(0, 10).map(([k, v]) => [clip(k, 40), clip(v, 20)])),
    level: { level: num(lvl.level), net_eur: num(lvl.net_eur), current_threshold_eur: num(lvl.current_threshold_eur), next_level: num(lvl.next_level), next_threshold_eur: num(lvl.next_threshold_eur), progress: num(lvl.progress), events_counted: num(lvl.events_counted) },
    achievements: (raw.achievements || []).slice(0, 50).map((a) => ({ id: clip(a.id, 40), title: clip(a.title, 60), category: clip(a.category, 20) || 'business', display_date: clip(a.display_date, 20) || null, unlocked: a.unlocked === true, unlocked_at: clip(a.unlocked_at, 40) || null })),
    leaderboards: { paper: board(raw.leaderboards && raw.leaderboards.paper), real: board(raw.leaderboards && raw.leaderboards.real) },
    paper_race: { id: clip(pr.id, 60), title: clip(pr.title, 80), status: clip(pr.status, 30) || 'UNKNOWN', mode: clip(pr.mode, 30), live_mode: clip(pr.live_mode, 30), currency: clip(pr.currency, 20), starting_balance: num(pr.starting_balance), target_balance: num(pr.target_balance), leader: pr.leader ? raceRow(pr.leader) : null, winner: pr.winner ? raceRow(pr.winner) : null, rows: (Array.isArray(pr.rows) ? pr.rows : []).slice(0, 20).map(raceRow) },
    agents: (raw.agents || []).slice(0, 64).map((a) => ({ id: clip(a.id, 40), display: clip(a.display, 60), room: clip(a.room, 60), parent: a.parent ? clip(a.parent, 40) : null, status: clip(a.status, 20), model: clip(a.model, 40), tier: clip(a.tier, 20) })),
    usage: { claude: usage(raw.usage && raw.usage.claude), codex: usage(raw.usage && raw.usage.codex), chatgpt: usage(raw.usage && raw.usage.chatgpt) },
  };
}

function createBusinessBridge({ env = process.env, execFile = childProcess.execFile, nodePath = process.execPath, now = Date.now, cacheMs = 15000 } = {}) {
  let cache = null;
  let inflight = null;
  async function status() {
    if (cache && now() - cache.at < cacheMs) return cache.value;
    if (inflight) return inflight;
    inflight = new Promise((resolve) => {
      const cli = resolveCli(env);
      if (!cli) return resolve({ available: false, reason: 'Business OS status CLI not installed (branch not merged/deployed yet)' });
      execFile(nodePath, [cli], { timeout: 30000, maxBuffer: 1024 * 1024, env: childEnv(env), shell: false, windowsHide: true }, (err, stdout) => {
        if (err) return resolve({ available: false, reason: 'Business OS status unavailable' });
        try { resolve(sanitise(JSON.parse(String(stdout)))); } catch { resolve({ available: false, reason: 'Business OS status unreadable' }); }
      });
    }).then((value) => { cache = { at: now(), value }; inflight = null; return value; });
    return inflight;
  }
  return { status };
}

module.exports = { createBusinessBridge, sanitise, resolveCli, childEnv };
