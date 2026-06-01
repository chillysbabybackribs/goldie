import type { WebContents } from "electron";
import { type AXNode, type RawAXSnapshot, roleOf, nameOf } from "@goldie/agent-core";

export type { RawAXSnapshot };

// Roles that are pure structure/scaffolding — present in the tree but not
// "content" a user would perceive. Kept in sync with perception/strip's intent.
const STRUCTURAL_ROLES = new Set([
  "RootWebArea",
  "InlineTextBox",
  "LineBreak",
  "ListMarker",
  "none",
  "generic",
  "LayoutTable",
  "LayoutTableRow",
  "LayoutTableCell",
]);

/**
 * Count nodes a user would actually perceive — non-ignored, non-structural,
 * and either interactable-by-role or carrying a name. Mirrors strip()'s notion
 * of "kept" closely enough to gate navigation on real content being present.
 */
function countMeaningful(nodes: AXNode[]): number {
  let n = 0;
  for (const node of nodes) {
    if (node.ignored) continue;
    const role = roleOf(node);
    if (STRUCTURAL_ROLES.has(role)) continue;
    if (nameOf(node).length >= 2 || isInteractableRole(role)) n++;
  }
  return n;
}

function isInteractableRole(role: string): boolean {
  return (
    role === "link" ||
    role === "button" ||
    role === "textbox" ||
    role === "searchbox" ||
    role === "combobox" ||
    role === "checkbox" ||
    role === "radio" ||
    role === "tab" ||
    role === "menuitem"
  );
}

/**
 * Approximate area of a CDP content quad [x1,y1,x2,y2,x3,y3,x4,y4] via the
 * shoelace formula. Used to reject degenerate (zero/near-zero) boxes before a
 * click so we never dispatch at the centroid of a bogus rectangle.
 */
function quadArea(q: number[]): number {
  if (!q || q.length < 8) return 0;
  const x = [q[0], q[2], q[4], q[6]];
  const y = [q[1], q[3], q[5], q[7]];
  let a = 0;
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    a += x[i] * y[j] - x[j] * y[i];
  }
  return Math.abs(a) / 2;
}

/**
 * Pick the page's best search box from the AX tree, agnostically. Scores each
 * candidate input: an explicit `searchbox` role wins; a `textbox`/`combobox`
 * whose name hints at search ranks next; any other text input is a last resort.
 * Returns the backend node id of the highest scorer, or undefined if none.
 */
function pickSearchBox(nodes: AXNode[]): number | undefined {
  const SEARCHY = /search|find|query|look ?up|keyword/i;
  let best: { score: number; backendId: number } | undefined;

  for (const n of nodes) {
    if (n.ignored) continue;
    const backendId = n.backendDOMNodeId;
    if (backendId === undefined) continue;
    const role = roleOf(n);
    const name = nameOf(n);

    let score = 0;
    if (role === "searchbox") score = 100;
    else if (role === "textbox" || role === "combobox")
      score = SEARCHY.test(name) ? 60 : 20;
    else continue; // not a text-entry control

    // A search-y name nudges a generic textbox above a non-search one.
    if (score > 0 && SEARCHY.test(name)) score += 5;

    if (!best || score > best.score) best = { score, backendId };
  }
  return best?.backendId;
}

/**
 * A thin wrapper over Electron's built-in CDP (webContents.debugger). This is
 * the seed of the future `ElectronCdpDriver` that will implement the abstract
 * BrowserDriver interface in agent-core. For now it proves the three things
 * Step 3 needs: a live debugger session, an a11y snapshot, and a deterministic
 * click resolved through a CDP backend node.
 *
 * Design notes:
 * - We attach once and keep the session for the life of the WebContents.
 * - Domains (DOM, Accessibility, Runtime, Page) are enabled idempotently; a
 *   cross-origin navigation tears down execution contexts, so re-enabling
 *   before each high-level op is cheap insurance against "context destroyed".
 * - All page geometry from CDP (getContentQuads) and all input coordinates
 *   (dispatchMouseEvent) live in the SAME page-viewport CSS-pixel space, so a
 *   click never needs to know where the slot is on screen. Self-consistent.
 */


export class CdpSession {
  private wc: WebContents;
  private attached = false;

  constructor(wc: WebContents) {
    this.wc = wc;
  }

  /** Attach the debugger. Safe to call repeatedly. */
  attach(): void {
    if (this.attached) return;
    const dbg = this.wc.debugger;
    if (!dbg.isAttached()) {
      // '1.3' is the stable CDP version Chromium ships.
      dbg.attach("1.3");
    }
    this.attached = true;
    // If the page process goes away, drop our flag so a later op re-attaches.
    dbg.on("detach", () => {
      this.attached = false;
    });
  }

  private async send<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T> {
    this.attach();
    return (await this.wc.debugger.sendCommand(method, params)) as T;
  }

  /** Idempotently enable the domains our operations rely on. */
  private async enableDomains(): Promise<void> {
    await this.send("DOM.enable");
    await this.send("Accessibility.enable");
    await this.send("Runtime.enable");
    await this.send("Page.enable");
    // Overlay = the inspector's element-highlight layer. It draws ON TOP of the
    // page (its own compositor layer), never in the DOM — so highlighting a
    // target can't pollute the a11y snapshot or readable-text capture.
    try {
      await this.send("Overlay.enable");
    } catch {
      // Overlay is best-effort; a click never depends on it.
    }
  }

  /**
   * Draw the inspector-style box on a node for `ms`, then clear it. Pure visual
   * feedback owned by the deterministic pipeline — shows exactly what it's about
   * to act on. Best-effort: never blocks or fails an action.
   */
  private async highlightNode(backendNodeId: number, ms = 450): Promise<void> {
    try {
      await this.send("Overlay.highlightNode", {
        backendNodeId,
        highlightConfig: {
          // Goldie's accent-ish translucent fill + a solid ring, like the
          // DevTools inspector but tuned to read as "the agent is here".
          contentColor: { r: 99, g: 102, b: 241, a: 0.18 },
          borderColor: { r: 129, g: 140, b: 248, a: 0.9 },
          showInfo: false,
        },
      });
      await new Promise((r) => setTimeout(r, ms));
      await this.send("Overlay.hideHighlight");
    } catch {
      // Best-effort overlay; ignore.
    }
  }

  /**
   * Raw accessibility-tree snapshot. No stripping/organizing — that is Step 4.
   * Each interactable node carries a backendDOMNodeId we can act on later.
   */
  async snapshotAccessibility(): Promise<RawAXSnapshot> {
    await this.enableDomains();
    const { nodes } = await this.send<{ nodes: AXNode[] }>(
      "Accessibility.getFullAXTree",
    );
    return { url: this.wc.getURL(), nodes };
  }

  /**
   * Capture the page's VISIBLE rendered text — the content the accessibility
   * tree drops (data tables, custom widgets, labeled numbers like a stock's
   * P/E). Runs in-page JS that walks the DOM, skips chrome/script/hidden nodes,
   * and returns whitespace-collapsed text in document order. This is the "read
   * what's actually on the page" half of perception that the a11y tree alone
   * misses. Bounded so a huge page can't blow the budget; the pipeline trims
   * further. Agnostic: no per-site selectors, just visibility + role-of-tag.
   */
  async captureText(maxChars = 12000): Promise<string> {
    await this.enableDomains();
    const js = `(() => {
      const SKIP = new Set(['SCRIPT','STYLE','NOSCRIPT','SVG','NAV','FOOTER','HEADER','IFRAME','TEMPLATE']);
      const out = [];
      let total = 0;
      const cap = ${maxChars};
      const seen = new Set();
      const walk = (node) => {
        if (total >= cap) return;
        if (node.nodeType === Node.TEXT_NODE) {
          const t = node.textContent.replace(/\\s+/g, ' ').trim();
          if (t.length >= 2 && !seen.has(t)) {
            seen.add(t);
            out.push(t);
            total += t.length;
          }
          return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        if (SKIP.has(node.tagName)) return;
        // Skip hidden subtrees (display:none / visibility:hidden / 0-size).
        const st = node.ownerDocument.defaultView.getComputedStyle(node);
        if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return;
        const r = node.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return;
        for (const child of node.childNodes) walk(child);
      };
      walk(document.body);
      return out.join('\\n');
    })()`;
    try {
      const res = await this.send<{ result: { value?: string } }>(
        "Runtime.evaluate",
        { expression: js, returnByValue: true },
      );
      return res.result?.value ?? "";
    } catch {
      return "";
    }
  }

  /**
   * Find the page's primary search box by ACCESSIBILITY ROLE — agnostic, no
   * per-site selectors. Prefers an explicit `searchbox`; otherwise a `textbox`
   * or `combobox` whose name/placeholder looks search-related ("search", "find",
   * "query"); otherwise the first text input on the page. Returns its backend
   * node id, or undefined if the page has no usable input. Then types the query
   * and presses Enter (caller wraps in a settle). One deterministic operation.
   */
  async searchPage(query: string): Promise<boolean> {
    await this.enableDomains();
    const { nodes } = await this.send<{ nodes: AXNode[] }>(
      "Accessibility.getFullAXTree",
    );
    const backendId = pickSearchBox(nodes);
    if (backendId === undefined) return false;
    await this.typeIntoBackendNode(backendId, query);
    await this.pressEnterOnBackendNode(backendId);
    return true;
  }

  /**
   * Cheap "does this page have real content yet?" probe. Many sites (Google,
   * any SPA) fire did-finish-load with an empty/skeleton DOM and paint the real
   * content milliseconds later via JS. A fixed settle either over-waits or
   * snapshots a blank page. So instead we poll the AX tree until it has more
   * than a handful of non-ignored, meaningful nodes — then we know perception
   * will see SOMETHING. Capped by `timeoutMs` so a genuinely sparse page (or a
   * hung one) can't stall the agent.
   *
   * "Meaningful" = non-ignored nodes that aren't pure structure and either are
   * interactable or carry a name. This mirrors what `strip` keeps, so the gate
   * agrees with what the planner will actually be shown.
   */
  async waitForContent(timeoutMs = 6000, minNodes = 3): Promise<void> {
    await this.enableDomains();
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let meaningful = 0;
      try {
        const { nodes } = await this.send<{ nodes: AXNode[] }>(
          "Accessibility.getFullAXTree",
        );
        meaningful = countMeaningful(nodes);
      } catch {
        // Context torn down mid-navigation — treat as "not ready yet".
        meaningful = 0;
      }
      if (meaningful >= minNodes) return;
      if (Date.now() >= deadline) return;
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  /**
   * Deterministically click an element by its CDP backend node id.
   * Resolves the element's on-page geometry, scrolls it into view, draws the
   * overlay highlight, GUARDS that the geometry is real (refuses to blind-click
   * an element with no/degenerate box), then dispatches a real mouse
   * press+release at the centroid — exactly what a user click does.
   *
   * The guard matters: getContentQuads can return an empty or zero-area box for
   * an off-screen / display:contents / collapsed element. Clicking the centroid
   * of a bogus box would land on whatever happens to be at (0,0)-ish — a
   * mis-click. We refuse and report instead.
   */
  async clickBackendNode(backendNodeId: number): Promise<{
    clicked: boolean;
    x: number;
    y: number;
  }> {
    await this.enableDomains();

    // Make sure the element is on-screen before we read its box.
    await this.send("DOM.scrollIntoViewIfNeeded", { backendNodeId });

    const { quads } = await this.send<{ quads: number[][] }>(
      "DOM.getContentQuads",
      { backendNodeId },
    );
    if (!quads || quads.length === 0) {
      return { clicked: false, x: 0, y: 0 };
    }

    // Pick the first quad with real area; reject degenerate boxes.
    const q = quads.find((cand) => quadArea(cand) >= 4);
    if (!q) {
      return { clicked: false, x: 0, y: 0 };
    }

    // A quad is [x1,y1, x2,y2, x3,y3, x4,y4] — average to the centroid.
    const x = (q[0] + q[2] + q[4] + q[6]) / 4;
    const y = (q[1] + q[3] + q[5] + q[7]) / 4;

    // Show the user exactly what we're about to click (what's shown == what's
    // clicked: same resolved node, same geometry).
    await this.highlightNode(backendNodeId);

    // Move, then press+release — mirrors a genuine pointer interaction.
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
    });
    await this.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });

    return { clicked: true, x, y };
  }

  /**
   * Type text into an element by backend node id: focus it (via DOM.focus,
   * falling back to a click), select-all + delete to clear, then insert the
   * text as real input. Mirrors a user typing into a field.
   */
  async typeIntoBackendNode(backendNodeId: number, text: string): Promise<void> {
    await this.enableDomains();
    // Show the field we're about to type into.
    await this.highlightNode(backendNodeId);
    try {
      await this.send("DOM.focus", { backendNodeId });
    } catch {
      // Some elements can't be focused directly — click to focus instead.
      await this.clickBackendNode(backendNodeId);
    }
    // Clear any existing value: Ctrl/Cmd+A then Backspace.
    await this.selectAll();
    await this.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Backspace",
      windowsVirtualKeyCode: 8,
    });
    await this.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Backspace",
      windowsVirtualKeyCode: 8,
    });
    // Insert the text as a single committed input.
    await this.send("Input.insertText", { text });
  }

  /** Press Enter (e.g. to submit a search). Focus the node first. */
  async pressEnterOnBackendNode(backendNodeId: number): Promise<void> {
    await this.enableDomains();
    try {
      await this.send("DOM.focus", { backendNodeId });
    } catch {
      // best-effort — the field is usually already focused after typing.
    }
    const enter = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 };
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", ...enter });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...enter });
  }

  /**
   * Scroll the viewport one near-full page in a direction by dispatching a real
   * mouse-wheel event at the page center. Mirrors a user scrolling — works on
   * any scroll container the pointer is over, no element targeting needed.
   */
  async scrollViewport(direction: "down" | "up"): Promise<void> {
    await this.enableDomains();
    const { width, height } = await this.viewportSize();
    const deltaY = (direction === "up" ? -1 : 1) * Math.round(height * 0.85);
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: Math.round(width / 2),
      y: Math.round(height / 2),
      deltaX: 0,
      deltaY,
    });
    // A short settle so lazy/virtualized content can render before we snapshot.
    await new Promise((r) => setTimeout(r, 350));
  }

  /** Scroll a specific element into view by backend node id. */
  async scrollNodeIntoView(backendNodeId: number): Promise<void> {
    await this.enableDomains();
    await this.send("DOM.scrollIntoViewIfNeeded", { backendNodeId });
    await new Promise((r) => setTimeout(r, 350));
  }

  /** Current layout viewport size in CSS px (for wheel coordinates). */
  private async viewportSize(): Promise<{ width: number; height: number }> {
    const { cssLayoutViewport } = await this.send<{
      cssLayoutViewport: { clientWidth: number; clientHeight: number };
    }>("Page.getLayoutMetrics");
    return {
      width: cssLayoutViewport?.clientWidth || 1024,
      height: cssLayoutViewport?.clientHeight || 768,
    };
  }

  private async selectAll(): Promise<void> {
    const mod = process.platform === "darwin" ? 4 : 2; // Meta vs Ctrl bit
    await this.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "a",
      windowsVirtualKeyCode: 65,
      modifiers: mod,
    });
    await this.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "a",
      windowsVirtualKeyCode: 65,
      modifiers: mod,
    });
  }

  detach(): void {
    if (this.wc.debugger.isAttached()) {
      try {
        this.wc.debugger.detach();
      } catch {
        // Already gone — fine.
      }
    }
    this.attached = false;
  }
}
