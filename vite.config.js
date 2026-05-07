import { defineConfig } from 'vite';
import { resolve } from 'path';

// Vite config: use /src as the project root so the three HTML pages
// (index.html, worker.html, dashboard.html) live next to each other.
// We still load env vars from the repo root (envDir below) so .env can sit
// at the top of the project rather than inside /src.
export default defineConfig({
  root: 'src',
  envDir: resolve(__dirname),
  publicDir: resolve(__dirname, 'public'),
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'src/index.html'),
        worker: resolve(__dirname, 'src/worker.html'),
        dashboard: resolve(__dirname, 'src/dashboard.html'),
      },
    },
  },
  server: {
    host: true,
    port: 5173,
  },
});
