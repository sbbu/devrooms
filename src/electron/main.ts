import { app, BrowserWindow, ipcMain, shell, dialog, Menu, screen } from 'electron';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.DEVROOMS_PORT ?? process.env.PORT ?? 4317);
const serverUrl = process.env.DEVROOMS_SERVER_URL ?? `http://127.0.0.1:${port}`;
const shouldUseExternalServer = Boolean(process.env.DEVROOMS_SERVER_URL);
let daemon: ChildProcessWithoutNullStreams | undefined;
let mainWindow: BrowserWindow | undefined;
let quitting = false;

// Two live instances fight over the daemon port — the second's boot even SIGKILLs the
// first's pty-host (freePtyHostPort), nuking its live terminals. Only the packaged app
// takes the lock: a dev checkout shares the same userData dir, so an unconditional lock
// would keep `pnpm dev` from coexisting with the installed app.
if (app.isPackaged && !app.requestSingleInstanceLock()) {
  app.quit();
}
app.on('second-instance', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

function escapeHtml(value: string) {
  return value.replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]!);
}

function statusPage(title: string, body: string) {
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>
:root{color-scheme:dark}
body{margin:0;background:#16181d;color:#c5c8d0;font:13px "JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace;display:grid;place-items:center;min-height:100vh;-webkit-app-region:drag}
main{width:min(680px,calc(100vw - 48px));background:#16181d;border:1px solid #2a2e37;padding:22px}
h1{font-size:18px;margin:0 0 10px;font-weight:normal}p{color:#6b7079;line-height:1.5;margin:0}code{border:1px solid #2a2e37;color:#7fb4ca;padding:1px 4px}pre{white-space:pre-wrap;border:1px solid #2a2e37;color:#c97b7b;padding:12px}
.x{position:fixed;top:8px;right:10px;width:12px;height:12px;background:#c97b7b;border:none;cursor:pointer;-webkit-app-region:no-drag}
</style></head><body><button class="x" title="close" onclick="window.devrooms&&window.devrooms.windowControl('close')"></button><main><h1>${escapeHtml(title)}</h1>${body}</main></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

async function loadStatusPage(title: string, body: string) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  // A navigation rejected because the user closed the window mid-load is cosmetic.
  await mainWindow.loadURL(statusPage(title, body)).catch(() => {});
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function isHealthy() {
  try {
    // Bounded: a wedged daemon that accepts but never answers must read as unhealthy,
    // not hang the probe (and with it the boot) indefinitely.
    const res = await fetch(`${serverUrl}/api/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForDaemon() {
  // Probe fast at first (the daemon usually binds within a few hundred ms, and a tight
  // early interval shaves the post-ready wait from ~50ms avg to ~12ms) then widen to 100ms,
  // keeping the same ~10s overall budget. Pre-listen probes fail-fast with ECONNREFUSED.
  const deadline = Date.now() + 10_000;
  let attempt = 0;
  while (Date.now() < deadline) {
    if (await isHealthy()) return;
    await sleep(attempt < 40 ? 25 : 100);
    attempt++;
  }
  throw new Error(`devrooms daemon did not become healthy at ${serverUrl}`);
}

// Kill whatever holds a TCP port, without blocking the main-process event loop the way
// spawnSync(lsof) did (it froze IPC/window-controls for up to 3s on every launch). Still
// awaited by the caller so the port is free before the daemon binds; the child just runs
// async with a hard 3s cap and a fast resolve if `sh`/`lsof` is missing.
function freePtyHostPort(p: number): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (done) return; done = true; clearTimeout(timer); resolve(); };
    // -sTCP:LISTEN scopes the kill to the listener: a bare `lsof -ti tcp:<port>` also
    // matches processes merely CONNECTED to it (a still-running daemon's client socket),
    // and SIGKILLing those takes out the wrong process.
    const child = spawn('sh', ['-c', `lsof -ti tcp:${p} -sTCP:LISTEN | xargs kill -9`], { stdio: 'ignore' });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } finish(); }, 3000);
    child.on('exit', finish);
    child.on('error', finish); // missing sh/lsof — resolve now instead of waiting out the 3s
  });
}

async function ensureDaemon() {
  if (await isHealthy()) return;
  if (shouldUseExternalServer) throw new Error(`External devrooms server is not reachable: ${serverUrl}`);

  // Fresh app launch: end any pty-host left over from a previous run (port + 1) so the
  // daemon spawns a clean one. Reusing a persisted host across the renderer reconnect
  // comes up with stale terminal state that breaks input/paste; a fresh host avoids it.
  if (process.platform !== 'win32') {
    await freePtyHostPort(port + 1);
  }

  const serverEntry = path.resolve(__dirname, '../server.js');
  const child = spawn(process.execPath, [serverEntry], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PORT: String(port) },
  });
  daemon = child;
  // Keep a stderr tail so a boot crash surfaces its actual error on the failure
  // page instead of a generic 10s health timeout.
  const stderrTail: string[] = [];
  child.stdout.on('data', (chunk) => process.stdout.write(`[devroomsd] ${chunk}`));
  child.stderr.on('data', (chunk) => {
    process.stderr.write(`[devroomsd] ${chunk}`);
    stderrTail.push(String(chunk));
    if (stderrTail.length > 20) stderrTail.shift();
  });
  // Created BEFORE the health polling starts, so an instant crash (port conflict,
  // module error) is observed rather than racing the first poll.
  const exited = new Promise<never>((_, reject) => {
    child.on('exit', (code, signal) => {
      console.log(`[devroomsd] exited code=${code ?? 'null'} signal=${signal ?? 'null'}`);
      if (daemon === child) daemon = undefined;
      reject(new Error(`daemon exited (code=${code ?? 'null'} signal=${signal ?? 'null'})\n${stderrTail.join('').trim()}`));
      // An exit after boot succeeded means the app is now a dead shell — say so
      // instead of leaving a frozen UI (unless we're the ones quitting).
      if (!quitting) {
        void loadStatusPage(
          'devrooms daemon stopped',
          `<p>The local daemon exited unexpectedly (code=${code ?? 'null'} signal=${signal ?? 'null'}).</p><pre>${escapeHtml(stderrTail.join('').trim() || 'no stderr output')}</pre><p>Quit and reopen devrooms.</p>`,
        );
      }
    });
  });
  // The race keeps `exited` handled for the process's whole life, so its rejection
  // at normal quit time never surfaces as an unhandledRejection.
  await Promise.race([waitForDaemon(), exited]);
}

async function createWindow() {
  // Start the daemon (cold-start long pole: lsof + node spawn + poll-to-healthy) BEFORE the
  // window/status-page work so its boot overlaps the status-page navigation. Probe health once
  // up front: when the daemon is already up (warm relaunch / external server) we skip the
  // status-page interstitial entirely and go straight to the app. The synchronous .catch keeps
  // an early rejection (daemon timeout) from escaping as an unhandledRejection before we await
  // it inside the try/catch below, where it still routes to the failure page.
  const healthy = await isHealthy();
  const daemonReady = healthy ? Promise.resolve() : ensureDaemon();
  daemonReady.catch(() => {});

  // Fill the work area of whichever display devrooms launches on (responsive to
  // the monitor) rather than a fixed size that leaves dead space on larger
  // screens. Still a normal window — freely resizable down to the min.
  const { x, y, width, height } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  mainWindow = new BrowserWindow({
    x,
    y,
    width,
    height,
    minWidth: 480,
    minHeight: 360,
    title: 'devrooms',
    frame: false,
    backgroundColor: '#16181d',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  // Drop the reference once closed so later navigations (status pages, daemon-exit
  // notices) see "no window" instead of throwing on a destroyed one.
  mainWindow.on('closed', () => { mainWindow = undefined; });
  try {
    if (!healthy) await loadStatusPage('Starting devrooms', `<p>Starting local daemon at <code>${escapeHtml(serverUrl)}</code>…</p>`);
    await daemonReady;
    // The window can be closed while the daemon boots; navigation then has no target.
    if (mainWindow && !mainWindow.isDestroyed()) await mainWindow.loadURL(serverUrl);
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    await loadStatusPage(
      'devrooms daemon failed to start',
      `<p>The desktop shell is open, but the local daemon is not healthy at <code>${escapeHtml(serverUrl)}</code>.</p><pre>${escapeHtml(message)}</pre><p>Fix the daemon issue or quit and reopen devrooms.</p>`,
    );
  }
}

ipcMain.on('window:control', (event, action: unknown) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  if (action === 'minimize') win.minimize();
  else if (action === 'close') win.close();
  else if (action === 'fullscreen') win.setSimpleFullScreen(!win.isSimpleFullScreen());
});

// The renderer pushes the active theme's base color here so the native window
// background (seen at the frameless corners and while resizing) tracks the theme
// instead of staying pinned to the dark default it was created with.
ipcMain.on('window:background', (event, color: unknown) => {
  if (typeof color !== 'string' || !/^#[0-9a-fA-F]{3,8}$/.test(color)) return;
  BrowserWindow.fromWebContents(event.sender)?.setBackgroundColor(color);
});

ipcMain.handle('dialog:openDirectory', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
  const result = await dialog.showOpenDialog(win!, {
    title: 'Open a git repository',
    buttonLabel: 'Open',
    properties: ['openDirectory', 'createDirectory'],
  });
  return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
});

// macOS only: replace the default menu with one that drops the Window ▸ Close
// (⌘W) item, freeing ⌘W for the renderer to close the focused terminal (iTerm
// style). Keeps the standard app/edit/view roles (⌘Q, clipboard, reload, etc.).
// Other platforms keep their default menu.
function installAppMenu() {
  if (process.platform !== 'darwin') return;
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'editMenu' },
    // Custom View menu instead of { role: 'viewMenu' }: keep reload (⌘R), force
    // reload, devtools and zoom, but route Full Screen through simple fullscreen so
    // the frameless window covers the whole display (no reserved menu-bar strip /
    // black gap that native fullscreen leaves on a borderless window).
    { label: 'View', submenu: [
      { role: 'reload' },
      { role: 'forceReload' },
      { role: 'toggleDevTools' },
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { label: 'Toggle Full Screen', accelerator: 'Control+Command+F', click: () => { const win = BrowserWindow.getFocusedWindow(); win?.setSimpleFullScreen(!win.isSimpleFullScreen()); } },
    ] },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }] },
  ]));
}

app.whenReady().then(() => {
  installAppMenu();
  void createWindow().catch((error) => {
    console.error(error);
    app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  quitting = true;
  if (daemon && !daemon.killed) daemon.kill('SIGTERM');
  // The detached pty-host is left running across a quit, but the NEXT launch starts
  // it fresh (see ensureDaemon) — reattaching a reused host to a relaunched renderer
  // left terminal input/paste broken, so we trade session-survival for a clean,
  // working terminal on every launch.
});
