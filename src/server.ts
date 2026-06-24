import express from 'express';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import pty from '@homebridge/node-pty-prebuilt-multiarch';

const DEVROOMS_HOME = process.env.DEVROOMS_HOME ?? path.join(os.homedir(), '.devrooms');
const ROOMS_ROOT = process.env.DEVROOMS_ROOMS_ROOT ?? path.join(os.homedir(), 'devrooms');
const STATE_PATH = path.join(DEVROOMS_HOME, 'state.json');
const APP_NAME = 'devrooms';
const APP_VERSION = '0.0.1';
const STARTED_AT = now();
const BIND_HOST = '127.0.0.1';
const PORT = parsePort(process.env.PORT);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type Project = {
  id: string;
  name: string;
  repoUrl: string;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
};

type Room = {
  id: string;
  projectId: string;
  name: string;
  path: string;
  branch?: string;
  status: 'creating' | 'idle' | 'error';
  error?: string;
  createdAt: string;
  updatedAt: string;
};

type ProcessStatus = 'running' | 'exited' | 'lost';

type ProcessRecord = {
  id: string;
  roomId: string;
  name: string;
  command: string;
  status: ProcessStatus;
  startedAt: string;
  exitedAt?: string;
  exitCode?: number;
  logTail?: string;
};

type State = {
  version: 1;
  projects: Record<string, Project>;
  rooms: Record<string, Room>;
  processes: Record<string, ProcessRecord>;
};

type ManagedProcess = {
  id: string;
  roomId: string;
  name: string;
  command: string;
  status: 'running' | 'exited';
  startedAt: string;
  exitedAt?: string;
  exitCode?: number;
  pty: pty.IPty;
  log: string[];
};

type RunResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

type AgentPreset = {
  id: string;
  label: string;
  description: string;
  command: string;
  available: boolean;
};

const processes = new Map<string, ManagedProcess>();
const cloneJobs = new Map<string, ChildProcess>();
const deletedRoomTokens = new Set<string>();

function now() {
  return new Date().toISOString();
}

function parsePort(value: string | undefined) {
  if (!value) return 4317;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`invalid PORT: ${value}`);
  }
  return parsed;
}

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function roomToken(room: Room) {
  return `${room.id}:${room.createdAt}`;
}

function requireString(value: unknown, field: string) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new HttpError(400, `${field} is required`);
  }
  return value.trim();
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function emptyState(): State {
  return { version: 1, projects: {}, rooms: {}, processes: {} };
}

function normalizeProcessRecord(value: unknown): ProcessRecord | null {
  const candidate = value as Partial<ProcessRecord>;
  if (!candidate || typeof candidate !== 'object') return null;
  if (typeof candidate.id !== 'string' || typeof candidate.roomId !== 'string') return null;
  if (typeof candidate.name !== 'string' || typeof candidate.command !== 'string') return null;
  if (typeof candidate.startedAt !== 'string') return null;
  const status: ProcessStatus = candidate.status === 'exited' || candidate.status === 'lost' ? candidate.status : 'running';
  return {
    id: candidate.id,
    roomId: candidate.roomId,
    name: candidate.name,
    command: candidate.command,
    status,
    startedAt: candidate.startedAt,
    exitedAt: typeof candidate.exitedAt === 'string' ? candidate.exitedAt : undefined,
    exitCode: typeof candidate.exitCode === 'number' ? candidate.exitCode : undefined,
    logTail: typeof candidate.logTail === 'string' ? candidate.logTail : undefined,
  };
}

function normalizeProcessRecords(raw: unknown): Record<string, ProcessRecord> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, ProcessRecord> = {};
  for (const value of Object.values(raw as Record<string, unknown>)) {
    const record = normalizeProcessRecord(value);
    if (record) out[record.id] = record;
  }
  return out;
}

function normalizeState(raw: unknown): State {
  const candidate = raw as Partial<State>;
  return {
    version: 1,
    projects: candidate.projects ?? {},
    rooms: candidate.rooms ?? {},
    processes: normalizeProcessRecords(candidate.processes),
  };
}

async function recoverLostProcesses(state: State) {
  let changed = false;
  for (const record of Object.values(state.processes)) {
    if (record.status === 'running' && !processes.has(record.id)) {
      record.status = 'lost';
      record.exitedAt = record.exitedAt ?? STARTED_AT;
      record.logTail = `${record.logTail ?? ''}\n[devrooms daemon restarted; PTY is no longer attached]\n`.slice(-4000);
      changed = true;
    }
  }
  if (changed) await saveState(state);
  return state;
}

async function ensureState(): Promise<State> {
  await fs.mkdir(DEVROOMS_HOME, { recursive: true });
  await fs.mkdir(ROOMS_ROOT, { recursive: true });
  try {
    const raw = await fs.readFile(STATE_PATH, 'utf8');
    return recoverLostProcesses(normalizeState(JSON.parse(raw)));
  } catch {
    const state = emptyState();
    await saveState(state);
    return state;
  }
}

async function saveState(state: State) {
  await fs.mkdir(DEVROOMS_HOME, { recursive: true });
  const tmp = `${STATE_PATH}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`);
  await fs.rename(tmp, STATE_PATH);
}

async function getState() {
  return ensureState();
}

function getProject(state: State, projectId: string) {
  const project = state.projects[projectId];
  if (!project) throw new HttpError(404, `unknown project: ${projectId}`);
  return project;
}

function getRoom(state: State, roomId: string) {
  const room = state.rooms[roomId];
  if (!room) throw new HttpError(404, `unknown room: ${roomId}`);
  return room;
}

async function assertPathInside(parent: string, child: string) {
  const parentPath = path.resolve(parent);
  const childPath = path.resolve(child);
  const rel = path.relative(parentPath, childPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new HttpError(400, 'path escaped room root');
  }
}

function run(command: string, args: string[], cwd: string, opts: { onChild?: (child: ChildProcess) => void; timeoutMs?: number } = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    opts.onChild?.(child);
    let stdout = '';
    let stderr = '';
    const limit = 2_000_000;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill('SIGTERM');
          reject(new HttpError(504, `${command} ${args.join(' ')} timed out`));
        }, opts.timeoutMs)
      : undefined;

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > limit) stdout = stdout.slice(-limit);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > limit) stderr = stderr.slice(-limit);
    });
    child.on('error', reject);
    child.on('close', (exitCode) => {
      if (timer) clearTimeout(timer);
      resolve({ exitCode: exitCode ?? 0, stdout, stderr });
    });
  });
}

async function runGit(room: Room, args: string[], opts: { timeoutMs?: number } = {}) {
  const result = await run('git', args, room.path, opts);
  if (result.exitCode !== 0) {
    throw new HttpError(500, result.stderr || result.stdout || `git ${args.join(' ')} failed`);
  }
  return result;
}

function parseStatus(raw: string) {
  const lines = raw.split('\n').filter(Boolean);
  const branchLine = lines.find((line) => line.startsWith('## ')) ?? '## unknown';
  const branch = branchLine.replace(/^## /, '');
  const files = lines
    .filter((line) => !line.startsWith('## '))
    .map((line) => ({
      index: line.slice(0, 1),
      workingTree: line.slice(1, 2),
      path: line.slice(3),
      raw: line,
      staged: line.slice(0, 1) !== ' ' && line.slice(0, 1) !== '?',
      dirty: line.slice(1, 2) !== ' ' || line.startsWith('??'),
    }));
  return { branch, files, raw, dirtyCount: files.length };
}

async function listBranches(room: Room) {
  const result = await runGit(room, ['branch', '--format=%(refname:short)']);
  return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
}

async function currentBranch(room: Room) {
  const result = await runGit(room, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return result.stdout.trim();
}

async function fileDiff(room: Room, file: string) {
  await assertPathInside(room.path, path.join(room.path, file));
  const status = await runGit(room, ['status', '--porcelain=v1', '--', file]);
  const isUntracked = status.stdout.startsWith('??');
  const unstaged = isUntracked
    ? await run('git', ['diff', '--no-index', '--', '/dev/null', file], room.path)
    : await runGit(room, ['diff', '--', file]);
  const staged = await runGit(room, ['diff', '--cached', '--', file]);
  return {
    path: file,
    diff: unstaged.stdout,
    stagedDiff: staged.stdout,
    status: status.stdout.trim(),
  };
}

function commandExists(cmd: string) {
  return spawnSync('sh', ['-lc', `command -v ${cmd} >/dev/null 2>&1`], { stdio: 'ignore' }).status === 0;
}

function agentPresets(): AgentPreset[] {
  const hasHermes = commandExists('hermes');
  const hasCodex = commandExists('codex');
  const hasClaude = commandExists('claude');
  const hasOpenCode = commandExists('opencode');
  return [
    {
      id: 'hermes-tui',
      label: 'Hermes TUI',
      description: 'Open a Hermes chat session inside this room.',
      command: 'hermes chat --tui --accept-hooks --pass-session-id',
      available: hasHermes,
    },
    {
      id: 'codex-tui',
      label: 'Codex TUI',
      description: 'Open interactive Codex in this room.',
      command: 'codex',
      available: hasCodex,
    },
    {
      id: 'claude-code',
      label: 'Claude Code',
      description: 'Open Claude Code in this room. Uses npx/pnpm dlx fallback if claude is not installed globally.',
      command: hasClaude ? 'claude' : 'pnpm dlx @anthropic-ai/claude-code',
      available: hasClaude || commandExists('pnpm'),
    },
    {
      id: 'opencode',
      label: 'OpenCode',
      description: 'Open OpenCode in this room.',
      command: 'opencode',
      available: hasOpenCode,
    },
  ];
}

function apiError(error: unknown, res: express.Response) {
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  console.error(error);
  res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
}

async function detectDefaultBranch(repoUrl: string) {
  const result = await run('git', ['ls-remote', '--symref', repoUrl, 'HEAD'], process.cwd(), { timeoutMs: 30_000 }).catch(() => undefined);
  const match = result?.stdout.match(/ref: refs\/heads\/([^\t\n ]+)\s+HEAD/);
  return match?.[1];
}

async function assertRepoReachable(repoUrl: string, defaultBranch: string) {
  let result: RunResult;
  try {
    result = await run('git', ['ls-remote', '--heads', repoUrl, defaultBranch], process.cwd(), { timeoutMs: 30_000 });
  } catch (error) {
    throw new HttpError(400, `repository is not reachable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (result.exitCode !== 0) {
    throw new HttpError(400, result.stderr || result.stdout || 'repository is not reachable');
  }
  if (!result.stdout.trim()) {
    throw new HttpError(400, `default branch not found in repository: ${defaultBranch}`);
  }
}

async function createProject(body: unknown) {
  const input = body as Record<string, unknown>;
  const name = requireString(input.name, 'name');
  const repoUrl = requireString(input.repoUrl, 'repoUrl');
  const suppliedBranch = typeof input.defaultBranch === 'string' && input.defaultBranch.trim() ? input.defaultBranch.trim() : undefined;
  const defaultBranch = suppliedBranch ?? (await detectDefaultBranch(repoUrl)) ?? 'main';
  await assertRepoReachable(repoUrl, defaultBranch);
  const id = slugify(typeof input.id === 'string' && input.id.trim() ? input.id : name);
  if (!id) throw new HttpError(400, 'project id is empty after slugification');

  const state = await getState();
  const existing = state.projects[id];
  const stamp = now();
  const project: Project = {
    id,
    name,
    repoUrl,
    defaultBranch,
    createdAt: existing?.createdAt ?? stamp,
    updatedAt: stamp,
  };
  state.projects[id] = project;
  await saveState(state);
  return project;
}

async function createRoom(projectId: string, body: unknown) {
  const input = body as Record<string, unknown>;
  const state = await getState();
  const project = getProject(state, projectId);
  const name = requireString(input.name, 'name');
  const branch = typeof input.branch === 'string' && input.branch.trim() ? input.branch.trim() : undefined;
  const id = slugify(`${project.id}-${name}`);
  if (!id) throw new HttpError(400, 'room id is empty after slugification');
  if (state.rooms[id]) throw new HttpError(409, `room already exists: ${id}`);

  const roomPath = path.join(ROOMS_ROOT, project.id, slugify(name));
  await assertPathInside(ROOMS_ROOT, roomPath);
  try {
    await fs.access(roomPath);
    throw new HttpError(409, `room path already exists: ${roomPath}`);
  } catch (error) {
    if (error instanceof HttpError) throw error;
  }

  const stamp = now();
  const room: Room = {
    id,
    projectId: project.id,
    name,
    path: roomPath,
    branch: branch ?? project.defaultBranch,
    status: 'creating',
    createdAt: stamp,
    updatedAt: stamp,
  };
  state.rooms[id] = room;
  await saveState(state);

  void materializeRoom(project, room).catch((error) => console.error('room clone failed', error));
  return room;
}

async function materializeRoom(project: Project, room: Room) {
  try {
    await fs.mkdir(path.dirname(room.path), { recursive: true });
    const cloneArgs = room.branch ? ['clone', '--branch', room.branch, project.repoUrl, room.path] : ['clone', project.repoUrl, room.path];
    const clone = await run('git', cloneArgs, path.dirname(room.path), {
      onChild: (child) => cloneJobs.set(room.id, child),
      timeoutMs: 15 * 60_000,
    });
    if (clone.exitCode !== 0) throw new Error(clone.stderr || clone.stdout || 'git clone failed');
    room.status = 'idle';
    room.updatedAt = now();
  } catch (error) {
    room.status = 'error';
    room.error = error instanceof Error ? error.message : String(error);
    room.updatedAt = now();
  } finally {
    cloneJobs.delete(room.id);
  }

  const latest = await getState();
  if (deletedRoomTokens.has(roomToken(room)) || latest.rooms[room.id]?.createdAt !== room.createdAt) return;
  latest.rooms[room.id] = room;
  await saveState(latest);
}

async function deleteRoom(roomId: string, body: unknown) {
  const input = body as Record<string, unknown>;
  const deleteFiles = input.deleteFiles === true;
  const force = input.force === true;
  const state = await getState();
  const room = getRoom(state, roomId);
  deletedRoomTokens.add(roomToken(room));
  const cloneJob = cloneJobs.get(roomId);
  if (cloneJob && !cloneJob.killed) cloneJob.kill('SIGTERM');
  cloneJobs.delete(roomId);
  const running = [...processes.values()].filter((proc) => proc.roomId === roomId && proc.status === 'running');
  if (running.length && !force) {
    throw new HttpError(409, `room has ${running.length} running process(es); kill them or pass force=true`);
  }
  for (const proc of running) {
    proc.pty.kill();
    proc.status = 'exited';
    proc.exitedAt = now();
  }
  for (const proc of [...processes.values()].filter((item) => item.roomId === roomId)) {
    processes.delete(proc.id);
  }
  for (const [id, record] of Object.entries(state.processes)) {
    if (record.roomId === roomId) delete state.processes[id];
  }
  delete state.rooms[roomId];
  await saveState(state);
  if (deleteFiles) {
    await assertPathInside(ROOMS_ROOT, room.path);
    await fs.rm(room.path, { recursive: true, force: true });
  }
  return { room, deleteFiles, killed: running.length };
}

function processLogTail(proc: ManagedProcess) {
  return proc.log.join('').slice(-4000);
}

function recordFromProcess(proc: ManagedProcess): ProcessRecord {
  return {
    id: proc.id,
    roomId: proc.roomId,
    name: proc.name,
    command: proc.command,
    status: proc.status,
    startedAt: proc.startedAt,
    exitedAt: proc.exitedAt,
    exitCode: proc.exitCode,
    logTail: processLogTail(proc),
  };
}

async function saveProcessRecord(record: ProcessRecord) {
  const state = await getState();
  if (!state.rooms[record.roomId]) return;
  state.processes[record.id] = record;
  await saveState(state);
}

async function removeProcessRecord(processId: string) {
  const state = await getState();
  if (!state.processes[processId]) return false;
  delete state.processes[processId];
  await saveState(state);
  return true;
}

async function spawnProcess(room: Room, command: string, name?: string) {
  const id = `proc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const shell = process.env.SHELL ?? '/bin/zsh';
  const child = pty.spawn(shell, ['-lc', command], {
    name: 'xterm-256color',
    cols: 120,
    rows: 36,
    cwd: room.path,
    env: { ...process.env, DEVROOMS_ROOM_ID: room.id, DEVROOMS_ROOM_PATH: room.path },
  });
  const managed: ManagedProcess = {
    id,
    roomId: room.id,
    name: name || command,
    command,
    status: 'running',
    startedAt: now(),
    pty: child,
    log: [],
  };
  child.onData((data) => {
    managed.log.push(data);
    if (managed.log.length > 2000) managed.log.splice(0, managed.log.length - 2000);
  });
  child.onExit(({ exitCode }) => {
    managed.status = 'exited';
    managed.exitCode = exitCode;
    managed.exitedAt = now();
    void saveProcessRecord(recordFromProcess(managed)).catch((error) => console.error('failed to persist process exit', error));
  });
  processes.set(id, managed);
  await saveProcessRecord(recordFromProcess(managed));
  return managed;
}

function processSummary(proc: ManagedProcess | ProcessRecord) {
  const logTail = 'log' in proc ? processLogTail(proc) : proc.logTail ?? '';
  return {
    id: proc.id,
    roomId: proc.roomId,
    name: proc.name,
    command: proc.command,
    status: proc.status,
    startedAt: proc.startedAt,
    exitedAt: proc.exitedAt,
    exitCode: proc.exitCode,
    logTail,
  };
}

function processCountsByRoom(state: State) {
  const counts: Record<string, { lost: number; running: number; total: number }> = {};
  for (const proc of Object.values(state.processes)) {
    const current = counts[proc.roomId] ?? { lost: 0, running: 0, total: 0 };
    current.total += 1;
    if (proc.status === 'running') current.running += 1;
    if (proc.status === 'lost') current.lost += 1;
    counts[proc.roomId] = current;
  }
  return counts;
}

function metaSummary(state: State) {
  return {
    name: APP_NAME,
    version: APP_VERSION,
    startedAt: STARTED_AT,
    uptimeSeconds: Math.round(process.uptime()),
    pid: process.pid,
    platform: process.platform,
    node: process.version,
    bindHost: BIND_HOST,
    port: PORT,
    home: DEVROOMS_HOME,
    roomsRoot: ROOMS_ROOT,
    projectCount: Object.keys(state.projects).length,
    roomCount: Object.keys(state.rooms).length,
    processCount: Object.keys(state.processes).length,
    runningProcessCount: Object.values(state.processes).filter((proc) => proc.status === 'running').length,
  };
}

async function killAllProcesses() {
  for (const proc of processes.values()) {
    if (proc.status === 'running') {
      proc.pty.kill();
      proc.status = 'exited';
      proc.exitedAt = now();
      await saveProcessRecord(recordFromProcess(proc));
    }
  }
}

function wirePtySocket(ws: WebSocket, child: pty.IPty, replay = '') {
  if (replay) ws.send(JSON.stringify({ type: 'output', data: replay }));
  const disposable = child.onData((data) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'output', data }));
  });
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString()) as { type?: string; data?: string; cols?: number; rows?: number };
      if (msg.type === 'input' && typeof msg.data === 'string') child.write(msg.data);
      if (msg.type === 'resize' && msg.cols && msg.rows) child.resize(msg.cols, msg.rows);
    } catch (error) {
      ws.send(JSON.stringify({ type: 'output', data: `\r\n[devrooms websocket error] ${String(error)}\r\n` }));
    }
  });
  ws.on('close', () => disposable.dispose());
}

async function main() {
  await ensureState();
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  app.get('/api/health', async (_req, res) => {
    const state = await getState();
    res.json({ ok: true, ...metaSummary(state) });
  });

  app.get('/api/meta', async (_req, res) => {
    const state = await getState();
    res.json(metaSummary(state));
  });

  app.get('/api/presets', async (_req, res) => {
    res.json({ presets: agentPresets() });
  });

  app.get('/api/projects', async (_req, res) => {
    const state = await getState();
    res.json({ projects: Object.values(state.projects), rooms: Object.values(state.rooms), processCounts: processCountsByRoom(state) });
  });

  app.post('/api/projects', async (req, res) => {
    try {
      res.json({ project: await createProject(req.body) });
    } catch (error) {
      apiError(error, res);
    }
  });

  app.get('/api/projects/:projectId/rooms', async (req, res) => {
    try {
      const state = await getState();
      getProject(state, req.params.projectId);
      res.json({ rooms: Object.values(state.rooms).filter((room) => room.projectId === req.params.projectId) });
    } catch (error) {
      apiError(error, res);
    }
  });

  app.post('/api/projects/:projectId/rooms', async (req, res) => {
    try {
      res.status(202).json({ room: await createRoom(req.params.projectId, req.body) });
    } catch (error) {
      apiError(error, res);
    }
  });

  app.delete('/api/rooms/:roomId', async (req, res) => {
    try {
      res.json({ ok: true, ...(await deleteRoom(req.params.roomId, req.body ?? {})) });
    } catch (error) {
      apiError(error, res);
    }
  });

  app.get('/api/rooms/:roomId/git/status', async (req, res) => {
    try {
      const state = await getState();
      const room = getRoom(state, req.params.roomId);
      const status = await runGit(room, ['status', '--porcelain=v1', '-b']);
      const head = await runGit(room, ['rev-parse', '--short', 'HEAD']).catch(() => ({ stdout: '' }));
      res.json({ status: parseStatus(status.stdout), branches: await listBranches(room), head: head.stdout.trim() });
    } catch (error) {
      apiError(error, res);
    }
  });

  app.get('/api/rooms/:roomId/git/diff', async (req, res) => {
    try {
      const state = await getState();
      const room = getRoom(state, req.params.roomId);
      const file = requireString(req.query.path, 'path');
      res.json(await fileDiff(room, file));
    } catch (error) {
      apiError(error, res);
    }
  });

  app.post('/api/rooms/:roomId/git/:op', async (req, res) => {
    try {
      const state = await getState();
      const room = getRoom(state, req.params.roomId);
      const op = req.params.op;
      let result: RunResult;
      if (op === 'stage') {
        const file = requireString(req.body?.path, 'path');
        await assertPathInside(room.path, path.join(room.path, file));
        result = await runGit(room, ['add', '--', file]);
      } else if (op === 'unstage') {
        const file = requireString(req.body?.path, 'path');
        await assertPathInside(room.path, path.join(room.path, file));
        result = await runGit(room, ['restore', '--staged', '--', file]);
      } else if (op === 'fetch') {
        result = await runGit(room, ['fetch', '--all', '--prune'], { timeoutMs: 5 * 60_000 });
      } else if (op === 'pull') {
        result = await runGit(room, ['pull', '--ff-only'], { timeoutMs: 5 * 60_000 });
      } else if (op === 'push') {
        const branch = await currentBranch(room);
        result = await runGit(room, ['push', '-u', 'origin', branch], { timeoutMs: 5 * 60_000 });
      } else if (op === 'checkout') {
        const branch = requireString(req.body?.branch, 'branch');
        result = await runGit(room, ['checkout', branch]);
      } else if (op === 'checkout-new') {
        const branch = requireString(req.body?.branch, 'branch');
        result = await runGit(room, ['checkout', '-b', branch]);
      } else if (op === 'commit') {
        const message = requireString(req.body?.message, 'message');
        result = await runGit(room, ['commit', '-m', message]);
      } else {
        throw new HttpError(404, `unknown git operation: ${op}`);
      }
      res.json({ ok: true, stdout: result.stdout, stderr: result.stderr });
    } catch (error) {
      apiError(error, res);
    }
  });

  app.get('/api/rooms/:roomId/processes', async (req, res) => {
    const state = await getState();
    const byId = new Map<string, ReturnType<typeof processSummary>>();
    for (const record of Object.values(state.processes).filter((proc) => proc.roomId === req.params.roomId)) {
      byId.set(record.id, processSummary(processes.get(record.id) ?? record));
    }
    for (const proc of [...processes.values()].filter((item) => item.roomId === req.params.roomId)) {
      byId.set(proc.id, processSummary(proc));
    }
    res.json({ processes: [...byId.values()] });
  });

  app.post('/api/rooms/:roomId/processes', async (req, res) => {
    try {
      const state = await getState();
      const room = getRoom(state, req.params.roomId);
      const command = requireString(req.body?.command, 'command');
      const name = typeof req.body?.name === 'string' ? req.body.name : undefined;
      const proc = await spawnProcess(room, command, name);
      res.json({ process: processSummary(proc) });
    } catch (error) {
      apiError(error, res);
    }
  });

  app.delete('/api/processes/:processId', async (req, res) => {
    const proc = processes.get(req.params.processId);
    if (!proc) {
      const removed = await removeProcessRecord(req.params.processId);
      if (!removed) return res.status(404).json({ error: 'unknown process' });
      return res.json({ ok: true, removed: true });
    }
    if (proc.status === 'running') proc.pty.kill();
    proc.status = 'exited';
    proc.exitedAt = now();
    await saveProcessRecord(recordFromProcess(proc));
    res.json({ ok: true });
  });

  const staticDir = path.join(__dirname, 'client');
  try {
    await fs.access(staticDir);
    app.use(express.static(staticDir));
    app.get('*splat', (_req, res) => res.sendFile(path.join(staticDir, 'index.html')));
  } catch {
    app.get('/', (_req, res) => res.type('text/plain').send('devrooms daemon running; build client with pnpm build'));
  }

  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', async (req, socket, head) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const roomTerminal = url.pathname.match(/^\/ws\/rooms\/([^/]+)\/terminal$/);
      const processTerminal = url.pathname.match(/^\/ws\/processes\/([^/]+)$/);

      if (!roomTerminal && !processTerminal) {
        socket.destroy();
        return;
      }

      wss.handleUpgrade(req, socket, head, async (ws) => {
        if (roomTerminal) {
          const state = await getState();
          const room = getRoom(state, roomTerminal[1]);
          const shell = process.env.SHELL ?? '/bin/zsh';
          const child = pty.spawn(shell, [], {
            name: 'xterm-256color',
            cols: 120,
            rows: 36,
            cwd: room.path,
            env: { ...process.env, DEVROOMS_ROOM_ID: room.id, DEVROOMS_ROOM_PATH: room.path },
          });
          child.write(`printf '\\033]0;devrooms: ${room.name.replace(/'/g, '')}\\007'\r`);
          wirePtySocket(ws, child);
          ws.on('close', () => child.kill());
          return;
        }

        if (processTerminal) {
          const proc = processes.get(processTerminal[1]);
          if (!proc) {
            const state = await getState();
            const record = state.processes[processTerminal[1]];
            if (record) {
              const replay = record.logTail ? `${record.logTail}\r\n` : '';
              ws.send(JSON.stringify({ type: 'output', data: `${replay}[process ${record.status}; PTY is not attached]\r\n` }));
            } else {
              ws.send(JSON.stringify({ type: 'output', data: '[unknown process]\r\n' }));
            }
            ws.close();
            return;
          }
          wirePtySocket(ws, proc.pty, proc.log.join(''));
        }
      });
    } catch (error) {
      console.error(error);
      socket.destroy();
    }
  });

  server.listen(PORT, BIND_HOST, () => {
    console.log(`devrooms listening on http://${BIND_HOST}:${PORT}`);
    console.log(`state: ${STATE_PATH}`);
    console.log(`rooms: ${ROOMS_ROOT}`);
  });

  const shutdown = () => {
    void (async () => {
      await killAllProcesses();
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 1000).unref();
    })().catch((error) => {
      console.error('failed to persist process shutdown', error);
      process.exit(1);
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
