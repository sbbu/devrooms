import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

if (process.platform !== 'darwin') {
  console.log('package smoke skipped: macOS only');
  process.exit(0);
}

const appBinary = path.resolve('release/mac-arm64/Devrooms.app/Contents/MacOS/Devrooms');
const tmp = await mkdtemp(path.join(os.tmpdir(), 'devrooms-package-smoke-'));
const port = String(54000 + (process.pid % 1000));
const logs = [];
let child;

function remember(chunk) {
  logs.push(String(chunk));
  if (logs.join('').length > 8000) logs.shift();
}

async function waitForHealth() {
  const url = `http://127.0.0.1:${port}/api/health`;
  let lastError;

  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const health = await res.json();
        if (health.ok && health.port === Number(port)) return health;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`packaged app did not become healthy: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

try {
  child = spawn(appBinary, [], {
    env: {
      ...process.env,
      DEVROOMS_HOME: path.join(tmp, 'home'),
      DEVROOMS_PORT: port,
      DEVROOMS_ROOMS_ROOT: path.join(tmp, 'rooms'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', remember);
  child.stderr.on('data', remember);
  child.on('exit', (code, signal) => remember(`[app exited code=${code ?? 'null'} signal=${signal ?? 'null'}]\n`));

  const health = await waitForHealth();
  console.log(`devrooms packaged app smoke ok pid=${health.pid} port=${health.port}`);
} catch (error) {
  console.error(error);
  console.error(logs.join(''));
  process.exitCode = 1;
} finally {
  if (child && !child.killed) child.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 300));
  await rm(tmp, { recursive: true, force: true });
}
