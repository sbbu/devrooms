import { spawn } from 'node:child_process';

const bin = (name) => process.platform === 'win32' ? `${name}.cmd` : name;
const env = {
  ...process.env,
  DEVROOMS_PROJECT_PATH: process.env.DEVROOMS_PROJECT_PATH || process.cwd(),
  DEVROOMS_PROJECT_NAME: process.env.DEVROOMS_PROJECT_NAME || 'devrooms',
};

const child = spawn(bin('tsx'), ['watch', 'src/server.ts'], { env, stdio: 'inherit' });

const forward = (signal) => {
  if (!child.killed) child.kill(signal);
};

process.once('SIGINT', () => forward('SIGINT'));
process.once('SIGTERM', () => forward('SIGTERM'));
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
