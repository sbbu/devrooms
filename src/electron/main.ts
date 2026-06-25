import { app, BrowserWindow, shell } from 'electron';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
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
body{margin:0;background:#06070a;color:#eef3ff;font:14px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;display:grid;place-items:center;min-height:100vh}
main{width:min(680px,calc(100vw - 48px));background:#0c1017;border:1px solid #263144;border-radius:18px;padding:24px;box-shadow:0 24px 80px #0008}
h1{font-size:24px;margin:0 0 10px;letter-spacing:-.04em}p{color:#8f9bb2;line-height:1.5}code{background:#090d14;border:1px solid #263144;border-radius:8px;color:#94f0c4;padding:2px 5px}pre{white-space:pre-wrap;background:#090d14;border:1px solid #263144;border-radius:12px;color:#ffd1d8;padding:12px}
</style></head><body><main><h1>${escapeHtml(title)}</h1>${body}</main></body></html>`;
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
    minWidth: 980,
    minHeight: 680,
    title: 'devrooms',
    backgroundColor: '#06070a',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
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
});
