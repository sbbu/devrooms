import type { ITheme } from '@xterm/xterm';
import { CURATED_THEMES } from './theme-catalog';

// devrooms theming. One Theme drives two surfaces at once:
//   - the React UI, by writing the :root CSS custom properties styles.css reads
//   - every xterm.js terminal (and therefore any agent TUI rendered inside it,
//     since Hermes/Codex/Claude Code/OpenCode paint with the terminal's ANSI palette)
//
// Appearance (system | light | dark) decides whether the light or dark theme is
// shown. "system" follows the OS via prefers-color-scheme and updates live. The
// user keeps one chosen theme per mode, so flipping appearance swaps between
// their picked light and dark themes.

export type UiColors = {
  base: string;       // window background
  surface: string;    // lifted: selected rows, focused fills
  hairline: string;   // every 1px rule / border
  hairline2: string;  // focused field border
  fg: string;         // primary text
  dim: string;        // demoted text: metadata, hints, inactive
  faint: string;      // furthest back: connectors, placeholders
  cyan: string;       // PRIMARY ACCENT — active / selection / inverted block
  yellow: string;     // warning / dirty / creating
  red: string;        // error / destructive
  green: string;      // success / running / added
};

// Exactly the xterm.js ITheme fields we drive. Assignable to ITheme.
export type TerminalColors = Required<
  Pick<
    ITheme,
    | 'background' | 'foreground' | 'cursor' | 'cursorAccent' | 'selectionBackground'
    | 'black' | 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan' | 'white'
    | 'brightBlack' | 'brightRed' | 'brightGreen' | 'brightYellow'
    | 'brightBlue' | 'brightMagenta' | 'brightCyan' | 'brightWhite'
  >
>;

export type Mode = 'dark' | 'light';
export type Appearance = 'system' | 'light' | 'dark';

export type Theme = {
  id: string;
  name: string;
  mode: Mode;
  ui: UiColors;
  terminal: TerminalColors;
};

export type ThemeConfig = { appearance: Appearance; dark: string; light: string };

const STORAGE_KEY = 'devrooms.theme';
export const DEFAULT_DARK_ID = 'devrooms-dark';
export const DEFAULT_LIGHT_ID = 'devrooms-light';

// ── built-in themes (always present) ────────────────────────────────────────
const devroomsDark: Theme = {
  id: 'devrooms-dark',
  name: 'devrooms Dark',
  mode: 'dark',
  ui: {
    base: '#16181d', surface: '#1c1f26', hairline: '#2a2e37', hairline2: '#353a45',
    fg: '#c5c8d0', dim: '#6b7079', faint: '#4b505a',
    cyan: '#7fb4ca', yellow: '#d4b46a', red: '#c97b7b', green: '#8aa872',
  },
  terminal: {
    background: '#16181d', foreground: '#c5c8d0', cursor: '#7fb4ca', cursorAccent: '#16181d',
    selectionBackground: '#2a3340',
    black: '#2a2e37', red: '#c97b7b', green: '#8aa872', yellow: '#d4b46a',
    blue: '#7f9cca', magenta: '#b08cc4', cyan: '#7fb4ca', white: '#c5c8d0',
    brightBlack: '#4b505a', brightRed: '#d99a9a', brightGreen: '#a3c089', brightYellow: '#e2c88a',
    brightBlue: '#9db8d8', brightMagenta: '#c7a8d8', brightCyan: '#a0ccdd', brightWhite: '#e8eaef',
  },
};

// devrooms Light — the calm counterpart, so light mode always has a home theme.
const devroomsLight: Theme = {
  id: 'devrooms-light',
  name: 'devrooms Light',
  mode: 'light',
  ui: {
    base: '#f7f8fa', surface: '#eceef2', hairline: '#dadde3', hairline2: '#c2c7d0',
    fg: '#2b2f37', dim: '#697079', faint: '#9aa0aa',
    cyan: '#1f7a99', yellow: '#9a6b1f', red: '#b4332a', green: '#4f7a35',
  },
  terminal: {
    background: '#f7f8fa', foreground: '#2b2f37', cursor: '#1f7a99', cursorAccent: '#f7f8fa',
    selectionBackground: '#d2e4ec',
    black: '#2b2f37', red: '#b4332a', green: '#4f7a35', yellow: '#9a6b1f',
    blue: '#2b6f9c', magenta: '#8a4f9e', cyan: '#1f7a99', white: '#dadde3',
    brightBlack: '#697079', brightRed: '#c95a4f', brightGreen: '#6a9a52', brightYellow: '#b7861f',
    brightBlue: '#3f86b8', brightMagenta: '#a06bb4', brightCyan: '#3f97b8', brightWhite: '#f7f8fa',
  },
};

export const THEMES: Theme[] = [devroomsDark, devroomsLight, ...CURATED_THEMES];

export function themeById(id: string | null | undefined): Theme | undefined {
  return THEMES.find((theme) => theme.id === id);
}
function firstOfMode(mode: Mode): Theme {
  return THEMES.find((theme) => theme.mode === mode) ?? devroomsDark;
}

// ── config (committed selection) ────────────────────────────────────────────
let config: ThemeConfig = { appearance: 'system', dark: DEFAULT_DARK_ID, light: DEFAULT_LIGHT_ID };
export function getConfig(): ThemeConfig {
  return { ...config };
}

const prefersDark = typeof window !== 'undefined' && window.matchMedia
  ? window.matchMedia('(prefers-color-scheme: dark)')
  : null;
function systemMode(): Mode {
  return prefersDark?.matches ? 'dark' : 'light';
}

// The effective light/dark mode after resolving "system".
export function resolveMode(cfg: ThemeConfig = config): Mode {
  return cfg.appearance === 'system' ? systemMode() : cfg.appearance;
}
export function getSystemMode(): Mode {
  return systemMode();
}
export function resolveTheme(cfg: ThemeConfig = config): Theme {
  const mode = resolveMode(cfg);
  const id = mode === 'light' ? cfg.light : cfg.dark;
  return themeById(id) ?? firstOfMode(mode);
}

// The currently-displayed theme (tracks previews too, so terminals opened mid-
// preview match what the user sees). getTerminalResource reads this.
let active: Theme = resolveTheme();
export function getActiveTheme(): Theme {
  return active;
}

// ── applying to the DOM + terminals ─────────────────────────────────────────
type TerminalLike = { term: { options: { theme?: ITheme } } };

function paint(theme: Theme) {
  active = theme;
  const root = document.documentElement.style;
  const ui = theme.ui;
  root.setProperty('--base', ui.base);
  root.setProperty('--surface', ui.surface);
  root.setProperty('--hairline', ui.hairline);
  root.setProperty('--hairline-2', ui.hairline2);
  root.setProperty('--fg', ui.fg);
  root.setProperty('--dim', ui.dim);
  root.setProperty('--faint', ui.faint);
  root.setProperty('--cyan', ui.cyan);
  root.setProperty('--yellow', ui.yellow);
  root.setProperty('--red', ui.red);
  root.setProperty('--green', ui.green);
  root.setProperty('--selection', theme.terminal.selectionBackground);
  root.colorScheme = theme.mode;
  for (const resource of window.__DEVROOMS_TERMINALS__?.values() ?? []) {
    (resource as TerminalLike).term.options.theme = theme.terminal;
  }
}

function persist() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(config)); } catch { /* no storage */ }
  emit();
}

// ── subscriptions (so React can mirror committed/system changes) ────────────
const listeners = new Set<() => void>();
function emit() { for (const fn of listeners) fn(); }
export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

// ── public actions ──────────────────────────────────────────────────────────
// Transient preview of a specific theme (no config change, not persisted).
export function previewTheme(theme: Theme): void { paint(theme); }
// Transient preview of an appearance choice (resolves against current slots).
export function previewAppearance(pref: Appearance): void {
  paint(resolveTheme({ ...config, appearance: pref }));
}
// Re-apply the committed resolution, discarding any live preview.
export function revertPreview(): void { paint(resolveTheme()); }

// Commit a theme: store it in the slot for its mode and, if it isn't the mode
// currently on screen, flip appearance so the user actually sees their pick.
export function commitTheme(theme: Theme): void {
  config = { ...config, [theme.mode]: theme.id };
  if (resolveMode() !== theme.mode) config.appearance = theme.mode;
  paint(resolveTheme());
  persist();
}
export function commitAppearance(pref: Appearance): void {
  config = { ...config, appearance: pref };
  paint(resolveTheme());
  persist();
}

// Read stored config and apply before first paint. Called from main.tsx ahead
// of React render so there's no flash. Also wires the live system-theme listener.
export function initTheme(): void {
  let raw: string | null = null;
  try { raw = localStorage.getItem(STORAGE_KEY); } catch { /* no storage */ }
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<ThemeConfig>;
      config = {
        appearance: parsed.appearance === 'light' || parsed.appearance === 'dark' || parsed.appearance === 'system' ? parsed.appearance : 'system',
        dark: typeof parsed.dark === 'string' ? parsed.dark : DEFAULT_DARK_ID,
        light: typeof parsed.light === 'string' ? parsed.light : DEFAULT_LIGHT_ID,
      };
    } catch {
      // Legacy value: a bare theme id string. Seed the matching slot.
      const legacy = themeById(raw);
      if (legacy) config = { ...config, [legacy.mode]: legacy.id, appearance: legacy.mode };
    }
  }
  prefersDark?.addEventListener('change', () => {
    if (config.appearance === 'system') { paint(resolveTheme()); emit(); }
  });
  paint(resolveTheme());
}
