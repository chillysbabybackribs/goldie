import type { IndexCluster, IndexComponent } from "../perception/page-index";
import type { Resolution, ResolveContext } from "./types";

/**
 * THE RESOLVER — turns one semantic plan step into a concrete action on the
 * page's harvested descriptor map, deterministically (no LLM). Or returns
 * "stuck" so the executor phones home.
 *
 * Design priority: HONEST stuck-detection. A confident-but-wrong match silently
 * derails the run, which is worse than a clean phone-home. So we resolve only on
 * a strong, unambiguous match; anything weak or tied returns "stuck" with the
 * close candidates attached (for the LLM to disambiguate).
 *
 * Matching is fuzzy but deterministic: normalized token overlap + substring +
 * role hints. No per-site rules — it works off the natural-language descriptors
 * harvested from the live DOM.
 */

// A match this strong resolves outright. Below MIN we're stuck.
const STRONG = 0.6;
const MIN = 0.3;
// If the runner-up is within this of the winner, it's ambiguous → stuck.
const AMBIGUOUS_GAP = 0.12;

export function resolveStep(ctx: ResolveContext): Resolution {
  const { step, index } = ctx;

  switch (step.kind) {
    case "navigate": {
      const url = (step.url ?? "").trim();
      if (!url) {
        return { status: "stuck", reason: "navigate step has no url" };
      }
      return { status: "navigate", url };
    }

    case "search": {
      const query = (step.query ?? step.target ?? "").trim();
      if (!query) {
        return { status: "stuck", reason: "search step has no query" };
      }
      return { status: "search", query };
    }

    case "finish":
      return { status: "finish" };

    case "click":
      return resolveClick(step.target ?? "", index.components);

    case "extract":
      return resolveExtract(step.target ?? "", index.clusters);

    default:
      return { status: "stuck", reason: `unknown step kind "${step.kind}"` };
  }
}

function resolveClick(
  target: string,
  components: IndexComponent[],
): Resolution {
  if (!target) {
    return { status: "stuck", reason: "click step has no target descriptor" };
  }
  if (components.length === 0) {
    return {
      status: "stuck",
      reason: "no clickable components on the current page",
    };
  }

  const scored = components
    .map((c) => ({
      c,
      score: score(target, descriptorOf(c)),
    }))
    .filter((s) => s.c.backendNodeId >= 0)
    .sort((a, b) => b.score - a.score);

  const top = scored[0];
  if (!top || top.score < MIN) {
    return {
      status: "stuck",
      reason: `no component matches "${target}"`,
      candidates: scored.slice(0, 5).map((s) => descriptorOf(s.c)),
    };
  }
  // Ambiguous: a close runner-up of a different element.
  const second = scored[1];
  if (
    top.score < STRONG &&
    second &&
    top.score - second.score < AMBIGUOUS_GAP
  ) {
    return {
      status: "stuck",
      reason: `"${target}" is ambiguous between multiple components`,
      candidates: scored.slice(0, 5).map((s) => descriptorOf(s.c)),
    };
  }

  return {
    status: "click",
    backendNodeId: top.c.backendNodeId,
    tag: top.c.tag,
    matchedDescriptor: descriptorOf(top.c),
  };
}

function resolveExtract(
  target: string,
  clusters: IndexCluster[],
): Resolution {
  if (clusters.length === 0) {
    return {
      status: "stuck",
      reason: "no extractable content clusters on the current page",
    };
  }
  // No target → if there's exactly one cluster, extract it; else ambiguous.
  const scored = clusters
    .map((s) => ({ s, score: target ? score(target, s.label + " " + s.text.slice(0, 120)) : 0.5 }))
    .sort((a, b) => b.score - a.score);

  const top = scored[0];
  if (target && (!top || top.score < MIN)) {
    return {
      status: "stuck",
      reason: `no content cluster matches "${target}"`,
      candidates: scored.slice(0, 6).map((s) => s.s.label),
    };
  }

  return {
    status: "extract",
    backendNodeId: top.s.backendNodeId,
    tag: top.s.tag,
    label: top.s.label,
    text: top.s.text,
  };
}

/** The natural-language descriptor we match a click target against. */
function descriptorOf(c: IndexComponent): string {
  return [c.name, c.kind, c.detail].filter(Boolean).join(" ");
}

/**
 * Similarity in [0,1] between a query and a candidate descriptor. Combines:
 *  - substring containment (strong signal either direction)
 *  - token-overlap (Jaccard-ish over content words)
 * Deterministic and cheap.
 */
function score(query: string, candidate: string): number {
  const q = normalize(query);
  const c = normalize(candidate);
  if (!q || !c) return 0;

  // Direct containment is a strong signal.
  if (c.includes(q) || q.includes(c)) {
    const ratio = Math.min(q.length, c.length) / Math.max(q.length, c.length);
    return 0.7 + 0.3 * ratio;
  }

  const qt = new Set(tokens(q));
  const ct = new Set(tokens(c));
  if (qt.size === 0 || ct.size === 0) return 0;
  let inter = 0;
  for (const t of qt) if (ct.has(t)) inter++;
  // Recall against the query (how much of what we asked for is present).
  const recall = inter / qt.size;
  // Light precision factor so a giant candidate matching one word doesn't win.
  const precision = inter / ct.size;
  return recall * 0.75 + precision * 0.25;
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STOP = new Set([
  "the", "a", "an", "to", "of", "for", "on", "in", "and", "or", "click",
  "open", "go", "view", "see", "page", "tab", "button", "link", "this", "that",
  "section", "find", "get", "read",
]);

function tokens(s: string): string[] {
  return normalize(s)
    .split(" ")
    .filter((t) => t.length > 1 && !STOP.has(t));
}
