#!/usr/bin/env node
// Generates the Pixel Office map from tools/office-spec.json: original pixel art (no
// third-party tiles), plus the matching collision grid, rooms, doors, work targets,
// idle seats, spawns, agent list and UI anchors (Nuclear Option lever, achievement
// plaques). Deterministic: the same spec always produces byte-identical outputs.
//
//   node tools/build-office-map.js
//
// Outputs:
//   assets/office-openclaw.png   COLSxROWS tiles of 32px (drawn at 16px and scaled 2x)
//   assets/office-layout.json    { cols, rows, tile, collision, rooms, targets, spawns, agents, ui }
//
// Collision codes match index.html: 0 floor, 1 wall/furniture/bedrock, 2 door, 3 chair/seat.
//
// Layout model (Fallout-Shelter-style stacked vault, original art): each floor is a band
// of compact rooms (room_height interior rows + one wall row) on both sides of a central
// lift shaft that connects every floor. Neighbouring rooms share a wall with a door in
// the walkway row; rooms next to the shaft have a door into it. Unused space is bedrock.
//
// Template legend (per room, row 0 against the top wall, last row = walkway):
//   .  floor   r  rug (walkable)   c  chair
//   T  review table   k  computer desk   w  writing desk   L  lab bench   B  bookshelf
//   W  whiteboard     F  filing cabinet  P  plant
//   Oval Office:  X executive desk   E executive chair   f flag (rectangular Finnish)   l lamp table
//                 q sofa seat (faces right)   p sofa seat (faces left)   K coffee table
//   Hangout:      s/t sofa seat (faces up/down)   u lounge chair   M TV   A arcade   C coffee bar
//   Markets:      Y wall screen   Z trading desk   Q crypto rig   H war table   J scoreboard
//   Operations:   V status video wall   R server rack   N NOC console
//   Achievements: U wall plaque frame   I trophy pedestal   G strategy map table

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SPEC = JSON.parse(fs.readFileSync(path.join(__dirname, 'office-spec.json'), 'utf8'));
const TILE = 32; // on-screen tile size
const T = 16;    // art tile size (scaled 2x)
const SCALE = TILE / T;
const RH = SPEC.room_height;
const SW = SPEC.shaft_width;
const BAND = RH + 1; // wall row + interior rows

// ---------------------------------------------------------------------------
// Spec -> grid

const roomKeys = Object.keys(SPEC.rooms);
for (const f of SPEC.floors) for (const k of [...f.left, ...f.right]) {
  if (!SPEC.rooms[k]) throw new Error(`floor references unknown room ${k}`);
}
for (const [k, r] of Object.entries(SPEC.rooms)) {
  if (!Array.isArray(r.template) || r.template.length !== RH) throw new Error(`${k}: template must have ${RH} rows`);
  const w = r.template[0].length;
  if (r.template.some((row) => row.length !== w)) throw new Error(`${k}: ragged template`);
  const walk = r.template[RH - 1];
  if (walk[0] !== '.' || walk[w - 1] !== '.') throw new Error(`${k}: walkway row must start and end with floor (door tiles)`);
}
const placed = new Set();
SPEC.floors.forEach((f) => [...f.left, ...f.right].forEach((k) => {
  if (placed.has(k)) throw new Error(`room ${k} placed twice`);
  placed.add(k);
}));
for (const k of roomKeys) if (!placed.has(k)) throw new Error(`room ${k} is not placed on any floor`);

const widthOf = (k) => SPEC.rooms[k].template[0].length;
const sideWidth = (list) => (list.length ? list.reduce((s, k) => s + widthOf(k), 0) + list.length + 1 : 1);
const LEFT = Math.max(...SPEC.floors.map((f) => sideWidth(f.left)));
const RIGHT = Math.max(...SPEC.floors.map((f) => sideWidth(f.right)));
const SHAFT_X = LEFT;                       // first shaft column
const COLS = LEFT + SW + RIGHT;
const ROWS = SPEC.floors.length * BAND + 1;

const grid = Array.from({ length: ROWS }, () => Array(COLS).fill('~'));
const set = (x, y, ch) => { grid[y][x] = ch; };
const ROOMS = [];

SPEC.floors.forEach((floor, fi) => {
  const yWall = fi * BAND;
  const y0 = yWall + 1;
  const yDoor = y0 + RH - 1;
  // Place a room with its interior starting at x0; draw walls around it.
  const place = (key, x0) => {
    const r = SPEC.rooms[key];
    const w = widthOf(key);
    for (let x = x0 - 1; x <= x0 + w; x++) { set(x, yWall, '#'); set(x, yWall + BAND, '#'); }
    for (let y = yWall; y <= yWall + BAND; y++) {
      if (grid[y][x0 - 1] !== 'D') set(x0 - 1, y, '#');
      if (grid[y][x0 + w] !== 'D') set(x0 + w, y, '#');
    }
    r.template.forEach((row, j) => [...row].forEach((ch, i) => set(x0 + i, y0 + j, ch)));
    ROOMS.push({ key, id: ROOMS.length + 1, name: r.name, label: r.label, color: r.color, floor: r.floor, oval: !!r.oval, rect: [x0, y0, x0 + w - 1, y0 + RH - 1], sign: [x0, yWall, x0 + w - 1] });
    return w;
  };
  // Right side: rooms left-to-right starting next to the shaft.
  let x = SHAFT_X + SW + 1;
  floor.right.forEach((key, i) => {
    const w = place(key, x);
    set(x - 1, yDoor, 'D'); // door to the shaft (i=0) or to the previous room
    x += w + 1;
    void i;
  });
  // Left side: rooms right-to-left starting next to the shaft.
  x = SHAFT_X - 1;
  floor.left.forEach((key) => {
    const w = widthOf(key);
    place(key, x - w);
    set(x, yDoor, 'D');
    x -= w + 1;
  });
});
// Lift shaft: walkable column through every floor; walls on both sides except doors.
for (let y = 1; y < ROWS - 1; y++) {
  for (let i = 0; i < SW; i++) set(SHAFT_X + i, y, '.');
  if (grid[y][SHAFT_X - 1] !== 'D') set(SHAFT_X - 1, y, '#');
  if (grid[y][SHAFT_X + SW] !== 'D') set(SHAFT_X + SW, y, '#');
}
for (let i = -1; i <= SW; i++) { set(SHAFT_X + i, 0, '#'); set(SHAFT_X + i, ROWS - 1, '#'); }
const LAYOUT = grid.map((row) => row.join(''));
const ZONES = [{ name: 'Lift', rect: [SHAFT_X, 1, SHAFT_X + SW - 1, ROWS - 2], floor: 'lift', color: '#94a3b8' }];

// ---------------------------------------------------------------------------
// Validation + derived data

const at = (x, y) => (x < 0 || y < 0 || x >= COLS || y >= ROWS ? '#' : LAYOUT[y][x]);
const FURNITURE = new Set(['T', 'k', 'w', 'L', 'B', 'W', 'F', 'P', 'X', 'f', 'l', 'K', 'M', 'A', 'C', 'Y', 'Z', 'Q', 'H', 'J', 'G', 'V', 'R', 'N', 'U', 'I']);
const SEATS = new Set(['c', 'E', 'q', 'p', 's', 't', 'u']);
const code = (ch) => {
  if (ch === '#' || ch === '~' || FURNITURE.has(ch)) return 1;
  if (ch === 'D') return 2;
  if (SEATS.has(ch)) return 3;
  if (ch === '.' || ch === 'r') return 0;
  throw new Error(`unknown layout char "${ch}"`);
};
const collision = LAYOUT.map(row => [...row].map(code));

// Every walkable tile must be reachable (pathfinder rules: seats are destinations only).
{
  const walk = [];
  collision.forEach((row, y) => row.forEach((v, x) => { if (v !== 1) walk.push(`${x},${y}`); }));
  const start = walk.find(k => { const [x, y] = k.split(',').map(Number); return collision[y][x] === 0; });
  const seen = new Set([start]);
  const queue = [start.split(',').map(Number)];
  while (queue.length) {
    const [x, y] = queue.shift();
    if (collision[y][x] === 3 && `${x},${y}` !== start) continue;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy, k = `${nx},${ny}`;
      if (collision[ny] && collision[ny][nx] !== undefined && collision[ny][nx] !== 1 && !seen.has(k)) { seen.add(k); queue.push([nx, ny]); }
    }
  }
  const sealed = walk.filter(k => !seen.has(k));
  if (sealed.length) throw new Error(`unreachable walkable tiles: ${sealed.join(' ')}`);
}

const rectTiles = ([x1, y1, x2, y2]) => {
  const tiles = [];
  for (let y = y1; y <= y2; y++) for (let x = x1; x <= x2; x++) tiles.push({ x, y });
  return tiles;
};
const roomTiles = (r) => rectTiles(r.rect);
const roomAt = (x, y) => ROOMS.find(r => x >= r.rect[0] && x <= r.rect[2] && y >= r.rect[1] && y <= r.rect[3]);
const zoneAt = (x, y) => ZONES.find(z => x >= z.rect[0] && x <= z.rect[2] && y >= z.rect[1] && y <= z.rect[3]);
const isWall = (x, y) => at(x, y) === '#' || at(x, y) === 'D' || at(x, y) === '~';

// ---------------------------------------------------------------------------
// Canvas (art resolution 320x400)

const W = COLS * T;
const H = ROWS * T;
const buf = Buffer.alloc(W * H * 4);

const hex = (h) => {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const px = (x, y, color, alpha = 1) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const [r, g, b] = typeof color === 'string' ? hex(color) : color;
  const i = (y * W + x) * 4;
  buf[i] = Math.round(buf[i] * (1 - alpha) + r * alpha);
  buf[i + 1] = Math.round(buf[i + 1] * (1 - alpha) + g * alpha);
  buf[i + 2] = Math.round(buf[i + 2] * (1 - alpha) + b * alpha);
  buf[i + 3] = 255;
};
const rect = (x, y, w, h, color, alpha) => {
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) px(x + i, y + j, color, alpha);
};
const shade = (h, f) => {
  const [r, g, b] = hex(h);
  const c = (v) => Math.max(0, Math.min(255, Math.round(f >= 1 ? v + (255 - v) * (f - 1) : v * f)));
  return [c(r), c(g), c(b)];
};

// 3x5 pixel font
const FONT = {
  A: ['111', '101', '111', '101', '101'], B: ['110', '101', '110', '101', '110'],
  C: ['111', '100', '100', '100', '111'], D: ['110', '101', '101', '101', '110'],
  E: ['111', '100', '110', '100', '111'], F: ['111', '100', '110', '100', '100'],
  G: ['111', '100', '101', '101', '111'], H: ['101', '101', '111', '101', '101'],
  I: ['111', '010', '010', '010', '111'], L: ['100', '100', '100', '100', '111'],
  M: ['101', '111', '111', '101', '101'], N: ['111', '101', '101', '101', '101'],
  O: ['111', '101', '101', '101', '111'], R: ['110', '101', '110', '101', '101'],
  S: ['111', '100', '111', '001', '111'], T: ['111', '010', '010', '010', '010'],
  U: ['101', '101', '101', '101', '111'], V: ['101', '101', '101', '101', '010'],
  W: ['101', '101', '111', '111', '101'], P: ['110', '101', '110', '100', '100'],
  Y: ['101', '101', '010', '010', '010'], ' ': ['000', '000', '000', '000', '000']
};
const textWidth = (s) => s.length * 4 - 1;
const text = (s, x, y, color) => {
  [...s.toUpperCase()].forEach((ch, n) => {
    const g = FONT[ch] || FONT[' '];
    g.forEach((row, j) => [...row].forEach((bit, i) => { if (bit === '1') px(x + n * 4 + i, y + j, color); }));
  });
};

// ---------------------------------------------------------------------------
// Floors

const HALL = '#9aa0ab';
const floorTile = (tx, ty) => {
  const ox = tx * T, oy = ty * T;
  const room = roomAt(tx, ty);
  const zone = room ? null : zoneAt(tx, ty);
  const kind = room ? room.floor : (zone ? zone.floor : 'hall');
  if (kind === 'lab') {
    rect(ox, oy, T, T, '#ece4ee');
    rect(ox, oy + T - 1, T, 1, '#d4c6d8'); rect(ox + T - 1, oy, 1, T, '#d4c6d8');
    rect(ox, oy + 7, T, 1, '#e0d5e3'); rect(ox + 7, oy, 1, T, '#e0d5e3');
  } else if (kind === 'wood') {
    rect(ox, oy, T, T, '#b27d4b');
    for (let j = 0; j < T; j += 4) {
      rect(ox, oy + j + 3, T, 1, '#9b6a3e');
      const seam = ((ty * 4 + j / 4) * 7) % T;
      px(ox + seam, oy + j, '#9b6a3e'); px(ox + seam, oy + j + 1, '#9b6a3e'); px(ox + seam, oy + j + 2, '#9b6a3e');
    }
  } else if (kind === 'checker') {
    for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
      rect(ox + i * 8, oy + j * 8, 8, 8, (i + j) % 2 ? '#dcc089' : '#ead4a2');
    }
  } else if (kind === 'lounge') {
    rect(ox, oy, T, T, '#6d5f99');
    for (let j = 1; j < T; j += 4) for (let i = (j % 8 === 1 ? 1 : 3); i < T; i += 4) px(ox + i, oy + j, '#7b6ca8');
  } else if (kind === 'trading') { // dark trading-floor carpet with a fine grid
    rect(ox, oy, T, T, '#1f2d3d');
    rect(ox, oy + 7, T, 1, '#263a50'); rect(ox + 7, oy, 1, T, '#263a50');
    if ((tx + ty) % 3 === 0) px(ox + 11, oy + 3, '#2f4a66');
  } else if (kind === 'crypto') { // dark tech floor with a neon grid
    rect(ox, oy, T, T, '#1c1830');
    rect(ox, oy + T - 1, T, 1, '#3a2d63'); rect(ox + T - 1, oy, 1, T, '#3a2d63');
    if ((tx * 7 + ty * 3) % 5 === 0) px(ox + 8, oy + 8, '#f7931a');
  } else if (kind === 'noc') { // operations: dark raised-floor tiles with cable-trench lines
    rect(ox, oy, T, T, '#10151c');
    rect(ox, oy, T, 1, '#1b2430'); rect(ox, oy, 1, T, '#1b2430');
    rect(ox + 1, oy + 1, T - 1, 1, '#141b24');
    if ((tx * 5 + ty * 3) % 7 === 0) px(ox + 8, oy + 8, '#14b8a6');
  } else if (kind === 'meme') { // war-room floor, dark red with hatching
    rect(ox, oy, T, T, '#2e1a1f');
    for (let i = 0; i < T; i += 4) px(ox + i, oy + ((i + ty * 4) % T), '#43242b');
    rect(ox, oy + T - 1, T, 1, '#3a2027');
  } else if (kind === 'sports') { // turf stripes with a pitch line
    rect(ox, oy, T, T, (tx % 2) ? '#2f7d3b' : '#2a7035');
    if (ty === 21) rect(ox, oy + 7, T, 1, '#d9f2dc');
  } else if (kind === 'marble') { // Grand Hall marble
    for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) rect(ox + i * 8, oy + j * 8, 8, 8, (i + j) % 2 ? '#d3d7de' : '#e3e6eb');
    px(ox + 3, oy + 12, '#c3c8d0'); px(ox + 4, oy + 11, '#c3c8d0'); px(ox + 12, oy + 4, '#c3c8d0');
  } else if (kind === 'exec') { // Oval Office: warm executive parquet
    rect(ox, oy, T, T, '#b8905c');
    for (let j = 0; j < T; j += 4) rect(ox, oy + j, T, 1, '#a57f4f');
    rect(ox + ((ty % 2) ? 5 : 11), oy, 1, T, '#9a7548');
  } else if (kind === 'lift') { // lift shaft: steel floor plates with a centre guide rail
    rect(ox, oy, T, T, '#5b6270');
    rect(ox, oy + T - 1, T, 1, '#4a505c'); rect(ox + 1, oy + 1, T - 2, 1, '#6d7585');
    px(ox + 3, oy + 3, '#8a93a5'); px(ox + 12, oy + 12, '#8a93a5');
  } else {
    rect(ox, oy, T, T, HALL);
    rect(ox, oy + T - 1, T, 1, '#8a909b'); rect(ox + T - 1, oy, 1, T, '#8a909b');
    px(ox + 4, oy + 5, '#a7adb7'); px(ox + 11, oy + 10, '#a7adb7');
  }
};

// ---------------------------------------------------------------------------
// Walls and doors

const WALL_CAP = '#262a35';
const WALL_FACE = '#586176';
const wallTile = (tx, ty) => {
  const ox = tx * T, oy = ty * T;
  const faceDown = !isWall(tx, ty + 1) && ty + 1 < ROWS;
  if (faceDown) {
    rect(ox, oy, T, 4, WALL_CAP);
    rect(ox, oy + 4, T, 12, WALL_FACE);
    rect(ox, oy + 4, T, 1, '#6c768c');
    const room = roomAt(tx, ty + 1);
    if (room) rect(ox, oy + 10, T, 2, shade(room.color, 0.8)); // room-colored stripe
    rect(ox, oy + 14, T, 2, '#3b4152'); // baseboard
  } else {
    rect(ox, oy, T, T, WALL_CAP);
    if (!isWall(tx - 1, ty) && tx > 0) rect(ox, oy, 1, T, '#3a4050');
    if (!isWall(tx + 1, ty) && tx < COLS - 1) rect(ox + T - 1, oy, 1, T, '#3a4050');
    if (!isWall(tx, ty - 1) && ty > 0) rect(ox, oy, T, 1, '#3a4050');
  }
};

const doorTile = (tx, ty) => {
  const ox = tx * T, oy = ty * T;
  if (isWall(tx - 1, ty) || isWall(tx + 1, ty)) { // door in a horizontal wall
    rect(ox, oy, T, 4, WALL_CAP);
    rect(ox, oy + 4, T, 12, WALL_FACE);
    rect(ox + 2, oy + 2, 12, 14, '#3b2a1c');
    rect(ox + 3, oy + 3, 10, 13, '#8a5a32');
    rect(ox + 4, oy + 4, 8, 5, '#9c6a3e');
    rect(ox + 4, oy + 10, 8, 5, '#9c6a3e');
    px(ox + 11, oy + 10, '#e8c55a'); px(ox + 11, oy + 11, '#c9a640');
  } else { // door in a vertical wall, seen from above
    rect(ox, oy, T, T, HALL);
    rect(ox + 5, oy, 6, T, '#3b2a1c');
    rect(ox + 6, oy + 1, 4, T - 2, '#8a5a32');
    rect(ox + 6, oy + 7, 4, 1, '#6e4526');
    px(ox + 9, oy + 10, '#e8c55a');
  }
};

// ---------------------------------------------------------------------------
// Oval Office: executive floor, oval rug and seal (inside a compact rectangular room)

const drawExecutiveRug = (room) => {
  const [x1, y1, x2] = room.rect;
  const cx = ((x1 + x2 + 1) * T) / 2;
  const cy = (y1 + 2) * T + 4;
  const rc = { a: Math.min(40, ((x2 - x1 + 1) * T) / 2 - 20), b: 14 };
  for (let y = cy - rc.b; y <= cy + rc.b; y++) {
    for (let x = cx - rc.a; x <= cx + rc.a; x++) {
      const v = ((x + 0.5 - cx) / rc.a) ** 2 + ((y + 0.5 - cy) / rc.b) ** 2;
      if (v > 1) continue;
      let c = '#1f3a68';
      if (v > 0.84) c = '#c9a227';
      else if (v > 0.74) c = '#274a82';
      else if (v > 0.68) c = '#c9a227';
      px(x, y, c);
    }
  }
  for (let y = -5; y <= 5; y++) for (let x = -5; x <= 5; x++) {
    const r2 = x * x + y * y;
    if (r2 <= 25) px(cx + x, cy + y, r2 >= 16 ? '#e0b83a' : r2 >= 9 ? '#1f3a68' : '#c9a227');
  }
  rect(cx - 2, cy - 1, 4, 2, '#6b4a12'); rect(cx - 1, cy - 2, 2, 4, '#6b4a12');
};

const exteriorTile = (tx, ty) => { // bedrock around the vault (expansion space)
  const ox = tx * T, oy = ty * T;
  rect(ox, oy, T, T, '#2a2420');
  const h = (tx * 73856093) ^ (ty * 19349663);
  for (let k = 0; k < 5; k++) {
    const x = Math.abs((h >> (k * 3)) % 14) + 1, y = Math.abs((h >> (k * 5)) % 14) + 1;
    px(ox + x, oy + y, k % 2 ? '#3a322b' : '#1f1a17');
  }
};

// ---------------------------------------------------------------------------
// Furniture (drawn over the floor)

const shadowBelow = (ox, oy, w, x0 = 1) => rect(ox + x0, oy + T - 1, w, 1, '#000000', 0.18);
const same = (tx, ty, ch) => at(tx, ty) === ch;

// Multi-tile furniture: draw per tile with outer edges where the neighbour differs.
const slab = (tx, ty, ch, top, edge, front) => {
  const ox = tx * T, oy = ty * T;
  const l = !same(tx - 1, ty, ch), r = !same(tx + 1, ty, ch);
  const u = !same(tx, ty - 1, ch), d = !same(tx, ty + 1, ch);
  const x0 = ox + (l ? 1 : 0), x1 = ox + T - (r ? 1 : 0);
  const y0 = oy + (u ? 2 : 0), y1 = oy + T - (d ? 4 : 0);
  rect(x0, y0, x1 - x0, y1 - y0, top);
  if (u) rect(x0, y0, x1 - x0, 1, edge);
  if (l) rect(x0, y0, 1, y1 - y0, edge);
  if (r) rect(x1 - 1, y0, 1, y1 - y0, shade(top, 0.8));
  if (d) {
    rect(x0, y1, x1 - x0, 3, front);
    rect(x0, y1 + 3, x1 - x0, 1, '#000000', 0.2);
  }
};

const monitor = (x, y, screen) => {
  rect(x, y, 7, 5, '#1c2029');
  rect(x + 1, y + 1, 5, 3, screen);
  rect(x + 3, y + 5, 1, 1, '#1c2029');
  rect(x + 2, y + 6, 3, 1, '#1c2029');
};

const drawFurniture = (tx, ty, ch) => {
  const ox = tx * T, oy = ty * T;
  const room = roomAt(tx, ty);
  const first = (c) => !same(tx - 1, ty, c); // left end of a horizontal run
  switch (ch) {
    case 'T': { // review table with drafts
      slab(tx, ty, 'T', '#8b5e3a', shade('#8b5e3a', 1.25), shade('#8b5e3a', 0.7));
      if ((tx + ty) % 2 === 0) {
        rect(ox + 3, oy + 5, 6, 7, '#f4f1e8'); rect(ox + 4, oy + 7, 4, 1, '#b9b3a3'); rect(ox + 4, oy + 9, 3, 1, '#d9534f');
      } else {
        rect(ox + 6, oy + 4, 5, 7, '#f4f1e8'); rect(ox + 7, oy + 6, 3, 1, '#b9b3a3'); px(ox + 9, oy + 9, '#2e9e5b');
      }
      break;
    }
    case 'k': { // computer desk
      slab(tx, ty, 'k', '#9a7550', '#b48d65', '#6e5236');
      monitor(ox + 4, oy + 2, ({ lab: '#f59ac8', crypto: '#f7931a', sports: '#5fd8ee' })[room && room.floor] || '#7fc8f8');
      rect(ox + 3, oy + 10, 8, 1, '#3a3f4b');
      px(ox + 12, oy + 10, '#3a3f4b');
      break;
    }
    case 'w': { // writing desk
      slab(tx, ty, 'w', '#a8743f', '#c28c55', '#7a5230');
      if (first('w')) {
        rect(ox + 3, oy + 2, 3, 2, '#2f8f6a'); rect(ox + 4, oy + 4, 1, 4, '#3a3f4b'); rect(ox + 3, oy + 8, 3, 1, '#3a3f4b');
        rect(ox + 8, oy + 5, 6, 7, '#f7f3e8'); rect(ox + 9, oy + 7, 4, 1, '#b8b09c'); rect(ox + 9, oy + 9, 4, 1, '#b8b09c');
      } else {
        rect(ox + 2, oy + 3, 8, 5, '#2b303b'); rect(ox + 3, oy + 4, 6, 3, '#9fe0c4'); rect(ox + 1, oy + 8, 10, 3, '#4a5160');
        rect(ox + 12, oy + 5, 2, 3, '#e9edf5'); px(ox + 14, oy + 6, '#e9edf5');
      }
      break;
    }
    case 'L': { // lab bench
      slab(tx, ty, 'L', '#dfe4ea', '#f4f6f9', '#a9b1bd');
      if ((tx % 2) === 0) {
        rect(ox + 5, oy + 9, 6, 2, '#3a3f4b'); rect(ox + 7, oy + 3, 2, 6, '#3a3f4b'); rect(ox + 6, oy + 2, 3, 2, '#596175'); px(ox + 9, oy + 7, '#ec4899');
      } else {
        rect(ox + 3, oy + 5, 3, 6, '#cfe9f5'); rect(ox + 3, oy + 8, 3, 3, '#ec4899');
        rect(ox + 9, oy + 3, 2, 3, '#cfe9f5'); rect(ox + 8, oy + 6, 4, 5, '#cfe9f5'); rect(ox + 8, oy + 8, 4, 3, '#39d98a');
      }
      break;
    }
    case 'B': { // bookshelf
      rect(ox + 1, oy, 14, 15, '#5b3a22');
      rect(ox + 2, oy + 1, 12, 13, '#3d2716');
      const spines = ['#d9534f', '#3b82f6', '#f0c24b', '#2e9e5b', '#8b5cf6', '#ec4899', '#e9edf5'];
      for (let shelf = 0; shelf < 3; shelf++) {
        const sy = oy + 1 + shelf * 5;
        rect(ox + 2, sy + 4, 12, 1, '#5b3a22');
        for (let b = 0; b < 5; b++) {
          const h = 3 + ((tx + ty + b + shelf) % 2);
          rect(ox + 2 + b * 2 + (b > 2 ? 1 : 0), sy + 4 - h, 2, h, spines[(tx * 3 + ty + b + shelf * 2) % spines.length]);
        }
      }
      shadowBelow(ox, oy, 14);
      break;
    }
    case 'W': { // standing whiteboard
      const l = first('W'), r = !same(tx + 1, ty, 'W');
      const x0 = ox + (l ? 1 : 0), x1 = ox + T - (r ? 1 : 0);
      rect(x0, oy + 1, x1 - x0, 11, '#c9ced8');
      rect(x0 + (l ? 1 : 0), oy + 2, x1 - x0 - (l ? 1 : 0) - (r ? 1 : 0), 9, '#fbfcfe');
      if (l) { rect(ox + 3, oy + 4, 8, 1, '#3b82f6'); rect(ox + 3, oy + 7, 5, 1, '#d9534f'); rect(ox + 4, oy + 12, 1, 3, '#7a8190'); }
      else { rect(ox + 2, oy + 4, 3, 3, '#2e9e5b'); rect(ox + 7, oy + 5, 5, 1, '#3b82f6'); rect(ox + 7, oy + 8, 4, 1, '#ec4899'); rect(ox + 11, oy + 12, 1, 3, '#7a8190'); }
      break;
    }
    case 'F': { // filing cabinet
      rect(ox + 3, oy + 1, 10, 14, '#8d96a3');
      rect(ox + 3, oy + 1, 10, 1, '#a9b1bd');
      for (let d = 0; d < 3; d++) {
        rect(ox + 4, oy + 3 + d * 4, 8, 3, '#7b8391');
        rect(ox + 7, oy + 4 + d * 4, 2, 1, '#d7dbe2');
      }
      shadowBelow(ox, oy, 10, 3);
      break;
    }
    case 'P': { // potted plant
      rect(ox + 5, oy + 10, 6, 5, '#a0522d'); rect(ox + 5, oy + 10, 6, 1, '#b8653a');
      rect(ox + 4, oy + 4, 8, 6, '#2e7d3e'); rect(ox + 6, oy + 2, 4, 3, '#3c9d4e');
      rect(ox + 3, oy + 6, 2, 3, '#3c9d4e'); rect(ox + 11, oy + 5, 2, 3, '#3c9d4e');
      px(ox + 7, oy + 5, '#5cc46d'); px(ox + 9, oy + 7, '#5cc46d');
      shadowBelow(ox, oy, 6, 5);
      break;
    }
    // --- Oval Office -------------------------------------------------------
    case 'X': { // executive desk (dark carved wood, gold trim)
      slab(tx, ty, 'X', '#5a3620', '#7a4b2c', '#3e2414');
      const l = first('X');
      rect(ox + (l ? 1 : 0), oy + 12, T - 1, 1, '#c9a227'); // gold trim on the front
      if (l) {
        rect(ox + 4, oy + 12, 5, 3, '#4a2c17'); rect(ox + 5, oy + 13, 3, 1, '#c9a227'); // carved panel
        rect(ox + 3, oy + 2, 3, 2, '#2e7d3e'); rect(ox + 4, oy + 4, 1, 3, '#c9a227'); rect(ox + 3, oy + 7, 3, 1, '#c9a227'); // banker's lamp
        rect(ox + 8, oy + 4, 6, 5, '#f4f1e8'); rect(ox + 9, oy + 6, 4, 1, '#b9b3a3'); // briefing papers
      } else {
        rect(ox + 7, oy + 12, 5, 3, '#4a2c17'); rect(ox + 8, oy + 13, 3, 1, '#c9a227');
        rect(ox + 3, oy + 4, 4, 3, '#1c2029'); px(ox + 4, oy + 5, '#9e2b2b');               // phone
        rect(ox + 9, oy + 3, 4, 2, '#c9a227'); px(ox + 10, oy + 2, '#1c2029'); px(ox + 12, oy + 2, '#1c2029'); // pen set
      }
      break;
    }
    case 'f': { // flag stand
      if (first('f')) {
        // Finnish national flag, 13 x 8 art px (8:13 = 0.615 ~ official 11:18 = 0.611).
        // Pole moved to the hoist side of the same tile so the fly fits inside the tile.
        // Cross, scaled from the official 5+3+10 (width) and 4+3+4 (height): 4+2+7 and 3+2+3.
        rect(ox + 2, oy + 1, 1, 15, '#c9a227'); px(ox + 2, oy, '#f0d060');
        rect(ox + 0, oy + 15, 5, 1, '#6b4a12');
        rect(ox + 3, oy + 2, 13, 8, '#f7f7f4');     // white field
        rect(ox + 7, oy + 2, 2, 8, '#003580');      // vertical bar: 4 | 2 | 7
        rect(ox + 3, oy + 5, 13, 2, '#003580');     // horizontal bar: 3 | 2 | 3
        break;
      }
      rect(ox + 7, oy + 1, 1, 15, '#c9a227'); px(ox + 7, oy, '#f0d060');
      rect(ox + 5, oy + 15, 5, 1, '#6b4a12');
      { // navy standard
        rect(ox + 8, oy + 2, 7, 8, '#1f3a68'); rect(ox + 8, oy + 10, 7, 1, '#c9a227');
        rect(ox + 10, oy + 4, 3, 3, '#c9a227');
      }
      break;
    }
    case 'l': { // side table with lamp
      rect(ox + 4, oy + 8, 8, 6, '#5a3620'); rect(ox + 4, oy + 8, 8, 1, '#7a4b2c'); rect(ox + 4, oy + 14, 8, 1, '#3e2414');
      rect(ox + 7, oy + 5, 2, 3, '#c9a227');
      rect(ox + 5, oy + 1, 6, 4, '#f7ecc8'); rect(ox + 5, oy + 4, 6, 1, '#e0cf9a');
      px(ox + 8, oy + 6, '#fff6d0', 0.8);
      shadowBelow(ox, oy, 8, 4);
      break;
    }
    case 'K': { // coffee table
      const oval = room && room.oval;
      slab(tx, ty, 'K', oval ? '#5a3620' : '#c49a6c', oval ? '#7a4b2c' : '#d8b48a', oval ? '#3e2414' : '#9a7550');
      if (oval) {
        if (first('K')) { rect(ox + 8, oy + 5, 6, 4, '#c9a227'); rect(ox + 9, oy + 6, 4, 2, '#e9a13b'); } // fruit bowl
        else { rect(ox + 2, oy + 4, 5, 6, '#f4f1e8'); rect(ox + 3, oy + 6, 3, 1, '#1f3a68'); } // briefing folder
      } else if (first('K')) {
        rect(ox + 4, oy + 5, 3, 3, '#f4f1e8'); px(ox + 5, oy + 6, '#6b3e1f'); rect(ox + 9, oy + 4, 5, 6, '#e07a5f'); // mug + magazine
      } else {
        rect(ox + 3, oy + 5, 6, 4, '#3a3f4b'); rect(ox + 4, oy + 6, 1, 1, '#5fd0ff'); rect(ox + 10, oy + 5, 3, 3, '#f4f1e8'); // controller + mug
      }
      break;
    }
    // --- Hangout -----------------------------------------------------------
    case 'M': { // TV on a low cabinet
      const l = first('M');
      rect(ox, oy + 11, T, 4, '#4a3b2f'); rect(ox, oy + 11, T, 1, '#5e4b3c');
      rect(ox + (l ? 2 : 0), oy + 1, T - 2, 9, '#15171d');
      rect(ox + (l ? 3 : 0), oy + 2, T - 3, 7, l ? '#3aa0d8' : '#3aa0d8');
      if (l) { rect(ox + 5, oy + 5, 6, 4, '#57c46d'); rect(ox + 8, oy + 3, 3, 2, '#ffe27a'); }
      else { rect(ox + 1, oy + 6, 8, 3, '#57c46d'); rect(ox + 4, oy + 4, 2, 2, '#ff6b8b'); }
      break;
    }
    case 'A': { // arcade cabinet
      rect(ox + 2, oy, 12, 15, tx % 2 ? '#4b3fa0' : '#a0326e');
      rect(ox + 3, oy + 1, 10, 2, '#ffd23f');
      rect(ox + 4, oy + 4, 8, 6, '#101318'); rect(ox + 5, oy + 5, 6, 4, tx % 2 ? '#39d98a' : '#5fd0ff');
      rect(ox + 3, oy + 11, 10, 2, '#2a2e38'); px(ox + 5, oy + 10, '#d9534f'); px(ox + 9, oy + 11, '#ffd23f'); px(ox + 11, oy + 11, '#5fd0ff');
      shadowBelow(ox, oy, 12, 2);
      break;
    }
    case 'C': { // coffee bar
      slab(tx, ty, 'C', '#8a6a4a', '#a3825e', '#5e4632');
      if (first('C')) { // espresso machine
        rect(ox + 3, oy + 1, 9, 9, '#c9ced8'); rect(ox + 4, oy + 2, 7, 3, '#8d96a3'); rect(ox + 6, oy + 6, 3, 2, '#2a2e38'); px(ox + 10, oy + 3, '#39d98a');
      } else { // cups and pastries
        rect(ox + 2, oy + 4, 3, 3, '#f4f1e8'); rect(ox + 6, oy + 4, 3, 3, '#f4f1e8'); rect(ox + 10, oy + 5, 4, 3, '#e9a13b');
      }
      break;
    }
    // --- Markets / Grand Hall ---------------------------------------------
    case 'Y': { // wall screen with a live chart (continuous across the run)
      const l = first('Y'), r = !same(tx + 1, ty, 'Y');
      const kind = room ? room.floor : 'marble';
      const bg = ({ trading: '#0c2218', meme: '#26090d', marble: '#0f1f3a' })[kind] || '#101318';
      rect(ox, oy + 1, T, 11, '#141821');
      rect(ox + (l ? 1 : 0), oy + 2, T - (l ? 1 : 0) - (r ? 1 : 0), 9, bg);
      for (let i = 0; i < T; i++) {
        const gx = ox + i;
        if ((l && i === 0) || (r && i === T - 1)) continue;
        if (kind === 'marble') { // world map with status dots
          if (Math.sin(gx * 0.35) + Math.cos(gx * 0.11) > 0.4) rect(gx, oy + 4 + (gx % 3), 1, 3, '#2e7d4f');
          if (gx % 11 === 0) px(gx, oy + 5, '#f0d060');
        } else { // price line + candles
          const v = Math.round(5 + 3 * Math.sin(gx * 0.21) + (kind === 'meme' ? 2 * Math.sin(gx * 0.9) : Math.cos(gx * 0.07)));
          const y = oy + 2 + Math.max(0, Math.min(8, 9 - v));
          px(gx, y, kind === 'meme' ? '#ff5d73' : '#39d98a');
          if (gx % 3 === 0) rect(gx, y + 1, 1, 2, (gx % 6 === 0) ? '#39d98a' : '#ff5d73');
        }
      }
      rect(ox, oy + 12, T, 1, '#000000', 0.25);
      break;
    }
    case 'Z': { // trading desk with two chart monitors
      slab(tx, ty, 'Z', '#2b2f3a', '#3a3f4b', '#1c1f27');
      for (const mx of [2, 9]) {
        rect(ox + mx, oy + 2, 6, 5, '#101318');
        for (let i = 0; i < 4; i++) rect(ox + mx + 1 + i, oy + 3 + ((tx + i) % 3), 1, 2, i % 2 ? '#ff5d73' : '#39d98a');
      }
      rect(ox + 4, oy + 9, 8, 1, '#4a5160');
      break;
    }
    case 'Q': { // crypto rig / server rack
      rect(ox + 2, oy, 12, 15, '#1b1d26'); rect(ox + 2, oy, 12, 1, '#2c2f3b');
      for (let j = 0; j < 4; j++) {
        rect(ox + 3, oy + 2 + j * 3, 10, 2, '#262a35');
        px(ox + 4, oy + 2 + j * 3, (tx + j) % 2 ? '#f7931a' : '#39d98a');
        px(ox + 6, oy + 2 + j * 3, '#5fd0ff');
      }
      shadowBelow(ox, oy, 12, 2);
      break;
    }
    case 'H': { // war table with a market map
      slab(tx, ty, 'H', '#4a1d22', '#6b2a30', '#2e1114');
      rect(ox + (first('H') ? 3 : 0), oy + 4, T - (first('H') ? 3 : 0) - (!same(tx + 1, ty, 'H') ? 3 : 0), 8, '#1f3b2a');
      px(ox + 5, oy + 6, '#ff5d73'); px(ox + 11, oy + 9, '#39d98a'); px(ox + 8, oy + 5, '#ffd23f');
      break;
    }
    case 'J': { // sports scoreboard screen
      const l = first('J'), r = !same(tx + 1, ty, 'J');
      rect(ox, oy + 1, T, 11, '#141821');
      rect(ox + (l ? 1 : 0), oy + 2, T - (l ? 1 : 0) - (r ? 1 : 0), 9, '#0b1f24');
      if (tx % 2 === 0) { text('2', ox + 3, oy + 4, '#5fd8ee'); text('1', ox + 10, oy + 4, '#ffd23f'); }
      else { rect(ox + 2, oy + 4, 12, 5, '#1d5a2c'); rect(ox + 7, oy + 4, 1, 5, '#d9f2dc'); rect(ox + 2, oy + 4, 12, 1, '#d9f2dc'); }
      rect(ox, oy + 12, T, 1, '#000000', 0.25);
      break;
    }
    case 'V': { // operations status wall: service tiles with health lights (continuous run)
      const l = first('V'), r = !same(tx + 1, ty, 'V');
      rect(ox, oy + 1, T, 11, '#0b0f14');
      rect(ox + (l ? 1 : 0), oy + 2, T - (l ? 1 : 0) - (r ? 1 : 0), 9, '#07131a');
      const health = ['#39d98a', '#39d98a', '#39d98a', '#f5c542', '#39d98a', '#ff5d73'];
      for (let k = 0; k < 2; k++) {
        const bx = ox + 2 + k * 7;
        if ((l && k === 0 && bx < ox + 2) || (r && bx + 5 > ox + T - 1)) continue;
        rect(bx, oy + 3, 5, 3, '#10303a');
        px(bx + 1, oy + 4, health[(tx * 2 + k) % health.length]);
        rect(bx + 2, oy + 4, 2, 1, '#5fd0ff');
        rect(bx, oy + 7, 5, 1, '#10303a');
        rect(bx, oy + 8, 1 + ((tx + k) % 5), 1, '#14b8a6');
      }
      rect(ox, oy + 12, T, 1, '#000000', 0.3);
      break;
    }
    case 'R': { // server rack with blinking status LEDs
      rect(ox + 3, oy, 10, 15, '#0d1117'); rect(ox + 3, oy, 10, 1, '#262c36');
      rect(ox + 3, oy, 1, 15, '#1c222b'); rect(ox + 12, oy, 1, 15, '#1c222b');
      for (let j = 0; j < 5; j++) {
        rect(ox + 4, oy + 2 + j * 2 + (j > 2 ? 1 : 0), 8, 1, '#1f2630');
        px(ox + 5, oy + 2 + j * 2 + (j > 2 ? 1 : 0), (tx + ty + j) % 4 === 0 ? '#f5c542' : '#39d98a');
        px(ox + 7, oy + 2 + j * 2 + (j > 2 ? 1 : 0), '#5fd0ff');
      }
      shadowBelow(ox, oy, 10, 3);
      break;
    }
    case 'N': { // NOC console: dark desk with two health monitors
      slab(tx, ty, 'N', '#1e2530', '#2b3442', '#141a22');
      rect(ox + 2, oy + 2, 6, 5, '#070b10'); rect(ox + 3, oy + 3, 4, 3, '#0f2a2e');
      px(ox + 4, oy + 4, '#39d98a'); px(ox + 5, oy + 4, '#39d98a'); px(ox + 6, oy + 5, (tx % 3 === 0) ? '#f5c542' : '#39d98a');
      rect(ox + 9, oy + 2, 5, 5, '#070b10'); rect(ox + 10, oy + 3, 3, 3, '#0e2233');
      rect(ox + 10, oy + 5, 3, 1, '#5fd0ff');
      rect(ox + 4, oy + 9, 8, 1, '#3a4452');
      break;
    }
    case 'U': { // achievement wall plaque frame (unlocks are drawn by the UI from verified data)
      rect(ox + 2, oy + 1, 12, 11, '#3b2a12');
      rect(ox + 3, oy + 2, 10, 9, '#1b1f29');
      rect(ox + 2, oy + 1, 12, 1, '#c9a227'); rect(ox + 2, oy + 11, 12, 1, '#8a6a1a');
      rect(ox + 7, oy + 5, 2, 3, '#2d3340');
      rect(ox, oy + 12, T, 1, '#000000', 0.25);
      break;
    }
    case 'I': { // trophy pedestal (empty until an achievement is verified)
      rect(ox + 4, oy + 9, 8, 6, '#d9d4c7'); rect(ox + 4, oy + 9, 8, 1, '#f1ede3'); rect(ox + 4, oy + 14, 8, 1, '#a9a393');
      rect(ox + 6, oy + 5, 4, 4, '#2d3340'); rect(ox + 7, oy + 4, 2, 1, '#3a4150');
      shadowBelow(ox, oy, 10, 3);
      break;
    }
    case 'G': { // strategy map table (Grand Hall)
      slab(tx, ty, 'G', '#6b4a2a', '#8a6238', '#4a321c');
      rect(ox + (first('G') ? 3 : 0), oy + 4, T - (first('G') ? 3 : 0) - (!same(tx + 1, ty, 'G') ? 3 : 0), 8, '#2d5d8c');
      rect(ox + 5, oy + 6, 4, 3, '#3c8d4e'); rect(ox + 10, oy + 8, 3, 2, '#3c8d4e');
      px(ox + 6, oy + 7, '#ff5d73'); px(ox + 11, oy + 8, '#5fd0ff');
      break;
    }
    default:
      break;
  }
};

// Rug (non-oval rooms): walkable decor with a border.
const rugTile = (tx, ty) => {
  const ox = tx * T, oy = ty * T;
  const l = !same(tx - 1, ty, 'r'), r = !same(tx + 1, ty, 'r');
  const u = !same(tx, ty - 1, 'r'), d = !same(tx, ty + 1, 'r');
  rect(ox + (l ? 2 : 0), oy + (u ? 2 : 0), T - (l ? 2 : 0) - (r ? 2 : 0), T - (u ? 2 : 0) - (d ? 2 : 0), '#2f8f6a');
};

// Seats
const chairTile = (tx, ty) => {
  const ox = tx * T, oy = ty * T;
  const room = roomAt(tx, ty);
  const base = room ? room.color : '#555c6b';
  const deskAbove = FURNITURE.has(at(tx, ty - 1));
  rect(ox + 7, oy + 11, 2, 3, '#2a2e38'); rect(ox + 4, oy + 14, 8, 1, '#2a2e38');
  rect(ox + 3, oy + 6, 10, 6, shade(base, 0.75));
  rect(ox + 3, oy + 6, 10, 1, shade(base, 0.95));
  if (deskAbove) rect(ox + 3, oy + 11, 10, 3, shade(base, 0.55));
  else rect(ox + 3, oy + 2, 10, 4, shade(base, 0.55));
};

const execChair = (tx, ty) => { // tall leather chair; backrest away from the desk below
  const ox = tx * T, oy = ty * T;
  rect(ox + 7, oy + 13, 2, 2, '#2a2e38'); rect(ox + 4, oy + 15, 8, 1, '#2a2e38');
  rect(ox + 3, oy + 1, 10, 8, '#3a2418'); rect(ox + 4, oy + 2, 8, 6, '#4e3020');
  rect(ox + 5, oy + 3, 1, 4, '#6b4430'); rect(ox + 10, oy + 3, 1, 4, '#6b4430');
  rect(ox + 2, oy + 8, 12, 5, '#4e3020'); rect(ox + 2, oy + 8, 12, 1, '#6b4430');
  rect(ox + 1, oy + 7, 2, 5, '#3a2418'); rect(ox + 13, oy + 7, 2, 5, '#3a2418');
};

const sofaSeat = (tx, ty, dir, ch, body, back) => {
  const ox = tx * T, oy = ty * T;
  if (dir === 'down') { // backrest above (seat faces down)
    const l = !same(tx - 1, ty, ch), r = !same(tx + 1, ty, ch);
    rect(ox, oy + 4, T, 8, body);
    rect(ox, oy + 1, T, 4, back);
    if (l) rect(ox + 1, oy + 1, 3, 12, back);
    if (r) rect(ox + T - 4, oy + 1, 3, 12, back);
    rect(ox + (l ? 4 : 0), oy + 10, T - (l ? 4 : 0) - (r ? 4 : 0), 1, shade(body, 0.85));
    shadowBelow(ox, oy, T - 2);
  } else if (dir === 'up') { // backrest below (seat faces up)
    const l = !same(tx - 1, ty, ch), r = !same(tx + 1, ty, ch);
    rect(ox, oy + 4, T, 8, body);
    rect(ox, oy + 11, T, 4, back);
    if (l) rect(ox + 1, oy + 3, 3, 12, back);
    if (r) rect(ox + T - 4, oy + 3, 3, 12, back);
    rect(ox + (l ? 4 : 0), oy + 5, T - (l ? 4 : 0) - (r ? 4 : 0), 1, shade(typeof body === 'string' ? body : '#888888', 1.2));
    if (!l) rect(ox, oy + 5, 1, 6, back);
    shadowBelow(ox, oy, T - 2);
  } else { // vertical sofa: 'right' faces right (backrest left), 'left' faces left
    const u = !same(tx, ty - 1, ch), d = !same(tx, ty + 1, ch);
    const backX = dir === 'right' ? ox + 2 : ox + T - 6;
    const seatX = dir === 'right' ? ox + 6 : ox + 2;
    rect(seatX, oy, 8, T, body);
    for (let j = 1; j < T; j += 3) rect(seatX, oy + j, 8, 1, '#e9dcb4'); // stripes
    rect(backX, oy, 4, T, back);
    if (u) rect(ox + 2, oy + 1, 12, 3, back);
    if (d) rect(ox + 2, oy + T - 3, 12, 3, back);
    if (!u) rect(seatX, oy, 8, 1, '#c9b27a');
  }
};

const loungeChair = (tx, ty) => { // round bean-bag style
  const ox = tx * T, oy = ty * T;
  for (let y = 0; y < 12; y++) for (let x = 0; x < 12; x++) {
    const v = ((x - 5.5) / 6) ** 2 + ((y - 5.5) / 6) ** 2;
    if (v <= 1) px(ox + 2 + x, oy + 3 + y, v > 0.6 ? '#c2573f' : '#e07a5f');
  }
  rect(ox + 5, oy + 6, 4, 2, '#f2a58c');
  shadowBelow(ox, oy, 10, 3);
};

// Room name plates.
const plate = (label, cx, y, color) => {
  const w = textWidth(label) + 6;
  const sx = Math.round(cx - w / 2);
  rect(sx - 1, y - 1, w + 2, 11, '#1b1f29');
  rect(sx, y, w, 9, shade(color, 0.7));
  rect(sx, y, w, 1, shade(color, 1.2));
  text(label, sx + 3, y + 2, '#ffffff');
};
const sign = (room) => {
  const [x1, y, x2] = room.sign;
  plate(room.label || room.name.toUpperCase(), (x1 * T + (x2 + 1) * T) / 2, y * T + 3, room.oval ? '#1f3a68' : room.color);
};

// ---------------------------------------------------------------------------
// Render

for (let ty = 0; ty < ROWS; ty++) {
  for (let tx = 0; tx < COLS; tx++) {
    const ch = at(tx, ty);
    if (ch === '#') wallTile(tx, ty);
    else if (ch === '~') exteriorTile(tx, ty);
    else if (ch === 'D') doorTile(tx, ty);
    else floorTile(tx, ty);
  }
}
ROOMS.filter((r) => r.oval).forEach(drawExecutiveRug);
for (let ty = 0; ty < ROWS; ty++) {
  for (let tx = 0; tx < COLS; tx++) {
    const ch = at(tx, ty);
    const room = roomAt(tx, ty);
    if (ch === 'r' && !(room && room.oval)) rugTile(tx, ty);
    else if (ch === 'c') chairTile(tx, ty);
    else if (ch === 'E') execChair(tx, ty);
    else if (ch === 'q') sofaSeat(tx, ty, 'right', 'q', '#efe3c2', '#c9b27a');
    else if (ch === 'p') sofaSeat(tx, ty, 'left', 'p', '#efe3c2', '#c9b27a');
    else if (ch === 's') sofaSeat(tx, ty, 'up', 's', '#e07a5f', '#b85a42');
    else if (ch === 't') sofaSeat(tx, ty, 'down', 't', '#e07a5f', '#b85a42');
    else if (ch === 'u') loungeChair(tx, ty);
    else if (FURNITURE.has(ch)) drawFurniture(tx, ty, ch);
  }
}
ROOMS.forEach(sign);

// ---------------------------------------------------------------------------
// PNG encoding (RGBA, nearest-neighbour upscale)

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b) => {
  let c = 0xffffffff;
  for (const v of b) c = CRC_TABLE[(c ^ v) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
const encodePNG = (src, w, h, scale) => {
  const ow = w * scale, oh = h * scale;
  const raw = Buffer.alloc((ow * 4 + 1) * oh);
  for (let y = 0; y < oh; y++) {
    raw[y * (ow * 4 + 1)] = 0;
    for (let x = 0; x < ow; x++) {
      const si = (Math.floor(y / scale) * w + Math.floor(x / scale)) * 4;
      src.copy(raw, y * (ow * 4 + 1) + 1 + x * 4, si, si + 4);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(ow, 0); ihdr.writeUInt32BE(oh, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
};

// ---------------------------------------------------------------------------
// Targets, agents and UI anchors: validate, then write outputs

const rooms = ROOMS.map(r => ({ id: r.id, name: r.name, color: r.color, tiles: roomTiles(r) }));
const roomByKey = (k) => { const r = ROOMS.find((x) => x.key === k); if (!r) throw new Error(`unknown room ${k}`); return r; };
const abs = (key, [i, j]) => { const r = roomByKey(key); return { x: r.rect[0] + i, y: r.rect[1] + j }; };
const inRect = (t, r) => t.x >= r.rect[0] && t.x <= r.rect[2] && t.y >= r.rect[1] && t.y <= r.rect[3];
const seatOrFloor = (t) => collision[t.y][t.x] === 0 || collision[t.y][t.x] === 3;

const ids = new Set(); const slots = new Set(); const seatsTaken = new Set();
for (const a of SPEC.agents) {
  if (!/^[a-z][a-z0-9_]*$/.test(a.id) || ids.has(a.id)) throw new Error(`agent id invalid/duplicate: ${a.id}`);
  if (!Number.isInteger(a.slot) || a.slot < 0 || slots.has(a.slot)) throw new Error(`agent slot invalid/duplicate: ${a.id}`);
  ids.add(a.id); slots.add(a.slot);
  const t = abs(a.room, a.seat);
  if (!seatOrFloor(t) || !inRect(t, roomByKey(a.room))) throw new Error(`seat for ${a.id} is not a free tile in ${a.room}`);
  const k = `${t.x},${t.y}`;
  if (seatsTaken.has(k)) throw new Error(`seat ${k} assigned twice (${a.id})`);
  seatsTaken.add(k);
  if (a.parent && !SPEC.agents.some((p) => p.id === a.parent && p.room === a.room)) throw new Error(`${a.id}: parent must exist in the same room`);
}
const enabled = SPEC.agents.filter((a) => a.enabled);
const WORK_TARGETS = Object.fromEntries(SPEC.agents.map((a) => [a.id, { ...abs(a.room, a.seat), room: roomByKey(a.room).name }]));
const idleRoom = roomByKey(SPEC.idle_room);
const IDLE_TARGETS = [];
roomTiles(idleRoom).forEach((t) => { if (collision[t.y][t.x] === 3) IDLE_TARGETS.push({ x: t.x, y: t.y }); });
const IDLE_OVERRIDES = Object.fromEntries(SPEC.agents.filter((a) => a.idle === 'work').map((a) => [a.id, WORK_TARGETS[a.id]]));
const AGENT_ORDER = enabled.map((a) => a.id);
const spawns = Object.fromEntries(AGENT_ORDER.map((id, i) => {
  const t = IDLE_OVERRIDES[id] || IDLE_TARGETS[i] || WORK_TARGETS[id];
  return [id, { x: t.x, y: t.y }];
}));
const leverTile = abs(SPEC.ui.lever.room, SPEC.ui.lever.at);
if (collision[leverTile.y][leverTile.x] !== 0) throw new Error('lever tile must be free floor');
const plaqueRoom = roomByKey(SPEC.ui.plaques.room);
const plaques = roomTiles(plaqueRoom).filter((t) => at(t.x, t.y) === SPEC.ui.plaques.char).map((t) => ({ x: t.x, y: t.y }));

const root = path.join(__dirname, '..');
const json = JSON.stringify({
  cols: COLS,
  rows: ROWS,
  tile: TILE,
  collision,
  rooms,
  targets: { work: WORK_TARGETS, idle: IDLE_TARGETS, idleRoom: idleRoom.name, idleOverrides: IDLE_OVERRIDES, agentOrder: AGENT_ORDER },
  spawns,
  agents: SPEC.agents.map((a) => ({ id: a.id, name: a.name, role: a.role, color: a.slot, room: roomByKey(a.room).name, parent: a.parent || null, enabled: !!a.enabled })),
  ui: { lever: leverTile, plaques, shaft: { x: SHAFT_X, width: SW } }
}, null, 2)
  .replace(/\[\s+((?:\d+,\s*)*\d+)\s+\]/g, (m, inner) => `[${inner.replace(/\s+/g, '')}]`)
  .replace(/\{\s+"x": (\d+),\s+"y": (\d+)\s+\}/g, '{ "x": $1, "y": $2 }');

fs.writeFileSync(path.join(root, 'assets', 'office-openclaw.png'), encodePNG(buf, W, H, SCALE));
fs.writeFileSync(path.join(root, 'assets', 'office-layout.json'), json + '\n');
console.log(`wrote assets/office-openclaw.png (${W * SCALE}x${H * SCALE}) and assets/office-layout.json`);
console.log(`${ROOMS.length} rooms on ${SPEC.floors.length} floors, ${enabled.length}/${SPEC.agents.length} agents enabled, ${IDLE_TARGETS.length} idle seats, ${plaques.length} plaques`);
