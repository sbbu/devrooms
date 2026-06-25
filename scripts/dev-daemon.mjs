import { spawn } from 'node:child_process';
import { killStaleDaemon, waitPortFree } from './lib-cleanup.mjs';

const bin = (name) => process.platform === 'win32' ? `${name}.cmd` : name;
const root = process.cwd();
const port = Number(process.env.DEVROOMS_PORT || process.env.PORT || 4317);
const env = {
  ...process.env,
  DEVROOMS_PROJECT_PATH: process.env.DEVROOMS_PROJECT_PATH || root,
  DEVROOMS_PROJECT_NAME: process.env.DEVROOMS_PROJECT_NAME || 'devrooms',
};

// Kill any previous daemon for this repo so daemons never pile up. Only the
// daemon here (not vite) — `pnpm dev` runs vite concurrently as a sibling.
killStaleDaemon(root, port);
await waitPortFree(port);

const child = spawn(bin('tsx'), ['watch', 'src/server.ts'], { env, stdio: 'inherit' });

const forward = (signal) => {
  if (!child.killed) child.kill(signal);
};

process.once('SIGINT', () => forward('SIGINT'));
process.once('SIGTERM', () => forward('SIGTERM'));
process.once('SIGHUP', () => forward('SIGHUP'));
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
