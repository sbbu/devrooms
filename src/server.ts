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
  rootPath?: string;
  createdAt: string;
  updatedAt: string;
};

type RoomKind = 'clone' | 'main';

type Room = {
  id: string;
  projectId: string;
  name: string;
  path: string;
  kind?: RoomKind;
  branch?: string;
  status: 'creating' | 'idle' | 'error';
  error?: string;
  // Ordered terminal ids tiled inside the room. Absent on legacy rooms — treated
  // as the single ['main'] terminal. 'main' is always present and never closes.
  terminals?: string[];
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
  pty?: pty.IPty;
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
  const running = await ptyHostRunningKeys();
  for (const record of Object.values(state.processes)) {
    if (record.status === 'running' && !running.has(`proc:${record.id}`)) {
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
  let state: State;
  try {
    const raw = await fs.readFile(STATE_PATH, 'utf8');
    state = await recoverLostProcesses(normalizeState(JSON.parse(raw)));
  } catch {
    state = emptyState();
    await saveState(state);
  }
  return ensureLaunchProject(state);
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

function expandUserPath(value: string) {
  if (value === '~') return os.homedir();
  if (value.startsWith(`~${path.sep}`)) return path.join(os.homedir(), value.slice(2));
  return value;
}

function resolveLocalPath(value: string) {
  return path.resolve(expandUserPath(value));
}

async function pathExists(value: string) {
  try {
    await fs.access(value);
    return true;
  } catch {
    return false;
  }
}

async function gitRootFor(value: string) {
  const result = await run('git', ['rev-parse', '--show-toplevel'], value, { timeoutMs: 10_000 }).catch(() => undefined);
  if (result?.exitCode !== 0) return undefined;
  const root = result?.stdout.trim();
  return root ? path.resolve(root) : undefined;
}

async function branchForPath(cwd: string) {
  const result = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd, { timeoutMs: 10_000 }).catch(() => undefined);
  const branch = result?.stdout.trim();
  return result?.exitCode === 0 && branch && branch !== 'HEAD' ? branch : undefined;
}

async function resolveProjectRoot(input: unknown) {
  if (typeof input !== 'string' || !input.trim()) return undefined;
  const requested = resolveLocalPath(input.trim());
  const exists = await pathExists(requested);
  if (!exists) throw new HttpError(400, `project path does not exist: ${requested}`);
  const root = await gitRootFor(requested);
  if (!root) throw new HttpError(400, `project path is not inside a git repository: ${requested}`);
  return root;
}

function mainRoomId(projectId: string) {
  return `${projectId}-main`;
}

// The main room IS the picked working copy, so its branch is just whatever that
// checkout currently has — read it live rather than storing a project-level one.
async function upsertMainRoom(state: State, project: Project, rootPath: string) {
  const branch = (await branchForPath(rootPath)) ?? 'main';
  const id = mainRoomId(project.id);
  const existing = state.rooms[id];
  if (
    existing?.projectId === project.id &&
    existing.name === 'main' &&
    existing.path === rootPath &&
    existing.kind === 'main' &&
    existing.branch === branch &&
    existing.status === 'idle'
  ) {
    return false;
  }
  const stamp = now();
  state.rooms[id] = {
    id,
    projectId: project.id,
    name: 'main',
    path: rootPath,
    kind: 'main',
    branch,
    status: 'idle',
    createdAt: existing?.createdAt ?? stamp,
    updatedAt: stamp,
  };
  return true;
}

async function defaultLaunchProject() {
  const configuredPath = process.env.DEVROOMS_PROJECT_PATH?.trim();
  if (!configuredPath) return undefined;
  const rootPath = await resolveProjectRoot(configuredPath);
  if (!rootPath) return undefined;
  // The project name is identity, not config: derive it from the repo directory
  // rather than an env var (per repo rule — names are never env-configured).
  const name = path.basename(rootPath);
  const id = slugify(name);
  if (!id) return undefined;
  const repoUrl = process.env.DEVROOMS_PROJECT_REPO_URL?.trim() || rootPath;
  return { id, name, repoUrl, rootPath };
}

async function ensureLaunchProject(state: State) {
  const launch = await defaultLaunchProject();
  if (!launch) return state;
  const stamp = now();
  const existing = state.projects[launch.id];
  const project: Project = {
    id: launch.id,
    name: launch.name,
    repoUrl: launch.repoUrl,
    rootPath: launch.rootPath,
    createdAt: existing?.createdAt ?? stamp,
    updatedAt: existing?.updatedAt ?? stamp,
  };
  const changedProject = !existing || existing.name !== project.name || existing.repoUrl !== project.repoUrl || existing.rootPath !== project.rootPath;
  if (changedProject) state.projects[project.id] = project;
  const changedRoom = await upsertMainRoom(state, project, launch.rootPath);
  if (changedProject || changedRoom) await saveState(state);
  return state;
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
    .map((line) => {
      const x = line.slice(0, 1);
      const y = line.slice(1, 2);
      const xy = line.slice(0, 2);
      return {
        index: x,
        workingTree: y,
        path: line.slice(3),
        raw: line,
        staged: x !== ' ' && x !== '?',
        dirty: y !== ' ' || line.startsWith('??'),
        // Unmerged paths from a conflicted merge: any U, or both sides added/deleted.
        // `conflicted` (still has markers) is refined by the status endpoint.
        unmerged: x === 'U' || y === 'U' || xy === 'AA' || xy === 'DD',
        conflicted: false,
      };
    });
  const ahead = Number(/\bahead (\d+)/.exec(branch)?.[1] ?? 0);
  const behind = Number(/\bbehind (\d+)/.exec(branch)?.[1] ?? 0);
  const hasUpstream = branch.includes('...');
  return { branch, files, raw, dirtyCount: files.length, ahead, behind, hasUpstream };
}

// Degraded status returned when git itself can't be read — keeps the panel rendering.
const EMPTY_GIT_STATUS = { branch: '', files: [] as ReturnType<typeof parseStatus>['files'], raw: '', dirtyCount: 0, ahead: 0, behind: 0, hasUpstream: false, unpushedCount: 0, merging: false };

// A file is still in conflict while it carries both the opening and closing merge
// markers git writes. Requiring both avoids false positives from a lone `=======`.
async function hasConflictMarkers(absPath: string): Promise<boolean> {
  try {
    const text = await fs.readFile(absPath, 'utf8');
    return /^<{7}[ \t]/m.test(text) && /^>{7}[ \t]/m.test(text);
  } catch {
    return false; // gone (e.g. delete/delete) — nothing to resolve in-file
  }
}

async function listBranches(room: Room) {
  // Include remote-tracking branches, not just local ones: a fresh clone has a
  // single local branch, so without the origin/* refs the branch picker would
  // only ever offer that one branch. Checking out a bare "main" that exists only
  // as origin/main makes git auto-create a local tracking branch (DWIM). Use full
  // refnames (not :short, which collapses refs/remotes/origin/HEAD to "origin").
  const result = await runGit(room, ['branch', '-a', '--format=%(refname)']);
  const seen = new Set<string>();
  const branches: string[] = [];
  for (const ref of result.stdout.split('\n').map((line) => line.trim()).filter(Boolean)) {
    if (ref.endsWith('/HEAD')) continue; // skip symbolic refs like origin/HEAD
    let name: string;
    if (ref.startsWith('refs/heads/')) name = ref.slice('refs/heads/'.length);
    else if (ref.startsWith('refs/remotes/origin/')) name = ref.slice('refs/remotes/origin/'.length);
    else continue; // skip non-origin remotes (checking them out would detach HEAD)
    if (seen.has(name)) continue; // local branch already covers this name
    seen.add(name);
    branches.push(name);
  }
  return branches;
}

async function currentBranch(room: Room) {
  const result = await runGit(room, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return result.stdout.trim();
}

// Resolve a picked branch name to a ref git can merge. The branch picker collapses
// refs/remotes/origin/* to short names, so a name may exist only as a remote-tracking
// ref (a branch worked on in another room, fetched but never checked out here). Prefer
// the local branch; fall back to origin/<name>; otherwise it isn't a branch we can merge.
async function resolveMergeRef(room: Room, branch: string): Promise<string> {
  for (const ref of [branch, `origin/${branch}`]) {
    if ((await run('git', ['rev-parse', '-q', '--verify', `${ref}^{commit}`], room.path)).exitCode === 0) return ref;
  }
  throw new HttpError(409, `no such branch to merge: ${branch}`);
}

async function fileDiff(room: Room, file: string) {
  await assertPathInside(room.path, path.join(room.path, file));
  const status = await runGit(room, ['status', '--porcelain=v1', '--', file]);
  const isUntracked = status.stdout.startsWith('??');
  const unstaged = isUntracked
    ? await run('git', ['diff', '--no-index', '--', '/dev/null', file], room.path)
    : await runGit(room, ['diff', '--', file]);
  const staged = await runGit(room, ['diff', '--cached', '--', file]);
  // fullDiff = the entire change vs HEAD (staged + unstaged), i.e. exactly what
  // a commit of this file would record. Used by the checkbox-based UI.
  let fullDiff = unstaged.stdout;
  if (!isUntracked) {
    const full = await runGit(room, ['diff', 'HEAD', '--', file]).catch(() => null);
    fullDiff = full ? full.stdout : unstaged.stdout;
  }
  return {
    path: file,
    diff: unstaged.stdout,
    stagedDiff: staged.stdout,
    fullDiff,
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
      command: 'hermes chat --tui --source devrooms --accept-hooks --pass-session-id',
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

async function assertRepoReachable(repoUrl: string) {
  let result: RunResult;
  try {
    result = await run('git', ['ls-remote', '--heads', repoUrl], process.cwd(), { timeoutMs: 30_000 });
  } catch (error) {
    throw new HttpError(400, `repository is not reachable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (result.exitCode !== 0) {
    throw new HttpError(400, result.stderr || result.stdout || 'repository is not reachable');
  }
}

async function createProject(body: unknown) {
  const input = body as Record<string, unknown>;
  const rootPath = await resolveProjectRoot(input.rootPath);
  // The project name is identity — when a local repo is picked, derive it from
  // the repo directory rather than making the user type it.
  const name = (typeof input.name === 'string' && input.name.trim())
    ? input.name.trim()
    : rootPath
      ? path.basename(rootPath)
      : requireString(input.name, 'name');
  const suppliedRepoUrl = typeof input.repoUrl === 'string' && input.repoUrl.trim() ? input.repoUrl.trim() : undefined;
  const repoUrl = suppliedRepoUrl ?? rootPath;
  if (!repoUrl) throw new HttpError(400, 'repoUrl is required unless rootPath is set');
  await assertRepoReachable(repoUrl);
  const id = slugify(typeof input.id === 'string' && input.id.trim() ? input.id : name);
  if (!id) throw new HttpError(400, 'project id is empty after slugification');

  const state = await getState();
  const existing = state.projects[id];
  const stamp = now();
  const project: Project = {
    id,
    name,
    repoUrl,
    rootPath,
    createdAt: existing?.createdAt ?? stamp,
    updatedAt: stamp,
  };
  state.projects[id] = project;
  if (rootPath) await upsertMainRoom(state, project, rootPath);
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
    kind: 'clone',
    // No explicit branch => clone the repo's default branch (origin/HEAD, i.e.
    // main/master) rather than whatever branch the project happened to launch on.
    // The actual branch is recorded after the clone, in materializeRoom.
    branch,
    status: 'creating',
    createdAt: stamp,
    updatedAt: stamp,
  };
  state.rooms[id] = room;
  await saveState(state);

  void materializeRoom(project, room).catch((error) => console.error('room clone failed', error));
  return room;
}

// A clone room is created with `git clone <project.repoUrl> …`. For a folder-picked
// project repoUrl is a local path, so the clone's origin is the user's own non-bare
// repo — which refuses `git push` to whatever branch is checked out there. Repoint
// origin at that local repo's OWN upstream (the real remote) so a clone behaves like a
// normal clone: push/pull hit a bare remote, divergence flows through pull & merge.
async function isLocalRepoPath(repoUrl: string): Promise<boolean> {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(repoUrl)) return false; // https:// ssh:// git:// file://
  if (/^[^/\\]+@[^/\\]+:/.test(repoUrl)) return false;        // scp-like git@host:path
  try { return (await fs.stat(repoUrl)).isDirectory(); } catch { return false; }
}

async function remoteUrl(repoPath: string, remote = 'origin'): Promise<string | null> {
  const result = await run('git', ['remote', 'get-url', remote], repoPath);
  const url = result.exitCode === 0 ? result.stdout.trim() : '';
  return url || null;
}

// A push target is safe unless it's a local NON-bare repo: only those refuse a push to
// their checked-out branch. Remote URLs and local bare repos accept pushes fine.
async function isPushableTarget(url: string): Promise<boolean> {
  if (!(await isLocalRepoPath(url))) return true;
  const result = await run('git', ['rev-parse', '--is-bare-repository'], url);
  return result.exitCode === 0 && result.stdout.trim() === 'true';
}

// Idempotent. No-op once origin is already pushable, or when the local source has no
// usable upstream of its own (then we keep the local origin as a fallback).
async function ensureCloneRemote(room: Room): Promise<void> {
  if (room.kind !== 'clone') return;
  const origin = await remoteUrl(room.path);
  if (!origin || (await isPushableTarget(origin))) return;
  const upstream = await remoteUrl(origin);
  if (!upstream || upstream === origin || !(await isPushableTarget(upstream))) return;
  await run('git', ['remote', 'set-url', 'origin', upstream], room.path);
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
    // Folder-picked projects clone from a local path; point origin at the real remote.
    await ensureCloneRemote(room).catch((error) => console.error('clone remote repoint failed', error));
    await run('git', ['fetch', 'origin', '--prune'], room.path).catch(() => { /* offline: keep local refs */ });
    // Record the branch git actually checked out (the repo default when none was
    // requested), so the room label and status reflect reality.
    room.branch = (await currentBranch(room).catch(() => undefined)) || room.branch;
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
  if (deleteFiles && room.kind === 'main') {
    throw new HttpError(400, 'main repo room files are never deleted by devrooms');
  }
  deletedRoomTokens.add(roomToken(room));
  const cloneJob = cloneJobs.get(roomId);
  if (cloneJob && !cloneJob.killed) cloneJob.kill('SIGTERM');
  cloneJobs.delete(roomId);
  // Liveness lives in the pty-host now, not the in-memory map (which has no
  // local exit handler and goes stale), so reconcile against the host.
  const hostRunning = await ptyHostRunningKeys();
  const running = [...processes.values()].filter((proc) => proc.roomId === roomId && hostRunning.has(`proc:${proc.id}`));
  if (running.length && !force) {
    throw new HttpError(409, `room has ${running.length} running process(es); kill them or pass force=true`);
  }
  await killAllRoomTerminals(room);
  for (const proc of running) {
    await ptyHostKill(`proc:${proc.id}`);
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

function appendPtyLog(log: string[], data: string) {
  log.push(data);
  if (log.length > 5000) log.splice(0, log.length - 5000);
}

function ptyLogTail(log: string[], maxChars = 4000) {
  return log.join('').slice(-maxChars);
}

function processLogTail(proc: ManagedProcess) {
  return ptyLogTail(proc.log);
}

// A room tiles multiple terminals. The "main" terminal keeps the bare
// `room:<id>` host key so existing live sessions survive this change untouched;
// extras are `room:<id>:<terminalId>`.
const MAX_ROOM_TERMINALS = 6;

function roomTerminalKey(roomId: string, terminalId: string) {
  return terminalId === 'main' ? `room:${roomId}` : `room:${roomId}:${terminalId}`;
}

function roomTerminalIds(room: Room) {
  return room.terminals?.length ? room.terminals : ['main'];
}

async function ensureRoomTerminal(room: Room, terminalId = 'main') {
  void installAgentStatusHooks(room); // fire-and-forget; never blocks the spawn
  await ptyHostSpawn(roomTerminalKey(room.id, terminalId), { cwd: room.path, env: devroomEnv(room) });
}

// Explicit per-agent status reporting. Each agent runs a hook on its lifecycle
// events that emits our private OSC 9279;<state> to the tty, which the pty-host
// parses into precise thinking / needs-input / done. Best-effort and idempotent;
// guarded by $DEVROOMS_ROOM_ID so it is a no-op outside devrooms terminals.
const agentHooksInstalled = new Set<string>();
let opencodePluginChecked = false;

type ClaudeHookEntry = { matcher?: string; hooks: Array<{ type: string; command: string }> };
type ClaudeSettings = { hooks?: Record<string, ClaudeHookEntry[]> } & Record<string, unknown>;

function statusHookCommand(state: string) {
  // Redirect stderr BEFORE stdout: if there is no controlling terminal, opening
  // /dev/tty fails, and with `2>/dev/null` already in effect that error is
  // swallowed instead of leaking as "/dev/tty: Device not configured". `|| true`
  // keeps the hook's exit status 0 so Claude Code never flags a failed hook.
  return `printf '\\033]9279;${state}\\033\\\\' 2>/dev/null >/dev/tty || true`;
}

async function installClaudeStatusHooks(room: Room) {
  const dir = path.join(room.path, '.claude');
  const file = path.join(dir, 'settings.local.json');
  let settings: ClaudeSettings = {};
  try {
    settings = JSON.parse(await fs.readFile(file, 'utf8')) as ClaudeSettings;
    if (!settings || typeof settings !== 'object') return; // leave anything unexpected alone
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return; // unreadable/malformed
  }
  const hooks = settings.hooks ?? (settings.hooks = {});
  const events: Array<[string, string]> = [['UserPromptSubmit', 'working'], ['Notification', 'needs-input'], ['Stop', 'done']];
  let changed = false;
  for (const [event, state] of events) {
    const list = hooks[event] ?? (hooks[event] = []);
    const command = statusHookCommand(state);
    // Find a previously-installed devrooms hook by its 9279 marker. If present but
    // using an older command form, heal it in place; otherwise install fresh. This
    // upgrades existing rooms instead of leaving stale (e.g. /dev/tty-erroring) hooks.
    const ours = list.find((entry) => entry.hooks?.some((h) => h.command?.includes('9279')));
    if (ours) {
      if (ours.hooks.length === 1 && ours.hooks[0]?.command === command) continue; // already current
      ours.matcher = '*';
      ours.hooks = [{ type: 'command', command }];
      changed = true;
      continue;
    }
    list.push({ matcher: '*', hooks: [{ type: 'command', command }] });
    changed = true;
  }
  if (!changed) return;
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(settings, null, 2)}\n`);
  console.log(`devrooms: installed Claude status hooks -> ${file}`);
}

async function installOpencodeStatusPlugin() {
  const configDir = path.join(os.homedir(), '.config', 'opencode');
  try { await fs.access(configDir); } catch { return; } // not an opencode user — skip
  const pluginDir = path.join(configDir, 'plugin');
  const file = path.join(pluginDir, 'devrooms-status.js');
  try { if ((await fs.readFile(file, 'utf8')).includes('9279')) return; } catch { /* not present yet */ }
  const content = `// Installed by devrooms — reports agent status to the devrooms sidebar.
import { writeFileSync } from "node:fs";
const mark = (s) => { try { if (process.env.DEVROOMS_ROOM_ID) writeFileSync("/dev/tty", "\\u001b]9279;" + s + "\\u001b\\\\"); } catch {} };
export const DevroomsStatus = async () => ({
  event: async ({ event }) => {
    if (event.type === "session.idle") mark("done");
    else if (event.type === "message.updated") mark("working");
  },
});
`;
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(file, content);
  console.log(`devrooms: installed opencode status plugin -> ${file}`);
}

async function installAgentStatusHooks(room: Room) {
  if (!agentHooksInstalled.has(room.id)) {
    agentHooksInstalled.add(room.id);
    await installClaudeStatusHooks(room).catch((error) => console.log(`devrooms: claude hook install skipped: ${error}`));
  }
  if (!opencodePluginChecked) {
    opencodePluginChecked = true;
    await installOpencodeStatusPlugin().catch((error) => console.log(`devrooms: opencode plugin install skipped: ${error}`));
  }
}

async function killRoomTerminal(roomId: string, terminalId = 'main') {
  await ptyHostKill(roomTerminalKey(roomId, terminalId));
}

async function killAllRoomTerminals(room: Room) {
  for (const terminalId of roomTerminalIds(room)) await killRoomTerminal(room.id, terminalId);
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

function devroomEnv(room: Room): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'devrooms',
    DEVROOMS_ROOM_ID: room.id,
    DEVROOMS_ROOM_NAME: room.name,
    DEVROOMS_ROOM_PATH: room.path,
    DEVROOMS_ROOM_KIND: room.kind ?? 'clone',
    DEVROOMS_PROJECT_ID: room.projectId,
    TERMINAL_CWD: room.path,
  };
  // The app/project name is never an env var — don't leak it into terminals.
  delete env.DEVROOMS_PROJECT_NAME;
  return env;
}

async function spawnProcess(room: Room, command: string, name?: string) {
  const id = `proc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  await ptyHostSpawn(`proc:${id}`, { kind: 'process', command, cwd: room.path, env: devroomEnv(room) });
  const managed: ManagedProcess = {
    id,
    roomId: room.id,
    name: name || command,
    command,
    status: 'running',
    startedAt: now(),
    log: [],
  };
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

// Lightweight per-room git signal for the sidebar: commits to pull (behind, vs
// the last-fetched origin ref), commits to push (local commits no origin ref
// holds — correct even without an upstream), and whether a merge left unmerged
// paths. Two cheap reads per room; any failure (not a repo, wedged, timeout)
// yields null so that room just shows no icons — the poller must never 500.
async function gitRoomSignal(room: Room): Promise<{ behind: number; unpushed: number; conflict: boolean } | null> {
  const status = await run('git', ['status', '--porcelain=v1', '-b'], room.path, { timeoutMs: 5000 });
  if (status.exitCode !== 0) return null;
  const parsed = parseStatus(status.stdout);
  const unpushed = await run('git', ['rev-list', '--count', 'HEAD', '--not', '--remotes=origin'], room.path, { timeoutMs: 5000 }).catch(() => ({ stdout: '' }));
  const unpushedCount = Number((unpushed?.stdout ?? '').trim()) || 0;
  return { behind: parsed.behind, unpushed: unpushedCount, conflict: parsed.files.some((file) => file.unmerged) };
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
  // No-op: PTYs live in the standalone pty-host so they survive daemon restarts.
  // The host is torn down separately (dev runner shutdown / electron quit).
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

const PTY_HOST_PORT = PORT + 1;
const PTY_HOST_URL = `http://127.0.0.1:${PTY_HOST_PORT}`;

// Every pty-host call gets a hard timeout. A wedged host (accepts the TCP connection
// but never replies — e.g. an orphan left after a crash) must NEVER hang the daemon:
// at boot, ensurePtyHost runs before app.listen, so an un-timed-out fetch there would
// stop the window from ever opening.
async function ptyHostFetch(pathAndQuery: string, init?: RequestInit, timeoutMs = 3000): Promise<Response> {
  return fetch(`${PTY_HOST_URL}${pathAndQuery}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

// Free PTY_HOST_PORT if a wedged predecessor is still holding it, so a fresh host can
// bind. Best-effort; only called when the existing host is already deemed unhealthy.
function freePtyHostPort() {
  if (process.platform === 'win32') return;
  try {
    spawnSync('sh', ['-c', `lsof -ti tcp:${PTY_HOST_PORT} | xargs kill -9`], { stdio: 'ignore', timeout: 3000 });
  } catch {
    /* noop */
  }
}

async function ptyHostHealthy() {
  try {
    const res = await ptyHostFetch('/health', undefined, 1500);
    return res.ok;
  } catch {
    return false;
  }
}

async function ensurePtyHost() {
  if (await ptyHostHealthy()) return;
  // Not healthy: a wedged predecessor may still hold the port and would block a fresh
  // host from binding — clear it before spawning.
  freePtyHostPort();
  // Spawn the host detached so it OUTLIVES daemon restarts (the whole point):
  // a reloaded daemon finds it healthy and reuses it, keeping PTYs alive.
  const here = fileURLToPath(import.meta.url);
  const dev = here.endsWith('.ts');
  const entry = path.join(path.dirname(here), dev ? 'pty-host.ts' : 'pty-host.js');
  const portArgs = ['--port', String(PTY_HOST_PORT)];
  const args = dev ? ['--import', 'tsx', entry, ...portArgs] : [entry, ...portArgs];
  const child = spawn(process.execPath, args, {
    cwd: path.dirname(here),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  for (let i = 0; i < 100; i++) {
    if (await ptyHostHealthy()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`pty-host did not become healthy at ${PTY_HOST_URL}`);
}

async function ptyHostRunningKeys(): Promise<Set<string>> {
  try {
    const res = await ptyHostFetch('/health', undefined, 1500);
    if (!res.ok) return new Set();
    const data = (await res.json()) as { running?: string[] };
    return new Set(data.running ?? []);
  } catch {
    return new Set();
  }
}

type HostActivity = { status: string; lastOutputMs: number; attentionMs: number; agentState?: string; agentStateMs: number };

async function ptyHostActivity(): Promise<{ now: number; sessions: Record<string, HostActivity> }> {
  try {
    const res = await ptyHostFetch('/activity', undefined, 2000);
    if (!res.ok) return { now: Date.now(), sessions: {} };
    return (await res.json()) as { now: number; sessions: Record<string, HostActivity> };
  } catch {
    return { now: Date.now(), sessions: {} };
  }
}

// Host keys are `room:<roomId>` / `room:<roomId>:<terminalId>` / `proc:<id>`.
function roomIdFromKey(key: string): string | null {
  const match = key.match(/^room:([^:]+)(?::.+)?$/);
  return match ? match[1] : null;
}

async function ptyHostSpawn(key: string, opts: { kind?: 'process'; command?: string; cwd: string; env: NodeJS.ProcessEnv }) {
  await ensurePtyHost();
  await ptyHostFetch('/spawn', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key, ...opts }),
  }, 5000);
}

async function ptyHostKill(key: string) {
  try {
    await ptyHostFetch('/kill', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key }) }, 2000);
  } catch {
    // host may be down; nothing to do
  }
}

async function ptyHostSession(key: string): Promise<{ status: 'running' | 'exited'; exitCode?: number; logTail: string } | null> {
  try {
    const res = await ptyHostFetch(`/session?key=${encodeURIComponent(key)}&max=200000`, undefined, 5000);
    if (!res.ok) return null;
    return (await res.json()) as { status: 'running' | 'exited'; exitCode?: number; logTail: string };
  } catch {
    return null;
  }
}

// Used only by the packaged app / tests, where the terminal WS hits the daemon.
// In dev, Vite proxies /ws straight to the host, so this is bypassed entirely.
function proxyTerminalSocket(client: WebSocket, upstreamUrl: string) {
  const upstream = new WebSocket(upstreamUrl);
  const pending: { data: any; binary: boolean }[] = [];
  client.on('message', (data, binary) => {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary });
    else pending.push({ data, binary });
  });
  upstream.on('open', () => {
    for (const item of pending) upstream.send(item.data, { binary: item.binary });
    pending.length = 0;
  });
  upstream.on('message', (data, binary) => {
    if (client.readyState === WebSocket.OPEN) client.send(data, { binary });
  });
  const closeBoth = () => {
    try { client.close(); } catch { /* noop */ }
    try { upstream.close(); } catch { /* noop */ }
  };
  client.on('close', closeBoth);
  upstream.on('close', closeBoth);
  client.on('error', closeBoth);
  upstream.on('error', closeBoth);
}

async function main() {
  await ensurePtyHost().catch((error) => console.error('pty-host unavailable:', error));
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

  // Per-room agent activity for the sidebar attention indicator. Aggregates every
  // terminal in a room: the room is as "busy" as its most-recent output and
  // surfaces the newest explicit/notification signal across its tiles.
  app.get('/api/activity', async (_req, res) => {
    try {
      const data = await ptyHostActivity();
      const rooms: Record<string, { lastOutputMs: number; attentionMs: number; agentState?: string; agentStateMs: number }> = {};
      for (const [key, session] of Object.entries(data.sessions)) {
        const roomId = roomIdFromKey(key);
        if (!roomId) continue;
        const current = rooms[roomId] ?? { lastOutputMs: 0, attentionMs: 0, agentState: undefined, agentStateMs: 0 };
        current.lastOutputMs = Math.max(current.lastOutputMs, session.lastOutputMs ?? 0);
        current.attentionMs = Math.max(current.attentionMs, session.attentionMs ?? 0);
        if ((session.agentStateMs ?? 0) > current.agentStateMs) {
          current.agentState = session.agentState;
          current.agentStateMs = session.agentStateMs ?? 0;
        }
        rooms[roomId] = current;
      }
      res.json({ now: data.now, rooms });
    } catch (error) {
      apiError(error, res);
    }
  });

  app.get('/api/projects', async (_req, res) => {
    const state = await getState();
    res.json({ projects: Object.values(state.projects), rooms: Object.values(state.rooms), processCounts: processCountsByRoom(state) });
  });

  // Per-room git signal for the sidebar (pull/push/conflict icons). Probed on its
  // own poll so a slow git call never holds up the project list. Sparse map: only
  // rooms with something to show appear (like processCounts). Never throws.
  app.get('/api/git/summary', async (_req, res) => {
    const state = await getState();
    const summary: Record<string, { behind: number; unpushed: number; conflict: boolean }> = {};
    await Promise.all(Object.values(state.rooms)
      .filter((room) => room.status === 'idle') // skip creating/errored/half-materialized rooms
      .map(async (room) => {
        try {
          const sig = await gitRoomSignal(room);
          if (sig && (sig.behind > 0 || sig.unpushed > 0 || sig.conflict)) summary[room.id] = sig;
        } catch { /* not a repo / wedged — no signal for this room */ }
      }));
    res.json({ summary });
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
      const status = await run('git', ['status', '--porcelain=v1', '-b'], room.path);
      if (status.exitCode !== 0) {
        // Git is wedged (not a repo, locked index, half-applied state, …). Degrade
        // gracefully so the panel keeps rendering and recovery stays reachable —
        // the poller must never 500 and take the whole git UI down with it.
        res.json({ status: EMPTY_GIT_STATUS, branches: [], head: '', gitError: (status.stderr || status.stdout || 'git status failed').trim() });
        return;
      }
      const head = await run('git', ['rev-parse', '--short', 'HEAD'], room.path).catch(() => ({ stdout: '' }));
      // Commits on HEAD not reachable from any origin ref = unpushed. Works even
      // when the branch has no tracking upstream (where status's ahead count is 0).
      const unpushed = await run('git', ['rev-list', '--count', 'HEAD', '--not', '--remotes=origin'], room.path).catch(() => ({ stdout: '' }));
      const unpushedCount = Number((unpushed?.stdout ?? '').trim()) || 0;
      // A conflicted `pull` leaves MERGE_HEAD behind: the merge is in progress and
      // must be resolved+committed (or aborted) before push/pull can proceed.
      const merging = (await run('git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], room.path)).exitCode === 0;
      const parsed = parseStatus(status.stdout);
      // Mark a file as still-conflicted only while conflict markers remain in it, so
      // "commit merge" lights up once the user has resolved them (even before staging).
      if (merging) {
        await Promise.all(parsed.files.filter((file) => file.unmerged).map(async (file) => {
          file.conflicted = await hasConflictMarkers(path.join(room.path, file.path));
        }));
      }
      const branches = await listBranches(room).catch(() => [] as string[]);
      res.json({ status: { ...parsed, unpushedCount, merging }, branches, head: head.stdout.trim() });
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

  app.get('/api/rooms/:roomId/git/log', async (req, res) => {
    try {
      const state = await getState();
      const room = getRoom(state, req.params.roomId);
      const limit = Math.min(Math.max(Number(req.query.limit) || 80, 1), 500);
      const fmt = ['%H', '%h', '%an', '%ae', '%aI', '%s'].join('%x1f');
      const out = await runGit(room, ['log', '-n', String(limit), '--no-color', `--pretty=format:${fmt}`]).catch(() => null);
      const unpushedOut = await runGit(room, ['rev-list', 'HEAD', '--not', '--remotes=origin']).catch(() => null);
      const unpushedSet = new Set((unpushedOut?.stdout ?? '').split('\n').filter(Boolean));
      const commits = (out?.stdout ?? '').split('\n').filter(Boolean).map((line) => {
        const [hash, short, author, email, date, subject] = line.split('\x1f');
        return { hash, short, author, email, date, subject, unpushed: unpushedSet.has(hash) };
      });
      res.json({ commits });
    } catch (error) {
      apiError(error, res);
    }
  });

  app.get('/api/rooms/:roomId/git/commit', async (req, res) => {
    try {
      const state = await getState();
      const room = getRoom(state, req.params.roomId);
      const hash = requireString(req.query.hash, 'hash');
      if (!/^[0-9a-fA-F]{4,40}$/.test(hash)) throw new HttpError(400, 'invalid commit hash');
      const fmt = ['%H', '%h', '%an', '%ae', '%aI', '%s', '%b'].join('%x1f');
      const meta = await runGit(room, ['show', '-s', '--no-color', `--pretty=format:${fmt}`, hash]);
      const [cHash, short, author, email, date, subject, ...bodyParts] = meta.stdout.split('\x1f');
      const namestat = await runGit(room, ['show', '--no-color', '--name-status', '--pretty=format:', hash]);
      const files = namestat.stdout.split('\n').filter(Boolean).map((line) => {
        const parts = line.split('\t');
        return { status: parts[0], path: parts[parts.length - 1] };
      });
      res.json({ hash: cHash, short, author, email, date, subject, body: bodyParts.join('\x1f').trimEnd(), files });
    } catch (error) {
      apiError(error, res);
    }
  });

  app.get('/api/rooms/:roomId/git/commit-diff', async (req, res) => {
    try {
      const state = await getState();
      const room = getRoom(state, req.params.roomId);
      const hash = requireString(req.query.hash, 'hash');
      if (!/^[0-9a-fA-F]{4,40}$/.test(hash)) throw new HttpError(400, 'invalid commit hash');
      const file = requireString(req.query.path, 'path');
      await assertPathInside(room.path, path.join(room.path, file));
      const out = await run('git', ['show', '--no-color', '--pretty=format:', hash, '--', file], room.path);
      res.json({ diff: out.stdout });
    } catch (error) {
      apiError(error, res);
    }
  });

  app.post('/api/rooms/:roomId/git/:op', async (req, res) => {
    try {
      const state = await getState();
      const room = getRoom(state, req.params.roomId);
      const op = req.params.op;
      // Before anything that talks to the remote, make sure a clone room points at the
      // real upstream rather than the local repo it was cloned from (fixes old rooms too).
      if (op === 'fetch' || op === 'pull' || op === 'push') await ensureCloneRemote(room);
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
        // Fast-forwards when possible; otherwise merges (GitHub Desktop's default
        // for a diverged branch). --no-edit keeps the merge non-interactive.
        result = await runGit(room, ['pull', '--no-rebase', '--no-edit'], { timeoutMs: 5 * 60_000 });
      } else if (op === 'push') {
        const branch = await currentBranch(room);
        result = await runGit(room, ['push', '-u', 'origin', branch], { timeoutMs: 5 * 60_000 });
      } else if (op === 'checkout') {
        const branch = requireString(req.body?.branch, 'branch');
        result = await runGit(room, ['checkout', branch]);
      } else if (op === 'checkout-new') {
        const branch = requireString(req.body?.branch, 'branch');
        result = await runGit(room, ['checkout', '-b', branch]);
      } else if (op === 'merge') {
        // Merge another branch into the current one. A clean/ff merge succeeds here;
        // a conflicting merge exits non-zero and leaves MERGE_HEAD, which the status
        // endpoint surfaces as `merging` so the same conflict UI (resolve → commit
        // merge / abort) drives it — no separate code path needed for merge vs pull.
        const branch = requireString(req.body?.branch, 'branch');
        const ref = await resolveMergeRef(room, branch);
        result = await runGit(room, ['merge', '--no-edit', ref], { timeoutMs: 5 * 60_000 });
      } else if (op === 'commit') {
        const message = requireString(req.body?.message, 'message');
        const rawPaths = Array.isArray(req.body?.paths) ? (req.body.paths as unknown[]) : [];
        const paths = rawPaths.filter((p): p is string => typeof p === 'string' && p.length > 0);
        if (paths.length) {
          // Commit exactly the checked files (GitHub Desktop style): clear the
          // index, stage only the selected paths, then commit.
          for (const p of paths) await assertPathInside(room.path, path.join(room.path, p));
          await runGit(room, ['reset', '-q']);
          await runGit(room, ['add', '--', ...paths]);
        }
        result = await runGit(room, ['commit', '-m', message]);
      } else if (op === 'discard') {
        // Throw away uncommitted changes to one path (destructive; client confirms).
        const file = requireString(req.body?.path, 'path');
        await assertPathInside(room.path, path.join(room.path, file));
        const tracked = (await run('git', ['cat-file', '-e', `HEAD:${file}`], room.path)).exitCode === 0;
        if (tracked) {
          // Modified/staged/deleted -> restore index + worktree to the committed version.
          result = await runGit(room, ['checkout', 'HEAD', '--', file]);
        } else {
          // New file (staged or untracked) -> unstage if needed, then remove it.
          await run('git', ['rm', '-f', '--ignore-unmatch', '--', file], room.path);
          result = await runGit(room, ['clean', '-fd', '--', file]);
        }
      } else if (op === 'discard-all') {
        // Revert all tracked changes and remove every untracked file (destructive).
        await run('git', ['reset', '--hard', 'HEAD'], room.path); // best-effort: errors only in a commit-less repo
        result = await runGit(room, ['clean', '-fd']);
      } else if (op === 'merge-abort') {
        // Throw away the in-progress merge, returning to the pre-pull state.
        result = await runGit(room, ['merge', '--abort']);
      } else if (op === 'merge-continue') {
        // Conclude a conflicted merge: refuse while any file still has conflict
        // markers (resolved-but-unstaged is fine), then stage the resolved tracked
        // files and commit with the prepared merge message.
        if ((await run('git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], room.path)).exitCode !== 0) throw new HttpError(409, 'no merge in progress');
        const unmerged = (await run('git', ['diff', '--name-only', '--diff-filter=U'], room.path)).stdout.split('\n').filter(Boolean);
        const unresolved: string[] = [];
        for (const file of unmerged) if (await hasConflictMarkers(path.join(room.path, file))) unresolved.push(file);
        if (unresolved.length) throw new HttpError(409, `unresolved conflict markers in: ${unresolved.join(', ')}`);
        await runGit(room, ['add', '-u']);
        result = await runGit(room, ['commit', '--no-edit']);
      } else {
        throw new HttpError(404, `unknown git operation: ${op}`);
      }
      res.json({ ok: true, stdout: result.stdout, stderr: result.stderr });
    } catch (error) {
      // Every op here is a git command; a non-zero exit (conflict, rejected push, dirty
      // tree, nothing to commit, …) is a user-facing outcome, not a server fault. Report
      // it as 409 so the client treats it as a handled result and the panel stays alive.
      if (error instanceof HttpError && error.status === 500) apiError(new HttpError(409, error.message), res);
      else apiError(error, res);
    }
  });

  app.get('/api/rooms/:roomId/processes', async (req, res) => {
    const state = await getState();
    const records = Object.values(state.processes).filter((proc) => proc.roomId === req.params.roomId);
    const running = await ptyHostRunningKeys();
    const out = await Promise.all(records.map(async (record) => {
      const live = await ptyHostSession(`proc:${record.id}`);
      let status: ProcessStatus = record.status;
      let exitCode = record.exitCode;
      let logTail = record.logTail ?? '';
      if (live) {
        status = live.status;
        exitCode = live.exitCode ?? exitCode;
        if (live.logTail) logTail = live.logTail;
        if (live.status === 'exited' && record.status === 'running') {
          record.status = 'exited';
          record.exitCode = exitCode;
          record.exitedAt = record.exitedAt ?? now();
          record.logTail = logTail.slice(-4000);
          await saveProcessRecord(record);
        }
      } else if (record.status === 'running' && !running.has(`proc:${record.id}`)) {
        status = 'lost';
      }
      return { id: record.id, roomId: record.roomId, name: record.name, command: record.command, status, startedAt: record.startedAt, exitedAt: record.exitedAt, exitCode, logTail };
    }));
    res.json({ processes: out });
  });

  app.post('/api/rooms/:roomId/terminal', async (req, res) => {
    try {
      const state = await getState();
      const room = getRoom(state, req.params.roomId);
      await ensureRoomTerminal(room);
      res.json({ ok: true });
    } catch (error) {
      apiError(error, res);
    }
  });

  // Add a tiled terminal to a room.
  app.post('/api/rooms/:roomId/terminals', async (req, res) => {
    try {
      const state = await getState();
      const room = getRoom(state, req.params.roomId);
      const terminals = roomTerminalIds(room);
      if (terminals.length >= MAX_ROOM_TERMINALS) {
        throw new HttpError(409, `a room can have at most ${MAX_ROOM_TERMINALS} terminals`);
      }
      let id = `t${Math.random().toString(36).slice(2, 7)}`;
      while (terminals.includes(id) || id === 'main') id = `t${Math.random().toString(36).slice(2, 7)}`;
      room.terminals = [...terminals, id];
      room.updatedAt = now();
      await saveState(state);
      await ensureRoomTerminal(room, id);
      res.json({ id, terminals: room.terminals });
    } catch (error) {
      apiError(error, res);
    }
  });

  // Ensure a specific room terminal exists (the client calls this before opening
  // a pane's socket — in dev the WS goes straight to the host, bypassing the daemon).
  app.post('/api/rooms/:roomId/terminals/:terminalId', async (req, res) => {
    try {
      const state = await getState();
      const room = getRoom(state, req.params.roomId);
      await ensureRoomTerminal(room, req.params.terminalId);
      res.json({ ok: true });
    } catch (error) {
      apiError(error, res);
    }
  });

  app.delete('/api/rooms/:roomId/terminals/:terminalId', async (req, res) => {
    try {
      const state = await getState();
      const room = getRoom(state, req.params.roomId);
      const terminalId = req.params.terminalId;
      if (terminalId === 'main') throw new HttpError(400, 'the main terminal cannot be closed');
      await killRoomTerminal(room.id, terminalId);
      room.terminals = roomTerminalIds(room).filter((id) => id !== terminalId);
      room.updatedAt = now();
      await saveState(state);
      res.json({ ok: true, terminals: room.terminals });
    } catch (error) {
      apiError(error, res);
    }
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
    const id = req.params.processId;
    await ptyHostKill(`proc:${id}`);
    processes.delete(id);
    const state = await getState();
    const record = state.processes[id];
    if (!record) return res.status(404).json({ error: 'unknown process' });
    if (record.status === 'running') {
      record.status = 'exited';
      record.exitedAt = record.exitedAt ?? now();
      await saveProcessRecord(record);
      return res.json({ ok: true });
    }
    await removeProcessRecord(id);
    res.json({ ok: true, removed: true });
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
      const roomTerminalN = url.pathname.match(/^\/ws\/rooms\/([^/]+)\/terminals\/([^/]+)$/);
      const processTerminal = url.pathname.match(/^\/ws\/processes\/([^/]+)$/);

      if (!roomTerminal && !roomTerminalN && !processTerminal) {
        socket.destroy();
        return;
      }

      // Resolve and ensure the host session BEFORE completing the WebSocket
      // handshake. proxyTerminalSocket attaches its input listener synchronously
      // once the handshake finishes; if we awaited the spawn *after* the
      // handshake, the client would open and could send keystrokes into that gap
      // before the listener exists — and lose them.
      let upstreamPath: string;
      try {
        if (roomTerminal) {
          const state = await getState();
          const room = getRoom(state, roomTerminal[1]);
          await ensureRoomTerminal(room);
          upstreamPath = `/ws/rooms/${room.id}/terminal`;
        } else if (roomTerminalN) {
          const state = await getState();
          const room = getRoom(state, roomTerminalN[1]);
          await ensureRoomTerminal(room, roomTerminalN[2]);
          upstreamPath = `/ws/rooms/${room.id}/terminals/${roomTerminalN[2]}`;
        } else {
          await ensurePtyHost();
          upstreamPath = `/ws/processes/${processTerminal![1]}`;
        }
      } catch (error) {
        // Finish the handshake only to surface the error to the client, then close.
        wss.handleUpgrade(req, socket, head, (ws) => {
          try { ws.send(JSON.stringify({ type: 'output', data: `\r\n[devrooms: ${String(error)}]\r\n` })); } catch { /* noop */ }
          ws.close();
        });
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        proxyTerminalSocket(ws, `ws://127.0.0.1:${PTY_HOST_PORT}${upstreamPath}${url.search}`);
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
