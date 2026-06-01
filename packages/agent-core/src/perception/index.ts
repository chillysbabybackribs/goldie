import type { RawAXSnapshot } from "./ax-types";
import { strip } from "./strip";
import { organize } from "./organize";
import { summarize, type SummarizeOptions } from "./summarize";
import type { PageView } from "./types";

export * from "./types";
export * from "./ax-types";
export { strip } from "./strip";
export { organize } from "./organize";
export { summarize } from "./summarize";

/**
 * The full perception pipeline: raw CDP a11y snapshot → token-budgeted PageView
 * the planner reads. Pure and deterministic — same snapshot in, same view out.
 *
 * If the snapshot carries visible page `text` (the content the a11y tree drops),
 * it's woven into the summary as a READABLE CONTENT block — so data the a11y
 * tree misses (table values, labeled numbers) actually reaches the planner.
 */
export function perceive(
  snapshot: RawAXSnapshot,
  options?: SummarizeOptions,
): PageView {
  const merged: SummarizeOptions = { ...options };
  if (snapshot.text && merged.pageText === undefined) {
    merged.pageText = snapshot.text;
  }
  return summarize(organize(strip(snapshot)), merged);
}
