// Development fixture: the real player against an in-memory backend.
// npx vite --config tests/fixtures/tempo-map.vite.config.js, then open /tests/fixtures/tempo-map.html
import {defineConfig} from 'vite';
import {fileURLToPath} from 'node:url';
const stub = fileURLToPath(new URL('./backend.js', import.meta.url));
const store = fileURLToPath(new URL('./notation-store.js', import.meta.url));
export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  plugins: [{name: 'fixture-backend', enforce: 'pre', resolveId(source, importer) {
    if (!importer || importer.includes('/tests/fixtures/')) return;
    if (/(^|\/)backend\.js$/.test(source)) return stub;
    if (importer.includes('/notation/') && /^\.\/store\.js$/.test(source)) return store;
  }}],
  server: {port: 5174, strictPort: true},
});
