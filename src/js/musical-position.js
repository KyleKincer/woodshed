// Number actual downbeats rather than assuming every bar is 4/4. A pickup
// before the first downbeat remains unnumbered; partial final bars still count.
export function buildBarIndex(beats) {
  let bar = 0, beat = 0;
  const entries = beats.map(entry => {
    if (entry.downbeat) { bar++; beat = 0; }
    beat++;
    return { time: entry.time, bar, beat };
  });
  return { entries, total: bar };
}

export function barPosition({entries}, time) {
  let lo = 0, hi = entries.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (entries[mid].time <= time + 1e-6) lo = mid + 1;
    else hi = mid;
  }
  return entries[lo - 1] || {bar: 0, beat: 0};
}
