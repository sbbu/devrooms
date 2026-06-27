import type { ITheme } from '@xterm/xterm';
import { CURATED_THEMES } from './theme-catalog';

// devrooms theming. One Theme drives two surfaces at once:
//   - the React UI, by writing the :root CSS custom properties styles.css reads
//   - every xterm.js terminal (and therefore any agent TUI rendered inside it,
//     since Hermes/Codex/Claude Code/OpenCode paint with the terminal's ANSI palette)
//
// A theme is mode-agnostic: each one carries BOTH a light and a dark variant.
// Appearance (system | light | dark) decides which variant is shown — picking a
// theme never picks a mode. "system" follows the OS via prefers-color-scheme and
// updates live, so flipping appearance swaps the active theme between its own
// light and dark variants while keeping the chosen theme.

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

// One light/dark face of a theme.
export type ThemeVariant = { ui: UiColors; terminal: TerminalColors };

// A theme: a name plus both faces. The active face is chosen by appearance.
export type Theme = {
  id: string;
  name: string;
  dark: ThemeVariant;
  light: ThemeVariant;
};

// A theme collapsed to a single mode — what actually gets painted.
export type ResolvedTheme = { id: string; name: string; mode: Mode; ui: UiColors; terminal: TerminalColors };

export type ThemeConfig = { appearance: Appearance; theme: string };

const STORAGE_KEY = 'devrooms.theme';
export const DEFAULT_THEME_ID = 'devrooms';

// ── built-in theme (always present) ─────────────────────────────────────────
// devrooms — the calm house theme, with a home for both light and dark mode.
const devrooms: Theme = {
  id: 'devrooms',
  name: 'devrooms',
  dark: {
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
  },
  light: {
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
  },
};

export const THEMES: Theme[] = [devrooms, ...CURATED_THEMES];

export function themeById(id: string | null | undefined): Theme | undefined {
  return THEMES.find((theme) => theme.id === id);
}

function variantFor(theme: Theme, mode: Mode): ThemeVariant {
  return mode === 'light' ? theme.light : theme.dark;
}
function resolved(theme: Theme, mode: Mode): ResolvedTheme {
  const variant = variantFor(theme, mode);
  return { id: theme.id, name: theme.name, mode, ui: variant.ui, terminal: variant.terminal };
}

// ── config (committed selection) ────────────────────────────────────────────
let config: ThemeConfig = { appearance: 'system', theme: DEFAULT_THEME_ID };
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
export function resolveTheme(cfg: ThemeConfig = config): ResolvedTheme {
  const mode = resolveMode(cfg);
  return resolved(themeById(cfg.theme) ?? THEMES[0], mode);
}

// The currently-displayed theme (tracks previews too, so terminals opened mid-
// preview match what the user sees). getTerminalResource reads this.
let active: ResolvedTheme = resolveTheme();
export function getActiveTheme(): ResolvedTheme {
  return active;
}

// ── applying to the DOM + terminals ─────────────────────────────────────────
type TerminalLike = {
  term: { options: { theme?: ITheme }; rows: number; refresh(start: number, end: number): void; clearTextureAtlas?(): void };
  notifyColorScheme?: (mode: Mode) => void;
};

function paint(theme: ResolvedTheme) {
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
    const like = resource as TerminalLike;
    const term = like.term;
    term.options.theme = theme.terminal;
    // Swapping the theme remaps palette-indexed cells, but the renderer can keep
    // stale glyphs cached in its texture atlas — drop it and repaint every visible
    // row so no cells straggle on the old colors. (Absolute-RGB/truecolor cells a
    // running TUI drew can't remap; those correct when the TUI itself redraws.)
    term.clearTextureAtlas?.();
    term.refresh(0, Math.max(0, term.rows - 1));
    // Nudge truecolor TUIs that opted into DEC 2031 (e.g. opencode's "system" theme)
    // to re-detect light/dark and redraw — the only way they follow a theme change,
    // since the palette remap above can't touch their absolute-RGB cells.
    like.notifyColorScheme?.(theme.mode);
  }
  // Keep the native (frameless) window background in step with the theme so the
  // window's corners and resize gutter don't stay dark under a light theme. The
  // bridge is Electron-only; in the browser this is a no-op.
  window.devrooms?.setBackgroundColor?.(ui.base);
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
// Transient preview of a theme (no config change, not persisted). Resolves the
// theme against the committed appearance, so the preview shows the variant you'd
// actually get for the current light/dark mode.
export function previewTheme(theme: Theme): void { paint(resolved(theme, resolveMode())); }
// Transient preview of an appearance choice (resolves the chosen theme into the
// previewed mode).
export function previewAppearance(pref: Appearance): void {
  paint(resolveTheme({ ...config, appearance: pref }));
}
// Re-apply the committed resolution, discarding any live preview.
export function revertPreview(): void { paint(resolveTheme()); }

// Commit a theme: it applies in whichever mode is currently on screen (and in the
// other mode later, since each theme carries both variants). Appearance is left
// untouched — choosing a theme never changes light/dark.
export function commitTheme(theme: Theme): void {
  config = { ...config, theme: theme.id };
  paint(resolveTheme());
  persist();
}
export function commitAppearance(pref: Appearance): void {
  config = { ...config, appearance: pref };
  paint(resolveTheme());
  persist();
}

// ── stored-config migration ─────────────────────────────────────────────────
// Older builds stored a theme per mode ({ dark, light } slots) or a bare theme
// id, both keyed by per-variant ids (e.g. "catppuccin-mocha"). Map those onto the
// new mode-agnostic theme ids so an upgrade keeps the user's pick.
const LEGACY_THEME_ID: Record<string, string> = {
  'devrooms-dark': 'devrooms', 'devrooms-light': 'devrooms',
  'tokyo-night': 'tokyo-night',
  'catppuccin-mocha': 'catppuccin', 'catppuccin-latte': 'catppuccin',
  'gruvbox-dark': 'gruvbox', 'gruvbox-light': 'gruvbox',
  'nord': 'nord', 'dracula': 'dracula',
  'solarized-dark': 'solarized', 'solarized-light': 'solarized',
  'rose-pine': 'rose-pine', 'one-dark': 'one',
};
function migrateThemeId(id: string | undefined): string | undefined {
  if (!id) return undefined;
  if (themeById(id)) return id;                 // already a current theme id
  return LEGACY_THEME_ID[id];                   // map a known legacy id, else undefined
}

// Read stored config and apply before first paint. Called from main.tsx ahead
// of React render so there's no flash. Also wires the live system-theme listener.
export function initTheme(): void {
  let raw: string | null = null;
  try { raw = localStorage.getItem(STORAGE_KEY); } catch { /* no storage */ }
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<ThemeConfig> & { dark?: string; light?: string };
      const appearance = parsed.appearance === 'light' || parsed.appearance === 'dark' || parsed.appearance === 'system' ? parsed.appearance : 'system';
      // Prefer the new `theme` field; fall back to migrating an old mode slot.
      const theme = migrateThemeId(typeof parsed.theme === 'string' ? parsed.theme : undefined)
        ?? migrateThemeId(parsed.dark) ?? migrateThemeId(parsed.light)
        ?? DEFAULT_THEME_ID;
      config = { appearance, theme };
    } catch {
      // Legacy value: a bare theme id string. Map it through the legacy table.
      config = { ...config, theme: migrateThemeId(raw) ?? DEFAULT_THEME_ID };
    }
  }
  prefersDark?.addEventListener('change', () => {
    if (config.appearance === 'system') { paint(resolveTheme()); emit(); }
  });
  paint(resolveTheme());
}
