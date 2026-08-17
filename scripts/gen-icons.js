// Generates PNG icons from scratch (no deps) using Node's built-in zlib.
// Draws the Sequence mark: dark felt, a faint 5x5 grid, and five gold chips on
// the diagonal — the sequence itself. Mirrors icons/icon.svg. Run:
//   node scripts/gen-icons.js
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const FELT = [0x07, 0x13, 0x0E];
const GLOW = [0x0D, 0x2A, 0x1D];
const GOLD = [0xF2, 0xC1, 0x4E];

function smoothstep(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** Coverage in [0,1] for a distance crossing an edge, anti-aliased over ±aa. */
function edgeCoverage(dist, edge, aa) { return 1 - smoothstep(edge - aa, edge + aa, dist); }

function drawIcon(size, scale = 1) {
  const u = size / 512;              // design units -> pixels
  const aa = u * 1.4;
  const cx = size / 2, cy = size / 2;
  const buf = Buffer.alloc(size * size * 4);

  // Grid + chips laid out on the 512 design grid, then scaled about the centre
  // (scale < 1 shrinks the content into a maskable safe area).
  const at = (v) => cx + (v - 256) * u * scale;   // horizontal design coord -> px
  const aty = (v) => cy + (v - 256) * u * scale;  // vertical, same maths
  const lines = [96, 160, 224, 288, 352, 416];
  const chips = [[128, 384], [192, 320], [256, 256], [320, 192], [384, 128]];
  const halfLine = 1.5 * u * scale;
  const chipR = 23 * u * scale;
  const holeR = 15 * u * scale;
  const holeW = 2 * u * scale;
  const gridMin = at(96), gridMax = at(416);
  const gridMinY = aty(96), gridMaxY = aty(416);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5, py = y + 0.5;

      // Felt: a soft glow from the top edge fading into the table.
      const glow = 1 - smoothstep(0, size * 0.75, Math.hypot(px - cx, py) * 0.9);
      let r = FELT[0] * (1 - glow) + GLOW[0] * glow;
      let g = FELT[1] * (1 - glow) + GLOW[1] * glow;
      let b = FELT[2] * (1 - glow) + GLOW[2] * glow;

      // Faint grid, clipped to the board square.
      let grid = 0;
      if (px >= gridMin - halfLine && px <= gridMax + halfLine &&
          py >= gridMinY - halfLine && py <= gridMaxY + halfLine) {
        for (const v of lines) {
          grid = Math.max(grid, edgeCoverage(Math.abs(px - at(v)), halfLine, aa));
          grid = Math.max(grid, edgeCoverage(Math.abs(py - aty(v)), halfLine, aa));
        }
      }
      const gridCov = grid * 0.09;
      r = r * (1 - gridCov) + 255 * gridCov;
      g = g * (1 - gridCov) + 255 * gridCov;
      b = b * (1 - gridCov) + 255 * gridCov;

      // Chips: a gold disc with a darker inner ring, so it reads as a chip
      // rather than a dot.
      let disc = 0, hole = 0;
      for (const [dx, dy] of chips) {
        const d = Math.hypot(px - at(dx), py - aty(dy));
        disc = Math.max(disc, edgeCoverage(d, chipR, aa));
        hole = Math.max(hole, edgeCoverage(Math.abs(d - holeR), holeW, aa));
      }
      r = r * (1 - disc) + GOLD[0] * disc;
      g = g * (1 - disc) + GOLD[1] * disc;
      b = b * (1 - disc) + GOLD[2] * disc;
      const ring = hole * 0.45;
      r = r * (1 - ring) + FELT[0] * ring;
      g = g * (1 - ring) + FELT[1] * ring;
      b = b * (1 - ring) + FELT[2] * ring;

      const i = (y * size + x) * 4;
      buf[i] = Math.round(r); buf[i + 1] = Math.round(g); buf[i + 2] = Math.round(b); buf[i + 3] = 255;
    }
  }
  return buf;
}

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePNG(rgba, size) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type RGBA
  // rest 0 (compression, filter, interlace)

  // Filter each scanline with filter type 0.
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, '..', 'icons');
const targets = [
  { name: 'icon-192.png', size: 192, scale: 1 },
  { name: 'icon-512.png', size: 512, scale: 1 },
  { name: 'icon-maskable.png', size: 512, scale: 0.7 }, // shrink for safe area
];
for (const t of targets) {
  const png = encodePNG(drawIcon(t.size, t.scale), t.size);
  fs.writeFileSync(path.join(outDir, t.name), png);
  console.log('wrote', t.name, png.length, 'bytes');
}
