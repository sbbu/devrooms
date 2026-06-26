import { useEffect, useRef, useState } from 'react';
import {
  THEMES, getConfig, getSystemMode, resolveMode,
  previewTheme, previewAppearance, revertPreview,
  commitTheme, commitAppearance,
  type Appearance,
} from './themes';

// A single text input collected by a command's inline prompt.
export type CommandField = {
  name: string;          // key in the values map handed to perform()
  placeholder: string;
  optional?: boolean;    // required fields gate submission
  defaultValue?: string;
};

// A command surfaced in the palette's root list. The palette owns the Theme and
// Appearance entries itself; everything else (navigation, room/terminal actions)
// is supplied by the app.
export type Command = {
  id: string;
  title: string;
  hint?: string;
  keywords?: string;
  // Selecting a command either runs it immediately or, when it declares a
  // `prompt`, opens an inline field form in the palette and runs perform() with
  // the collected values on submit.
  perform: (values?: Record<string, string>) => void;
  prompt?: { title: string; submitLabel: string; fields: CommandField[] };
};

type PaletteMode = 'root' | 'theme' | 'appearance' | 'prompt';

type Row = {
  key: string;
  title: string;
  hint?: string;
  tag?: string;          // right-aligned label, e.g. "dark" / "light"
  swatches?: string[];   // little color chips for theme rows
  checked?: boolean;     // current-selection dot
  search: string;        // text matched against the query
  preview?: () => void;  // fired when the row becomes highlighted (submodes)
  run: () => void;       // fired on Enter / click
};

// Cheap ranked match: prefix > word-boundary > substring > subsequence.
function score(query: string, text: string): number {
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
  { pref: 'system', title: 'System', hint: 'Follow the OS appearance' },
  { pref: 'light', title: 'Light', hint: 'Always use the light theme' },
  { pref: 'dark', title: 'Dark', hint: 'Always use the dark theme' },
];

export function CommandPalette({ open, onClose, commands }: { open: boolean; onClose: () => void; commands: Command[] }) {
  const [mode, setMode] = useState<PaletteMode>('root');
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const [promptCmd, setPromptCmd] = useState<Command | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const fieldRefs = useRef<(HTMLInputElement | null)[]>([]);
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
    setMode('root'); setQuery(''); setIndex(0); setPromptCmd(null); setValues({});
    restoreFocusRef.current?.focus?.();
    restoreFocusRef.current = null;
    return undefined;
  }, [open]);

  // Move to root/submode with the highlight reset in the same batch, so the
  // preview effect fires once for the new top row (never a stale/clamped index).
  const go = (next: PaletteMode) => { setMode(next); setQuery(''); setIndex(0); };

  // Open a command's inline field form, seeding each field with its default.
  const enterPrompt = (cmd: Command) => {
    const seed: Record<string, string> = {};
    cmd.prompt!.fields.forEach((field) => { seed[field.name] = field.defaultValue ?? ''; });
    setPromptCmd(cmd); setValues(seed); setMode('prompt'); setQuery(''); setIndex(0);
  };

  const promptReady = promptCmd?.prompt!.fields.every((f) => f.optional || (values[f.name] ?? '').trim()) ?? false;
  const submitPrompt = () => {
    if (!promptCmd) return;
    // Enter on an incomplete form jumps to the first missing required field
    // instead of firing, so the action never runs half-specified.
    const missing = promptCmd.prompt!.fields.findIndex((f) => !f.optional && !(values[f.name] ?? '').trim());
    if (missing >= 0) { fieldRefs.current[missing]?.focus(); return; }
    promptCmd.perform(values); onClose();
  };

  const cfg = getConfig();
  // Enter a submode highlighting the current selection, so live-preview starts on
  // the active theme/appearance (no jump to row 0) and you arrow out from there.
  const enterTheme = () => { setMode('theme'); setQuery(''); setIndex(Math.max(0, THEMES.findIndex((t) => t.id === cfg[resolveMode()]))); };
  const enterAppearance = () => { setMode('appearance'); setQuery(''); setIndex(Math.max(0, APPEARANCES.findIndex((a) => a.pref === cfg.appearance))); };
  const rootRows: Row[] = [
    { key: '_theme', title: 'Theme', hint: 'Change the color theme', search: 'theme color colors palette appearance', run: enterTheme },
    { key: '_appearance', title: 'Appearance', hint: `System · light · dark — now ${resolveMode()}`, search: 'appearance light dark mode system', run: enterAppearance },
    ...commands.map((cmd) => ({
      key: cmd.id, title: cmd.title, hint: cmd.hint,
      search: `${cmd.title} ${cmd.keywords ?? ''}`,
      run: () => { if (cmd.prompt) enterPrompt(cmd); else { cmd.perform(); onClose(); } },
    })),
  ];
  const themeRows: Row[] = THEMES.map((theme) => ({
    key: theme.id, title: theme.name, tag: theme.mode,
    swatches: [theme.ui.base, theme.ui.surface, theme.ui.cyan, theme.ui.green, theme.ui.yellow, theme.ui.red],
    checked: cfg[theme.mode] === theme.id,
    search: `${theme.name} ${theme.mode} theme`,
    preview: () => previewTheme(theme),
    run: () => { commitTheme(theme); onClose(); },
  }));
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

  // Land the cursor in the first prompt field the moment the form appears.
  useEffect(() => { if (open && mode === 'prompt') fieldRefs.current[0]?.focus(); }, [open, mode, promptCmd]);

  if (!open) return null;

  const backToRoot = () => { revertPreview(); setPromptCmd(null); setValues({}); go('root'); inputRef.current?.focus(); };

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

  // Field keys: Enter submits (or jumps to the first gap), Escape/empty-Backspace
  // backs out, and Tab cycles fields so the whole form stays keyboard-only.
  function onFieldKeyDown(event: React.KeyboardEvent<HTMLInputElement>, fieldIndex: number) {
    const fields = promptCmd?.prompt!.fields ?? [];
    if (event.key === 'Enter') {
      event.preventDefault();
      submitPrompt();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      backToRoot();
    } else if (event.key === 'Backspace' && (values[fields[fieldIndex]?.name] ?? '') === '' && fieldIndex === 0) {
      event.preventDefault();
      backToRoot();
    } else if (event.key === 'Tab') {
      event.preventDefault();
      const next = (fieldIndex + (event.shiftKey ? -1 : 1) + fields.length) % fields.length;
      fieldRefs.current[next]?.focus();
    }
  }

  const crumb = mode === 'theme' ? 'Theme' : mode === 'appearance' ? 'Appearance' : null;
  const placeholder = mode === 'theme' ? 'Search themes…' : mode === 'appearance' ? 'Choose appearance…' : 'Search settings and commands…';

  if (mode === 'prompt' && promptCmd) {
    const fields = promptCmd.prompt!.fields;
    return (
      <div className="cmd-overlay" onMouseDown={onClose}>
        <div className="cmd cmd-prompt" onMouseDown={(event) => event.stopPropagation()}>
          {fields.map((field, i) => (
            <div className="cmd-input" key={field.name}>
              {i === 0 && <span className="cmd-crumb">{promptCmd.prompt!.title}<span className="cmd-crumb-sep">›</span></span>}
              <input
                ref={(el) => { fieldRefs.current[i] = el; }}
                value={values[field.name] ?? ''}
                onChange={(event) => setValues((v) => ({ ...v, [field.name]: event.target.value }))}
                onKeyDown={(event) => onFieldKeyDown(event, i)}
                placeholder={field.optional ? `${field.placeholder} (optional)` : field.placeholder}
                spellCheck={false}
                autoComplete="off"
              />
            </div>
          ))}
          <div className="cmd-foot">
            <span><kbd>↵</kbd> {promptReady ? promptCmd.prompt!.submitLabel : 'fill required fields'}</span>
            <span><kbd>tab</kbd> next field</span>
            <span><kbd>esc</kbd> back</span>
          </div>
        </div>
      </div>
    );
  }

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
              {row.checked && <span className="cmd-check">●</span>}
            </div>
          )) : <div className="cmd-empty">No matches</div>}
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
