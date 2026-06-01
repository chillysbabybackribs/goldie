import type { BrowserDriver } from "../driver/browser-driver";
import type { PageIndex } from "../perception/page-index";
import { resolveStep } from "./resolve";
import type { Plan, PlanStep, Resolution } from "./types";

/**
 * THE AUTONOMOUS EXECUTOR — the inverted control flow. The executor DRIVES; the
 * LLM only assists. Given a plan (produced once up front), it runs each step on
 * its own against the live page's harvested descriptor map: resolve → act,
 * resolve → act. It holds durable state (current step, gathered content) so a
 * phone-home is a RESUME, not a restart.
 *
 * When the deterministic resolver returns "stuck", the executor calls `assist`
 * (one targeted LLM call) to repair JUST that step, then continues from exactly
 * where it paused — accumulated progress intact. A clean run never calls the LLM
 * mid-flight at all; cost = 1 plan + 1 synthesis, plus an assist only per stuck
 * step.
 */

export interface ExecutorEvent {
  type: "step" | "action" | "extracted" | "stuck" | "assisted" | "done" | "error";
  message?: string;
  step?: PlanStep;
  stepIndex?: number;
}

export interface AssistFn {
  /** Repair one stuck step given the current page map. Returns a new step. */
  (args: {
    goal: string;
    stuck: PlanStep;
    reason: string;
    index: PageIndex;
    candidates?: string[];
  }): Promise<PlanStep>;
}

export interface SynthesizeFn {
  /** Produce the final answer from the goal + gathered content. */
  (args: { goal: string; gathered: string[] }): Promise<string>;
}

export interface ExecuteOptions {
  assist: AssistFn;
  synthesize: SynthesizeFn;
  onEvent?: (e: ExecutorEvent) => void;
  /** Max assist calls per step before giving up on it (avoid infinite help). */
  maxAssistPerStep?: number;
  signal?: AbortSignal;
}

export interface ExecuteResult {
  answer: string;
  gathered: string[];
  /** Counts for A/B vs the orchestrator: LLM calls = 1 plan + assists + 1 synth. */
  assistCalls: number;
  stepsRun: number;
}

export class Executor {
  constructor(private driver: BrowserDriver) {}

  async run(plan: Plan, opts: ExecuteOptions): Promise<ExecuteResult> {
    const emit = (e: ExecutorEvent) => opts.onEvent?.(e);
    const maxAssist = opts.maxAssistPerStep ?? 2;
    const gathered: string[] = [];
    let assistCalls = 0;
    let stepsRun = 0;

    for (let i = 0; i < plan.steps.length; i++) {
      if (opts.signal?.aborted) break;
      let step = plan.steps[i];
      emit({ type: "step", step, stepIndex: i, message: step.note });

      // Resolve → (assist if stuck) → resolve again, up to maxAssist times.
      let resolution = await this.resolve(step);
      let attempts = 0;
      while (resolution.status === "stuck" && attempts < maxAssist) {
        if (opts.signal?.aborted) break;
        emit({ type: "stuck", step, stepIndex: i, message: resolution.reason });
        const index = await this.driver.pageIndex();
        step = await opts.assist({
          goal: plan.goal,
          stuck: step,
          reason: resolution.reason,
          index,
          candidates: resolution.candidates,
        });
        assistCalls++;
        attempts++;
        emit({ type: "assisted", step, stepIndex: i, message: step.note });
        resolution = await this.resolve(step);
      }

      if (resolution.status === "stuck") {
        // Couldn't unblock even with help — record and move on (don't restart).
        emit({
          type: "error",
          step,
          stepIndex: i,
          message: `gave up on step: ${resolution.reason}`,
        });
        continue;
      }

      await this.act(resolution, gathered, emit, i);
      stepsRun++;
    }

    emit({ type: "step", message: "synthesizing answer" });
    const answer = await opts.synthesize({ goal: plan.goal, gathered });
    emit({ type: "done" });
    return { answer, gathered, assistCalls, stepsRun };
  }

  /** Resolve a step against a FRESH page index (so the map is current). */
  private async resolve(step: PlanStep): Promise<Resolution> {
    // navigate/search/finish don't need the page map; resolve directly.
    if (step.kind === "navigate" || step.kind === "search" || step.kind === "finish") {
      return resolveStep({ step, index: emptyIndex() });
    }
    const index = await this.driver.pageIndex();
    return resolveStep({ step, index });
  }

  /** Perform a resolved action and accumulate any extracted content. */
  private async act(
    res: Resolution,
    gathered: string[],
    emit: (e: ExecutorEvent) => void,
    stepIndex: number,
  ): Promise<void> {
    switch (res.status) {
      case "navigate":
        await this.driver.navigate(res.url);
        emit({ type: "action", stepIndex, message: `navigated to ${res.url}` });
        return;
      case "search":
        await this.driver.search(res.query);
        emit({ type: "action", stepIndex, message: `searched "${res.query}"` });
        return;
      case "click":
        await this.driver.click(res.backendNodeId);
        emit({
          type: "action",
          stepIndex,
          message: `clicked "${res.matchedDescriptor}"`,
        });
        return;
      case "extract":
        gathered.push(`[${res.label}]\n${res.text}`);
        emit({
          type: "extracted",
          stepIndex,
          message: `extracted "${res.label}" (${res.text.length} chars)`,
        });
        return;
      case "finish":
      case "stuck":
        return;
    }
  }
}

function emptyIndex(): PageIndex {
  return { url: "", title: "", components: [], clusters: [] };
}
