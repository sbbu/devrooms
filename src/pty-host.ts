// Standalone PTY host.
//
// Owns every terminal/agent PTY in its own long-lived process so they survive
// API-daemon restarts. In dev the daemon runs under `tsx watch`, which SIGTERMs
// and respawns the daemon on every server-code edit; if the PTYs lived there
// they'd die with it. Here the daemon only sends lifecycle commands over HTTP,
// and terminal I/O streams over this host's own WebSocket, so a daemon restart
// never drops a live terminal.
import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import pty from '@homebridge/node-pty-prebuilt-multiarch';

// Port comes from a CLI flag (--port N), not an env var: the daemon places the
// host at <daemon port> + 1. Defaults to 4318 for a standalone run.
const portFlag = process.argv.indexOf('--port');
const PORT = portFlag >= 0 ? Number(process.argv[portFlag + 1]) : 4318;
const HOST = '127.0.0.1';

type AgentState = 'working' | 'needs-input' | 'done';

type Session = {
  key: string;
  pty: pty.IPty;
  log: string[];
  status: 'running' | 'exited';
  exitCode?: number;
  exitedAt?: string;
  cols: number;
  rows: number;
  shell: string;               // basename of the spawn shell, to tell "idle shell" from "running something"
  // Activity tracking for the sidebar "needs attention vs thinking" indicator.
  lastOutputMs: number;        // wall-clock of the most recent output byte
  attentionMs: number;         // last generic notification (OSC 9 / OSC 777)
  agentState?: AgentState;     // last explicit state from an agent hook (private OSC)
  agentStateMs: number;        // wall-clock of that explicit state
  scanCarry: string;           // tail of the last chunk, so markers split across chunks still match
};

// key: "room:<roomId>" | "proc:<processId>"
const sessions = new Map<string, Session>();

function appendLog(log: string[], data: string) {
  log.push(data);
  if (log.length > 5000) log.splice(0, log.length - 5000);
}

// Derive activity from the raw output stream. Agents announce state three ways:
//  - private OSC 9279;<state> emitted by the hooks devrooms installs (precise)
//  - generic desktop-notification escapes OSC 9 / OSC 777 (e.g. codex osc9 mode)
//  - simply producing output (=> thinking). Raw BEL is ignored: shells ring it on
//    every failed tab-completion, so it is far too noisy to mean "attention".
const STATE_RE = /\x1b\]9279;(working|needs-input|done)(?:\x07|\x1b\\)/g;
const NOTIFY_RE = /\x1b\]9;[^\x07\x1b]|\x1b\]777;/;

function scanActivity(session: Session, data: string) {
  session.lastOutputMs = Date.now();
  const buf = session.scanCarry + data;
  let match: RegExpExecArray | null;
  let lastState: AgentState | undefined;
  STATE_RE.lastIndex = 0;
  while ((match = STATE_RE.exec(buf))) lastState = match[1] as AgentState;
  if (lastState) { session.agentState = lastState; session.agentStateMs = Date.now(); }
  if (NOTIFY_RE.test(buf)) session.attentionMs = Date.now();
  session.scanCarry = data.slice(-48);
}

function logTail(log: string[], maxChars = 4000) {
  return log.join('').slice(-maxChars);
}

function spawnSession(key: string, args: string[], opts: { cwd: string; env: Record<string, string>; cols?: number; rows?: number }) {
  const existing = sessions.get(key);
  if (existing && existing.status === 'running') return existing;
  if (existing) sessions.delete(key);
  const cols = opts.cols ?? 120;
  const rows = opts.rows ?? 36;
  const shell = opts.env.SHELL || process.env.SHELL || '/bin/zsh';
  const child = pty.spawn(shell, args, { name: 'xterm-256color', cols, rows, cwd: opts.cwd, env: opts.env });
  const session: Session = { key, pty: child, log: [], status: 'running', cols, rows, shell: shell.split('/').pop() || shell, lastOutputMs: Date.now(), attentionMs: 0, agentStateMs: 0, scanCarry: '' };
  child.onData((data) => { appendLog(session.log, data); scanActivity(session, data); });
  child.onExit(({ exitCode }) => {
    session.status = 'exited';
    session.exitCode = exitCode;
    session.exitedAt = new Date().toISOString();
    appendLog(session.log, `\r\n[devrooms session exited: ${exitCode}]\r\n`);
  });
  sessions.set(key, session);
  return session;
}

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

function sendJson(res: http.ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname;
  try {
    if (req.method === 'GET' && path === '/health') {
      const running = [...sessions.values()].filter((s) => s.status === 'running').map((s) => s.key);
      return sendJson(res, 200, { ok: true, pid: process.pid, running });
    }
    if (req.method === 'GET' && path === '/activity') {
      const out: Record<string, { status: string; lastOutputMs: number; attentionMs: number; agentState?: AgentState; agentStateMs: number }> = {};
      for (const [key, s] of sessions) {
        out[key] = { status: s.status, lastOutputMs: s.lastOutputMs, attentionMs: s.attentionMs, agentState: s.agentState, agentStateMs: s.agentStateMs };
      }
      return sendJson(res, 200, { now: Date.now(), sessions: out });
    }
    if (req.method === 'POST' && path === '/spawn') {
      const body = await readBody(req);
      const key = typeof body.key === 'string' ? body.key : '';
      const cwd = typeof body.cwd === 'string' ? body.cwd : '';
      const env = (body.env && typeof body.env === 'object') ? body.env as Record<string, string> : null;
      if (!key || !cwd || !env) return sendJson(res, 400, { error: 'key, cwd and env are required' });
      const args = body.kind === 'process' ? ['-lc', String(body.command ?? '')] : [];
      const session = spawnSession(key, args, { cwd, env, cols: Number(body.cols) || undefined, rows: Number(body.rows) || undefined });
      return sendJson(res, 200, { ok: true, status: session.status });
    }
    if (req.method === 'POST' && path === '/kill') {
      const body = await readBody(req);
      const key = typeof body.key === 'string' ? body.key : '';
      // Default to an unconditional kill (room delete, subagent stop). Only an explicit
      // force:false opts into the "busy?" guard used by the terminal-close UX: refuse
      // if the tty's foreground process isn't just the idle shell.
      const force = body.force !== false;
      const session = key ? sessions.get(key) : undefined;
      if (session && session.status === 'running' && !force) {
        const proc = (session.pty.process || '').replace(/^-/, ''); // login shells report as "-zsh"
        if (proc && proc !== session.shell) return sendJson(res, 200, { ok: false, busy: true, proc });
      }
      if (session) { if (session.status === 'running') session.pty.kill(); sessions.delete(key); }
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'GET' && path === '/session') {
      const key = url.searchParams.get('key') ?? '';
      const session = sessions.get(key);
      if (!session) return sendJson(res, 404, { error: 'no session' });
      const max = Number(url.searchParams.get('max') || 4000);
      return sendJson(res, 200, { status: session.status, exitCode: session.exitCode, exitedAt: session.exitedAt, logTail: logTail(session.log, max) });
    }
    return sendJson(res, 404, { error: 'not found' });
  } catch (error) {
    return sendJson(res, 500, { error: String(error) });
  }
});

const wss = new WebSocketServer({ noServer: true });

function wire(ws: WebSocket, session: Session, replay: string) {
  if (replay) ws.send(JSON.stringify({ type: 'output', data: replay }));
  // Coalesce every PTY chunk that arrives in the same event-loop tick into one WS frame.
  // A TUI redraw / chatty build emits a burst of small chunks; this collapses that burst's
  // O(chunks) JSON.stringify + frames + downstream JSON.parse to O(bursts). setImmediate
  // (not a ms timer) flushes on the very next tick, so interactive keystroke echo latency
  // is unchanged. Activity-scan + log-replay run on a SEPARATE pty.onData listener, so they
  // are unaffected by this batching.
  let pending = '';
  let scheduled = false;
  const flush = () => {
    scheduled = false;
    if (!pending) return;
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'output', data: pending }));
    pending = '';
  };
  const disposable = session.pty.onData((data) => {
    pending += data;
    if (!scheduled) { scheduled = true; setImmediate(flush); }
  });
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString()) as { type?: string; data?: string; cols?: number; rows?: number };
      if (msg.type === 'input' && typeof msg.data === 'string' && session.status === 'running') session.pty.write(msg.data);
      if (msg.type === 'resize' && msg.cols && msg.rows && session.status === 'running') {
        session.pty.resize(msg.cols, msg.rows);
        session.cols = msg.cols;
        session.rows = msg.rows;
      }
    } catch {
      /* ignore malformed frames */
    }
  });
  ws.on('close', () => { disposable.dispose(); pending = ''; });
}

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  // A room can hold several terminals. Key scheme: the "main" terminal keeps the
  // bare `room:<id>` key (so existing live sessions are untouched), extras are
  // `room:<id>:<terminalId>`.
  const room = url.pathname.match(/^\/ws\/rooms\/([^/]+)\/terminal$/);
  const roomTerm = url.pathname.match(/^\/ws\/rooms\/([^/]+)\/terminals\/([^/]+)$/);
  const proc = url.pathname.match(/^\/ws\/processes\/([^/]+)$/);
  const key = room
    ? `room:${room[1]}`
    : roomTerm
      ? (roomTerm[2] === 'main' ? `room:${roomTerm[1]}` : `room:${roomTerm[1]}:${roomTerm[2]}`)
      : proc
        ? `proc:${proc[1]}`
        : null;
  if (!key) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const session = sessions.get(key);
    const wantsReplay = url.searchParams.get('replay') !== '0';
    if (!session) {
      ws.send(JSON.stringify({ type: 'output', data: '\r\n[devrooms: no live session — reopen it]\r\n' }));
      ws.close();
      return;
    }
    wire(ws, session, wantsReplay ? logTail(session.log, 200_000) : '');
  });
});

server.listen(PORT, HOST, () => {
  console.log(`devrooms pty-host on http://${HOST}:${PORT} pid=${process.pid}`);
});

const shutdown = () => {
  // Note: we deliberately do NOT kill sessions here — the whole point is that
  // PTYs outlive restarts. The OS reaps them only when this host itself exits.
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
