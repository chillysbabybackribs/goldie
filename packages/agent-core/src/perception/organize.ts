import {
  type AXNode,
  boolProp,
  nameOf,
  prop,
  roleOf,
} from "./ax-types";
import {
  INTERACTABLE_ROLES,
  LANDMARK_ROLES,
  type NodeIndex,
} from "./strip";
import type {
  ElementKind,
  PerceivedNode,
  PerceivedPage,
  PerceivedRegion,
} from "./types";

/**
 * ORGANIZE — turn the kept nodes into the structured PerceivedPage:
 *  - classify each into the small ElementKind vocabulary
 *  - assign stable integer ids to interactables (in document order)
 *  - extract detail (href / value / heading level) and state flags
 *  - group every node under its nearest landmark ancestor → the outline
 *  - build the id → backendNodeId resolution table
 *
 * IDs are assigned only to actionable/meaningful elements the planner can refer
 * to. Region containers are structure, not targets, so they carry no id.
 */

export function organize(index: NodeIndex): PerceivedPage {
  const root = findRoot(index);
  const title = root ? nameOf(root) : "";

  // Stable id counter — document order, interactables + meaningful nodes only.
  let nextId = 1;
  const byId = new Map<number, number>();

  // A link/button's accessible name usually ALSO appears as a child StaticText
  // node, which would duplicate it in the outline. Pre-collect interactable
  // names so we can drop those redundant text nodes.
  const interactableNames = new Set<string>();
  for (const n of index.kept) {
    const k = classify(n);
    if (k && k !== "region" && k !== "text" && k !== "heading") {
      const nm = displayName(n);
      if (nm) interactableNames.add(nm);
    }
  }

  // Bucket kept nodes by their nearest landmark ancestor.
  const regionOrder: string[] = [];
  const buckets = new Map<
    string,
    { landmark: string; name?: string; nodes: PerceivedNode[] }
  >();

  const bucketKeyFor = (n: AXNode): { key: string; landmark: string; name?: string } => {
    const lm = nearestLandmark(n, index);
    if (!lm) return { key: "__root__", landmark: "" };
    return {
      key: lm.nodeId,
      landmark: landmarkLabel(roleOf(lm)),
      name: nameOf(lm) || undefined,
    };
  };

  for (const n of index.kept) {
    const kind = classify(n);
    if (!kind) continue;
    // Landmark containers define buckets; they aren't emitted as nodes.
    if (kind === "region") continue;
    // Drop standalone text that merely repeats an interactable's label.
    if (kind === "text" && interactableNames.has(displayName(n))) continue;

    const node: PerceivedNode = {
      id: 0,
      kind,
      name: displayName(n),
      backendNodeId: n.backendDOMNodeId ?? -1,
    };

    const detail = detailOf(n, kind);
    if (detail) node.detail = detail;
    if (kind === "heading") {
      const lvl = Number(prop(n, "level"));
      if (lvl >= 1 && lvl <= 6) node.level = lvl;
    }
    const flags = flagsOf(n);
    if (flags.length) node.flags = flags;

    // Assign an id to everything actionable + meaningful (i.e. everything we
    // emit). Headings/text get ids too so the planner can reference them, but
    // only ones with a real backend node are resolvable.
    node.id = nextId++;
    if (node.backendNodeId >= 0) byId.set(node.id, node.backendNodeId);

    const { key, landmark, name } = bucketKeyFor(n);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { landmark, name, nodes: [] };
      buckets.set(key, bucket);
      regionOrder.push(key);
    }
    bucket.nodes.push(node);
  }

  const regions: PerceivedRegion[] = regionOrder
    .map((k) => buckets.get(k)!)
    .filter((b) => b.nodes.length > 0)
    .map((b) => ({ landmark: b.landmark, name: b.name, nodes: b.nodes }));

  return { url: index.url, title, regions, byId };
}

function findRoot(index: NodeIndex): AXNode | undefined {
  for (const n of index.all.values()) {
    if (roleOf(n) === "RootWebArea") return n;
  }
  return undefined;
}

/** Walk parentId up the FULL tree to the closest landmark, if any. */
function nearestLandmark(n: AXNode, index: NodeIndex): AXNode | undefined {
  let cur: AXNode | undefined = n.parentId
    ? index.all.get(n.parentId)
    : undefined;
  while (cur) {
    if (LANDMARK_ROLES.has(roleOf(cur))) return cur;
    cur = cur.parentId ? index.all.get(cur.parentId) : undefined;
  }
  return undefined;
}

function landmarkLabel(role: string): string {
  switch (role) {
    case "banner":
      return "header";
    case "contentinfo":
      return "footer";
    case "navigation":
      return "nav";
    case "complementary":
      return "aside";
    case "main":
      return "main";
    case "search":
      return "search";
    case "form":
      return "form";
    case "region":
      return "section";
    default:
      return role;
  }
}

/** Map a Chromium role to our small vocabulary, or null to drop. */
function classify(n: AXNode): ElementKind | null {
  const role = roleOf(n);
  if (LANDMARK_ROLES.has(role)) return "region";
  if (role === "link") return "link";
  if (role === "button") return "button";
  if (role === "textbox" || role === "searchbox" || role === "spinbutton")
    return "input";
  if (role === "combobox" || role === "listbox" || role === "slider")
    return "select";
  if (role === "checkbox" || role === "radio" || role === "switch")
    return "checkbox";
  if (
    role === "tab" ||
    role === "menuitem" ||
    role === "menuitemcheckbox" ||
    role === "menuitemradio" ||
    role === "option"
  )
    return "tab";
  if (role === "heading") return "heading";
  if (role === "image") return "image";
  if (role === "StaticText" || role === "text" || role === "paragraph")
    return "text";
  // Interactable but unmapped → treat as a button (still actionable).
  if (INTERACTABLE_ROLES.has(role)) return "button";
  return null;
}

/** A human-meaningful label, falling back to description, then a url hint. */
function displayName(n: AXNode): string {
  const name = nameOf(n);
  if (name) return name;
  const desc = n.description?.value ? String(n.description.value).trim() : "";
  if (desc) return desc;
  // Unnamed link/button (icon-only, e.g. an upvote arrow): derive a hint from
  // the url's last meaningful path segment so the planner has something to go
  // on rather than a bare "(link)".
  const url = prop(n, "url");
  if (url) {
    const seg = lastPathSegment(url);
    if (seg) return `(${seg})`;
  }
  return `(${roleOf(n)})`;
}

function lastPathSegment(url: string): string | undefined {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    const last = parts[parts.length - 1];
    if (last) return decodeURIComponent(last).slice(0, 24);
    return u.host;
  } catch {
    return undefined;
  }
}

function detailOf(n: AXNode, kind: ElementKind): string | undefined {
  if (kind === "link") {
    const url = prop(n, "url");
    return url ? shortenUrl(url) : undefined;
  }
  if (kind === "input" || kind === "select") {
    // CDP exposes current value under a "value" property on some controls.
    const v = prop(n, "value");
    if (v) return `="${truncate(v, 40)}"`;
  }
  return undefined;
}

function flagsOf(n: AXNode): string[] {
  const flags: string[] = [];
  if (boolProp(n, "disabled")) flags.push("disabled");
  if (boolProp(n, "required")) flags.push("required");
  if (boolProp(n, "readonly")) flags.push("readonly");
  if (prop(n, "checked") === "true") flags.push("checked");
  if (prop(n, "expanded") === "true") flags.push("expanded");
  if (prop(n, "expanded") === "false") flags.push("collapsed");
  if (prop(n, "selected") === "true") flags.push("selected");
  return flags;
}

function shortenUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname === "/" ? "" : u.pathname;
    return truncate(u.host + path, 48);
  } catch {
    return truncate(url, 48);
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}
