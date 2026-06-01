import type { PageIndex } from "../perception/page-index";

/**
 * The PLAN — what the LLM produces ONCE from the goal. An ordered list of
 * semantic steps the deterministic executor carries out on its own. Steps are
 * natural-language intents, NOT element ids: the executor resolves each against
 * the live page's harvested descriptor map at execution time.
 */

/** A single semantic step in the plan. */
export interface PlanStep {
  /**
   * What kind of intent this is. Small, stable vocabulary the resolver knows:
   *  - navigate: go to a URL (or a described destination)
   *  - search:   search the current page/site for a query
   *  - click:    activate the component matching `target`
   *  - extract:  read the content cluster/section matching `target`
   *  - finish:   synthesize the answer from gathered content
   */
  kind: "navigate" | "search" | "click" | "extract" | "finish";
  /** For navigate: the URL. */
  url?: string;
  /** For search: the query. */
  query?: string;
  /**
   * For click/extract: the NATURAL-LANGUAGE descriptor of the target, in the
   * planner's words (e.g. "the Statistics tab", "valuation metrics"). The
   * resolver matches this against harvested descriptors.
   */
  target?: string;
  /** Human-readable note of why this step (shown as activity). */
  note?: string;
}

export interface Plan {
  goal: string;
  steps: PlanStep[];
}

/**
 * The result of resolving ONE step against the current page index. Either a
 * concrete resolved action the executor can perform, or "stuck" — the resolver
 * could not confidently map the step to the page, so the executor must phone
 * home to the LLM. Honest stuck-detection is the whole point: a wrong-but-
 * confident resolution silently derails the task.
 */
export type Resolution =
  | { status: "navigate"; url: string }
  | { status: "search"; query: string }
  | {
      status: "click";
      backendNodeId: number;
      tag: string;
      matchedDescriptor: string;
    }
  | {
      status: "extract";
      backendNodeId: number;
      tag: string;
      label: string;
      text: string;
    }
  | { status: "finish" }
  | {
      status: "stuck";
      /** Why we couldn't resolve — passed to the LLM when phoning home. */
      reason: string;
      /** Candidate descriptors that were close, to help the LLM disambiguate. */
      candidates?: string[];
    };

/** Inputs the resolver needs to resolve a step. */
export interface ResolveContext {
  step: PlanStep;
  index: PageIndex;
}
