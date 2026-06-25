import { execSync } from 'node:child_process';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

// Prevent devrooms dev processes from piling up across launches.
//
// Each launcher calls these on startup to kill any *previous* instance for this
// repo before starting a fresh one. They're deliberately scoped so they can
// never match the launcher itself:
//   - the daemon/vite kills target TCP ports we have not bound yet
//   - the electron/watch kills are pattern-matched to this repo's paths, and a
//     `node scripts/dev-*.mjs` launcher matches none of those patterns.

function sh(cmd) {
  try {
    execSync(cmd, { stdio: 'ignore', shell: '/bin/sh' });
  } catch {
    // nothing to kill, or kill failed — fine
  }
}

export function killByPort(port) {
  // Listener only — never connected clients (e.g. vite proxying to the daemon),
  // so cleaning the daemon can't take vite down as collateral.
  sh(`lsof -ti tcp:${port} -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null || true`);
}

// Kill a previous daemon for this repo: the one holding our port, plus any
// stray `tsx watch src/server.ts` from this repo that may not be bound.
export function killStaleDaemon(root, port) {
  killByPort(port);
  sh(`pkill -f "${root}/node_modules/.*tsx/dist/cli.mjs watch src/server.ts" 2>/dev/null || true`);
}

export function killStaleVite(vitePort = 5177) {
  killByPort(vitePort);
}

export function killStaleElectron(root) {
  sh(`pkill -f "${root}/dist/electron/main.js" 2>/dev/null || true`);
}

// Wait until a TCP port is free (the killed process has released it) so the
// fresh daemon can bind without EADDRINUSE.
export async function waitPortFree(port, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const inUse = await new Promise((resolve) => {
      const socket = net.createConnection({ port, host: '127.0.0.1' });
      socket.setTimeout(500, () => { socket.destroy(); resolve(false); });
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => resolve(false));
    });
    if (!inUse) return;
    await delay(150);
  }
}
