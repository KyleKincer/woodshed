// Full-app development fixture: the real index.html and app modules, with the
// Convex client, Convex Auth and the local processor replaced by in-memory
// stand-ins.
//   npm run fixture   (or: npx vite --config tests/fixture/vite.config.mjs)
// The port is FIXTURE_PORT (default 5190; a package worktree's .env.worktree
// sets it), or --port on the command line. Each port gets its own Vite cache,
// tests/fixture/.vite-cache/<port>, so several fixture servers run side by side.
import {fileURLToPath} from 'node:url';
import {existsSync, readFileSync} from 'node:fs';
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
    transformIndexHtml(html) {
      // Vite may append ?t= to app.js after an edit, so match the prefix.
      return html.replace(/<script type="module" src="\/src\/js\/app\.js/,
        m => `<script type="module" src="/@fs${path.join(here, 'preamble.js')}"></script>\n  ${m}`);
    },
  }],
  optimizeDeps: {exclude: ['convex/browser', '@convex-dev/auth']},
  server: {port, strictPort: true, host: '127.0.0.1', fs: {allow: [repo, here]}},
};
