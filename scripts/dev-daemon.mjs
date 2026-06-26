import path from 'node:path';
import { killStaleDaemon, waitPortFree } from './lib-cleanup.mjs';
import { superviseReload } from './lib-reload.mjs';

const bin = (name) => process.platform === 'win32' ? `${name}.cmd` : name;
const root = process.cwd();
const port = Number(process.env.DEVROOMS_PORT || process.env.PORT || 4317);
const env = {
  ...process.env,
  DEVROOMS_PROJECT_PATH: process.env.DEVROOMS_PROJECT_PATH || root,
};
// The project name is identity, not config — the daemon derives it from the repo
// dir. Drop any inherited DEVROOMS_PROJECT_NAME so it never travels as an env var.
delete env.DEVROOMS_PROJECT_NAME;

// Kill any previous daemon for this repo so daemons never pile up. Only the
// daemon here (not vite) — `pnpm dev` runs vite concurrently as a sibling.
killStaleDaemon(root, port);
// The pty-host (port + 1) is left running so sessions survive restarts; the
// daemon reuses a healthy one. `pnpm stop` ends it on purpose.
await waitPortFree(port);

// Like `tsx watch src/server.ts`, but it will NOT reload while the daemon's source
// has merge conflict markers — a half-merged server.ts would crash on reload and take
// the whole app's API down (devrooms watches its own source). The running daemon stays
// up until the merge is resolved. src/client is excluded; vite owns the UI's HMR.
const supervisor = superviseReload({
  cmd: bin('tsx'),
  args: ['src/server.ts'],
  cwd: root,
  env,
  watchDir: path.join(root, 'src'),
  excludeDir: path.join(root, 'src', 'client'),
  label: 'daemon',
  log: console.error,
});

process.once('SIGINT', () => supervisor.stop('SIGINT'));
process.once('SIGTERM', () => supervisor.stop('SIGTERM'));
process.once('SIGHUP', () => supervisor.stop('SIGHUP'));
