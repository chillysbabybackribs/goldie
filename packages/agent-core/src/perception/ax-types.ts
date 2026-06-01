/**
 * Types for the RAW accessibility snapshot produced by CDP
 * `Accessibility.getFullAXTree`. These mirror exactly what Chromium returns
 * (verified against real captures of news.ycombinator.com and a large
 * Wikipedia article). The perception pipeline consumes these and nothing else,
 * which keeps it independent of Electron — any driver that can produce this
 * shape (Playwright, a server, a test fixture) feeds the same pipeline.
 */

export interface AXValue {
  type: string;
  value?: unknown;
}

export interface AXProperty {
  name: string;
  value: AXValue;
}

export interface AXNode {
  nodeId: string;
  /** Absent on the root; present on every other node. */
  parentId?: string;
  childIds?: string[];
  /** True when a screen reader would skip this node (our primary noise signal). */
  ignored: boolean;
  ignoredReasons?: AXProperty[];
  role?: AXValue;
  name?: AXValue;
  description?: AXValue;
  /** The DOM node to act on via CDP. Snapshot-scoped — goes stale on navigation. */
  backendDOMNodeId?: number;
  properties?: AXProperty[];
}

export interface RawAXSnapshot {
  url: string;
  nodes: AXNode[];
}

/** Convenience: read a string-ish property value off a node. */
export function prop(node: AXNode, name: string): string | undefined {
  const p = node.properties?.find((x) => x.name === name);
  if (!p) return undefined;
  const v = p.value.value;
  return v === undefined || v === null ? undefined : String(v);
}

/** Convenience: read a boolean-ish property. */
export function boolProp(node: AXNode, name: string): boolean {
  return prop(node, name) === "true";
}

/** The node's role string, or "" if none. */
export function roleOf(node: AXNode): string {
  return node.role?.value ? String(node.role.value) : "";
}

/** The node's accessible name, trimmed, or "" if none. */
export function nameOf(node: AXNode): string {
  return node.name?.value ? String(node.name.value).trim() : "";
}
