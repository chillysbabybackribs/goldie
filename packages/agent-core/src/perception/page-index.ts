/**
 * The ACTIONABLE INDEX — perception restructured from a text outline into a
 * spatially-grounded map of what's on a page. It has two halves:
 *
 *  - COMPONENTS: every clickable affordance (links/buttons/inputs/tabs), each
 *    with a stable tag the agent acts on ("click c12") and a rect.
 *  - CLUSTERS: extractable content groups detected agnostically (tables, lists,
 *    cards, heading-delimited blocks), each with a tag ("extract s3"), a label,
 *    a rect, and its readable text.
 *
 * This is produced deterministically by the driver (in-page DOM pass) — NOT by
 * the a11y tree. It is BOTH the data the overlay paints on the page AND the
 * map the planner picks tags from. One artifact, two consumers.
 *
 * Coordinates are page-viewport CSS px (the same space CDP input uses), so the
 * overlay and any click resolve to the same place.
 */

export interface IndexRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A clickable/typeable affordance. */
export interface IndexComponent {
  /** Stable tag for this snapshot, e.g. "c7". The agent acts by this. */
  tag: string;
  /** Small vocabulary: link/button/input/tab/checkbox/select. */
  kind: string;
  /** Accessible name / visible label. */
  name: string;
  /** For links: href host/path. For inputs: placeholder/value. */
  detail?: string;
  rect: IndexRect;
  /** CDP backend node id — resolved at act time, never shown to the LLM. */
  backendNodeId: number;
}

/** An extractable content cluster. */
export interface IndexCluster {
  /** Stable tag for this snapshot, e.g. "s3". The agent extracts by this. */
  tag: string;
  /** What kind of cluster: table/list/card/section. */
  kind: string;
  /** A short human label (from a heading/caption), e.g. "Key Data". */
  label: string;
  rect: IndexRect;
  /** The cluster's readable text (bounded). Returned on extract. */
  text: string;
  backendNodeId: number;
}

export interface PageIndex {
  url: string;
  title: string;
  components: IndexComponent[];
  clusters: IndexCluster[];
}
