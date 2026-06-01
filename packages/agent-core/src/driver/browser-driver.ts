import type { RawAXSnapshot } from "../perception/ax-types";

/**
 * The abstraction that keeps agent-core independent of Electron. The concrete
 * implementation today is ElectronCdpDriver (in apps/desktop, wrapping
 * webContents.debugger); a PlaywrightDriver or a server-side driver can be
 * dropped in later with zero changes to perception/planner/orchestrator.
 *
 * The driver speaks in BACKEND NODE IDS — it never exposes selectors. The
 * orchestrator resolves an LLM-chosen element id to a backendNodeId (via the
 * PageView.byId map) before calling these.
 */
export interface BrowserDriver {
  /** Current page url. */
  url(): Promise<string>;
  /** Navigate and resolve when the page has settled. */
  navigate(url: string): Promise<void>;
  /** Raw accessibility snapshot — the perception pipeline's only input. */
  snapshot(): Promise<RawAXSnapshot>;
  /** Deterministically click an element by its CDP backend node id. */
  click(backendNodeId: number): Promise<void>;
  /** Type text into an element by backend node id (focus + insert). */
  type(backendNodeId: number, text: string): Promise<void>;
  /** Press Enter on an element by backend node id (e.g. submit a search). */
  pressEnter(backendNodeId: number): Promise<void>;
  /**
   * Deterministically search the current page: find its search box, enter the
   * query, submit, and wait for results to settle — all internally. Returns
   * true if a search box was found and used, false if the page has none (so the
   * orchestrator can report that cleanly). No selectors cross the boundary.
   */
  search(query: string): Promise<boolean>;
  /** Scroll the viewport one page in a direction to reveal more content. */
  scroll(direction: "down" | "up"): Promise<void>;
  /** Scroll a specific element (by backend node id) into view. */
  scrollIntoView(backendNodeId: number): Promise<void>;
}
