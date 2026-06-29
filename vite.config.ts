import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// Skip HMR for a module while it carries merge conflict markers — applying a
// half-merged module would error the client. Keep the last-good version loaded and
// resume normal HMR once the merge is resolved (mirrors the daemon's reload guard).
function skipHmrOnConflictMarkers(): Plugin {
  const open = /^<{7}[ \t]/m;
  const close = /^>{7}[ \t]/m;
  return {
    name: 'devrooms:skip-hmr-on-conflict-markers',
    async handleHotUpdate(ctx) {
      let text = '';
      try { text = await ctx.read(); } catch { return; }
      if (open.test(text) && close.test(text)) {
        ctx.server.config.logger.warn(`[devrooms] merge conflict markers in ${ctx.file} — HMR paused until resolved`);
        return []; // no modules to update: keep the last good one loaded
      }
    },
  };
}

export default defineConfig({
  root: 'src/client',
  plugins: [react(), skipHmrOnConflictMarkers()],
  build: {
    outDir: '../../dist/client',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Split stable vendors into their own chunks so an app-code edit doesn't invalidate
        // react/xterm in the browser cache (paired with the immutable headers the daemon now
        // sends for assets/), and so chunks can fetch in parallel. highlight.js is
        // intentionally NOT listed — it is a lazy dynamic import with its own chunk.
        manualChunks: {
          react: ['react', 'react-dom', 'react/jsx-runtime'],
          xterm: ['@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-webgl'],
        },
      },
    },
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
