import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const markerName = '.devrooms-showcase-root';
const showcaseRoot = path.resolve(process.env.DEVROOMS_SCREENSHOT_ROOT ?? path.join(os.homedir(), '.devrooms-showcase'));
const outputPath = path.resolve(process.env.DEVROOMS_SCREENSHOT_OUT ?? path.join(repoRoot, 'docs', 'assets', 'devrooms-poweruser.png'));
const devroomsSource = path.resolve(process.env.DEVROOMS_SCREENSHOT_DEVROOMS_SOURCE ?? repoRoot);

function run(command, args, cwd, options = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...(options.env ?? {}) },
    timeout: options.timeout ?? 120_000,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed in ${cwd}\n${result.stdout ?? ''}${result.stderr ?? ''}`);
  }
  return result.stdout ?? '';
}

async function write(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

async function resetShowcaseRoot() {
  if (existsSync(showcaseRoot)) {
    const marker = path.join(showcaseRoot, markerName);
    if (!existsSync(marker)) throw new Error(`refusing to remove unmarked showcase root: ${showcaseRoot}`);
    rmSync(showcaseRoot, { recursive: true, force: true });
  }
  mkdirSync(showcaseRoot, { recursive: true });
  writeFileSync(path.join(showcaseRoot, markerName), 'owned by devrooms README screenshot generator\n');
}

async function gitInitRepo(name, files, edits, branches = []) {
  const reposRoot = path.join(showcaseRoot, 'repos');
  const remotesRoot = path.join(showcaseRoot, 'remotes');
  const repo = path.join(reposRoot, name);
  const remote = path.join(remotesRoot, `${name}.git`);
  mkdirSync(repo, { recursive: true });
  mkdirSync(remotesRoot, { recursive: true });

  run('git', ['init', '-b', 'main'], repo);
  run('git', ['config', 'user.name', 'devrooms demo'], repo);
  run('git', ['config', 'user.email', 'demo@example.invalid'], repo);
  for (const [file, content] of Object.entries(files)) await write(path.join(repo, file), content);
  run('git', ['add', '.'], repo);
  run('git', ['commit', '-m', `init ${name}`], repo);

  for (const branch of branches) {
    run('git', ['checkout', '-b', branch.name], repo);
    for (const [file, content] of Object.entries(branch.files)) await write(path.join(repo, file), content);
    run('git', ['add', '.'], repo);
    run('git', ['commit', '-m', branch.message], repo);
    run('git', ['checkout', 'main'], repo);
  }

  run('git', ['init', '--bare', '-b', 'main', remote], showcaseRoot);
  run('git', ['remote', 'add', 'origin', remote], repo);
  run('git', ['push', '-u', 'origin', '--all'], repo);

  if (edits.checkout) run('git', ['checkout', edits.checkout], repo);
  for (const [file, content] of Object.entries(edits.files ?? {})) await write(path.join(repo, file), content);
  if (edits.untracked) for (const [file, content] of Object.entries(edits.untracked)) await write(path.join(repo, file), content);
  return { repo, remote };
}

async function cloneDevroomsRepo() {
  const reposRoot = path.join(showcaseRoot, 'repos');
  const remotesRoot = path.join(showcaseRoot, 'remotes');
  const repo = path.join(reposRoot, 'devrooms');
  const remote = path.join(remotesRoot, 'devrooms.git');
  mkdirSync(reposRoot, { recursive: true });
  mkdirSync(remotesRoot, { recursive: true });
  run('git', ['clone', '--depth=1', devroomsSource, repo], showcaseRoot, { timeout: 180_000 });
  run('git', ['config', 'user.name', 'devrooms demo'], repo);
  run('git', ['config', 'user.email', 'demo@example.invalid'], repo);
  run('git', ['checkout', '-b', 'feature/poweruser-readme-shot'], repo);
  await write(path.join(repo, 'docs', 'screenshot-notes.md'), `# power-user screenshot pass\n\n- refresh README screenshot\n- verify multi-terminal layout\n- exercise git branch palette\n`);
  await write(path.join(repo, 'src', 'client', 'src', 'screenshot-fixture.ts'), `export const screenshotFixture = { rooms: 9, terminals: 4, agents: 3 };\n`);
  run('git', ['add', 'docs/screenshot-notes.md'], repo);
  run('git', ['commit', '-m', 'docs: draft power-user screenshot notes'], repo);
  run('git', ['init', '--bare', '-b', 'main', remote], showcaseRoot);
  run('git', ['remote', 'remove', 'origin'], repo);
  run('git', ['remote', 'add', 'origin', remote], repo);
  run('git', ['push', '-u', 'origin', '--all'], repo);
  await write(path.join(repo, 'README.md'), `${readFileSync(path.join(repo, 'README.md'), 'utf8')}\n\n<!-- screenshot pass: testing README image refresh -->\n`);
  await write(path.join(repo, 'e2e', 'power-user.spec.ts'), `test('power user keeps three rooms live', async () => {\n  // screenshot fixture\n});\n`);
  return { repo, remote };
}

async function createFixtureRepos() {
  const devrooms = await cloneDevroomsRepo();
  const atlas = await gitInitRepo('atlas-api', {
    'package.json': JSON.stringify({ type: 'module', scripts: { test: 'node --test tests/*.test.mjs', lint: 'node scripts/lint.mjs', dev: 'node src/server.mjs' } }, null, 2) + '\n',
    'src/router.mjs': `export function route(path) {\n  if (path === '/health') return { ok: true };\n  return { status: 404 };\n}\n`,
    'src/server.mjs': `import { route } from './router.mjs';\nconsole.log('atlas-api dev server ready', route('/health'));\nsetInterval(() => console.log('request /health 200'), 2500);\n`,
    'tests/router.test.mjs': `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { route } from '../src/router.mjs';\ntest('health route', () => assert.equal(route('/health').ok, true));\n`,
    'scripts/lint.mjs': `console.log('lint ok: src/router.mjs tests/router.test.mjs');\n`,
    'docs/plan.md': `# atlas-api active plan\n\n- harden edge-cache auth path\n- keep tests green while the agent edits router rules\n- prepare a narrow commit for review\n`,
  }, {
    checkout: 'feature/edge-cache',
    files: {
      'src/router.mjs': `export function route(path) {\n  if (path === '/health') return { ok: true };\n  if (path.startsWith('/v1/cache')) return { status: 200, cache: 'edge', auth: 'pending-review' };\n  return { status: 404 };\n}\n`,
    },
    untracked: {
      'tests/cache.test.mjs': `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { route } from '../src/router.mjs';\ntest('cache route is alive', () => assert.equal(route('/v1/cache/users').cache, 'edge'));\n`,
    },
  }, [
    { name: 'feature/edge-cache', message: 'feat: sketch edge cache routing', files: { 'docs/cache.md': '# edge cache notes\n' } },
    { name: 'fix/auth-timeout', message: 'fix: capture auth timeout repro', files: { 'tests/auth-timeout.test.mjs': `import test from 'node:test';\ntest('auth timeout repro placeholder', () => {});\n` } },
    { name: 'perf/streaming-json', message: 'perf: add streaming json branch notes', files: { 'docs/streaming.md': '# streaming json\n' } },
  ]);

  const consoleUi = await gitInitRepo('console-ui', {
    'package.json': JSON.stringify({ type: 'module', scripts: { build: 'node scripts/build.mjs', test: 'node --test tests/*.test.mjs' } }, null, 2) + '\n',
    'src/app.js': `export function nav(width) { return width < 720 ? 'mini' : 'full'; }\n`,
    'tests/app.test.mjs': `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { nav } from '../src/app.js';\ntest('mini rail below 720', () => assert.equal(nav(640), 'mini'));\n`,
    'scripts/build.mjs': `console.log('bundled console-ui in 318ms');\n`,
  }, {
    checkout: 'feat/command-palette',
    files: { 'src/app.js': `export function nav(width) { return width < 720 ? 'mini' : 'full'; }\nexport const palette = ['open room', 'clone room', 'switch theme'];\n` },
    untracked: { 'docs/keyboard.md': '# keyboard map\n\ncmd-p opens the command palette.\n' },
  }, [
    { name: 'feat/command-palette', message: 'feat: add command palette shell', files: { 'src/palette.js': `export const actions = ['open', 'clone', 'theme'];\n` } },
    { name: 'fix/mobile-sidebar', message: 'fix: preserve mini sidebar state', files: { 'tests/sidebar.test.mjs': `import test from 'node:test';\ntest('sidebar fixture', () => {});\n` } },
  ]);

  const worker = await gitInitRepo('worker-runtime', {
    'worker.py': `def handle(event):\n    return {'ok': True, 'event': event}\n\nif __name__ == '__main__':\n    print(handle('heartbeat'))\n`,
    'test_worker.py': `import unittest\nfrom worker import handle\nclass WorkerTest(unittest.TestCase):\n    def test_handle(self):\n        self.assertTrue(handle('x')['ok'])\nif __name__ == '__main__':\n    unittest.main()\n`,
    'README.md': '# worker-runtime\n',
  }, {
    checkout: 'main',
    files: { 'worker.py': `def handle(event):\n    if event == 'backfill':\n        return {'ok': True, 'queued': 42}\n    return {'ok': True, 'event': event}\n\nif __name__ == '__main__':\n    print(handle('heartbeat'))\n` },
  }, [
    { name: 'chore/backfill-runner', message: 'chore: stage backfill runner', files: { 'backfill.py': `print('backfill ready')\n` } },
  ]);

  return [
    { name: 'atlas-api', ...atlas },
    { name: 'devrooms', ...devrooms },
    { name: 'console-ui', ...consoleUi },
    { name: 'worker-runtime', ...worker },
  ];
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
    server.on('error', reject);
  });
}

async function waitForHealth(base) {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return await res.json();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('devrooms server did not become healthy');
}

async function api(base, route, options = {}) {
  const res = await fetch(`${base}${route}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${options.method ?? 'GET'} ${route}: ${res.status} ${data.error ?? res.statusText}`);
  return data;
}

async function waitForRoom(base, projectId, roomId) {
  for (let i = 0; i < 160; i++) {
    const data = await api(base, `/api/projects/${projectId}/rooms`);
    const room = data.rooms.find((item) => item.id === roomId);
    if (room?.status === 'idle') return room;
    if (room?.status === 'error') throw new Error(`room ${roomId} failed: ${room.error}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`room ${roomId} did not become idle`);
}

async function setupDevroomsState(base, repos) {
  const projectIds = {};
  for (const item of repos) {
    const created = await api(base, '/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name: item.name, rootPath: item.repo, repoUrl: item.remote }),
    });
    projectIds[item.name] = created.project.id;
  }

  const clonePlan = [
    ['atlas-api', 'auth-rewrite', 'fix/auth-timeout'],
    ['atlas-api', 'streaming-json', 'perf/streaming-json'],
    ['devrooms', 'terminal-cache', 'feature/poweruser-readme-shot'],
    ['devrooms', 'theme-polish', 'main'],
    ['console-ui', 'mobile-nav', 'fix/mobile-sidebar'],
    ['worker-runtime', 'backfill-runner', 'chore/backfill-runner'],
  ];
  const cloneRooms = [];
  for (const [projectName, roomName, branch] of clonePlan) {
    const created = await api(base, `/api/projects/${projectIds[projectName]}/rooms`, {
      method: 'POST',
      body: JSON.stringify({ name: roomName, branch }),
    });
    cloneRooms.push(await waitForRoom(base, projectIds[projectName], created.room.id));
  }

  const all = await api(base, '/api/projects');
  const atlasMain = all.rooms.find((room) => room.id === `${projectIds['atlas-api']}-main`);
  if (!atlasMain) throw new Error('atlas main room missing');

  // Dirty a few clone rooms after materialization so the sidebar looks like a real day.
  for (const room of cloneRooms) {
    if (room.name === 'auth-rewrite') await write(path.join(room.path, 'src', 'router.mjs'), `export function route(path) {\n  if (path === '/health') return { ok: true };\n  if (path === '/auth/session') return { status: 200, session: 'rotating' };\n  return { status: 404 };\n}\n`);
    if (room.name === 'terminal-cache') await write(path.join(room.path, 'docs', 'terminal-cache.md'), '# terminal cache repro\n\nPTY survives hot reload.\n');
    if (room.name === 'mobile-nav') await write(path.join(room.path, 'src', 'app.js'), `export function nav(width) { return width < 900 ? 'mini' : 'full'; }\n`);
  }

  // Add tiled terminals to the selected room.
  const terminalIds = ['main'];
  for (let i = 0; i < 3; i++) {
    const added = await api(base, `/api/rooms/${atlasMain.id}/terminals`, { method: 'POST' });
    terminalIds.push(added.id);
  }

  // Start real subprocesses so process counts and agent activity show up.
  await api(base, `/api/rooms/${atlasMain.id}/processes`, {
    method: 'POST',
    body: JSON.stringify({
      name: 'Hermes planner',
      command: `printf '\\033]9279;working\\a[hermes] planning cache/auth split\\n'; while true; do printf '[hermes] checking next patch slice at %s\\n' "$(date +%H:%M:%S)"; sleep 12; done`,
    }),
  });
  await api(base, `/api/rooms/${atlasMain.id}/processes`, {
    method: 'POST',
    body: JSON.stringify({ name: 'test shard', command: 'node --test tests/*.test.mjs' }),
  });
  const devroomsTerminal = all.rooms.find((room) => room.name === 'terminal-cache');
  if (devroomsTerminal) {
    await api(base, `/api/rooms/${devroomsTerminal.id}/processes`, {
      method: 'POST',
      body: JSON.stringify({ name: 'OpenCode review', command: `printf '\\033]9279;needs-input\\a[opencode] review complete — waiting for human input\\n'; sleep 300` }),
    });
  }

  return { atlasMain, terminalIds };
}

async function sendTerminal(basePort, roomId, terminalId, command, waitMs = 1300) {
  const suffix = terminalId === 'main' ? `/ws/rooms/${roomId}/terminal` : `/ws/rooms/${roomId}/terminals/${terminalId}`;
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${basePort}${suffix}?replay=0`);
    const timer = setTimeout(() => { try { ws.close(); } catch {} ; resolve(); }, waitMs);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'resize', cols: 96, rows: 18 }));
      ws.send(JSON.stringify({ type: 'input', data: `${command}\n` }));
    });
    ws.on('error', (error) => { clearTimeout(timer); reject(error); });
  });
}

async function seedTerminalOutput(port, room, terminalIds) {
  const clear = `printf '\\033c'`;
  const commands = [
    `${clear}; printf '\\033[1;36matlas-api / feature/edge-cache\\033[0m\\n'; git status --short --branch; printf '\\n'; git diff --stat; printf '\\n'; node --test tests/*.test.mjs`,
    `${clear}; printf '\\033[1;35mbranch stack + recent commits\\033[0m\\n'; git branch --sort=-committerdate --format='%(refname:short)  %(committerdate:relative)' | sed -n '1,8p'; printf '\\n'; git log --oneline --decorate -5`,
    `${clear}; printf '\\033[1;32mdev server / watcher\\033[0m\\n'; while true; do ms=$(( $(date +%S) % 70 + 18 )); printf '[%s] rebuilt src/router.mjs in %sms — serving /v1/cache/users\\n' "$(date +%H:%M:%S)" "$ms"; sleep 2; done`,
    `${clear}; printf '\\033[1;33magent handoff\\033[0m\\n'; printf '\\033]9279;working\\a'; printf '[claude] reviewing sidebar state model\\n[codex] drafting cache-route regression\\n[hermes] staging a two-file commit plan\\n\\n'; sed -n '1,12p' docs/plan.md`,
  ];
  for (let i = 0; i < terminalIds.length; i++) await sendTerminal(port, room.id, terminalIds[i], commands[i], i === 2 ? 2800 : 1800);
}

function findChrome() {
  const envPath = process.env.CHROME_PATH;
  const candidates = [
    envPath,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ].filter(Boolean);
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  for (const cmd of ['google-chrome', 'chromium', 'chromium-browser', 'chrome']) {
    const found = spawnSync('sh', ['-lc', `command -v ${cmd}`], { encoding: 'utf8' });
    if (found.status === 0 && found.stdout.trim()) return found.stdout.trim();
  }
  throw new Error('Chrome/Chromium not found. Set CHROME_PATH to a Chromium-compatible browser.');
}

async function screenshot(port) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const chromeProfile = path.join(showcaseRoot, 'chrome-profile');
  mkdirSync(chromeProfile, { recursive: true });
  const chrome = findChrome();
  const url = `http://127.0.0.1:${port}`;
  const args = [
    '--headless=new',
    '--no-first-run',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-extensions',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--window-size=1800,1100',
    '--virtual-time-budget=7000',
    `--user-data-dir=${chromeProfile}`,
    `--screenshot=${outputPath}`,
    url,
  ];
  const result = spawnSync(chrome, args, { encoding: 'utf8', timeout: 45_000 });
  if (result.status !== 0) throw new Error(`Chrome screenshot failed\n${result.stdout ?? ''}${result.stderr ?? ''}`);
  if (!existsSync(outputPath) || statSync(outputPath).size < 50_000) throw new Error(`screenshot missing or suspiciously small: ${outputPath}`);
}

async function main() {
  if (!existsSync(path.join(repoRoot, 'dist', 'server.js'))) throw new Error('dist/server.js missing; run pnpm build first');
  await resetShowcaseRoot();
  const repos = await createFixtureRepos();
  const port = Number(process.env.PORT || await freePort());
  const home = path.join(showcaseRoot, 'home');
  const roomsRoot = path.join(showcaseRoot, 'rooms');
  mkdirSync(home, { recursive: true });
  mkdirSync(roomsRoot, { recursive: true });
  await write(path.join(home, '.shrc'), `PS1='powerdev@devbox $ '\n`);
  const demoEnv = {
    HOME: home,
    USER: 'powerdev',
    LOGNAME: 'powerdev',
    HOSTNAME: 'devbox',
    SHELL: '/bin/sh',
    ENV: path.join(home, '.shrc'),
    PS1: 'powerdev@devbox $ ',
    PROMPT_COMMAND: '',
  };
  const server = spawn(process.execPath, ['dist/server.js'], {
    cwd: repoRoot,
    env: { ...process.env, ...demoEnv, PORT: String(port), DEVROOMS_HOME: home, DEVROOMS_ROOMS_ROOT: roomsRoot },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  server.stdout.on('data', (chunk) => { logs += chunk.toString(); });
  server.stderr.on('data', (chunk) => { logs += chunk.toString(); });
  try {
    const base = `http://127.0.0.1:${port}`;
    await waitForHealth(base);
    const { atlasMain, terminalIds } = await setupDevroomsState(base, repos);
    await seedTerminalOutput(port, atlasMain, terminalIds);
    await new Promise((resolve) => setTimeout(resolve, 2200));
    await screenshot(port);
    console.log(`wrote ${outputPath}`);
  } catch (error) {
    console.error(logs.split('\n').slice(-80).join('\n'));
    throw error;
  } finally {
    server.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 500));
    try { execFileSync('sh', ['-lc', `lsof -ti tcp:${port + 1} | xargs kill -9`], { stdio: 'ignore' }); } catch {}
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
