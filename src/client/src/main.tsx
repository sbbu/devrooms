import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import './styles.css';

type Project = { id: string; name: string; repoUrl: string; defaultBranch: string };
type Room = { id: string; projectId: string; name: string; path: string; branch?: string; status: 'creating' | 'idle' | 'error'; error?: string };
type GitFile = { index: string; workingTree: string; path: string; raw: string };
type GitStatus = { status: { branch: string; files: GitFile[]; raw: string }; branches: string[]; head: string };
type ManagedProcess = { id: string; roomId: string; name: string; command: string; status: 'running' | 'exited'; startedAt: string; exitCode?: number; logTail: string };

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

function TerminalPane({ roomId, processId }: { roomId?: string; processId?: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!hostRef.current || (!roomId && !processId)) return;
    const term = new Terminal({ cursorBlink: true, convertEol: true, fontFamily: 'JetBrains Mono, SFMono-Regular, Menlo, monospace', fontSize: 13, theme: { background: '#0b0d12', foreground: '#d6deff' } });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    term.focus();
    fit.fit();
    const socket = new WebSocket(wsUrl(processId ? `/ws/processes/${processId}` : `/ws/rooms/${roomId}/terminal`));
    socket.addEventListener('open', () => {
      fit.fit();
      socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    });
    socket.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data as string) as { type: string; data: string };
      if (msg.type === 'output') term.write(msg.data);
    });
    socket.addEventListener('close', () => term.writeln('\r\n[devrooms disconnected]'));
    const disposable = term.onData((data) => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ type: 'input', data })));
    const onResize = () => {
      fit.fit();
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      disposable.dispose();
      socket.close();
      term.dispose();
    };
  }, [roomId, processId]);

  return <div className="terminal" ref={hostRef} />;
}

function GitPanel({ room }: { room: Room }) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [diff, setDiff] = useState('');
  const [log, setLog] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setError(null);
    const next = await api<GitStatus>(`/api/rooms/${room.id}/git/status`);
    setStatus(next);
    if (!selected && next.status.files[0]) setSelected(next.status.files[0].path);
  }

  useEffect(() => { refresh().catch((err) => setError(err.message)); }, [room.id]);

  useEffect(() => {
    if (!selected) { setDiff(''); return; }
    api<{ diff: string; stagedDiff: string }>(`/api/rooms/${room.id}/git/diff?path=${encodeURIComponent(selected)}`)
      .then((data) => setDiff(data.diff || data.stagedDiff || 'no diff'))
      .catch((err) => setDiff(err.message));
  }, [room.id, selected]);

  async function gitOp(op: string, body?: unknown) {
    setError(null);
    const result = await api<{ stdout: string; stderr: string }>(`/api/rooms/${room.id}/git/${op}`, { method: 'POST', body: JSON.stringify(body ?? {}) });
    setLog([result.stdout, result.stderr].filter(Boolean).join('\n') || `${op} ok`);
    await refresh();
  }

  return (
    <div className="git-panel">
      <div className="toolbar">
        <button onClick={() => refresh()}>refresh</button><button onClick={() => gitOp('fetch')}>fetch</button><button onClick={() => gitOp('pull')}>pull</button><button onClick={() => gitOp('push')}>push</button>
        <select value={status?.status.branch.split('...')[0] ?? ''} onChange={(event) => event.target.value && gitOp('checkout', { branch: event.target.value })}>
          <option value="">branch</option>{status?.branches.map((branch) => <option key={branch} value={branch}>{branch}</option>)}
        </select>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="git-meta">{status ? `${status.status.branch} · ${status.head}` : 'loading git status'}</div>
      <div className="git-layout">
        <div className="files">
          {status?.status.files.length ? status.status.files.map((file) => (
            <button className={selected === file.path ? 'file selected' : 'file'} key={file.path} onClick={() => setSelected(file.path)}><span className="badge">{file.index}{file.workingTree}</span>{file.path}</button>
          )) : <div className="empty">clean</div>}
        </div>
        <div className="diff"><div className="diff-actions">{selected && <button onClick={() => gitOp('stage', { path: selected })}>stage</button>}{selected && <button onClick={() => gitOp('unstage', { path: selected })}>unstage</button>}</div><pre>{diff}</pre></div>
      </div>
      {log && <pre className="op-log">{log}</pre>}
    </div>
  );
}

function SubagentsPanel({ room }: { room: Room }) {
  const [processes, setProcesses] = useState<ManagedProcess[]>([]);
  const [command, setCommand] = useState('echo hello from devrooms && git status --short && sleep 2');
  const [attached, setAttached] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    const data = await api<{ processes: ManagedProcess[] }>(`/api/rooms/${room.id}/processes`);
    setProcesses(data.processes);
  }
  useEffect(() => { refresh().catch((err) => setError(err.message)); const timer = setInterval(() => refresh().catch(() => undefined), 3000); return () => clearInterval(timer); }, [room.id]);
  async function start() {
    setError(null);
    const data = await api<{ process: ManagedProcess }>(`/api/rooms/${room.id}/processes`, { method: 'POST', body: JSON.stringify({ command, name: command.split(/\s+/).slice(0, 4).join(' ') }) });
    setAttached(data.process.id);
    await refresh();
  }
  async function kill(processId: string) { await api(`/api/processes/${processId}`, { method: 'DELETE' }); await refresh(); }

  return <div className="subagents"><div className="launcher"><input value={command} onChange={(event) => setCommand(event.target.value)} /><button onClick={start}>start process</button><button onClick={refresh}>refresh</button></div>{error && <div className="error">{error}</div>}<div className="process-list">{processes.map((proc) => <div className={attached === proc.id ? 'process selected' : 'process'} key={proc.id}><button onClick={() => setAttached(proc.id)}>attach</button><button onClick={() => kill(proc.id)}>kill</button><strong>{proc.name}</strong><span>{proc.status}{proc.exitCode !== undefined ? `:${proc.exitCode}` : ''}</span></div>)}</div>{attached ? <TerminalPane processId={attached} /> : <pre className="hint">start or attach a process to view its terminal</pre>}</div>;
}

function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [tab, setTab] = useState<'terminal' | 'git' | 'subagents'>('terminal');
  const [projectName, setProjectName] = useState('Scatter');
  const [repoUrl, setRepoUrl] = useState('git@github.com:guminc/scatter.git');
  const [roomName, setRoomName] = useState('room-a');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedProject = useMemo(() => projects.find((project) => project.id === selectedProjectId) ?? projects[0], [projects, selectedProjectId]);
  const projectRooms = useMemo(() => rooms.filter((room) => room.projectId === selectedProject?.id), [rooms, selectedProject]);
  const selectedRoom = useMemo(() => rooms.find((room) => room.id === selectedRoomId) ?? projectRooms[0], [rooms, selectedRoomId, projectRooms]);

  async function refresh() {
    const data = await api<{ projects: Project[]; rooms: Room[] }>('/api/projects');
    setProjects(data.projects); setRooms(data.rooms);
    if (!selectedProjectId && data.projects[0]) setSelectedProjectId(data.projects[0].id);
    if (!selectedRoomId && data.rooms[0]) setSelectedRoomId(data.rooms[0].id);
  }
  useEffect(() => { refresh().catch((err) => setError(err.message)); }, []);
  async function createProject() { setBusy(true); setError(null); try { const data = await api<{ project: Project }>('/api/projects', { method: 'POST', body: JSON.stringify({ name: projectName, repoUrl }) }); setSelectedProjectId(data.project.id); await refresh(); } catch (err) { setError(err instanceof Error ? err.message : String(err)); } finally { setBusy(false); } }
  async function createRoom() { if (!selectedProject) return; setBusy(true); setError(null); try { const data = await api<{ room: Room }>(`/api/projects/${selectedProject.id}/rooms`, { method: 'POST', body: JSON.stringify({ name: roomName }) }); setSelectedRoomId(data.room.id); await refresh(); } catch (err) { setError(err instanceof Error ? err.message : String(err)); } finally { setBusy(false); } }

  return <main><aside><div className="brand">devrooms</div><section><h2>projects</h2>{projects.map((project) => <button className={selectedProject?.id === project.id ? 'nav active' : 'nav'} key={project.id} onClick={() => setSelectedProjectId(project.id)}>{project.name}</button>)}<input value={projectName} onChange={(event) => setProjectName(event.target.value)} placeholder="project name" /><input value={repoUrl} onChange={(event) => setRepoUrl(event.target.value)} placeholder="git repo url" /><button disabled={busy} onClick={createProject}>save project</button></section><section><h2>rooms</h2>{projectRooms.map((room) => <button className={selectedRoom?.id === room.id ? 'nav active' : 'nav'} key={room.id} onClick={() => setSelectedRoomId(room.id)}>{room.name} <span>{room.status}</span></button>)}<input value={roomName} onChange={(event) => setRoomName(event.target.value)} placeholder="room name" /><button disabled={busy || !selectedProject} onClick={createRoom}>clone room</button></section></aside><section className="workspace"><header><div><h1>{selectedRoom ? selectedRoom.name : 'no room selected'}</h1><p>{selectedRoom?.path ?? 'create a project and clone a room'}</p></div><nav><button className={tab === 'terminal' ? 'active' : ''} onClick={() => setTab('terminal')}>terminal</button><button className={tab === 'git' ? 'active' : ''} onClick={() => setTab('git')}>git</button><button className={tab === 'subagents' ? 'active' : ''} onClick={() => setTab('subagents')}>subagents</button><button onClick={() => refresh()}>refresh</button></nav></header>{error && <div className="error">{error}</div>}{!selectedRoom && <div className="empty splash">create a room to open a terminal</div>}{selectedRoom && tab === 'terminal' && <TerminalPane roomId={selectedRoom.id} />}{selectedRoom && tab === 'git' && <GitPanel room={selectedRoom} />}{selectedRoom && tab === 'subagents' && <SubagentsPanel room={selectedRoom} />}</section></main>;
}

createRoot(document.getElementById('root')!).render(<App />);
