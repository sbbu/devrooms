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
  throw new Error(`Devrooms daemon did not become healthy at ${serverUrl}`);
}

async function ensureDaemon() {
  if (await isHealthy()) return;
  if (shouldUseExternalServer) throw new Error(`External Devrooms server is not reachable: ${serverUrl}`);

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
  await ensureDaemon();
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 980,
    minHeight: 680,
    title: 'Devrooms',
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
  await mainWindow.loadURL(serverUrl);
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
