import { useCallback, useEffect, useState } from "react";
import type { BrowserState } from "../../../electron/preload";

export type PanelMode = "collapsed" | "compact" | "full";

// Split bounds = chat's share of width in full mode. One source of truth shared
// with the Splitter. MAX = chat at its widest, i.e. the browser at its NARROWEST
// — the clean state we open into by default.
export const SPLIT_MIN = 0.25;
export const SPLIT_MAX = 0.6;

const EMPTY_STATE: BrowserState = {
  url: "",
  title: "",
  loading: false,
  canGoBack: false,
  canGoForward: false,
};

/**
 * Owns the browser panel's UI state and mirrors the live page state from main.
 * The native side knows nothing about modes — this hook translates a mode into
 * "show or hide". Bounds for the current mode are applied by the layout (via
 * useSlotBounds on the slot element), so a mode change just needs show/hide.
 */
export function useBrowserPanel() {
  const [mode, setMode] = useState<PanelMode>("collapsed");
  // Open into the browser-narrowest split (chat widest). User drags to widen.
  const [chatFraction, setChatFraction] = useState(SPLIT_MAX);
  const [state, setState] = useState<BrowserState>(EMPTY_STATE);

  // Mirror live page state pushed from main.
  useEffect(() => window.goldie.browser.onState(setState), []);

  // Show/hide the native view as the mode crosses the collapsed boundary.
  useEffect(() => {
    if (mode === "collapsed") void window.goldie.browser.hide();
    else void window.goldie.browser.show();
  }, [mode]);

  const open = useCallback((to: Exclude<PanelMode, "collapsed"> = "full") => {
    // Always open at the browser-narrowest split — the clean state.
    if (to === "full") setChatFraction(SPLIT_MAX);
    setMode(to);
  }, []);
  const collapse = useCallback(() => setMode("collapsed"), []);

  // When the agent starts browsing, main asks us to open the panel.
  useEffect(
    () => window.goldie.browser.onOpenRequest(() => open("full")),
    [open],
  );

  const navigate = useCallback((url: string) => {
    void window.goldie.browser.navigate(url);
  }, []);

  return {
    mode,
    setMode,
    chatFraction,
    setChatFraction,
    state,
    open,
    collapse,
    navigate,
    back: () => void window.goldie.browser.back(),
    forward: () => void window.goldie.browser.forward(),
    reload: () => void window.goldie.browser.reload(),
  };
}
