// Pixel Office command-center UI: grouped HUD, level/XP bar, usage bars, achievement
// plaques, activity feed, and agent-drawer metadata.
//
// - ONE shared poll of /api/overview (cached server-side); no model calls, no per-widget loops.
// - Never fakes state: a percentage bar is shown only when a real number exists;
//   otherwise the real status (UNKNOWN / WAITING_LIMIT / AVAILABLE) is shown with its reason.
// - DOM is built with createElement/textContent only (no HTML strings from the backend).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CommandCenter = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const OVERVIEW_URL = '/api/overview';
  const POLL_MS = 10000;
  const workerControlUrl = (id) => '/api/workers/' + encodeURIComponent(id) + '/control';
  const eur = (n) => (Number.isFinite(n) ? '€' + Math.round(n).toLocaleString('en-US') : '€?');
  const hhmm = (t) => {
    const d = typeof t === 'number' ? new Date(t) : new Date(Date.parse(t));
    return Number.isNaN(d.getTime()) ? '' : String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  };
  const ago = (t, now = Date.now()) => {
    if (!t) return '—';
    const s = Math.max(0, Math.round((now - (typeof t === 'number' ? t : Date.parse(t))) / 1000));
    return s < 60 ? s + 's' : s < 3600 ? Math.floor(s / 60) + 'm' : Math.floor(s / 3600) + 'h';
  };
  const bar = (fraction, width = 16) => {
    const n = Math.max(0, Math.min(width, Math.round(fraction * width)));
    return '█'.repeat(n) + '░'.repeat(width - n);
  };

  // ------------------------------------------------------------ view models

  function hudModel({ tasks = [], chars = [], health = null, overview = null, effectiveStatus = (c) => c.status || 'IDLE' }) {
    const failed = tasks.filter((t) => ['failed', 'timed_out'].includes(t.status)).length;
    const bos = overview && overview.bos;
    const svc = (k) => (bos && bos.available && bos.services ? bos.services[k] === 'ACTIVE' : undefined);
    return {
      work: {
        active: chars.filter((c) => !['IDLE', 'OFFLINE'].includes(effectiveStatus(c))).length,
        queued: tasks.filter((t) => t.status === 'queued').length,
        running: tasks.filter((t) => t.status === 'running').length,
        approvals: tasks.filter((t) => t.status === 'waiting_approval').length,
        failed,
        failedAlert: failed > 0,
      },
      infra: {
        gateway: health ? !!(health.gateway && health.gateway.ok) : undefined,
        pixel: health ? true : false,
        sync: health ? !!(health.bridge && health.bridge.ok) : undefined,
        bridge: svc('business-os-bridge'),
        scheduler: health ? !!(health.scheduler && health.scheduler.ok) : undefined,
      },
      global: bos && bos.available
        ? { system: bos.global.system, mode: bos.mode.summary, kill: bos.global.kill_switch }
        : { system: 'UNKNOWN', mode: 'UNKNOWN', kill: 'UNKNOWN' },
    };
  }

  function levelModel(level) {
    if (!level || !Number.isFinite(level.level)) return { text: 'LVL ?', detail: 'ledger unavailable', bar: bar(0), fraction: 0 };
    const next = Number.isFinite(level.next_threshold_eur) ? level.next_threshold_eur : null;
    return {
      text: 'LVL ' + level.level,
      detail: next === null ? eur(level.net_eur) + ' (max level)' : eur(level.net_eur) + ' / ' + eur(next),
      bar: bar(level.progress || 0),
      fraction: level.progress || 0,
      basis: 'verified realized net profit',
    };
  }

  function raceModel(race) {
    if (!race || !Array.isArray(race.rows) || !race.rows.length) return { title: 'DEMO RACE', leader: 'UNKNOWN', detail: 'paper race unavailable', fraction: 0, tooltip: '' };
    const leader = race.leader || race.rows[0];
    const target = Number.isFinite(race.target_balance) ? race.target_balance : 300;
    const balance = Number.isFinite(leader.balance) ? leader.balance : null;
    const risk = Number.isFinite(leader.risk_multiplier) ? leader.risk_multiplier.toFixed(2) + '×' : '?';
    const paused = race.status === 'PAUSED_CUTOFF' || race.paused === true;
    const rows = race.rows.map((r, i) => {
      const rr = Number.isFinite(r.risk_multiplier) ? r.risk_multiplier.toFixed(2) + '×' : '?';
      const rb = Number.isFinite(r.balance) ? r.balance.toFixed(2) : '?';
      const cap = Number.isFinite(r.max_new_stake) ? r.max_new_stake.toFixed(2) : '?';
      const avail = Number.isFinite(r.available_balance) ? r.available_balance.toFixed(2) : '?';
      return (i + 1) + '. ' + (r.agent || 'UNKNOWN') + ' · ' + rb + ' DEMO_EUR · RISK ' + rr + ' · CAP ' + cap + ' · AVAIL ' + avail;
    });
    return {
      title: race.status === 'FINISHED' ? 'WINNER' : (paused ? 'RACE PAUSED' : 'DEMO RACE'),
      leader: (leader.agent || 'UNKNOWN') + (balance === null ? '' : ' ' + balance.toFixed(2)),
      detail: 'DEMO_EUR / ' + target + ' · RISK ' + risk + ' · CAP ' + (Number.isFinite(leader.max_new_stake) ? leader.max_new_stake.toFixed(2) : '?') + ' · AVAIL ' + (Number.isFinite(leader.available_balance) ? leader.available_balance.toFixed(2) : '?') + ' · OPEN ' + (Number.isFinite(leader.open_intents) ? leader.open_intents : 0) + ' · SETTLED ' + (Number.isFinite(leader.settled) ? leader.settled : 0) + ' · ' + (paused ? 'PAUSED @ CUTOFF' : (leader.state || race.status || 'UNKNOWN')),
      fraction: Number.isFinite(leader.progress) ? Math.max(0, Math.min(1, leader.progress)) : 0,
      tooltip: rows.join('\n') + (race.pause_at ? '\nCutoff: ' + race.pause_at : ''),
    };
  }

  function usageModel(label, u) {
    const s = u || { status: 'UNKNOWN' };
    const running = String(label).toLowerCase() === 'codex' && s.run_state === 'RUNNING';
    const windows = (Array.isArray(s.windows) ? s.windows : []).filter((w) => Number.isFinite(w && w.used_pct));
    if (windows.length) {
      return {
        label, kind: 'windows', percent: Math.max(...windows.map((w) => w.used_pct)),
        text: windows.map((w) => String(w.name || '?').toUpperCase() + ' ' + bar(w.used_pct / 100, 10) + ' ' + w.used_pct + '%').join('\n'),
        sub: (running ? 'RUNNING · ' : '') + (s.status === 'STALE' ? 'STALE · ' : '') + (s.detected_at ? 'seen ' + ago(s.detected_at) + ' ago' : ''),
        reason: s.reason || '', status: s.status,
      };
    }
    if (Number.isFinite(s.percent_used)) {
      return { label, kind: 'bar', percent: s.percent_used, bar: bar(s.percent_used / 100), text: s.percent_used + '%', sub: (running ? 'RUNNING · ' : '') + (s.reset_at ? 'reset ' + hhmm(s.reset_at) : ''), status: s.status };
    }
    if (s.status === 'WAITING_LIMIT') {
      return { label, kind: 'state', text: 'WAITING_LIMIT', sub: s.next_retry_at ? 'next retry ' + hhmm(s.next_retry_at) : '', status: s.status };
    }
    if (s.status === 'AVAILABLE') return running
      ? { label, kind: 'state', text: 'RUNNING', sub: 'usage UNKNOWN' + (s.detected_at ? ' · seen ' + ago(s.detected_at) + ' ago' : ''), status: s.status }
      : { label, kind: 'state', text: 'AVAILABLE', sub: s.detected_at ? 'seen ' + ago(s.detected_at) + ' ago' : '', status: s.status };
    return { label, kind: 'state', text: 'UNKNOWN', sub: s.last_known ? 'last ' + s.last_known + (s.detected_at ? ' ' + ago(s.detected_at) + ' ago' : '') : '', reason: s.reason || '', status: 'UNKNOWN' };
  }

  // Plaque i shows achievement i: unlocked only when the backend says it is unlocked.
  function plaquesModel(plaques = [], achievements = []) {
    return plaques.map((p, i) => {
      const a = achievements[i];
      return { x: p.x, y: p.y, id: a ? a.id : null, title: a ? a.title : 'Empty plaque', category: a && a.category ? a.category : null, unlocked: !!(a && a.unlocked === true), unlocked_at: a ? a.unlocked_at : null, display_date: a && a.unlocked === true && a.display_date ? a.display_date : null };
    });
  }

  function agentMeta(id, overview, now = Date.now()) {
    const bos = overview && overview.bos;
    const a = bos && bos.available ? (bos.agents || []).find((x) => x.id === id) : null;
    const meta = { model: a ? a.model : 'unknown', room: a ? a.room : null, escalation: 'none recorded', serviceHealth: null };
    if (id === 'operations' && bos && bos.available) {
      const vals = Object.entries(bos.services || {}).filter(([k, v]) => v !== 'NOT_INSTALLED');
      meta.serviceHealth = vals.filter(([, v]) => v === 'ACTIVE').length + '/' + vals.length;
    }
    void now;
    return meta;
  }

  function workerModel(w, now = Date.now()) {
    const lines = [];
    const d = w.details || {};
    if (w.id === 'aalto_seat_watcher') {
      if (Number.isFinite(d.courses)) lines.push(d.courses + ' course' + (d.courses === 1 ? '' : 's'));
      lines.push('Last poll ' + (d.lastPollAt ? ago(d.lastPollAt, now) : ago(w.lastSeenAt, now)));
    }
    if (w.id === 'startag_50k') {
      if (w.progress && Number.isFinite(w.progress.current)) lines.push(Number(w.progress.current).toLocaleString('en-US') + ' / ' + Number(w.progress.target || 50000).toLocaleString('en-US'));
      if (w.phase) lines.push('Phase: ' + w.phase);
      if (d.codex) lines.push('Codex: ' + d.codex.state + (d.codex.nextRetryAt ? ' · next retry ' + hhmm(d.codex.nextRetryAt) : ''));
      if (d.proofreader) lines.push('Proofreader: ' + d.proofreader.state);
      if (d.checkpoint && d.checkpoint.id) lines.push('Checkpoint: ' + d.checkpoint.id);
      if (d.lastBatch && d.lastBatch.id) lines.push('Last batch: ' + d.lastBatch.id + (Number.isFinite(d.lastBatch.count) ? ' (' + d.lastBatch.count + ')' : ''));
      if (d.errorSummary) lines.push('Error: ' + d.errorSummary);
    }
    if (w.stale) lines.push('Heartbeat stale (' + ago(w.lastSeenAt, now) + ')');
    if (w.propagation && w.propagation !== 'NOT_APPLICABLE') lines.push('Global stop: ' + (w.propagation === 'ACKED' ? 'acknowledged by worker' : 'propagation pending (not stopped by VPS)'));
    return { id: w.id, name: w.name, status: w.status, lines, controlledFromVps: false };
  }

  function activityModel(items = [], now = Date.now()) {
    return items.slice().reverse().map((i) => ({ text: i.text, ago: ago(i.at, now), kind: i.kind, warn: i.level === 'warn' }));
  }

  // External Windows workers (Aalto, STARTAG): rooms driven ONLY by the worker feed in
  // /api/overview. They are not OpenClaw agents and are never controlled from the VPS.
  // A stale or missing report renders STALE/OFFLINE; values are never filled in.
  const STARTAG_TARGET = 50000;
  const EXT_TONE = { WATCHING: 'ok', RUNNING: 'ok', PROOFREADING: 'ok', PROMPT_READY: 'ok', COMPLETED: 'ok', IDLE: 'idle', SEAT_FOUND: 'warn', ALERTING: 'warn', WAITING_LIMIT: 'warn', WAITING_APPROVAL: 'warn', ERROR: 'bad', OFF: 'off', OFFLINE: 'stale' };
  function externalRoomModel(id, w, now = Date.now()) {
    if (!w) {
      return { id, present: false, status: 'NO DATA', tone: 'stale', stale: true, badge: 'EXTERNAL · WINDOWS', board: id === 'startag_50k' ? 'NO DATA' : null, rows: [['Status', 'no report received from the Windows worker']] };
    }
    const d = w.details || {};
    const stale = w.stale === true || w.status === 'OFFLINE';
    const status = stale ? 'OFFLINE' : String(w.status || 'UNKNOWN');
    const m = { id, present: true, status, tone: stale ? 'stale' : (EXT_TONE[status] || 'idle'), stale, badge: 'EXTERNAL · WINDOWS', rows: [] };
    const has = (v) => v !== undefined && v !== null && v !== '';
    const row = (k, v) => { if (has(v)) m.rows.push([k, String(v)]); };
    // While stale, reported values are history, never current state: label them.
    const hist = (v) => (has(v) ? (stale ? 'last reported: ' + v + ' (stale)' : v) : null);
    row('Worker', (w.name || id) + ' · Windows / external');
    row('Status', stale ? 'OFFLINE (stale: last report ' + (w.lastSeenAt ? ago(w.lastSeenAt, now) + ' ago' : 'never') + ')' : status);
    row('Phase', hist(w.phase) || '—'); row('Message', hist(w.message));
    if (id === 'aalto_seat_watcher') {
      m.label = stale ? 'STALE' : status;
      row('Last check', w.lastCheckAt ? ago(w.lastCheckAt, now) + ' ago' + (stale ? ' (stale)' : '') : 'UNKNOWN');
      row('Next poll', !stale && w.nextCheckAt ? hhmm(w.nextCheckAt) : (stale ? '—' : 'UNKNOWN'));
      row('Enabled (TURN ON/OFF)', w.enabled === false ? 'OFF' : 'ON');
    }
    if (id === 'startag_50k') {
      const p = w.progress || {};
      const cur = Number.isFinite(p.current) ? p.current : null;
      const pending = w.control && w.control.pendingAction ? w.control.pendingAction.action : null;
      const active = !stale && ['RUNNING', 'PROOFREADING', 'PROMPT_READY', 'WAITING_LIMIT', 'WAITING_APPROVAL'].includes(status);
      m.power = {
        active,
        pending,
        label: (pending === 'run' || pending === 'resume') ? 'STARTING…' : active ? 'ON' : 'OFF',
        action: active ? null : 'run'
      };
      m.board = stale ? 'STALE / OFFLINE' : (cur === null ? 'NO PROGRESS REPORTED' : cur.toLocaleString('en-US') + ' / ' + STARTAG_TARGET.toLocaleString('en-US'));
      m.fraction = !stale && cur !== null ? Math.max(0, Math.min(1, cur / STARTAG_TARGET)) : null;
      m.codex = stale ? '—' : (d.codex ? d.codex.state : 'not reported');
      m.proofreader = stale ? '—' : (d.proofreader ? d.proofreader.state : 'not reported');
      m.checkpoint = d.checkpoint && d.checkpoint.id ? d.checkpoint.id : null;
      m.lastBatch = d.lastBatch && d.lastBatch.id ? d.lastBatch.id + (Number.isFinite(d.lastBatch.count) ? ' (' + d.lastBatch.count + ')' : '') : null;
      m.alert = null;
      if (!stale && status === 'WAITING_LIMIT') m.alert = 'WAITING_LIMIT' + (d.codex && d.codex.nextRetryAt ? ' · retry ' + hhmm(d.codex.nextRetryAt) : '');
      if (!stale && status === 'WAITING_APPROVAL') m.alert = 'WAITING_APPROVAL' + (w.message ? ' · ' + w.message : '');
      if (!stale && status === 'ERROR') m.alert = 'ERROR' + (d.errorSummary ? ' · ' + d.errorSummary : '');
      row('Progress', stale ? (cur !== null ? 'last reported ' + cur.toLocaleString('en-US') + ' / 50,000 (stale)' : 'unknown (stale)') : m.board);
      row('Checkpoint', hist(m.checkpoint) || '—'); row('Last batch', hist(m.lastBatch ? m.lastBatch + (Number.isFinite(d.lastBatch.at) ? ' at ' + hhmm(d.lastBatch.at) : '') : null) || '—');
      row('Codex', m.codex); row('Proofreader', m.proofreader);
      if (d.codex && d.codex.nextRetryAt && status === 'WAITING_LIMIT' && !stale) row('Codex retry', hhmm(d.codex.nextRetryAt));
      if (d.errorSummary) row('Error', hist(d.errorSummary));
    }
    row('Last seen', w.lastSeenAt ? ago(w.lastSeenAt, now) + ' ago' : 'never');
    row('Stale', stale ? 'yes' : 'no');
    if (w.propagation && w.propagation !== 'NOT_APPLICABLE') row('Global stop', w.propagation === 'ACKED' ? 'acknowledged by the worker' : 'propagation pending (not stopped by the VPS)');
    if (w.globalStop && Number.isFinite(w.globalStop.epoch)) row('Last stop ack', 'epoch ' + w.globalStop.epoch);
    row('Controlled from VPS', 'no (observed only)');
    return m;
  }

  // ------------------------------------------------------------ DOM (browser)

  function mount({ doc, stage, hud, fetchImpl, layoutPromise, getHudInputs, setInterval: si = (typeof setInterval === 'function' ? setInterval : null) }) {
    const el = (tag, cls, text) => { const n = doc.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
    let overview = null;
    let plaqueNodes = [];
    let extRooms = []; // { id, nodes }

    // HUD groups
    hud.textContent = '';
    const groups = {};
    for (const [key, title] of [['work', 'WORK'], ['infra', 'INFRA'], ['global', 'GLOBAL'], ['level', 'BUSINESS'], ['race', 'DEMO RACE'], ['usage', 'USAGE']]) {
      const g = el('div', 'hud-group hud-' + key);
      g.appendChild(el('span', 'hud-title', title));
      hud.appendChild(g);
      groups[key] = g;
    }
    const stat = (g, label) => { const s = el('div', 'stat'); s.appendChild(el('span', null, label)); const b = el('b', null, '–'); s.appendChild(b); g.appendChild(s); return { s, b }; };
    const w = { active: stat(groups.work, 'Active'), queued: stat(groups.work, 'Queued'), running: stat(groups.work, 'Running'), approvals: stat(groups.work, 'Approvals'), failed: stat(groups.work, 'Failed') };
    const dot = (g, label, title) => { const d = el('div', 'health'); d.title = title; const i = el('i', 'dot'); d.appendChild(i); d.appendChild(doc.createTextNode(label)); g.appendChild(d); return i; };
    const infra = { gateway: dot(groups.infra, 'Gateway', 'OpenClaw Gateway'), pixel: dot(groups.infra, 'Pixel', 'Pixel Office server'), sync: dot(groups.infra, 'Sync', 'OpenClaw -> Pixel Office sync'), bridge: dot(groups.infra, 'Bridge', 'Business OS Bridge service'), scheduler: dot(groups.infra, 'Scheduler', 'OpenClaw scheduler') };
    const gl = { system: stat(groups.global, 'System'), mode: stat(groups.global, 'Mode'), kill: stat(groups.global, 'Global kill') };
    const lvl = { name: el('b', 'lvl-name', 'LVL ?'), detail: el('span', 'lvl-detail', ''), bar: el('span', 'lvl-bar', '') };
    groups.level.appendChild(lvl.name); groups.level.appendChild(lvl.detail); groups.level.appendChild(lvl.bar);
    groups.level.title = 'Business Level from VERIFIED realized net profit only';
    const race = { leader: el('b', 'race-leader', 'UNKNOWN'), detail: el('span', 'race-detail', ''), bar: el('span', 'race-bar', '') };
    groups.race.appendChild(race.leader); groups.race.appendChild(race.detail); groups.race.appendChild(race.bar);
    groups.race.title = 'Fake money only · PAPER_DEMO_ONLY · LIVE_DISABLED';
    const usageNodes = {};
    for (const [k, label] of [['codex', 'CODEX'], ['claude', 'CLAUDE']]) {
      const u = el('div', 'usage');
      const name = el('span', 'usage-name', label); const val = el('span', 'usage-val', '…'); const sub = el('span', 'usage-sub', '');
      u.appendChild(name); u.appendChild(val); u.appendChild(sub);
      groups.usage.appendChild(u);
      usageNodes[k] = { u, val, sub };
    }

    // Activity feed (collapsible)
    const feed = el('div', 'cc-feed collapsed');
    const feedHead = el('button', 'cc-feed-head', 'Activity ▸');
    feedHead.type = 'button';
    const feedList = el('div', 'cc-feed-list');
    feed.appendChild(feedHead); feed.appendChild(feedList);
    feedHead.addEventListener('click', () => {
      const c = feed.className.includes('collapsed');
      feed.className = 'cc-feed' + (c ? '' : ' collapsed');
      feedHead.textContent = c ? 'Activity ▾' : 'Activity ▸';
    });
    stage.appendChild(feed);

    function renderHud() {
      const m = hudModel({ ...getHudInputs(), overview });
      for (const k of Object.keys(w)) w[k].b.textContent = String(m.work[k]);
      w.failed.s.className = 'stat' + (m.work.failedAlert ? ' alert' : '');
      for (const [k, i] of Object.entries(infra)) i.className = 'dot ' + (m.infra[k] === true ? 'ok' : m.infra[k] === false ? 'bad' : '');
      gl.system.b.textContent = m.global.system; gl.system.s.className = 'stat state-' + m.global.system;
      gl.mode.b.textContent = m.global.mode;
      gl.kill.b.textContent = m.global.kill;
    }

    function render() {
      renderHud();
      const bos = overview && overview.bos;
      const lm = levelModel(bos && bos.available ? bos.level : null);
      lvl.name.textContent = lm.text; lvl.detail.textContent = lm.detail; lvl.bar.textContent = lm.bar;
      const rm = raceModel(bos && bos.available ? bos.paper_race : null);
      race.leader.textContent = rm.leader; race.detail.textContent = rm.detail; race.bar.textContent = bar(rm.fraction, 10); groups.race.title = rm.tooltip || 'Fake money only · PAPER_DEMO_ONLY · LIVE_DISABLED';
      const usage = (overview && overview.usage) || {};
      for (const [k, n] of Object.entries(usageNodes)) {
        const um = usageModel(k, usage[k]);
        n.val.textContent = um.kind === 'bar' ? um.bar + ' ' + um.text : um.text;
        n.sub.textContent = um.sub || '';
        n.u.title = um.reason || '';
        n.u.className = 'usage usage-' + um.status;
      }
      const ach = bos && bos.available ? bos.achievements : [];
      plaquesModel(plaqueNodes.map((p) => p.pos), ach).forEach((pm, i) => {
        const n = plaqueNodes[i].node;
        n.className = 'cc-plaque' + (pm.unlocked ? ' unlocked' : '');
        n.textContent = pm.unlocked ? '★' : '';
        n.title = (pm.unlocked ? 'Unlocked: ' : 'Locked: ') + pm.title + (pm.unlocked ? ' (' + (pm.display_date || String(pm.unlocked_at || '').slice(0, 10)) + ')' : '') + (pm.category === 'historical' ? ' · historical milestone' : '');
      });
      renderExternal();
      feedList.textContent = '';
      for (const a of activityModel((overview && overview.activity) || []).slice(0, 30)) {
        const row = el('div', 'cc-feed-row' + (a.warn ? ' warn' : ''));
        row.appendChild(el('span', 'cc-feed-ago', a.ago));
        row.appendChild(el('span', 'cc-feed-text', a.text));
        feedList.appendChild(row);
      }
    }

    // External worker rooms + detail card
    const card = el('div', 'cc-ext-card hidden');
    const cardTitle = el('b', 'cc-ext-title', '');
    const cardClose = el('button', 'cc-ext-close', '×'); cardClose.type = 'button';
    const cardRows = el('div', 'cc-ext-rows');
    card.appendChild(cardClose); card.appendChild(cardTitle); card.appendChild(cardRows);
    card.appendChild(el('div', 'cc-ext-note', 'External Windows worker · observed via /api/workers · not an OpenClaw agent · not controlled from the VPS'));
    stage.appendChild(card);
    let cardFor = null;
    cardClose.addEventListener('click', () => { cardFor = null; card.className = 'cc-ext-card hidden'; });
    const workerById = (id) => ((overview && overview.workers) || []).find((x) => x.id === id) || null;
    async function setWorkerPower(id, action) {
      const res = await fetchImpl(workerControlUrl(id), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ enabled: true, action: 'run' })
      });
      if (!res.ok) throw new Error('worker control HTTP ' + res.status);
      await refresh();
    }
    function renderCard() {
      if (!cardFor) return;
      const m = externalRoomModel(cardFor.id, workerById(cardFor.id));
      cardTitle.textContent = cardFor.room;
      cardRows.textContent = '';
      for (const [k, v] of m.rows) { const r = el('div', 'cc-ext-row'); r.appendChild(el('span', null, k)); r.appendChild(el('b', null, v)); cardRows.appendChild(r); }
    }
    function renderExternal() {
      for (const r of extRooms) {
        const m = externalRoomModel(r.id, workerById(r.id));
        r.nodes.room.className = 'cc-ext-room tone-' + m.tone;
        r.nodes.status.textContent = m.id === 'aalto_seat_watcher' ? (m.label || m.status) : m.status;
        if (r.nodes.lamp) r.nodes.lamp.className = 'cc-ext-lamp tone-' + m.tone;
        if (r.nodes.power && m.power) {
          r.nodes.power.textContent = '⏻ ' + m.power.label;
          r.nodes.power.className = 'cc-ext-power' + (m.power.active ? ' on' : '') + (m.power.pending ? ' pending' : '');
          r.nodes.power.setAttribute('aria-pressed', String(m.power.active));
          r.nodes.power.setAttribute('aria-label', 'STARTAG 50K power ' + m.power.label);
          r.nodes.power.disabled = !!m.power.pending || !m.power.action;
          if (m.power.action) r.nodes.power.dataset.action = m.power.action;
          else delete r.nodes.power.dataset.action;
        }
        if (r.nodes.board) {
          r.nodes.boardText.textContent = m.board;
          r.nodes.boardBar.style.width = m.fraction === null || m.fraction === undefined ? '0' : Math.round(m.fraction * 100) + '%';
          r.nodes.board.className = 'cc-ext-board' + (m.stale ? ' stale' : '');
          r.nodes.codex.textContent = 'CODEX: ' + m.codex;
          r.nodes.proof.textContent = 'PROOFREADER: ' + m.proofreader;
          r.nodes.cp.textContent = m.stale ? 'CP —' : 'CP ' + (m.checkpoint || '—') + (m.lastBatch ? ' · ' + m.lastBatch : '');
          r.nodes.alert.textContent = m.alert || '';
          r.nodes.alert.className = 'cc-ext-alert' + (m.alert ? '' : ' hidden');
        }
      }
      renderCard();
    }

    async function refresh() {
      try {
        const r = await fetchImpl(OVERVIEW_URL, { headers: { Accept: 'application/json' } });
        overview = JSON.parse(await r.text());
      } catch (e) {
        overview = null; // backend not loaded yet -> everything renders UNKNOWN
      }
      render();
      return overview;
    }

    Promise.resolve(layoutPromise).then((layout) => {
      const tile = (layout && layout.tile) || 32;
      for (const p of (layout && layout.ui && layout.ui.plaques) || []) {
        const n = el('div', 'cc-plaque');
        n.style.left = p.x * tile + 'px';
        n.style.top = p.y * tile + 'px';
        stage.appendChild(n);
        plaqueNodes.push({ pos: p, node: n });
      }
      const place = (n, x, y, wTiles) => { n.style.left = x * tile + 'px'; n.style.top = y * tile + 'px'; if (wTiles) n.style.width = wTiles * tile + 'px'; stage.appendChild(n); return n; };
      for (const e of (layout && layout.ui && layout.ui.external) || []) {
        const nodes = {};
        nodes.room = place(el('div', 'cc-ext-room'), e.rect.x, e.rect.y, e.rect.w);
        nodes.room.style.height = e.rect.h * tile + 'px';
        nodes.room.title = e.room + ' — click for details';
        nodes.room.appendChild(el('span', 'cc-ext-badge', e.worker === 'aalto_seat_watcher' ? 'EXT' : 'EXTERNAL · WINDOWS'));
        nodes.status = el('span', 'cc-ext-status', '…');
        nodes.room.appendChild(nodes.status);
        nodes.room.addEventListener('click', () => { cardFor = { id: e.worker, room: e.room }; card.className = 'cc-ext-card'; renderCard(); });
        const st = e.stations || {};
        if (st.lamp) nodes.lamp = place(el('div', 'cc-ext-lamp'), st.lamp.x, st.lamp.y);
        if (st.board) {
          nodes.board = place(el('div', 'cc-ext-board'), st.board.x, st.board.y, st.board.w);
          nodes.boardText = el('span', 'cc-ext-board-text', '…'); nodes.boardBar = el('i', 'cc-ext-board-bar');
          nodes.board.appendChild(nodes.boardText); nodes.board.appendChild(nodes.boardBar);
        }
        if (st.codex) nodes.codex = place(el('div', 'cc-ext-label'), st.codex.x - 1, st.codex.y, 4);
        if (st.proofreader) nodes.proof = place(el('div', 'cc-ext-label'), st.proofreader.x - 1, st.proofreader.y, 4);
        if (e.worker === 'startag_50k' && st.processor) {
          nodes.power = place(el('button', 'cc-ext-power', '⏻ OFF'), st.processor.x, st.processor.y, st.processor.w || 2);
          nodes.power.type = 'button';
          nodes.power.setAttribute('aria-label', 'STARTAG 50K power OFF');
          nodes.power.addEventListener('click', async (ev) => {
            if (ev && ev.stopPropagation) ev.stopPropagation();
            if (nodes.power.disabled) return;
            const action = nodes.power.dataset.action;
            if (!action) return;
            nodes.power.disabled = true;
            try { await setWorkerPower(e.worker, action); }
            catch (err) { nodes.power.disabled = false; nodes.power.title = String(err && err.message || err); }
          });
        }
        if (st.checkpoint) nodes.cp = place(el('div', 'cc-ext-label cc-ext-cp'), st.checkpoint.x, st.checkpoint.y, st.checkpoint.w + 2);
        if (st.conveyor) nodes.alert = place(el('div', 'cc-ext-alert hidden'), st.conveyor.x - 1, st.conveyor.y + 2, st.conveyor.w + 2);
        extRooms.push({ id: e.worker, nodes });
      }
      render();
    });

    refresh();
    if (si) si(refresh, POLL_MS);
    return { refresh, render, renderHud, get overview() { return overview; }, agentMeta: (id) => agentMeta(id, overview), workerModel };
  }

  return { hudModel, levelModel, raceModel, usageModel, plaquesModel, agentMeta, workerModel, activityModel, externalRoomModel, mount, workerControlUrl, OVERVIEW_URL, POLL_MS };
});
