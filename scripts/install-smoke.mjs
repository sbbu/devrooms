import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const repoRoot = process.cwd();
const installDir = await mkdtemp(path.join(os.tmpdir(), 'devrooms-install-'));
const runtimeDir = await mkdtemp(path.join(os.tmpdir(), 'devrooms-installed-runtime-'));
const appPath = path.join(installDir, 'Devrooms.app');
const binary = path.join(appPath, 'Contents', 'MacOS', 'Devrooms');
const port = 54100 + Math.floor(Math.random() * 1000);

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth() {
  const url = `http://127.0.0.1:${port}/api/health`;
  let last;
  for (let i = 0; i < 80; i += 1) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
      last = new Error(`${res.status} ${res.statusText}`);
    } catch (error) {
      last = error;
    }
    await wait(100);
  }
  throw last ?? new Error('health check timed out');
}

let child;
try {
  const install = spawn('bash', ['scripts/install-mac.sh', '--skip-build'], {
    cwd: repoRoot,
    env: { ...process.env, DEVROOMS_INSTALL_DIR: installDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let installLog = '';
  install.stdout.on('data', (chunk) => { installLog += chunk.toString(); });
  install.stderr.on('data', (chunk) => { installLog += chunk.toString(); });
  const code = await new Promise((resolve) => install.on('exit', resolve));
  if (code !== 0) throw new Error(`install failed (${code}): ${installLog}`);

  child = spawn(binary, [], {
    env: {
      ...process.env,
      DEVROOMS_PORT: String(port),
      DEVROOMS_HOME: path.join(runtimeDir, 'home'),
      DEVROOMS_ROOMS_ROOT: path.join(runtimeDir, 'rooms'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let appLog = '';
  child.stdout.on('data', (chunk) => { appLog += chunk.toString(); });
  child.stderr.on('data', (chunk) => { appLog += chunk.toString(); });
  child.once('exit', (code) => {
    if (code !== 0 && code !== null) console.error(appLog);
  });
  const health = await waitForHealth();
  if (health.bindHost !== '127.0.0.1' || health.port !== port) throw new Error(`bad installed app health: ${JSON.stringify(health)}`);
  console.log(`devrooms installed app smoke ok ${appPath}`);
} finally {
  if (child && !child.killed) child.kill('SIGTERM');
  await wait(250);
  await rm(installDir, { recursive: true, force: true });
  await rm(runtimeDir, { recursive: true, force: true });
}
