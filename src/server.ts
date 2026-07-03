import express from 'express';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';

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

// In-memory authoritative state. The daemon is the SOLE writer of STATE_PATH (single
// process — no cluster/fork; the pty-host never touches it; every renderer window talks
// to this one daemon), so we read + normalize + reconcile lost PTYs + ensure the launch
// project ONCE at startup and keep the parsed object in memory. getState() then returns
// that object directly — no disk read, no JSON.parse, no per-request pty-host round-trip
// and no git spawns, all of which the four client pollers used to pay on every tick.
// saveState() keeps the cache authoritative after each mutation (and, because all callers
// now share one object, a concurrent read-modify-write can no longer last-writer clobber
// a divergent disk copy).
let cachedState: State | null = null;

async function loadStateFromDisk(): Promise<State> {
  await fs.mkdir(DEVROOMS_HOME, { recursive: true });
  await fs.mkdir(ROOMS_ROOT, { recursive: true });
  let state: State;
  try {
    const raw = await fs.readFile(STATE_PATH, 'utf8');
    state = normalizeState(JSON.parse(raw));
  } catch {
    // ONLY a missing or genuinely unparseable file lands here. A present-but-unparseable file
    // would otherwise be silently overwritten with empty state (wiping every project/room), so
    // preserve it for recovery before starting fresh. (A missing file just no-ops the rename.)
    await fs.rename(STATE_PATH, `${STATE_PATH}.corrupt-${Date.now()}`).catch(() => undefined);
    state = emptyState();
  }
  // recoverLostProcesses (a pty-host probe) and ensureLaunchProject (two git spawns) run here
  // exactly once at boot, not per request — and OUTSIDE the try, so a transient/misconfigured
  // launch path (DEVROOMS_PROJECT_PATH not yet a repo) propagates as a clean startup error
  // without renaming away a perfectly valid state file. ensureLaunchProject persists via its
  // own saveState; /api/rooms/:id/processes still reconciles exited/lost live on every fetch.
  return ensureLaunchProject(await recoverLostProcesses(state));
}

async function ensureState(): Promise<State> {
  if (!cachedState) cachedState = await loadStateFromDisk();
  return cachedState;
}

async function saveState(state: State) {
  cachedState = state; // keep the in-memory copy authoritative after every mutation
  await fs.mkdir(DEVROOMS_HOME, { recursive: true });
  // Unique tmp name so two concurrent writers never share (and corrupt) one tmp file —
  // a half-written tmp surviving the rename could poison the next parse. Best-effort cleanup.
  const tmp = `${STATE_PATH}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await fs.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`);
    await fs.rename(tmp, STATE_PATH);
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
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
      // GIT_OPTIONAL_LOCKS=0 stops read-only git commands from taking .git/index.lock
      // to refresh the index as a side effect. The daemon polls `git status` (summary,
      // the changes panel, label derivation) every few seconds; without this, a poll can
      // hold the lock exactly when a user merge/commit/checkout tries to write the index,
      // which fails with "unable to write index". Operations that *require* the lock
      // (merge/commit/add themselves) still take it — only the optional refresh is skipped.
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
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
    terminals: existing?.terminals, // a branch switch must not drop the user's tiled terminals
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

// Git C-quotes status paths that contain quotes, backslashes, control characters or —
// under the default core.quotepath — any non-ASCII byte: `"src/caf\303\251.ts"`. The
// octal escapes are raw bytes of the UTF-8 encoding, so decode escapes to bytes first
// and the whole byte run to a string second; otherwise every path-addressed op (stage,
// discard, diff, conflict-marker stat) misses the real file.
function unquoteGitPath(entry: string): string {
  if (!entry.startsWith('"') || !entry.endsWith('"') || entry.length < 2) return entry;
  const inner = entry.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] !== '\\') { bytes.push(...Buffer.from(inner[i], 'utf8')); continue; }
    const next = inner[++i];
    if (next >= '0' && next <= '7') {
      bytes.push(parseInt(inner.slice(i, i + 3), 8));
      i += 2;
    } else {
      const control: Record<string, string> = { a: '\x07', b: '\b', t: '\t', n: '\n', v: '\v', f: '\f', r: '\r' };
      bytes.push(...Buffer.from(control[next] ?? next ?? '', 'utf8'));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

// A rename/copy status entry reads `orig -> new` (either side may be quoted); split it.
// When orig is quoted, scan past its escapes to the closing quote so a literal " -> "
// inside the old name can't split the entry early. An unquoted orig containing " -> "
// is ambiguous in porcelain v1 itself — first match is the best available reading.
function splitRenameEntry(entry: string): { orig?: string; target: string } {
  if (entry.startsWith('"')) {
    for (let i = 1; i < entry.length; i++) {
      if (entry[i] === '\\') { i++; continue; }
      if (entry[i] === '"') {
        return entry.slice(i + 1).startsWith(' -> ')
          ? { orig: entry.slice(0, i + 1), target: entry.slice(i + 5) }
          : { target: entry };
      }
    }
    return { target: entry };
  }
  const sep = entry.indexOf(' -> ');
  return sep >= 0 ? { orig: entry.slice(0, sep), target: entry.slice(sep + 4) } : { target: entry };
}

function renameTargetPath(entry: string): string {
  return splitRenameEntry(entry).target;
}

// Rename entries surface to the client as their TARGET path only, but git-op pathspecs
// must also cover the rename SOURCE (the staged deletion) — otherwise commit/stage/
// unstage handle half the rename (committing a duplicate file) and discard treats the
// target as untracked and deletes it. Resolves targets → sources from a fresh porcelain
// read; callers must resolve BEFORE any `git reset`, which dissolves rename entries.
async function renameSources(room: Room, files: string[]): Promise<Map<string, string>> {
  const wanted = new Set(files);
  const sources = new Map<string, string>();
  const status = await run('git', ['status', '--porcelain=v1'], room.path, { timeoutMs: 5000 });
  if (status.exitCode !== 0) return sources;
  for (const line of status.stdout.split('\n')) {
    if (!line) continue;
    const { orig, target } = splitRenameEntry(line.slice(3));
    if (orig !== undefined && wanted.has(unquoteGitPath(target))) sources.set(unquoteGitPath(target), unquoteGitPath(orig));
  }
  return sources;
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
        path: unquoteGitPath(renameTargetPath(line.slice(3))),
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

// Fingerprinting the ref state lets the 4s status poller skip the `for-each-ref` spawn
// when branches are unchanged (the common case). Loose refs are walked recursively with
// per-file mtimes: the recursive NAMES catch nested branch create/delete (a slash-y
// branch at refs/heads/<a>/<b> only bumps its immediate parent dir's mtime), and the
// per-file MTIMES catch commits, which rewrite the loose ref in place — a commit must
// refresh the picker's ages/ordering within one poll. Packed refs (git pack-refs,
// clones) are covered by the packed-refs file mtime; FETCH_HEAD (rewritten on every
// fetch) is a cheap belt-and-suspenders. The stats are one per loose ref — trivial
// beside the for-each-ref spawn they save.
const branchCache = new Map<string, { fp: string; data: { name: string; committedAt: number }[] }>();

async function branchFingerprint(room: Room): Promise<string> {
  const g = path.join(room.path, '.git');
  const stats = [path.join(g, 'HEAD'), path.join(g, 'packed-refs'), path.join(g, 'FETCH_HEAD')].map(async (p) => {
    try { return String((await fs.stat(p)).mtimeMs); } catch { return '-'; }
  });
  const looseRefs = [path.join(g, 'refs', 'heads'), path.join(g, 'refs', 'remotes', 'origin')].map(async (dir) => {
    try {
      const names = (await fs.readdir(dir, { recursive: true })).sort();
      const parts = await Promise.all(names.map(async (name) => {
        try { return `${name}:${(await fs.stat(path.join(dir, String(name)))).mtimeMs}`; } catch { return String(name); }
      }));
      return parts.join(',');
    } catch { return '-'; }
  });
  return (await Promise.all([...stats, ...looseRefs])).join('|');
}

async function listBranches(room: Room): Promise<{ name: string; committedAt: number }[]> {
  // One entry per branch with its last-commit time (unix), most-recent first, so the
  // picker floats active branches to the top and sinks abandoned ones. Includes
  // remote-tracking origin/* (a fresh clone has only those; checking one out makes
  // git auto-create a local tracking branch — DWIM) collapsed to short names. Skip
  // origin/HEAD and other remotes (checking those out would detach HEAD).
  const fp = await branchFingerprint(room);
  const hit = branchCache.get(room.path);
  if (hit && hit.fp === fp) return hit.data;
  const result = await runGit(room, ['for-each-ref', '--format=%(committerdate:unix)%09%(refname)', 'refs/heads/', 'refs/remotes/origin/']);
  const byName = new Map<string, number>();
  for (const line of result.stdout.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const when = Number(line.slice(0, tab)) || 0;
    const ref = line.slice(tab + 1).trim();
    if (ref.endsWith('/HEAD')) continue;
    let name: string;
    if (ref.startsWith('refs/heads/')) name = ref.slice('refs/heads/'.length);
    else if (ref.startsWith('refs/remotes/origin/')) name = ref.slice('refs/remotes/origin/'.length);
    else continue;
    // Local and remote of the same name collapse to one row; keep the newer date.
    const prev = byName.get(name);
    if (prev === undefined || when > prev) byName.set(name, when);
  }
  const data = [...byName].map(([name, committedAt]) => ({ name, committedAt })).sort((a, b) => b.committedAt - a.committedAt);
  branchCache.set(room.path, { fp, data });
  return data;
}

async function currentBranch(room: Room) {
  const result = await runGit(room, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return result.stdout.trim();
}

// Fast branch read for the projects poller (per idle room, every ~5s). HEAD is exactly
// the file `git switch`/`checkout` rewrites, so a plain read reflects the live branch with
// no process spawn. Falls back to the git spawn for anything non-standard: `.git` is a FILE
// (linked worktree/submodule with HEAD elsewhere) → readFile ENOTDIRs → catch → spawn; a
// detached HEAD holds a sha → returns 'HEAD', identical to `git rev-parse --abbrev-ref HEAD`.
async function currentBranchFast(room: Room): Promise<string> {
  let raw: string;
  try {
    raw = (await fs.readFile(path.join(room.path, '.git', 'HEAD'), 'utf8')).trim();
  } catch {
    return currentBranch(room);
  }
  if (raw.startsWith('ref: refs/heads/')) return raw.slice('ref: refs/heads/'.length);
  return 'HEAD'; // detached HEAD — matches `git rev-parse --abbrev-ref HEAD`
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

// Next free "room-N" handle for a project, for rooms created without a name.
function nextRoomHandle(state: State, projectId: string): string {
  for (let n = 1; ; n += 1) {
    const candidate = `room-${n}`;
    if (!state.rooms[slugify(`${projectId}-${candidate}`)]) return candidate;
  }
}

async function createRoom(projectId: string, body: unknown) {
  const input = body as Record<string, unknown>;
  const state = await getState();
  const project = getProject(state, projectId);
  const explicitBranch = typeof input.branch === 'string' && input.branch.trim() ? input.branch.trim() : undefined;
  // No branch given: default to the SOURCE repo's CURRENT branch (its checked-out
  // HEAD), so a clone tracks whatever you're working on with zero typing. Only when
  // cloning the local working copy itself (repoUrl === rootPath), where that branch is
  // guaranteed to exist; a separately-configured remote might lack an unpushed local
  // branch, so there we leave it blank and clone the repo default (origin/HEAD).
  const branch = explicitBranch
    ?? (project.rootPath && project.repoUrl === project.rootPath ? await branchForPath(project.rootPath) : undefined);
  // Name is optional: fall back to the EXPLICIT branch (the user's task identity), then
  // an auto "room-N". The DEFAULTED current branch is intentionally not used as a name —
  // it would collide with the main room (e.g. "main") and isn't a chosen task label.
  const rawName = typeof input.name === 'string' ? input.name.trim() : '';
  let name = rawName || explicitBranch || nextRoomHandle(state, project.id);
  // A name whose own slug is empty (all emoji / non-Latin) or dot-only ("." / "..",
  // which slugify keeps) can still yield a non-empty room id (the project prefix
  // survives), but roomPath below joins slugify(name) — and such a leaf collapses the
  // path onto the project's rooms dir or its PARENT, which a later delete-with-files
  // would wipe wholesale. Regenerate the whole name so id, name and path stay consistent.
  if (!slugify(name).replace(/^\.+$/, '')) name = nextRoomHandle(state, project.id);
  let id = slugify(`${project.id}-${name}`);
  if (!id) throw new HttpError(400, 'room id is empty after slugification');
  // A non-typed name that collided (cloning the current branch when a same-named room
  // already exists, e.g. "main") shouldn't 409 — fall back to a fresh room-N handle. A
  // user-typed name still conflicts loudly so they can pick another.
  if (state.rooms[id] && !rawName) {
    name = nextRoomHandle(state, project.id);
    id = slugify(`${project.id}-${name}`);
  }
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
    // Branch to clone: the one the user picked, else the source's current branch (set
    // above), else the repo default (origin/HEAD) when neither is known. materializeRoom
    // checks it out with --branch — a mistyped/missing branch surfaces as a clone error.
    // The actually checked-out branch is recorded after the clone.
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

// .env files are gitignored, so a fresh clone never has them — which breaks apps
// that need them. Find every .env / .env.* in the source working tree (skipping
// dependency/build dirs) so they can be carried into the clone.
const ENV_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'out', '.turbo', 'coverage', '.venv']);
async function findEnvFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string, rel: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => null);
    if (!entries) return;
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (ENV_SKIP_DIRS.has(entry.name)) continue;
        await walk(path.join(dir, entry.name), rel ? `${rel}/${entry.name}` : entry.name);
      } else if (entry.isFile() && (entry.name === '.env' || entry.name.startsWith('.env.'))) {
        found.push(rel ? `${rel}/${entry.name}` : entry.name);
      }
    }
  }
  await walk(root, '');
  return found;
}

// Copy the source's .env files into a freshly-cloned room, preserving relative
// paths. Skips any that already exist in the clone (e.g. committed .env.example),
// so it only fills in the gitignored ones the clone is missing. Best-effort.
async function copyEnvFiles(srcRoot: string, destRoot: string): Promise<number> {
  let copied = 0;
  for (const rel of await findEnvFiles(srcRoot)) {
    const dst = path.join(destRoot, rel);
    try { await fs.access(dst); continue; } catch { /* missing in the clone — copy it */ }
    try {
      await fs.mkdir(path.dirname(dst), { recursive: true });
      await fs.copyFile(path.join(srcRoot, rel), dst);
      copied += 1;
    } catch (error) { console.error(`devrooms: .env copy failed for ${rel}:`, error); }
  }
  return copied;
}

// Repo-local git config never survives `git clone` — the clone starts with a fresh
// .git/config. Git Town keeps its whole setup there (main branch, perennials, the
// git-town-branch.<name>.parent lineage), so without this a new room re-asks the
// `git town` setup questions. Carry every git-town key over verbatim, and nothing
// else — copying all local config would clobber the clone's own remote.origin.url.
// -z framing survives values with newlines; --add preserves multi-valued keys.
async function copyGitTownConfig(srcRoot: string, destRoot: string): Promise<number> {
  const listed = await run('git', ['config', '--local', '-z', '--get-regexp', '^git-town'], srcRoot);
  if (listed.exitCode !== 0) return 0; // exit 1: no git-town keys — nothing to carry
  let copied = 0;
  for (const entry of listed.stdout.split('\0')) {
    if (!entry) continue;
    const nl = entry.indexOf('\n');
    const key = nl >= 0 ? entry.slice(0, nl) : entry;
    const value = nl >= 0 ? entry.slice(nl + 1) : '';
    const set = await run('git', ['config', '--local', '--add', key, value], destRoot);
    if (set.exitCode === 0) copied += 1;
    else console.error(`devrooms: git-town config carry failed for ${key}:`, set.stderr.trim());
  }
  return copied;
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
    const checkedOut = (await currentBranch(room).catch(() => undefined)) || room.branch;
    room.branch = checkedOut;
    // Cloning a *local* folder checks out THAT working copy's branch, which can carry
    // local-only commits the source never pushed. A new room should be the branch as it
    // is on the remote, so hard-reset it to origin/<branch> (safe — the clone has no
    // work yet). Only when the branch exists on origin: a purely local branch (or a
    // detached tag checkout) has no remote counterpart to match, so leave it alone.
    if (checkedOut && checkedOut !== 'HEAD') {
      const onOrigin = await run('git', ['rev-parse', '--verify', '--quiet', `origin/${checkedOut}`], room.path).catch(() => null);
      if (onOrigin?.exitCode === 0) {
        await run('git', ['reset', '--hard', `origin/${checkedOut}`], room.path)
          .catch((error) => console.error(`devrooms: reset ${checkedOut} to origin failed`, error));
      }
    }
    // Carry over the source repo's gitignored .env files (the clone won't have them)
    // and its repo-local git-town config (git clone starts a fresh .git/config).
    if (project.rootPath) {
      const copied = await copyEnvFiles(project.rootPath, room.path).catch((error) => { console.error('devrooms: .env copy failed', error); return 0; });
      if (copied) console.log(`devrooms: copied ${copied} .env file(s) into ${room.path}`);
      const townKeys = await copyGitTownConfig(project.rootPath, room.path).catch((error) => { console.error('devrooms: git-town config carry failed', error); return 0; });
      if (townKeys) console.log(`devrooms: carried ${townKeys} git-town config key(s) into ${room.path}`);
    }
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
  // Liveness lives in the pty-host, and identity in the PERSISTED records — the
  // in-memory map is empty after a daemon restart, so trusting it here would skip
  // the guard and orphan still-running PTYs in the host. Reconcile records × host.
  const hostRunning = await ptyHostRunningKeys();
  const running = Object.values(state.processes).filter((record) => record.roomId === roomId && hostRunning.has(`proc:${record.id}`));
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
  // Drop every per-room cache entry so nothing leaks — and so a recreated room with
  // the same id/path (deterministic slugs) starts fresh instead of inheriting stale
  // branch lists or a hooks-already-installed marker pointing at deleted files.
  gitSnapshotCache.delete(roomId);
  roomLabelCache.delete(roomId);
  defaultBranchCache.delete(roomId);
  branchCache.delete(room.path);
  agentHooksInstalled.delete(roomId);
  await saveState(state);
  if (deleteFiles) {
    await assertPathInside(ROOMS_ROOT, room.path);
    // A just-SIGTERMed clone (and its index-pack children) can still be writing under
    // room.path; wait for it (bounded) and let rm retry, so a file appearing mid-removal
    // can't fail the delete after state was already updated.
    if (cloneJob && cloneJob.exitCode === null && cloneJob.signalCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 5000);
        timer.unref();
        cloneJob.once('close', () => { clearTimeout(timer); resolve(); });
      });
    }
    await fs.rm(room.path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  return { room, deleteFiles, killed: running.length };
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

async function killRoomTerminal(roomId: string, terminalId = 'main', force = true) {
  return ptyHostKill(roomTerminalKey(roomId, terminalId), force);
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
  // The daemon's own PORT must not leak either: generic dev servers (next, express)
  // honor $PORT, so an agent's `next dev` in a room would try to bind the daemon's
  // port, collide, and "fix" it by killing whatever listens there — i.e. the daemon.
  delete env.PORT;
  delete env.DEVROOMS_PORT;
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
  };
  processes.set(id, managed);
  await saveProcessRecord(recordFromProcess(managed));
  return managed;
}

function processSummary(proc: ManagedProcess) {
  return {
    id: proc.id,
    roomId: proc.roomId,
    name: proc.name,
    command: proc.command,
    status: proc.status,
    startedAt: proc.startedAt,
    exitedAt: proc.exitedAt,
    exitCode: proc.exitCode,
    logTail: '', // the live tail streams from the pty-host; a just-spawned process has none
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

// --- Derived room labels ----------------------------------------------------
// A room's typed name goes stale the moment its task finishes, so for display we
// derive an activity label from cheap signals, task-first:
//   1. a descriptive (non-default) branch name — the user's own task label
//   2. the oldest non-merge commit unique to the branch (skips merge noise)
//   3. a dirty-tree stat — what the room is touching right now
// Falling through to undefined lets the client show the stable name handle. The
// git-backed steps are cached briefly so the projects poll stays cheap.
const LABEL_TTL_MS = 8_000;
const roomLabelCache = new Map<string, { at: number; label: string | undefined }>();

function deslugBranch(branch: string) {
  const tail = branch.split('/').pop() ?? branch;       // drop feat/ , user/ … prefixes
  return tail.replace(/[_-]+/g, ' ').trim();
}

function cleanSubject(subject: string) {
  return subject.replace(/^(\w+)(\([^)]*\))?!?:\s*/, '').trim();   // strip conventional-commit prefix
}

function truncateLabel(value: string, max = 48) {
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
}

// The top-level directory shared by most changed paths, used to give a dirty-tree
// stat a sense of place ("editing 4 files · src"). Empty when the changes are
// scattered, so we never imply a focus that isn't there.
function commonTopDir(paths: string[]) {
  const counts = new Map<string, number>();
  for (const candidate of paths) {
    const slash = candidate.indexOf('/');
    if (slash > 0) counts.set(candidate.slice(0, slash), (counts.get(candidate.slice(0, slash)) ?? 0) + 1);
  }
  let dir = '';
  let best = 0;
  for (const [name, n] of counts) if (n > best) { dir = name; best = n; }
  return best >= Math.ceil(paths.length / 2) ? dir : '';
}

async function gitRoomLabel(room: Room, base?: string): Promise<string | undefined> {
  // The oldest commit unique to this branch names the task it was created for,
  // with merges excluded so a "Merge branch 'main'" subject can never win.
  if (base && room.branch && room.branch !== base) {
    const log = await run('git', ['log', '--no-merges', '--format=%s', `${base}..HEAD`], room.path, { timeoutMs: 5_000 }).catch(() => undefined);
    if (log?.exitCode === 0) {
      const subjects = log.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
      const oldest = subjects[subjects.length - 1];
      if (oldest) { const subject = cleanSubject(oldest); if (subject) return truncateLabel(subject); }
    }
  }
  // Otherwise describe what the room is actively touching.
  // -uall lists files inside new directories individually (porcelain otherwise
  // collapses an untracked dir to one entry), so the count reflects real files.
  const status = await run('git', ['status', '--porcelain', '-uall'], room.path, { timeoutMs: 5_000 }).catch(() => undefined);
  if (status?.exitCode === 0) {
    const files = status.stdout.split('\n')
      .map((line) => unquoteGitPath(renameTargetPath(line.slice(3))))
      .filter(Boolean);
    if (files.length) {
      const dir = commonTopDir(files);
      return `editing ${files.length} file${files.length === 1 ? '' : 's'}${dir ? ` · ${dir}` : ''}`;
    }
  }
  return undefined;
}

// The repo's default branch, read from origin/HEAD (set by git clone). It doesn't
// change during a session, so cache it long enough to keep the projects poll cheap.
const DEFAULT_BRANCH_TTL_MS = 60_000;
const defaultBranchCache = new Map<string, { at: number; branch: string | undefined }>();

async function roomBaseBranch(room: Room): Promise<string | undefined> {
  const cached = defaultBranchCache.get(room.id);
  if (cached && Date.now() - cached.at < DEFAULT_BRANCH_TTL_MS) return cached.branch;
  const result = await run('git', ['rev-parse', '--abbrev-ref', 'origin/HEAD'], room.path, { timeoutMs: 5_000 }).catch(() => undefined);
  const ref = result?.exitCode === 0 ? result.stdout.trim() : '';
  const branch = ref && ref !== 'origin/HEAD' ? ref.replace(/^origin\//, '') : undefined;
  defaultBranchCache.set(room.id, { at: Date.now(), branch });
  return branch;
}

async function deriveRoomLabel(room: Room): Promise<string | undefined> {
  // The main room is the repo itself — its name ("main") is already its identity.
  if (room.kind === 'main') return undefined;
  const base = await roomBaseBranch(room);
  // A branch that isn't the repo default is the user's own task label. Fall back to
  // the usual default names if origin/HEAD couldn't be read.
  const onDefault = base ? room.branch === base : room.branch === 'main' || room.branch === 'master';
  if (room.branch && !onDefault) {
    const label = deslugBranch(room.branch);
    if (label) return label;
  }
  // Only spend git reads on settled rooms, and only as often as the TTL.
  if (room.status !== 'idle') return undefined;
  const cached = roomLabelCache.get(room.id);
  if (cached && Date.now() - cached.at < LABEL_TTL_MS) return cached.label;
  const label = await gitRoomLabel(room, base);
  roomLabelCache.set(room.id, { at: Date.now(), label });
  return label;
}

// Rooms as sent to the client: the stored record, but with the LIVE git branch plus a
// derived activity label. The stored room.branch only gets written at clone time, so it
// drifts the moment the branch changes any other way — a `git switch` in the terminal,
// or a clone that lands on a different default than was asked for. A stale branch in the
// UI is dangerous (it misled a push to the wrong branch once), so always report what git
// actually has checked out, and derive the label from that too.
async function roomViews(rooms: Room[]) {
  return Promise.all(rooms.map(async (room) => {
    const live = room.status === 'idle' ? await currentBranchFast(room).catch(() => undefined) : undefined;
    const view = live && live !== room.branch ? { ...room, branch: live } : room;
    const label = await deriveRoomLabel(view).catch(() => undefined);
    return label ? { ...view, label } : view;
  }));
}

// The `git status -b` + unpushed `rev-list` pair is read by THREE overlapping pollers
// for the same rooms within the same few seconds (the sidebar summary every 5s for every
// idle room, and the focused room's status every 4s). Coalesce them behind a tiny TTL +
// in-flight promise so beating timers share one pair of git spawns instead of duplicating
// them. TTL is well under the poll intervals, so counts are at most ~1.5s staler than the
// already-4–5s poll — invisible — and a mutating git op busts the room's entry immediately.
const GIT_SNAPSHOT_TTL_MS = 1500;
const gitSnapshotCache = new Map<string, { at: number; settled: boolean; promise: Promise<{ status: RunResult; unpushed: number }> }>();

function gitSnapshot(room: Room): Promise<{ status: RunResult; unpushed: number }> {
  const hit = gitSnapshotCache.get(room.id);
  // An unsettled entry is always shared — a slow spawn outliving the TTL must not
  // let the next poller pile a duplicate git pair on top of the wedged one.
  if (hit && (!hit.settled || Date.now() - hit.at < GIT_SNAPSHOT_TTL_MS)) return hit.promise;
  const promise = (async () => {
    const status = await run('git', ['status', '--porcelain=v1', '-b'], room.path, { timeoutMs: 5000 });
    let unpushed = 0;
    if (status.exitCode === 0) {
      const rl = await run('git', ['rev-list', '--count', 'HEAD', '--not', '--remotes=origin'], room.path, { timeoutMs: 5000 })
        .catch(() => ({ exitCode: 0, stdout: '', stderr: '' } as RunResult));
      unpushed = Number((rl.stdout ?? '').trim()) || 0;
    }
    return { status, unpushed };
  })();
  const entry = { at: Date.now(), settled: false, promise };
  promise.then(
    () => { entry.settled = true; },
    () => {
      // A transient failure (timeout 504, wedged git) must not be pinned for the whole
      // TTL — but only evict our own entry, not one a mutating git op already replaced.
      if (gitSnapshotCache.get(room.id) === entry) gitSnapshotCache.delete(room.id);
    },
  );
  gitSnapshotCache.set(room.id, entry);
  return promise;
}

// Lightweight per-room git signal for the sidebar: commits to pull (behind, vs
// the last-fetched origin ref), commits to push (local commits no origin ref
// holds — correct even without an upstream), and whether a merge left unmerged
// paths. Shares the coalesced snapshot; any failure (not a repo, wedged, timeout)
// yields null so that room just shows no icons — the poller must never 500.
async function gitRoomSignal(room: Room): Promise<{ behind: number; unpushed: number; dirty: number; conflict: boolean } | null> {
  const snap = await gitSnapshot(room).catch(() => null);
  if (!snap || snap.status.exitCode !== 0) return null;
  const parsed = parseStatus(snap.status.stdout);
  // dirty = every uncommitted entry (modified, staged, untracked, unmerged) — "has
  // work in progress", the count the changes tab would show.
  return { behind: parsed.behind, unpushed: snap.unpushed, dirty: parsed.dirtyCount, conflict: parsed.files.some((file) => file.unmerged) };
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
    // -sTCP:LISTEN is load-bearing: a bare `lsof -ti tcp:<port>` also matches processes
    // holding CLIENT sockets to that port — including this daemon's own keep-alive
    // connections to the host — so without it the recovery path SIGKILLs the daemon
    // itself (and, in dev, Vite's proxied sockets) instead of the wedged listener.
    spawnSync('sh', ['-c', `lsof -ti tcp:${PTY_HOST_PORT} -sTCP:LISTEN | xargs kill -9`], { stdio: 'ignore', timeout: 3000 });
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

// Single-flight: concurrent callers (terminal opens racing WS upgrades at boot) share
// one health-check/spawn instead of double-spawning hosts that then fight over the port.
// Reset in finally on BOTH outcomes, so one failed ensure never poisons later spawns.
let ptyHostEnsuring: Promise<void> | null = null;
function ensurePtyHost(): Promise<void> {
  if (!ptyHostEnsuring) ptyHostEnsuring = doEnsurePtyHost().finally(() => { ptyHostEnsuring = null; });
  return ptyHostEnsuring;
}

async function doEnsurePtyHost() {
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

async function ptyHostKill(key: string, force = true): Promise<{ busy?: boolean; proc?: string }> {
  try {
    const res = await ptyHostFetch('/kill', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, force }) }, 2000);
    return (await res.json().catch(() => ({}))) as { busy?: boolean; proc?: string };
  } catch {
    return {}; // host may be down; nothing to kill
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
    res.json({ projects: Object.values(state.projects), rooms: await roomViews(Object.values(state.rooms)), processCounts: processCountsByRoom(state) });
  });

  // Per-room git signal for the sidebar (pull/push/conflict icons). Probed on its
  // own poll so a slow git call never holds up the project list. Sparse map: only
  // rooms with something to show appear (like processCounts). Never throws.
  app.get('/api/git/summary', async (_req, res) => {
    const state = await getState();
    const summary: Record<string, { behind: number; unpushed: number; dirty: number; conflict: boolean }> = {};
    await Promise.all(Object.values(state.rooms)
      .filter((room) => room.status === 'idle') // skip creating/errored/half-materialized rooms
      .map(async (room) => {
        try {
          const sig = await gitRoomSignal(room);
          if (sig && (sig.behind > 0 || sig.unpushed > 0 || sig.dirty > 0 || sig.conflict)) summary[room.id] = sig;
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
      res.json({ rooms: await roomViews(Object.values(state.rooms).filter((room) => room.projectId === req.params.projectId)) });
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
      // Shared with the sidebar summary poller (gitSnapshot): one `git status -b` +
      // unpushed rev-list pair serves both timers. A rejected snapshot (timeout/wedged)
      // degrades to the same graceful empty status as a non-zero exit.
      const snap = await gitSnapshot(room).catch(() => null);
      if (!snap || snap.status.exitCode !== 0) {
        // Git is wedged (not a repo, locked index, half-applied state, …). Degrade
        // gracefully so the panel keeps rendering and recovery stays reachable —
        // the poller must never 500 and take the whole git UI down with it.
        const s = snap?.status;
        res.json({ status: EMPTY_GIT_STATUS, branches: [], head: '', gitError: ((s?.stderr || s?.stdout) ?? 'git status failed').trim() });
        return;
      }
      const status = snap.status;
      const unpushedCount = snap.unpushed;
      const head = await run('git', ['rev-parse', '--short', 'HEAD'], room.path).catch(() => ({ stdout: '' }));
      // A conflicted `pull` leaves MERGE_HEAD behind: the merge is in progress and
      // must be resolved+committed (or aborted) before push/pull can proceed. In a normal
      // clone .git is a directory and MERGE_HEAD is a plain loose file whose mere existence
      // is exactly what `rev-parse --verify MERGE_HEAD` checks — so a stat avoids the per-tick
      // git spawn. Linked worktrees keep .git as a FILE (gitdir elsewhere), so fall back to
      // the spawn there; any stat error also falls back.
      let merging: boolean;
      try {
        const gitDir = path.join(room.path, '.git');
        merging = (await fs.stat(gitDir)).isDirectory()
          ? await fs.stat(path.join(gitDir, 'MERGE_HEAD')).then(() => true, () => false)
          : (await run('git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], room.path)).exitCode === 0;
      } catch {
        merging = (await run('git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], room.path)).exitCode === 0;
      }
      const parsed = parseStatus(status.stdout);
      // Mark a file as still-conflicted only while conflict markers remain in it, so
      // "commit merge" lights up once the user has resolved them (even before staging).
      if (merging) {
        await Promise.all(parsed.files.filter((file) => file.unmerged).map(async (file) => {
          file.conflicted = await hasConflictMarkers(path.join(room.path, file.path));
        }));
      }
      const branches = await listBranches(room).catch(() => [] as { name: string; committedAt: number }[]);
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
        const orig = (await renameSources(room, [file])).get(file);
        result = await runGit(room, ['add', '--', ...(orig ? [orig] : []), file]);
      } else if (op === 'unstage') {
        const file = requireString(req.body?.path, 'path');
        await assertPathInside(room.path, path.join(room.path, file));
        const orig = (await renameSources(room, [file])).get(file);
        result = await runGit(room, ['restore', '--staged', '--', ...(orig ? [orig] : []), file]);
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
          // index, stage only the selected paths, then commit. Rename sources ride
          // along with their targets so the staged deletion lands in the commit too.
          for (const p of paths) await assertPathInside(room.path, path.join(room.path, p));
          const sources = await renameSources(room, paths);
          await runGit(room, ['reset', '-q']);
          await runGit(room, ['add', '--', ...new Set([...sources.values(), ...paths])]);
        }
        result = await runGit(room, ['commit', '-m', message]);
      } else if (op === 'discard') {
        // Throw away uncommitted changes to one path (destructive; client confirms).
        const file = requireString(req.body?.path, 'path');
        await assertPathInside(room.path, path.join(room.path, file));
        const orig = (await renameSources(room, [file])).get(file);
        if (orig) {
          // A rename target: the committed state is the SOURCE at HEAD. Restore it and
          // remove the target — treating the target as plain-untracked would delete it
          // without ever bringing the source back.
          await runGit(room, ['checkout', 'HEAD', '--', orig]);
          await run('git', ['rm', '-f', '--ignore-unmatch', '--', file], room.path);
          result = await runGit(room, ['clean', '-fd', '--', file]);
        } else if ((await run('git', ['cat-file', '-e', `HEAD:${file}`], room.path)).exitCode === 0) {
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
      } else if (op === 'revert') {
        // Create a NEW commit that undoes <hash> (git revert) — non-destructive:
        // history is preserved and nothing is rewritten or force-pushed. Kept atomic:
        // if it can't apply cleanly we abort the half-applied revert so the room never
        // gets stuck mid-revert (the panel only drives MERGE_HEAD conflicts, not
        // REVERT_HEAD), and report it as a handled outcome with no changes made.
        const hash = requireString(req.body?.hash, 'hash');
        if (!/^[0-9a-f]{4,40}$/i.test(hash)) throw new HttpError(400, 'invalid commit hash');
        const attempt = await run('git', ['revert', '--no-edit', hash], room.path, { timeoutMs: 60_000 });
        if (attempt.exitCode !== 0) {
          await run('git', ['revert', '--abort'], room.path).catch(() => undefined); // best effort; no-op if no revert started
          throw new HttpError(409, (attempt.stderr || attempt.stdout || '').trim() || 'could not revert that commit cleanly — no changes were made');
        }
        result = attempt;
      } else if (op === 'merge-abort') {
        // Throw away the in-progress merge, returning to the pre-pull state.
        result = await runGit(room, ['merge', '--abort']);
      } else if (op === 'merge-continue') {
        // Conclude a conflicted merge: refuse while any file still has conflict
        // markers (resolved-but-unstaged is fine), then stage the resolved tracked
        // files and commit with the prepared merge message.
        if ((await run('git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], room.path)).exitCode !== 0) throw new HttpError(409, 'no merge in progress');
        // -z: NUL separators and no C-quoting, so non-ASCII paths stat and stage correctly.
        const unmerged = (await run('git', ['diff', '--name-only', '-z', '--diff-filter=U'], room.path)).stdout.split('\0').filter(Boolean);
        const unresolved: string[] = [];
        for (const file of unmerged) if (await hasConflictMarkers(path.join(room.path, file))) unresolved.push(file);
        if (unresolved.length) throw new HttpError(409, `unresolved conflict markers in: ${unresolved.join(', ')}`);
        // Stage only the conflicted files — `add -u` would sweep the user's unrelated
        // working-tree edits into the merge commit.
        if (unmerged.length) await runGit(room, ['add', '--', ...unmerged]);
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
    } finally {
      // Bust the coalesced snapshot whether the op SUCCEEDED or FAILED — a conflicting
      // pull/merge throws but absolutely changed on-disk state (MERGE_HEAD, conflict markers),
      // so the client's immediate post-op refresh must read fresh, not up-to-1.5s-stale. The
      // pre-mutation throws (unknown op / bad args) bust a still-valid entry, which is harmless.
      gitSnapshotCache.delete(req.params.roomId);
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
      // Guard by default: refuse if the terminal is running something (foreground proc
      // isn't the idle shell). ?force=1 skips the guard once the user confirms.
      const force = req.query.force === '1';
      const result = await killRoomTerminal(room.id, terminalId, force);
      if (result?.busy) { res.json({ ok: false, busy: true, proc: result.proc }); return; }
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
    // Vite emits content-hashed files under assets/ — those can be cached forever
    // (immutable). index.html lives at the root and is the SPA shell, so it stays
    // no-cache or a rebuild wouldn't be picked up. Scoped to the assets/ dir so a
    // long-named unhashed public asset is never wrongly frozen.
    app.use(express.static(staticDir, {
      setHeaders: (res, fp) => {
        res.setHeader('Cache-Control', /[/\\]assets[/\\]/.test(fp) ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    }));
    app.get('*splat', (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(staticDir, 'index.html'));
    });
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
        // Finish the handshake only to surface the error to the client, then close. Sent as
        // a BINARY output frame to match the pty-host wire protocol — the renderer now ingests
        // only binary terminal frames, so a JSON text frame here would be silently dropped.
        wss.handleUpgrade(req, socket, head, (ws) => {
          try { ws.send(Buffer.from(`\r\n[devrooms: ${String(error)}]\r\n`, 'utf8'), { binary: true }); } catch { /* noop */ }
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

  // PTYs live in the standalone pty-host and deliberately survive this shutdown;
  // the host is torn down separately (pnpm stop / electron quit).
  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
