import { useRef } from "react";
import { ChatView } from "../components/ChatView";
import { BrowserPanel } from "./BrowserPanel";
import { Splitter } from "./Splitter";
import { useBrowserPanel } from "./useBrowserPanel";

/**
 * Arranges the chat and the browser panel. For now the panel has two states:
 * collapsed, and full (a draggable split). The browser opens into full at its
 * browser-narrowest width — the clean state. (A true mobile/compact mode with
 * CDP device-metrics emulation returns in Step 7.)
 */
export function Workspace() {
  const panel = useBrowserPanel();
  const rowRef = useRef<HTMLDivElement>(null);

  const { mode, chatFraction } = panel;
  const open = mode !== "collapsed";

  return (
    <div ref={rowRef} className="relative flex h-full w-full">
      {/* Chat column. Full width when collapsed; chatFraction when split. */}
      <div
        className="h-full min-w-0 transition-[width] duration-300 ease-soft"
        style={{ width: open ? `${chatFraction * 100}%` : "100%" }}
      >
        <ChatView />
      </div>

      {/* Splitter + browser panel only when open. */}
      {open && (
        <>
          <Splitter containerRef={rowRef} onFraction={panel.setChatFraction} />
          <div className="h-full min-w-0 flex-1 border-l border-line">
            <BrowserPanel
              mode={mode}
              state={panel.state}
              onNavigate={panel.navigate}
              onBack={panel.back}
              onForward={panel.forward}
              onReload={panel.reload}
              onCollapse={panel.collapse}
            />
          </div>
        </>
      )}

      {/* Floating "open browser" affordance when collapsed. */}
      {mode === "collapsed" && (
        <button
          aria-label="Open browser"
          onClick={() => panel.open("full")}
          className="absolute bottom-5 right-5 flex h-10 w-10 items-center justify-center rounded-well bg-raised text-ink-muted shadow-card transition-colors hover:bg-overlay hover:text-ink"
        >
          <svg width="18" height="18" viewBox="0 0 20 20">
            <circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <path d="M2.5 10h15M10 2.5c2 2.2 2 13.3 0 15M10 2.5c-2 2.2-2 13.3 0 15" fill="none" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </button>
      )}
    </div>
  );
}
