// Oval Office "Nuclear Option": a red emergency LEVER for the Business OS GLOBAL kill switch.
//
// - The lever is pixel art (canvas) inside the Oval Office, not an HTML button.
// - Its position is derived ONLY from the real backend status (never faked for animation).
// - Pulling it only opens a confirmation. Nothing is sent until the human presses ACTIVATE.
// - ACTIVATE calls POST /api/killswitch/stop once (no automatic retry). The backend runs
//   the existing Business OS CLI with fixed arguments.
// - Resume is CLI-only (system-kill.js start); this UI never resumes.
// - Only textContent is used (never HTML strings), so no status text can inject markup.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.NuclearOption = api;
    const boot = () => {
      const container = document.getElementById('mapStage') || document.getElementById('gameContainer');
      if (!container) return;
      // Lever position comes from the generated layout (ui.lever); constant fallback.
      fetch('assets/office-layout.json').then((r) => r.json()).catch(() => null).then((layout) => {
        api.createNuclearOption({ doc: document, container, fetchImpl: window.fetch.bind(window), position: api.leverPositionFromLayout(layout) }).start();
      });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const LABEL = 'Nuclear Option';
  const CONFIRM_TEXT = 'Do you want to obliterate Russia?';
  const STOP_URL = '/api/killswitch/stop';
  const STATUS_URL = '/api/killswitch/status';
  const RESUME_HINT = 'Resume is CLI-only: node ~/business-os/killswitch/system-kill.js start';

  // Oval Office ("Command Center" tiles x15-20, y9-15 at 32 px): open floor at tiles
  // (19-20, 10), right of Diktator's desk and inside the curved wall.
  const POSITION = { left: 642, top: 312 };
  const SPRITE = { w: 16, h: 28, scale: 2 }; // art pixels, drawn 2x like the office map

  const WORKER_NAMES = { startag_50k: 'STARTAG 50K', aalto_seat_watcher: 'Aalto Seat Watcher' };

  const C = {
    edge: '#0f1115', plate: '#3a3f47', bevel: '#5b616b', shade: '#24282e', bolt: '#9ca3af',
    slot: '#0b0c0f', stem: '#9ca3af', stemDark: '#6b7280',
    gripHi: '#f87171', grip: '#dc2626', gripLo: '#7f1d1d', gripCap: '#991b1b',
    hazardY: '#facc15', hazardK: '#111111',
    lockBody: '#eab308', lockShackle: '#d4d4d8', lockHole: '#111111',
  };

  // Pure pixel-art renderer. put(x, y, color) receives art-pixel coordinates (16 x 28).
  // A riveted steel housing with a vertical slot; a steel shaft rides in the slot and
  // carries a large red grip. position: 'up' | 'down' | 'mid'. locked adds a padlock.
  function drawLever(put, { position = 'up', locked = false } = {}) {
    const rect = (x, y, w, h, c) => { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) put(x + i, y + j, c); };
    // housing
    rect(3, 9, 10, 17, C.edge);
    rect(4, 10, 8, 15, C.plate);
    rect(4, 10, 8, 1, C.bevel); rect(4, 10, 1, 15, C.bevel);
    rect(4, 24, 8, 1, C.shade); rect(11, 10, 1, 15, C.shade);
    for (const [x, y] of [[5, 11], [10, 11], [5, 23], [10, 23]]) put(x, y, C.bolt);
    rect(7, 12, 2, 10, C.slot);
    // hazard base
    for (let x = 2; x <= 13; x++) for (let y = 26; y <= 27; y++) put(x, y, (x + y) % 4 < 2 ? C.hazardY : C.hazardK);
    // shaft + grip (grip top row gy, 4 rows tall)
    const gy = position === 'up' ? 0 : position === 'down' ? 19 : 10;
    if (position === 'up') { rect(7, 4, 2, 10, C.stem); rect(8, 4, 1, 10, C.stemDark); }
    else if (position === 'mid') { rect(7, 14, 2, 4, C.stem); rect(8, 14, 1, 4, C.stemDark); }
    else { rect(7, 16, 2, 3, C.stem); rect(8, 16, 1, 3, C.stemDark); }
    rect(2, gy, 12, 1, C.gripHi);
    rect(1, gy + 1, 14, 2, C.grip);
    rect(2, gy + 3, 12, 1, C.gripLo);
    put(1, gy, C.gripCap); put(14, gy, C.gripCap); put(1, gy + 3, C.gripCap); put(14, gy + 3, C.gripCap);
    put(0, gy + 1, C.gripCap); put(0, gy + 2, C.gripCap); put(15, gy + 1, C.gripCap); put(15, gy + 2, C.gripCap);
    rect(3, gy + 1, 2, 1, C.gripHi); // specular highlight
    if (locked) {
      rect(12, 14, 3, 1, C.lockShackle); put(12, 15, C.lockShackle); put(14, 15, C.lockShackle);
      rect(11, 16, 5, 4, C.lockBody); put(13, 17, C.lockHole); put(13, 18, C.lockHole);
    }
  }

  // Pure: global kill-switch status -> what the lever and labels show.
  function viewModel(status) {
    const s = status || {};
    const state = s.available === false ? 'UNAVAILABLE' : (s.state || 'UNKNOWN');
    const busy = !!s.stopInProgress;
    const allowed = s.executionAllowed === true && state === 'RUNNING';
    const unresolved = (s.unresolved || []).map((u) => u.id).filter(Boolean);
    const vm = { state, tone: 'unknown', badge: state, canArm: false, summary: [], external: [], lever: { position: allowed ? 'up' : 'down', locked: false, warning: false, disabled: false } };

    if (state === 'UNAVAILABLE') {
      Object.assign(vm, { tone: 'unavailable', badge: 'KILL SWITCH UNAVAILABLE', canArm: false });
      vm.lever = { position: 'mid', locked: true, warning: false, disabled: true };
      vm.summary.push(s.reason || 'Global kill switch backend not reachable.');
    } else if (busy || state === 'STOPPING') {
      Object.assign(vm, { tone: 'stopping', badge: 'STOPPING — AI execution blocked', canArm: false });
      vm.lever = { position: 'mid', locked: true, warning: false, disabled: false };
      vm.summary.push('Global stop in progress. New AI work is already refused.');
    } else if (state === 'RUNNING') {
      Object.assign(vm, { tone: 'running', badge: 'RUNNING — AI execution allowed', canArm: true });
      if (s.armed === false) vm.summary.push('Not armed yet: a stop will end DEGRADED until `system-kill install` is run.');
    } else if (state === 'STOPPED') {
      Object.assign(vm, { tone: 'stopped', badge: 'STOPPED — AI EXECUTION STOPPED', canArm: false });
      vm.lever = { position: 'down', locked: true, warning: false, disabled: false };
      vm.summary.push('All VPS-controlled AI execution is stopped.', RESUME_HINT);
    } else if (state === 'STARTING') {
      Object.assign(vm, { tone: 'starting', badge: 'STARTING — AI execution still blocked', canArm: false });
      vm.lever = { position: allowed ? 'up' : 'down', locked: true, warning: false, disabled: false };
      vm.summary.push('A human resume is in progress.');
    } else if (state === 'DEGRADED') {
      Object.assign(vm, { tone: 'degraded', badge: 'DEGRADED — AI execution blocked', canArm: true });
      vm.lever = { position: allowed ? 'up' : 'down', locked: false, warning: true, disabled: false };
      vm.summary.push(unresolved.length ? `Unresolved: ${unresolved.join(', ')}` : 'Some components did not reach the target state.');
      vm.summary.push('ACTIVATE re-runs the same graceful stop (no force).', RESUME_HINT);
    } else {
      Object.assign(vm, { tone: 'unknown', badge: 'UNKNOWN — gate unreadable, AI execution blocked', canArm: true });
      vm.lever = { position: 'down', locked: false, warning: true, disabled: false };
    }

    // Windows workers are never reported as stopped by the VPS kill switch.
    for (const w of s.externalWorkers || []) {
      const name = WORKER_NAMES[w.id] || w.id;
      vm.external.push(state === 'RUNNING' || w.status === 'NOT_CONTROLLED'
        ? `${name}: not controlled from VPS`
        : `${name}: propagation pending (not stopped by VPS)`);
    }
    return vm;
  }

  async function readJson(res) {
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      // The Pixel Office catch-all answers unknown routes with index.html (HTTP 200).
      throw new Error('kill switch backend not loaded (restart Pixel Office after review)');
    }
  }

  const CSS = [
    '#nuclearOption{position:absolute;z-index:7;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;gap:2px;font-family:"Courier New",monospace;pointer-events:none}',
    '#nuclearOption>*{pointer-events:auto}',
    '#nuclearLever{display:flex;flex-direction:column;align-items:center;cursor:grab;outline:none;user-select:none;-webkit-user-select:none}',
    '#nuclearLever:active{cursor:grabbing}',
    '#nuclearLever canvas{width:32px;height:56px;image-rendering:pixelated;image-rendering:crisp-edges;filter:drop-shadow(0 2px 0 rgba(0,0,0,.45))}',
    '#nuclearLever:focus-visible canvas{outline:2px solid #fde68a;outline-offset:2px}',
    '#nuclearOption[data-locked=true] #nuclearLever{cursor:not-allowed}',
    '#nuclearOption[data-armed=true] #nuclearLever canvas{filter:drop-shadow(0 0 5px #ef4444) drop-shadow(0 0 2px #ef4444)}',
    '#nuclearOption[data-warning=true] #nuclearLever canvas{animation:nuclearWarn 1.1s infinite}',
    '#nuclearOption[data-tone=stopping] #nuclearLever canvas,#nuclearOption[data-tone=starting] #nuclearLever canvas{animation:nuclearPulse .9s infinite}',
    '#nuclearOption[data-disabled=true] #nuclearLever canvas{filter:grayscale(1);opacity:.55}',
    '#nuclearPlaque{background:linear-gradient(#3b2a12,#23180a);color:#fde68a;border:1px solid #c9a227;border-radius:2px;font:bold 8px "Courier New",monospace;padding:1px 4px;white-space:nowrap;letter-spacing:.03em;box-shadow:0 1px 0 #0f1115}',
    '#nuclearOptionBadge{background:rgba(17,24,39,.92);color:#e5e7eb;font-size:8px;padding:1px 5px;border-radius:3px;white-space:nowrap}',
    '#nuclearOption[data-tone=running] #nuclearOptionBadge{color:#86efac}',
    '#nuclearOption[data-tone=stopped] #nuclearOptionBadge{color:#fca5a5;font-weight:bold}',
    '#nuclearOption[data-tone=degraded] #nuclearOptionBadge,#nuclearOption[data-tone=unknown] #nuclearOptionBadge{color:#fdba74;font-weight:bold}',
    '#nuclearOptionDetail{background:rgba(17,24,39,.88);color:#cbd5e1;font-size:8px;padding:2px 5px;border-radius:3px;max-width:220px;text-align:center}',
    '#nuclearOptionDetail[hidden]{display:none}',
    '#nuclearModal{position:fixed;inset:0;z-index:50;background:rgba(0,0,0,.72);display:flex;align-items:center;justify-content:center}',
    '#nuclearModal[hidden]{display:none}',
    '#nuclearModalBox{background:#111827;border:2px solid #b91c1c;border-radius:10px;padding:22px 26px;max-width:420px;color:#f3f4f6;font-family:"Courier New",monospace;text-align:center}',
    '#nuclearConfirmText{font-size:16px;font-weight:bold;margin:0 0 18px}',
    '#nuclearModalBox button{border:0;border-radius:6px;padding:8px 18px;font-weight:bold;margin:0 6px;cursor:pointer}',
    '#nuclearCancel{background:#4b5563;color:#fff}',
    '#nuclearActivate{background:#dc2626;color:#fff}',
    '#nuclearModalBox button:disabled{opacity:.5;cursor:wait}',
    '#nuclearResult{font-size:11px;margin-top:12px;color:#fca5a5;min-height:14px}',
    '@keyframes nuclearPulse{50%{opacity:.55}}',
    '@keyframes nuclearWarn{0%,100%{filter:drop-shadow(0 0 1px #f97316)}50%{filter:drop-shadow(0 0 6px #f97316)}}',
  ].join('\n');

  // Lever anchored on its layout tile: centred horizontally, sprite bottom on the tile bottom.
  function leverPositionFromLayout(layout) {
    const l = layout && layout.ui && layout.ui.lever;
    const tile = (layout && layout.tile) || 32;
    if (!l || !Number.isInteger(l.x) || !Number.isInteger(l.y)) return POSITION;
    return { left: l.x * tile + tile / 2, top: (l.y + 1) * tile - SPRITE.h * SPRITE.scale };
  }

  function createNuclearOption({ doc, container, fetchImpl, position = POSITION, pollMs = 10000, setIntervalImpl = (typeof setInterval === 'function' ? setInterval : null) }) {
    const el = (tag, props = {}) => {
      const node = doc.createElement(tag);
      for (const [k, v] of Object.entries(props)) {
        if (k === 'text') node.textContent = v;
        else if (k === 'attrs') for (const [a, b] of Object.entries(v)) node.setAttribute(a, b);
        else node[k] = v;
      }
      return node;
    };

    const style = el('style', { text: CSS });
    const wrap = el('div', { id: 'nuclearOption', attrs: { 'data-tone': 'unknown', 'data-locked': 'true', 'aria-label': 'Global kill switch' } });
    wrap.style.left = position.left + 'px';
    wrap.style.top = position.top + 'px';

    // The lever: a focusable element (role=button for keyboard/screen readers) whose
    // visible form is a pixel-art lever sprite plus a brass plaque.
    const lever = el('div', { id: 'nuclearLever', attrs: { role: 'button', tabindex: '0', 'aria-label': `${LABEL} (emergency lever)`, 'aria-disabled': 'true', title: 'System-wide Business OS kill switch' } });
    const sprite = el('canvas', { id: 'nuclearLeverSprite', width: SPRITE.w, height: SPRITE.h, attrs: { 'aria-hidden': 'true' } });
    const plaque = el('div', { id: 'nuclearPlaque', text: LABEL });
    lever.appendChild(sprite);
    lever.appendChild(plaque);
    const badge = el('div', { id: 'nuclearOptionBadge', text: 'checking…' });
    const detail = el('div', { id: 'nuclearOptionDetail', text: '', hidden: true });
    wrap.appendChild(lever);
    wrap.appendChild(badge);
    wrap.appendChild(detail);

    const modal = el('div', { id: 'nuclearModal', hidden: true, attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'nuclearConfirmText' } });
    const box = el('div', { id: 'nuclearModalBox' });
    const question = el('p', { id: 'nuclearConfirmText', text: CONFIRM_TEXT });
    const cancel = el('button', { id: 'nuclearCancel', type: 'button', text: 'CANCEL' });
    const activate = el('button', { id: 'nuclearActivate', type: 'button', text: 'ACTIVATE' });
    const result = el('div', { id: 'nuclearResult', text: '' });
    box.appendChild(question);
    box.appendChild(cancel);
    box.appendChild(activate);
    box.appendChild(result);
    modal.appendChild(box);

    let lastVm = viewModel(null);
    let sending = false;

    function paint(leverState) {
      const ctx = sprite.getContext && sprite.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, SPRITE.w, SPRITE.h);
      drawLever((x, y, c) => { ctx.fillStyle = c; ctx.fillRect(x, y, 1, 1); }, leverState);
    }

    function interactive() {
      return lastVm.canArm && !sending;
    }

    function render(status) {
      lastVm = viewModel(status);
      wrap.setAttribute('data-tone', lastVm.tone);
      wrap.setAttribute('data-locked', String(!interactive()));
      wrap.setAttribute('data-warning', String(lastVm.lever.warning));
      wrap.setAttribute('data-disabled', String(lastVm.lever.disabled));
      wrap.setAttribute('data-lever', lastVm.lever.position);
      lever.setAttribute('aria-disabled', String(!interactive()));
      badge.textContent = lastVm.badge;
      const text = [...lastVm.summary, ...lastVm.external].join(' · ');
      detail.textContent = text;
      detail.hidden = !text;
      paint(lastVm.lever); // position comes only from the real status
      return lastVm;
    }

    async function refresh() {
      try {
        const res = await fetchImpl(STATUS_URL, { method: 'GET', headers: { Accept: 'application/json' } });
        return render(await readJson(res));
      } catch (e) {
        return render({ available: false, reason: e.message });
      }
    }

    // Pulling the lever only opens the confirmation. It never sends anything.
    function openConfirm() {
      if (!interactive()) return false; // STOPPED/STOPPING/STARTING/unavailable: no-op
      result.textContent = '';
      activate.disabled = false;
      cancel.disabled = false;
      wrap.setAttribute('data-armed', 'true');
      modal.hidden = false;
      return true;
    }

    // CANCEL: close and redraw the lever from the last REAL status (no request).
    function closeConfirm() {
      modal.hidden = true;
      wrap.setAttribute('data-armed', 'false');
      paint(lastVm.lever);
    }

    async function activateStop() {
      if (sending || modal.hidden) return null;
      sending = true;
      activate.disabled = true;
      cancel.disabled = true;
      result.textContent = 'Sending global stop…';
      let outcome;
      try {
        const res = await fetchImpl(STOP_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Pixel-Office-Action': 'nuclear-option' },
          body: JSON.stringify({ confirm: 'ACTIVATE' }),
        });
        const body = await readJson(res);
        if (res.status === 202 && body.accepted) outcome = { ok: true, text: 'Global stop started. AI execution is blocked; watch the lever.' };
        else if (body.noop) outcome = { ok: true, text: 'Already STOPPED. Nothing was sent.' };
        else outcome = { ok: false, text: `Not started: ${body.reason || 'HTTP ' + res.status}` };
      } catch (e) {
        outcome = { ok: false, text: `Not started: ${e.message}` };
      }
      result.textContent = outcome.text;
      sending = false;
      cancel.disabled = false;
      if (outcome.ok) closeConfirm();
      await refresh(); // the lever moves only when the backend reports the new state
      return outcome;
    }

    lever.addEventListener('click', () => { openConfirm(); });
    lever.addEventListener('keydown', (e) => {
      if (e && (e.key === 'Enter' || e.key === ' ')) { if (e.preventDefault) e.preventDefault(); openConfirm(); }
    });
    cancel.addEventListener('click', () => { closeConfirm(); refresh(); });
    activate.addEventListener('click', () => { activateStop(); });

    function start() {
      doc.head.appendChild(style);
      container.appendChild(wrap);
      doc.body.appendChild(modal);
      render(null);
      refresh();
      if (setIntervalImpl && pollMs > 0) setIntervalImpl(refresh, pollMs);
      return api;
    }

    const api = { start, refresh, render, openConfirm, closeConfirm, activateStop, nodes: { wrap, lever, sprite, plaque, badge, detail, modal, question, cancel, activate, result } };
    return api;
  }

  return { createNuclearOption, viewModel, drawLever, leverPositionFromLayout, LABEL, CONFIRM_TEXT, STOP_URL, STATUS_URL, POSITION, SPRITE };
});
