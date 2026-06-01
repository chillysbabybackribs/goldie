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
 */
export function perceive(
  snapshot: RawAXSnapshot,
  options?: SummarizeOptions,
): PageView {
  return summarize(organize(strip(snapshot)), options);
}
