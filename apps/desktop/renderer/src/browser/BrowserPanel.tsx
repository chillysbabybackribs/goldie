import { useEffect, useRef, useState } from "react";
import type { BrowserState } from "../../../electron/preload";
import { useSlotBounds } from "./useSlotBounds";
import type { PanelMode } from "./useBrowserPanel";

function NavButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className="grid h-7 w-7 place-items-center rounded-lg text-ink-muted transition-colors enabled:hover:bg-overlay enabled:hover:text-ink disabled:opacity-25"
    >
      {children}
    </button>
  );
}

export function BrowserPanel({
  mode,
  state,
  onNavigate,
  onBack,
  onForward,
  onReload,
  onCollapse,
}: {
  mode: PanelMode;
  state: BrowserState;
  onNavigate: (url: string) => void;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  onCollapse: () => void;
}) {
  const slotRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState(state.url);
  const [editing, setEditing] = useState(false);

  // Keep the native view glued to the slot. Re-measure when the mode changes
  // (compact↔full changes the slot size).
  useSlotBounds(slotRef, mode !== "collapsed", [mode]);

  // Reflect the live URL in the pill unless the user is actively editing it.
  useEffect(() => {
    if (!editing) setDraft(state.url === "about:blank" ? "" : state.url);
  }, [state.url, editing]);

  return (
    <div className="flex h-full min-w-0 flex-col">
      {/* Panel chrome — slim, quiet, matches the card aesthetic. */}
      <div className="flex items-center gap-1 px-2 py-2">
        <NavButton label="Back" onClick={onBack} disabled={!state.canGoBack}>
          <svg width="15" height="15" viewBox="0 0 16 16">
            <path d="M10 3l-5 5 5 5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </NavButton>
        <NavButton label="Forward" onClick={onForward} disabled={!state.canGoForward}>
          <svg width="15" height="15" viewBox="0 0 16 16">
            <path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </NavButton>
        <NavButton label="Reload" onClick={onReload}>
          <svg width="14" height="14" viewBox="0 0 16 16">
            <path d="M13 8a5 5 0 1 1-1.5-3.5M13 2.5V5h-2.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </NavButton>

        {/* URL pill */}
        <form
          className="min-w-0 flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            onNavigate(draft);
            setEditing(false);
            (document.activeElement as HTMLElement)?.blur();
          }}
        >
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onFocus={() => setEditing(true)}
            onBlur={() => setEditing(false)}
            placeholder="Enter a URL or search"
            spellCheck={false}
            className="h-7 w-full rounded-lg bg-raised px-3 text-[12.5px] text-ink placeholder:text-ink-faint focus:outline-none focus:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.12)] [user-select:text]"
          />
        </form>

        {/* Collapse panel */}
        <NavButton label="Close browser" onClick={onCollapse}>
          <svg width="13" height="13" viewBox="0 0 13 13">
            <line x1="3" y1="3" x2="10" y2="10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            <line x1="10" y1="3" x2="3" y2="10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
        </NavButton>
      </div>

      {/* The SLOT — an empty well the native WebContentsView is positioned over.
          We never render page content here; the native layer covers it. The
          dark fill shows only for the split-second before the view paints. */}
      <div className="min-h-0 flex-1 px-2 pb-2">
        <div
          ref={slotRef}
          className="h-full w-full overflow-hidden rounded-well bg-canvas shadow-well"
        />
      </div>
    </div>
  );
}
