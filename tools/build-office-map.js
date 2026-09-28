#!/usr/bin/env node
// Generates the OpenClaw office map: original pixel art (no third-party tiles),
// plus the matching collision grid, room tiles and agent targets, from one ASCII layout.
//
//   node tools/build-office-map.js
//
// Outputs:
//   assets/office-openclaw.png   640x800 background (20x25 tiles of 32px, drawn at 16px and scaled 2x)
//   assets/office-layout.json    { cols, rows, tile, collision, rooms, targets, spawns }
//
// Collision codes match index.html: 0 floor, 1 wall/furniture, 2 door, 3 chair/seat.
//
// Plan:              Research Lab
//                         |
//   Review Room --  OVAL OFFICE  -- Writing Studio
//                  (Command Center)
//                         |
//                    Hangout Room
// A hallway ring surrounds the Oval Office, whose centre is the exact map centre.

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------------------------------------------------------------------------
// Layout (20 x 25). Legend:
//   #  wall             D  door              .  floor            o  Oval Office wall (curved)
//   r  rug (walkable)   c  chair             T  table            k  computer desk
//   w  writing desk     L  lab bench         B  bookshelf        W  whiteboard
//   F  filing cabinet   P  plant
//   Oval Office:  X executive desk   E executive chair   f flag   l lamp table
//                 q sofa seat (faces right)   p sofa seat (faces left)   K coffee table
//   Hangout:      s sofa seat (faces up)   u lounge chair   M TV   A arcade   C coffee bar
const LAYOUT = [
  '####################', // 0
  '####################', // 1  Research Lab back wall
  '#BBB.WWPLLLL.WW.BBB#', // 2
  '#.kk..LL.kk..LL.kk.#', // 3
  '#..c..c..c....c.c..#', // 4
  '#P................P#', // 5
  '#########DD#########', // 6
  '#FF.#..........#.BB#', // 7  hallway ring (top)
  '#...#.PooooooP.#...#', // 8
  '#kk.#.oooffooo.#.ww#', // 9
  '#c..#.oo.El.oo.#.c.#', // 10
  '#...D.D..XX..D.D...#', // 11 Review -- Oval Office -- Writing
  '#TT.#.oqrrrrpo.#.ww#', // 12 map centre row
  '#TT.#.oqrKKrpo.#.c.#', // 13
  '#c..#.oolrrloo.#...#', // 14
  '#...#.ooo..ooo.#..B#', // 15
  '#WW.#.PooDDooP.#...#', // 16
  '#P..#..........#..P#', // 17 hallway ring (bottom)
  '#########DD#########', // 18 Hangout Room back wall
  '#P.MM........AA.CCP#', // 19
  '#..KK..............#', // 20
  '#.ssss.......uKu...#', // 21
  '#.............u...P#', // 22
  '#B......ssss......B#', // 23
  '####################'  // 24
];

const COLS = 20;
const ROWS = 25;
const TILE = 32; // on-screen tile size
const T = 16;    // art tile size (scaled 2x)
const SCALE = TILE / T;

// Oval Office ellipse in art pixels: centred on the map (320x400 on screen).
const OVAL = { cx: COLS * T / 2, cy: ROWS * T / 2, a: 64, b: 72, ring: 7 };

// Room regions and colors (colors match the dashboard room palette).
const ROOMS = [
  { id: 1, name: 'Command Center', color: '#c9a227', oval: true, floor: 'oval' },
  { id: 2, name: 'Research Lab', color: '#ec4899', rect: [1, 2, 18, 5], sign: [1, 1, 18], floor: 'lab' },
  { id: 3, name: 'Writing Studio', color: '#10b981', rect: [16, 7, 18, 17], sign: [15, 6, 18], floor: 'wood' },
  { id: 4, name: 'Review Room', color: '#f59e0b', rect: [1, 7, 3, 17], sign: [0, 6, 4], floor: 'checker' },
  { id: 5, name: 'Hangout Room', color: '#8b5cf6', rect: [1, 19, 18, 23], sign: [1, 18, 8], floor: 'lounge' }
];

// Deterministic agent destinations (tile coordinates).
const WORK_TARGETS = {
  coordinator: { x: 9, y: 10, room: 'Command Center' },  // executive chair behind the desk
  researcher: { x: 9, y: 4, room: 'Research Lab' },
  writer: { x: 17, y: 10, room: 'Writing Studio' },
  reviewer: { x: 1, y: 14, room: 'Review Room' }
};
// Lounge seats, in assignment order (agent i takes seat i; extras are spare distinct seats).
const IDLE_TARGETS = [
  { x: 3, y: 21 }, { x: 4, y: 21 }, { x: 13, y: 21 }, { x: 15, y: 21 },
  { x: 2, y: 21 }, { x: 5, y: 21 }, { x: 14, y: 22 },
  { x: 8, y: 23 }, { x: 9, y: 23 }, { x: 10, y: 23 }, { x: 11, y: 23 }
];
const AGENT_ORDER = ['coordinator', 'researcher', 'writer', 'reviewer'];
// Agents that do not go to the Hangout Room when idle. Diktator (coordinator) stays
// seated at the executive desk in the Oval Office whether idle or working.
const IDLE_OVERRIDES = {
  coordinator: { x: 9, y: 10, room: 'Command Center' }
};

// ---------------------------------------------------------------------------
// Validation + derived data

if (LAYOUT.length !== ROWS || LAYOUT.some(r => r.length !== COLS)) {
  throw new Error(`layout must be ${COLS}x${ROWS}: ${LAYOUT.map(r => r.length).join(',')}`);
}
const at = (x, y) => (x < 0 || y < 0 || x >= COLS || y >= ROWS ? '#' : LAYOUT[y][x]);
const FURNITURE = new Set(['T', 'k', 'w', 'L', 'B', 'W', 'F', 'P', 'X', 'f', 'l', 'K', 'M', 'A', 'C']);
const SEATS = new Set(['c', 'E', 'q', 'p', 's', 'u']);
const code = (ch) => {
  if (ch === '#' || ch === 'o' || FURNITURE.has(ch)) return 1;
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

// Ellipse geometry decides which tiles are Oval Office floor vs curved wall.
const inEllipse = (x, y, a, b) => ((x - OVAL.cx) / a) ** 2 + ((y - OVAL.cy) / b) ** 2 <= 1;
const ovalClass = (tx, ty) => {
  const x0 = tx * T, y0 = ty * T;
  const corners = [[x0 + 1, y0 + 1], [x0 + T - 1, y0 + 1], [x0 + 1, y0 + T - 1], [x0 + T - 1, y0 + T - 1]];
  if (corners.every(([x, y]) => inEllipse(x, y, OVAL.a - OVAL.ring, OVAL.b - OVAL.ring))) return 'inside';
  if (corners.some(([x, y]) => inEllipse(x, y, OVAL.a, OVAL.b))) return 'ring';
  return 'outside';
};
const ovalTiles = [];
for (let ty = 0; ty < ROWS; ty++) {
  for (let tx = 0; tx < COLS; tx++) {
    const cls = ovalClass(tx, ty);
    const ch = at(tx, ty);
    if (cls === 'inside') ovalTiles.push({ x: tx, y: ty });
    if (cls === 'ring' && ch !== 'o' && ch !== 'D') throw new Error(`tile ${tx},${ty} is on the oval wall but layout has "${ch}"`);
    if (cls !== 'ring' && ch === 'o') throw new Error(`tile ${tx},${ty} marked "o" is not on the oval wall`);
    if (cls === 'inside' && (ch === '#' || ch === 'o')) throw new Error(`oval interior tile ${tx},${ty} is a wall`);
  }
}

const rectTiles = ([x1, y1, x2, y2]) => {
  const tiles = [];
  for (let y = y1; y <= y2; y++) for (let x = x1; x <= x2; x++) tiles.push({ x, y });
  return tiles;
};
const roomTiles = (r) => (r.oval ? ovalTiles : rectTiles(r.rect));
const roomAt = (x, y) => ROOMS.find(r => roomTiles(r).some(t => t.x === x && t.y === y));
const isWall = (x, y) => at(x, y) === '#' || at(x, y) === 'D';

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
  W: ['101', '101', '111', '111', '101'], ' ': ['000', '000', '000', '000', '000']
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
  const kind = room ? room.floor : 'hall';
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
  } else if (kind === 'oval') {
    rect(ox, oy, T, T, '#e3d3a8'); // repainted by the oval overlay
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
// Oval Office overlay (per-pixel ellipse: floor, curved wall with windows, rug, seal, doors)

const drawOval = () => {
  const { cx, cy, a, b, ring } = OVAL;
  for (let y = cy - b - 1; y <= cy + b + 1; y++) {
    for (let x = cx - a - 1; x <= cx + a + 1; x++) {
      const X = x + 0.5, Y = y + 0.5;
      const vOut = ((X - cx) / a) ** 2 + ((Y - cy) / b) ** 2;
      const vIn = ((X - cx) / (a - ring)) ** 2 + ((Y - cy) / (b - ring)) ** 2;
      if (vIn <= 1) {
        // cream carpet with a faint diamond weave
        const d = ((x + y) % 6 === 0) || ((x - y + 600) % 6 === 0);
        let c = d ? '#dccb9c' : '#e6d6ab';
        // window band along the inside of the curved wall behind the desk
        if (Y < cy - (b - ring) * 0.62 && vIn > 0.8) {
          const k = (x - (cx - a)) % 9;
          c = (k === 0 || k === 8) ? '#f3ecd8' : (y % 4 === 0 ? '#d7eefa' : '#8fcbeb');
          if (vIn < 0.84) c = '#c9a227'; // gold sill
        }
        px(x, y, c);
      } else if (vOut <= 1) {
        let c = '#f3ecd8';                               // cream wall
        if (vOut > 0.955) c = '#3d3526';                 // outer outline
        else if (vIn < 1.07) c = '#c9a227';              // gold inner trim
        else if (vOut > 0.91) c = '#e2d7bb';             // outer shading
        // tall windows along the curved wall behind the desk
        const top = Y < cy - b * 0.62;
        if (top && vIn >= 1.07 && vOut <= 0.955) {
          const k = (x - (cx - a)) % 9;
          if (k >= 2 && k <= 6) c = (y % 5 === 0) ? '#e8f4fb' : '#9fd3f0';
          if (k === 1 || k === 7) c = '#f3ecd8';
        }
        px(x, y, c);
      }
    }
  }
  // Curtains framing the window arc
  for (const sx of [cx - 42, cx + 38]) rect(sx, cy - b + 8, 4, 9, '#9e2b2b');

  // Oval rug with gold border and a seal at the exact map centre
  const rc = { x: cx, y: cy + 8, a: 46, b: 32 };
  for (let y = rc.y - rc.b; y <= rc.y + rc.b; y++) {
    for (let x = rc.x - rc.a; x <= rc.x + rc.a; x++) {
      const v = ((x + 0.5 - rc.x) / rc.a) ** 2 + ((y + 0.5 - rc.y) / rc.b) ** 2;
      if (v > 1) continue;
      let c = '#1f3a68';
      if (v > 0.86) c = '#c9a227';
      else if (v > 0.78) c = '#274a82';
      else if (v > 0.74) c = '#c9a227';
      px(x, y, c);
    }
  }
  for (let y = -7; y <= 7; y++) for (let x = -7; x <= 7; x++) {
    const r2 = x * x + y * y;
    if (r2 <= 49) px(cx + x, cy + y, r2 >= 36 ? '#e0b83a' : r2 >= 25 ? '#1f3a68' : '#c9a227');
  }
  // stylised eagle/star in the seal
  rect(cx - 3, cy - 1, 6, 2, '#6b4a12'); rect(cx - 1, cy - 3, 2, 6, '#6b4a12');
  px(cx - 4, cy - 2, '#6b4a12'); px(cx + 3, cy - 2, '#6b4a12');

  // Door openings in the curved wall
  for (let ty = 0; ty < ROWS; ty++) {
    for (let tx = 0; tx < COLS; tx++) {
      if (at(tx, ty) !== 'D' || ovalClass(tx, ty) !== 'ring') continue;
      const ox = tx * T, oy = ty * T;
      const vertical = ty === Math.floor(cy / T) - 1 || ty === Math.floor(cy / T); // side doors
      if (at(tx - 1, ty) === '.' || at(tx + 1, ty) === '.') {
        // side door: opening spans the tile vertically
        rect(ox, oy + 2, T, T - 4, '#e6d6ab');
        rect(ox, oy + 1, T, 1, '#c9a227'); rect(ox, oy + T - 2, T, 1, '#c9a227');
      } else {
        // bottom double door
        rect(ox + (at(tx - 1, ty) === 'D' ? 0 : 2), oy, T - 2, T, '#e6d6ab');
        if (at(tx - 1, ty) !== 'D') rect(ox + 1, oy, 1, T, '#c9a227');
        if (at(tx + 1, ty) !== 'D') rect(ox + T - 2, oy, 1, T, '#c9a227');
      }
      void vertical;
    }
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
      monitor(ox + 4, oy + 2, room && room.floor === 'lab' ? '#f59ac8' : '#7fc8f8');
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
      rect(ox + 7, oy + 1, 1, 15, '#c9a227'); px(ox + 7, oy, '#f0d060');
      rect(ox + 5, oy + 15, 5, 1, '#6b4a12');
      if (first('f')) { // stars & stripes
        for (let j = 0; j < 8; j++) rect(ox + 8, oy + 2 + j, 7, 1, j % 2 ? '#f4f1e8' : '#b22234');
        rect(ox + 8, oy + 2, 3, 4, '#3c3b6e'); px(ox + 9, oy + 3, '#ffffff');
      } else { // navy standard
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
  if (dir === 'up') { // backrest below (seat faces up)
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
  if (room.oval) {
    // two-line gold plaque on the hallway wall above the curved office
    const w = textWidth('COMMAND CENTER') + 8;
    const sx = OVAL.cx - Math.round(w / 2), sy = OVAL.cy - OVAL.b - 16;
    rect(sx - 1, sy - 1, w + 2, 17, '#1b1f29');
    rect(sx, sy, w, 15, '#1f3a68');
    rect(sx, sy, w, 1, '#e0b83a'); rect(sx, sy + 14, w, 1, '#c9a227');
    text('OVAL OFFICE', OVAL.cx - Math.round(textWidth('OVAL OFFICE') / 2), sy + 2, '#f0d060');
    text('COMMAND CENTER', OVAL.cx - Math.round(textWidth('COMMAND CENTER') / 2), sy + 8, '#ffffff');
    return;
  }
  const [x1, y, x2] = room.sign;
  plate(room.name.toUpperCase(), (x1 * T + (x2 + 1) * T) / 2, y * T + 3, room.color);
};

// ---------------------------------------------------------------------------
// Render

for (let ty = 0; ty < ROWS; ty++) {
  for (let tx = 0; tx < COLS; tx++) {
    const ch = at(tx, ty);
    if (ch === '#') wallTile(tx, ty);
    else if (ch === 'D' && ovalClass(tx, ty) !== 'ring') doorTile(tx, ty);
    else floorTile(tx, ty);
  }
}
drawOval();
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
// Targets: validate, then write outputs

const rooms = ROOMS.map(r => ({ id: r.id, name: r.name, color: r.color, tiles: roomTiles(r) }));
const inRoom = (t, name) => rooms.find(r => r.name === name).tiles.some(q => q.x === t.x && q.y === t.y);
const seatOrFloor = (t) => collision[t.y][t.x] === 0 || collision[t.y][t.x] === 3;
for (const [agent, t] of Object.entries(WORK_TARGETS)) {
  if (!seatOrFloor(t) || !inRoom(t, t.room)) throw new Error(`work target for ${agent} is not a free tile in ${t.room}`);
}
const idleKeys = new Set();
for (const t of IDLE_TARGETS) {
  if (!seatOrFloor(t) || !inRoom(t, 'Hangout Room')) throw new Error(`idle target ${t.x},${t.y} is not a free Hangout Room tile`);
  const k = `${t.x},${t.y}`;
  if (idleKeys.has(k)) throw new Error(`duplicate idle target ${k}`);
  idleKeys.add(k);
}
for (const [agent, t] of Object.entries(IDLE_OVERRIDES)) {
  if (!seatOrFloor(t) || !inRoom(t, t.room)) throw new Error(`idle override for ${agent} is not a free tile in ${t.room}`);
}
// Idle position per agent: override if any, else the lounge seat matching its order.
const spawns = Object.fromEntries(AGENT_ORDER.map((id, i) => {
  const t = IDLE_OVERRIDES[id] || IDLE_TARGETS[i];
  return [id, { x: t.x, y: t.y }];
}));

const root = path.join(__dirname, '..');
const json = JSON.stringify({
  cols: COLS,
  rows: ROWS,
  tile: TILE,
  collision,
  rooms,
  targets: { work: WORK_TARGETS, idle: IDLE_TARGETS, idleRoom: 'Hangout Room', idleOverrides: IDLE_OVERRIDES, agentOrder: AGENT_ORDER },
  spawns
}, null, 2)
  .replace(/\[\s+((?:\d+,\s*)*\d+)\s+\]/g, (m, inner) => `[${inner.replace(/\s+/g, '')}]`)
  .replace(/\{\s+"x": (\d+),\s+"y": (\d+)\s+\}/g, '{ "x": $1, "y": $2 }');

fs.writeFileSync(path.join(root, 'assets', 'office-openclaw.png'), encodePNG(buf, W, H, SCALE));
fs.writeFileSync(path.join(root, 'assets', 'office-layout.json'), json + '\n');
console.log(`wrote assets/office-openclaw.png (${W * SCALE}x${H * SCALE}) and assets/office-layout.json`);
console.log(`Oval Office: ${ovalTiles.length} floor tiles, centre at (${OVAL.cx * SCALE}, ${OVAL.cy * SCALE}) px`);
