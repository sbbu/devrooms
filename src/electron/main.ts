import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.DEVROOMS_PORT ?? process.env.PORT ?? 4317);
const serverUrl = process.env.DEVROOMS_SERVER_URL ?? `http://127.0.0.1:${port}`;
const shouldUseExternalServer = Boolean(process.env.DEVROOMS_SERVER_URL);
let daemon: ChildProcessWithoutNullStreams | undefined;
let mainWindow: BrowserWindow | undefined;

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
  await mainWindow?.loadURL(statusPage(title, body));
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function isHealthy() {
  try {
    const res = await fetch(`${serverUrl}/api/health`);
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForDaemon() {
  for (let i = 0; i < 100; i++) {
    if (await isHealthy()) return;
    await sleep(100);
  }
  throw new Error(`devrooms daemon did not become healthy at ${serverUrl}`);
}

async function ensureDaemon() {
  if (await isHealthy()) return;
  if (shouldUseExternalServer) throw new Error(`External devrooms server is not reachable: ${serverUrl}`);

  // Fresh app launch: end any pty-host left over from a previous run (port + 1) so the
  // daemon spawns a clean one. Reusing a persisted host across the renderer reconnect
  // comes up with stale terminal state that breaks input/paste; a fresh host avoids it.
  if (process.platform !== 'win32') {
    try { spawnSync('sh', ['-c', `lsof -ti tcp:${port + 1} | xargs kill -9`], { stdio: 'ignore', timeout: 3000 }); } catch { /* best effort */ }
  }

  const serverEntry = path.resolve(__dirname, '../server.js');
  daemon = spawn(process.execPath, [serverEntry], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PORT: String(port) },
  });
  daemon.stdout.on('data', (chunk) => process.stdout.write(`[devroomsd] ${chunk}`));
  daemon.stderr.on('data', (chunk) => process.stderr.write(`[devroomsd] ${chunk}`));
  daemon.on('exit', (code, signal) => {
    console.log(`[devroomsd] exited code=${code ?? 'null'} signal=${signal ?? 'null'}`);
    daemon = undefined;
  });
  await waitForDaemon();
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
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
  await loadStatusPage('Starting devrooms', `<p>Starting local daemon at <code>${escapeHtml(serverUrl)}</code>…</p>`);
  try {
    await ensureDaemon();
    await mainWindow.loadURL(serverUrl);
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
  else if (action === 'fullscreen') win.setFullScreen(!win.isFullScreen());
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

app.whenReady().then(() => {
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
  if (daemon && !daemon.killed) daemon.kill('SIGTERM');
  // The detached pty-host is left running across a quit, but the NEXT launch starts
  // it fresh (see ensureDaemon) — reattaching a reused host to a relaunched renderer
  // left terminal input/paste broken, so we trade session-survival for a clean,
  // working terminal on every launch.
});
