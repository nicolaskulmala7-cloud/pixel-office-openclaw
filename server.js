const express = require('express');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
} else {
  dotenv.config();
}

const resolveDataDir = (dir) => {
  if (!dir) {
    return path.join(__dirname, 'data');
  }
  return path.isAbsolute(dir) ? dir : path.join(__dirname, dir);
};

const DATA_DIR = resolveDataDir(process.env.PIXEL_DATA_DIR);
fs.mkdirSync(DATA_DIR, { recursive: true });

const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'pixeladmin';

const dataPath = (filename) => path.join(DATA_DIR, filename);
const CONFIG_PATH = dataPath('pixel-config.json');
const AGENTS_PATH = dataPath('agents.json');
const LOG_PATH = dataPath('pixel_actions.jsonl');
const MAP_PATH = dataPath('map.json');
const COLLISION_PATH = dataPath('pixel_collision.json');
const ROOMS_PATH = dataPath('pixel_rooms.json');
const agentMessagePath = (id) => dataPath(`agent_${id}_message.txt`);
const ARRIVED_OFFICE_PATH = dataPath('pep_arrived_office');
const ARRIVED_RECEPTION_PATH = dataPath('pep_arrived_reception');

const readJSONFile = (filePath) => {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    return null;
  }
};

const writeJSONFile = (filePath, data) => {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
};

const loadAgentsFromDisk = () => {
  const agentsData = readJSONFile(AGENTS_PATH);
  if (Array.isArray(agentsData) && agentsData.length) {
    return agentsData;
  }
  const legacyConfig = readJSONFile(CONFIG_PATH);
  if (legacyConfig && Array.isArray(legacyConfig.agents)) {
    return legacyConfig.agents;
  }
  return null;
};

const persistAgents = (agents) => {
  if (Array.isArray(agents)) {
    writeJSONFile(AGENTS_PATH, agents);
  }
};

const loadMapData = () => {
  const mapData = readJSONFile(MAP_PATH);
  if (mapData) {
    return mapData;
  }
  return {
    collision: readJSONFile(COLLISION_PATH),
    rooms: readJSONFile(ROOMS_PATH)
  };
};

const persistMapData = (updates = {}) => {
  const current = loadMapData() || {};
  const merged = {
    ...current,
    ...updates,
    updatedAt: new Date().toISOString()
  };
  writeJSONFile(MAP_PATH, merged);
  if (merged.rooms) {
    writeJSONFile(ROOMS_PATH, merged.rooms);
  }
  if (merged.collision) {
    writeJSONFile(COLLISION_PATH, merged.collision);
  }
  return merged;
};

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 19000;

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Equipo OpenClaw: los ids internos deben coincidir exactamente con los de OpenClaw.
// `color` es el índice del sprite (assets/characters/char_N.png).
const TILE = 32;
const tileCenter = (t) => t * TILE + TILE / 2;

// Rectángulos en coordenadas de tile (inclusive) sobre el plano por defecto
const rectTiles = (x1, y1, x2, y2) => {
  const tiles = [];
  for (let y = y1; y <= y2; y++) {
    for (let x = x1; x <= x2; x++) tiles.push({ x, y });
  }
  return tiles;
};

// Plano de la oficina OpenClaw (generado por tools/build-office-map.js junto a assets/office-openclaw.png)
const OFFICE_LAYOUT = readJSONFile(path.join(__dirname, 'assets', 'office-layout.json')) || {};
const DEFAULT_COLLISION = Array.isArray(OFFICE_LAYOUT.collision) ? OFFICE_LAYOUT.collision : null;
const SPAWNS = OFFICE_LAYOUT.spawns || {};
const spawnX = (id, fallback) => tileCenter(SPAWNS[id] ? SPAWNS[id].x : fallback);
const spawnY = (id, fallback) => tileCenter(SPAWNS[id] ? SPAWNS[id].y : fallback);

const DEFAULT_ROOMS = Array.isArray(OFFICE_LAYOUT.rooms) && OFFICE_LAYOUT.rooms.length ? OFFICE_LAYOUT.rooms : [
  { id: 1, name: 'Command Center', color: '#c9a227', tiles: rectTiles(15, 11, 20, 13) },
  { id: 2, name: 'Research Lab', color: '#ec4899', tiles: rectTiles(1, 2, 10, 8) },
  { id: 3, name: 'Writing Studio', color: '#10b981', tiles: rectTiles(1, 10, 10, 15) },
  { id: 4, name: 'Review Room', color: '#f59e0b', tiles: rectTiles(1, 17, 10, 23) },
  { id: 5, name: 'Hangout Room', color: '#8b5cf6', tiles: rectTiles(14, 19, 21, 23) },
  { id: 6, name: 'Trading Floor', color: '#22c55e', tiles: rectTiles(25, 2, 34, 6) },
  { id: 7, name: 'Crypto Lab', color: '#f7931a', tiles: rectTiles(25, 8, 34, 12) },
  { id: 8, name: 'Memecoin War Room', color: '#ef4444', tiles: rectTiles(25, 14, 34, 18) },
  { id: 9, name: 'Sports Analytics Room', color: '#06b6d4', tiles: rectTiles(25, 20, 34, 23) }
];

const DEFAULT_AGENTS = [
  { id: 'coordinator', name: 'Diktator', role: 'Coordinator', color: 0, x: spawnX('coordinator', 17), y: spawnY('coordinator', 10), room: 'Command Center' },
  { id: 'researcher', name: 'Researcher', role: 'Research Analyst', color: 1, x: spawnX('researcher', 16), y: spawnY('researcher', 20), room: 'Research Lab' },
  { id: 'writer', name: 'Writer', role: 'Content Writer', color: 2, x: spawnX('writer', 15), y: spawnY('writer', 22), room: 'Writing Studio' },
  { id: 'reviewer', name: 'Reviewer', role: 'Quality Reviewer', color: 3, x: spawnX('reviewer', 16), y: spawnY('reviewer', 22), room: 'Review Room' },
  { id: 'market_trader', name: 'Trader', role: 'Market Trader (paper)', color: 4, x: spawnX('market_trader', 20), y: spawnY('market_trader', 20), room: 'Trading Floor' },
  { id: 'crypto_analyst', name: 'Crypto', role: 'Crypto Analyst (paper)', color: 5, x: spawnX('crypto_analyst', 19), y: spawnY('crypto_analyst', 21), room: 'Crypto Lab' },
  { id: 'memecoin_scout', name: 'Memecoin Scout', role: 'Memecoin Scout (research only)', color: 6, x: spawnX('memecoin_scout', 21), y: spawnY('memecoin_scout', 21), room: 'Memecoin War Room' },
  { id: 'sports_analyst', name: 'Sports Analyst', role: 'Sports Analyst (paper)', color: 7, x: spawnX('sports_analyst', 20), y: spawnY('sports_analyst', 22), room: 'Sports Analytics Room' }
].map(a => ({ ...a, personality: 'Trabajador', state: 'idle', active: true }));

// Salas del demo original (sin tiles); si el mapa guardado solo contiene estas, se reemplaza
const LEGACY_DEMO_ROOM_NAMES = ['Recepción', 'Sala Principal', 'Sala Reuniones', 'Despacho', 'Cafetería'];

const OPENCLAW_IDS = DEFAULT_AGENTS.map(a => a.id);
const SAFE_AGENT_ID = /^[A-Za-z0-9_-]+$/;
const clone = (v) => JSON.parse(JSON.stringify(v));

// Los agentes demo usaban ids numéricos (0-5); se descartan y se garantizan los 4 de OpenClaw.
// Se conservan los cambios guardados (nombre, posición, sala...) de los agentes OpenClaw.
const normalizeAgents = (agents) => {
  const list = Array.isArray(agents) ? agents : [];
  const kept = list.filter(a => a && typeof a.id === 'string' && SAFE_AGENT_ID.test(a.id));
  const result = DEFAULT_AGENTS.map(def => {
    const saved = kept.find(a => a.id === def.id);
    return saved ? { ...def, ...saved } : clone(def);
  });
  kept.forEach(a => {
    if (!OPENCLAW_IDS.includes(a.id)) result.push(a);
  });
  return result;
};

const isLegacyDemoRooms = (rooms) =>
  Array.isArray(rooms) && rooms.every(r =>
    r && LEGACY_DEMO_ROOM_NAMES.includes(r.name) && !(Array.isArray(r.tiles) && r.tiles.length)
  );

// Sin salas o con las del demo -> salas por defecto. Con salas propias -> se añaden las que falten.
const normalizeRooms = (rooms) => {
  if (!Array.isArray(rooms) || !rooms.length || isLegacyDemoRooms(rooms)) {
    return clone(DEFAULT_ROOMS);
  }
  const result = [...rooms];
  DEFAULT_ROOMS.forEach(def => {
    if (!result.some(r => r && r.name === def.name)) result.push(clone(def));
  });
  return result;
};

// Copia única de los datos previos a la migración (nunca se sobrescribe)
const backupOnce = (filePath, suffix) => {
  if (!fs.existsSync(filePath)) return;
  const backupPath = filePath.replace(/\.json$/, `.${suffix}.json`);
  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(filePath, backupPath);
    console.log(`Backup created: ${backupPath}`);
  }
};

let config = {
  agents: clone(DEFAULT_AGENTS),
  rooms: clone(DEFAULT_ROOMS)
};

// Cargar configuración guardada
try {
  const storedAgents = loadAgentsFromDisk();
  if (storedAgents) {
    config.agents = storedAgents;
    console.log('Agentes cargados desde disco');
  } else if (fs.existsSync(CONFIG_PATH)) {
    const savedConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if (Array.isArray(savedConfig.agents)) {
      config.agents = savedConfig.agents;
    }
    if (Array.isArray(savedConfig.rooms)) {
      config.rooms = savedConfig.rooms;
    }
    console.log('Configuración cargada (legacy)');
  } else {
    console.log('Usando configuración inicial');
  }
} catch (e) {
  console.log('Usando configuración inicial');
}

const initialMapData = loadMapData() || {};
if (Array.isArray(initialMapData.rooms) && initialMapData.rooms.length) {
  config.rooms = initialMapData.rooms;
}

// Migración al equipo OpenClaw
const migratedAgents = normalizeAgents(config.agents);
if (JSON.stringify(migratedAgents) !== JSON.stringify(config.agents)) {
  backupOnce(AGENTS_PATH, 'pre-openclaw-backup');
  config.agents = migratedAgents;
  persistAgents(config.agents);
  console.log('Agents migrated to the OpenClaw team');
} else if (!fs.existsSync(AGENTS_PATH)) {
  persistAgents(config.agents);
}

const migratedRooms = normalizeRooms(config.rooms);
if (JSON.stringify(migratedRooms) !== JSON.stringify(config.rooms) || !fs.existsSync(MAP_PATH)) {
  backupOnce(MAP_PATH, 'pre-openclaw-backup');
  config.rooms = migratedRooms;
  persistMapData({
    rooms: config.rooms,
    collision: initialMapData.collision || null
  });
  console.log('Rooms migrated to the OpenClaw layout');
}

// Acepta solo ids seguros (se usan en rutas de archivo)
const agentKey = (raw) => (SAFE_AGENT_ID.test(String(raw)) ? String(raw) : null);

app.get('/api/config', (req, res) => {
  res.json({
    agents: config.agents,
    rooms: config.rooms
  });
});

console.log('Dashboard auth route ready');
app.post('/api/auth/login', (req, res) => {
  const { password } = req.body || {};
  if (!DASHBOARD_PASSWORD) {
    return res.json({ success: true });
  }
  if (password && password === DASHBOARD_PASSWORD) {
    return res.json({ success: true });
  }
  return res.status(401).json({ success: false });
});

// Posición y estado de los agentes los controla /api/agent/:id/move (live sync);
// un guardado de configuración no los sobrescribe.
const LIVE_FIELDS = ['x', 'y', 'state', 'status', 'task', 'taskId', 'statusSince'];
const roomsHaveTiles = (rooms) => Array.isArray(rooms) && rooms.some(r => r && Array.isArray(r.tiles) && r.tiles.length);

app.post('/api/config', (req, res) => {
  const previous = config;
  config = req.body || {};
  config.agents = normalizeAgents(config.agents).map(agent => {
    const current = (previous.agents || []).find(a => a.id === agent.id);
    if (!current) return agent;
    const live = {};
    LIVE_FIELDS.forEach(k => { if (current[k] !== undefined) live[k] = current[k]; });
    return { ...agent, ...live };
  });
  if (!roomsHaveTiles(config.rooms)) {
    config.rooms = roomsHaveTiles(previous.rooms) ? previous.rooms : clone(DEFAULT_ROOMS);
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  persistAgents(config.agents);
  persistMapData({ rooms: config.rooms });
  console.log('Configuración guardada');
  res.json({ success: true, config });
});

app.post('/api/agent/:id/move', (req, res) => {
  const id = agentKey(req.params.id);
  const { x, y, state } = req.body;
  const agent = config.agents.find(a => String(a.id) === id);
  if (agent) {
    if (x !== undefined) agent.x = x;
    if (y !== undefined) agent.y = y;
    if (state) agent.state = state;
    persistAgents(config.agents);
    console.log(`[${agent.name}] Mover a (${x}, ${y})`);
    res.json({ success: true, agent });
  } else {
    res.status(404).json({ error: 'Agente no encontrado' });
  }
});

// ---------------------------------------------------------------------------
// Live status, task feed and health (written by the OpenClaw sync bridge)

const AGENT_STATUSES = ['IDLE', 'WORKING', 'RESEARCHING', 'WRITING', 'REVIEWING', 'DELEGATING', 'WAITING APPROVAL', 'ERROR', 'OFFLINE'];
const TASK_STATUSES = ['queued', 'running', 'waiting_approval', 'completed', 'failed', 'cancelled', 'timed_out', 'lost'];
const TASKS_PATH = dataPath('tasks.json');
const MAX_TASKS = 200;
const clip = (v, n) => (typeof v === 'string' ? v.slice(0, n) : undefined);
const num = (v) => (Number.isFinite(v) ? v : undefined);

app.post('/api/agent/:id/status', (req, res) => {
  const id = agentKey(req.params.id);
  const agent = id && config.agents.find(a => String(a.id) === id);
  if (!agent) return res.status(404).json({ error: 'Agente no encontrado' });
  const { status, task, taskId } = req.body || {};
  if (!AGENT_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  if (agent.status !== status) agent.statusSince = Date.now();
  agent.status = status;
  agent.task = clip(task, 160) || '';
  agent.taskId = clip(taskId, 80) || '';
  persistAgents(config.agents);
  res.json({ success: true });
});

// Sanitised copy of the OpenClaw task ledger (titles, states, timestamps, short summaries)
let taskFeed = readJSONFile(TASKS_PATH) || { updatedAt: 0, tasks: [] };
const sanitizeTask = (t) => ({
  id: clip(t.id, 80),
  agentId: clip(t.agentId, 64),
  title: clip(t.title, 200) || '',
  status: TASK_STATUSES.includes(t.status) ? t.status : 'queued',
  kind: clip(t.kind, 32),
  runtime: clip(t.runtime, 32),
  createdAt: num(t.createdAt),
  startedAt: num(t.startedAt),
  endedAt: num(t.endedAt),
  summary: clip(t.summary, 600),
  error: clip(t.error, 300),
  toolUseCount: num(t.toolUseCount),
  parentTaskId: clip(t.parentTaskId, 80)
});
app.post('/api/tasks/sync', (req, res) => {
  const list = req.body && Array.isArray(req.body.tasks) ? req.body.tasks : null;
  if (!list) return res.status(400).json({ error: 'tasks[] required' });
  const tasks = list.filter(t => t && typeof t.id === 'string').slice(0, MAX_TASKS).map(sanitizeTask);
  taskFeed = { updatedAt: Date.now(), tasks };
  writeJSONFile(TASKS_PATH, taskFeed);
  res.json({ success: true, count: tasks.length });
});
app.get('/api/tasks', (req, res) => {
  let tasks = taskFeed.tasks;
  if (req.query.agentId) tasks = tasks.filter(t => t.agentId === String(req.query.agentId));
  if (req.query.status) tasks = tasks.filter(t => t.status === String(req.query.status));
  res.json({ updatedAt: taskFeed.updatedAt, tasks });
});

// Health: Pixel Office itself, plus what the bridge last reported (no secrets)
const startedAt = Date.now();
let bridgeReport = null;
const BRIDGE_STALE_MS = 45000;
app.post('/api/sync/heartbeat', (req, res) => {
  const b = req.body || {};
  bridgeReport = {
    receivedAt: Date.now(),
    version: clip(b.version, 32),
    gateway: {
      connected: b.gateway && b.gateway.connected === true,
      since: num(b.gateway && b.gateway.since),
      serverVersion: clip(b.gateway && b.gateway.serverVersion, 32)
    },
    scheduler: b.scheduler && typeof b.scheduler === 'object' ? {
      ok: b.scheduler.ok === true,
      jobs: num(b.scheduler.jobs),
      enabledJobs: num(b.scheduler.enabledJobs),
      nextWakeAt: num(b.scheduler.nextWakeAt)
    } : null
  };
  res.json({ success: true });
});
app.get('/api/health', (req, res) => {
  const now = Date.now();
  const bridgeOk = !!bridgeReport && now - bridgeReport.receivedAt < BRIDGE_STALE_MS;
  res.json({
    now,
    pixelOffice: { ok: true, uptimeMs: now - startedAt },
    bridge: { ok: bridgeOk, lastSeenAt: bridgeReport ? bridgeReport.receivedAt : null, version: bridgeReport ? bridgeReport.version : null },
    gateway: { ok: bridgeOk && bridgeReport.gateway.connected, since: bridgeOk ? bridgeReport.gateway.since : null, version: bridgeOk ? bridgeReport.gateway.serverVersion : null },
    scheduler: bridgeOk && bridgeReport.scheduler ? bridgeReport.scheduler : { ok: false, jobs: null }
  });
});

// API para obtener log de acciones
app.get('/api/log', (req, res) => {
  try {
    const logData = fs.readFileSync(LOG_PATH, 'utf8')
      .split('\n')
      .filter(line => line.trim())
      .map(line => JSON.parse(line))
      .slice(-50);
    res.json(logData);
  } catch (e) {
    res.json([]);
  }
});

// API para limpiar log
app.post('/api/log/clear', (req, res) => {
  try {
    fs.writeFileSync(LOG_PATH, '');
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API para obtener comandos de agentes (movimientos)
const agentCommands = {};
const commandTimestamps = {};

app.get('/api/agent/:id/command', (req, res) => {
  const id = agentKey(req.params.id);
  const cmd = id && agentCommands[id];
  
  // Si hay comando y tiene menos de 30 segundos, devolverlo y consumirlo inmediatamente
  if (cmd && commandTimestamps[id]) {
    const age = Date.now() - commandTimestamps[id];
    if (age < 30000) { // Comando válido por 30 segundos
      // Consumir inmediatamente para evitar que otros navegadores lo lean
      agentCommands[id] = null;
      commandTimestamps[id] = null;
      return res.json(cmd);
    } else {
      // Comando expirado, limpiar
      agentCommands[id] = null;
      commandTimestamps[id] = null;
    }
  }
  res.json(null);
});

// Endpoint para confirmar que el agente llegó físicamente al destino
app.post('/api/agent/:id/arrived', (req, res) => {
  const id = agentKey(req.params.id);
  const { location } = req.body;
  
  // Crear archivo de señalización para el controller
  if (location === 'office') {
    fs.writeFileSync(ARRIVED_OFFICE_PATH, '1');
  } else if (location === 'reception') {
    fs.writeFileSync(ARRIVED_RECEPTION_PATH, '1');
  }
  
  console.log(`[Llegada] Agente ${id} llegó a: ${location}`);
  res.json({ success: true });
});
app.post('/api/agent/:id/command/ack', (req, res) => {
  const id = agentKey(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid agent id' });
  agentCommands[id] = null;
  commandTimestamps[id] = null;
  res.json({ success: true });
});

app.post('/api/agent/:id/command', (req, res) => {
  const id = agentKey(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid agent id' });
  agentCommands[id] = req.body;
  commandTimestamps[id] = Date.now();
  console.log(`[Comando] Agente ${id}:`, req.body);
  res.json({ success: true });
});
app.get('/api/messages', (req, res) => {
  const messages = {};
  config.agents.forEach(agent => {
    const id = agentKey(agent.id);
    if (!id) return;
    try {
      messages[id] = fs.readFileSync(agentMessagePath(id), 'utf8');
    } catch (e) {
      messages[id] = "";
    }
  });
  res.json(messages);
});

// API para guardar mapa de colisiones
app.post('/api/collision', (req, res) => {
  try {
    persistMapData({ collision: req.body });
    console.log('Collision map saved');
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API para guardar salas
app.post('/api/rooms', (req, res) => {
  try {
    const updated = persistMapData({ rooms: req.body });
    if (Array.isArray(updated.rooms)) {
      config.rooms = updated.rooms;
    }
    console.log('Rooms saved');
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.get('/api/collision', (req, res) => {
  try {
    const mapData = loadMapData();
    const collision = (mapData && mapData.collision) || DEFAULT_COLLISION;
    if (!collision) {
      throw new Error('Mapa no disponible');
    }
    res.json(collision);
  } catch (e) {
    res.status(500).json({ error: e.message || 'Mapa no disponible' });
  }
});

// API para obtener salas
app.get('/api/rooms', (req, res) => {
  try {
    const mapData = loadMapData();
    if (mapData && Array.isArray(mapData.rooms)) {
      return res.json(mapData.rooms);
    }
  } catch (e) {
    // ignore and fallback below
  }
  res.json(config.rooms.map(r => ({ ...r, tiles: r.tiles || [] })));
});

app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Solo loopback: el acceso remoto se hace por túnel SSH
const HOST = '127.0.0.1';

app.listen(PORT, HOST, () => {
  console.log(`Pixel Office v3 en http://${HOST}:${PORT}`);
  console.log('Agentes activos:', config.agents.filter(a => a.active).map(a => a.name).join(', '));
});
