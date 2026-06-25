import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'src/client',
  plugins: [react()],
  build: {
    outDir: '../../dist/client',
    emptyOutDir: true,
  },
  server: {
    port: 5177,
    proxy: {
      // /api -> daemon; /ws -> pty-host directly (daemon port + 1). Routing the
      // terminal socket straight to the host means daemon restarts don't touch
      // live terminals — the running session stays connected.
      '/api': 'http://127.0.0.1:4317',
      '/ws': {
        target: 'ws://127.0.0.1:4318',
        ws: true,
      },
    },
  },
});
