import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';

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

async function websocketProbe(port, roomId, expected) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/rooms/${roomId}/terminal`);
  let out = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`websocket timed out; output=${out}`)), 6000);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'input', data: 'pwd\n' })));
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

const root = mkdtempSync(path.join(tmpdir(), 'devrooms-smoke-'));
const src = path.join(root, 'src');
const home = path.join(root, 'home');
const roomsRoot = path.join(root, 'rooms');
mkdirSync(src, { recursive: true });
run('git', ['init', '-b', 'main'], src);
run('git', ['config', 'user.name', 'Smoke'], src);
run('git', ['config', 'user.email', 'smoke@example.invalid'], src);
writeFileSync(path.join(src, 'README.md'), 'hello\n');
run('git', ['add', 'README.md'], src);
run('git', ['commit', '-m', 'initial sample'], src);

const port = await freePort();
const server = spawn('node', ['dist/server.js'], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(port), DEVROOMS_HOME: home, DEVROOMS_ROOMS_ROOT: roomsRoot },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
server.stdout.on('data', (chunk) => { logs += chunk.toString(); });
server.stderr.on('data', (chunk) => { logs += chunk.toString(); });

try {
  const base = `http://127.0.0.1:${port}`;
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

  await request(base, '/api/projects', { method: 'POST', body: JSON.stringify({ name: 'Sample', repoUrl: src }) });
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
  run('git', ['config', 'user.name', 'Smoke'], path.join(roomsRoot, 'sample', 'alpha'));
  run('git', ['config', 'user.email', 'smoke@example.invalid'], path.join(roomsRoot, 'sample', 'alpha'));
  await request(base, `/api/rooms/${room.id}/git/commit`, { method: 'POST', body: JSON.stringify({ message: 'update readme' }) });
  status = await request(base, `/api/rooms/${room.id}/git/status`);
  if (status.status.dirtyCount !== 0) throw new Error(`expected clean tree after commit, saw ${status.status.dirtyCount}`);

  const started = await request(base, `/api/rooms/${room.id}/processes`, { method: 'POST', body: JSON.stringify({ name: 'smoke', command: 'pwd && git status --short' }) });
  await delay(1000);
  const processes = await request(base, `/api/rooms/${room.id}/processes`);
  const proc = processes.processes.find((item) => item.id === started.process.id);
  if (!proc || proc.exitCode !== 0 || !proc.logTail.includes(room.path)) throw new Error('process log/status smoke failed');

  await websocketProbe(port, room.id, room.path);
  await request(base, `/api/rooms/${room.id}`, { method: 'DELETE', body: JSON.stringify({ deleteFiles: true }) });

  await request(base, '/api/projects', { method: 'POST', body: JSON.stringify({ name: 'Broken', repoUrl: path.join(root, 'missing-repo') }) });
  const failedCreate = await request(base, '/api/projects/broken/rooms', { method: 'POST', body: JSON.stringify({ name: 'bad' }) });
  if (failedCreate.room.status !== 'creating') throw new Error(`expected failed clone to start as creating, got ${failedCreate.room.status}`);
  const failedRoom = await waitForRoomStatus(base, 'broken', failedCreate.room.id, 'error');
  if (!failedRoom.error) throw new Error('failed clone did not record an error');
  await request(base, `/api/rooms/${failedRoom.id}`, { method: 'DELETE', body: JSON.stringify({ deleteFiles: true }) });
  console.log('devrooms smoke ok');
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  server.kill('SIGTERM');
  rmSync(root, { recursive: true, force: true });
}
