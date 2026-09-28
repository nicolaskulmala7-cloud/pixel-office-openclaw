#!/usr/bin/env node
// Generates the OpenClaw office map: original pixel art (no third-party tiles),
// plus the matching collision grid and room tiles, from one ASCII layout.
//
//   node tools/build-office-map.js
//
// Outputs:
//   assets/office-openclaw.png   640x800 background (20x25 tiles of 32px, drawn at 16px and scaled 2x)
//   assets/office-layout.json    { cols, rows, tile, collision, rooms, spawns }
//
// Collision codes match index.html: 0 floor, 1 wall/furniture, 2 door, 3 chair.

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------------------------------------------------------------------------
// Layout (20 x 25). Legend:
//   #  wall            D  door           .  floor          r  rug (walkable)
//   c  chair           T  table          S  monitor console
//   k  computer desk   w  writing desk   L  lab bench      B  bookshelf
//   W  whiteboard      F  filing cabinet P  plant          O  sofa
//   V  water cooler
const LAYOUT = [
  '####################', // 0
  '####################', // 1  back walls (room signs)
  '#PSSSSSSSP#BBB.WW.P#', // 2
  '#.........#........#', // 3
  '#...c.c...#.kk..LL.#', // 4
  '#..TTTTT..#.c....c.#', // 5
  '#..TTTTT..#........#', // 6
  '#...c.c...#.LL..kk.#', // 7
  '#P.......P#.c....c.#', // 8
  '#####D########D#####', // 9
  '#P................P#', // 10 hallway
  '#..................#', // 11
  '#.................V#', // 12
  '#####D########D#####', // 13 back walls (room signs)
  '#BB.....BB#FF..WW.P#', // 14
  '#.........#........#', // 15
  '#.ww..ww..#..c..c..#', // 16
  '#..c..c...#..TTTT..#', // 17
  '#.........#..TTTT..#', // 18
  '#..rrrrr..#..c..c..#', // 19
  '#..rrrrr..#........#', // 20
  '#..rrrrr..#.kk....F#', // 21
  '#P.OOO...B#.c.....F#', // 22
  '#B.......P#P......P#', // 23
  '####################'  // 24
];

const COLS = 20;
const ROWS = 25;
const TILE = 32; // on-screen tile size
const T = 16;    // art tile size (scaled 2x)
const SCALE = TILE / T;

// Room regions (inclusive tile rects) and accent colors (match the dashboard room colors).
const ROOMS = [
  { id: 1, name: 'Command Center', color: '#3b82f6', rect: [1, 2, 9, 8], sign: [1, 1, 9], floor: 'carpet' },
  { id: 2, name: 'Research Lab', color: '#ec4899', rect: [11, 2, 18, 8], sign: [11, 1, 18], floor: 'lab' },
  { id: 3, name: 'Writing Studio', color: '#10b981', rect: [1, 14, 9, 23], sign: [1, 13, 4], floor: 'wood' },
  { id: 4, name: 'Review Room', color: '#f59e0b', rect: [11, 14, 18, 23], sign: [15, 13, 18], floor: 'checker' }
];

// Default standing spots (floor tiles) for each agent's home room.
const SPAWNS = {
  coordinator: { x: 5, y: 3 },
  researcher: { x: 14, y: 6 },
  writer: { x: 5, y: 18 },
  reviewer: { x: 14, y: 20 }
};

// ---------------------------------------------------------------------------
// Validation + derived data

if (LAYOUT.length !== ROWS || LAYOUT.some(r => r.length !== COLS)) {
  throw new Error(`layout must be ${COLS}x${ROWS}: ${LAYOUT.map(r => r.length).join(',')}`);
}
const at = (x, y) => (x < 0 || y < 0 || x >= COLS || y >= ROWS ? '#' : LAYOUT[y][x]);
const FURNITURE = new Set(['T', 'S', 'k', 'w', 'L', 'B', 'W', 'F', 'P', 'O', 'V']);
const code = (ch) => {
  if (ch === '#' || FURNITURE.has(ch)) return 1;
  if (ch === 'D') return 2;
  if (ch === 'c') return 3;
  if (ch === '.' || ch === 'r') return 0;
  throw new Error(`unknown layout char "${ch}"`);
};
const collision = LAYOUT.map(row => [...row].map(code));
const inRect = (x, y, [x1, y1, x2, y2]) => x >= x1 && x <= x2 && y >= y1 && y <= y2;
const roomAt = (x, y) => ROOMS.find(r => inRect(x, y, r.rect));
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
  E: ['111', '100', '110', '100', '111'], G: ['111', '100', '101', '101', '111'],
  H: ['101', '101', '111', '101', '101'], I: ['111', '010', '010', '010', '111'],
  L: ['100', '100', '100', '100', '111'], M: ['101', '111', '111', '101', '101'],
  N: ['111', '101', '101', '101', '101'], O: ['111', '101', '101', '101', '111'],
  R: ['110', '101', '110', '101', '101'], S: ['111', '100', '111', '001', '111'],
  T: ['111', '010', '010', '010', '010'], U: ['101', '101', '101', '101', '111'],
  V: ['101', '101', '101', '101', '010'], W: ['101', '101', '111', '111', '101'],
  ' ': ['000', '000', '000', '000', '000']
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
  if (kind === 'carpet') {
    rect(ox, oy, T, T, '#34507f');
    for (let j = 0; j < T; j += 4) for (let i = (j / 4) % 2 ? 2 : 0; i < T; i += 4) px(ox + i, oy + j, '#2d4671');
  } else if (kind === 'lab') {
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
    // light edge where the cap meets a walkable/furnished area
    if (!isWall(tx - 1, ty) && tx > 0) rect(ox, oy, 1, T, '#3a4050');
    if (!isWall(tx + 1, ty) && tx < COLS - 1) rect(ox + T - 1, oy, 1, T, '#3a4050');
    if (!isWall(tx, ty - 1) && ty > 0) rect(ox, oy, T, 1, '#3a4050');
  }
};

const doorTile = (tx, ty) => {
  const ox = tx * T, oy = ty * T;
  rect(ox, oy, T, 4, WALL_CAP);
  rect(ox, oy + 4, T, 12, WALL_FACE);
  rect(ox + 2, oy + 2, 12, 14, '#3b2a1c');       // frame
  rect(ox + 3, oy + 3, 10, 13, '#8a5a32');       // door panel
  rect(ox + 4, oy + 4, 8, 5, '#9c6a3e');
  rect(ox + 4, oy + 10, 8, 5, '#9c6a3e');
  px(ox + 11, oy + 10, '#e8c55a'); px(ox + 11, oy + 11, '#c9a640'); // handle
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
  switch (ch) {
    case 'T': { // conference / review table
      const room = roomAt(tx, ty);
      const top = room && room.floor === 'carpet' ? '#3c4a66' : '#8b5e3a';
      slab(tx, ty, 'T', top, shade(top, 1.25), shade(top, 0.7));
      if (room && room.floor === 'carpet') {
        if ((tx + ty) % 2 === 0) { rect(ox + 4, oy + 5, 7, 5, '#aab4c8'); rect(ox + 5, oy + 6, 5, 3, '#5fd0ff'); } // tablets
        else { rect(ox + 5, oy + 6, 6, 4, '#e9edf5'); rect(ox + 6, oy + 7, 4, 1, '#9aa3b5'); } // briefs
      } else if ((tx + ty) % 2 === 0) {
        rect(ox + 3, oy + 5, 6, 7, '#f4f1e8'); rect(ox + 4, oy + 7, 4, 1, '#b9b3a3'); rect(ox + 4, oy + 9, 3, 1, '#d9534f'); // marked-up draft
      } else {
        rect(ox + 6, oy + 4, 5, 7, '#f4f1e8'); rect(ox + 7, oy + 6, 3, 1, '#b9b3a3'); px(ox + 9, oy + 9, '#2e9e5b'); // approved check
      }
      break;
    }
    case 'S': { // command console with dashboards
      slab(tx, ty, 'S', '#2c3345', '#3e4861', '#1d2230');
      const palette = ['#39d98a', '#5fd0ff', '#ffb547', '#ff6b8b'];
      rect(ox + 2, oy + 1, 12, 8, '#141821');
      rect(ox + 3, oy + 2, 10, 6, '#0f2a3a');
      const c = palette[tx % palette.length];
      for (let i = 0; i < 4; i++) rect(ox + 4 + i * 2, oy + 7 - ((tx + i * 3) % 4) - 1, 1, ((tx + i * 3) % 4) + 1, c); // bar chart
      rect(ox + 3, oy + 11, 10, 1, '#4a556f'); // keyboard
      break;
    }
    case 'k': { // computer desk
      slab(tx, ty, 'k', '#9a7550', '#b48d65', '#6e5236');
      monitor(ox + 4, oy + 2, roomAt(tx, ty) && roomAt(tx, ty).floor === 'lab' ? '#f59ac8' : '#7fc8f8');
      rect(ox + 3, oy + 10, 8, 1, '#3a3f4b'); // keyboard
      px(ox + 12, oy + 10, '#3a3f4b');
      break;
    }
    case 'w': { // writing desk
      slab(tx, ty, 'w', '#a8743f', '#c28c55', '#7a5230');
      if (!same(tx - 1, ty, 'w')) { // left half: lamp + papers
        rect(ox + 3, oy + 2, 3, 2, '#2f8f6a'); rect(ox + 4, oy + 4, 1, 4, '#3a3f4b'); rect(ox + 3, oy + 8, 3, 1, '#3a3f4b');
        rect(ox + 8, oy + 5, 6, 7, '#f7f3e8'); rect(ox + 9, oy + 7, 4, 1, '#b8b09c'); rect(ox + 9, oy + 9, 4, 1, '#b8b09c');
      } else { // right half: laptop + mug
        rect(ox + 2, oy + 3, 8, 5, '#2b303b'); rect(ox + 3, oy + 4, 6, 3, '#9fe0c4'); rect(ox + 1, oy + 8, 10, 3, '#4a5160');
        rect(ox + 12, oy + 5, 2, 3, '#e9edf5'); px(ox + 14, oy + 6, '#e9edf5');
      }
      break;
    }
    case 'L': { // lab bench
      slab(tx, ty, 'L', '#dfe4ea', '#f4f6f9', '#a9b1bd');
      if (!same(tx - 1, ty, 'L')) { // microscope
        rect(ox + 5, oy + 9, 6, 2, '#3a3f4b'); rect(ox + 7, oy + 3, 2, 6, '#3a3f4b'); rect(ox + 6, oy + 2, 3, 2, '#596175'); px(ox + 9, oy + 7, '#ec4899');
      } else { // flasks
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
      const l = !same(tx - 1, ty, 'W'), r = !same(tx + 1, ty, 'W');
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
    case 'O': { // sofa facing up (toward the rug)
      const l = !same(tx - 1, ty, 'O'), r = !same(tx + 1, ty, 'O');
      rect(ox, oy + 4, T, 8, '#2f8f6a');
      rect(ox, oy + 10, T, 4, '#246f52'); // back
      if (l) rect(ox + 1, oy + 3, 3, 11, '#246f52');
      if (r) rect(ox + T - 4, oy + 3, 3, 11, '#246f52');
      rect(ox + (l ? 4 : 0), oy + 5, T - (l ? 4 : 0) - (r ? 4 : 0), 1, '#3aa57c');
      shadowBelow(ox, oy, T - 2);
      break;
    }
    case 'V': { // water cooler
      rect(ox + 5, oy + 7, 6, 8, '#e9edf5'); rect(ox + 5, oy + 7, 6, 1, '#c9ced8');
      rect(ox + 6, oy + 1, 4, 6, '#7fc8f8'); rect(ox + 6, oy + 1, 4, 1, '#a9dcfb');
      px(ox + 7, oy + 10, '#3b82f6'); px(ox + 9, oy + 10, '#d9534f');
      shadowBelow(ox, oy, 6, 5);
      break;
    }
    default:
      break;
  }
};

// Rug: walkable decor with a border.
const rugTile = (tx, ty) => {
  const ox = tx * T, oy = ty * T;
  const l = !same(tx - 1, ty, 'r'), r = !same(tx + 1, ty, 'r');
  const u = !same(tx, ty - 1, 'r'), d = !same(tx, ty + 1, 'r');
  rect(ox + (l ? 2 : 0), oy + (u ? 2 : 0), T - (l ? 2 : 0) - (r ? 2 : 0), T - (u ? 2 : 0) - (d ? 2 : 0), '#2f8f6a');
  const x0 = ox + (l ? 4 : 0), y0 = oy + (u ? 4 : 0);
  const x1 = ox + T - (r ? 4 : 0), y1 = oy + T - (d ? 4 : 0);
  if (u) rect(x0, y0, x1 - x0, 1, '#9fe0c4');
  if (d) rect(x0, y1 - 1, x1 - x0, 1, '#9fe0c4');
  if (l) rect(x0, y0, 1, y1 - y0, '#9fe0c4');
  if (r) rect(x1 - 1, y0, 1, y1 - y0, '#9fe0c4');
  if ((tx + ty) % 2 === 0) { px(ox + 7, oy + 7, '#57b891'); px(ox + 8, oy + 8, '#57b891'); }
};

// Office chair; the backrest sits on the side away from the adjacent desk/table.
const chairTile = (tx, ty) => {
  const ox = tx * T, oy = ty * T;
  const room = roomAt(tx, ty);
  const seat = room ? shade(room.color, 0.75) : '#555c6b';
  const back = room ? shade(room.color, 0.55) : '#3a3f4b';
  const deskAbove = FURNITURE.has(at(tx, ty - 1));
  rect(ox + 7, oy + 11, 2, 3, '#2a2e38'); rect(ox + 4, oy + 14, 8, 1, '#2a2e38'); // base
  rect(ox + 3, oy + 6, 10, 6, seat);
  rect(ox + 3, oy + 6, 10, 1, shade(room ? room.color : '#555c6b', 0.95));
  if (deskAbove) rect(ox + 3, oy + 11, 10, 3, back); // backrest toward viewer
  else rect(ox + 3, oy + 2, 10, 4, back);           // backrest away from viewer
};

// Room name plate on the back wall.
const sign = (room) => {
  const [x1, y, x2] = room.sign;
  const span = (x2 - x1 + 1) * T;
  const label = room.name.toUpperCase();
  const w = textWidth(label) + 6;
  const sx = x1 * T + Math.floor((span - w) / 2);
  const sy = y * T + 3;
  rect(sx - 1, sy - 1, w + 2, 11, '#1b1f29');
  rect(sx, sy, w, 9, shade(room.color, 0.7));
  rect(sx, sy, w, 1, shade(room.color, 1.2));
  text(label, sx + 3, sy + 2, '#ffffff');
};

// ---------------------------------------------------------------------------
// Render

for (let ty = 0; ty < ROWS; ty++) {
  for (let tx = 0; tx < COLS; tx++) {
    const ch = at(tx, ty);
    if (ch === '#') wallTile(tx, ty);
    else if (ch === 'D') doorTile(tx, ty);
    else floorTile(tx, ty);
  }
}
for (let ty = 0; ty < ROWS; ty++) {
  for (let tx = 0; tx < COLS; tx++) {
    const ch = at(tx, ty);
    if (ch === 'r') rugTile(tx, ty);
    else if (ch === 'c') chairTile(tx, ty);
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
// Write outputs

const root = path.join(__dirname, '..');
const rooms = ROOMS.map(r => {
  const [x1, y1, x2, y2] = r.rect;
  const tiles = [];
  for (let y = y1; y <= y2; y++) for (let x = x1; x <= x2; x++) tiles.push({ x, y });
  return { id: r.id, name: r.name, color: r.color, tiles };
});
for (const [agent, s] of Object.entries(SPAWNS)) {
  if (collision[s.y][s.x] !== 0) throw new Error(`spawn for ${agent} is not a floor tile`);
}

fs.writeFileSync(path.join(root, 'assets', 'office-openclaw.png'), encodePNG(buf, W, H, SCALE));
fs.writeFileSync(path.join(root, 'assets', 'office-layout.json'), JSON.stringify({
  cols: COLS, rows: ROWS, tile: TILE, collision, rooms, spawns: SPAWNS
}, null, 2) + '\n');
console.log(`wrote assets/office-openclaw.png (${W * SCALE}x${H * SCALE}) and assets/office-layout.json`);
