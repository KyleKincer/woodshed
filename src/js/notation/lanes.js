// Drum lanes: an event grid aligned to the recording's time, one row per kit
// piece in use. Notes are onsets, drawn as fixed markers; written rhythm lives
// in the score view.
import {KIT, number, starts, toTime} from '../../../shared/notation.ts';
import {xml} from './html.js';

export const LANE_HEIGHT = 28, LANE_TOP = 26;
/** Rows to show: pieces with notes, the core kit, and the current piece, in staff order. */
export function laneRows(score, {piece = null, all = false} = {}) {
  if (all) return KIT.map(k => k.id);
  const used = new Set(score.bars.flatMap(b => b.hits.map(h => h.instrument)));
  return KIT.filter(k => k.core || used.has(k.id) || k.id === piece).map(k => k.id);
}

export function renderLanes(host, {score, indices, width, timeRange, selected, cursor, grid = .25, rows}) {
  const positions = starts(score.timeline), height = rows.length * LANE_HEIGHT + LANE_TOP + 8;
  const qx = q => (toTime(score.timeline, q) - timeRange.start) / (timeRange.end - timeRange.start) * width;
  const targets = [], bars = [], rowOf = new Map(rows.map((id, i) => [id, i]));
  const bits = [`<svg width="${width}" height="${height}" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">`];
  rows.forEach((id, row) => { const y = LANE_TOP + row * LANE_HEIGHT; bits.push(`<path d="M0 ${y + LANE_HEIGHT / 2}H${width}" stroke="var(--border)" opacity=".5"/>`); });
  for (const index of indices) {
    const m = score.timeline.measures[index], start = positions[index], left = qx(start), right = qx(start + number(m.length));
    bars.push({index, left, right});
    const bar = score.bars.find(b => b.measureId === m.id);
    bits.push(`<path d="M${left} 0V${height}" stroke="var(--border)"/><text x="${left + 6}" y="14" fill="var(--muted)" font-size="11">${index + 1}${m.label ? ` · ${xml(m.label)}` : ''}</text>`);
    if (!bar || bar.coverage === 'unstarted') bits.push(`<rect x="${left}" y="20" width="${right - left}" height="${height - 20}" fill="var(--grid-minor)"/>`);
    for (let q = grid; q < number(m.length) - 1e-9; q += grid) { const x = qx(start + q); bits.push(`<path d="M${x} 20V${height}" stroke="var(--grid-minor)"${Math.abs(q - Math.round(q)) < 1e-9 ? ' stroke-width="2"' : ''}/>`); }
    for (const hit of bar?.hits || []) {
      const row = rowOf.get(hit.instrument);
      if (row == null) continue;
      const x = qx(start + number(hit.offset)), y = LANE_TOP + row * LANE_HEIGHT + LANE_HEIGHT / 2, on = selected.has(hit.id);
      const fill = hit.ghost ? 'var(--bg-2)' : on ? 'var(--accent)' : 'var(--drums)', stroke = on ? 'var(--accent)' : 'var(--drums)';
      bits.push(`<rect x="${x - 1}" y="${y - 8}" rx="3" width="12" height="16" fill="${fill}" stroke="${stroke}" stroke-width="${hit.accent || hit.heavy ? 3 : 1}"/>`);
      if (hit.flam || hit.drag) bits.push(`<circle cx="${x - 6}" cy="${y}" r="2.2" fill="${stroke}"/>`);
      if (hit.roll) bits.push(`<path d="M${x + 2} ${y + 4}l7 -8" stroke="var(--bg)" stroke-width="1.5"/>`);
      targets.push({hit, index, x, y, right: x + 11});
    }
  }
  if (cursor != null) bits.push(`<path d="M${qx(cursor)} 20V${height}" stroke="var(--accent)" stroke-dasharray="4 3"/>`);
  bits.push('</svg>');
  host.innerHTML = bits.join('');
  return {targets, bars, qx, height};
}
