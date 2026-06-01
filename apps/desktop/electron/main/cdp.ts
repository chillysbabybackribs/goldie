import type { WebContents } from "electron";
import {
  type AXNode,
  type RawAXSnapshot,
  type PageIndex,
  roleOf,
  nameOf,
} from "@goldie/agent-core";

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
        // Never let our own overlay leak into perception.
        if (node.id === 'goldie-overlay-root') return;
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
   * Build the ACTIONABLE INDEX from the live DOM: clickable components +
   * extractable content clusters, each tagged + located. Deterministic and
   * agnostic — heuristics over DOM structure, no per-site rules. The in-page
   * pass marks each chosen element with data-goldie-tag and returns structured
   * data; we then resolve each tag to a CDP backend node id in one bulk pass so
   * the agent can act on a tag without the LLM ever seeing a selector.
   */
  async buildPageIndex(): Promise<PageIndex> {
    await this.enableDomains();
    const expr = buildIndexExpression();
    let raw: RawIndex;
    try {
      const res = await this.send<{ result: { value?: RawIndex } }>(
        "Runtime.evaluate",
        { expression: expr, returnByValue: true },
      );
      raw = res.result?.value ?? emptyRawIndex();
    } catch {
      raw = emptyRawIndex();
    }

    // Resolve each tagged element → backend node id in one bulk DOM pass.
    const tagToBackend = await this.resolveTaggedBackendIds();

    const components = raw.components.map((c) => ({
      tag: c.tag,
      kind: c.kind,
      name: c.name,
      detail: c.detail || undefined,
      rect: c.rect,
      backendNodeId: tagToBackend.get(c.tag) ?? -1,
    }));
    const clusters = raw.clusters.map((s) => ({
      tag: s.tag,
      kind: s.kind,
      label: s.label,
      rect: s.rect,
      text: s.text,
      backendNodeId: tagToBackend.get(s.tag) ?? -1,
    }));

    return { url: this.wc.getURL(), title: raw.title, components, clusters };
  }

  /**
   * Draw the PERSISTENT index overlay: a pass-through (pointer-events:none)
   * layer of tagged boxes over each indexed component and cluster, so the human
   * sees exactly what the deterministic pipeline perceives as actionable /
   * extractable — and can still click the page underneath. Reads the
   * data-goldie-tag attributes the index pass already set. Idempotent: replaces
   * any previous overlay. The container (#goldie-overlay-root) is excluded from
   * perception so it never pollutes the index it visualizes.
   */
  async drawIndexOverlay(): Promise<void> {
    await this.enableDomains();
    try {
      await this.send("Runtime.evaluate", {
        expression: overlayExpression(),
        returnByValue: true,
      });
    } catch {
      // Overlay is cosmetic; never fail an action over it.
    }
  }

  /** Remove the index overlay (e.g. on navigation, before re-indexing). */
  async clearIndexOverlay(): Promise<void> {
    try {
      await this.send("Runtime.evaluate", {
        expression:
          "(()=>{const e=document.getElementById('goldie-overlay-root');if(e)e.remove();})()",
        returnByValue: true,
      });
    } catch {
      // ignore
    }
  }

  /** Map every data-goldie-tag element to its CDP backend node id, in bulk. */
  private async resolveTaggedBackendIds(): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    try {
      const { root } = await this.send<{ root: { nodeId: number } }>(
        "DOM.getDocument",
        { depth: -1 },
      );
      const { nodeIds } = await this.send<{ nodeIds: number[] }>(
        "DOM.querySelectorAll",
        { nodeId: root.nodeId, selector: "[data-goldie-tag]" },
      );
      for (const nodeId of nodeIds) {
        try {
          const { node } = await this.send<{
            node: { backendNodeId: number; attributes?: string[] };
          }>("DOM.describeNode", { nodeId });
          const attrs = node.attributes ?? [];
          const i = attrs.indexOf("data-goldie-tag");
          if (i >= 0 && i + 1 < attrs.length) {
            out.set(attrs[i + 1], node.backendNodeId);
          }
        } catch {
          // skip a node that vanished mid-pass
        }
      }
    } catch {
      // DOM not ready — empty map; tags resolve to -1.
    }
    return out;
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

// ---------------------------------------------------------------------------
// Actionable-index builder (in-page JS + raw shapes)
// ---------------------------------------------------------------------------

interface RawRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface RawComponent {
  tag: string;
  kind: string;
  name: string;
  detail: string;
  rect: RawRect;
}
interface RawCluster {
  tag: string;
  kind: string;
  label: string;
  text: string;
  rect: RawRect;
}
interface RawIndex {
  title: string;
  components: RawComponent[];
  clusters: RawCluster[];
}

function emptyRawIndex(): RawIndex {
  return { title: "", components: [], clusters: [] };
}

/**
 * The in-page pass that builds the actionable index. Runs entirely in the
 * page's JS context (via Runtime.evaluate). It:
 *  - clears any previous goldie tags,
 *  - finds visible clickable COMPONENTS (links/buttons/inputs/tabs), tags each
 *    data-goldie-tag="cN", returns {tag,kind,name,detail,rect},
 *  - detects extractable CLUSTERS agnostically (tables, repeated-sibling lists,
 *    heading-delimited blocks), tags each "sN", returns {tag,kind,label,text,rect}.
 * Everything is bounded so a huge page can't blow up the payload.
 *
 * Kept as a single self-contained IIFE string — no external deps, no per-site
 * rules. This is the make-or-break cluster heuristic; tuned to be useful, not
 * exhaustive.
 */
function buildIndexExpression(): string {
  return `(() => {
    const MAX_COMPONENTS = 120;
    const MAX_CLUSTERS = 24;
    const CLUSTER_TEXT_CAP = 1200;

    // Clean previous run's tags so re-indexing is idempotent.
    for (const el of document.querySelectorAll('[data-goldie-tag]')) {
      el.removeAttribute('data-goldie-tag');
    }

    const visible = (el) => {
      const st = getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return false;
      const r = el.getBoundingClientRect();
      return r.width > 1 && r.height > 1;
    };
    const rectOf = (el) => {
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
    };
    const text = (el) => (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
    const cap = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

    // ---- COMPONENTS ----
    const compSel = 'a[href], button, input:not([type=hidden]), textarea, select, [role=button], [role=link], [role=tab], [role=checkbox], [role=menuitem], [contenteditable=true]';
    const components = [];
    let cN = 0;
    for (const el of document.querySelectorAll(compSel)) {
      if (cN >= MAX_COMPONENTS) break;
      if (!visible(el)) continue;
      const tagName = el.tagName.toLowerCase();
      const role = el.getAttribute('role') || '';
      let kind = 'button';
      if (tagName === 'a' || role === 'link') kind = 'link';
      else if (tagName === 'input' || tagName === 'textarea' || el.getAttribute('contenteditable') === 'true') kind = 'input';
      else if (tagName === 'select') kind = 'select';
      else if (role === 'tab') kind = 'tab';
      else if (role === 'checkbox' || el.type === 'checkbox') kind = 'checkbox';
      const name = cap(text(el) || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || '', 80);
      let detail = '';
      if (kind === 'link' && el.href) { try { const u = new URL(el.href); detail = (u.host + u.pathname).slice(0, 48); } catch {} }
      else if (kind === 'input') detail = (el.value || el.placeholder || '').slice(0, 40);
      const tag = 'c' + (++cN);
      el.setAttribute('data-goldie-tag', tag);
      components.push({ tag, kind, name, detail, rect: rectOf(el) });
    }

    // ---- CLUSTERS ----
    const clusters = [];
    let sN = 0;
    const used = new Set();
    const labelFor = (el) => {
      // nearest preceding heading, or aria-label, or caption
      const cap2 = el.querySelector && el.querySelector('caption');
      if (cap2 && text(cap2)) return cap(text(cap2), 60);
      const aria = el.getAttribute && el.getAttribute('aria-label');
      if (aria) return cap(aria, 60);
      let h = el.previousElementSibling;
      let hops = 0;
      while (h && hops < 4) {
        if (/^H[1-6]$/.test(h.tagName) && text(h)) return cap(text(h), 60);
        h = h.previousElementSibling; hops++;
      }
      // a heading inside the cluster
      const inner = el.querySelector && el.querySelector('h1,h2,h3,h4,h5,h6');
      if (inner && text(inner)) return cap(text(inner), 60);
      return '';
    };
    // Density check: reject "blob wrappers" whose text is ~entirely inside ONE
    // descendant (that descendant is the real cluster, not this wrapper).
    const isBlobWrapper = (el, t) => {
      let biggest = 0;
      for (const c of el.children) {
        const ct = text(c).length;
        if (ct > biggest) biggest = ct;
      }
      return t.length > 0 && biggest / t.length >= 0.9 && el.children.length <= 2;
    };

    const addCluster = (el, kind, opts) => {
      opts = opts || {};
      if (sN >= MAX_CLUSTERS) return false;
      if (used.has(el) || !visible(el)) return false;
      const t = text(el);
      if (t.length < 40) return false; // too small to be worth extracting
      // skip if an ancestor OR descendant is already a cluster (no nesting dup)
      let p = el.parentElement;
      while (p) { if (used.has(p)) return false; p = p.parentElement; }
      if (el.querySelector && el.querySelector('[data-goldie-tag^=s]')) return false;
      const label = labelFor(el);
      // Quality gate: must have a real label, UNLESS it's a dense data structure
      // (a table with header cells, or a strong repeated-row list).
      if (!label && !opts.allowUnlabeled) return false;
      if (isBlobWrapper(el, t)) return false;
      used.add(el);
      const tag = 's' + (++sN);
      el.setAttribute('data-goldie-tag', tag);
      clusters.push({ tag, kind, label: label || kind, text: cap(t, CLUSTER_TEXT_CAP), rect: rectOf(el) });
      return true;
    };

    // 1) DATA tables only — must have header cells or a caption/label. Layout
    //    tables (no th, no caption, no heading) are skipped as noise.
    for (const el of document.querySelectorAll('table, [role=table], [role=grid]')) {
      if (sN >= MAX_CLUSTERS) break;
      const hasHeaders = el.querySelector && (el.querySelector('th, thead, [role=columnheader]') || el.querySelector('caption'));
      addCluster(el, 'table', { allowUnlabeled: !!hasHeaders });
    }

    // 2) Repeated-sibling groups (lists): a parent with >=3 similar children.
    //    Strong repetition is allowed even without a label (it's clearly a list).
    const sig = (el) => el.tagName + '.' + (el.className && typeof el.className === 'string' ? el.className.split(/\\s+/)[0] : '');
    const containers = document.querySelectorAll('ul, ol, [role=list], section');
    for (const parent of containers) {
      if (sN >= MAX_CLUSTERS) break;
      if (used.has(parent)) continue;
      const kids = Array.from(parent.children).filter((k) => k.getBoundingClientRect().height > 4);
      if (kids.length < 3) continue;
      const sigs = {};
      for (const k of kids) { const s = sig(k); sigs[s] = (sigs[s] || 0) + 1; }
      const top = Math.max(0, ...Object.values(sigs));
      if (top >= 3 && top >= kids.length * 0.6) addCluster(parent, 'list', { allowUnlabeled: true });
    }

    // 3) Heading-delimited blocks — only for tighter wrappers (section/article),
    //    not page-spanning main/div, and only when labeled by their heading.
    for (const h of document.querySelectorAll('h2, h3')) {
      if (sN >= MAX_CLUSTERS) break;
      const parent = h.parentElement;
      if (!parent || used.has(parent)) continue;
      if (/^(SECTION|ARTICLE)$/.test(parent.tagName)) {
        const t = text(parent);
        if (t.length > 80 && t.length < 4000) addCluster(parent, 'section');
      }
    }

    const title = (document.title || '').trim();
    return { title, components, clusters };
  })()`;
}

/**
 * In-page JS that paints the persistent index overlay. Reads the
 * data-goldie-tag attributes set by the index pass and draws one labeled,
 * pass-through box per tag — components (cN) ringed in indigo, clusters (sN) in
 * amber. The whole layer is pointer-events:none so the page stays fully usable.
 * Re-running replaces the prior overlay.
 */
function overlayExpression(): string {
  return `(() => {
    const ID = 'goldie-overlay-root';
    const old = document.getElementById(ID);
    if (old) old.remove();
    const root = document.createElement('div');
    root.id = ID;
    root.setAttribute('data-goldie-tag', ''); // mark so index never re-tags it
    root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483646;';
    const tagged = document.querySelectorAll('[data-goldie-tag]:not(#' + ID + ')');
    for (const el of tagged) {
      const tag = el.getAttribute('data-goldie-tag');
      if (!tag) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      const isCluster = tag[0] === 's';
      const color = isCluster ? '251,191,36' : '129,140,248';
      const box = document.createElement('div');
      box.style.cssText =
        'position:fixed;left:' + r.left + 'px;top:' + r.top + 'px;width:' + r.width + 'px;height:' + r.height + 'px;' +
        'border:1.5px solid rgba(' + color + ',0.9);border-radius:4px;box-sizing:border-box;' +
        'background:rgba(' + color + ',0.07);pointer-events:none;';
      const lbl = document.createElement('div');
      lbl.textContent = tag;
      lbl.style.cssText =
        'position:absolute;top:-1px;left:-1px;font:600 10px/1.4 ui-monospace,monospace;' +
        'padding:0 4px;color:#0b0d10;background:rgba(' + color + ',0.95);border-radius:3px 0 4px 0;';
      box.appendChild(lbl);
      root.appendChild(box);
    }
    document.documentElement.appendChild(root);
    return tagged.length;
  })()`;
}
