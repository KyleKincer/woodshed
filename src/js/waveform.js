// Compute min/max peaks from an AudioBuffer and paint them on a canvas.

export function computePeaks(buffer, width) {
  return computePeaksRange(buffer, 0, buffer.duration, width);
}

// Min/max peaks for a time window [startSec, endSec], reduced to `width` bins.
// Lets us re-render the waveform at any zoom level straight from the buffer.
// Stereo is mixed to mono ((L + R) / 2). Each bin is a [min, max] pair; an empty
// bin (past the end of the buffer) is [0, 0].
//   {samplesPerBin}  an exact whole number of samples per bin, from the window's
//                    first sample (bin x covers start + x·n … start + (x+1)·n,
//                    clipped to the window). src/stage/wave-render.js builds its
//                    peak pyramid with it. Without it the window is split evenly.
export function computePeaksRange(buffer, startSec, endSec, width, {samplesPerBin} = {}) {
  const sr = buffer.sampleRate;
  const ch0 = buffer.getChannelData(0);
  const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;
  const startSample = Math.max(0, Math.floor(startSec * sr));
  const endSample = Math.min(buffer.length, Math.ceil(endSec * sr));
  const total = Math.max(1, endSample - startSample);
  const step = samplesPerBin > 0 ? Math.max(1, Math.round(samplesPerBin)) : Math.max(1, total / width);
  const peaks = new Float32Array(width * 2); // [min,max] per bin
  for (let x = 0; x < width; x++) {
    let min = 1.0, max = -1.0;
    const start = startSample + Math.floor(x * step);
    const end = Math.min(startSample + Math.floor((x + 1) * step), endSample);
    if (ch1) {
      for (let i = start; i < end; i++) {
        const v = (ch0[i] + ch1[i]) * 0.5;
        if (v < min) min = v;
        if (v > max) max = v;
      }
    } else {
      for (let i = start; i < end; i++) {
        const v = ch0[i];
        if (v < min) min = v;
        if (v > max) max = v;
      }
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
