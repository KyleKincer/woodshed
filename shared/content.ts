/** Compare persisted JSON values by content, independently of object key order. */
export function sameContent(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, i) => sameContent(value, b[i]));
  }
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.prototype.hasOwnProperty.call(right, key) && sameContent(left[key], right[key]));
}
