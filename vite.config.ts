import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
export default defineConfig({
  root: 'web',
  plugins: [
    react(),
    {
      name: 'local-onnx-runtime',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const match = req.url?.split('?')[0].match(/^\/vendor\/ort\/([a-z0-9.-]+\.mjs)$/i);
          if (!match) return next();
          try {
            const source = readFileSync(path.resolve('web/public/vendor/ort', match[1]));
            res.setHeader('Content-Type', 'text/javascript');
            res.end(source);
          } catch {
            res.statusCode = 404;
            res.end();
          }
        });
      },
    },
  ],
  build: { outDir: '../dist/web', emptyOutDir: true },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:3001',
      '/control': { target: 'ws://127.0.0.1:3001', ws: true },
    },
  },
});
