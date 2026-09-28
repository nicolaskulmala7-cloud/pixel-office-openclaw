#!/usr/bin/env node
// OpenClaw Gateway -> Pixel Office live sync bridge.
//
// Consumes structured session events from the local OpenClaw Gateway
// (sessions.subscribe / sessions.changed / session.message, with sessions.list
// {activeOnly} reconciliation) and mirrors per-agent activity into Pixel Office
// through its HTTP API. Makes no LLM/model calls. Loopback-only by design.
//
// Env (all optional):
//   OPENCLAW_GATEWAY_URL   default ws://127.0.0.1:18789
//   OPENCLAW_CONFIG_PATH   default ~/.openclaw/openclaw.json (shared token source)
//   OPENCLAW_GATEWAY_TOKEN overrides the token read from the config file
//   PIXEL_OFFICE_URL       default http://127.0.0.1:19000
//   PIXEL_SYNC_STATE_DIR   default ~/.local/state/pixel-office-sync

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const VERSION = '1.0.0';
const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || 'ws://127.0.0.1:18789';
const PIXEL_URL = (process.env.PIXEL_OFFICE_URL || 'http://127.0.0.1:19000').replace(/\/+$/, '');
const OPENCLAW_CONFIG_PATH = process.env.OPENCLAW_CONFIG_PATH || path.join(os.homedir(), '.openclaw', 'openclaw.json');
const STATE_DIR = process.env.PIXEL_SYNC_STATE_DIR || path.join(os.homedir(), '.local', 'state', 'pixel-office-sync');
const IDENTITY_PATH = path.join(STATE_DIR, 'device-identity.json');

// OpenClaw agent -> Pixel Office agent. `slot` is the Pixel Office sprite/color index (0-3).
const AGENT_MAP = [
  { openclaw: 'coordinator', pixel: 'coordinator', slot: 0, name: 'Chief of Staff', room: 'Command Center' },
  { openclaw: 'researcher', pixel: 'researcher', slot: 1, name: 'Researcher', room: 'Research Lab' },
  { openclaw: 'writer', pixel: 'writer', slot: 2, name: 'Writer', room: 'Writing Studio' },
  { openclaw: 'reviewer', pixel: 'reviewer', slot: 3, name: 'Reviewer', room: 'Review Room' }
];
const COORDINATOR = 'coordinator';

const CLIENT_ID = 'gateway-client';
const CLIENT_MODE = 'ui';
const ROLE = 'operator';
const SCOPES = ['operator.read']; // read-only: subscribe + list, nothing else
const PROTOCOL = 4;

const TILE = 32;
const RPC_TIMEOUT_MS = 10000;
const RECONCILE_MS = 30000;       // sessions.list {activeOnly} safety net + liveness check
const PIXEL_RECONCILE_MS = 15000; // re-assert state if a browser config save clobbered it
const LAYOUT_REFRESH_MS = 5 * 60 * 1000;
const IDLE_DEBOUNCE_MS = 2500;    // avoid flicker between back-to-back runs
const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 30000;
const PAIRING_RETRY_MS = 30000;

// ---------------------------------------------------------------------------
// Logging with secret scrubbing

const secrets = new Set();
const addSecret = (s) => { if (typeof s === 'string' && s.length >= 8) secrets.add(s); };
const scrub = (text) => {
  let out = String(text);
  for (const s of secrets) out = out.split(s).join('<redacted>');
  return out;
};
const log = (...parts) => console.log(scrub(parts.map(p => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')));
const describeError = (e) => {
  if (!e) return 'unknown error';
  const code = e.details && (e.details.code || e.details.reason);
  return [e.code, code, e.message].filter(Boolean).join(' / ');
};

// ---------------------------------------------------------------------------
// Loopback enforcement

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const assertLoopback = (label, raw) => {
  const u = new URL(raw);
  if (!LOOPBACK_HOSTS.has(u.hostname)) {
    throw new Error(`${label} must be a loopback address (got host "${u.hostname}")`);
  }
};

// ---------------------------------------------------------------------------
// Credentials: shared gateway token (bootstrap) + persisted device identity/token

const readSharedToken = () => {
  if (process.env.OPENCLAW_GATEWAY_TOKEN) return process.env.OPENCLAW_GATEWAY_TOKEN;
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(OPENCLAW_CONFIG_PATH, 'utf8'));
  } catch (e) {
    throw new Error(`cannot read OpenClaw config at ${OPENCLAW_CONFIG_PATH}`);
  }
  const token = cfg && cfg.gateway && cfg.gateway.auth && cfg.gateway.auth.token;
  if (typeof token !== 'string' || !token) {
    throw new Error('gateway.auth.token is not a plain string in the OpenClaw config; set OPENCLAW_GATEWAY_TOKEN');
  }
  return token;
};

const writePrivateJSON = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
};

const loadIdentity = () => {
  let ident = null;
  try {
    ident = JSON.parse(fs.readFileSync(IDENTITY_PATH, 'utf8'));
  } catch (e) { /* create below */ }
  if (!ident || !ident.privateKeyPem || !ident.publicKeyPem) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    ident = {
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
      privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' })
    };
    writePrivateJSON(IDENTITY_PATH, ident);
    log('[auth] created new device identity');
  }
  const raw = crypto.createPublicKey(ident.publicKeyPem).export({ type: 'spki', format: 'der' }).subarray(-32);
  ident.publicKeyRaw = raw.toString('base64url');
  ident.deviceId = crypto.createHash('sha256').update(raw).digest('hex');
  addSecret(ident.deviceToken);
  return ident;
};

const persistDeviceToken = (ident, token) => {
  addSecret(token);
  if (ident.deviceToken === token) return;
  ident.deviceToken = token;
  writePrivateJSON(IDENTITY_PATH, {
    publicKeyPem: ident.publicKeyPem,
    privateKeyPem: ident.privateKeyPem,
    deviceToken: token
  });
  log('[auth] stored device token (operator.read)');
};

const clearDeviceToken = (ident) => {
  delete ident.deviceToken;
  writePrivateJSON(IDENTITY_PATH, { publicKeyPem: ident.publicKeyPem, privateKeyPem: ident.privateKeyPem });
};

// Mirrors buildDeviceAuthPayloadV3 from the gateway client package.
const signConnect = (ident, { nonce, signedAt, token }) => {
  const payload = [
    'v3', ident.deviceId, CLIENT_ID, CLIENT_MODE, ROLE, SCOPES.join(','),
    String(signedAt), token || '', nonce, 'linux', ''
  ].join('|');
  const signature = crypto.sign(null, Buffer.from(payload, 'utf8'), crypto.createPrivateKey(ident.privateKeyPem));
  return {
    id: ident.deviceId,
    publicKey: ident.publicKeyRaw,
    signature: signature.toString('base64url'),
    signedAt,
    nonce
  };
};

// ---------------------------------------------------------------------------
// Pixel Office client

const pixel = {
  reachable: false,
  layout: new Map(), // pixelId -> { tileX, tileY, room }
  layoutLoadedAt: 0
};

const pixelFetch = async (route, options = {}) => {
  const res = await fetch(`${PIXEL_URL}${route}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    signal: AbortSignal.timeout(5000)
  });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} for ${route}`);
    err.status = res.status;
    throw err;
  }
  const type = res.headers.get('content-type') || '';
  return type.includes('application/json') ? res.json() : res.text();
};

const pixelPost = (route, body) => pixelFetch(route, { method: 'POST', body: JSON.stringify(body) });

// Collision map: server copy if saved, else the default map shipped in index.html.
const loadCollisionMap = async () => {
  try {
    const map = await pixelFetch('/api/collision');
    if (Array.isArray(map) && Array.isArray(map[0])) return map;
  } catch (e) { /* fall through */ }
  try {
    const html = await pixelFetch('/index.html');
    const m = typeof html === 'string' && html.match(/default_COLLISION_MAP\s*=\s*(\[\[[\d,\[\]\s]+\]\])/);
    if (m) return JSON.parse(m[1]);
  } catch (e) { /* fall through */ }
  return null;
};

// Pick a stable target tile inside the room: prefer chairs (3), then floor (0),
// nearest to the room's centroid. Without a collision map, nearest tile to centroid.
const pickRoomTile = (room, collision) => {
  const tiles = (room && Array.isArray(room.tiles) ? room.tiles : []).filter(t => Number.isInteger(t.x) && Number.isInteger(t.y));
  if (!tiles.length) return null;
  const cx = tiles.reduce((s, t) => s + t.x, 0) / tiles.length;
  const cy = tiles.reduce((s, t) => s + t.y, 0) / tiles.length;
  const dist = (t) => (t.x - cx) ** 2 + (t.y - cy) ** 2;
  const cell = (t) => (collision && collision[t.y] ? collision[t.y][t.x] : undefined);
  const byDist = (a, b) => dist(a) - dist(b) || a.y - b.y || a.x - b.x;
  const chairs = tiles.filter(t => cell(t) === 3).sort(byDist);
  const floor = tiles.filter(t => cell(t) === 0).sort(byDist);
  return chairs[0] || floor[0] || (collision ? null : tiles.slice().sort(byDist)[0]);
};

const refreshLayout = async () => {
  const [config, rooms, collision] = await Promise.all([
    pixelFetch('/api/config'),
    pixelFetch('/api/rooms'),
    loadCollisionMap()
  ]);
  const agents = (config && Array.isArray(config.agents)) ? config.agents : [];
  const roomList = Array.isArray(rooms) && rooms.length ? rooms : (config.rooms || []);
  const layout = new Map();
  for (const m of AGENT_MAP) {
    const agent = agents.find(a => a.id === m.pixel) || agents.find(a => a.color === m.slot);
    if (!agent) {
      log(`[pixel] WARNING no Pixel Office agent for ${m.openclaw} (id "${m.pixel}" / slot ${m.slot})`);
      continue;
    }
    if (agent.id !== m.pixel || agent.color !== m.slot) {
      log(`[pixel] WARNING mapping drift for ${m.openclaw}: found id "${agent.id}" slot ${agent.color}`);
    }
    const room = roomList.find(r => r && r.name === m.room);
    const tile = pickRoomTile(room, collision);
    if (!tile) log(`[pixel] WARNING no walkable tile found in room "${m.room}" for ${m.openclaw}`);
    layout.set(m.openclaw, { pixelId: agent.id, name: agent.name, slot: agent.color, room: m.room, tile });
  }
  const changed = JSON.stringify([...layout]) !== JSON.stringify([...pixel.layout]);
  pixel.layout = layout;
  pixel.layoutLoadedAt = Date.now();
  if (changed) {
    for (const [oc, l] of layout) {
      const where = l.tile ? `tile (${l.tile.x},${l.tile.y})` : 'no tile';
      log(`[pixel] map ${oc} -> Pixel Office "${l.pixelId}" slot ${l.slot} "${l.name}" -> ${l.room} ${where}`);
    }
    if (!collision) log('[pixel] WARNING collision map unavailable; using unfiltered room tiles');
  }
};

// ---------------------------------------------------------------------------
// Activity model

// sessionKey -> { agentId, sessionId, active }
const sessions = new Map();
const desired = new Map();  // openclawId -> { state, label }
const applied = new Map();  // openclawId -> { state, label }; cleared when Pixel Office drops
const wasWorking = new Map(); // openclawId -> last state successfully pushed (survives Pixel Office drops)
const idleTimers = new Map();

const agentIdFromKey = (key) => {
  const m = typeof key === 'string' && key.match(/^agent:([^:]+):/);
  return m ? m[1] : null;
};

const isActiveRow = (row) => {
  if (!row) return false;
  if (Array.isArray(row.activeRunIds) && row.activeRunIds.length) return true;
  return row.hasActiveRun === true;
};

const agentIsActive = (agentId) => {
  for (const s of sessions.values()) if (s.agentId === agentId && s.active) return true;
  return false;
};

const computeDesired = () => {
  const result = new Map();
  const workerActive = AGENT_MAP.some(m => m.openclaw !== COORDINATOR && agentIsActive(m.openclaw));
  for (const m of AGENT_MAP) {
    if (!agentIsActive(m.openclaw)) {
      result.set(m.openclaw, { state: 'idle', label: '' });
    } else if (m.openclaw === COORDINATOR) {
      result.set(m.openclaw, { state: 'working', label: workerActive ? 'Delegating' : 'Working' });
    } else {
      result.set(m.openclaw, { state: 'working', label: 'Working' });
    }
  }
  return result;
};

const sameTarget = (a, b) => a && b && a.state === b.state && a.label === b.label;

const recompute = () => {
  const next = computeDesired();
  for (const [id, target] of next) {
    const prev = desired.get(id);
    if (target.state === 'idle' && prev && prev.state === 'working') {
      // Debounce working -> idle so consecutive runs don't make the sprite bounce.
      if (!idleTimers.has(id)) {
        idleTimers.set(id, setTimeout(() => {
          idleTimers.delete(id);
          if (!agentIsActive(id)) {
            desired.set(id, { state: 'idle', label: '' });
            pushAgent(id).catch(() => {});
          }
        }, IDLE_DEBOUNCE_MS));
      }
      continue;
    }
    if (target.state === 'working' && idleTimers.has(id)) {
      clearTimeout(idleTimers.get(id));
      idleTimers.delete(id);
    }
    if (!sameTarget(prev, target)) {
      desired.set(id, target);
      pushAgent(id).catch(() => {});
    }
  }
};

// Apply one keyed row (from sessions.changed, session.message or sessions.list).
const applyRow = (row, fallback = {}) => {
  const key = row.key || fallback.sessionKey;
  if (!key) return false;
  const agentId = row.agentId || fallback.agentId || agentIdFromKey(key);
  if (!agentId) return false;
  const hasFact = Array.isArray(row.activeRunIds) || typeof row.hasActiveRun === 'boolean';
  if (!hasFact) return true; // keyed but no activity fact (omission is inert)
  const prev = sessions.get(key);
  sessions.set(key, { agentId, sessionId: row.sessionId || (prev && prev.sessionId), active: isActiveRow(row) });
  return true;
};

const handleSessionEvent = (payload) => {
  if (!payload) return false;
  const key = payload.sessionKey || payload.key || (payload.session && payload.session.key);
  if (!key) return false; // keyless = broad invalidation
  if (payload.reason === 'delete' || payload.reason === 'deleted') {
    sessions.delete(key);
    return true;
  }
  const nested = payload.session || {};
  // Nested row values take precedence; fall back to top-level receipts.
  const row = {
    key,
    agentId: nested.agentId || payload.agentId,
    sessionId: nested.sessionId || payload.sessionId,
    hasActiveRun: typeof nested.hasActiveRun === 'boolean' ? nested.hasActiveRun : payload.hasActiveRun,
    activeRunIds: Array.isArray(nested.activeRunIds) ? nested.activeRunIds
      : (Array.isArray(payload.activeRunIds) ? payload.activeRunIds : undefined)
  };
  return applyRow(row);
};

// Replace the active set from an authoritative activeOnly snapshot.
const applyActiveSnapshot = (list) => {
  const rows = (list && Array.isArray(list.sessions)) ? list.sessions : [];
  const activeKeys = new Set();
  for (const row of rows) {
    if (row && row.key && isActiveRow(row)) {
      activeKeys.add(row.key);
      sessions.set(row.key, { agentId: row.agentId || agentIdFromKey(row.key), sessionId: row.sessionId, active: true });
    }
  }
  for (const [key, s] of sessions) {
    if (!activeKeys.has(key)) {
      if (s.active) s.active = false;
    }
  }
  // Keep the map bounded: only active sessions matter for state.
  for (const [key, s] of sessions) if (!s.active) sessions.delete(key);
};

// ---------------------------------------------------------------------------
// Push state into Pixel Office

const pushAgent = async (id, { force = false } = {}) => {
  const target = desired.get(id);
  const layout = pixel.layout.get(id);
  if (!target || !layout) return;
  if (!force && sameTarget(applied.get(id), target)) return;
  const pid = encodeURIComponent(layout.pixelId);
  try {
    if (target.state === 'working') {
      const body = { state: 'working' };
      if (layout.tile) {
        body.x = layout.tile.x * TILE + TILE / 2;
        body.y = layout.tile.y * TILE + TILE / 2;
      }
      await pixelPost(`/api/agent/${pid}/move`, body);
      if (layout.tile) {
        await pixelPost(`/api/agent/${pid}/command`, {
          action: 'move', tileX: layout.tile.x, tileY: layout.tile.y, msg: target.label, source: 'openclaw-sync'
        });
      }
    } else {
      await pixelPost(`/api/agent/${pid}/move`, { state: 'idle' });
      // Release the sprite back to autonomous wandering only if this bridge put it to work,
      // so other automations' commands aren't interrupted on startup.
      const prev = applied.get(id) || wasWorking.get(id);
      if (prev && prev.state === 'working') {
        await pixelPost(`/api/agent/${pid}/command`, { action: 'idle', source: 'openclaw-sync' });
      }
    }
    wasWorking.set(id, { state: target.state });
    applied.set(id, { ...target });
    markPixelReachable(true);
    log(`[sync] ${id} -> ${target.state}${target.label ? ` (${target.label})` : ''}${target.state === 'working' ? ` @ ${layout.room}` : ''}`);
  } catch (e) {
    markPixelReachable(false, e);
  }
};

const markPixelReachable = (ok, err) => {
  if (ok && !pixel.reachable) {
    pixel.reachable = true;
    log('[pixel] reachable');
  } else if (!ok && pixel.reachable) {
    pixel.reachable = false;
    applied.clear(); // re-apply everything once it's back
    log(`[pixel] unreachable: ${err ? err.message : 'unknown'}`);
  }
};

// Periodic Pixel Office reconciliation: layout refresh, restart recovery and
// re-asserting `state` if a browser's 5s config save overwrote it.
const pixelReconcile = async () => {
  try {
    const wasReachable = pixel.reachable;
    if (!wasReachable || Date.now() - pixel.layoutLoadedAt > LAYOUT_REFRESH_MS) await refreshLayout();
    const config = await pixelFetch('/api/config');
    markPixelReachable(true);
    for (const [id, target] of desired) {
      const layout = pixel.layout.get(id);
      if (!layout) continue;
      const agent = (config.agents || []).find(a => a.id === layout.pixelId);
      if (!wasReachable || !applied.has(id)) {
        await pushAgent(id, { force: true });
      } else if (agent && agent.state !== target.state) {
        await pixelPost(`/api/agent/${encodeURIComponent(layout.pixelId)}/move`, { state: target.state });
      }
    }
  } catch (e) {
    markPixelReachable(false, e);
  }
};

// ---------------------------------------------------------------------------
// Gateway connection

let ws = null;
let rpcSeq = 0;
const pending = new Map();
let backoffMs = BACKOFF_MIN_MS;
let reconnectTimer = null;
let reconcileTimer = null;
let connectedAt = 0;
let stopping = false;
let useSharedToken = false;
let lastInvalidation = 0;

const rpc = (method, params) => new Promise((resolve, reject) => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return reject(new Error('gateway not connected'));
  const id = `pos-${++rpcSeq}`;
  const timer = setTimeout(() => {
    pending.delete(id);
    reject(Object.assign(new Error(`${method} timed out`), { code: 'TIMEOUT' }));
  }, RPC_TIMEOUT_MS);
  pending.set(id, { resolve, reject, timer });
  ws.send(JSON.stringify({ type: 'req', id, method, params }));
});

const scheduleReconnect = (delayMs) => {
  if (stopping || reconnectTimer) return;
  const base = delayMs != null ? delayMs : backoffMs;
  const wait = Math.round(base * (0.8 + Math.random() * 0.4));
  if (delayMs == null) backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
  log(`[gateway] reconnecting in ${Math.round(wait / 1000)}s`);
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, wait);
};

const reconcileGateway = async () => {
  try {
    const list = await rpc('sessions.list', { activeOnly: true, limit: 200 });
    applyActiveSnapshot(list);
    recompute();
  } catch (e) {
    log(`[gateway] reconcile failed: ${describeError(e)}`);
    if (e.code === 'TIMEOUT' && ws) ws.close(4000, 'reconcile timeout');
  }
};

const onHello = async (hello, ident) => {
  const auth = hello.auth || {};
  if (auth.deviceToken) persistDeviceToken(ident, auth.deviceToken);
  useSharedToken = false;
  connectedAt = Date.now();
  log(`[gateway] connected (server ${hello.server && hello.server.version}, scopes ${JSON.stringify(auth.scopes || [])})`);
  try {
    // Install listener first (done in onmessage); then subscribe with an activeOnly snapshot.
    const res = await rpc('sessions.subscribe', { activeOnly: true, limit: 200 });
    applyActiveSnapshot(res && res.list);
    recompute();
    // Trailing refresh in case events raced the snapshot.
    setTimeout(() => reconcileGateway(), 1000);
  } catch (e) {
    log(`[gateway] subscribe failed: ${describeError(e)}`);
    if (ws) ws.close(4001, 'subscribe failed');
    return;
  }
  clearInterval(reconcileTimer);
  reconcileTimer = setInterval(reconcileGateway, RECONCILE_MS);
};

const onConnectError = (err, ident, usedDeviceToken) => {
  const code = err && err.details && (err.details.code || err.details.reason);
  log(`[gateway] connect rejected: ${describeError(err)}`);
  if (code === 'PAIRING_REQUIRED' || /pairing/i.test(err && err.message)) {
    const reqId = err.details && err.details.requestId;
    log(`[gateway] device pairing required${reqId ? ` (request ${reqId})` : ''}; approve with: openclaw devices approve <requestId>`);
    return PAIRING_RETRY_MS;
  }
  if (usedDeviceToken) {
    // Stored device token rejected (revoked/rotated): fall back to shared-token bootstrap once.
    clearDeviceToken(ident);
    useSharedToken = true;
    return BACKOFF_MIN_MS;
  }
  return null;
};

const connect = () => {
  if (stopping) return;
  let ident, sharedToken;
  try {
    ident = loadIdentity();
    sharedToken = readSharedToken();
    addSecret(sharedToken);
  } catch (e) {
    log(`[gateway] setup error: ${e.message}`);
    scheduleReconnect(BACKOFF_MAX_MS);
    return;
  }
  const usedDeviceToken = !useSharedToken && !!ident.deviceToken;
  const authToken = usedDeviceToken ? ident.deviceToken : sharedToken;

  let socket;
  try {
    socket = new WebSocket(GATEWAY_URL);
  } catch (e) {
    log(`[gateway] cannot open socket: ${e.message}`);
    scheduleReconnect();
    return;
  }
  ws = socket;
  let handshakeDone = false;
  let retryOverride = null;

  const challengeTimer = setTimeout(() => {
    if (!handshakeDone) {
      log('[gateway] no connect.challenge received');
      socket.close(4002, 'no challenge');
    }
  }, RPC_TIMEOUT_MS);

  socket.onmessage = (ev) => {
    let frame;
    try { frame = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')); } catch (e) { return; }

    if (frame.type === 'res') {
      const p = pending.get(frame.id);
      if (!p) return;
      pending.delete(frame.id);
      clearTimeout(p.timer);
      if (frame.ok) p.resolve(frame.payload);
      else p.reject(Object.assign(new Error((frame.error && frame.error.message) || 'request failed'), frame.error || {}));
      return;
    }
    if (frame.type !== 'event') return;

    if (frame.event === 'connect.challenge') {
      clearTimeout(challengeTimer);
      const { nonce, ts } = frame.payload || {};
      if (typeof nonce !== 'string' || !Number.isInteger(ts) || ts < 0) {
        log('[gateway] invalid connect.challenge');
        socket.close(4003, 'invalid challenge');
        return;
      }
      rpc('connect', {
        minProtocol: PROTOCOL,
        maxProtocol: PROTOCOL,
        client: { id: CLIENT_ID, displayName: 'Pixel Office Sync', version: VERSION, platform: 'linux', mode: CLIENT_MODE },
        role: ROLE,
        scopes: SCOPES,
        caps: [],
        auth: { token: authToken },
        userAgent: `openclaw-pixel-sync/${VERSION}`,
        device: signConnect(ident, { nonce, signedAt: ts, token: authToken })
      }).then((hello) => {
        handshakeDone = true;
        backoffMs = BACKOFF_MIN_MS;
        return onHello(hello, ident);
      }).catch((err) => {
        if (err && err.code === 'UNAVAILABLE' && err.retryAfterMs) retryOverride = err.retryAfterMs;
        else retryOverride = onConnectError(err, ident, usedDeviceToken);
        socket.close(4004, 'connect rejected');
      });
      return;
    }

    if (!handshakeDone) return;
    const payload = frame.payload;
    if (frame.event === 'sessions.changed' || frame.event === 'session.message') {
      const keyed = handleSessionEvent(payload);
      if (keyed) {
        recompute();
      } else if (frame.event === 'sessions.changed' && Date.now() - lastInvalidation > 1000) {
        lastInvalidation = Date.now();
        setTimeout(reconcileGateway, 250); // broad invalidation -> authoritative refresh
      }
    } else if (frame.event === 'agent' && payload && payload.stream === 'lifecycle') {
      const phase = payload.data && payload.data.phase;
      if (phase === 'end' || phase === 'error' || phase === 'aborted') setTimeout(reconcileGateway, 1500);
    }
  };

  socket.onerror = () => { /* onclose follows */ };

  socket.onclose = (ev) => {
    clearTimeout(challengeTimer);
    clearInterval(reconcileTimer);
    reconcileTimer = null;
    for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error('gateway disconnected')); }
    pending.clear();
    if (ws === socket) ws = null;
    if (stopping) return;
    const uptime = connectedAt ? Date.now() - connectedAt : 0;
    connectedAt = 0;
    log(`[gateway] disconnected (code ${ev.code}${ev.reason ? `, ${scrub(ev.reason)}` : ''})`);
    // Unknown activity while disconnected: mark everyone idle rather than show stale work.
    sessions.clear();
    recompute();
    if (uptime > 60000) backoffMs = BACKOFF_MIN_MS;
    scheduleReconnect(retryOverride);
  };
};

// ---------------------------------------------------------------------------
// Main

const main = async () => {
  assertLoopback('OPENCLAW_GATEWAY_URL', GATEWAY_URL);
  assertLoopback('PIXEL_OFFICE_URL', PIXEL_URL);
  if (typeof WebSocket !== 'function' || typeof fetch !== 'function') {
    throw new Error('Node.js >= 22 with global WebSocket and fetch is required');
  }
  log(`[sync] openclaw-pixel-sync ${VERSION} starting (gateway ${GATEWAY_URL}, pixel ${PIXEL_URL})`);
  for (const m of AGENT_MAP) desired.set(m.openclaw, { state: 'idle', label: '' });
  await pixelReconcile();
  setInterval(pixelReconcile, PIXEL_RECONCILE_MS);
  connect();
};

const shutdown = (sig) => {
  stopping = true;
  log(`[sync] ${sig} received, shutting down`);
  if (ws) ws.close(1000, 'shutdown');
  setTimeout(() => process.exit(0), 200);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (e) => log(`[sync] unhandled rejection: ${describeError(e)}`));

main().catch((e) => {
  log(`[sync] fatal: ${e.message}`);
  process.exit(1);
});
