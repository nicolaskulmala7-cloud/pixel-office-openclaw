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

  function usageModel(label, u) {
    const s = u || { status: 'UNKNOWN' };
    if (Number.isFinite(s.percent_used)) {
      return { label, kind: 'bar', percent: s.percent_used, bar: bar(s.percent_used / 100), text: s.percent_used + '%', sub: s.reset_at ? 'reset ' + hhmm(s.reset_at) : '', status: s.status };
    }
    if (s.status === 'WAITING_LIMIT') {
      return { label, kind: 'state', text: 'WAITING_LIMIT', sub: s.next_retry_at ? 'next retry ' + hhmm(s.next_retry_at) : '', status: s.status };
    }
    if (s.status === 'AVAILABLE') return { label, kind: 'state', text: 'AVAILABLE', sub: s.detected_at ? 'seen ' + ago(s.detected_at) + ' ago' : '', status: s.status };
    return { label, kind: 'state', text: 'UNKNOWN', sub: s.last_known ? 'last ' + s.last_known + (s.detected_at ? ' ' + ago(s.detected_at) + ' ago' : '') : '', reason: s.reason || '', status: 'UNKNOWN' };
  }

  // Plaque i shows achievement i: unlocked only when the backend says it is unlocked.
  function plaquesModel(plaques = [], achievements = []) {
    return plaques.map((p, i) => {
      const a = achievements[i];
      return { x: p.x, y: p.y, id: a ? a.id : null, title: a ? a.title : 'Empty plaque', unlocked: !!(a && a.unlocked === true), unlocked_at: a ? a.unlocked_at : null };
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

  // ------------------------------------------------------------ DOM (browser)

  function mount({ doc, stage, hud, fetchImpl, layoutPromise, getHudInputs, setInterval: si = (typeof setInterval === 'function' ? setInterval : null) }) {
    const el = (tag, cls, text) => { const n = doc.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
    let overview = null;
    let plaqueNodes = [];

    // HUD groups
    hud.textContent = '';
    const groups = {};
    for (const [key, title] of [['work', 'WORK'], ['infra', 'INFRA'], ['global', 'GLOBAL'], ['level', 'BUSINESS'], ['usage', 'USAGE']]) {
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
    const usageNodes = {};
    for (const [k, label] of [['chatgpt', 'CHATGPT'], ['codex', 'CODEX'], ['claude', 'CLAUDE']]) {
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
        n.title = (pm.unlocked ? 'Unlocked: ' : 'Locked: ') + pm.title + (pm.unlocked_at ? ' (' + pm.unlocked_at.slice(0, 10) + ')' : '');
      });
      feedList.textContent = '';
      for (const a of activityModel((overview && overview.activity) || []).slice(0, 30)) {
        const row = el('div', 'cc-feed-row' + (a.warn ? ' warn' : ''));
        row.appendChild(el('span', 'cc-feed-ago', a.ago));
        row.appendChild(el('span', 'cc-feed-text', a.text));
        feedList.appendChild(row);
      }
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
      render();
    });

    refresh();
    if (si) si(refresh, POLL_MS);
    return { refresh, render, renderHud, get overview() { return overview; }, agentMeta: (id) => agentMeta(id, overview), workerModel };
  }

  return { hudModel, levelModel, usageModel, plaquesModel, agentMeta, workerModel, activityModel, mount, OVERVIEW_URL, POLL_MS };
});
