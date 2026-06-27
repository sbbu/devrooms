import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

// A styled confirmation popup that replaces the native window.confirm() boxes with
// the app's palette-style action menu (the shared .cmd-* chrome used by the command
// palette, branch menu, and clone-room dialog). useConfirm() hands back an async
// confirm(opts) => Promise<boolean>; the provider keeps a single live dialog so any
// component — however deep — can await a yes/no without prop-drilling.
export type ConfirmOptions = {
  title: string;          // the question, e.g. "Discard changes to src/app.ts?"
  detail?: string;        // optional caution under it, e.g. "This can't be undone."
  confirmLabel: string;   // the affirmative action row, e.g. "discard"
  cancelLabel?: string;   // defaults to "cancel"
  danger?: boolean;       // tint the affirmative action red (destructive)
};

type Pending = ConfirmOptions & { id: number; resolve: (ok: boolean) => void };

// Default resolves false so a confirm() called before the provider mounts (shouldn't
// happen) declines rather than hangs the awaiter.
const ConfirmContext = createContext<(opts: ConfirmOptions) => Promise<boolean>>(
  () => Promise.resolve(false),
);

export function useConfirm() {
  return useContext(ConfirmContext);
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  // Read the live request without making it a dependency, so the confirm() identity
  // stays stable (consumers never re-bind) and settle() always sees the latest.
  const pendingRef = useRef<Pending | null>(null);
  pendingRef.current = pending;
  const idRef = useRef(0);

  const confirm = useCallback((opts: ConfirmOptions) =>
    new Promise<boolean>((resolve) => {
      // One dialog at a time: if something is already open, decline it first so its
      // awaiter resolves instead of leaking, then show the new request. Update the ref
      // synchronously too (not just on the next render) so a second confirm() in the
      // same tick declines this request rather than orphaning its promise.
      pendingRef.current?.resolve(false);
      idRef.current += 1;
      const next: Pending = { ...opts, id: idRef.current, resolve };
      pendingRef.current = next;
      setPending(next);
    }), []);

  const settle = (ok: boolean) => {
    pendingRef.current?.resolve(ok);
    setPending(null);
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending && <ConfirmDialog key={pending.id} req={pending} onSettle={settle} />}
    </ConfirmContext.Provider>
  );
}

// The dialog itself: a two-row action menu (affirmative, then cancel) under a header
// that states the question. Keyed by request id in the provider, so it remounts —
// and re-seeds its highlight — for every fresh confirm.
function ConfirmDialog({ req, onSettle }: { req: Pending; onSettle: (ok: boolean) => void }) {
  const [index, setIndex] = useState(0); // 0 = confirm, 1 = cancel
  const cardRef = useRef<HTMLDivElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  // Focus the card on open so it owns the keyboard (no text input to focus here),
  // and hand focus back — usually to the live terminal — when it closes.
  useEffect(() => {
    restoreRef.current = document.activeElement as HTMLElement | null;
    const raf = requestAnimationFrame(() => cardRef.current?.focus());
    return () => {
      cancelAnimationFrame(raf);
      restoreRef.current?.focus?.();
      restoreRef.current = null;
    };
  }, []);

  const rows = [
    { label: req.confirmLabel, danger: req.danger ?? false, ok: true },
    { label: req.cancelLabel ?? 'cancel', danger: false, ok: false },
  ];

  // Contain every keystroke: stopPropagation keeps the document-level handlers
  // (terminal shortcuts, the changes-view arrow navigation) from reacting while the
  // dialog owns the keyboard.
  const onKeyDown = (event: React.KeyboardEvent) => {
    event.stopPropagation();
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Tab') {
      event.preventDefault();
      setIndex((i) => (i === 0 ? 1 : 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      onSettle(rows[index].ok);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      onSettle(false);
    }
  };

  return (
    <div className="cmd-overlay" onMouseDown={() => onSettle(false)}>
      <div className="cmd cmd-confirm" ref={cardRef} tabIndex={-1} onKeyDown={onKeyDown} onMouseDown={(event) => event.stopPropagation()}>
        <div className="cmd-confirm-head">
          <div className="cmd-confirm-title">{req.title}</div>
          {req.detail && <div className="cmd-confirm-detail">{req.detail}</div>}
        </div>
        <div className="cmd-list">
          {rows.map((row, i) => (
            <div
              key={row.label}
              className={`cmd-row${i === index ? ' sel' : ''}${row.danger ? ' danger' : ''}`}
              onMouseMove={() => setIndex(i)}
              onMouseDown={(event) => { event.preventDefault(); onSettle(row.ok); }}
            >
              <span className="cmd-main"><span className="cmd-title">{row.label}</span></span>
            </div>
          ))}
        </div>
        <div className="cmd-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
          <span><kbd>↵</kbd> select</span>
          <span><kbd>esc</kbd> cancel</span>
        </div>
      </div>
    </div>
  );
}
