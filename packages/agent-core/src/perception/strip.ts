import { type AXNode, type RawAXSnapshot, roleOf, nameOf } from "./ax-types";

/**
 * STRIP — drop everything a user could neither perceive nor act on.
 *
 * The accessibility tree already does most of the work: `ignored` marks nodes
 * a screen reader skips (not-rendered, aria-hidden, presentational, etc.). On
 * top of that we drop structural/layout noise roles that survive un-ignored
 * but carry no meaning on their own (inline text boxes, line breaks, layout
 * tables, anonymous generics). What remains is the set of nodes worth
 * organizing: interactables, landmarks, headings, and meaningful text.
 *
 * Returns a NodeIndex so later stages can still walk the original hierarchy
 * (kept whole) while iterating only the kept nodes.
 */

// Roles that are pure structure/noise — never meaningful on their own.
const NOISE_ROLES = new Set([
  "InlineTextBox",
  "LineBreak",
  "ListMarker",
  "none",
  "generic",
  "LayoutTable",
  "LayoutTableRow",
  "LayoutTableCell",
  "Abbr",
  "superscript",
  "subscript",
  "emphasis",
  "strong",
]);

// Interactable roles we always keep (the things the agent acts on).
export const INTERACTABLE_ROLES = new Set([
  "link",
  "button",
  "textbox",
  "searchbox",
  "combobox",
  "listbox",
  "checkbox",
  "radio",
  "switch",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "option",
  "slider",
  "spinbutton",
]);

// Landmark/section roles that give the page its outline.
export const LANDMARK_ROLES = new Set([
  "banner",
  "navigation",
  "main",
  "contentinfo",
  "search",
  "complementary",
  "region",
  "form",
]);

export interface NodeIndex {
  url: string;
  /** All nodes (unfiltered) keyed by nodeId, for hierarchy walking. */
  all: Map<string, AXNode>;
  /** The kept nodes, in document order. */
  kept: AXNode[];
}

export function strip(snapshot: RawAXSnapshot): NodeIndex {
  const all = new Map<string, AXNode>();
  for (const n of snapshot.nodes) all.set(n.nodeId, n);

  const kept: AXNode[] = [];
  for (const n of snapshot.nodes) {
    if (shouldKeep(n)) kept.push(n);
  }

  return { url: snapshot.url, all, kept };
}

function shouldKeep(n: AXNode): boolean {
  const role = roleOf(n);

  // The root carries page identity (title/url) — handle separately, not kept
  // as an element.
  if (role === "RootWebArea") return false;

  // A screen reader would skip it → so do we.
  if (n.ignored) return false;

  // Pure structural noise.
  if (NOISE_ROLES.has(role)) return false;

  // Always keep interactables (even unnamed — e.g. an icon button; we'll label
  // it from description/role downstream).
  if (INTERACTABLE_ROLES.has(role)) return true;

  // Keep landmarks for grouping.
  if (LANDMARK_ROLES.has(role)) return true;

  // Keep headings — they structure the outline.
  if (role === "heading") return true;

  // Keep meaningful static text ONLY if it has a non-trivial name. The bulk of
  // StaticText is captured under interactables; standalone text is kept sparely
  // so the summary stays short.
  if (role === "StaticText" || role === "text" || role === "paragraph") {
    return nameOf(n).length >= 2;
  }

  // Keep named images (alt text can be meaningful, e.g. a logo or chart).
  if (role === "image") return nameOf(n).length > 0;

  // Everything else (rows/cells/lists/figures/etc.) is container scaffolding we
  // don't surface directly — its useful children survive on their own.
  return false;
}
