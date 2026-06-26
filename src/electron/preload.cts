import { contextBridge, ipcRenderer } from 'electron';

// Authored as .cts so TypeScript emits CommonJS (preload.cjs): sandboxed
// Electron preload scripts must be CommonJS, even in a "type": "module" package.
// Bridges a small window-control API for the custom frameless title bar.
contextBridge.exposeInMainWorld('devrooms', {
  platform: process.platform,
  windowControl: (action: 'minimize' | 'close' | 'fullscreen') => ipcRenderer.send('window:control', action),
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke('dialog:openDirectory'),
  // Lets the renderer keep the native window background in step with the theme,
  // so the frameless corners / resize gutter don't stay dark under a light theme.
  setBackgroundColor: (color: string) => ipcRenderer.send('window:background', color),
});
