'use strict';
// UI behaviour of the Oval Office "Nuclear Option" lever using a minimal fake DOM.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createNuclearOption, viewModel, drawLever, LABEL, CONFIRM_TEXT, POSITION, SPRITE } = require('../nuclear-option');

class Ctx {
  constructor() { this.px = new Map(); this.fillStyle = ''; }
  clearRect() { this.px.clear(); }
  fillRect(x, y) { this.px.set(`${x},${y}`, this.fillStyle); }
  count(color) { let n = 0; for (const c of this.px.values()) if (c === color) n++; return n; }
}
class El {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this.style = {}; this.listeners = {}; this._text = ''; this.hidden = false; this.disabled = false; if (this.tagName === 'CANVAS') this.ctx = new Ctx(); }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  appendChild(c) { this.children.push(c); return c; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k]; }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  dispatch(t, e = {}) { for (const fn of this.listeners[t] || []) fn(e); }
  click() { if (this.disabled) return; this.dispatch('click'); }
  getContext() { return this.ctx; }
  all() { return [this, ...this.children.flatMap((c) => c.all())]; }
}
const makeDoc = () => ({ head: new El('head'), body: new El('body'), createElement: (t) => new El(t) });

function status(state, extra = {}) {
  return { available: true, state, executionAllowed: state === 'RUNNING', armed: true, unresolved: [], externalWorkers: [{ id: 'startag_50k', status: state === 'RUNNING' ? 'NOT_CONTROLLED' : 'EXTERNAL_PROPAGATION_PENDING' }, { id: 'aalto_seat_watcher', status: state === 'RUNNING' ? 'NOT_CONTROLLED' : 'EXTERNAL_PROPAGATION_PENDING' }], ...extra };
}

function fakeFetch(current, stopResponse = { status: 202, body: { accepted: true } }) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, init });
    const reply = url.endsWith('/status') ? { status: 200, text: JSON.stringify(current.value) } : typeof stopResponse === 'function' ? await stopResponse() : { status: stopResponse.status, text: typeof stopResponse.body === 'string' ? stopResponse.body : JSON.stringify(stopResponse.body) };
    return { status: reply.status, text: async () => reply.text };
  };
  impl.calls = calls;
  impl.posts = () => calls.filter((c) => c.init.method === 'POST');
  return impl;
}

async function mount(state = 'RUNNING', stopResponse) {
  const current = { value: status(state) };
  const fetchImpl = fakeFetch(current, stopResponse);
  const doc = makeDoc();
  const container = new El('div');
  const ui = createNuclearOption({ doc, container, fetchImpl, setIntervalImpl: null }).start();
  await ui.refresh();
  return { ui, n: ui.nodes, fetchImpl, current, doc, container };
}
const flush = () => new Promise((r) => setImmediate(r));
const RED = '#dc2626';

// ---------------------------------------------------------------- the lever itself

test('the Nuclear Option is a red pixel-art lever inside the Oval Office, not a button', async () => {
  const { n, container, doc } = await mount();
  assert.equal(n.lever.tagName, 'DIV', 'not an HTML <button>');
  assert.equal(n.lever.getAttribute('role'), 'button', 'still keyboard/screen-reader operable');
  assert.equal(n.sprite.tagName, 'CANVAS');
  assert.equal(n.plaque.textContent, 'Nuclear Option');
  assert.equal(LABEL, 'Nuclear Option');
  assert.ok(!container.all().some((e) => e.tagName === 'BUTTON'), 'no HTML button in the Oval Office overlay');
  assert.ok(n.sprite.ctx.count(RED) >= 24, 'large red grip is painted (14x2 minus highlight)');
  assert.equal(n.sprite.width, 16);
  assert.equal(n.sprite.height, 28);
  // Position comes from the generated layout's lever tile, inside the Oval Office.
  const layout = require('../assets/office-layout.json');
  const oval = layout.rooms.find((r) => r.name === 'Command Center');
  assert.ok(oval.tiles.some((t) => t.x === layout.ui.lever.x && t.y === layout.ui.lever.y), 'lever tile inside the Oval Office');
  const pos = require('../nuclear-option').leverPositionFromLayout(layout);
  assert.equal(pos.left, layout.ui.lever.x * 32 + 16);
  assert.equal(pos.top + SPRITE.h * SPRITE.scale, (layout.ui.lever.y + 1) * 32, 'sprite stands on its tile');
  assert.deepEqual(require('../nuclear-option').leverPositionFromLayout(null), POSITION, 'fallback without a layout');
  const css = doc.head.children[0].textContent;
  assert.match(css, /#nuclearLever canvas\{width:32px;height:56px;image-rendering:pixelated/);
});

test('sprite: grip is UP / MID / DOWN in the slot and a padlock appears when locked', () => {
  const paint = (st) => { const ctx = new Ctx(); drawLever((x, y, c) => { ctx.fillStyle = c; ctx.fillRect(x, y); }, st); return ctx; };
  const redRows = (ctx) => [...new Set([...ctx.px].filter(([, c]) => c === RED).map(([k]) => Number(k.split(',')[1])))].sort((a, b) => a - b);
  assert.deepEqual(redRows(paint({ position: 'up' })), [1, 2]);
  assert.deepEqual(redRows(paint({ position: 'mid' })), [11, 12]);
  assert.deepEqual(redRows(paint({ position: 'down' })), [20, 21]);
  assert.equal(paint({ position: 'down', locked: true }).count('#eab308') > 0, true, 'padlock');
  assert.equal(paint({ position: 'up' }).count('#eab308'), 0);
});

test('lever state mapping follows the REAL backend state for every global state', async () => {
  const expected = {
    RUNNING: { lever: 'up', locked: 'false', warning: 'false', disabled: 'false', tone: 'running' },
    STOPPING: { lever: 'mid', locked: 'true', warning: 'false', disabled: 'false', tone: 'stopping' },
    STOPPED: { lever: 'down', locked: 'true', warning: 'false', disabled: 'false', tone: 'stopped' },
    STARTING: { lever: 'down', locked: 'true', warning: 'false', disabled: 'false', tone: 'starting' },
    DEGRADED: { lever: 'down', locked: 'false', warning: 'true', disabled: 'false', tone: 'degraded' },
  };
  for (const [state, exp] of Object.entries(expected)) {
    const { n } = await mount(state);
    const a = (k) => n.wrap.getAttribute(k);
    assert.deepEqual({ lever: a('data-lever'), locked: a('data-locked'), warning: a('data-warning'), disabled: a('data-disabled'), tone: a('data-tone') }, exp, state);
  }
  const un = await mount('RUNNING');
  un.current.value = { available: false, state: 'UNAVAILABLE', reason: 'kill switch not installed' };
  await un.ui.refresh();
  assert.equal(un.n.wrap.getAttribute('data-lever'), 'mid');
  assert.equal(un.n.wrap.getAttribute('data-disabled'), 'true');
  assert.equal(un.n.wrap.getAttribute('data-locked'), 'true');
  assert.match(un.n.badge.textContent, /UNAVAILABLE/);
  // DEGRADED derives the physical position from execution_allowed.
  assert.equal(viewModel(status('DEGRADED', { executionAllowed: true })).lever.position, 'down', 'DEGRADED never allows execution, so never UP');
  assert.equal(viewModel({ available: true, state: 'RUNNING', executionAllowed: false }).lever.position, 'down', 'not UP unless execution is really allowed');
});

// ------------------------------------------------------------- confirmation flow

test('pulling the lever only opens the confirmation; exact question; no stop request', async () => {
  const { n, fetchImpl } = await mount();
  assert.equal(n.modal.hidden, true);
  n.lever.click();
  await flush();
  assert.equal(n.modal.hidden, false);
  assert.equal(n.question.textContent, 'Do you want to obliterate Russia?');
  assert.equal(CONFIRM_TEXT, 'Do you want to obliterate Russia?');
  assert.equal(n.cancel.textContent, 'CANCEL');
  assert.equal(n.activate.textContent, 'ACTIVATE');
  assert.equal(fetchImpl.posts().length, 0);
  assert.equal(n.wrap.getAttribute('data-lever'), 'up', 'opening the dialog does not fake a lever position');
  // Keyboard: Enter also only opens the dialog.
  const k = await mount();
  k.n.lever.dispatch('keydown', { key: 'Enter', preventDefault() {} });
  assert.equal(k.n.modal.hidden, false);
  assert.equal(k.fetchImpl.posts().length, 0);
});

test('CANCEL: zero stop requests; lever returns to the authoritative backend state', async () => {
  const { n, fetchImpl, current } = await mount();
  n.lever.click();
  assert.equal(n.wrap.getAttribute('data-armed'), 'true');
  current.value = status('RUNNING');
  n.cancel.click();
  await flush(); await flush();
  assert.equal(n.modal.hidden, true);
  assert.equal(n.wrap.getAttribute('data-armed'), 'false');
  assert.equal(fetchImpl.posts().length, 0, 'no stop request');
  assert.ok(fetchImpl.calls.every((c) => c.init.method === 'GET' && c.url.endsWith('/status')), 'only read-only status refreshes');
  assert.equal(n.wrap.getAttribute('data-lever'), 'up');
});

test('ACTIVATE sends exactly one fixed stop request; lever moves only when the backend says so', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { n, fetchImpl, ui, current } = await mount('RUNNING', async () => { await gate; return { status: 202, text: JSON.stringify({ accepted: true }) }; });
  n.lever.click();
  n.activate.click();
  n.activate.click();
  release();
  await flush(); await flush(); await flush();
  const posts = fetchImpl.posts();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, '/api/killswitch/stop');
  assert.deepEqual(JSON.parse(posts[0].init.body), { confirm: 'ACTIVATE' });
  assert.equal(posts[0].init.headers['X-Pixel-Office-Action'], 'nuclear-option');
  assert.equal(posts[0].init.headers['Content-Type'], 'application/json');
  assert.equal(n.modal.hidden, true);
  assert.equal(n.wrap.getAttribute('data-lever'), 'up', 'backend still reports RUNNING: lever not faked down');
  current.value = status('STOPPING');
  await ui.refresh();
  assert.equal(n.wrap.getAttribute('data-lever'), 'mid');
  current.value = status('STOPPED');
  await ui.refresh();
  assert.equal(n.wrap.getAttribute('data-lever'), 'down');
  assert.equal(n.wrap.getAttribute('data-locked'), 'true');
});

test('STOPPED / STOPPING / STARTING / UNAVAILABLE: pulling does nothing and sends nothing', async () => {
  for (const state of ['STOPPED', 'STOPPING', 'STARTING']) {
    const { n, fetchImpl } = await mount(state);
    n.lever.click();
    await flush();
    assert.equal(n.modal.hidden, true, state);
    assert.equal(fetchImpl.posts().length, 0, state);
  }
  const stopped = await mount('STOPPED');
  assert.match(stopped.n.detail.textContent, /Resume is CLI-only/);
  assert.match(stopped.n.badge.textContent, /AI EXECUTION STOPPED/);
});

test('DEGRADED shows the exact state, a short summary, and still allows the graceful re-stop dialog', async () => {
  const vm = viewModel(status('DEGRADED', { unresolved: [{ id: 'openclaw-gateway', reason: 'x' }, { id: 'business-os-bridge', reason: 'y' }] }));
  assert.match(vm.badge, /^DEGRADED/);
  assert.ok(vm.summary.includes('Unresolved: openclaw-gateway, business-os-bridge'));
  const { n } = await mount('DEGRADED');
  n.lever.click();
  assert.equal(n.modal.hidden, false);
});

test('Windows workers are never shown as stopped by the VPS kill switch', () => {
  for (const state of ['RUNNING', 'STOPPING', 'STOPPED', 'STARTING', 'DEGRADED']) {
    const vm = viewModel(status(state));
    assert.equal(vm.external.length, 2);
    for (const line of vm.external) {
      assert.doesNotMatch(line, /^[^:]+: (stopped|STOPPED)\b/, `${state}: ${line}`);
      assert.match(line, state === 'RUNNING' ? /not controlled from VPS/ : /propagation pending \(not stopped by VPS\)/);
    }
  }
});

test('backend errors are shown and never treated as success; no automatic retry', async () => {
  const html = await mount('RUNNING', { status: 200, body: '<!DOCTYPE html><html>' });
  html.n.lever.click(); await html.ui.activateStop();
  assert.match(html.n.result.textContent, /backend not loaded/);
  assert.equal(html.n.modal.hidden, false);

  const forbidden = await mount('RUNNING', { status: 403, body: { accepted: false, reason: 'cross-origin request' } });
  forbidden.n.lever.click(); await forbidden.ui.activateStop();
  assert.match(forbidden.n.result.textContent, /Not started: cross-origin request/);

  const down = await mount('RUNNING', async () => { throw new Error('network down'); });
  down.n.lever.click(); await down.ui.activateStop();
  assert.match(down.n.result.textContent, /network down/);
  assert.equal(down.fetchImpl.posts().length, 1, 'no automatic retry');
});

test('no markup injection: status text is rendered with textContent only', async () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'nuclear-option.js'), 'utf8');
  assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
  const { ui, n } = await mount();
  ui.render(status('DEGRADED', { unresolved: [{ id: '<img src=x onerror=alert(1)>', reason: 'x' }] }));
  assert.match(n.detail.textContent, /<img src=x onerror=alert\(1\)>/, 'kept as inert text');
});
