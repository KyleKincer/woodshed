// Full-app development fixture (architecture §11.2): the real index.html and
// app modules, with the Convex client, Convex Auth and the local processor
// replaced by in-memory stand-ins, plus the harness host.
//   npm run fixture   (or: npx vite --config tests/fixture/vite.config.mjs)
// The port is FIXTURE_PORT (default 5190; a package worktree's .env.worktree
// sets it), or --port on the command line. Each port gets its own Vite cache,
// tests/fixture/.vite-cache/<port>, so several fixture servers run side by side.
//
// The plugin:
//   - resolves convex/browser, @convex-dev/auth/browser and the OAuth provider
//     to tests/fixture/stubs/*, which route every call to tests/fixture/db;
//   - puts two scripts first in <head> of index.html and of every harness page:
//     /__fixture/early.js (classic: storage switches and fx-now, before
//     theme-init) and tests/fixture/preamble.js (the first module: db and fakes);
//   - serves /__harness/ (the list) and /__harness/<name> (lib/harness.mjs).
import {fileURLToPath} from 'node:url';
import {existsSync, readFileSync} from 'node:fs';
import {findHarnesses, harnessPage, harnessIndex} from './lib/harness.mjs';
import path from 'node:path';
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const DEFAULT_PORT = 5190;
function worktreePort() {
  const file = path.join(repo, '.env.worktree');
  if (!existsSync(file)) return undefined;
  return /^\s*FIXTURE_PORT\s*=\s*(\d+)\s*$/m.exec(readFileSync(file, 'utf8'))?.[1];
}
function cliPort(argv) {
  const i = argv.findIndex(a => a === '--port' || a.startsWith('--port='));
  if (i < 0) return undefined;
  return argv[i].includes('=') ? argv[i].split('=')[1] : argv[i + 1];
}
function toPort(value, source) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`fixture: bad port ${JSON.stringify(value)} from ${source}`);
  return n;
}
const port = cliPort(process.argv) !== undefined ? toPort(cliPort(process.argv), '--port')
  : process.env.FIXTURE_PORT ? toPort(process.env.FIXTURE_PORT, 'FIXTURE_PORT')
  : worktreePort() !== undefined ? toPort(worktreePort(), '.env.worktree')
  : DEFAULT_PORT;
const stub = name => path.join(here, 'stubs', name);
const EARLY_URL = '/__fixture/early.js';
export default {
  root: repo,
  envDir: here,
  cacheDir: path.join(here, '.vite-cache', String(port)),
  clearScreen: false,
  define: {'import.meta.env.VITE_CONVEX_URL': JSON.stringify('https://fixture.convex.invalid')},
  plugins: [{
    name: 'woodshed-fixture', enforce: 'pre',
    resolveId(source, importer) {
      if (!importer || importer.startsWith(here)) return;
      if (source === 'convex/browser') return stub('convex-browser.js');
      if (source === '@convex-dev/auth/browser') return stub('convex-auth.js');
      if (source === '@convex-dev/auth/providers/oauth/react') return stub('oauth.js');
    },
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        // The app's index.html (any route Vite answers with it) and the harness pages.
        if (ctx.filename !== path.join(repo, 'index.html') && !html.includes('data-harness=')) return;
        return [
          {tag: 'script', attrs: {src: EARLY_URL}, injectTo: 'head-prepend'},
          {tag: 'script', attrs: {type: 'module', src: `/@fs${path.join(here, 'preamble.js')}`}, injectTo: 'head-prepend'},
        ];
      },
    },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url, 'http://fixture.invalid');
        if (url.pathname === EARLY_URL) {
          res.setHeader('content-type', 'text/javascript; charset=utf-8');
          res.setHeader('cache-control', 'no-store');
          res.end(readFileSync(path.join(here, 'early.js'), 'utf8'));
          return;
        }
        const m = /^\/__harness(?:\/([^/]*))?\/?$/.exec(url.pathname);
        if (!m) return next();
        const found = findHarnesses(repo);
        const name = decodeURIComponent(m[1] ?? '');
        const send = (status, html) => { res.statusCode = status; res.setHeader('content-type', 'text/html; charset=utf-8'); res.setHeader('cache-control', 'no-store'); res.end(html); };
        try {
          if (!name) return send(200, harnessIndex(found));
          if (!found.harnesses.has(name)) return send(404, harnessIndex(found, {missing: found.duplicates.has(name) ? null : name}));
          send(200, await server.transformIndexHtml(req.url, harnessPage(name), req.originalUrl));
        } catch (error) { next(error); }
      });
    },
  }],
  optimizeDeps: {exclude: ['convex/browser', '@convex-dev/auth']},
  server: {port, strictPort: true, host: '127.0.0.1', fs: {allow: [repo, here]}},
};
