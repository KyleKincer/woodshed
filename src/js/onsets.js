// Percussive onsets from a decoded stem, used to tighten keyboard taps and to line imported charts up
// (src/js/chart-align.js). Energy flux on a high-passed signal with an adaptive threshold: cheap enough
// to run on the main thread for a whole song. A frame's rise comes from the newest hop entering its
// window, which places the onset near the window end.
//
//   detectOnsets(buffer, {hop, window}) → [seconds]                       the picked onsets
//   onsetStrength(buffer, {hop, window}) → {rate, start, values}          the flux itself: values[i] is the
//                                                                          rise at start + i / rate seconds

/** The energy flux of `buffer`, one value per hop (frame f's rise is placed at frameTime(f)). */
function fluxOf(buffer, {hop, window}) {
  const rate = buffer.sampleRate, channels = Math.min(2, buffer.numberOfChannels);
  const data = Array.from({length: channels}, (_, c) => buffer.getChannelData(c));
  const frames = Math.max(0, Math.floor((buffer.length - window) / hop));
  const energy = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const start = f * hop;
    for (let i = start + 1; i < start + window; i += 2) {
      for (let c = 0; c < channels; c++) { const d = data[c][i] - data[c][i - 1]; sum += d * d; }
    }
    energy[f] = Math.log1p(sum * 1000);
  }
  const flux = new Float32Array(frames);
  for (let f = 1; f < frames; f++) flux[f] = Math.max(0, energy[f] - energy[f - 1]);
  return {flux, frames, rate, frameTime: f => (f * hop + window - hop / 2) / rate};
}

export function detectOnsets(buffer, {hop = 128, window = 512} = {}) {
  if (!buffer?.length || !buffer.getChannelData) return [];
  const {flux, frames, rate, frameTime} = fluxOf(buffer, {hop, window});
  const onsets = [], span = 16;
  let lastFrame = -Infinity;
  for (let f = 1; f < frames - 1; f++) {
    if (flux[f] < flux[f - 1] || flux[f] < flux[f + 1]) continue;
    let mean = 0, count = 0;
    for (let k = Math.max(0, f - span); k < Math.min(frames, f + span); k++) { mean += flux[k]; count++; }
    mean /= count;
    if (flux[f] > mean * 1.6 + 0.05 && f - lastFrame > 0.04 * rate / hop) { onsets.push(frameTime(f)); lastFrame = f; }
  }
  return onsets;
}

/** The flux as a strength curve (see the header); null for a missing or empty buffer. */
export function onsetStrength(buffer, {hop = 128, window = 512} = {}) {
  if (!buffer?.length || !buffer.getChannelData) return null;
  const {flux, frameTime} = fluxOf(buffer, {hop, window});
  return {rate: buffer.sampleRate / hop, start: frameTime(0), values: flux};
}

/** Nearest onset to `time` within `tolerance` seconds, or null. */
export function nearestOnset(onsets, time, tolerance) {
  let low = 0, high = onsets.length;
  while (low < high) { const mid = (low + high) >> 1; if (onsets[mid] < time) low = mid + 1; else high = mid; }
  let best = null, distance = tolerance;
  for (const i of [low - 1, low]) if (i >= 0 && i < onsets.length && Math.abs(onsets[i] - time) <= distance) { best = onsets[i]; distance = Math.abs(onsets[i] - time); }
  return best;
}
