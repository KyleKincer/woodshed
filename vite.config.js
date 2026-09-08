import { defineConfig } from 'vite';
import downloads from './api/downloads.js';

// Plain-JS app: no framework plugin needed. The existing renderer code is
// already native ES modules, so Vite is doing bundling + env injection only.
export default defineConfig({
  plugins: [{name:'download-api',configureServer(server) {
    server.middlewares.use('/api/downloads', (req,res) => {
      res.status = code => { res.statusCode=code;return res; };
      res.json = data => { res.setHeader('Content-Type','application/json');res.end(JSON.stringify(data)); };
      void downloads(req,res);
    });
  }}],
  server: { port: 5173, strictPort: true },
  build: {
    outDir: 'dist',
    // Stems are decoded in a Worker-free main-thread path today; keep the
    // bundle simple and debuggable.
    sourcemap: true,
  },
});
