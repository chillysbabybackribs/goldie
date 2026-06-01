/**
 * The perception model — the intermediate + output shapes the pipeline
 * produces. The planner (LLM) only ever sees a PageView: a compact, stable,
 * token-budgeted description of the page plus an id→backendNodeId map the
 * driver uses to act. The LLM picks an `id`; it never sees a selector or a
 * backend node id.
 */

/**
 * The small, stable interaction vocabulary. We collapse Chromium's ~40 ARIA
 * roles into this handful — agnostic across any web app, and all the planner
 * needs to choose an action.
 */
export type ElementKind =
  | "link"
  | "button"
  | "input" // textbox / searchbox / combobox text entry
  | "select" // combobox/listbox/menu that picks from options
  | "checkbox" // checkbox / switch / radio
  | "tab"
  | "heading"
  | "text" // meaningful static text we chose to keep
  | "image"
  | "region"; // a landmark/section container

/** A single interactable or meaningful node after strip + organize. */
export interface PerceivedNode {
  /** Stable integer id for THIS snapshot. The LLM refers to elements by this. */
  id: number;
  kind: ElementKind;
  /** Accessible name / label / text. */
  name: string;
  /** For links: the href. For inputs: current value/placeholder if any. */
  detail?: string;
  /** Heading level (1–6) when kind === "heading". */
  level?: number;
  /** State flags worth surfacing (disabled, checked, expanded, required…). */
  flags?: string[];
  /** Resolved at act-time, never shown to the LLM. */
  backendNodeId: number;
}

/** A landmark/region grouping of nodes — gives the summary its outline shape. */
export interface PerceivedRegion {
  /** Landmark label: "nav", "main", "search", "header", "footer", "aside", or "". */
  landmark: string;
  /** Optional accessible name of the region (e.g. a labelled nav). */
  name?: string;
  nodes: PerceivedNode[];
}

/**
 * The full perceived page. `regions` is the organized outline; `byId` is the
 * act-time resolution table (id → backendNodeId) the driver consumes.
 */
export interface PerceivedPage {
  url: string;
  title: string;
  regions: PerceivedRegion[];
  byId: Map<number, number>;
}

/**
 * What the planner actually receives: the rendered summary string plus the
 * resolution map. Keeping them together means a snapshot's ids and its
 * resolution table can never drift apart.
 */
export interface PageView {
  url: string;
  title: string;
  /** The rich-but-short outline the LLM reads. */
  summary: string;
  /** id → backendNodeId, for the driver to act on the LLM's chosen id. */
  byId: Map<number, number>;
  /** How many interactable nodes the summary describes. */
  elementCount: number;
}
