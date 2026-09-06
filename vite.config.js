import { defineConfig } from 'vite';

// Plain-JS app: no framework plugin needed. The existing renderer code is
// already native ES modules, so Vite is doing bundling + env injection only.
export default defineConfig({
  server: { port: 5173, strictPort: true },
  build: {
    outDir: 'dist',
    // Stems are decoded in a Worker-free main-thread path today; keep the
    // bundle simple and debuggable.
    sourcemap: true,
  },
});
