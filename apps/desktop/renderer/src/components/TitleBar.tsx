/** A minimal, custom window control (frameless window draws its own). */
function Control({
  label,
  onClick,
  children,
  danger,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  danger?: boolean;
}) {
  return (
    <button
      aria-label={label}
      onClick={onClick}
      className={`no-drag grid h-7 w-7 place-items-center rounded-lg text-ink-faint transition-colors duration-150 hover:text-ink ${
        danger ? "hover:bg-red-500/80 hover:text-white" : "hover:bg-raised"
      }`}
    >
      {children}
    </button>
  );
}

export function TitleBar() {
  const w = window.goldie?.window;
  return (
    <header className="drag-region flex h-11 shrink-0 items-center justify-between px-3">
      <div className="flex items-center pl-1">
        <span className="text-[13px] font-medium tracking-tight text-ink-muted">
          goldie
        </span>
      </div>

      <div className="flex items-center gap-1">
        <Control label="Minimize" onClick={() => w?.minimize()}>
          <svg width="11" height="11" viewBox="0 0 11 11">
            <line x1="2" y1="5.5" x2="9" y2="5.5" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </Control>
        <Control label="Maximize" onClick={() => w?.toggleMaximize()}>
          <svg width="11" height="11" viewBox="0 0 11 11">
            <rect x="2.2" y="2.2" width="6.6" height="6.6" rx="1.4" fill="none" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </Control>
        <Control label="Close" onClick={() => w?.close()} danger>
          <svg width="11" height="11" viewBox="0 0 11 11">
            <line x1="2.5" y1="2.5" x2="8.5" y2="8.5" stroke="currentColor" strokeWidth="1.2" />
            <line x1="8.5" y1="2.5" x2="2.5" y2="8.5" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </Control>
      </div>
    </header>
  );
}
