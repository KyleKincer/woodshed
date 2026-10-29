// Drum lanes: an event grid aligned to the recording's time, one row per kit
// piece in use. Notes are onsets, drawn as fixed markers; written rhythm lives
// in the score view. Colours come from tokens through the classes in
// src/styles/views/notation/lanes.css, so a theme change needs no redraw.
import {KIT, number, starts, toTime} from '../../../shared/notation.ts';
import {xml} from './html.js';
import '../../styles/views/notation/lanes.css';

export const LANE_HEIGHT = 28, LANE_TOP = 26;
/** Rows to show: pieces with notes, the core kit, and the current piece, in staff order. */
export function laneRows(score, {piece = null, all = false} = {}) {
  if (all) return KIT.map(k => k.id);
  const used = new Set(score.bars.flatMap(b => b.hits.map(h => h.instrument)));
  return KIT.filter(k => k.core || used.has(k.id) || k.id === piece).map(k => k.id);
}

const n = v => Math.round(v * 100) / 100;

export function renderLanes(host, {score, indices, width, timeRange, selected, cursor, grid = .25, rows}) {
  const positions = starts(score.timeline), height = rows.length * LANE_HEIGHT + LANE_TOP + 8;
  const qx = q => (toTime(score.timeline, q) - timeRange.start) / (timeRange.end - timeRange.start) * width;
  const targets = [], bars = [], rowOf = new Map(rows.map((id, i) => [id, i]));
  const bits = [`<svg class="lanes" width="${width}" height="${height}" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">`];
  rows.forEach((id, row) => { const y = LANE_TOP + row * LANE_HEIGHT; bits.push(`<path class="lane-row" d="M0 ${y + LANE_HEIGHT / 2}H${width}"/>`); });
  for (const index of indices) {
    const m = score.timeline.measures[index], start = positions[index], left = qx(start), right = qx(start + number(m.length));
    bars.push({index, left, right});
    const bar = score.bars.find(b => b.measureId === m.id);
    bits.push(`<path class="lane-bar" d="M${n(left)} 0V${height}"/><text class="lane-bar-label" x="${n(left + 6)}" y="14">${index + 1}${m.label ? ` · ${xml(m.label)}` : ''}</text>`);
    if (!bar || bar.coverage === 'unstarted') bits.push(`<rect class="lane-unstarted" x="${n(left)}" y="20" width="${n(right - left)}" height="${height - 20}"/>`);
    for (let q = grid; q < number(m.length) - 1e-9; q += grid) {
      const x = qx(start + q), beat = Math.abs(q - Math.round(q)) < 1e-9;
      bits.push(`<path class="${beat ? 'lane-beat' : 'lane-grid'}" d="M${n(x)} 20V${height}"/>`);
    }
    for (const hit of bar?.hits || []) {
      const row = rowOf.get(hit.instrument);
      if (row == null) continue;
      const x = qx(start + number(hit.offset)), y = LANE_TOP + row * LANE_HEIGHT + LANE_HEIGHT / 2, on = selected.has(hit.id);
      const cls = ['lane-hit', on ? 'is-selected' : '', hit.ghost ? 'is-ghost' : '', hit.accent || hit.heavy ? 'is-accent' : ''].filter(Boolean).join(' ');
      bits.push(`<rect class="${cls}" x="${n(x - 1)}" y="${n(y - 8)}" rx="3" width="12" height="16"/>`);
      if (hit.flam || hit.drag) bits.push(`<circle class="lane-grace${on ? ' is-selected' : ''}" cx="${n(x - 6)}" cy="${n(y)}" r="2.2"/>`);
      if (hit.roll) bits.push(`<path class="lane-roll" d="M${n(x + 2)} ${n(y + 4)}l7 -8"/>`);
      targets.push({hit, index, x, y, right: x + 11});
    }
  }
  if (cursor != null) bits.push(`<path class="lane-cursor" d="M${n(qx(cursor))} 20V${height}"/>`);
  bits.push('</svg>');
  host.innerHTML = bits.join('');
  return {targets, bars, qx, height};
}
