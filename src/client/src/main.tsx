import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import './styles.css';

type Project = { id: string; name: string; repoUrl: string; defaultBranch: string };
type Room = { id: string; projectId: string; name: string; path: string; branch?: string; status: 'creating' | 'idle' | 'error'; error?: string };
type GitFile = { index: string; workingTree: string; path: string; raw: string; staged: boolean; dirty: boolean };
type GitStatus = { status: { branch: string; files: GitFile[]; raw: string; dirtyCount: number }; branches: string[]; head: string };
type ManagedProcess = { id: string; roomId: string; name: string; command: string; status: 'running' | 'exited' | 'lost'; startedAt: string; exitedAt?: string; exitCode?: number; logTail: string };
type AgentPreset = { id: string; label: string; description: string; command: string; available: boolean };

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

function fileStatusLabel(file: GitFile) {
  if (file.raw.startsWith('??')) return 'new';
  if (file.index.trim() && file.workingTree.trim()) return 'mixed';
  if (file.index.trim()) return 'staged';
  if (file.workingTree.trim()) return 'modified';
  return 'changed';
}

function TerminalPane({ roomId, processId }: { roomId?: string; processId?: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!hostRef.current || (!roomId && !processId)) return;
    const term = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: 'JetBrains Mono, SFMono-Regular, Menlo, ui-monospace, monospace',
      fontSize: 13,
      lineHeight: 1.18,
      theme: { background: '#090b10', foreground: '#d6deff', cursor: '#f4f7ff', selectionBackground: '#34415e' },
    });
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
    const observer = new ResizeObserver(onResize);
    observer.observe(hostRef.current);
    window.addEventListener('resize', onResize);
    return () => {
      observer.disconnect();
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
  const [stagedDiff, setStagedDiff] = useState('');
  const [commitMessage, setCommitMessage] = useState('');
  const [newBranch, setNewBranch] = useState('');
  const [log, setLog] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setError(null);
    const next = await api<GitStatus>(`/api/rooms/${room.id}/git/status`);
    setStatus(next);
    setSelected((current) => current && next.status.files.some((file) => file.path === current) ? current : next.status.files[0]?.path ?? null);
  }

  useEffect(() => { refresh().catch((err) => setError(err.message)); }, [room.id]);

  useEffect(() => {
    if (!selected) { setDiff(''); setStagedDiff(''); return; }
    api<{ diff: string; stagedDiff: string }>(`/api/rooms/${room.id}/git/diff?path=${encodeURIComponent(selected)}`)
      .then((data) => { setDiff(data.diff || ''); setStagedDiff(data.stagedDiff || ''); })
      .catch((err) => { setDiff(err.message); setStagedDiff(''); });
  }, [room.id, selected]);

  async function gitOp(op: string, body?: unknown) {
    setError(null);
    const result = await api<{ stdout: string; stderr: string }>(`/api/rooms/${room.id}/git/${op}`, { method: 'POST', body: JSON.stringify(body ?? {}) });
    setLog([result.stdout, result.stderr].filter(Boolean).join('\n') || `${op} ok`);
    await refresh();
  }

  return (
    <div className="git-panel panel-grid">
      <div className="panel-toolbar">
        <button onClick={() => refresh()}>refresh</button>
        <button onClick={() => gitOp('fetch')}>fetch</button>
        <button onClick={() => gitOp('pull')}>pull --ff-only</button>
        <button onClick={() => gitOp('push')}>push</button>
        <select value={status?.status.branch.split('...')[0] ?? ''} onChange={(event) => event.target.value && gitOp('checkout', { branch: event.target.value })}>
          <option value="">branch</option>{status?.branches.map((branch) => <option key={branch} value={branch}>{branch}</option>)}
        </select>
      </div>
      <div className="branch-create">
        <input value={newBranch} onChange={(event) => setNewBranch(event.target.value)} placeholder="new branch name" />
        <button disabled={!newBranch.trim()} onClick={() => gitOp('checkout-new', { branch: newBranch.trim() }).then(() => setNewBranch(''))}>create branch</button>
      </div>
      {error && <div className="error inline">{error}</div>}
      <div className="git-meta">
        <span>{status ? status.status.branch : 'loading branch'}</span>
        <span>{status?.head}</span>
        <span>{status ? `${status.status.dirtyCount} changed` : ''}</span>
      </div>
      <div className="git-layout">
        <div className="files">
          {status?.status.files.length ? status.status.files.map((file) => (
            <button className={selected === file.path ? 'file selected' : 'file'} key={file.path} onClick={() => setSelected(file.path)}>
              <span className={`file-state ${fileStatusLabel(file)}`}>{fileStatusLabel(file)}</span>
              <span className="file-path">{file.path}</span>
            </button>
          )) : <div className="empty clean">clean tree</div>}
        </div>
        <div className="diff">
          <div className="diff-actions">
            <strong>{selected ?? 'no file selected'}</strong>
            <span className="spacer" />
            {selected && <button onClick={() => gitOp('stage', { path: selected })}>stage</button>}
            {selected && <button onClick={() => gitOp('unstage', { path: selected })}>unstage</button>}
          </div>
          <div className="diff-scroll">
            {stagedDiff && <><div className="diff-label">staged</div><pre>{stagedDiff}</pre></>}
            {diff && <><div className="diff-label">working tree</div><pre>{diff}</pre></>}
            {!diff && !stagedDiff && <div className="empty">no diff for selected file</div>}
          </div>
        </div>
      </div>
      <div className="commit-row">
        <input value={commitMessage} onChange={(event) => setCommitMessage(event.target.value)} placeholder="commit message" />
        <button disabled={!commitMessage.trim()} onClick={() => gitOp('commit', { message: commitMessage.trim() }).then(() => setCommitMessage(''))}>commit staged</button>
      </div>
      {log && <pre className="op-log">{log}</pre>}
    </div>
  );
}

function SubagentsPanel({ room, presets }: { room: Room; presets: AgentPreset[] }) {
  const [processes, setProcesses] = useState<ManagedProcess[]>([]);
  const [command, setCommand] = useState('hermes chat --tui --accept-hooks --pass-session-id');
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
    <div className="subagents panel-grid">
      <div className="preset-grid">
        {presets.map((preset) => (
          <button key={preset.id} className={preset.available ? 'preset' : 'preset unavailable'} onClick={() => { setCommand(preset.command); setName(preset.label); }}>
            <strong>{preset.label}</strong>
            <span>{preset.available ? preset.command : `missing: ${preset.command}`}</span>
          </button>
        ))}
      </div>
      <div className="launcher">
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder="process name" />
        <input value={command} onChange={(event) => setCommand(event.target.value)} placeholder="command" />
        <button disabled={!command.trim()} onClick={start}>start</button>
        <button onClick={refresh}>refresh</button>
      </div>
      {error && <div className="error inline">{error}</div>}
      <div className="process-list">
        {processes.length ? processes.map((proc) => (
          <div className={attached === proc.id ? 'process selected' : 'process'} key={proc.id}>
            <button onClick={() => setAttached(proc.id)}>{proc.status === 'running' ? 'attach' : 'log'}</button>
            <button onClick={() => kill(proc.id)}>{proc.status === 'running' ? 'kill' : 'dismiss'}</button>
            <strong>{proc.name}</strong>
            <code>{proc.command}</code>
            <span className={`status ${proc.status}`}>{proc.status}{proc.exitCode !== undefined ? `:${proc.exitCode}` : ''}</span>
          </div>
        )) : <div className="empty">no room processes yet</div>}
      </div>
      <div className="attached-terminal">
        {attached ? <TerminalPane processId={attached} /> : <div className="hint">start or attach a process to view its terminal</div>}
      </div>
    </div>
  );
}

function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [presets, setPresets] = useState<AgentPreset[]>([]);
  const [roomProcesses, setRoomProcesses] = useState<ManagedProcess[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('terminal');
  const [projectName, setProjectName] = useState('Devrooms');
  const [repoUrl, setRepoUrl] = useState('https://github.com/sbbu/devrooms.git');
  const [defaultBranch, setDefaultBranch] = useState('main');
  const [roomName, setRoomName] = useState('room-a');
  const [roomBranch, setRoomBranch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedProject = useMemo(() => projects.find((project) => project.id === selectedProjectId) ?? projects[0], [projects, selectedProjectId]);
  const projectRooms = useMemo(() => rooms.filter((room) => room.projectId === selectedProject?.id), [rooms, selectedProject]);
  const selectedRoom = useMemo(() => rooms.find((room) => room.id === selectedRoomId) ?? projectRooms[0], [rooms, selectedRoomId, projectRooms]);
  const runningCount = roomProcesses.filter((proc) => proc.status === 'running').length;

  async function refresh() {
    const [projectData, presetData] = await Promise.all([
      api<{ projects: Project[]; rooms: Room[] }>('/api/projects'),
      api<{ presets: AgentPreset[] }>('/api/presets'),
    ]);
    setProjects(projectData.projects); setRooms(projectData.rooms); setPresets(presetData.presets);
    if (!selectedProjectId && projectData.projects[0]) setSelectedProjectId(projectData.projects[0].id);
    if (!selectedRoomId && projectData.rooms[0]) setSelectedRoomId(projectData.rooms[0].id);
  }
  useEffect(() => { refresh().catch((err) => setError(err.message)); }, []);

  useEffect(() => {
    const timer = setInterval(() => refresh().catch(() => undefined), 5000);
    return () => clearInterval(timer);
  }, [selectedProjectId, selectedRoomId]);

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

  async function createProject() {
    setBusy(true); setError(null);
    try {
      const data = await api<{ project: Project }>('/api/projects', { method: 'POST', body: JSON.stringify({ name: projectName, repoUrl, defaultBranch }) });
      setSelectedProjectId(data.project.id);
      await refresh();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }

  async function createRoom() {
    if (!selectedProject) return;
    setBusy(true); setError(null);
    try {
      const data = await api<{ room: Room }>(`/api/projects/${selectedProject.id}/rooms`, { method: 'POST', body: JSON.stringify({ name: roomName, branch: roomBranch || undefined }) });
      setSelectedRoomId(data.room.id);
      await refresh();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }

  async function deleteSelectedRoom() {
    if (!selectedRoom) return;
    const really = window.confirm(`Remove ${selectedRoom.name} from Devrooms and delete its files?`);
    if (!really) return;
    setBusy(true); setError(null);
    try {
      await api(`/api/rooms/${selectedRoom.id}`, { method: 'DELETE', body: JSON.stringify({ deleteFiles: true }) });
      setSelectedRoomId(null);
      await refresh();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }

  return (
    <main>
      <aside>
        <div className="brand-block"><div className="brand">devrooms</div><p>durable clone rooms for agentic work</p></div>
        <section>
          <div className="section-head"><h2>projects</h2><span>{projects.length}</span></div>
          {projects.map((project) => <button className={selectedProject?.id === project.id ? 'nav active' : 'nav'} key={project.id} onClick={() => setSelectedProjectId(project.id)}><strong>{project.name}</strong><span>{project.defaultBranch}</span></button>)}
          <div className="form-card">
            <input value={projectName} onChange={(event) => setProjectName(event.target.value)} placeholder="project name" />
            <input value={repoUrl} onChange={(event) => setRepoUrl(event.target.value)} placeholder="git repo url" />
            <input value={defaultBranch} onChange={(event) => setDefaultBranch(event.target.value)} placeholder="default branch" />
            <button disabled={busy || !projectName.trim() || !repoUrl.trim()} onClick={createProject}>save project</button>
          </div>
        </section>
        <section>
          <div className="section-head"><h2>rooms</h2><span>{projectRooms.length}</span></div>
          {projectRooms.map((room) => <button className={selectedRoom?.id === room.id ? 'nav active' : 'nav'} key={room.id} onClick={() => setSelectedRoomId(room.id)}><strong>{room.name}</strong><span className={`pill ${room.status}`}>{room.status}</span></button>)}
          <div className="form-card">
            <input value={roomName} onChange={(event) => setRoomName(event.target.value)} placeholder="room name" />
            <input value={roomBranch} onChange={(event) => setRoomBranch(event.target.value)} placeholder={`branch (${selectedProject?.defaultBranch ?? 'default'})`} />
            <button disabled={busy || !selectedProject || !roomName.trim()} onClick={createRoom}>clone room</button>
          </div>
        </section>
      </aside>
      <section className="workspace">
        <header>
          <div className="room-title">
            <h1>{selectedRoom ? selectedRoom.name : 'no room selected'}</h1>
            <p>{selectedRoom ? shortPath(selectedRoom.path) : 'create a project and clone a room'}</p>
          </div>
          <div className="room-stats">
            <span>{selectedProject?.name ?? 'no project'}</span>
            <span>{selectedRoom?.branch ?? selectedProject?.defaultBranch ?? 'no branch'}</span>
            <span>{runningCount} running</span>
            <span>{roomProcesses.length} process{roomProcesses.length === 1 ? '' : 'es'}</span>
          </div>
          <nav>
            <button className={tab === 'terminal' ? 'active' : ''} onClick={() => setTab('terminal')}>terminal</button>
            <button className={tab === 'git' ? 'active' : ''} onClick={() => setTab('git')}>git</button>
            <button className={tab === 'subagents' ? 'active' : ''} onClick={() => setTab('subagents')}>subagents</button>
            <button onClick={() => refresh()}>refresh</button>
            {selectedRoom && <button className="danger" onClick={deleteSelectedRoom}>delete</button>}
          </nav>
        </header>
        {error && <div className="error">{error}</div>}
        {!selectedRoom && <div className="empty splash"><strong>No room selected.</strong><span>Create a project, then clone a room. Each room is a full repository clone.</span></div>}
        {selectedRoom && selectedRoom.status !== 'idle' && (
          <div className={`empty splash room-state ${selectedRoom.status}`}>
            <strong>{selectedRoom.status === 'creating' ? 'Cloning room…' : 'Room clone failed'}</strong>
            <span>{selectedRoom.status === 'creating' ? 'Devrooms is cloning the repository in the background. This view will refresh automatically.' : selectedRoom.error}</span>
            <button onClick={() => refresh()}>refresh now</button>
          </div>
        )}
        {selectedRoom?.status === 'idle' && tab === 'terminal' && <TerminalPane roomId={selectedRoom.id} />}
        {selectedRoom?.status === 'idle' && tab === 'git' && <GitPanel room={selectedRoom} />}
        {selectedRoom?.status === 'idle' && tab === 'subagents' && <SubagentsPanel room={selectedRoom} presets={presets} />}
      </section>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
