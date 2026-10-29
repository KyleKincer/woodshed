// Every song-map edit names a reason from REASON_ORIGIN (architecture §4.2, §10.1).
// This scans src/**/*.js statically for `.edit(`, `.replace(`, `.replaceFromBeats(`
// and `.replaceFromTimeline(` calls whose reason (the second argument) is a
// string literal; integrations re-run it whenever new map editors land.
import {describe, expect, test} from 'vitest';
import {readdirSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {REASON_ORIGIN} from '../src/js/song-map.js';
import {ORIGINS} from '../shared/song-map.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CALL = /\.(edit|replace|replaceFromBeats|replaceFromTimeline)\s*\(/g;
const REGEX_BEFORE = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);

/** Reads one call's arguments (comments already stripped) from the index just after its "("; strings, templates and regexes stay intact. */
export function readArguments(source, start) {
  const args = [];
  let depth = 0, from = start, i = start, last = '(';
  const skipString = (quote) => { for (i++; i < source.length; i++) { if (source[i] === '\\') i++; else if (source[i] === quote) return; } };
  const skipTemplate = () => {
    for (i++; i < source.length; i++) {
      if (source[i] === '\\') i++;
      else if (source[i] === '`') return;
      else if (source[i] === '$' && source[i + 1] === '{') {
        let inner = 1;
        for (i += 2; i < source.length && inner; i++) {
          const c = source[i];
          if (c === '{') inner++;
          else if (c === '}') inner--;
          else if (c === '\'' || c === '"') skipString(c);
          else if (c === '`') skipTemplate();
        }
        i--;
      }
    }
  };
  const skipRegex = () => { let cls = false; for (i++; i < source.length; i++) { const c = source[i]; if (c === '\\') i++; else if (c === '[') cls = true; else if (c === ']') cls = false; else if (c === '/' && !cls) return; } };
  for (; i < source.length; i++) {
    const c = source[i];
    if (c === '\'' || c === '"') skipString(c);
    else if (c === '`') skipTemplate();
    else if (c === '/' && REGEX_BEFORE.has(last)) skipRegex();
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) { const tail = source.slice(from, i).trim(); if (tail || args.length) args.push(tail); return {args, end: i}; }
      depth--;
    } else if (c === ',' && depth === 0) { args.push(source.slice(from, i).trim()); from = i + 1; }
    if (!/\s/.test(c)) last = /[\w$)\]'"`]/.test(c) ? 'x' : c;
  }
  return {args, end: source.length};
}

const literal = (arg) => /^(['"])([^'"\\\n]*)\1$/.exec(arg)?.[2] ?? /^`([^`$\\\n]*)`$/.exec(arg)?.[1] ?? null;
/** `String.prototype.replace` takes a regex, a string or a RegExp first; map `replace` takes a map. */
const stringReplace = (args) => !!args[0] && (/^[/'"`]/.test(args[0]) || /^new\s+RegExp\b/.test(args[0]));

/** Blanks out comments (keeping newlines, strings, templates and regexes), so commented-out calls are not scanned. */
export function stripComments(source) {
  let out = '', i = 0, last = '';
  const copyQuoted = (quote) => { const start = i; for (i++; i < source.length; i++) { if (source[i] === '\\') i++; else if (source[i] === quote) break; } out += source.slice(start, i + 1); };
  const copyRegex = () => { const start = i; let cls = false; for (i++; i < source.length; i++) { const c = source[i]; if (c === '\\') i++; else if (c === '[') cls = true; else if (c === ']') cls = false; else if (c === '/' && !cls) break; } out += source.slice(start, i + 1); };
  for (; i < source.length; i++) {
    const c = source[i];
    if (c === '/' && source[i + 1] === '/') { const end = source.indexOf('\n', i); const stop = end < 0 ? source.length : end; out += ' '.repeat(stop - i); i = stop - 1; continue; }
    if (c === '/' && source[i + 1] === '*') { const end = source.indexOf('*/', i + 2), stop = end < 0 ? source.length : end + 2; out += source.slice(i, stop).replace(/[^\n]/g, ' '); i = stop - 1; continue; }
    if (c === '\'' || c === '"' || c === '`') copyQuoted(c);
    else if (c === '/' && REGEX_BEFORE.has(last)) copyRegex();
    else out += c;
    if (!/\s/.test(c)) last = /[\w$)\]'"`]/.test(c) ? 'x' : c;
  }
  return out;
}

function* mapCalls(text) {
  const source = stripComments(text);
  for (const match of source.matchAll(CALL)) {
    const method = match[1], {args} = readArguments(source, match.index + match[0].length);
    if (method === 'replace' && stringReplace(args)) continue;
    yield {method, args, line: source.slice(0, match.index).split('\n').length};
  }
}

/** Every map-edit call in a source text with a string-literal reason: [{method, reason, line}]. */
export function scanReasons(text) {
  const found = [];
  for (const {method, args, line} of mapCalls(text)) {
    const reason = args.length > 1 ? literal(args[1]) : null;
    if (reason !== null) found.push({method, reason, line});
  }
  return found;
}

/**
 * `.edit(` calls that pass no reason at all (§4.2: every call names one). The
 * store still defaults to 'edit' only for the unowned legacy
 * tests/notation-songmap.test.js; src/ must never rely on it.
 */
export function scanMissingReasons(text) {
  const found = [];
  for (const {method, args, line} of mapCalls(text)) if (method === 'edit' && args.length < 2) found.push({method, line});
  return found;
}

function sourceFiles(dir) {
  return readdirSync(dir, {withFileTypes: true}).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

describe('the scanner', () => {
  test('finds literal reasons and skips string replaces, comments, regexes and templates', () => {
    const source = [
      "songMap.edit((d) => { d.label = 'a, b'; }, 'pin');",
      "map.replace(next, \"tempo-source\");",
      "store.replaceFromBeats(beats.map((b) => ({...b, t: `x,${y(1, 2)}`})), 'detect');",
      "map.replaceFromTimeline(timeline, `part-fit`);",
      "name.replace('no_', 'no ');",
      "text.replace(/[,)]/g, 'x');",
      "text.replace(new RegExp(',', 'g'), 'y');",
      "map.edit(change, reason);",
      "map.edit(change);",
      "// map.edit(change, 'commented');",
      "map.edit((d) => d.pins.filter((p) => /x\\/(/.test(p)), /* ) */ 'drag', {linked});",
    ].join('\n');
    expect(scanReasons(source)).toEqual([
      {method: 'edit', reason: 'pin', line: 1},
      {method: 'replace', reason: 'tempo-source', line: 2},
      {method: 'replaceFromBeats', reason: 'detect', line: 3},
      {method: 'replaceFromTimeline', reason: 'part-fit', line: 4},
      {method: 'edit', reason: 'drag', line: 11},
    ]);
  });
  test('an edit with no reason is reported', () => {
    expect(scanMissingReasons(["map.edit(change);", "map.edit(change, reason);", "map.edit((d) => { d.x = f(a, b); });", "s.replace(/x/, 'y');"].join('\n')))
      .toEqual([{method: 'edit', line: 1}, {method: 'edit', line: 3}]);
  });
  test('an unknown reason is reported', () => {
    const found = scanReasons("map.edit((d) => {}, 'shuffle');").filter((c) => !(c.reason in REASON_ORIGIN));
    expect(found).toEqual([{method: 'edit', reason: 'shuffle', line: 1}]);
  });
});

describe('REASON_ORIGIN', () => {
  test('is exhaustive and maps every reason to a known origin or to "keep"', () => {
    expect(Object.keys(REASON_ORIGIN).sort()).toEqual(['adopt', 'bar', 'detect', 'drag', 'edit', 'label', 'meter', 'nudge', 'part-fit', 'pin', 'ramp',
      'renumber', 'restore', 'scale', 'sections', 'tap', 'tapBeat', 'tempo', 'tempo-source', 'tempo-source-cancel', 'timeline', 'unpin'].sort());
    for (const origin of Object.values(REASON_ORIGIN)) expect(origin === null || ORIGINS.includes(origin)).toBe(true);
    expect(Object.isFrozen(REASON_ORIGIN)).toBe(true);
  });
  test('every map-edit call in src/**/*.js uses a reason from the table', () => {
    const unknown = [];
    let scanned = 0;
    for (const file of sourceFiles(path.join(ROOT, 'src'))) {
      const source = readFileSync(file, 'utf8');
      for (const call of scanReasons(source)) {
        scanned++;
        if (!Object.prototype.hasOwnProperty.call(REASON_ORIGIN, call.reason)) unknown.push(`${path.relative(ROOT, file)}:${call.line} .${call.method}(…, '${call.reason}')`);
      }
    }
    expect(unknown).toEqual([]);
    expect(scanned).toBeGreaterThan(0);
  });
  test('no map edit in src/**/*.js relies on the default reason', () => {
    const missing = sourceFiles(path.join(ROOT, 'src')).flatMap((file) =>
      scanMissingReasons(readFileSync(file, 'utf8')).map((call) => `${path.relative(ROOT, file)}:${call.line} .${call.method}(…) has no reason`));
    expect(missing).toEqual([]);
  });
});
