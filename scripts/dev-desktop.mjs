import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { killStaleDaemon, killStaleVite, killStaleElectron, killByPort, waitPortFree } from './lib-cleanup.mjs';

const bin = (name) => process.platform === 'win32' ? `${name}.cmd` : name;
const root = process.cwd();
const port = Number(process.env.DEVROOMS_PORT || process.env.PORT || 4317);
const daemonUrl = `http://127.0.0.1:${port}`;
const viteUrl = process.env.DEVROOMS_VITE_URL || 'http://127.0.0.1:5177';
const baseEnv = {
  ...process.env,
  PORT: String(port),
  DEVROOMS_PROJECT_PATH: process.env.DEVROOMS_PROJECT_PATH || root,
};
// The project name is identity, not config — the daemon derives it from the repo
// dir. Drop any inherited DEVROOMS_PROJECT_NAME so it never travels as an env var.
delete baseEnv.DEVROOMS_PROJECT_NAME;
const children = [];

function start(name, command, args, extraEnv = {}) {
  const child = spawn(command, args, {
    cwd: root,
    env: { ...baseEnv, ...extraEnv },
    stdio: 'inherit',
  });
  children.push(child);
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    console.error(`[devrooms:${name}] exited code=${code ?? 'null'} signal=${signal ?? 'null'}`);
    shutdown(code ?? 1);
  });
  return child;
}

let shuttingDown = false;
function shutdown(code = 0) {
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 500).unref();
}

async function waitFor(url, label) {
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // keep waiting
    }
    await delay(100);
  }
  throw new Error(`${label} did not become ready at ${url}`);
}

process.once('SIGINT', () => shutdown(0));
process.once('SIGTERM', () => shutdown(0));
process.once('SIGHUP', () => shutdown(0));

// Kill any previous devrooms instance for this repo before starting a fresh
// one, so daemons/vite/electron never pile up across launches.
console.log('[devrooms] cleaning up any previous instance...');
killStaleDaemon(root, port);
killStaleVite();
killStaleElectron(root);
killByPort(port + 1); // stale pty-host
await waitPortFree(port);
await waitPortFree(port + 1);

console.log('[devrooms] compiling Electron main once...');
const tscOnce = spawnSync(bin('tsc'), ['-p', 'tsconfig.electron.json'], { cwd: root, env: baseEnv, stdio: 'inherit' });
if (tscOnce.status !== 0) process.exit(tscOnce.status ?? 1);

start('daemon', bin('tsx'), ['watch', 'src/server.ts']);
start('ui', bin('vite'), ['--host', '127.0.0.1']);
start('electron-tsc', bin('tsc'), ['-p', 'tsconfig.electron.json', '--watch', '--preserveWatchOutput']);

try {
  await waitFor(`${daemonUrl}/api/health`, 'daemon');
  await waitFor(viteUrl, 'vite');
  const electronMain = path.join(root, 'dist/electron/main.js');
  if (!existsSync(electronMain)) throw new Error(`missing Electron main build: ${electronMain}`);
  start('electron', bin('electron'), [electronMain], { DEVROOMS_SERVER_URL: viteUrl, DEVROOMS_PORT: String(port) });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  shutdown(1);
}
