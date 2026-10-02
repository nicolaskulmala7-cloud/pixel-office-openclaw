'use strict';
// Command-center overview: honest usage, observed-only workers, bounded activity, safe DOM.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer, tmp, REPO } = require('./helpers');
const CC = require('../command-center');
const { createActivity } = require('../activity');
const { sanitise } = require('../business-bridge');

const json = { 'Content-Type': 'application/json' };
const post = (base, p, body) => fetch(base + p, { method: 'POST', headers: json, body: JSON.stringify(body) });
const NOKS = { BUSINESS_OS_KILLSWITCH_CLI: '/nonexistent/killswitch/system-kill.js' };

function fakeUiStatus(raw) {
  const dir = path.join(tmp('fake-bos-ui-'), 'ops');
  fs.mkdirSync(dir);
  const cli = path.join(dir, 'bos-ui-status.js');
  fs.writeFileSync(cli, `console.log(${JSON.stringify(JSON.stringify(raw))});\n`);
  return cli;
}
const BOS = (over = {}) => ({
  generated_at: '2026-09-29T00:00:00Z',
  global: { system: 'RUNNING', execution_allowed: true, kill_switch: 'UNARMED', epoch: 4, unresolved: [] },
  mode: { summary: 'PAPER / LIVE_DISABLED' },
  services: { 'business-os-bridge': 'ACTIVE', 'ai-router': 'NOT_INSTALLED' },
  level: { level: 0, net_eur: 0, next_level: 1, next_threshold_eur: 1, progress: 0, events_counted: 0 },
  achievements: [{ id: 'first_euro', title: 'First Euro', unlocked: false }],
  leaderboards: { paper: { board: 'PAPER', rows: [] }, real: { board: 'REAL', rows: [] } },
  paper_race: { id: 'race', status: 'ACTIVE', mode: 'PAPER_DEMO_ONLY', live_mode: 'LIVE_DISABLED', currency: 'DEMO_EUR', starting_balance: 100, target_balance: 300, pause_at: null, paused: false, leader: { agent: 'market_trader', risk_multiplier: 4.5, balance: 100, verified_balance: 100, risk_balance: 100, available_balance: 90, max_new_stake: 81, open_intents: 1, open_stake: 10, settled: 0, progress: 0, state: 'RACING' }, rows: [{ agent: 'market_trader', risk_multiplier: 4.5, start: 100, balance: 100, verified_balance: 100, risk_balance: 100, available_balance: 90, max_new_stake: 81, pnl: 0, settled: 0, open_intents: 1, open_stake: 10, progress: 0, state: 'RACING' }] },
  agents: [{ id: 'coordinator', display: 'Diktator', model: 'Opus 5.5', tier: 'strong' }],
  usage: { claude: { status: 'UNKNOWN', reason: 'usage.status providers: []' } },
  secret_path: '/home/x/.env', token: 'sk-should-not-pass',
  ...over,
});

test('bridge sanitiser: drops unknown fields, clamps usage, never invents a percentage', () => {
  const s = sanitise(BOS({ usage: { claude: { status: 'AVAILABLE', percent_used: 250 }, codex: { status: 'MADE_UP', percent_used: 40 } } }));
  assert.equal(s.usage.claude.percent_used, 100);
  assert.deepEqual([s.usage.codex.status, s.usage.codex.percent_used], ['UNKNOWN', null]);
  assert.equal('chatgpt' in s.usage, false, 'nonexistent ChatGPT usage meter is omitted');
  assert.doesNotMatch(JSON.stringify(s), /sk-should-not-pass|\.env/);
  assert.equal(sanitise({ global: { system: 'PWNED' } }).global.system, 'UNKNOWN');
  assert.deepEqual([s.paper_race.starting_balance, s.paper_race.target_balance, s.paper_race.live_mode], [100, 300, 'LIVE_DISABLED']);
  assert.equal(s.paper_race.rows[0].risk_multiplier, 4.5);
  assert.deepEqual([s.paper_race.rows[0].available_balance, s.paper_race.rows[0].max_new_stake], [90, 81]);
  assert.equal(s.paper_race.pause_at, null);
});

test('overview without Business OS: everything UNKNOWN, nothing fabricated', async (t) => {
  const srv = await startServer({ ...NOKS, BUSINESS_OS_UI_STATUS_CLI: '/nonexistent/ops/bos-ui-status.js' });
  t.after(() => srv.stop());
  const o = await (await fetch(srv.base + '/api/overview')).json();
  assert.equal(o.bos.available, false);
  for (const k of ['claude', 'codex']) {
    assert.equal(o.usage[k].status, 'UNKNOWN', k);
    assert.equal(o.usage[k].percent_used, null, k);
  }
  assert.equal('chatgpt' in o.usage, false);
  const hud = CC.hudModel({ overview: o });
  assert.deepEqual(hud.global, { system: 'UNKNOWN', mode: 'UNKNOWN', kill: 'UNKNOWN' });
  assert.equal(CC.levelModel(null).text, 'LVL ?');
});

test('overview with Business OS; workers observed only; propagation honest; STARTAG details sanitised', async (t) => {
  const srv = await startServer({ ...NOKS, BUSINESS_OS_UI_STATUS_CLI: fakeUiStatus(BOS({ global: { system: 'STOPPED', execution_allowed: false, kill_switch: 'UNARMED', epoch: 4, unresolved: [] } })) });
  t.after(() => srv.stop());
  await post(srv.base, '/api/workers/startag_50k/status', {
    name: 'STARTAG', status: 'RUNNING',
    details: { codex: { state: 'WAITING_LIMIT', nextRetryAt: 1790000000000, apiKey: 'sk-x' }, proofreader: { state: 'PROMPT_READY' }, lastBatch: { id: 'b-7', count: 1e12 }, token: 'nope' },
    globalStop: { epoch: 4, state: 'STOPPED', at: 1 },
  });
  await post(srv.base, '/api/workers/aalto_seat_watcher/status', { name: 'Aalto', status: 'WATCHING', globalStop: { epoch: 'x', state: 'STOPPED' } });
  const o = await (await fetch(srv.base + '/api/overview')).json();
  assert.equal(o.bos.global.system, 'STOPPED');
  assert.equal(o.bos.mode.summary, 'PAPER / LIVE_DISABLED');
  assert.doesNotMatch(JSON.stringify(o), /sk-x|sk-should-not-pass|nope|\.env/);
  const st = o.workers.find((w) => w.id === 'startag_50k');
  const aa = o.workers.find((w) => w.id === 'aalto_seat_watcher');
  assert.equal(st.propagation, 'ACKED', 'worker acknowledged this epoch');
  assert.equal(aa.propagation, 'EXTERNAL_PROPAGATION_PENDING', 'invalid ack is never treated as stopped');
  assert.ok(o.workers.every((w) => w.controlledFromVps === false));
  assert.equal(st.details.lastBatch.count, 1000000, 'bounded');
  assert.ok(Object.keys(st.details.codex).every((k) => ['lastAttemptAt', 'nextRetryAt', 'state', 'usage'].includes(k)), 'only allowlisted Codex fields');
  assert.equal(o.usage.codex.status, 'WAITING_LIMIT');
  assert.equal(o.usage.codex.percent_used, null, 'Codex exposes no percentage; none invented');
  assert.equal('chatgpt' in o.usage, false);
  assert.equal(st.details.proofreader.state, 'PROMPT_READY');
  const lines = CC.workerModel(st).lines.join('\n');
  assert.match(lines, /Codex: WAITING_LIMIT · next retry/);
  assert.match(lines, /Proofreader: PROMPT_READY/);
  assert.match(CC.workerModel(aa).lines.join('\n'), /propagation pending \(not stopped by VPS\)/);
  const act = (await (await fetch(srv.base + '/api/activity?n=500')).json()).items.map((i) => i.text).join('\n');
  assert.match(act, /STARTAG: NEW -> RUNNING/);
  assert.match(act, /acknowledged global stop \(epoch 4\)/);
});

test('fresh Codex app-server quota from STARTAG renders live 5h/7d usage', async (t) => {
  const now = Date.now();
  const staleBos = {
    status: 'STALE', percent_used: 62, detected_at: '2026-09-30T18:26:28Z',
    windows: [{ name: '5h', used_pct: 62 }, { name: '7d', used_pct: 25 }]
  };
  const srv = await startServer({ ...NOKS, BUSINESS_OS_UI_STATUS_CLI: fakeUiStatus(BOS({ usage: { claude: { status: 'UNKNOWN' }, codex: staleBos } })) });
  t.after(() => srv.stop());
  await post(srv.base, '/api/workers/startag_50k/status', {
    name: 'STARTAG', status: 'RUNNING',
    details: {
      codex: {
        state: 'RUNNING',
        usage: {
          sampledAt: now,
          source: 'codex_app_server_rate_limits',
          allowed: true,
          windows: [
            { name: '5h', usedPct: 27, resetsAt: now + 3600000 },
            { name: '7d', usedPct: 41, resetsAt: now + 86400000 }
          ],
          token: 'must-not-pass'
        }
      }
    }
  });
  const o = await (await fetch(srv.base + '/api/overview')).json();
  assert.equal(o.usage.codex.status, 'AVAILABLE');
  assert.equal(o.usage.codex.run_state, 'RUNNING');
  assert.equal(o.usage.codex.percent_used, 41);
  assert.deepEqual(o.usage.codex.windows.map((w) => [w.name, w.used_pct]), [['5h', 27], ['7d', 41]]);
  assert.equal(o.usage.codex.source, 'codex_app_server_rate_limits');
  assert.doesNotMatch(JSON.stringify(o), /must-not-pass|2026-09-30T18:26:28Z/);
});

test('stale worker quota degrades to RUNNING usage UNKNOWN instead of replaying percentages', async (t) => {
  const old = Date.now() - 60 * 60 * 1000;
  const srv = await startServer({ ...NOKS, BUSINESS_OS_UI_STATUS_CLI: fakeUiStatus(BOS({ usage: { claude: { status: 'UNKNOWN' }, codex: { status: 'UNKNOWN' } } })) });
  t.after(() => srv.stop());
  await post(srv.base, '/api/workers/startag_50k/status', {
    name: 'STARTAG', status: 'RUNNING',
    details: { codex: { state: 'RUNNING', usage: { sampledAt: old, source: 'codex_app_server_rate_limits', windows: [{ name: '5h', usedPct: 88, resetsAt: old + 3600000 }] } } }
  });
  const o = await (await fetch(srv.base + '/api/overview')).json();
  assert.equal(o.usage.codex.status, 'AVAILABLE');
  assert.equal(o.usage.codex.run_state, 'RUNNING');
  assert.equal(o.usage.codex.percent_used, null);
  assert.doesNotMatch(JSON.stringify(o.usage.codex), /88/);
  assert.match(o.usage.codex.reason, /stale/i);
});

test('stale Codex quota snapshot never overrides a live STARTAG RUNNING heartbeat', async (t) => {
  const staleCodex = {
    status: 'STALE', percent_used: 93, detected_at: '2026-10-01T00:00:00Z',
    windows: [{ name: '5h', used_pct: 43 }, { name: '7d', used_pct: 93 }]
  };
  const srv = await startServer({ ...NOKS, BUSINESS_OS_UI_STATUS_CLI: fakeUiStatus(BOS({ usage: { claude: { status: 'UNKNOWN' }, codex: staleCodex } })) });
  t.after(() => srv.stop());
  await post(srv.base, '/api/workers/startag_50k/status', {
    name: 'STARTAG', status: 'RUNNING',
    progress: { current: null, target: 50000, unit: 'leads' },
    details: { codex: { state: 'RUNNING' } }
  });
  const o = await (await fetch(srv.base + '/api/overview')).json();
  assert.equal(o.usage.codex.status, 'AVAILABLE');
  assert.equal(o.usage.codex.run_state, 'RUNNING');
  assert.equal(o.usage.codex.percent_used, null);
  assert.equal(Array.isArray(o.usage.codex.windows) ? o.usage.codex.windows.length : 0, 0);
  assert.doesNotMatch(JSON.stringify(o.usage.codex), /43|93|2026-10-01T00:00:00Z/);
  assert.equal('chatgpt' in o.usage, false);
});

test('view models: FAILED highlighted, usage bar only from real numbers, plaques only when unlocked', () => {
  const hud = CC.hudModel({ tasks: [{ status: 'failed' }, { status: 'queued' }, { status: 'waiting_approval' }], chars: [] });
  assert.deepEqual([hud.work.failed, hud.work.failedAlert, hud.work.queued, hud.work.approvals], [1, true, 1, 1]);
  assert.equal(CC.hudModel({ tasks: [] }).work.failedAlert, false);
  assert.equal(CC.usageModel('Claude', { status: 'AVAILABLE', percent_used: 42 }).kind, 'bar');
  assert.equal(CC.usageModel('Claude', { status: 'AVAILABLE', percent_used: null }).kind, 'state');
  assert.equal(CC.usageModel('Codex', undefined).text, 'UNKNOWN');
  const runningCodex = CC.usageModel('Codex', { status: 'AVAILABLE', run_state: 'RUNNING', detected_at: Date.now() });
  assert.deepEqual([runningCodex.text, runningCodex.sub.includes('usage UNKNOWN')], ['RUNNING', true]);
  const windows = CC.usageModel('Codex', { status: 'LOW', detected_at: Date.now(), windows: [{ name: '5h', used_pct: 43 }, { name: '7d', used_pct: 93 }] });
  assert.equal(windows.kind, 'windows');
  assert.match(windows.text, /5H .*43%\n7D .*93%/);
  const pl = CC.plaquesModel([{ x: 1, y: 1 }, { x: 2, y: 1 }], [{ id: 'a', title: 'A', unlocked: true }, { id: 'b', title: 'B', unlocked: 'yes' }]);
  assert.deepEqual(pl.map((p) => p.unlocked), [true, false], 'only a literal true unlocks');
  assert.equal(CC.levelModel({ level: 3, net_eur: 40, next_threshold_eur: 100, progress: 0.2 }).text, 'LVL 3');
  const race = CC.raceModel(BOS().paper_race);
  assert.match(race.leader, /market_trader 100\.00/);
  assert.match(race.detail, /RISK 4\.50× · CAP 81\.00 · AVAIL 90\.00 · OPEN 1 · SETTLED 0/);
  assert.match(race.tooltip, /market_trader · 100\.00 DEMO_EUR · RISK 4\.50× · CAP 81\.00 · AVAIL 90\.00/);
  assert.equal(race.fraction, 0);
  const pausedRace = CC.raceModel({ ...BOS().paper_race, status: 'PAUSED_CUTOFF', paused: true });
  assert.equal(pausedRace.title, 'RACE PAUSED');
  assert.match(pausedRace.detail, /PAUSED @ CUTOFF/);
});

test('activity feed is bounded, collapses repeats, and persists', () => {
  let t = 0;
  const file = path.join(tmp('act-'), 'activity.json');
  const a = createActivity({ file, limit: 5, now: () => t });
  a.add('agent', 'same'); t += 1000; a.add('agent', 'same');
  assert.equal(a.list().length, 1, 'repeat within 60s collapsed');
  for (let i = 0; i < 20; i++) { t += 61000; a.add('bogus-kind', 'event ' + i); }
  assert.equal(a.list(100).length, 5);
  assert.equal(a.list(1)[0].kind, 'system');
  assert.equal(createActivity({ file, limit: 5 }).list(100).length, 5, 'reloaded from disk');
  assert.equal(a.add('worker', 'x'.repeat(999)).text.length, 200);
  assert.equal(a.add('worker', 'job FAILED').level, 'warn');
});

test('command-center DOM uses textContent only; UI has no fabricated usage defaults', () => {
  const src = fs.readFileSync(path.join(REPO, 'command-center.js'), 'utf8');
  assert.doesNotMatch(src, /innerHTML|insertAdjacentHTML|document\.write|eval\(/);
  assert.doesNotMatch(src, /percent_used\s*[:=]\s*\d/, 'no hard-coded usage numbers');
  assert.doesNotMatch(src, /\['chatgpt',\s*'CHATGPT'\]/, 'nonexistent ChatGPT meter is not rendered');
  const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
  assert.match(html, /<script src="command-center\.js"><\/script>/);
});

test('command-center.js is served; the data dir and tools are not', async (t) => {
  const srv = await startServer(NOKS);
  t.after(() => srv.stop());
  const r = await fetch(srv.base + '/command-center.js');
  assert.equal(r.status, 200);
  assert.match(await r.text(), /hudModel/);
  for (const p of ['/activity.js', '/business-bridge.js', '/tools/office-spec.json', '/data/activity.json']) {
    const x = await fetch(srv.base + p);
    const body = await x.text();
    assert.ok(!/createActivity|createBusinessBridge|"schema_version"/.test(body), `${p} not leaked`);
  }
});

test('SYSTEM CREATED plaque: first plaque, shows the display date only when unlocked, marked historical', () => {
  const ach = [{ id: 'system_created', title: 'SYSTEM CREATED', category: 'historical', display_date: '28.09.2026', unlocked: true, unlocked_at: '2026-09-28T00:00:00+02:00' }, { id: 'first_sale', title: 'FIRST SALE', category: 'business', display_date: null, unlocked: false }];
  const [p0, p1] = CC.plaquesModel([{ x: 1, y: 1 }, { x: 2, y: 1 }], ach);
  assert.deepEqual([p0.id, p0.unlocked, p0.display_date, p0.category], ['system_created', true, '28.09.2026', 'historical']);
  assert.deepEqual([p1.unlocked, p1.display_date], [false, null]);
  const s = sanitise({ achievements: ach });
  assert.deepEqual([s.achievements[0].display_date, s.achievements[0].category], ['28.09.2026', 'historical']);
});


test('STARTAG RUNNING with unknown count never renders as zero or stale 500 progress', () => {
  const w = {
    id: 'startag_50k',
    name: 'STARTAG 50K',
    status: 'RUNNING',
    stale: false,
    phase: 'Codex running (read-only process observation)',
    progress: { current: null, target: 50000, unit: 'leads' },
    details: { codex: { state: 'RUNNING' }, checkpoint: { id: 'STEP5I_CHECKPOINT500.json', at: 1 } },
    lastSeenAt: Date.now(),
  };
  const card = CC.externalRoomModel('startag_50k', w, Date.now());
  assert.equal(card.board, 'NO PROGRESS REPORTED');
  assert.doesNotMatch(JSON.stringify(card), /500\s*\/\s*50,?000|0\s*\/\s*50,?000/);
  const wm = CC.workerModel(w, Date.now());
  assert.doesNotMatch(wm.lines.join('\n'), /500\s*\/\s*50,?000|0\s*\/\s*50,?000/);
  assert.match(wm.lines.join('\n'), /Codex: RUNNING/);
});
