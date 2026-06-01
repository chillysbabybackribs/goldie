import type { PageView } from "../perception/types";

/**
 * The Action vocabulary — the planner's (LLM's) output contract. Every turn it
 * emits exactly one Action. The orchestrator executes it deterministically.
 * `id` always refers to an element id from the CURRENT PageView the planner was
 * shown; the orchestrator resolves it to a CDP backend node at act-time.
 */
export type Action =
  | { type: "navigate"; url: string; reason?: string }
  | { type: "click"; id: number; reason?: string }
  | { type: "type"; id: number; text: string; submit?: boolean; reason?: string }
  // Scroll the page to reveal more content. `direction` moves the viewport;
  // an optional `id` scrolls that element into view instead (more reliable
  // than guessing pixels). Re-snapshotting next turn shows the new content.
  | { type: "scroll"; direction?: "down" | "up"; id?: number; reason?: string }
  | { type: "finish"; answer: string }
  // Pure-chat escape hatch: no browsing needed, answer directly.
  | { type: "answer"; answer: string };

/** A record of one executed step, fed back to the planner as history. */
export interface StepRecord {
  action: Action;
  /** Short outcome note, e.g. "navigated to …", "clicked, page changed". */
  outcome: string;
}

/**
 * What a Planner sees each turn. The summary string is the rich-but-short page
 * outline from perception; history is the running list of executed steps.
 */
export interface PlanInput {
  goal: string;
  /** Null on the very first turn before any page is loaded. */
  page: PageView | null;
  history: StepRecord[];
  /** The step index (1-based), so the planner knows how far in it is. */
  step: number;
  /** Hard cap, so the planner can wrap up before being force-stopped. */
  maxSteps: number;
  /** Compact prior-conversation context (from ChatSession), turn 1 only. */
  conversation?: string;
  /** One-line note of the browser's current page (from ChatSession). */
  browserState?: string;
}

/** The planner abstraction. One implementation per provider (Anthropic/Gemini). */
export interface Planner {
  readonly id: string;
  /** Decide the next Action given the goal, current page, and history. */
  plan(input: PlanInput): Promise<PlanResult>;
}

/**
 * Events streamed from a run to the UI as it happens. The renderer turns these
 * into the assistant message + the compact activity trail.
 */
export type AgentEvent =
  | { type: "thinking" } // a planner turn started
  | { type: "action"; action: Action; step: number } // about to execute
  | { type: "observation"; outcome: string } // result of the last action
  | { type: "browsing-started" } // first browser action → UI opens the panel
  | { type: "answer"; text: string } // the final synthesized answer
  | { type: "usage"; usage: TokenUsage } // running token totals for this turn
  | { type: "error"; message: string };

/** Token counts. Summed across the planner calls within one run. */
export interface TokenUsage {
  input: number;
  output: number;
  /** Number of planner (LLM) calls made this run. */
  calls: number;
  /**
   * Cached input tokens READ this run (billed at ~10%). High after turn 1 once
   * the stable prompt prefix is cached — our signal that caching is working.
   */
  cacheRead?: number;
  /** Input tokens WRITTEN to cache this run (the one-time cache-creation cost). */
  cacheWrite?: number;
}

export interface RunOptions {
  maxSteps?: number;
  onEvent?: (event: AgentEvent) => void;
  signal?: AbortSignal;
  /**
   * Compact prior-conversation context injected into the planner's first turn
   * (rendered by ChatSession). Keeps follow-ups working without re-sending
   * past page summaries.
   */
  history?: string;
  /** A one-line note of what page the browser is currently on. */
  browserState?: string;
  /**
   * If the browser is already on a page, observe it on turn 1 so the planner
   * can choose to reuse it (per the "let the planner decide" design).
   */
  startWithCurrentPage?: boolean;
  /**
   * Optional per-turn tracer for instrumentation. Called once per planner turn
   * with exactly what was sent and decided, so a host can write a human-readable
   * run log. agent-core stays pure (no fs); the host owns persistence.
   */
  trace?: (entry: TraceEntry) => void;
}

/** One planner turn, captured for a human-readable run trace. */
export interface TraceEntry {
  step: number;
  /** The fully-rendered user message sent to the LLM this turn. */
  sentMessage: string;
  /** The action the LLM returned. */
  action: Action;
  /** Token usage for THIS turn (not cumulative). */
  turnUsage?: { input: number; output: number; cacheRead?: number };
  /** The deterministic outcome of the action (filled after act). */
  outcome?: string;
}

export interface RunResult {
  answer: string;
  steps: StepRecord[];
  /** True if the run touched the browser at all. */
  browsed: boolean;
  /** Token totals for the whole run. */
  usage: TokenUsage;
}

/**
 * A Planner may report token usage for its last call. Optional so a planner
 * that can't report usage still satisfies the interface.
 */
export interface PlanResult {
  action: Action;
  usage?: {
    input: number;
    output: number;
    /** Cached input tokens read on this call (Anthropic prompt caching). */
    cacheRead?: number;
    /** Input tokens written to cache on this call. */
    cacheWrite?: number;
  };
}
