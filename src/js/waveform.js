// Compute min/max peaks from an AudioBuffer and paint them on a canvas.

export function computePeaks(buffer, width) {
  return computePeaksRange(buffer, 0, buffer.duration, width);
}

// Min/max peaks for a time window [startSec, endSec], reduced to `width` bins.
// Lets us re-render the waveform at any zoom level straight from the buffer.
export function computePeaksRange(buffer, startSec, endSec, width) {
  const sr = buffer.sampleRate;
  const ch0 = buffer.getChannelData(0);
  const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;
  const startSample = Math.max(0, Math.floor(startSec * sr));
  const endSample = Math.min(buffer.length, Math.ceil(endSec * sr));
  const total = Math.max(1, endSample - startSample);
  const samplesPerBin = Math.max(1, total / width);
  const peaks = new Float32Array(width * 2); // [min,max] per bin
  for (let x = 0; x < width; x++) {
    let min = 1.0, max = -1.0;
    const start = startSample + Math.floor(x * samplesPerBin);
    const end = Math.min(startSample + Math.floor((x + 1) * samplesPerBin), endSample);
    for (let i = start; i < end; i++) {
      let v = ch0[i];
      if (ch1) v = (v + ch1[i]) * 0.5;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (min > max) { min = 0; max = 0; }
    peaks[x * 2] = min;
    peaks[x * 2 + 1] = max;
  }
  return peaks;
}

export function drawWaveform(canvas, peaks, color, opts = {}) {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, cssW, cssH);

  const mid = cssH / 2;
  const bins = peaks.length / 2;
  const step = cssW / bins;

  ctx.fillStyle = color;
  ctx.globalAlpha = opts.dim ? 0.28 : 1;
  for (let x = 0; x < bins; x++) {
    const min = peaks[x * 2];
    const max = peaks[x * 2 + 1];
    const y1 = mid - max * mid * 0.92;
    const y2 = mid - min * mid * 0.92;
    ctx.fillRect(x * step, y1, Math.max(step, 1), Math.max(y2 - y1, 1));
  }
  ctx.globalAlpha = 1;
}
