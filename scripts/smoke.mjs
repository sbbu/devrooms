import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { killByPort } from './lib-cleanup.mjs';

function run(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      server.close(() => resolve(addr.port));
    });
    server.on('error', reject);
  });
}

async function request(base, route, options = {}) {
  const res = await fetch(`${base}${route}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${options.method ?? 'GET'} ${route}: ${res.status} ${data.error ?? res.statusText}`);
  return data;
}

async function text(base, route) {
  const res = await fetch(`${base}${route}`);
  const body = await res.text();
  if (!res.ok) throw new Error(`GET ${route}: ${res.status} ${body.slice(0, 120)}`);
  return body;
}

async function waitForHealth(base) {
  for (let i = 0; i < 80; i++) {
    try { return await request(base, '/api/health'); } catch { await delay(100); }
  }
  throw new Error('server did not become healthy');
}

async function waitForRoomStatus(base, projectId, roomId, wantedStatus) {
  for (let i = 0; i < 120; i++) {
    const data = await request(base, `/api/projects/${projectId}/rooms`);
    const room = data.rooms.find((item) => item.id === roomId);
    if (room?.status === wantedStatus) return room;
    if (room?.status === 'error' && wantedStatus !== 'error') throw new Error(`room clone failed: ${room.error}`);
    await delay(100);
  }
  throw new Error(`room did not become ${wantedStatus}: ${roomId}`);
}

async function waitForProcess(base, roomId, processId, predicate, label) {
  let proc;
  for (let i = 0; i < 80; i++) {
    const data = await request(base, `/api/rooms/${roomId}/processes`);
    proc = data.processes.find((item) => item.id === processId);
    if (proc && predicate(proc)) return proc;
    await delay(100);
  }
  throw new Error(`${label} timed out: ${JSON.stringify(proc)}`);
}

async function websocketProbe(url, onOpen, expected) {
  const ws = new WebSocket(url);
  let out = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`websocket timed out; output=${out}`)), 6000);
    ws.on('open', () => onOpen?.(ws));
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'output') out += msg.data;
      if (out.includes(expected)) {
        clearTimeout(timer);
        resolve();
      }
    });
    ws.on('error', reject);
  });
  ws.close();
}

async function roomWebsocketProbe(port, roomId, expected) {
  await websocketProbe(
    `ws://127.0.0.1:${port}/ws/rooms/${roomId}/terminal`,
    (ws) => setTimeout(() => ws.send(JSON.stringify({ type: 'input', data: 'cd "$DEVROOMS_ROOM_PATH"\nprintf "%s|%s|%s\\n" "$PWD" "$TERMINAL_CWD" "$DEVROOMS_ROOM_PATH"\n' })), 200),
    expected,
  );
}

async function roomTerminalReconnectProbe(port, roomId) {
  const url = `ws://127.0.0.1:${port}/ws/rooms/${roomId}/terminal`;
  const first = new WebSocket(url);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('first room terminal websocket did not open')), 4000);
    first.on('open', () => {
      clearTimeout(timer);
      first.send(JSON.stringify({ type: 'input', data: 'export DEVROOMS_SMOKE_MARKER=alive\ncd /\nprintf "seed:%s|%s\\n" "$DEVROOMS_SMOKE_MARKER" "$PWD"\n' }));
      setTimeout(resolve, 600);
    });
    first.on('error', reject);
  });
  first.close();
  await delay(300);
  await websocketProbe(
    url,
    (ws) => setTimeout(() => ws.send(JSON.stringify({ type: 'input', data: 'printf "resume:%s|%s\\n" "$DEVROOMS_SMOKE_MARKER" "$PWD"\n' })), 200),
    'resume:alive|/',
  );
}

async function processWebsocketProbe(port, processId, expected) {
  await websocketProbe(`ws://127.0.0.1:${port}/ws/processes/${processId}`, null, expected);
}

const root = mkdtempSync(path.join(tmpdir(), 'devrooms-smoke-'));
const src = path.join(root, 'src');
const remote = path.join(root, 'remote.git');
const home = path.join(root, 'home');
const roomsRoot = path.join(root, 'rooms');
mkdirSync(src, { recursive: true });
const srcRoot = realpathSync(src);
run('git', ['init', '-b', 'main'], src);
run('git', ['config', 'user.name', 'Smoke'], src);
run('git', ['config', 'user.email', 'smoke@example.invalid'], src);
writeFileSync(path.join(src, 'README.md'), 'hello\n');
run('git', ['add', 'README.md'], src);
run('git', ['commit', '-m', 'initial sample'], src);
// -b main so the bare remote's HEAD matches the pushed branch (like a real GitHub
// repo). Without it, HEAD defaults to master while content lives on main, and a
// no-branch clone lands on an unborn branch.
run('git', ['init', '--bare', '-b', 'main', remote], root);
run('git', ['remote', 'add', 'origin', remote], src);
run('git', ['push', '-u', 'origin', 'main'], src);

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
let logs = '';
let server;

function startServer(extraEnv = {}) {
  // Drop any inherited DEVROOMS_* (project/room identity, bootstrap path): when this
  // suite runs from inside a devrooms terminal — devrooms dogfoods itself — those
  // would auto-bootstrap the real repo and break the clean-slate assertions below.
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('DEVROOMS_')));
  const child = spawn('node', ['dist/server.js'], {
    cwd: process.cwd(),
    // HOME points at the temp dir so agent-hook installation (which probes
    // ~/.config/opencode) never touches the real home during tests.
    env: { ...cleanEnv, HOME: home, PORT: String(port), DEVROOMS_HOME: home, DEVROOMS_ROOMS_ROOT: roomsRoot, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { logs += chunk.toString(); });
  child.stderr.on('data', (chunk) => { logs += chunk.toString(); });
  return child;
}

async function stopServer(signal = 'SIGTERM') {
  if (!server || server.killed) return;
  server.kill(signal);
  await delay(500);
}

server = startServer();

try {
  const health = await waitForHealth(base);
  if (health.name !== 'devrooms' || health.port !== port || health.bindHost !== '127.0.0.1') throw new Error(`bad health metadata: ${JSON.stringify(health)}`);
  const indexHtml = await text(base, '/');
  if (!indexHtml.includes('<div id="root"></div>')) throw new Error('built UI html was not served at /');
  const spaHtml = await text(base, '/rooms/does-not-exist');
  if (!spaHtml.includes('<div id="root"></div>')) throw new Error('SPA fallback did not serve index.html');
  const meta = await request(base, '/api/meta');
  if (meta.name !== 'devrooms' || meta.projectCount !== 0 || meta.roomCount !== 0) throw new Error(`bad meta payload: ${JSON.stringify(meta)}`);
  const presets = await request(base, '/api/presets');
  if (!Array.isArray(presets.presets) || !presets.presets.some((preset) => preset.id === 'hermes-tui')) throw new Error('missing hermes preset');

  await request(base, '/api/projects', { method: 'POST', body: JSON.stringify({ name: 'Local Sample', rootPath: src }) });
  const localRooms = await request(base, '/api/projects/local-sample/rooms');
  const mainRoom = localRooms.rooms.find((item) => item.id === 'local-sample-main');
  if (!mainRoom || mainRoom.kind !== 'main' || mainRoom.status !== 'idle' || mainRoom.path !== srcRoot) throw new Error(`missing local main room: ${JSON.stringify(localRooms)}`);
  const mainProc = await request(base, `/api/rooms/${mainRoom.id}/processes`, { method: 'POST', body: JSON.stringify({ name: 'main env', command: 'printf "%s|%s|%s|%s\n" "$PWD" "$TERMINAL_CWD" "$DEVROOMS_ROOM_KIND" "$DEVROOMS_ROOM_PATH"' }) });
  await waitForProcess(
    base,
    mainRoom.id,
    mainProc.process.id,
    (proc) => proc.exitCode === 0 && proc.logTail.includes(`${srcRoot}|${srcRoot}|main|${srcRoot}`),
    'main room process env smoke',
  );
  await request(base, `/api/rooms/${mainRoom.id}`, { method: 'DELETE', body: JSON.stringify({ deleteFiles: false }) });

  await request(base, '/api/projects', { method: 'POST', body: JSON.stringify({ name: 'Sample', repoUrl: remote }) });
  const created = await request(base, '/api/projects/sample/rooms', { method: 'POST', body: JSON.stringify({ name: 'alpha' }) });
  if (created.room.status !== 'creating') throw new Error(`expected async room creation, got ${created.room.status}`);
  const room = await waitForRoomStatus(base, 'sample', created.room.id, 'idle');
  const readme = path.join(roomsRoot, 'sample', 'alpha', 'README.md');
  writeFileSync(readme, 'hello\nworld\n');

  let status = await request(base, `/api/rooms/${room.id}/git/status`);
  if (status.status.dirtyCount !== 1) throw new Error(`expected 1 dirty file, saw ${status.status.dirtyCount}`);
  const diff = await request(base, `/api/rooms/${room.id}/git/diff?path=README.md`);
  if (!diff.diff.includes('+world')) throw new Error('diff did not include edited line');

  await request(base, `/api/rooms/${room.id}/git/stage`, { method: 'POST', body: JSON.stringify({ path: 'README.md' }) });
  const staged = await request(base, `/api/rooms/${room.id}/git/diff?path=README.md`);
  if (!staged.stagedDiff.includes('+world')) throw new Error('staged diff did not include edited line');
  await request(base, `/api/rooms/${room.id}/git/unstage`, { method: 'POST', body: JSON.stringify({ path: 'README.md' }) });
  const unstaged = await request(base, `/api/rooms/${room.id}/git/diff?path=README.md`);
  if (unstaged.stagedDiff || !unstaged.diff.includes('+world')) throw new Error('unstage did not move the change back to the working tree');
  await request(base, `/api/rooms/${room.id}/git/stage`, { method: 'POST', body: JSON.stringify({ path: 'README.md' }) });
  run('git', ['config', 'user.name', 'Smoke'], path.join(roomsRoot, 'sample', 'alpha'));
  run('git', ['config', 'user.email', 'smoke@example.invalid'], path.join(roomsRoot, 'sample', 'alpha'));
  await request(base, `/api/rooms/${room.id}/git/commit`, { method: 'POST', body: JSON.stringify({ message: 'update readme' }) });
  status = await request(base, `/api/rooms/${room.id}/git/status`);
  if (status.status.dirtyCount !== 0) throw new Error(`expected clean tree after commit, saw ${status.status.dirtyCount}`);
  await request(base, `/api/rooms/${room.id}/git/push`, { method: 'POST' });

  await request(base, `/api/rooms/${room.id}/git/checkout-new`, { method: 'POST', body: JSON.stringify({ branch: 'feature/smoke' }) });
  status = await request(base, `/api/rooms/${room.id}/git/status`);
  if (!status.status.branch.startsWith('feature/smoke')) throw new Error(`expected feature/smoke branch, got ${status.status.branch}`);
  await request(base, `/api/rooms/${room.id}/git/checkout`, { method: 'POST', body: JSON.stringify({ branch: 'main' }) });

  run('git', ['pull', '--ff-only', 'origin', 'main'], src);
  writeFileSync(path.join(src, 'REMOTE.md'), 'from remote\n');
  run('git', ['add', 'REMOTE.md'], src);
  run('git', ['commit', '-m', 'remote update'], src);
  run('git', ['push', 'origin', 'main'], src);
  await request(base, `/api/rooms/${room.id}/git/fetch`, { method: 'POST' });
  await request(base, `/api/rooms/${room.id}/git/pull`, { method: 'POST' });
  if (!readFileSync(path.join(roomsRoot, 'sample', 'alpha', 'REMOTE.md'), 'utf8').includes('from remote')) throw new Error('pull did not bring down remote update');

  const started = await request(base, `/api/rooms/${room.id}/processes`, { method: 'POST', body: JSON.stringify({ name: 'smoke', command: 'printf "%s|%s|%s|%s\n" "$PWD" "$TERMINAL_CWD" "$DEVROOMS_ROOM_PATH" "$DEVROOMS_ROOM_ID" && git status --short' }) });
  let proc = await waitForProcess(
    base,
    room.id,
    started.process.id,
    (item) => item.exitCode === 0 && item.logTail.includes(`${room.path}|${room.path}|${room.path}|${room.id}`),
    'process cwd/env smoke',
  );

  const longRunning = await request(base, `/api/rooms/${room.id}/processes`, { method: 'POST', body: JSON.stringify({ name: 'long smoke', command: 'printf live-start && sleep 30' }) });
  let processes = await request(base, `/api/rooms/${room.id}/processes`);
  proc = processes.processes.find((item) => item.id === longRunning.process.id);
  if (!proc || proc.status !== 'running') throw new Error(`long-running process was not persisted as running: ${JSON.stringify(proc)}`);
  let registry = await request(base, '/api/projects');
  if (registry.processCounts?.[room.id]?.running !== 1) throw new Error(`missing running process count: ${JSON.stringify(registry.processCounts)}`);
  await stopServer('SIGKILL');
  server = startServer();
  await waitForHealth(base);
  processes = await request(base, `/api/rooms/${room.id}/processes`);
  proc = processes.processes.find((item) => item.id === longRunning.process.id);
  // PTYs live in the standalone pty-host, so a process SURVIVES a daemon restart.
  if (!proc || proc.status !== 'running' || !proc.logTail.includes('live-start')) throw new Error(`expected process to survive daemon restart via pty-host: ${JSON.stringify(proc)}`);
  registry = await request(base, '/api/projects');
  if (registry.processCounts?.[room.id]?.running !== 1) throw new Error(`expected surviving running process after restart: ${JSON.stringify(registry.processCounts)}`);
  await processWebsocketProbe(port, longRunning.process.id, 'live-start');
  await request(base, `/api/processes/${longRunning.process.id}`, { method: 'DELETE' });

  await roomTerminalReconnectProbe(port, room.id);
  await roomWebsocketProbe(port, room.id, `${room.path}|${room.path}|${room.path}`);

  // multiple tiled terminals per room
  const addedTerm = await request(base, `/api/rooms/${room.id}/terminals`, { method: 'POST' });
  if (!addedTerm.id || !addedTerm.terminals?.includes('main') || !addedTerm.terminals?.includes(addedTerm.id)) throw new Error(`add terminal failed: ${JSON.stringify(addedTerm)}`);
  await websocketProbe(
    `ws://127.0.0.1:${port}/ws/rooms/${room.id}/terminals/${addedTerm.id}`,
    (ws) => setTimeout(() => ws.send(JSON.stringify({ type: 'input', data: 'printf "extra-term:%s\\n" "$PWD"\n' })), 200),
    `extra-term:${room.path}`,
  );
  const delTerm = await request(base, `/api/rooms/${room.id}/terminals/${addedTerm.id}`, { method: 'DELETE' });
  if (delTerm.terminals?.includes(addedTerm.id)) throw new Error(`terminal not removed after close: ${JSON.stringify(delTerm)}`);
  let mainTerminalProtected = false;
  try { await request(base, `/api/rooms/${room.id}/terminals/main`, { method: 'DELETE' }); } catch (error) { mainTerminalProtected = String(error).includes('400'); }
  if (!mainTerminalProtected) throw new Error('main terminal must not be closable');

  await request(base, `/api/rooms/${room.id}`, { method: 'DELETE', body: JSON.stringify({ deleteFiles: true }) });

  let rejectedBadProject = false;
  try {
    await request(base, '/api/projects', { method: 'POST', body: JSON.stringify({ name: 'Broken', repoUrl: path.join(root, 'missing-repo') }) });
  } catch (error) {
    rejectedBadProject = String(error).includes('400');
  }
  if (!rejectedBadProject) throw new Error('project creation did not reject an unreachable repository');

  const cancelCreate = await request(base, '/api/projects/sample/rooms', { method: 'POST', body: JSON.stringify({ name: 'cancel', branch: 'definitely-missing' }) });
  if (cancelCreate.room.status !== 'creating') throw new Error(`expected cancel clone to start as creating, got ${cancelCreate.room.status}`);
  await request(base, `/api/rooms/${cancelCreate.room.id}`, { method: 'DELETE', body: JSON.stringify({ deleteFiles: true }) });
  await delay(300);
  const afterCancel = await request(base, '/api/projects/sample/rooms');
  if (afterCancel.rooms.some((item) => item.id === cancelCreate.room.id)) throw new Error('deleted creating room was resurrected');

  const failedCreate = await request(base, '/api/projects/sample/rooms', { method: 'POST', body: JSON.stringify({ name: 'bad', branch: 'definitely-missing' }) });
  if (failedCreate.room.status !== 'creating') throw new Error(`expected failed clone to start as creating, got ${failedCreate.room.status}`);
  const failedRoom = await waitForRoomStatus(base, 'sample', failedCreate.room.id, 'error');
  if (!failedRoom.error) throw new Error('failed clone did not record an error');
  await request(base, `/api/rooms/${failedRoom.id}`, { method: 'DELETE', body: JSON.stringify({ deleteFiles: true }) });

  await stopServer('SIGTERM');
  // The project name is identity — derived from the repo directory basename
  // ("src"), never from an env var — so the launched ids follow from basename(src).
  server = startServer({ DEVROOMS_PROJECT_PATH: src });
  await waitForHealth(base);
  const launchedRooms = await request(base, '/api/projects/src/rooms');
  const launchedMain = launchedRooms.rooms.find((item) => item.id === 'src-main');
  if (!launchedMain || launchedMain.kind !== 'main' || launchedMain.path !== srcRoot) throw new Error(`launch default main room missing: ${JSON.stringify(launchedRooms)}`);
  await request(base, `/api/rooms/${launchedMain.id}`, { method: 'DELETE', body: JSON.stringify({ deleteFiles: false }) });

  console.log('devrooms smoke ok');
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  await stopServer('SIGTERM');
  try { killByPort(port + 1); } catch { /* detached pty-host already gone */ }
  rmSync(root, { recursive: true, force: true });
}
