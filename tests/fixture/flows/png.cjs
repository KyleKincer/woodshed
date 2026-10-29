// A minimal PNG reader for the verification flows: decodes the 8-bit, non-interlaced
// RGB/RGBA PNGs that Chromium screenshots produce (zlib from node:zlib, the five
// scanline filters), so a flow can measure rendered colours (a cover veil's effective
// opacity) without an image library. Other formats throw.
//   const {decodePng, averageRgb} = require('./png.cjs');
//   const img = decodePng(await page.screenshot({clip}));   // {width, height, channels, data}
//   averageRgb(img, {x, y, w, h})                            // [r, g, b] over the region
'use strict';

const zlib = require('node:zlib');

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function decodePng(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('png: not a PNG');
  let offset = 8, width = 0, height = 0, channels = 0;
  const idat = [];
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset), type = buf.toString('ascii', offset + 4, offset + 8);
    const body = buf.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0); height = body.readUInt32BE(4);
      const depth = body[8], color = body[9], interlace = body[12];
      if (depth !== 8 || interlace !== 0 || (color !== 2 && color !== 6)) throw new Error(`png: unsupported format (depth ${depth}, colour type ${color}, interlace ${interlace})`);
      channels = color === 6 ? 4 : 3;
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  if (!width || !channels) throw new Error('png: no IHDR');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels, data = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)], src = y * (stride + 1) + 1, row = y * stride, prev = row - stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[src + x];
      const a = x >= channels ? data[row + x - channels] : 0, b = y ? data[prev + x] : 0, c = y && x >= channels ? data[prev + x - channels] : 0;
      let out;
      switch (filter) {
        case 0: out = v; break;
        case 1: out = v + a; break;
        case 2: out = v + b; break;
        case 3: out = v + ((a + b) >> 1); break;
        case 4: out = v + paeth(a, b, c); break;
        default: throw new Error(`png: bad filter ${filter} on row ${y}`);
      }
      data[row + x] = out & 0xff;
    }
  }
  return {width, height, channels, data};
}

/** The mean [r, g, b] over a region of a decoded image (the whole image by default). */
function averageRgb(img, {x = 0, y = 0, w = img.width - x, h = img.height - y} = {}) {
  const sum = [0, 0, 0];
  let n = 0;
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
    const i = (yy * img.width + xx) * img.channels;
    sum[0] += img.data[i]; sum[1] += img.data[i + 1]; sum[2] += img.data[i + 2]; n++;
  }
  return sum.map(s => s / Math.max(1, n));
}

/**
 * The opacity at which `art` composited over `bg` gives `shown`, per channel, using only
 * the channels where art and bg differ by at least `minContrast` (else null).
 */
function effectiveAlpha(shown, art, bg, {minContrast = 24} = {}) {
  const alphas = [0, 1, 2].filter(i => Math.abs(art[i] - bg[i]) >= minContrast).map(i => (shown[i] - bg[i]) / (art[i] - bg[i]));
  return alphas.length ? alphas.reduce((s, a) => s + a, 0) / alphas.length : null;
}

/**
 * The least-squares opacity at which image `art` composited over the flat colour `bg`
 * gives image `shown` (same size), over every pixel and channel of the region; null when
 * the art barely differs from bg (no contrast to measure with).
 */
function fitAlpha(shown, art, bg, {x = 0, y = 0, w = art.width - x, h = art.height - y} = {}) {
  if (shown.width !== art.width || shown.height !== art.height) throw new Error('png: fitAlpha needs two images of one size');
  let num = 0, den = 0;
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
    const i = (yy * art.width + xx) * art.channels, j = (yy * shown.width + xx) * shown.channels;
    for (let c = 0; c < 3; c++) {
      const d = art.data[i + c] - bg[c];
      num += (shown.data[j + c] - bg[c]) * d;
      den += d * d;
    }
  }
  const pixels = Math.max(1, w * h);
  return den / pixels < 64 ? null : num / den;
}

/** 'rgb(18, 22, 21)' or 'rgba(…)' → [r, g, b]. */
function parseRgb(css) {
  const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(css ?? '');
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

module.exports = {decodePng, averageRgb, effectiveAlpha, fitAlpha, parseRgb};
