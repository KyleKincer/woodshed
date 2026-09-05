// AudioBuffers can be reused by a new AudioContext. Keep recently decoded
// stems by immutable object key and sample rate, with a strict memory bound.
export class DecodedStemCache {
  constructor(maxBytes) {
    this.maxBytes = maxBytes;
    this.bytes = 0;
    this.entries = new Map();
    this.generation = 0;
  }
  async load(key, sampleRate, decode) {
    const cacheKey = JSON.stringify([key, sampleRate]);
    const hit = this.entries.get(cacheKey);
    if (hit) {
      this.entries.delete(cacheKey);
      this.entries.set(cacheKey, hit);
      return hit.buffer;
    }
    const generation = this.generation;
    const buffer = await decode();
    const bytes = buffer.length * buffer.numberOfChannels * Float32Array.BYTES_PER_ELEMENT;
    if (generation !== this.generation || bytes > this.maxBytes) return buffer;
    const previous = this.entries.get(cacheKey);
    if (previous) { this.bytes -= previous.bytes; this.entries.delete(cacheKey); }
    while (this.bytes + bytes > this.maxBytes && this.entries.size) {
      const oldest = this.entries.keys().next().value;
      this.bytes -= this.entries.get(oldest).bytes;
      this.entries.delete(oldest);
    }
    this.entries.set(cacheKey, {buffer, bytes});
    this.bytes += bytes;
    return buffer;
  }
  clear() {
    this.generation++;
    this.entries.clear();
    this.bytes = 0;
  }
}
const smallDevice = typeof navigator !== 'undefined' && (
  (navigator.deviceMemory && navigator.deviceMemory <= 4) ||
  (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches)
);
export const decodedStemCache = new DecodedStemCache((smallDevice ? 128 : 512) * 1024 * 1024);
