import { BrowserWindow, WebContentsView } from "electron";
import { CdpSession, type RawAXSnapshot } from "./cdp";

/** A rectangle in the window's content coordinate space (CSS px / DIP). */
export interface SlotBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** State the renderer mirrors as panel chrome (URL pill, nav buttons). */
export interface BrowserState {
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

const CANVAS = "#16181b";
const ABOUT_BLANK = "about:blank";

/**
 * Owns the single embedded WebContentsView — the live page the user sees and
 * (later) the agent drives over CDP. The view is a NATIVE layer composited on
 * top of the renderer; it is not part of the DOM. The renderer draws an empty
 * "slot" and reports its rect; we position the view to overlap that slot
 * exactly. Hiding the view (retract) is just setting it invisible.
 *
 * This module deliberately knows nothing about panel STATES (compact/full) —
 * that is the renderer's concern. Here we only ever honor "put the page at
 * these bounds" and "show/hide". That keeps the native side dumb and stable.
 */
export class BrowserManager {
  private view: WebContentsView | null = null;
  private window: BrowserWindow;
  private lastBounds: SlotBounds = { x: 0, y: 0, width: 0, height: 0 };
  private attached = false;
  private onState: (state: BrowserState) => void;
  private cdp: CdpSession | null = null;
  // Resolves once the panel is shown AND has reported a real (non-zero) slot
  // rect, so the agent's first navigate paints into a correctly-positioned view
  // instead of an off-screen, zero-bounds one. Anyone awaiting readiness before
  // the panel opens waits here; `setBounds` with a real rect resolves it.
  private readyResolve: (() => void) | null = null;
  private readyPromise: Promise<void> | null = null;
  private onPrepare: (() => void) | null = null;

  constructor(window: BrowserWindow, onState: (state: BrowserState) => void) {
    this.window = window;
    this.onState = onState;
  }

  /** Register the callback that asks the renderer to open the browser panel. */
  setPrepareHandler(fn: () => void): void {
    this.onPrepare = fn;
  }

  /**
   * Ensure the panel is open and the view is positioned, THEN resolve. Called
   * before the agent's first navigate so the page never paints into a detached,
   * zero-bounds view. If the panel is already up with real bounds, resolves
   * immediately. Capped so a renderer that never reports bounds can't hang the
   * agent.
   */
  private async ensureReady(timeoutMs = 2000): Promise<void> {
    if (this.attached && hasArea(this.lastBounds)) return;
    if (!this.readyPromise) {
      this.readyPromise = new Promise<void>((resolve) => {
        this.readyResolve = resolve;
      });
      // Ask the renderer to open the panel (it will then report slot bounds).
      this.onPrepare?.();
    }
    await Promise.race([
      this.readyPromise,
      new Promise<void>((r) => setTimeout(r, timeoutMs)),
    ]);
  }

  /** Lazily create the view on first use so an idle app pays nothing. */
  private ensureView(): WebContentsView {
    if (this.view) return this.view;

    const view = new WebContentsView({
      webPreferences: {
        // The embedded page is untrusted web content — keep it sandboxed and
        // isolated. It has no preload and no access to our IPC bridge.
        sandbox: true,
        contextIsolation: true,
      },
    });
    view.setBackgroundColor(CANVAS);

    const wc = view.webContents;
    const emit = () => this.emitState();
    wc.on("did-start-loading", emit);
    wc.on("did-stop-loading", emit);
    wc.on("did-navigate", emit);
    wc.on("did-navigate-in-page", emit);
    wc.on("page-title-updated", emit);

    this.cdp = new CdpSession(wc);
    this.view = view;
    return view;
  }

  /** The CDP session for the embedded page (attaches lazily on first use). */
  private cdpSession(): CdpSession {
    this.ensureView();
    return this.cdp!;
  }

  /**
   * Perception's input: the a11y snapshot PLUS the page's visible rendered text
   * (the content the a11y tree drops). Captured together so the planner sees a
   * page's data — tables, labeled numbers — in one snapshot instead of scrolling
   * to hunt for content the a11y tree can't surface.
   */
  async snapshot(): Promise<RawAXSnapshot> {
    const cdp = this.cdpSession();
    const [ax, text] = await Promise.all([
      cdp.snapshotAccessibility(),
      cdp.captureText(),
    ]);
    return { ...ax, text };
  }

  /**
   * Deterministic click that WAITS for any navigation it triggers. A click on a
   * link/tab/button often navigates or swaps the view; without this wait the
   * loop snapshots a blank/mid-load page and the planner has to notice and route
   * around it (observed: blank-after-click on Yahoo links/tabs, wasted turns).
   * Now the click leaves a SETTLED, readable page — the LLM never babysits it.
   */
  async clickNode(backendNodeId: number) {
    return this.runAndSettle(() =>
      this.cdpSession().clickBackendNode(backendNodeId),
    );
  }

  /** Type text into a node by backend id. */
  async typeNode(backendNodeId: number, text: string): Promise<void> {
    await this.cdpSession().typeIntoBackendNode(backendNodeId, text);
  }

  /**
   * Deterministic search: find the page's search box, enter the query, submit,
   * and wait for results to settle — one operation. Returns false if the page
   * has no usable search box. The planner never operates the box itself.
   */
  async search(query: string): Promise<boolean> {
    return this.runAndSettle(() => this.cdpSession().searchPage(query));
  }

  /**
   * Press Enter on a node and WAIT for the navigation it triggers (a search
   * submit). Without this wait the loop snapshots the pre-submit page, the
   * planner thinks the submit didn't work, and re-issues it (observed: 5
   * retries on Google search).
   */
  async pressEnterNode(backendNodeId: number): Promise<void> {
    await this.runAndSettle(() =>
      this.cdpSession().pressEnterOnBackendNode(backendNodeId),
    );
  }

  /**
   * Run a page interaction, then leave the page in a SETTLED, readable state:
   * arm a navigation watcher BEFORE the action (so a fast nav can't be missed),
   * run it, and if a navigation starts within a short window, wait for it to
   * finish loading + for real content to paint; if none does (in-page/AJAX
   * update, or a no-op click), settle briefly. This is the shared mechanics +
   * recovery that keeps the LLM from ever seeing a half-loaded page.
   *
   * Returns whatever the action returned (e.g. clickBackendNode's result).
   */
  private async runAndSettle<T>(action: () => Promise<T>): Promise<T> {
    const wc = this.ensureView().webContents;
    const urlBefore = wc.getURL();

    const navigated = new Promise<boolean>((resolve) => {
      let settled = false;
      const onStart = () => {
        if (settled) return;
        settled = true;
        cleanup();
        const onFinish = () => {
          wc.off("did-finish-load", onFinish);
          wc.off("did-fail-load", onFinish);
          resolve(true);
        };
        wc.on("did-finish-load", onFinish);
        wc.on("did-fail-load", onFinish);
        setTimeout(() => {
          wc.off("did-finish-load", onFinish);
          wc.off("did-fail-load", onFinish);
          resolve(true);
        }, 15000);
      };
      const cleanup = () => {
        wc.off("did-start-navigation", onStart);
        wc.off("did-navigate", onStart);
      };
      wc.on("did-start-navigation", onStart);
      wc.on("did-navigate", onStart);
      // No navigation within this window → in-page update or no-op, proceed.
      setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(false);
      }, 1200);
    });

    const result = await action();
    const didNavigate = await navigated;
    if (didNavigate || wc.getURL() !== urlBefore) {
      await this.cdpSession().waitForContent();
    } else {
      await new Promise((r) => setTimeout(r, 400));
    }
    return result;
  }

  /** Scroll the viewport to reveal more content. */
  async scrollViewport(direction: "down" | "up"): Promise<void> {
    await this.cdpSession().scrollViewport(direction);
  }

  /** Scroll a node by backend id into view. */
  async scrollNodeIntoView(backendNodeId: number): Promise<void> {
    await this.cdpSession().scrollNodeIntoView(backendNodeId);
  }

  /** Navigate and resolve once the page has finished loading (or errored). */
  async navigateAndWait(input: string): Promise<void> {
    const view = this.ensureView();
    // Make sure the panel is open and positioned BEFORE we load, so the first
    // paint lands in the right place — not off-screen at zero bounds. This also
    // consolidates "open the browser" and "load the page" into one beat.
    await this.ensureReady();
    const wc = view.webContents;
    const url = normalizeUrl(input);
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        wc.off("did-finish-load", finish);
        wc.off("did-fail-load", finish);
        resolve();
      };
      wc.on("did-finish-load", finish);
      wc.on("did-fail-load", finish);
      void wc.loadURL(url).catch(finish);
      // Safety timeout so a hung load can't stall the agent loop forever.
      setTimeout(finish, 15000);
    });
    // did-finish-load fires with an empty DOM on SPAs/Google — the real content
    // paints just after via JS. Poll the a11y tree until it has actual content
    // (capped) so we never hand the planner a blank page to guess about.
    await this.cdpSession().waitForContent();
  }

  /** The live page url (for the driver). */
  currentUrl(): string {
    return this.view?.webContents.getURL() ?? "";
  }

  /** The live page title (for session state). */
  title(): string {
    return this.view?.webContents.getTitle() ?? "";
  }

  private emitState(): void {
    const wc = this.view?.webContents;
    if (!wc) return;
    this.onState({
      url: wc.getURL(),
      title: wc.getTitle(),
      loading: wc.isLoading(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
    });
  }

  /** Position the page to overlap the renderer's slot rect. */
  setBounds(bounds: SlotBounds): void {
    this.lastBounds = bounds;
    if (this.attached && this.view) {
      this.view.setBounds({
        x: Math.round(bounds.x),
        y: Math.round(bounds.y),
        width: Math.round(bounds.width),
        height: Math.round(bounds.height),
      });
      // The panel is open and positioned — anyone awaiting readiness (the
      // agent's first navigate) can proceed now.
      if (hasArea(bounds) && this.readyResolve) {
        this.readyResolve();
        this.readyResolve = null;
      }
    }
  }

  /** Attach + reveal the view (panel expanding). */
  show(): void {
    const view = this.ensureView();
    if (!this.attached) {
      this.window.contentView.addChildView(view);
      this.attached = true;
    }
    view.setVisible(true);
    this.setBounds(this.lastBounds);
    // Land on a calm blank page until the user/agent navigates.
    if (view.webContents.getURL() === "") {
      void view.webContents.loadURL(ABOUT_BLANK);
    }
    this.emitState();
  }

  /** Hide the view without destroying it (panel retracting). */
  hide(): void {
    this.view?.setVisible(false);
  }

  navigate(input: string): void {
    const view = this.ensureView();
    const url = normalizeUrl(input);
    void view.webContents.loadURL(url);
  }

  goBack(): void {
    const wc = this.view?.webContents;
    if (wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
  }

  goForward(): void {
    const wc = this.view?.webContents;
    if (wc?.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
  }

  reload(): void {
    this.view?.webContents.reload();
  }
}

/**
 * Turn raw URL-bar input into a loadable URL. A bare host gets https://; a
 * query-looking string becomes a search. Kept tiny and deterministic — no
 * surprises for the agent path later.
 */
/** A slot rect with real area — i.e. the panel is actually laid out on screen. */
function hasArea(b: SlotBounds): boolean {
  return b.width > 1 && b.height > 1;
}

function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return ABOUT_BLANK;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  // Looks like a domain (has a dot, no spaces) → assume https.
  if (/^[^\s]+\.[^\s]+$/.test(trimmed)) return `https://${trimmed}`;
  // Otherwise treat as a search query.
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
}
