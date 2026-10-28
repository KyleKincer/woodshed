// Harness discovery and the harness page (architecture §11.2). Used by the
// fixture's Vite plugin (vite.config.mjs) and its tests.
//
// A harness is a file `tests/harness/**/<name>.harness.js` (the packages'
// harnesses) or `tests/fixture/harness/<name>.harness.js` (the fixture's own),
// exporting `default async function mount(el, {fixture, query, h})`. It is
// served at /__harness/<name>, where <name> is the file's basename; two files
// with one basename are an error, reported on the index page and for that name.
// /__harness/ lists every harness.
import {readdirSync, existsSync} from 'node:fs';
import path from 'node:path';

export const HARNESS_ROOTS = ['tests/harness', 'tests/fixture/harness'];
export const HARNESS_SUFFIX = '.harness.js';
export const HARNESS_NAME = /^[a-z0-9][a-z0-9-]*$/;

function walk(dir, recursive, out) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, {withFileTypes: true})) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (recursive) walk(full, recursive, out); }
    else if (entry.name.endsWith(HARNESS_SUFFIX)) out.push(full);
  }
  return out;
}

/**
 * {harnesses: Map<name, repoRelativePath>, duplicates: Map<name, path[]>, invalid: path[]}
 * for the repository at `root`.
 */
export function findHarnesses(root) {
  const files = [];
  walk(path.join(root, HARNESS_ROOTS[0]), true, files);
  walk(path.join(root, HARNESS_ROOTS[1]), false, files);
  const byName = new Map(), invalid = [];
  for (const file of files.sort()) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    const name = path.basename(file, HARNESS_SUFFIX);
    if (!HARNESS_NAME.test(name)) { invalid.push(rel); continue; }
    byName.set(name, [...(byName.get(name) ?? []), rel]);
  }
  const harnesses = new Map(), duplicates = new Map();
  for (const [name, paths] of byName) (paths.length === 1 ? harnesses.set(name, paths[0]) : duplicates.set(name, paths));
  return {harnesses, duplicates, invalid};
}

const escape = s => String(s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));

/** The page for one harness: the host module mounts it into <main id="harness">. */
export function harnessPage(name) {
  return `<!doctype html>
<html lang="en" data-harness="${escape(name)}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>${escape(name)} · harness</title>
  <style>#harness { height: 100%; overflow: auto; padding: var(--s5); }</style>
</head>
<body>
  <main id="harness" data-scroller aria-label="${escape(name)} harness"></main>
  <script type="module" src="/tests/fixture/harness/host.js"></script>
</body>
</html>
`;
}

/** The /__harness/ index, or the error page for an unknown or ambiguous name. */
export function harnessIndex({harnesses, duplicates, invalid}, {missing} = {}) {
  const items = [...harnesses].map(([name, file]) => `<li><a href="/__harness/${escape(name)}">${escape(name)}</a> <code>${escape(file)}</code></li>`).join('\n      ');
  const problems = [
    ...(missing ? [`No harness is named “${escape(missing)}”.`] : []),
    ...[...duplicates].map(([name, files]) => `“${escape(name)}” is defined twice: ${files.map(escape).join(', ')}.`),
    ...invalid.map(file => `${escape(file)}: a harness name is lower-case letters, digits and dashes.`),
  ];
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Harnesses</title></head>
<body>
  <main>
    <h1>Harnesses</h1>
    ${problems.length ? `<ul role="alert">${problems.map(p => `<li>${p}</li>`).join('')}</ul>` : ''}
    ${harnesses.size ? `<ul>\n      ${items}\n    </ul>` : '<p>No harness files yet.</p>'}
  </main>
</body>
</html>
`;
}
