import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const require = createRequire(import.meta.url);
const electronVersion = require('electron/package.json').version;
const packageName = '@homebridge/node-pty-prebuilt-multiarch';
const cli = path.resolve('node_modules/.bin/electron-rebuild');
const env = { ...process.env };

if (process.platform === 'darwin' && !env.npm_config_python && existsSync('/usr/bin/python3')) {
  env.npm_config_python = '/usr/bin/python3';
}

if (!existsSync(cli)) {
  console.error(`missing ${cli}; run pnpm install first`);
  process.exit(1);
}

const args = ['-f', '-w', packageName, '-v', electronVersion];
console.log(`rebuilding ${packageName} for Electron ${electronVersion}`);

const child = spawn(cli, args, { stdio: 'inherit', env });
child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`electron-rebuild terminated by ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 0);
});
