import {
  ChatSession,
  createPlanner,
  Orchestrator,
  type AgentEvent,
  type ProviderId,
} from "@goldie/agent-core";
import { getApiKey } from "./config";
import { ElectronCdpDriver } from "./cdp-driver";
import { RunTracer } from "./run-trace";
import type { BrowserManager } from "./browser";

/** Map the renderer's model-picker label to a provider + concrete model. */
function resolveModel(label: string): { provider: ProviderId; model?: string } {
  if (/gemini/i.test(label)) return { provider: "gemini", model: "gemini-3-flash" };
  return { provider: "anthropic", model: "claude-haiku-4-5-20251001" };
}

/**
 * Runs chat turns through the agent within a PERSISTENT conversation. Holds one
 * ChatSession (compact history + live browser state) so follow-ups work
 * ("open it and summarize the comments") without re-sending past page
 * summaries. Each turn builds a fresh Orchestrator (planner from the key in
 * MAIN — never the renderer) seeded with the session.
 */
export class AgentRunner {
  private session = new ChatSession();

  constructor(private browser: BrowserManager) {}

  /** Start a new conversation (clears history). */
  reset(): void {
    this.session = new ChatSession();
  }

  async run(
    task: string,
    modelLabel: string,
    onEvent: (event: AgentEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const { provider, model } = resolveModel(modelLabel);
    const apiKey = getApiKey(provider);
    if (!apiKey) {
      onEvent({
        type: "error",
        message: `No API key configured for ${provider}. Add it to apps/desktop/.env.`,
      });
      return;
    }

    // Reflect the live page into the session before the run, so the planner's
    // first turn knows what's loaded.
    this.session.setBrowserState(this.browser.currentUrl(), this.browser.title());
    const onPage = this.session.renderBrowserState().length > 0;

    const tracer = new RunTracer();
    try {
      const planner = createPlanner(provider, apiKey, model);
      const driver = new ElectronCdpDriver(this.browser);
      const orchestrator = new Orchestrator(planner, driver);
      const result = await orchestrator.run(task, {
        onEvent,
        signal,
        history: this.session.renderHistory() || undefined,
        browserState: this.session.renderBrowserState() || undefined,
        // Let the planner decide whether to reuse the open page.
        startWithCurrentPage: onPage,
        trace: tracer.add,
      });

      // Write the human-readable run trace for inspection.
      tracer.write(task, result.answer);

      // One-line usage trace to the main-process console (dev visibility).
      const u = result.usage;
      console.log(
        `[agent] run done — ${u.calls} turns · ${u.input} in · ${u.output} out` +
          (u.cacheRead ? ` · ${u.cacheRead} cached` : "") +
          ` · browsed=${result.browsed}`,
      );

      // Distill the run into ONE compact session entry; discard the rest.
      const endedUrl = this.browser.currentUrl();
      this.session.setBrowserState(endedUrl, this.browser.title());
      this.session.record({
        user: task,
        conclusion: distill(result.answer, result.browsed, endedUrl),
      });
    } catch (err) {
      onEvent({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/** One-line conclusion stored in session history (answer gist + ending state). */
function distill(answer: string, browsed: boolean, endedUrl: string): string {
  const gist = answer.replace(/\s+/g, " ").trim().slice(0, 140);
  if (!browsed) return `answered: ${gist}`;
  const where = hostOf(endedUrl);
  return where ? `answered: ${gist} (browser on ${where})` : `answered: ${gist}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}
