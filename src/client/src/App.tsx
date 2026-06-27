import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import './styles.css';
import { CommandPalette, score, type Command } from './CommandPalette';
import { useConfirm } from './Confirm';
import { getActiveTheme, getConfig, resolveTheme, subscribe, type Mode } from './themes';
import hljs from 'highlight.js/lib/common';

// Keyboard-shortcut modifier for hints + handlers: ⌘ on macOS (never reaches the
// PTY, so shortcuts fire even with the terminal focused), Ctrl elsewhere.
const IS_MAC = /mac|darwin/i.test(window.devrooms?.platform ?? navigator.platform ?? '');
const MOD_KEY = IS_MAC ? '⌘' : 'Ctrl+';
const MOD_SHIFT = IS_MAC ? '⌘⇧' : 'Ctrl+Shift+';
const MOD_DEL = IS_MAC ? '⌘⌫' : 'Ctrl+⌫';

type Project = { id: string; name: string; repoUrl: string; rootPath?: string };
type Room = { id: string; projectId: string; name: string; path: string; kind?: 'clone' | 'main'; branch?: string; status: 'creating' | 'idle' | 'error'; error?: string; terminals?: string[]; label?: string };
type GitFile = { index: string; workingTree: string; path: string; raw: string; staged: boolean; dirty: boolean; unmerged?: boolean; conflicted?: boolean };
type Branch = { name: string; committedAt: number };
type GitStatus = { status: { branch: string; files: GitFile[]; raw: string; dirtyCount: number; ahead?: number; behind?: number; hasUpstream?: boolean; unpushedCount?: number; merging?: boolean }; branches: Branch[]; head: string; gitError?: string };
type GitSummary = { behind: number; unpushed: number; dirty: number; conflict: boolean };
type GitSummaries = Record<string, GitSummary>;
type FileDiff = { path: string; diff: string; stagedDiff: string; fullDiff: string; status: string };
type Commit = { hash: string; short: string; author: string; email: string; date: string; subject: string; unpushed?: boolean };
type CommitFile = { status: string; path: string };
type CommitDetail = Commit & { body: string; files: CommitFile[] };
type ManagedProcess = { id: string; roomId: string; name: string; command: string; status: 'running' | 'exited' | 'lost'; startedAt: string; exitedAt?: string; exitCode?: number; logTail: string };
type AgentPreset = { id: string; label: string; description: string; command: string; available: boolean };
type Meta = { name: string; version: string; startedAt: string; uptimeSeconds: number; pid: number; platform: string; node: string; bindHost: string; port: number; home: string; roomsRoot: string; projectCount: number; roomCount: number; processCount: number; runningProcessCount: number };
type ProcessCount = { lost: number; running: number; total: number };
type ProcessCounts = Record<string, ProcessCount>;

type Tab = 'terminal' | 'git' | 'subagents';

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data as T;
}

function wsUrl(path: string) {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}${path}`;
}

function shortPath(value: string) {
  return value.replace(/^\/Users\/[^/]+/, '~');
}

function formatUptime(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1) return `${seconds}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 1) return `${minutes}m`;
  return `${hours}h ${minutes % 60}m`;
}

function compactProc(count?: ProcessCount) {
  if (!count?.total) return '';
  if (count.running) return `${count.running} run`;
  if (count.lost) return `${count.lost} lost`;
  return `${count.total} done`;
}

// A 2-char monogram for the mini rail: first letter of the first two segments
// (split on separators and camelCase), e.g. "api-gateway" → "AG", "devrooms" → "DE".
function projectInitials(name: string) {
  const segments = name
    .split(/[-_\s/.]+/)
    .flatMap((segment) => segment.split(/(?<=[a-z0-9])(?=[A-Z])/))
    .filter(Boolean);
  const letters = segments.length >= 2 ? segments[0][0] + segments[1][0] : name.replace(/[^a-z0-9]/gi, '');
  return (letters || name).slice(0, 2).toUpperCase();
}

const STATUS_GLYPH: Record<Room['status'], string> = { idle: '●', creating: '◐', error: '✕' };

function fileGutter(file: GitFile): { ch: string; cls: string } {
  if (file.conflicted) return { ch: '!', cls: 'conflict' };
  if (file.raw.startsWith('??')) return { ch: '?', cls: 'new' };
  if (file.index.trim() && file.workingTree.trim()) return { ch: '±', cls: 'mixed' };
  if (file.index.trim()) return { ch: 'S', cls: 'staged' };
  if (file.workingTree.trim()) return { ch: 'M', cls: 'modified' };
  return { ch: '•', cls: 'modified' };
}

function relTime(iso: string) {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(months / 12)}y ago`;
}

// Compact age ("5m" / "3h" / "2d" / "4mo" / "2y") from a unix-seconds timestamp,
// for the branch picker's recency tag.
function relAge(unixSec: number) {
  if (!unixSec) return '';
  const secs = Math.max(0, Math.round(Date.now() / 1000 - unixSec));
  if (secs < 3600) return `${Math.max(1, Math.round(secs / 60))}m`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h`;
  if (secs < 2592000) return `${Math.round(secs / 86400)}d`;
  if (secs < 31536000) return `${Math.round(secs / 2592000)}mo`;
  return `${Math.round(secs / 31536000)}y`;
}

const COMMIT_STATUS_CLASS: Record<string, string> = { A: 'new', M: 'modified', D: 'del', R: 'staged', C: 'staged' };

type DiffRow = { type: 'hunk' | 'meta' | 'add' | 'del' | 'ctx'; text: string; oldNo?: number; newNo?: number; lang?: string };

// Map a file path to a highlight.js language id, but only one the bundled
// `common` set actually registers (else we fall back to plain text).
const HL_EXT: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json', json5: 'json',
  css: 'css', scss: 'scss', sass: 'scss', less: 'less',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
  java: 'java', kt: 'kotlin', kts: 'kotlin',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp',
  cs: 'csharp', php: 'php', sql: 'sql', swift: 'swift', lua: 'lua',
  r: 'r', pl: 'perl', pm: 'perl', graphql: 'graphql', gql: 'graphql',
  diff: 'diff', patch: 'diff', make: 'makefile', mk: 'makefile', dockerfile: 'dockerfile',
};
function langForPath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const base = path.slice(path.lastIndexOf('/') + 1);
  const key = (base.includes('.') ? base.slice(base.lastIndexOf('.') + 1) : base).toLowerCase();
  const lang = HL_EXT[key];
  return lang && hljs.getLanguage(lang) ? lang : undefined;
}

function parseDiff(text: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldNo = 0;
  let newNo = 0;
  let curLang: string | undefined;
  for (const line of text.split('\n')) {
    if (line.startsWith('@@')) {
      const match = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (match) { oldNo = Number(match[1]); newNo = Number(match[2]); }
      rows.push({ type: 'hunk', text: line });
    } else if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('+++') || line.startsWith('---') || line.startsWith('new file') || line.startsWith('deleted file') || line.startsWith('old mode') || line.startsWith('new mode') || line.startsWith('similarity') || line.startsWith('rename ') || line.startsWith('\\')) {
      if (line.startsWith('+++ b/')) curLang = langForPath(line.slice(6));
      else if (line.startsWith('diff --git')) { const mm = /^diff --git a\/.+ b\/(.+)$/.exec(line); if (mm) curLang = langForPath(mm[1]); }
      rows.push({ type: 'meta', text: line });
    } else if (line.startsWith('+')) {
      rows.push({ type: 'add', text: line, newNo, lang: curLang });
      newNo++;
    } else if (line.startsWith('-')) {
      rows.push({ type: 'del', text: line, oldNo, lang: curLang });
      oldNo++;
    } else {
      rows.push({ type: 'ctx', text: line, oldNo, newNo, lang: curLang });
      oldNo++;
      newNo++;
    }
  }
  if (rows.length && rows[rows.length - 1].type === 'ctx' && rows[rows.length - 1].text === '') rows.pop();
  return rows;
}

// Per-line syntax highlighting for diff rows via highlight.js (the `common`
// language bundle, ~37 languages). Each line is highlighted independently using
// the language derived from the file path, so a string/comment spanning multiple
// lines may mis-highlight an interior line — an acceptable trade-off for
// line-based diffs. hljs escapes the text it emits, so the HTML is safe to inject.
function highlightCode(code: string, lang?: string): ReactNode {
  if (!code || !lang) return code;
  try {
    return <span dangerouslySetInnerHTML={{ __html: hljs.highlight(code, { language: lang, ignoreIllegals: true }).value }} />;
  } catch {
    return code;
  }
}

function DiffView({ text, path }: { text: string; path?: string }) {
  const rows = useMemo(() => parseDiff(text), [text]);
  const fallbackLang = useMemo(() => langForPath(path), [path]);
  if (!text.trim()) return <div className="empty">no textual changes</div>;
  return (
    <div className="diff-table">
      {rows.map((row, i) => (
        <div key={i} className={`dl ${row.type}`}>
          <span className="ln">{row.oldNo ?? ''}</span>
          <span className="ln">{row.newNo ?? ''}</span>
          {row.type === 'add' || row.type === 'del' || row.type === 'ctx'
            ? <span className="dc"><span className="dpfx">{row.text.slice(0, 1) || ' '}</span>{highlightCode(row.text.slice(1), row.lang ?? fallbackLang)}</span>
            : <span className="dc">{row.text === '' ? ' ' : row.text}</span>}
        </div>
      ))}
    </div>
  );
}

type TerminalResource = {
  key: string;
  container: HTMLDivElement;
  term: Terminal;
  fit: FitAddon;
  opened: boolean;
  hasOutput: boolean;
  endpoint?: string;
  wantEndpoint?: string;
  wantEnsure?: string;
  socket?: WebSocket;
  input?: { dispose(): void };
  reconnectTimer?: number;
  retries?: number;
  wants2031?: boolean;                       // app opted into DEC 2031 color-scheme notifications
  lastSchemeSent?: Mode;                      // dedup: only notify when light/dark actually flips
  notifyColorScheme?: (mode: Mode) => void;  // push a CSI ? 997 ; Ps n notification (themes.ts calls this)
};

declare global {
  interface Window {
    __DEVROOMS_TERMINALS__?: Map<string, TerminalResource>;
    __DEVROOMS_TERMINAL_UNLOAD_BOUND__?: boolean;
    devrooms?: { platform: string; windowControl: (action: 'minimize' | 'close' | 'fullscreen') => void; pickDirectory: () => Promise<string | null>; setBackgroundColor: (color: string) => void };
  }
}

function terminalCache() {
  window.__DEVROOMS_TERMINALS__ ??= new Map<string, TerminalResource>();
  if (!window.__DEVROOMS_TERMINAL_UNLOAD_BOUND__) {
    window.addEventListener('beforeunload', () => {
      for (const resource of window.__DEVROOMS_TERMINALS__?.values() ?? []) resource.socket?.close();
    });
    window.__DEVROOMS_TERMINAL_UNLOAD_BOUND__ = true;
  }
  return window.__DEVROOMS_TERMINALS__;
}

function terminalTarget(roomId?: string, processId?: string, terminalId?: string) {
  if (processId) return { key: `process:${processId}`, endpoint: `/ws/processes/${processId}`, ensure: undefined as string | undefined };
  if (roomId) {
    const tid = terminalId ?? 'main';
    // The main terminal keeps the legacy key/paths so its live session is never
    // disturbed by this change; extras get a `:<tid>` suffix.
    if (tid === 'main') return { key: `room:${roomId}`, endpoint: `/ws/rooms/${roomId}/terminal`, ensure: `/api/rooms/${roomId}/terminal` as string | undefined };
    return { key: `room:${roomId}:${tid}`, endpoint: `/ws/rooms/${roomId}/terminals/${tid}`, ensure: `/api/rooms/${roomId}/terminals/${tid}` as string | undefined };
  }
  return null;
}

function disposeTerminalResource(key: string) {
  const cache = window.__DEVROOMS_TERMINALS__;
  const resource = cache?.get(key);
  if (!resource) return;
  // Tear down reconnection FIRST: clearing wantEndpoint makes the socket's close
  // handler skip scheduleReconnect, and clearing the timer stops a pending retry from
  // firing connectTerminal against the now-disposed xterm. Otherwise disposing would
  // paradoxically resurrect the resource.
  resource.wantEndpoint = undefined;
  resource.wantEnsure = undefined;
  if (resource.reconnectTimer) { window.clearTimeout(resource.reconnectTimer); resource.reconnectTimer = undefined; }
  try { resource.socket?.close(); } catch { /* already closed */ }
  try { resource.input?.dispose(); } catch { /* noop */ }
  try { resource.term.dispose(); } catch { /* noop */ }
  cache!.delete(key);
}

// Dispose every cached terminal belonging to a room: its main `room:<id>` key plus
// any extra `room:<id>:<tid>` tiles. Called when a room is deleted so a later room
// that slugs to the same id can't inherit the dead xterm buffer or socket. Exact
// match for main + a `:`-anchored prefix for tiles, so a sibling room whose id merely
// starts with this id (e.g. `foo` vs `foo-bar`) is never swept up.
function disposeRoomTerminals(roomId: string) {
  const cache = window.__DEVROOMS_TERMINALS__;
  if (!cache) return;
  for (const key of [...cache.keys()]) {
    if (key === `room:${roomId}` || key.startsWith(`room:${roomId}:`)) disposeTerminalResource(key);
  }
}

function getTerminalResource(key: string) {
  const cache = terminalCache();
  const existing = cache.get(key);
  if (existing) return existing;

  const term = new Terminal({
    cursorBlink: true,
    convertEol: false,
    fontFamily: 'JetBrains Mono, SFMono-Regular, Menlo, ui-monospace, monospace',
    fontSize: 13,
    lineHeight: 1.18,
    macOptionIsMeta: true,
    scrollback: 10000,
    theme: getActiveTheme().terminal,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  // Make http(s) URLs clickable. Uses xterm's built-in link provider (no addon) and
  // opens via window.open → the Electron main's setWindowOpenHandler → shell.openExternal
  // (i.e. the system browser). Single-line matching, which covers the common case.
  term.registerLinkProvider({
    provideLinks(lineNo, callback) {
      const line = term.buffer.active.getLine(lineNo - 1);
      if (!line) { callback(undefined); return; }
      const text = line.translateToString(true);
      const links: { range: { start: { x: number; y: number }; end: { x: number; y: number } }; text: string; activate: () => void }[] = [];
      const re = /https?:\/\/[^\s"'`<>()[\]{}]+/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        const uri = m[0].replace(/[.,;:!?]+$/, ''); // drop trailing sentence punctuation
        if (uri.length < 'https://'.length) continue;
        links.push({
          range: { start: { x: m.index + 1, y: lineNo }, end: { x: m.index + uri.length, y: lineNo } },
          text: uri,
          activate: () => { window.open(uri, '_blank', 'noopener,noreferrer'); },
        });
      }
      callback(links.length ? links : undefined);
    },
  });
  const container = document.createElement('div');
  container.className = 'terminal-surface';
  const resource: TerminalResource = { key, container, term, fit, opened: false, hasOutput: false };
  resource.input = term.onData((data) => {
    const socket = resource.socket;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'input', data }));
  });
  term.attachCustomKeyEventHandler((event) => {
    if (event.type === 'keydown' && event.key === 'Enter' && event.shiftKey) {
      const socket = resource.socket;
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'input', data: '\n' }));
      event.preventDefault();
      return false;
    }
    return true;
  });
  // DEC private mode 2031 — color-scheme-change notifications. Adaptive TUIs (e.g.
  // opencode's "system" theme) enable 2031 and then rely on the *terminal* to tell
  // them when light/dark flips; on that signal they re-query OSC 10/11 (which xterm
  // answers from the live theme) and re-theme. xterm.js doesn't implement 2031, so
  // we do it here. Claude Code and other indexed-palette TUIs don't need this —
  // xterm remaps their cells on a theme swap for free; only truecolor TUIs go stale.
  const sendToPty = (data: string): boolean => {
    const socket = resource.socket;
    if (socket?.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify({ type: 'input', data }));
    return true;
  };
  term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
    if (params.includes(2031)) resource.wants2031 = true;
    return false; // observe only — let xterm handle this DECSET (and every other) normally
  });
  term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => {
    if (params.includes(2031)) resource.wants2031 = false; // app left 2031 (e.g. opencode quit)
    return false;
  });
  term.parser.registerCsiHandler({ prefix: '?', intermediates: '$', final: 'p' }, (params) => {
    if (params[0] !== 2031) return false; // DECRQM for any other mode: let xterm answer it
    sendToPty(`\x1b[?2031;${resource.wants2031 ? 1 : 2}$y`); // report support so the app trusts our notifications
    return true;
  });
  resource.lastSchemeSent = getActiveTheme().mode; // the app detects the right mode itself at spawn
  resource.notifyColorScheme = (mode) => {
    if (!resource.wants2031 || resource.lastSchemeSent === mode) return;
    // 1 = dark, 2 = light. Only advance the dedup marker once it's actually delivered,
    // so a flip made while the socket is down retries on the next theme change.
    if (sendToPty(`\x1b[?997;${mode === 'dark' ? 1 : 2}n`)) resource.lastSchemeSent = mode;
  };
  cache.set(key, resource);
  return resource;
}

function scheduleReconnect(resource: TerminalResource, scheduleFit: () => void) {
  if (resource.reconnectTimer || !resource.wantEndpoint) return;
  resource.retries = (resource.retries ?? 0) + 1;
  const delay = Math.min(3000, 400 * 2 ** Math.min(resource.retries - 1, 3));
  resource.reconnectTimer = window.setTimeout(() => {
    resource.reconnectTimer = undefined;
    if (resource.wantEndpoint) void connectTerminal(resource, resource.wantEndpoint, scheduleFit, true, resource.wantEnsure);
  }, delay);
}

async function connectTerminal(resource: TerminalResource, endpoint: string, scheduleFit: () => void, isReconnect = false, ensure?: string) {
  resource.wantEndpoint = endpoint;
  resource.wantEnsure = ensure;
  if (resource.reconnectTimer) { window.clearTimeout(resource.reconnectTimer); resource.reconnectTimer = undefined; }

  const ready = resource.socket?.readyState;
  if (!isReconnect && resource.endpoint === endpoint && (ready === WebSocket.OPEN || ready === WebSocket.CONNECTING)) {
    scheduleFit();
    return;
  }
  if (resource.socket && resource.socket.readyState !== WebSocket.CLOSED) {
    const stale = resource.socket;
    resource.socket = undefined;
    stale.close();
  }

  // On a reconnect, wipe the emulator (clears stale frame + resets mouse/alt-screen
  // modes that would otherwise echo as garbage) and ask the server to replay the
  // full buffer so the view reflects the live PTY's current state.
  if (isReconnect) { resource.term.reset(); resource.hasOutput = false; }

  // Ensure the host has spawned this room's PTY before connecting. In dev the WS
  // goes straight to the pty-host via Vite, so the daemon never sees the connect
  // and can't lazily spawn it — the client asks the daemon to ensure it first.
  if (ensure) {
    try { await fetch(ensure, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); } catch { /* host may already have it */ }
    if (resource.wantEndpoint !== endpoint) return; // superseded by a newer connect
  }

  const replay = resource.hasOutput ? '0' : '1';
  const socket = new WebSocket(wsUrl(`${endpoint}?replay=${replay}`));
  resource.endpoint = endpoint;
  resource.socket = socket;
  socket.addEventListener('open', () => { resource.retries = 0; scheduleFit(); });
  socket.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data as string) as { type?: string; data?: string };
    if (msg.type === 'output' && typeof msg.data === 'string') {
      resource.hasOutput = true;
      resource.term.write(msg.data);
    }
  });
  socket.addEventListener('close', () => {
    if (resource.socket === socket) {
      resource.socket = undefined;
      scheduleReconnect(resource, scheduleFit);
    }
  });
}

function TerminalPane({ roomId, processId, terminalId }: { roomId?: string; processId?: string; terminalId?: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    const target = terminalTarget(roomId, processId, terminalId);
    if (!host || !target) return;
    const resource = getTerminalResource(target.key);
    let disposed = false;
    host.replaceChildren(resource.container);
    if (!resource.opened) {
      resource.term.open(resource.container);
      resource.opened = true;
    }
    resource.term.focus();

    const fitAndResize = () => {
      if (disposed || !host.isConnected || !resource.container.isConnected || host.clientWidth <= 0 || host.clientHeight <= 0) return;
      const proposed = resource.fit.proposeDimensions();
      if (!proposed) return;
      const cols = Math.max(2, proposed.cols - 1);
      const rows = Math.max(2, proposed.rows);
      if (resource.term.cols !== cols || resource.term.rows !== rows) resource.term.resize(cols, rows);
      const socket = resource.socket;
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'resize', cols: resource.term.cols, rows: resource.term.rows }));
    };
    const scheduleFit = () => {
      requestAnimationFrame(() => {
        fitAndResize();
        requestAnimationFrame(fitAndResize);
        window.setTimeout(fitAndResize, 50);
      });
    };
    fitAndResize();
    void connectTerminal(resource, target.endpoint, scheduleFit, false, target.ensure);
    const observer = new ResizeObserver(scheduleFit);
    observer.observe(host);
    observer.observe(resource.container);
    window.addEventListener('resize', scheduleFit);
    document.fonts?.ready.then(scheduleFit).catch(() => undefined);
    scheduleFit();
    return () => {
      disposed = true;
      observer.disconnect();
      window.removeEventListener('resize', scheduleFit);
      if (host.contains(resource.container)) host.removeChild(resource.container);
    };
  }, [roomId, processId, terminalId]);

  return <div className="terminal"><div className="terminal-host" ref={hostRef} /></div>;
}

// Split N panes into balanced rows (tmux "tiled" style): roughly square, wider
// than tall, every pane flexes to fill — no gaps, no manual sizing.
function tileRows<T>(items: T[]): T[][] {
  const n = items.length;
  if (n <= 1) return [items];
  const rows = Math.round(Math.sqrt(n));
  const base = Math.floor(n / rows);
  const extra = n % rows;
  const out: T[][] = [];
  let i = 0;
  for (let r = 0; r < rows; r++) {
    const count = base + (r < extra ? 1 : 0);
    out.push(items.slice(i, i + count));
    i += count;
  }
  return out;
}

function RoomTerminals({ room, onClose }: { room: Room; onClose: (terminalId: string) => void }) {
  const terminals = room.terminals?.length ? room.terminals : ['main'];
  // One terminal: render exactly as before — no pane chrome.
  if (terminals.length === 1) return <TerminalPane roomId={room.id} terminalId={terminals[0]} />;
  return (
    <div className="troom">
      {tileRows(terminals).map((rowItems, r) => (
        <div className="trow" key={r}>
          {rowItems.map((tid) => (
            <div className="tpane" key={tid} data-terminal={tid}>
              <div className="tpane-head">
                <span className="tlabel">{tid === 'main' ? 'main' : `term ${terminals.indexOf(tid) + 1}`}</span>
                {tid !== 'main' && <button className="tpane-x" title={`close terminal (${MOD_KEY}W)`} onClick={() => onClose(tid)}>×</button>}
              </div>
              <TerminalPane roomId={room.id} terminalId={tid} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

// Per-room agent state derived from the host's activity stream.
type RoomActivity = { lastOutputMs: number; attentionMs: number; agentState?: string; agentStateMs: number };
type RoomState = 'thinking' | 'needs-input' | 'attention' | 'idle';
const BUSY_MS = 1000;
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function deriveRoomState(activity: RoomActivity | undefined, ackMs: number): RoomState {
  if (!activity) return 'idle';
  const now = Date.now(); // same machine as the host, so its ms timestamps are comparable
  // An explicit hook state only counts while it's the LATEST thing the agent did — its
  // OSC was the last output, nothing real has happened since. That gates two things:
  //  - a stale "done"/"needs-input" doesn't linger after the agent resumed, and
  //  - "working" is NOT treated as sticky. opencode emits "working" but often never a
  //    matching "done"/idle, so honoring it directly spun forever. Real output drives
  //    "thinking" (and stops within BUSY_MS of the agent going quiet), which is the
  //    correct signal for both claude and opencode.
  if (activity.agentState === 'needs-input') return activity.agentStateMs > ackMs ? 'needs-input' : 'idle';
  if (activity.agentState === 'done') return activity.agentStateMs > ackMs ? 'attention' : 'idle';
  if (now - activity.lastOutputMs < BUSY_MS) return 'thinking';
  if (activity.attentionMs > ackMs && activity.attentionMs >= activity.lastOutputMs - 150) return 'attention';
  return 'idle';
}

function AgentGlyph({ state }: { state: RoomState }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (state !== 'thinking') return;
    const id = window.setInterval(() => setFrame((value) => (value + 1) % SPIN.length), 90);
    return () => window.clearInterval(id);
  }, [state]);
  if (state === 'thinking') return <span className="glyph thinking" title="thinking">{SPIN[frame]}</span>;
  if (state === 'needs-input') return <span className="glyph needs-input" title="waiting for your input">◆</span>;
  if (state === 'attention') return <span className="glyph attention" title="finished — your turn">◆</span>;
  return <span className="glyph idle">●</span>;
}

function ChangesView({ room, status, branch, onCommitted }: { room: Room; status: GitStatus | null; branch: string; onCommitted: () => Promise<void> | void }) {
  const files = status?.status.files ?? [];
  const merging = status?.status.merging ?? false;
  const [selected, setSelected] = useState<string | null>(null);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [summary, setSummary] = useState('');
  const [description, setDescription] = useState('');
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const masterRef = useRef<HTMLInputElement | null>(null);
  const confirm = useConfirm();

  useEffect(() => {
    setExcluded((prev) => { const next = new Set<string>(); for (const file of files) if (prev.has(file.path)) next.add(file.path); return next; });
    setSelected((current) => (current && files.some((file) => file.path === current)) ? current : (files[0]?.path ?? null));
  }, [status]);

  useEffect(() => {
    if (!selected) { setDiff(null); return; }
    let alive = true;
    api<FileDiff>(`/api/rooms/${room.id}/git/diff?path=${encodeURIComponent(selected)}`)
      .then((data) => { if (alive) setDiff(data); })
      .catch(() => { if (alive) setDiff(null); });
    return () => { alive = false; };
  }, [room.id, selected]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      // Any open overlay (palette, branch menu, confirm popup) owns the arrow keys —
      // don't move file selection underneath it, even during the brief gap before the
      // overlay has taken focus.
      if (document.querySelector('.cmd-overlay')) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return;
      if (!files.length) return;
      const index = Math.max(0, files.findIndex((file) => file.path === selected));
      const next = event.key === 'ArrowDown' ? Math.min(files.length - 1, index + 1) : Math.max(0, index - 1);
      setSelected(files[next].path);
      event.preventDefault();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [files, selected]);

  useEffect(() => { document.querySelector('.chg-file.sel')?.scrollIntoView({ block: 'nearest' }); }, [selected]);

  const included = files.filter((file) => !excluded.has(file.path));
  const allIncluded = files.length > 0 && included.length === files.length;
  const noneIncluded = included.length === 0;
  useEffect(() => { if (masterRef.current) masterRef.current.indeterminate = !allIncluded && !noneIncluded; }, [allIncluded, noneIncluded]);

  function toggle(path: string) {
    setExcluded((prev) => { const next = new Set(prev); if (next.has(path)) next.delete(path); else next.add(path); return next; });
  }
  function toggleAll() {
    setExcluded((prev) => prev.size === 0 ? new Set(files.map((file) => file.path)) : new Set());
  }

  async function commit() {
    if (!summary.trim() || included.length === 0) return;
    setCommitting(true); setError(null);
    try {
      const message = description.trim() ? `${summary.trim()}\n\n${description.trim()}` : summary.trim();
      await api(`/api/rooms/${room.id}/git/commit`, { method: 'POST', body: JSON.stringify({ message, paths: included.map((file) => file.path) }) });
      setSummary(''); setDescription('');
      await onCommitted();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setCommitting(false); }
  }

  async function discardFile(path: string) {
    if (!(await confirm({ title: `Discard changes to ${path}?`, detail: "This can't be undone.", confirmLabel: 'discard', danger: true }))) return;
    setError(null);
    try {
      await api(`/api/rooms/${room.id}/git/discard`, { method: 'POST', body: JSON.stringify({ path }) });
      await onCommitted();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  }

  async function discardAll() {
    if (!files.length) return;
    if (!(await confirm({ title: `Discard all ${files.length} uncommitted change${files.length === 1 ? '' : 's'}?`, detail: "This can't be undone.", confirmLabel: 'discard all', danger: true }))) return;
    setError(null);
    try {
      await api(`/api/rooms/${room.id}/git/discard-all`, { method: 'POST', body: JSON.stringify({}) });
      await onCommitted();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  }

  return (
    <div className="changes">
      <div className="chg-left">
        <div className="chg-listhead">
          <input ref={masterRef} type="checkbox" className="ck" checked={allIncluded} onChange={toggleAll} disabled={!files.length} />
          <span>{files.length} changed file{files.length === 1 ? '' : 's'}</span>
          {files.length > 0 && !merging && <button className="discard-all" title="discard all uncommitted changes" onClick={discardAll}>discard all</button>}
        </div>
        <div className="chg-list">
          {files.length ? files.map((file) => {
            const gutter = fileGutter(file);
            return (
              <div key={file.path} className={selected === file.path ? 'chg-file sel' : 'chg-file'} onClick={() => setSelected(file.path)}>
                <input type="checkbox" className="ck" checked={!excluded.has(file.path)} onChange={() => toggle(file.path)} onClick={(event) => event.stopPropagation()} />
                <span className={`g ${gutter.cls}`}>{gutter.ch}</span>
                <span className="p">{file.path}</span>
                {!file.unmerged && <button className="discard-file" title="discard changes" onClick={(event) => { event.stopPropagation(); discardFile(file.path); }}>discard</button>}
              </div>
            );
          }) : <div className="empty clean">no local changes</div>}
        </div>
        {merging ? (
          <div className="chg-commitbox merging">
            <div className="merge-hint">
              merge in progress. resolve the <span className="g conflict">!</span> files in your editor, then use
              <strong> commit merge</strong> above. or <strong>abort</strong> to back out.
            </div>
            {error && <div className="error inline">{error}</div>}
          </div>
        ) : (
          <div className="chg-commitbox">
            <input value={summary} onChange={(event) => setSummary(event.target.value)} placeholder="summary" />
            <textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="description (optional)" rows={3} />
            {error && <div className="error inline">{error}</div>}
            <button className="commit-btn" disabled={committing || !summary.trim() || included.length === 0} onClick={commit}>
              {committing ? 'committing…' : `commit ${included.length} file${included.length === 1 ? '' : 's'} to ${branch || 'branch'}`}
            </button>
          </div>
        )}
      </div>
      <div className="diff-pane">
        {selected ? (
          <>
            <div className="diff-head"><span className="fp">{selected}</span></div>
            <DiffView text={diff?.fullDiff || diff?.diff || ''} path={selected ?? undefined} />
          </>
        ) : <div className="empty">select a file to view its diff</div>}
      </div>
    </div>
  );
}

function HistoryView({ room, reloadKey }: { room: Room; reloadKey: number }) {
  const [commits, setCommits] = useState<Commit[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<CommitDetail | null>(null);
  const [file, setFile] = useState<string | null>(null);
  const [diff, setDiff] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api<{ commits: Commit[] }>(`/api/rooms/${room.id}/git/log?limit=100`)
      .then((data) => { if (!alive) return; setCommits(data.commits); setSelected((current) => current ?? data.commits[0]?.hash ?? null); })
      .catch((err) => { if (alive) setError(err instanceof Error ? err.message : String(err)); });
    return () => { alive = false; };
    // reloadKey bumps after every git op (push/pull/fetch/checkout) so the
    // unpushed (↑) markers refresh once a push lands.
  }, [room.id, reloadKey]);

  useEffect(() => {
    if (!selected) { setDetail(null); setFile(null); return; }
    let alive = true;
    api<CommitDetail>(`/api/rooms/${room.id}/git/commit?hash=${selected}`)
      .then((data) => { if (!alive) return; setDetail(data); setFile(data.files[0]?.path ?? null); })
      .catch((err) => { if (alive) setError(err instanceof Error ? err.message : String(err)); });
    return () => { alive = false; };
  }, [room.id, selected]);

  useEffect(() => {
    if (!selected || !file) { setDiff(''); return; }
    let alive = true;
    api<{ diff: string }>(`/api/rooms/${room.id}/git/commit-diff?hash=${selected}&path=${encodeURIComponent(file)}`)
      .then((data) => { if (alive) setDiff(data.diff); })
      .catch(() => { if (alive) setDiff(''); });
    return () => { alive = false; };
  }, [room.id, selected, file]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return;
      if (!commits.length) return;
      const index = Math.max(0, commits.findIndex((commit) => commit.hash === selected));
      const next = event.key === 'ArrowDown' ? Math.min(commits.length - 1, index + 1) : Math.max(0, index - 1);
      setSelected(commits[next].hash);
      event.preventDefault();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [commits, selected]);

  useEffect(() => { document.querySelector('.commit-row.sel')?.scrollIntoView({ block: 'nearest' }); }, [selected]);

  return (
    <div className="history">
      <div className="hist-list">
        {commits.length ? commits.map((commit) => (
          <div key={commit.hash} className={`commit-row${selected === commit.hash ? ' sel' : ''}${commit.unpushed ? ' up' : ''}`} onClick={() => setSelected(commit.hash)}>
            <span className="cgutter" title={commit.unpushed ? 'not pushed to origin' : undefined}>{commit.unpushed ? '↑' : ''}</span>
            <span className="cbody">
              <span className="csub">{commit.subject}</span>
              <span className="cmeta"><span className="cauthor">{commit.author}</span><span className="cdate">{relTime(commit.date)}</span><span className="chash">{commit.short}</span></span>
            </span>
          </div>
        )) : <div className="empty">{error ?? 'no commits yet'}</div>}
      </div>
      <div className="diff-pane">
        {detail ? (
          <>
            <div className="commit-detail-head">
              <div className="cd-subject">{detail.subject}</div>
              {detail.body && <div className="cd-body">{detail.body}</div>}
              <div className="cd-meta"><span>{detail.author}</span><span>{relTime(detail.date)}</span><span className="chash">{detail.short}</span><span>{detail.files.length} file{detail.files.length === 1 ? '' : 's'}</span></div>
            </div>
            <div className="cd-files">
              {detail.files.map((commitFile) => {
                const cls = COMMIT_STATUS_CLASS[commitFile.status[0]] ?? 'modified';
                return (
                  <div key={commitFile.path} className={file === commitFile.path ? 'cd-file sel' : 'cd-file'} onClick={() => setFile(commitFile.path)}>
                    <span className={`g ${cls}`}>{commitFile.status[0]}</span>
                    <span className="p">{commitFile.path}</span>
                  </div>
                );
              })}
            </div>
            <div className="diff-head"><span className="fp">{file ?? ''}</span></div>
            <DiffView text={diff} path={file ?? undefined} />
          </>
        ) : <div className="empty">{error ?? 'select a commit'}</div>}
      </div>
    </div>
  );
}

// Git state + operations for one room, lifted out of the panel so the branch
// toolbar can live in the workspace header (visible on every tab) while the
// changes/history panel shares the exact same status — one fetch, one source of
// truth. Polls whenever a room is selected; resets on room change.
function useGitRoom(room: Room | null) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [pushRejected, setPushRejected] = useState(false);
  const roomId = room?.id ?? null;

  const refresh = useCallback(async (): Promise<GitStatus | null> => {
    if (!roomId) { setStatus(null); return null; }
    try { const next = await api<GitStatus>(`/api/rooms/${roomId}/git/status`); setStatus(next); setError(null); return next; }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); return null; }
  }, [roomId]);

  // Reset transient state and refetch on room change (clearing status first so the
  // header never flashes the previous room's branch).
  useEffect(() => { setPushRejected(false); setNote(''); setError(null); setStatus(null); refresh(); }, [roomId, refresh]);
  useEffect(() => {
    if (!roomId) return undefined;
    const onFocus = () => { refresh(); };
    window.addEventListener('focus', onFocus);
    const timer = window.setInterval(() => { refresh(); }, 4000);
    return () => { window.removeEventListener('focus', onFocus); window.clearInterval(timer); };
  }, [roomId, refresh]);

  const gitOp = useCallback(async (op: string, body?: unknown) => {
    if (!roomId) return false;
    setError(null);
    try {
      const result = await api<{ stdout: string; stderr: string }>(`/api/rooms/${roomId}/git/${op}`, { method: 'POST', body: JSON.stringify(body ?? {}) });
      setNote([result.stdout, result.stderr].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().slice(0, 200) || `${op} ok`);
      setPushRejected(false);
      await refresh();
      window.dispatchEvent(new Event('devrooms:git')); // nudge the sidebar icons to re-poll now
      setReloadKey((value) => value + 1); // re-fetch history so ↑ markers update
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Re-read git state right away so the UI reflects reality without waiting for the
      // poll or a tab switch. Crucially, decide off STATE (is a merge now in progress?)
      // rather than parsing the error text — a conflicted `git pull` reports its fetch
      // summary on stderr and the "CONFLICT" lines on stdout, so the message alone lies.
      const next = await refresh();
      window.dispatchEvent(new Event('devrooms:git')); // a failed op can still change state (e.g. conflict) — refresh icons
      if (next?.status.merging) {
        // The merge started but hit conflicts — switch straight to the resolve/commit UI.
        setPushRejected(false);
        setError(null);
        setNote('merge conflicts — resolve the ! files, then commit the merge');
      // Clone room whose origin is a local repo with no real remote: git refuses to push
      // the branch checked out there. pull & merge can't fix it — say so plainly.
      } else if (op === 'push' && /checked out branch|denyCurrentBranch/i.test(message)) {
        setPushRejected(false);
        setError(null);
        setNote('cannot push: that branch is checked out in the repo this room was cloned from. work on a room branch, or give the project a remote.');
      // Non-fast-forward push: origin moved on. Flip the button to pull & merge
      // (GitHub Desktop style) — pull merges, then the merge can be pushed.
      } else if (op === 'push' && /rejected|fetch first|non-fast-forward|failed to push/i.test(message)) {
        setPushRejected(true);
        setError(null);
        setNote('origin has new commits — pull & merge, then push again');
      } else if ((op === 'pull' || op === 'merge') && /would be overwritten|commit your changes|please commit|stash/i.test(message)) {
        // Dirty working tree blocks the merge. Point at the natural fix instead of a raw error.
        setPushRejected(false);
        setError(null);
        setNote('you have uncommitted changes — commit them below (or stash) first');
      } else {
        setError(message);
      }
      return false;
    }
  }, [roomId, refresh]);

  const doOp = useCallback(async (op: string, body?: unknown) => { setSyncing(true); try { await gitOp(op, body); } finally { setSyncing(false); } }, [gitOp]);

  const branch = status?.status.branch.split('...')[0] ?? room?.branch ?? '';
  const changeCount = status?.status.files.length ?? 0;
  const unpushed = status?.status.unpushedCount ?? 0;
  const behind = status?.status.behind ?? 0;
  const hasUpstream = status?.status.hasUpstream ?? false;
  const merging = status?.status.merging ?? false;
  const conflicts = (status?.status.files ?? []).filter((file) => file.conflicted).length;
  const otherBranches = (status?.branches ?? []).filter((b) => b.name !== branch);
  const gitError = status?.gitError;
  // One adaptive sync action, in git terms: pull when behind (incl. diverged),
  // otherwise push when there are unpushed commits, otherwise fetch to check.
  // A rejected push (origin ahead) forces pull & merge even when our cached
  // behind-count is stale — we haven't fetched since origin moved on.
  const mergePull = pushRejected || (behind > 0 && unpushed > 0);
  const syncOp = (behind > 0 || pushRejected) ? 'pull' : unpushed > 0 ? 'push' : 'fetch';
  const syncLabel = syncOp === 'fetch' ? '⟳ fetch' : syncOp === 'pull' ? (mergePull ? 'pull & merge' : 'pull') : 'push';
  const syncTitle = syncOp === 'fetch'
    ? 'git fetch --all --prune'
    : syncOp === 'pull'
      ? (mergePull ? 'origin has new commits — git pull (merge), then push' : `git pull origin ${branch}`)
      : hasUpstream ? `git push origin ${branch}` : `git push -u origin ${branch} (new branch)`;

  return { status, error, note, setNote, syncing, reloadKey, refresh, gitOp, doOp, branch, changeCount, unpushed, behind, merging, conflicts, otherBranches, gitError, syncOp, syncLabel, syncTitle };
}

type GitRoom = ReturnType<typeof useGitRoom>;

// The branch / sync / merge toolbar. Lives in the workspace header so it's
// available on every tab (terminal, git, subagents), not just the git tab.
// A searchable branch action menu (palette-style, reusing the .cmd-* UI): switch
// branch (recency-sorted — abandoned ones sink), a "merge a branch in…" submode,
// and inline "create branch '<typed>'". Replaces the old branch select + merge
// select + new-branch field with one keyboard-driven picker.
type BranchRow = { id: string; title: string; hint?: string; age?: string; checked?: boolean; act: () => void };

function BranchMenu({ open, onClose, current, branches, canMerge, onCheckout, onCreate, onMerge }: {
  open: boolean;
  onClose: () => void;
  current: string;
  branches: Branch[];
  canMerge: boolean;
  onCheckout: (name: string) => void;
  onCreate: (name: string) => void;
  onMerge: (name: string) => void;
}) {
  const [mode, setMode] = useState<'switch' | 'merge'>('switch');
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (open) {
      restoreRef.current = document.activeElement as HTMLElement | null;
      setMode('switch'); setQuery(''); setIndex(0);
      const raf = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(raf);
    }
    restoreRef.current?.focus?.();
    restoreRef.current = null;
    return undefined;
  }, [open]);

  const q = query.trim();
  const base: BranchRow[] = [];
  if (mode === 'switch') {
    if (canMerge) base.push({ id: '_merge', title: 'merge a branch in…', hint: `into ${current}`, act: () => { setMode('merge'); setQuery(''); setIndex(0); } });
    for (const b of branches) base.push({ id: `sw:${b.name}`, title: b.name, age: relAge(b.committedAt), checked: b.name === current, act: () => { if (b.name !== current) onCheckout(b.name); onClose(); } });
  } else {
    for (const b of branches.filter((b) => b.name !== current)) base.push({ id: `mg:${b.name}`, title: b.name, age: relAge(b.committedAt), act: () => { onMerge(b.name); onClose(); } });
  }
  let rows = q
    ? base.map((r, i) => ({ r, s: score(q, `${r.title} ${r.hint ?? ''}`), i })).filter((e) => e.s > 0).sort((a, b) => b.s - a.s || a.i - b.i).map((e) => e.r)
    : base;
  // Type a name that isn't an existing branch → offer to create it (switch mode only).
  if (mode === 'switch' && q && !branches.some((b) => b.name === q)) {
    rows = [...rows, { id: '_create', title: `create branch “${q}”`, age: 'new', act: () => { onCreate(q); onClose(); } }];
  }
  const idx = rows.length ? Math.min(index, rows.length - 1) : 0;
  const activeId = rows[idx]?.id ?? null;
  useEffect(() => { listRef.current?.querySelector('.cmd-row.sel')?.scrollIntoView({ block: 'nearest' }); }, [activeId]);

  if (!open) return null;

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); setIndex((i) => (rows.length ? (Math.min(i, rows.length - 1) + 1) % rows.length : 0)); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setIndex((i) => (rows.length ? (Math.min(i, rows.length - 1) - 1 + rows.length) % rows.length : 0)); }
    else if (event.key === 'Enter') { event.preventDefault(); rows[idx]?.act(); }
    else if (event.key === 'Escape') { event.preventDefault(); if (mode === 'merge') { setMode('switch'); setQuery(''); setIndex(0); } else onClose(); }
    else if (event.key === 'Backspace' && query === '' && mode === 'merge') { event.preventDefault(); setMode('switch'); setIndex(0); }
  };

  return (
    <div className="cmd-overlay" onMouseDown={onClose}>
      <div className="cmd" onMouseDown={(event) => event.stopPropagation()}>
        <div className="cmd-input">
          {mode === 'merge' && <span className="cmd-crumb">merge into {current}<span className="cmd-crumb-sep">›</span></span>}
          <input ref={inputRef} value={query} onChange={(event) => { setQuery(event.target.value); setIndex(0); }} onKeyDown={onKeyDown}
            placeholder={mode === 'merge' ? 'pick a branch to merge…' : 'switch branch, or type a new name…'} spellCheck={false} autoComplete="off" />
        </div>
        <div className="cmd-list" ref={listRef}>
          {rows.length ? rows.map((row, i) => (
            <div key={row.id} className={i === idx ? 'cmd-row sel' : 'cmd-row'} onMouseMove={() => setIndex(i)} onMouseDown={(event) => { event.preventDefault(); row.act(); }}>
              <span className="cmd-main">
                <span className="cmd-title">{row.title}</span>
                {row.hint && <span className="cmd-hint">{row.hint}</span>}
              </span>
              {row.age && <span className="branch-age">{row.age}</span>}
              {row.checked && <span className="cmd-check">●</span>}
            </div>
          )) : <div className="cmd-empty">no matches</div>}
        </div>
        <div className="cmd-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
          <span><kbd>↵</kbd> select</span>
          <span><kbd>esc</kbd> {mode === 'merge' ? 'back' : 'close'}</span>
        </div>
      </div>
    </div>
  );
}

function GitBar({ git }: { git: GitRoom }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const confirm = useConfirm();
  const { branch, otherBranches, merging, conflicts, syncing, syncOp, syncLabel, syncTitle, behind, unpushed, doOp, gitOp } = git;
  // The global ⌘⇧B shortcut and the "git: branch…" palette command open this menu.
  useEffect(() => {
    const open = () => setMenuOpen(true);
    window.addEventListener('devrooms:branch-menu', open);
    return () => window.removeEventListener('devrooms:branch-menu', open);
  }, []);
  return (
    <span className="headgit">
      {merging ? (
        <span className="mergebar">
          <span className="merge-state">{conflicts > 0 ? `merging — ${conflicts} conflict${conflicts === 1 ? '' : 's'}` : 'merging — resolved'}</span>
          <button className="merge-commit" disabled={syncing || conflicts > 0} title="conclude the merge (git commit --no-edit)" onClick={() => doOp('merge-continue')}>commit merge</button>
          <button className="merge-abort" disabled={syncing} title="discard the merge (git merge --abort)" onClick={() => doOp('merge-abort')}>abort</button>
        </span>
      ) : (
        <button className="sync" disabled={syncing} onClick={() => doOp(syncOp)} title={`${syncTitle}  (${MOD_KEY}S)`}>
          <span className="sync-verb">{syncing ? 'syncing…' : syncLabel}</span>
          {!syncing && (behind > 0 || unpushed > 0) && (
            <span className="sync-counts">
              {behind > 0 && <span className="dn">↓{behind}</span>}
              {unpushed > 0 && <span className="up">↑{unpushed}</span>}
            </span>
          )}
          {!syncing && <span className="kbd-hint">{MOD_KEY}S</span>}
        </button>
      )}
      <button className="branch-btn" disabled={syncing} onClick={() => setMenuOpen(true)} title={`switch / merge / create branch  (${MOD_SHIFT}B)`}>
        <span className="branch-cur">{branch || 'branch'}</span><span className="branch-caret">▾</span>
        <span className="kbd-hint">{MOD_SHIFT}B</span>
      </button>
      <BranchMenu
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        current={branch}
        branches={git.status?.branches ?? []}
        canMerge={!merging && otherBranches.length > 0}
        onCheckout={(name) => gitOp('checkout', { branch: name })}
        onCreate={(name) => gitOp('checkout-new', { branch: name })}
        onMerge={async (name) => { if (await confirm({ title: `Merge ${name} into ${branch}?`, detail: 'Combines its commits into the current branch.', confirmLabel: 'merge' })) gitOp('merge', { branch: name }); }}
      />
    </span>
  );
}

// Transient git op feedback (notes/errors), shown as a line under the header so it
// sits below the toolbar regardless of which tab is open.
function GitFeedback({ git }: { git: GitRoom }) {
  if (!git.error && !git.gitError && !git.note) return null;
  return (
    <>
      {git.error && <div className="error">{git.error}</div>}
      {git.gitError && <div className="error">git unavailable: {git.gitError}</div>}
      {git.note && <div className="gitnote" onClick={() => git.setNote('')}>{git.note}</div>}
    </>
  );
}

function GitPanel({ room, git }: { room: Room; git: GitRoom }) {
  const [view, setView] = useState<'changes' | 'history'>('changes');
  // On opening the git tab (GitPanel mounts fresh each time) or switching rooms,
  // pick the default view from the freshly-fetched status: history when there's
  // nothing to manage — no uncommitted changes and no merge in progress — else
  // changes. Only runs on room change/mount, so manual tab switches stick.
  useEffect(() => {
    git.refresh().then((next) => {
      if (next) setView(next.status.files.length === 0 && !next.status.merging ? 'history' : 'changes');
    });
  }, [room.id, git.refresh]);
  return (
    <div className="git">
      <div className="git-tabs">
        <button className={view === 'changes' ? 'gt active' : 'gt'} onClick={() => setView('changes')}>changes{git.changeCount ? ` ${git.changeCount}` : ''}</button>
        <button className={view === 'history' ? 'gt active' : 'gt'} onClick={() => setView('history')}>history</button>
      </div>
      {view === 'changes'
        ? <ChangesView room={room} status={git.status} branch={git.branch} onCommitted={() => { git.refresh(); }} />
        : <HistoryView room={room} reloadKey={git.reloadKey} />}
    </div>
  );
}

function SubagentsPanel({ room, presets }: { room: Room; presets: AgentPreset[] }) {
  const [processes, setProcesses] = useState<ManagedProcess[]>([]);
  const [command, setCommand] = useState('hermes chat --tui --source devrooms --accept-hooks --pass-session-id');
  const [name, setName] = useState('Hermes TUI');
  const [attached, setAttached] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    const data = await api<{ processes: ManagedProcess[] }>(`/api/rooms/${room.id}/processes`);
    setProcesses(data.processes);
  }
  useEffect(() => { refresh().catch((err) => setError(err.message)); const timer = setInterval(() => refresh().catch(() => undefined), 3000); return () => clearInterval(timer); }, [room.id]);
  async function start() {
    setError(null);
    const data = await api<{ process: ManagedProcess }>(`/api/rooms/${room.id}/processes`, { method: 'POST', body: JSON.stringify({ command, name }) });
    setAttached(data.process.id);
    await refresh();
  }
  async function kill(processId: string) { await api(`/api/processes/${processId}`, { method: 'DELETE' }); await refresh(); }

  return (
    <div className="subs">
      <div className="presets">
        {presets.map((preset) => (
          <button key={preset.id} className={preset.available ? 'preset' : 'preset off'} onClick={() => { setCommand(preset.command); setName(preset.label); }}>
            <span className="l">{preset.label}</span>
            <span className="c">{preset.available ? preset.command : `missing: ${preset.command}`}</span>
          </button>
        ))}
      </div>
      <div className="launcher">
        <input className="name" value={name} onChange={(event) => setName(event.target.value)} placeholder="process name" />
        <input className="cmd" value={command} onChange={(event) => setCommand(event.target.value)} placeholder="command" />
        <button disabled={!command.trim()} onClick={start}>start</button>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="proclist">
        {processes.length ? processes.map((proc) => (
          <div className={attached === proc.id ? 'proc sel' : 'proc'} key={proc.id}>
            <span className="acts">
              <button onClick={() => setAttached(proc.id)}>{proc.status === 'running' ? 'attach' : 'log'}</button>
              <button onClick={() => kill(proc.id)}>{proc.status === 'running' ? 'kill' : 'dismiss'}</button>
            </span>
            <span className="pname">{proc.name}</span>
            <span className="pcmd">{proc.command}</span>
            <span className={`st ${proc.status}`}>{proc.status}{proc.exitCode !== undefined ? `:${proc.exitCode}` : ''}</span>
          </div>
        )) : <div className="empty">no room processes yet</div>}
      </div>
      <div className="attached">
        {attached ? <TerminalPane processId={attached} /> : <div className="empty">start or attach a process to view its terminal</div>}
      </div>
    </div>
  );
}

// Clone-a-room overlay. Its own modal (reusing the palette's .cmd-* chrome), opened
// by ⌘N, the sidebar "+ room" button, and the "clone room…" command — deliberately
// NOT a sub-mode of the command palette, so Esc closes it outright. It's a searchable
// branch picker (same UX as the branch switcher): the source repo's branches with the
// current branch highlighted, so Enter clones off it with zero typing. Rooms are
// auto-named after their branch — there is no name field.
function NewRoomDialog({ open, onClose, projectName, defaultBranch, branchSourceRoomId, disabled, onClone }: {
  open: boolean;
  onClose: () => void;
  projectName?: string;
  defaultBranch: string;
  branchSourceRoomId?: string;
  disabled?: boolean;
  onClone: (branch: string) => void;
}) {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  // Read the latest values without making them effect deps, so a background rooms-poll
  // (or a keystroke) can't reset the highlight while you navigate — we only seed once.
  const defaultBranchRef = useRef(defaultBranch);
  defaultBranchRef.current = defaultBranch;
  const queryRef = useRef(query);
  queryRef.current = query;

  useEffect(() => {
    if (!open) { restoreRef.current?.focus?.(); restoreRef.current = null; return undefined; }
    restoreRef.current = document.activeElement as HTMLElement | null;
    setQuery(''); setIndex(0); setBranches([]);
    const raf = requestAnimationFrame(() => inputRef.current?.focus());
    // Pull the source repo's branch list so the picker is searchable. Best-effort: if it
    // fails or there's no ready room yet, you can still type a branch name to clone off.
    let alive = true;
    if (branchSourceRoomId) {
      void api<GitStatus>(`/api/rooms/${branchSourceRoomId}/git/status`)
        .then((g) => { if (alive) setBranches(g.branches ?? []); })
        .catch(() => { /* free-text fallback */ });
    }
    return () => { alive = false; cancelAnimationFrame(raf); };
  }, [open, branchSourceRoomId]);

  // Once the branch list arrives (and you haven't started typing), highlight the
  // current branch so Enter clones off it with no typing.
  useEffect(() => {
    if (!open || !branches.length || queryRef.current) return;
    const i = branches.findIndex((b) => b.name === defaultBranchRef.current);
    setIndex(i >= 0 ? i : 0);
  }, [open, branches]);

  const q = query.trim();
  const base: BranchRow[] = branches.map((b) => ({
    id: `cl:${b.name}`, title: b.name, age: relAge(b.committedAt), checked: b.name === defaultBranch,
    act: () => { if (!disabled) { onClone(b.name); onClose(); } },
  }));
  let rows = q
    ? base.map((r, i) => ({ r, s: score(q, r.title), i })).filter((e) => e.s > 0).sort((a, b) => b.s - a.s || a.i - b.i).map((e) => e.r)
    : base;
  // Typed something that isn't an existing branch → offer to clone off it anyway (covers
  // a repo whose branch list hasn't loaded, or an exact ref you know by name).
  if (q && !branches.some((b) => b.name === q)) {
    rows = [...rows, { id: '_type', title: `clone off “${q}”`, age: 'branch', act: () => { if (!disabled) { onClone(q); onClose(); } } }];
  }
  const idx = rows.length ? Math.min(index, rows.length - 1) : 0;
  const activeId = rows[idx]?.id ?? null;
  useEffect(() => { listRef.current?.querySelector('.cmd-row.sel')?.scrollIntoView({ block: 'nearest' }); }, [activeId]);

  if (!open) return null;

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); setIndex((i) => (rows.length ? (Math.min(i, rows.length - 1) + 1) % rows.length : 0)); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setIndex((i) => (rows.length ? (Math.min(i, rows.length - 1) - 1 + rows.length) % rows.length : 0)); }
    else if (event.key === 'Enter') { event.preventDefault(); rows[idx]?.act(); }
    else if (event.key === 'Escape') { event.preventDefault(); onClose(); }
  };

  return (
    <div className="cmd-overlay" onMouseDown={onClose}>
      <div className="cmd" onMouseDown={(event) => event.stopPropagation()}>
        <div className="cmd-input">
          <span className="cmd-crumb">clone into {projectName ?? 'project'}<span className="cmd-crumb-sep">›</span></span>
          <input ref={inputRef} value={query} onChange={(event) => { setQuery(event.target.value); setIndex(0); }} onKeyDown={onKeyDown}
            placeholder="clone off a branch — search or type a name…" spellCheck={false} autoComplete="off" />
        </div>
        <div className="cmd-list" ref={listRef}>
          {rows.length ? rows.map((row, i) => (
            <div key={row.id} className={i === idx ? 'cmd-row sel' : 'cmd-row'} onMouseMove={() => setIndex(i)} onMouseDown={(event) => { event.preventDefault(); row.act(); }}>
              <span className="cmd-main">
                <span className="cmd-title">{row.title}</span>
                {row.hint && <span className="cmd-hint">{row.hint}</span>}
              </span>
              {row.age && <span className="branch-age">{row.age}</span>}
              {row.checked && <span className="cmd-check">●</span>}
            </div>
          )) : <div className="cmd-empty">no branches — type a name to clone off it</div>}
        </div>
        <div className="cmd-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
          <span><kbd>↵</kbd> clone room</span>
          <span><kbd>esc</kbd> cancel</span>
        </div>
      </div>
    </div>
  );
}

export function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [presets, setPresets] = useState<AgentPreset[]>([]);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [processCounts, setProcessCounts] = useState<ProcessCounts>({});
  const [gitSummary, setGitSummary] = useState<GitSummaries>({});
  const [roomProcesses, setRoomProcesses] = useState<ManagedProcess[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('terminal');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = useConfirm();
  const [paletteOpen, setPaletteOpen] = useState(false);
  // The clone-room form is its own overlay (⌘N / the "clone room…" command open it),
  // not a sub-mode of the command palette — so Esc closes it outright instead of
  // dropping you into an action menu you never opened.
  const [showCloneRoom, setShowCloneRoom] = useState(false);
  const [, setThemeTick] = useState(0);
  const [activity, setActivity] = useState<Record<string, RoomActivity>>({});
  // When a room was last "seen" — attention older than this is acknowledged.
  const ackRef = useRef<Record<string, number>>({});
  // Sidebar collapse: railPref is the persisted user intent; forcedMini is a
  // transient width override that never mutates intent (see toggleRail/effects).
  const [railPref, setRailPref] = useState<'full' | 'mini'>(() => {
    try { return localStorage.getItem('devrooms.rail') === 'mini' ? 'mini' : 'full'; } catch { return 'full'; }
  });
  const [forcedMini, setForcedMini] = useState(() => window.matchMedia('(max-width: 720px)').matches);

  // Re-render (status bar theme readout) whenever a theme is committed or the
  // system light/dark setting flips while on "system".
  useEffect(() => subscribe(() => setThemeTick((tick) => tick + 1)), []);

  // ⌘P / ⌘K toggles the palette (Ctrl on non-mac). Capture phase so it wins over
  // xterm and the browser print shortcut. The modifier is gated by platform so
  // Ctrl+P/Ctrl+K stay free for readline/emacs editing inside the terminal on
  // macOS. event.code (physical key) keeps it working under Caps Lock / Shift.
  useEffect(() => {
    const isMac = window.devrooms?.platform === 'darwin' || /Mac/i.test(navigator.platform);
    const onKey = (event: KeyboardEvent) => {
      const mod = isMac ? event.metaKey : event.ctrlKey;
      if (mod && !event.altKey && (event.code === 'KeyP' || event.code === 'KeyK')) {
        event.preventDefault();
        event.stopPropagation();
        // A confirm popup is modal: swallow the toggle so ⌘P/⌘K can't pop the palette
        // over it and steal its keyboard (the native confirm it replaced blocked the
        // event loop entirely). The palette's own ⌘P-to-close still works.
        if (document.querySelector('.cmd-confirm')) return;
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const selectedProject = useMemo(() => projects.find((project) => project.id === selectedProjectId) ?? projects[0], [projects, selectedProjectId]);
  const selectedRoom = useMemo(() => rooms.find((room) => room.id === selectedRoomId), [rooms, selectedRoomId]);
  // The branch a new clone defaults to: the source repo's current checkout, read off
  // the project's main room (which mirrors the working copy's live branch). Only when
  // cloning from that local copy (repoUrl === rootPath) is that branch guaranteed to
  // exist; a separately-configured remote may not have it, so leave the field blank
  // there and let the server fall back to the repo default.
  const projectCurrentBranch = useMemo(() => {
    if (!selectedProject || selectedProject.repoUrl !== selectedProject.rootPath) return '';
    return rooms.find((room) => room.projectId === selectedProject.id && room.kind === 'main')?.branch ?? '';
  }, [rooms, selectedProject]);
  // A ready room of the selected project whose git the new-room picker can read the
  // branch list from (every clone shares the repo's branches). Prefer the main repo.
  const branchSourceRoomId = useMemo(() => {
    if (!selectedProject) return undefined;
    const inProject = rooms.filter((room) => room.projectId === selectedProject.id && room.status === 'idle');
    return (inProject.find((room) => room.kind === 'main') ?? inProject[0])?.id;
  }, [rooms, selectedProject]);
  // Git state for the selected (ready) room — drives the branch toolbar in the
  // workspace header and the git panel below it from one shared source.
  const git = useGitRoom(selectedRoom?.status === 'idle' ? selectedRoom : null);
  const runningCount = roomProcesses.filter((proc) => proc.status === 'running').length;

  // Effective collapse = user intent OR a too-narrow viewport. The width override
  // is never written back to railPref, so widening restores the saved intent.
  const miniRail = forcedMini || railPref === 'mini';
  // Single toggle for both the button and the Cmd/Ctrl+B shortcut. While the
  // viewport forces mini, the toggle is inert so it never mutates saved intent.
  const toggleRail = useCallback(() => {
    if (forcedMini) return;
    const next = railPref === 'mini' ? 'full' : 'mini';
    try { localStorage.setItem('devrooms.rail', next); } catch { /* storage may be unavailable */ }
    setRailPref(next);
    // Collapsing while a rail control holds focus would otherwise keep the
    // sidebar peeked open (focus); drop focus so the collapse is honored at once.
    if (next === 'mini') (document.activeElement as HTMLElement | null)?.blur?.();
  }, [railPref, forcedMini]);
  function expandRail() {
    try { localStorage.setItem('devrooms.rail', 'full'); } catch { /* storage may be unavailable */ }
    setRailPref('full');
  }
  const isMac = IS_MAC, MOD = MOD_KEY, MODSHIFT = MOD_SHIFT, KDEL = MOD_DEL;
  const shortcutHint = `${MOD}B`;

  async function refresh() {
    const [projectData, presetData, metaData] = await Promise.all([
      api<{ processCounts: ProcessCounts; projects: Project[]; rooms: Room[] }>('/api/projects'),
      api<{ presets: AgentPreset[] }>('/api/presets'),
      api<Meta>('/api/meta'),
    ]);
    setProjects(projectData.projects); setRooms(projectData.rooms); setProcessCounts(projectData.processCounts ?? {}); setPresets(presetData.presets); setMeta(metaData);
    // Reconcile the terminal cache against the live rooms: dispose any resource whose
    // room is gone (covers deletes from another window and any path that didn't tidy up
    // explicitly), so a recreated same-id room never reattaches a dead terminal.
    const liveRoomIds = new Set(projectData.rooms.map((room) => room.id));
    for (const key of [...(window.__DEVROOMS_TERMINALS__?.keys() ?? [])]) {
      const match = /^room:([^:]+)/.exec(key);
      if (match && !liveRoomIds.has(match[1])) disposeTerminalResource(key);
    }
    if (!selectedProjectId && projectData.projects[0]) setSelectedProjectId(projectData.projects[0].id);
    if (!selectedRoomId && projectData.rooms[0]) setSelectedRoomId(projectData.rooms[0].id);
  }
  useEffect(() => { refresh().catch((err) => setError(err.message)); }, []);

  // Force the mini rail below 720px (browser only — Electron clamps to 980).
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 720px)');
    const onChange = () => setForcedMini(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // All app keyboard shortcuts run through one capture-phase listener (mounted once)
  // that delegates to a ref reassigned each render, so it always sees current state
  // without re-subscribing. The handler body is assigned below, after the actions it
  // calls are defined. See shortcutRef.current = … near the command list.
  const shortcutRef = useRef<(event: KeyboardEvent) => void>(() => {});
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => shortcutRef.current(event);
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  useEffect(() => {
    const timer = setInterval(() => refresh().catch(() => undefined), 5000);
    return () => clearInterval(timer);
  }, [selectedProjectId, selectedRoomId]);

  // Poll per-room agent activity for the sidebar attention indicator, and keep the
  // focused room acknowledged so it never flags attention while you're watching it.
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const data = await api<{ now: number; rooms: Record<string, RoomActivity> }>('/api/activity');
        if (!alive) return;
        if (selectedRoomId) ackRef.current[selectedRoomId] = Date.now();
        setActivity(data.rooms);
      } catch { /* host may be momentarily unreachable */ }
    };
    poll();
    const timer = setInterval(poll, 1200);
    return () => { alive = false; clearInterval(timer); };
  }, [selectedRoomId]);

  useEffect(() => { if (selectedRoomId) ackRef.current[selectedRoomId] = Date.now(); }, [selectedRoomId]);

  // Poll per-room git state for the sidebar icons (commits to pull/push, merge
  // conflict). Sparse map — only rooms with something to show. "behind" reflects
  // the last fetch; push/conflict are always live from local state.
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const data = await api<{ summary: GitSummaries }>('/api/git/summary');
        if (alive) setGitSummary(data.summary ?? {});
      } catch { /* host may be momentarily unreachable */ }
    };
    poll();
    const timer = setInterval(poll, 5000);
    // A git op in the panel fires this so the sidebar updates at once, not in ≤5s.
    window.addEventListener('devrooms:git', poll);
    return () => { alive = false; clearInterval(timer); window.removeEventListener('devrooms:git', poll); };
  }, []);

  async function refreshRoomProcesses(roomId: string) {
    const data = await api<{ processes: ManagedProcess[] }>(`/api/rooms/${roomId}/processes`);
    setRoomProcesses(data.processes);
  }

  useEffect(() => {
    if (!selectedRoom) { setRoomProcesses([]); return; }
    refreshRoomProcesses(selectedRoom.id).catch(() => undefined);
    const timer = setInterval(() => refreshRoomProcesses(selectedRoom.id).catch(() => undefined), 3000);
    return () => clearInterval(timer);
  }, [selectedRoom?.id]);

  async function pickProjectFolder() {
    const pick = window.devrooms?.pickDirectory;
    if (!pick) { setError('the folder picker is only available in the desktop app'); return; }
    const dir = await pick();
    if (!dir) return; // cancelled
    setBusy(true); setError(null);
    try {
      // The daemon resolves the folder to its git root and names the project
      // after that directory — no path or url is ever typed.
      const data = await api<{ project: Project }>('/api/projects', { method: 'POST', body: JSON.stringify({ rootPath: dir }) });
      setSelectedProjectId(data.project.id);
      await refresh();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }

  async function createRoom(branch?: string) {
    if (!selectedProject) return; // rooms are auto-named — the server derives the name from the branch
    setBusy(true); setError(null);
    try {
      const data = await api<{ room: Room }>(`/api/projects/${selectedProject.id}/rooms`, { method: 'POST', body: JSON.stringify({ branch: branch?.trim() || undefined }) });
      setSelectedRoomId(data.room.id);
      setShowCloneRoom(false);
      await refresh();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }

  async function deleteSelectedRoom() {
    if (!selectedRoom) return;
    const deleteFiles = selectedRoom.kind !== 'main';
    const really = await confirm({
      title: `Remove ${selectedRoom.name} from devrooms?`,
      detail: deleteFiles ? "Its cloned files will be deleted too — this can't be undone." : 'The main repo files will be left untouched.',
      confirmLabel: deleteFiles ? 'remove & delete files' : 'remove room',
      danger: true,
    });
    if (!really) return;
    setBusy(true); setError(null);
    try {
      await api(`/api/rooms/${selectedRoom.id}`, { method: 'DELETE', body: JSON.stringify({ deleteFiles }) });
      // Drop the room's cached xterm + socket so a same-name recreate (which slugs to
      // the same room id) starts from a clean terminal instead of the dead one.
      disposeRoomTerminals(selectedRoom.id);
      setSelectedRoomId(null);
      await refresh();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }

  async function addTerminal() {
    if (!selectedRoom) return;
    setBusy(true); setError(null);
    try {
      await api(`/api/rooms/${selectedRoom.id}/terminals`, { method: 'POST' });
      await refresh();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }

  async function closeTerminal(terminalId: string, force = false) {
    if (!selectedRoom) return;
    setError(null);
    try {
      const res = await api<{ ok: boolean; busy?: boolean; proc?: string }>(`/api/rooms/${selectedRoom.id}/terminals/${terminalId}${force ? '?force=1' : ''}`, { method: 'DELETE' });
      // The server refuses if the terminal is running something — confirm, then force.
      if (res.busy) {
        if (await confirm({ title: `“${res.proc}” is still running in this terminal.`, detail: 'Close it anyway?', confirmLabel: 'close terminal', danger: true })) await closeTerminal(terminalId, true);
        return;
      }
      disposeTerminalResource(`room:${selectedRoom.id}:${terminalId}`);
      await refresh();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  }

  const terminalCount = selectedRoom?.terminals?.length ?? 1;
  // A branch belongs to a room, not a project — only surface one when a room is
  // selected, so a stale project default branch never shows in the status bar.
  const branchLabel = selectedRoom?.branch ?? '';

  // App actions surfaced in the command palette (Theme + Appearance are added by
  // the palette itself). Rebuilt each render so the closures see current state.
  const commands: Command[] = [
    { id: 'go-terminal', title: 'go to terminal', hint: 'show the terminal tab', keywords: 'terminal shell view', shortcut: `${MOD}1`, perform: () => setTab('terminal') },
    { id: 'go-git', title: 'go to git', hint: 'show the git tab', keywords: 'git diff changes commit', shortcut: `${MOD}2`, perform: () => setTab('git') },
    { id: 'go-subagents', title: 'go to subagents', hint: 'show the subagents tab', keywords: 'agents processes hermes claude codex', shortcut: `${MOD}3`, perform: () => setTab('subagents') },
    { id: 'refresh', title: 'refresh', hint: 'reload projects and rooms', keywords: 'reload sync', perform: () => { void refresh(); } },
    {
      id: 'new-room', title: 'clone room…',
      hint: selectedProject ? `clone a room into ${selectedProject.name}` : 'clone a room into this project',
      keywords: 'clone create new room', shortcut: `${MOD}N`,
      perform: () => setShowCloneRoom(true),
    },
    { id: 'new-project', title: 'new project…', hint: 'pick a local repo folder', keywords: 'folder repo open add', shortcut: `${MODSHIFT}N`, perform: () => { void pickProjectFolder(); } },
    { id: 'toggle-sidebar', title: 'toggle sidebar', hint: 'show / hide the rooms rail', keywords: 'sidebar rail collapse expand', shortcut: `${MOD}B`, perform: () => toggleRail() },
  ];
  if (selectedRoom?.status === 'idle' && terminalCount < 6) {
    commands.splice(1, 0, { id: 'new-terminal', title: 'new terminal', hint: 'add a tiled terminal to this room', keywords: 'split pane add tiled', shortcut: `${MOD}T`, perform: () => { void addTerminal(); } });
  }
  if (selectedRoom?.status === 'idle') {
    commands.push({ id: 'git-sync', title: 'git: sync', hint: 'fetch / pull / push (whatever this room needs)', keywords: 'fetch pull push sync git', shortcut: `${MOD}S`, perform: () => { void git.doOp(git.syncOp); } });
    commands.push({ id: 'git-branch', title: 'git: branch…', hint: 'switch, merge, or create a branch', keywords: 'branch switch checkout merge create', shortcut: `${MODSHIFT}B`, perform: () => window.dispatchEvent(new Event('devrooms:branch-menu')) });
  }
  if (selectedRoom) {
    commands.push({ id: 'delete-room', title: 'delete current room', hint: selectedRoom.name, keywords: 'remove destroy', shortcut: KDEL, perform: () => { void deleteSelectedRoom(); } });
  }
  // Every room is searchable in the palette: ⌘P → type a room/project name → switch.
  for (const room of rooms) {
    const proj = projects.find((p) => p.id === room.projectId);
    commands.push({
      id: `switch-room:${room.id}`,
      title: room.label ?? room.name,
      hint: proj ? `${proj.name}${room.kind === 'main' ? ' · main' : ''}` : (room.kind === 'main' ? 'main' : 'room'),
      keywords: `room go switch open ${room.name} ${room.label ?? ''} ${proj?.name ?? ''}`,
      checked: room.id === selectedRoomId,
      perform: () => { setSelectedRoomId(room.id); setSelectedProjectId(room.projectId); },
    });
  }

  // Assign the global shortcut handler (mounted once above). ⌘ on macOS works even
  // with the terminal focused; Ctrl on win/linux is left alone inside text fields so
  // it still reaches the terminal. The palette / branch menu own the keyboard when open.
  // Note: ⌘R is deliberately NOT bound — Electron's default menu owns it (window reload).
  shortcutRef.current = (event) => {
    const mod = isMac ? event.metaKey : event.ctrlKey;
    if (!mod || event.altKey) return;
    if (document.querySelector('.cmd-overlay')) return;
    const target = event.target as HTMLElement | null;
    const inText = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || !!target.isContentEditable);
    // The terminal's hidden textarea (xterm-helper-textarea) isn't a real edit field
    // and never receives ⌘ combos as input — so for shortcuts like ⌘⌫ (which would
    // otherwise be suppressed wherever a textarea is focused, i.e. almost always),
    // treat only genuine inputs as "text".
    const inRealInput = !!target && (target.tagName === 'INPUT' || (target.tagName === 'TEXTAREA' && !target.classList.contains('xterm-helper-textarea')) || !!target.isContentEditable);
    if (!isMac && inText) return;
    const shift = event.shiftKey;
    const hit = (fn: () => void) => { event.preventDefault(); event.stopPropagation(); fn(); };
    switch (event.code) {
      case 'Digit1': return hit(() => setTab('terminal'));
      case 'Digit2': return hit(() => setTab('git'));
      case 'Digit3': return hit(() => setTab('subagents'));
      case 'KeyB': return hit(() => { if (shift) window.dispatchEvent(new Event('devrooms:branch-menu')); else toggleRail(); });
      case 'KeyN': return hit(() => { if (shift) { void pickProjectFolder(); } else { setShowCloneRoom(true); } });
      case 'KeyT': if (!shift && selectedRoom?.status === 'idle' && terminalCount < 6) return hit(() => { setTab('terminal'); void addTerminal(); }); return;
      case 'KeyS': if (!shift && selectedRoom?.status === 'idle' && !git.merging) return hit(() => { void git.doOp(git.syncOp); }); return;
      case 'KeyW': {
        if (shift) return;
        // Close the focused terminal tile (the main one is the room's shell, not
        // closeable). closeTerminal guards against killing something that's running.
        const tid = (document.activeElement as HTMLElement | null)?.closest('[data-terminal]')?.getAttribute('data-terminal');
        if (tid && tid !== 'main') return hit(() => { void closeTerminal(tid); });
        return;
      }
    }
    if ((event.key === 'Backspace' || event.key === 'Delete') && !shift && !inRealInput && selectedRoom) hit(() => { void deleteSelectedRoom(); });
  };

  const activeTheme = resolveTheme(getConfig());

  return (
    <div className="app">
      <div className="titlebar">
        <span className="tb-left">
          {window.devrooms && (
            <span className="traffic">
              <button className="tl close" title="close" onClick={() => window.devrooms?.windowControl('close')} />
              <button className="tl min" title="minimize" onClick={() => window.devrooms?.windowControl('minimize')} />
              <button className="tl full" title="fullscreen" onClick={() => window.devrooms?.windowControl('fullscreen')} />
            </span>
          )}
          <span className="name">devrooms</span>
        </span>
        <span className="meta">
          <button className="palette-hint" onClick={() => setPaletteOpen(true)} title="command palette">{window.devrooms?.platform === 'darwin' ? '⌘' : 'ctrl'} p</button>
          <span><span className={meta ? 'dot' : 'dot off'} />{meta ? 'daemon' : 'no daemon'}</span>
          {meta && <span className="ver">v{meta.version}</span>}
        </span>
      </div>

      <div className="split" data-rail={miniRail ? 'mini' : 'full'}>
        <aside className="sidebar">
          <div className="rule">rooms<span className="count">{rooms.length}</span>
            <button
              className="rail-toggle"
              disabled={forcedMini}
              aria-label={miniRail ? 'expand sidebar' : 'collapse sidebar'}
              aria-expanded={!miniRail}
              title={forcedMini ? 'widen the window to pin the sidebar open' : miniRail ? `expand sidebar (${shortcutHint})` : `collapse sidebar (${shortcutHint})`}
              onClick={toggleRail}
            />
          </div>
          {projects.length ? (
            <div className="tree">
              {projects.map((project) => {
                const projectRooms = rooms.filter((room) => room.projectId === project.id);
                return (
                  <Fragment key={project.id}>
                    <button className={selectedProject?.id === project.id ? 'node project-node proj-active' : 'node project-node'} aria-label={project.name} title={project.name} onClick={() => setSelectedProjectId(project.id)}>
                      <span className="pname">{project.name}</span>
                      <span className="mark" aria-hidden="true">{projectInitials(project.name)}</span>
                    </button>
                    {projectRooms.map((room, index) => {
                      const last = index === projectRooms.length - 1;
                      const pc = processCounts[room.id];
                      const procLabel = compactProc(pc);
                      const mark = room.kind === 'main' ? room.name.charAt(0).toUpperCase() : room.name.charAt(0).toLowerCase();
                      // Lead with the derived activity label; the typed name stays the
                      // stable handle (shown muted alongside, and in the tooltip).
                      const display = room.label ?? room.name;
                      const gs = gitSummary[room.id];
                      const gitLabel = gs ? [gs.conflict ? 'merge conflict' : '', gs.dirty ? `${gs.dirty} uncommitted` : '', gs.behind ? `${gs.behind} to pull` : '', gs.unpushed ? `${gs.unpushed} to push` : ''].filter(Boolean).join(' · ') : '';
                      const meta = `${room.branch ? room.branch + ' · ' : ''}${room.kind ?? 'clone'} · ${room.status}${procLabel ? ' · ' + procLabel : ''}${gitLabel ? ' · ' + gitLabel : ''}`;
                      return (
                        <button
                          key={room.id}
                          className={selectedRoom?.id === room.id ? 'node room-node row-sel' : 'node room-node'}
                          aria-label={`${display}${room.label ? ` (${room.name})` : ''} · ${meta}`}
                          title={`${display}${room.label ? ` (${room.name})` : ''} · ${meta}`}
                          data-proc={pc?.running ? 'run' : pc?.lost ? 'lost' : undefined}
                          onClick={() => { setSelectedRoomId(room.id); setSelectedProjectId(room.projectId); }}
                        >
                          <span className="conn" aria-hidden="true">{last ? '└' : '├'}</span>
                          {room.status === 'idle'
                            ? <AgentGlyph state={deriveRoomState(activity[room.id], ackRef.current[room.id] ?? 0)} />
                            : <span className={`glyph ${room.status}`} aria-hidden="true">{STATUS_GLYPH[room.status]}</span>}
                          <span className="rbody">
                            <span className="rtop">
                              <span className="rname">{display}</span>
                              {gs && (gs.conflict || gs.dirty > 0 || gs.behind > 0 || gs.unpushed > 0) && (
                                <span className="gitstate" aria-hidden="true">
                                  {gs.conflict && <span className="gs-conflict" title="merge conflict">!</span>}
                                  {gs.dirty > 0 && <span className="gs-dirty" title={`${gs.dirty} uncommitted change${gs.dirty === 1 ? '' : 's'}`}>±{gs.dirty}</span>}
                                  {gs.behind > 0 && <span className="gs-pull" title={`${gs.behind} to pull`}>↓{gs.behind}</span>}
                                  {gs.unpushed > 0 && <span className="gs-push" title={`${gs.unpushed} to push`}>↑{gs.unpushed}</span>}
                                </span>
                              )}
                              {procLabel && <span className="count2">{procLabel}</span>}
                            </span>
                            <span className="rsub">
                              <span className="rbranch">{room.branch || 'main'}</span>
                              {room.kind !== 'main' && <span className="kind">clone</span>}
                            </span>
                          </span>
                          <span className="mark" aria-hidden="true">{mark}</span>
                        </button>
                      );
                    })}
                  </Fragment>
                );
              })}
            </div>
          ) : <div className="empty">no projects yet — hit + project</div>}

          <div className="addbar">
            <button title={`new room (${MOD_KEY}N)`} disabled={!selectedProject} onClick={() => { if (miniRail && !forcedMini) expandRail(); setShowCloneRoom(true); }}>+ room<span className="kbd-hint">{MOD_KEY}N</span></button>
            <button title={`add project from folder (${MOD_SHIFT}N)`} disabled={busy} onClick={pickProjectFolder}>+ project<span className="kbd-hint">{MOD_SHIFT}N</span></button>
          </div>
        </aside>

        <section className="ws">
          <div className="ws-head">
            <div className="ws-title">
              <span className="rname">{selectedRoom ? (selectedRoom.label ?? selectedRoom.name) : 'no room selected'}</span>
              <span className="rpath">{selectedRoom ? shortPath(selectedRoom.path) : 'create a project or clone a room to begin'}</span>
            </div>
            <div className="tabs">
              <button className={tab === 'terminal' ? 'tab active' : 'tab'} onClick={() => setTab('terminal')} title={`terminal (${MOD_KEY}1)`}>terminal<span className="kbd-hint">{MOD_KEY}1</span></button>
              <button className={tab === 'git' ? 'tab active' : 'tab'} onClick={() => setTab('git')} title={`git (${MOD_KEY}2)`}>git<span className="kbd-hint">{MOD_KEY}2</span></button>
              <button className={tab === 'subagents' ? 'tab active' : 'tab'} onClick={() => setTab('subagents')} title={`subagents (${MOD_KEY}3)`}>subagents<span className="kbd-hint">{MOD_KEY}3</span></button>
              {selectedRoom?.status === 'idle' && <GitBar git={git} />}
              <span className="spacer" />
              <span className="tab-actions">
                {tab === 'terminal' && selectedRoom?.status === 'idle' && (
                  <button onClick={addTerminal} disabled={busy || terminalCount >= 6} title={`add a tiled terminal (${MOD_KEY}T)`}>+ term<span className="kbd-hint">{MOD_KEY}T</span></button>
                )}
                {selectedRoom && <button className="danger" onClick={deleteSelectedRoom} title={`delete this room (${MOD_DEL})`}>delete<span className="kbd-hint">{MOD_DEL}</span></button>}
              </span>
            </div>
          </div>
          {selectedRoom?.status === 'idle' && <GitFeedback git={git} />}

          {error && <div className="error">{error}</div>}
          {!selectedRoom && <div className="splash"><strong>no room selected</strong><span>create a project from a local repo for a main room, or clone a separate room</span></div>}
          {selectedRoom && selectedRoom.status !== 'idle' && (
            <div className={`splash room-state ${selectedRoom.status}`}>
              <strong>{selectedRoom.status === 'creating' ? 'cloning room…' : 'room clone failed'}</strong>
              <span>{selectedRoom.status === 'creating' ? 'cloning in the background — this view refreshes automatically' : selectedRoom.error}</span>
              <button className="retry" onClick={() => refresh()}>refresh now</button>
            </div>
          )}
          {selectedRoom?.status === 'idle' && (
            <div className="body">
              {tab === 'terminal' && <RoomTerminals room={selectedRoom} onClose={closeTerminal} />}
              {tab === 'git' && <GitPanel room={selectedRoom} git={git} />}
              {tab === 'subagents' && <SubagentsPanel room={selectedRoom} presets={presets} />}
            </div>
          )}
        </section>
      </div>

      <div className="statusbar">
        <span className="brand">devrooms</span>
        {selectedRoom && <span className="seg">{selectedProject?.name}<span className="arrow">{'›'}</span><span className="b">{selectedRoom.name}</span></span>}
        {branchLabel && <span className="seg">{branchLabel}</span>}
        <span className="seg">{'⏵'} {runningCount}/{roomProcesses.length} proc</span>
        <span className="spacer" />
        <button className="seg theme-seg" onClick={() => setPaletteOpen(true)} title="change theme (⌘p)"><span className="theme-chip" style={{ background: activeTheme.ui.cyan }} />{activeTheme.name.toLowerCase()}</button>
        {meta && <span className="seg">{meta.bindHost}:{meta.port}</span>}
        {meta && <span className="seg">up {formatUptime(meta.uptimeSeconds)}</span>}
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={commands} />
      <NewRoomDialog
        open={showCloneRoom}
        onClose={() => setShowCloneRoom(false)}
        projectName={selectedProject?.name}
        defaultBranch={projectCurrentBranch}
        branchSourceRoomId={branchSourceRoomId}
        disabled={!selectedProject}
        onClone={(branch) => { void createRoom(branch); }}
      />
    </div>
  );
}

