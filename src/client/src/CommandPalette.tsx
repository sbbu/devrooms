import { useEffect, useRef, useState } from 'react';
import {
  THEMES, getConfig, getSystemMode, resolveMode,
  previewTheme, previewAppearance, revertPreview,
  commitTheme, commitAppearance,
  type Appearance,
} from './themes';

// A command surfaced in the palette's root list. The palette owns the Theme and
// Appearance entries itself; everything else (navigation, room/terminal actions)
// is supplied by the app. Selecting a command runs it immediately; anything that
// needs more input (e.g. cloning a room) opens its own dedicated overlay instead.
export type Command = {
  id: string;
  title: string;
  hint?: string;
  keywords?: string;
  shortcut?: string;     // display-only key hint, e.g. "⌘1" / "Ctrl+R"
  checked?: boolean;     // show the current-selection dot (e.g. the active room)
  perform: () => void;   // fired on Enter / click
};

type PaletteMode = 'root' | 'theme' | 'appearance';

type Row = {
  key: string;
  title: string;
  hint?: string;
  tag?: string;          // right-aligned label, e.g. "dark" / "light"
  keys?: string;         // right-aligned key hint, e.g. "⌘1"
  swatches?: string[];   // little color chips for theme rows
  checked?: boolean;     // current-selection dot
  search: string;        // text matched against the query
  preview?: () => void;  // fired when the row becomes highlighted (submodes)
  run: () => void;       // fired on Enter / click
};

// Cheap ranked match: prefix > word-boundary > substring > subsequence.
export function score(query: string, text: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const i = t.indexOf(q);
  if (i === 0) return 4;
  if (i > 0 && /[\s:/-]/.test(t[i - 1])) return 3;
  if (i > 0) return 2;
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) if (t[ti] === q[qi]) qi++;
  return qi === q.length ? 1 : 0;
}

function filterRows(rows: Row[], query: string): Row[] {
  if (!query) return rows;
  return rows
    .map((row, i) => ({ row, s: score(query, row.search), i }))
    .filter((entry) => entry.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((entry) => entry.row);
}

const APPEARANCES: { pref: Appearance; title: string; hint: string }[] = [
  { pref: 'system', title: 'system', hint: 'follow the os appearance' },
  { pref: 'light', title: 'light', hint: 'always use the light theme' },
  { pref: 'dark', title: 'dark', hint: 'always use the dark theme' },
];

export function CommandPalette({ open, onClose, commands }: { open: boolean; onClose: () => void; commands: Command[] }) {
  const [mode, setMode] = useState<PaletteMode>('root');
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  // Open: remember the focused element (usually the live terminal) and focus the
  // search box. Close: revert any uncommitted preview, reset to a clean root
  // state — the component stays mounted, so mode/query/index would otherwise
  // persist and re-fire a stale submode preview on the next open — and hand
  // focus back so the terminal stays typable. After a commit the committed
  // resolution already equals what's shown, so the revert is a no-op repaint.
  useEffect(() => {
    if (open) {
      restoreFocusRef.current = document.activeElement as HTMLElement | null;
      const raf = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(raf);
    }
    revertPreview();
    setMode('root'); setQuery(''); setIndex(0);
    restoreFocusRef.current?.focus?.();
    restoreFocusRef.current = null;
    return undefined;
  }, [open]);

  // Move to root/submode with the highlight reset in the same batch, so the
  // preview effect fires once for the new top row (never a stale/clamped index).
  const go = (next: PaletteMode) => { setMode(next); setQuery(''); setIndex(0); };

  const cfg = getConfig();
  const activeMode = resolveMode();
  // Enter a submode highlighting the current selection, so live-preview starts on
  // the active theme/appearance (no jump to row 0) and you arrow out from there.
  const enterTheme = () => { setMode('theme'); setQuery(''); setIndex(Math.max(0, THEMES.findIndex((t) => t.id === cfg.theme))); };
  const enterAppearance = () => { setMode('appearance'); setQuery(''); setIndex(Math.max(0, APPEARANCES.findIndex((a) => a.pref === cfg.appearance))); };
  const rootRows: Row[] = [
    { key: '_theme', title: 'theme', hint: 'change the color theme', search: 'theme color colors palette appearance', run: enterTheme },
    { key: '_appearance', title: 'appearance', hint: `system · light · dark — now ${resolveMode()}`, search: 'appearance light dark mode system', run: enterAppearance },
    ...commands.map((cmd) => ({
      key: cmd.id, title: cmd.title, hint: cmd.hint, keys: cmd.shortcut, checked: cmd.checked,
      search: `${cmd.title} ${cmd.keywords ?? ''}`,
      run: () => { cmd.perform(); onClose(); },
    })),
  ];
  // Swatches preview the variant for the mode currently on screen, so the chips
  // match what committing the theme would actually show. A theme isn't dark or
  // light — appearance decides — so there's no mode tag.
  const themeRows: Row[] = THEMES.map((theme) => {
    const ui = (activeMode === 'light' ? theme.light : theme.dark).ui;
    return {
      key: theme.id, title: theme.name.toLowerCase(),
      swatches: [ui.base, ui.surface, ui.cyan, ui.green, ui.yellow, ui.red],
      checked: cfg.theme === theme.id,
      search: `${theme.name} theme`,
      preview: () => previewTheme(theme),
      run: () => { commitTheme(theme); onClose(); },
    };
  });
  const appearanceRows: Row[] = APPEARANCES.map((a) => ({
    key: `ap_${a.pref}`, title: a.title,
    hint: a.pref === 'system' ? `${a.hint} — now ${getSystemMode()}` : a.hint,
    checked: cfg.appearance === a.pref,
    search: `${a.title} appearance ${a.pref} mode`,
    preview: () => previewAppearance(a.pref),
    run: () => { commitAppearance(a.pref); onClose(); },
  }));

  const rows = mode === 'theme' ? themeRows : mode === 'appearance' ? appearanceRows : rootRows;
  const filtered = filterRows(rows, query);
  const idx = filtered.length ? Math.min(index, filtered.length - 1) : 0;
  const activeKey = filtered[idx]?.key ?? null;

  // Live-preview the highlighted row in submodes.
  const filteredRef = useRef(filtered);
  filteredRef.current = filtered;
  useEffect(() => {
    if (!open || (mode !== 'theme' && mode !== 'appearance') || activeKey == null) return;
    filteredRef.current.find((row) => row.key === activeKey)?.preview?.();
  }, [open, mode, activeKey]);

  // Keep the highlighted row in view.
  useEffect(() => { listRef.current?.querySelector('.cmd-row.sel')?.scrollIntoView({ block: 'nearest' }); }, [activeKey]);

  if (!open) return null;

  const backToRoot = () => { revertPreview(); go('root'); inputRef.current?.focus(); };

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setIndex((i) => (filtered.length ? (Math.min(i, filtered.length - 1) + 1) % filtered.length : 0));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setIndex((i) => (filtered.length ? (Math.min(i, filtered.length - 1) - 1 + filtered.length) % filtered.length : 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      filtered[idx]?.run();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      if (mode !== 'root') backToRoot(); else onClose();
    } else if (event.key === 'Backspace' && query === '' && mode !== 'root') {
      event.preventDefault();
      backToRoot();
    }
  }

  const crumb = mode === 'theme' ? 'theme' : mode === 'appearance' ? 'appearance' : null;
  const placeholder = mode === 'theme' ? 'search themes…' : mode === 'appearance' ? 'choose appearance…' : 'search settings and commands…';

  return (
    <div className="cmd-overlay" onMouseDown={onClose}>
      <div className="cmd" onMouseDown={(event) => event.stopPropagation()}>
        <div className="cmd-input">
          {crumb && <span className="cmd-crumb">{crumb}<span className="cmd-crumb-sep">›</span></span>}
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => { setQuery(event.target.value); setIndex(0); }}
            onKeyDown={onKeyDown}
            placeholder={placeholder}
            spellCheck={false}
            autoComplete="off"
          />
        </div>
        <div className="cmd-list" ref={listRef}>
          {filtered.length ? filtered.map((row, i) => (
            <div
              key={row.key}
              className={i === idx ? 'cmd-row sel' : 'cmd-row'}
              onMouseMove={() => setIndex(i)}
              onMouseDown={(event) => { event.preventDefault(); row.run(); }}
            >
              {row.swatches && (
                <span className="cmd-swatches">
                  {row.swatches.map((color, s) => <span key={s} className="cmd-swatch" style={{ background: color }} />)}
                </span>
              )}
              <span className="cmd-main">
                <span className="cmd-title">{row.title}</span>
                {row.hint && <span className="cmd-hint">{row.hint}</span>}
              </span>
              {row.tag && <span className="cmd-tag">{row.tag}</span>}
              {row.keys && <span className="cmd-keys">{row.keys}</span>}
              {row.checked && <span className="cmd-check">●</span>}
            </div>
          )) : <div className="cmd-empty">no matches</div>}
        </div>
        <div className="cmd-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
          <span><kbd>↵</kbd> select</span>
          <span><kbd>esc</kbd> {mode === 'root' ? 'close' : 'back'}</span>
        </div>
      </div>
    </div>
  );
}
