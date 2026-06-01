import type { BrowserDriver } from "../driver/browser-driver";
import { perceive } from "../perception";
import type { PageView } from "../perception/types";
import type {
  Action,
  AgentEvent,
  PlanInput,
  Planner,
  RunOptions,
  RunResult,
  StepRecord,
  TokenUsage,
} from "./types";

const DEFAULT_MAX_STEPS = 12;

/** Loose URL equality: same host + path, ignoring trailing slash and protocol. */
function sameUrl(a: string, b: string): boolean {
  const norm = (u: string): string => {
    try {
      const p = new URL(u);
      return (p.host + p.pathname).replace(/\/$/, "").toLowerCase();
    } catch {
      return u.replace(/\/$/, "").toLowerCase();
    }
  };
  return norm(a) === norm(b);
}

/** Thrown by a driver when a backend node id no longer resolves. */
function isStaleNodeError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /No node (with given id|found for given backend id)/i.test(msg);
}

/**
 * The Plan → Act → Observe loop. Holds the strict separation our architecture
 * requires: the planner (LLM) only ever consumes a PageView summary and emits a
 * structured Action; this loop does all the deterministic driving.
 *
 * STALE-ID DISCIPLINE (the fix): every iteration re-snapshots and rebuilds a
 * fresh PageView.byId BEFORE resolving the planner's chosen id. A byId map is
 * never carried across an action that could change the page. And if an Act
 * still hits a stale-node error (page mutated mid-snapshot), we re-snapshot and
 * re-plan rather than crash.
 */
export class Orchestrator {
  constructor(
    private planner: Planner,
    private driver: BrowserDriver,
  ) {}

  async run(goal: string, options: RunOptions = {}): Promise<RunResult> {
    const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
    const emit = (e: AgentEvent) => options.onEvent?.(e);
    const history: StepRecord[] = [];
    const usage: TokenUsage = {
      input: 0,
      output: 0,
      calls: 0,
      cacheRead: 0,
      cacheWrite: 0,
    };
    let browsed = false;
    let page: PageView | null = null;

    // Inject the session context only on the planner's FIRST turn — it's prior
    // context, not per-step state, so we don't re-send it every turn.
    let firstTurn = true;
    const plan = async (input: PlanInput): Promise<Action> => {
      emit({ type: "thinking" });
      const seeded: PlanInput = firstTurn
        ? {
            ...input,
            conversation: options.history,
            browserState: options.browserState,
          }
        : input;
      firstTurn = false;
      const result = await this.planner.plan(seeded);
      if (result.usage) {
        usage.input += result.usage.input;
        usage.output += result.usage.output;
        usage.cacheRead = (usage.cacheRead ?? 0) + (result.usage.cacheRead ?? 0);
        usage.cacheWrite =
          (usage.cacheWrite ?? 0) + (result.usage.cacheWrite ?? 0);
        usage.calls += 1;
        emit({ type: "usage", usage: { ...usage } });
      }
      return result.action;
    };

    // If the browser is already on a page, observe it up front so the planner
    // can decide to reuse it (per the "let the planner decide" design).
    if (options.startWithCurrentPage) {
      try {
        page = await this.observe();
        browsed = true;
      } catch {
        page = null;
      }
    }

    for (let step = 1; step <= maxSteps; step++) {
      if (options.signal?.aborted) {
        return { answer: "Stopped.", steps: history, browsed, usage };
      }

      // OBSERVE — once browsing, always a FRESH snapshot so `page.byId` is valid
      // for exactly this turn's decision. (Skipped on the turn right after the
      // up-front observe above, which already produced a fresh page.)
      if (browsed && !(step === 1 && page)) {
        page = await this.observe();
      }

      const action = await plan({ goal, page, history, step, maxSteps });
      emit({ type: "action", action, step });

      // ACT
      if (action.type === "answer" || action.type === "finish") {
        emit({ type: "answer", text: action.answer });
        return { answer: action.answer, steps: history, browsed, usage };
      }

      // The first browser-bound action opens the panel.
      if (!browsed) {
        browsed = true;
        emit({ type: "browsing-started" });
      }

      const outcome = await this.act(action, page);
      history.push({ action, outcome });
      emit({ type: "observation", outcome });
    }

    // Out of steps — ask the planner for a final answer from what it has.
    const wrapUp = await plan({
      goal,
      page: browsed ? page : null,
      history,
      step: maxSteps,
      maxSteps,
    });
    const answer =
      wrapUp.type === "answer" || wrapUp.type === "finish"
        ? wrapUp.answer
        : "I wasn't able to finish within the step limit.";
    emit({ type: "answer", text: answer });
    return { answer, steps: history, browsed, usage };
  }

  /** Fresh snapshot → perceived page. */
  private async observe(): Promise<PageView> {
    const snapshot = await this.driver.snapshot();
    return perceive(snapshot);
  }

  /**
   * Execute one Action deterministically. Resolves an element id through the
   * CURRENT page's byId map only. On a stale-node error, re-snapshots and
   * retries once against the fresh map before giving up.
   */
  private async act(action: Action, page: PageView | null): Promise<string> {
    switch (action.type) {
      case "navigate": {
        // Hard guard against redundant navigation: if we're already on this
        // URL, skip the reload and nudge the planner to use the current page.
        if (page && sameUrl(page.url, action.url)) {
          return `already on ${action.url} — use the current page to answer or act`;
        }
        await this.driver.navigate(action.url);
        return `navigated to ${action.url}`;
      }

      case "click":
        return this.withFreshResolve(page, action.id, async (backendId) => {
          await this.driver.click(backendId);
          return `clicked element ${action.id}`;
        });

      case "type":
        return this.withFreshResolve(page, action.id, async (backendId) => {
          await this.driver.type(backendId, action.text);
          if (action.submit) await this.driver.pressEnter(backendId);
          return `typed into element ${action.id}${action.submit ? " and submitted" : ""}`;
        });

      case "scroll": {
        // Element-targeted scroll: bring a specific id into view.
        if (action.id !== undefined) {
          return this.withFreshResolve(page, action.id, async (backendId) => {
            await this.driver.scrollIntoView(backendId);
            return `scrolled element ${action.id} into view`;
          });
        }
        // Viewport scroll: no element needed, just move the page.
        const direction = action.direction ?? "down";
        await this.driver.scroll(direction);
        return `scrolled ${direction}`;
      }

      default:
        return "no-op";
    }
  }

  /**
   * Resolve an element id → backend node id against the given page, run the
   * driver op, and if it fails with a stale-node error, re-snapshot once and
   * retry against the fresh map. Surfaces a clear outcome the planner can act
   * on (e.g. "element 14 no longer exists").
   */
  private async withFreshResolve(
    page: PageView | null,
    id: number,
    op: (backendId: number) => Promise<string>,
  ): Promise<string> {
    const resolve = (p: PageView | null): number | undefined => p?.byId.get(id);

    let backendId = resolve(page);
    if (backendId === undefined) {
      // The planner referenced an id not in the current page → re-observe and
      // report, so the next plan works from reality.
      return `element ${id} is not on the current page`;
    }

    try {
      return await op(backendId);
    } catch (err) {
      if (!isStaleNodeError(err)) throw err;
      // Page changed under us — re-snapshot and try once more.
      const fresh = await this.observe();
      backendId = resolve(fresh);
      if (backendId === undefined) {
        return `element ${id} no longer exists after the page changed`;
      }
      try {
        return await op(backendId);
      } catch (err2) {
        if (isStaleNodeError(err2)) {
          return `element ${id} could not be acted on (page kept changing)`;
        }
        throw err2;
      }
    }
  }
}
