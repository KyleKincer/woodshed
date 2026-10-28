// Full-app development fixture: the real index.html and app modules, with the
// Convex client, Convex Auth and the local processor replaced by in-memory
// stand-ins.
//   npm run fixture   (or: npx vite --config tests/fixture/vite.config.mjs --port 5190)
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const stub = name => path.join(here, 'stubs', name);
export default {
  root: repo,
  envDir: here,
  cacheDir: path.join(here, '.vite-cache'),
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
  server: {strictPort: true, host: '127.0.0.1', fs: {allow: [repo, here]}},
};
