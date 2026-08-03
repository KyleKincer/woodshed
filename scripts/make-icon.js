#!/usr/bin/env node
'use strict';

// Generate build/icon.png, the app icon electron-builder converts per platform.
//
//   node scripts/make-icon.js
//
// The mark is the sidebar logo — `◐` in the accent colour on the app
// background (see `.logo` and `--accent` in src/css/styles.css). It's drawn
// geometrically rather than by rasterising the glyph: no font dependency, and it
// stays crisp at 16px where a rendered glyph goes muddy.
//
// Writing the PNG by hand keeps this dependency-free. It only runs when the icon
// changes, so there's nothing to optimise.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 1024;

// Matches src/css/styles.css.
const ACCENT = [0x5b, 0x8c, 0xff];
const BG = [0x0e, 0x0f, 0x13];

// macOS insets app icon artwork rather than letting it bleed to the edge, and
// the same proportions read fine on Windows and Linux.
const MARGIN = 100;
const CORNER = 185;

// Ring geometry for `◐`: a stroked circle whose left half is filled solid.
const CENTER = SIZE / 2;
const RADIUS = 230;
const STROKE = 46;

const SS = 4; // supersampling factor per axis, for antialiasing

// Coverage of the rounded-rect body at one sample point.
function inBody(x, y) {
  const lo = MARGIN;
  const hi = SIZE - MARGIN;
  if (x < lo || x > hi || y < lo || y > hi) return false;
  // Corners: only the quarter-circles count.
  const cx = x < lo + CORNER ? lo + CORNER : x > hi - CORNER ? hi - CORNER : x;
  const cy = y < lo + CORNER ? lo + CORNER : y > hi - CORNER ? hi - CORNER : y;
  if (cx === x && cy === y) return true;
  return (x - cx) ** 2 + (y - cy) ** 2 <= CORNER ** 2;
}

// Coverage of the mark at one sample point.
function inMark(x, y) {
  const r = Math.sqrt((x - CENTER) ** 2 + (y - CENTER) ** 2);
  if (r > RADIUS) return false;
  if (r >= RADIUS - STROKE) return true; // the ring itself
  return x < CENTER; // filled left half
}

function render() {
  // RGBA scanlines, each prefixed with a filter-type byte (0 = none).
  const raw = Buffer.alloc(SIZE * (1 + SIZE * 4));
  const step = 1 / SS;
  const offset = step / 2;

  for (let y = 0; y < SIZE; y++) {
    const rowStart = y * (1 + SIZE * 4);
    raw[rowStart] = 0;
    for (let x = 0; x < SIZE; x++) {
      let body = 0;
      let mark = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + offset + sx * step;
          const py = y + offset + sy * step;
          if (inBody(px, py)) body++;
          if (inMark(px, py)) mark++;
        }
      }
      const total = SS * SS;
      const bodyA = body / total;
      const markA = mark / total;

      // Composite the mark over the body, then the body over transparency.
      const p = rowStart + 1 + x * 4;
      for (let c = 0; c < 3; c++) {
        raw[p + c] = Math.round(BG[c] * (1 - markA) + ACCENT[c] * markA);
      }
      raw[p + 3] = Math.round(255 * Math.max(bodyA, markA));
    }
  }
  return raw;
}

// --- minimal PNG container ---

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(raw) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const out = path.join(__dirname, '..', 'build', 'icon.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png(render()));
console.log(`wrote ${path.relative(process.cwd(), out)} (${SIZE}x${SIZE})`);
