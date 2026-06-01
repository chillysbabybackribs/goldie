import type {
  PageView,
  PerceivedNode,
  PerceivedPage,
  PerceivedRegion,
} from "./types";

/**
 * SUMMARIZE — render the organized page into the rich-but-short outline the
 * planner reads. The format is deliberately terse and stable:
 *
 *   PAGE: "Title" — host/path
 *   [nav] Optional Region Name
 *     (3) link "Orders" → app.acme/orders
 *     (4) button "New"
 *   [main]
 *     # "Open Orders (24)"
 *     (12) input "Filter" ="acme"
 *     (31) link "Order #1043 — $82" → …
 *     … +18 more links
 *
 * Each interactable shows its (id) so the planner can act by id. Long runs of
 * same-kind items are truncated with a count so token cost stays bounded on
 * heavy pages (a 16k-node Wikipedia article must not blow the budget).
 */

export interface SummarizeOptions {
  /** Max nodes rendered per region before truncating with a count. */
  maxPerRegion?: number;
  /** Hard cap on total rendered nodes across the page. */
  maxTotal?: number;
  /**
   * Visible rendered page text (from the driver) to weave in as a READABLE
   * CONTENT block — the data the a11y outline misses. Deduped against the
   * element names already shown so we don't repeat link labels.
   */
  pageText?: string;
  /** Max characters of readable content to include (token budget guard). */
  maxTextChars?: number;
}

const DEFAULTS: Required<Omit<SummarizeOptions, "pageText">> = {
  maxPerRegion: 40,
  maxTotal: 200,
  maxTextChars: 2400,
};

/** Hard per-region cap for chrome (nav/footer) so boilerplate collapses fast. */
const CHROME_REGION_CAP = 8;

/**
 * Render priority by landmark — lower sorts first. Content leads; chrome trails.
 * This is the whole of the relevance heuristic: it's deterministic, agnostic
 * (works off ARIA landmark roles, no per-site rules), and never drops anything
 * — it only reorders, so every id stays available to the planner.
 */
function regionPriority(landmark: string): number {
  switch (landmark) {
    case "main":
      return 0;
    case "section":
      return 1;
    case "": // root/body content with no explicit landmark
      return 2;
    case "search":
    case "form":
      return 3;
    case "header":
      return 4;
    case "aside":
      return 5;
    case "nav":
      return 6;
    case "footer":
      return 7;
    default:
      return 4; // unknown landmarks sit mid-pack, above nav/footer
  }
}

/** Chrome = navigation/footer boilerplate, collapsed hard to protect content. */
function isChrome(landmark: string): boolean {
  return landmark === "nav" || landmark === "footer";
}

export function summarize(
  page: PerceivedPage,
  options: SummarizeOptions = {},
): PageView {
  const opts = { ...DEFAULTS, ...options };
  const lines: string[] = [];

  lines.push(`PAGE: ${quote(page.title || "(untitled)")} — ${shortHost(page.url)}`);

  // Total interactables ACROSS THE WHOLE PAGE — reported regardless of what we
  // render, so the planner knows the true scale (and we never silently imply
  // we showed everything).
  const elementCount = page.regions.reduce(
    (sum, r) => sum + r.nodes.filter(isInteractable).length,
    0,
  );

  let total = 0;
  let hiddenRegions = 0;
  let hiddenInteractables = 0;

  // RELEVANCE-FIRST ORDER: render content-bearing regions (main/section/body,
  // then search/form, then header/aside) BEFORE chrome (nav/footer). The budget
  // is unchanged, but what fills it leads with what the goal is likely about —
  // so the model finds what it needs at the top and the repetitive nav/footer
  // boilerplate that used to dominate is collapsed at the end. Document order is
  // preserved WITHIN a tier (stable, deterministic).
  const ordered = page.regions
    .map((region, idx) => ({ region, idx }))
    .sort((a, b) => {
      const pa = regionPriority(a.region.landmark);
      const pb = regionPriority(b.region.landmark);
      return pa !== pb ? pa - pb : a.idx - b.idx;
    });

  for (const { region } of ordered) {
    const remaining = opts.maxTotal - total;
    const regionInteractables = region.nodes.filter(isInteractable).length;

    if (remaining <= 0) {
      // Page budget exhausted — account for the dropped region honestly.
      hiddenRegions++;
      hiddenInteractables += regionInteractables;
      continue;
    }

    // Chrome regions (nav/footer) collapse hard — a few items then a count —
    // so a 40-link footer can't crowd out main content. Content regions keep
    // the full per-region budget.
    const perRegionCap = isChrome(region.landmark)
      ? Math.min(opts.maxPerRegion, CHROME_REGION_CAP)
      : opts.maxPerRegion;
    const budget = Math.min(perRegionCap, remaining);
    const { rendered, body, hiddenInteractables: regionHidden } = renderRegion(
      region,
      budget,
    );
    if (body.length === 0) {
      // Nothing rendered (e.g. a region of only headings under tight budget):
      // still report any interactables it held.
      hiddenInteractables += regionInteractables;
      continue;
    }

    lines.push(regionHeader(region));
    lines.push(...body);
    total += rendered;
    hiddenInteractables += regionHidden;
  }

  if (hiddenInteractables > 0 || hiddenRegions > 0) {
    const bits: string[] = [];
    if (hiddenInteractables > 0)
      bits.push(`+${hiddenInteractables} more element(s)`);
    if (hiddenRegions > 0) bits.push(`${hiddenRegions} region(s)`);
    lines.push(`… ${bits.join(", ")} not shown (snapshot to expand)`);
  }

  // READABLE CONTENT — the visible page text the a11y outline misses (data
  // values, table cells, paragraphs). Deduped against names already in the
  // outline so we don't repeat link/heading labels, and bounded so it can't
  // bloat the payload. This is what lets the planner SEE a stock's P/E or a
  // table of metrics that the a11y tree dropped — and read a page in ONE
  // snapshot instead of scrolling for it.
  const contentText = options.pageText
    ? renderReadableContent(options.pageText, page, opts.maxTextChars)
    : "";
  if (contentText) {
    lines.push("");
    lines.push("READABLE CONTENT (visible page text):");
    lines.push(contentText);
  }

  // Nothing meaningful rendered: this page is genuinely empty or still loading.
  // Say so explicitly so the planner doesn't fabricate "scroll to reveal hidden
  // content" loops — there is nothing below the fold to reveal. Scrolling a
  // blank page does nothing; the right move is to navigate somewhere with
  // content (or reconsider the chosen site).
  if (total === 0 && !contentText) {
    lines.push(
      "(This page has no readable content — it is blank or failed to load. " +
        "Scrolling will not reveal anything. Navigate to a page that has content.)",
    );
  }

  return {
    url: page.url,
    title: page.title,
    summary: lines.join("\n"),
    byId: page.byId,
    elementCount,
  };
}

/**
 * Turn captured page text into a compact readable block: drop lines that merely
 * repeat an element already in the outline, drop trivially-short fragments,
 * collapse runs, and cap to a char budget. Keeps document order (where the data
 * actually is) and reports honest truncation.
 */
function renderReadableContent(
  pageText: string,
  page: PerceivedPage,
  maxChars: number,
): string {
  // Names already visible in the outline — skip these in the content block.
  const shown = new Set<string>();
  for (const region of page.regions) {
    for (const n of region.nodes) {
      if (n.name) shown.add(normalize(n.name));
    }
  }
  if (page.title) shown.add(normalize(page.title));

  const seen = new Set<string>();
  const kept: string[] = [];
  let used = 0;
  let dropped = 0;

  for (const raw of pageText.split("\n")) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (line.length < 2) continue;
    const key = normalize(line);
    if (seen.has(key)) continue;
    seen.add(key);
    // Skip pure-boilerplate lines already represented as elements/headings.
    if (shown.has(key)) continue;
    if (used + line.length > maxChars) {
      dropped++;
      continue;
    }
    kept.push("  " + truncateLine(line, 200));
    used += line.length;
  }

  if (kept.length === 0) return "";
  if (dropped > 0) kept.push(`  … +${dropped} more line(s) of content (read to expand)`);
  return kept.join("\n");
}

function normalize(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

function truncateLine(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function renderRegion(
  region: PerceivedRegion,
  budget: number,
): { rendered: number; body: string[]; hiddenInteractables: number } {
  const body: string[] = [];
  let rendered = 0;
  let hiddenInteractables = 0;

  // Group consecutive same-kind nodes so we can truncate a long run with a
  // count rather than listing 200 links.
  const runs = groupRuns(region.nodes);

  for (let r = 0; r < runs.length; r++) {
    const run = runs[r];

    if (rendered >= budget) {
      // Out of budget — every remaining node in every remaining run is hidden.
      for (let i = r; i < runs.length; i++) {
        hiddenInteractables += runs[i].filter(isInteractable).length;
      }
      break;
    }

    const remaining = budget - rendered;

    if (run.length === 1 || remaining >= run.length) {
      for (const n of run) {
        body.push("  " + renderNode(n));
        rendered++;
      }
    } else {
      // Render a few, then summarize the rest of this run with a count.
      const show = Math.max(remaining - 1, 1);
      for (let i = 0; i < show; i++) {
        body.push("  " + renderNode(run[i]));
        rendered++;
      }
      const hidden = run.slice(show);
      body.push(`  … +${hidden.length} more ${kindPlural(run[0].kind)}`);
      rendered++;
      hiddenInteractables += hidden.filter(isInteractable).length;
    }
  }

  return { rendered, body, hiddenInteractables };
}

/** Split a region's nodes into runs of the same kind. */
function groupRuns(nodes: PerceivedNode[]): PerceivedNode[][] {
  const runs: PerceivedNode[][] = [];
  for (const n of nodes) {
    const last = runs[runs.length - 1];
    if (last && last[0].kind === n.kind) last.push(n);
    else runs.push([n]);
  }
  return runs;
}

function renderNode(n: PerceivedNode): string {
  if (n.kind === "heading") {
    const h = "#".repeat(n.level ?? 1);
    return `${h} ${quote(n.name)}`;
  }
  if (n.kind === "text") {
    return `· ${quote(n.name)}`;
  }
  const parts = [`(${n.id})`, n.kind, quote(n.name)];
  if (n.detail) parts.push(n.kind === "link" ? `→ ${n.detail}` : n.detail);
  if (n.flags?.length) parts.push(`[${n.flags.join(",")}]`);
  return parts.join(" ");
}

function regionHeader(region: PerceivedRegion): string {
  const tag = region.landmark ? `[${region.landmark}]` : "[body]";
  return region.name ? `${tag} ${region.name}` : tag;
}

function isInteractable(n: PerceivedNode): boolean {
  return n.kind !== "heading" && n.kind !== "text" && n.kind !== "image";
}

function kindPlural(kind: string): string {
  return kind === "checkbox" ? "checkboxes" : `${kind}s`;
}

function quote(s: string): string {
  return `"${s.replace(/\s+/g, " ").trim()}"`;
}

function shortHost(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname === "/" ? "" : u.pathname;
    return u.host + path;
  } catch {
    return url;
  }
}
