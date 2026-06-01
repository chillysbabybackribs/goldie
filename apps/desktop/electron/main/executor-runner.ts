import Anthropic from "@anthropic-ai/sdk";
import {
  Executor,
  parsePlan,
  coerceStep,
  buildPlanPrompt,
  buildAssistPrompt,
  PLAN_SYSTEM_PROMPT,
  PLAN_SCHEMA,
  ASSIST_SYSTEM_PROMPT,
  ASSIST_SCHEMA,
  type AgentEvent,
  type PageIndex,
  type PlanStep,
} from "@goldie/agent-core";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import { getApiKey } from "./config";
import { ElectronCdpDriver } from "./cdp-driver";
import type { BrowserManager } from "./browser";

/**
 * The PLAN→EXECUTE runner — the A/B challenger to AgentRunner's orchestrator.
 * The LLM plans ONCE, the deterministic Executor runs the plan on its own, and
 * the LLM is consulted again only to (a) repair a stuck step or (b) synthesize
 * the final answer. Token cost = 1 plan + N assists (ideally 0) + 1 synthesis.
 *
 * Uses the Anthropic SDK directly for the three LLM touchpoints, mirroring
 * AnthropicPlanner. Reports usage so we can A/B against the orchestrator.
 */
export class ExecutorRunner {
  constructor(private browser: BrowserManager) {}

  async run(
    task: string,
    onEvent: (event: AgentEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const apiKey = getApiKey("anthropic");
    if (!apiKey) {
      onEvent({ type: "error", message: "No Anthropic API key configured." });
      return;
    }
    const client = new Anthropic({ apiKey });
    const model = "claude-haiku-4-5-20251001";
    const driver = new ElectronCdpDriver(this.browser);

    const usage = { input: 0, output: 0, calls: 0 };
    const trace: string[] = [
      "==============================================================================",
      "GOLDIE EXECUTOR TRACE (plan → execute)",
      "==============================================================================",
      `GOAL: ${task}`,
      "",
    ];
    const addUsage = (
      label: string,
      u: { input_tokens: number; output_tokens: number },
    ) => {
      usage.input += u.input_tokens;
      usage.output += u.output_tokens;
      usage.calls += 1;
      trace.push(`[LLM ${usage.calls}] ${label} — ${u.input_tokens} in / ${u.output_tokens} out`);
      onEvent({ type: "usage", usage: { ...usage } });
    };

    // ---- PLAN (one call) ----
    onEvent({ type: "thinking" });
    let planRaw: unknown;
    try {
      const res = await client.messages.create({
        model,
        max_tokens: 1024,
        system: PLAN_SYSTEM_PROMPT,
        tools: [
          {
            name: "plan",
            description: "Produce the ordered semantic plan.",
            input_schema: PLAN_SCHEMA as unknown as Anthropic.Tool.InputSchema,
          },
        ],
        tool_choice: { type: "tool", name: "plan" },
        messages: [{ role: "user", content: buildPlanPrompt(task) }],
      });
      addUsage("plan", res.usage);
      const tu = res.content.find((b) => b.type === "tool_use");
      planRaw = tu && tu.type === "tool_use" ? tu.input : {};
    } catch (err) {
      onEvent({ type: "error", message: errMsg(err) });
      return;
    }
    const plan = parsePlan(task, planRaw);
    trace.push("", "PLAN:");
    plan.steps.forEach((s, i) =>
      trace.push(
        `  ${i + 1}. ${s.kind}${s.url ? ` ${s.url}` : ""}${s.query ? ` "${s.query}"` : ""}${s.target ? ` → "${s.target}"` : ""}`,
      ),
    );
    trace.push("", "EXECUTION:");
    // Surface the plan as activity so it's visible/traceable.
    onEvent({
      type: "action",
      step: 0,
      action: { type: "answer", answer: `PLAN: ${plan.steps.map((s) => s.kind + (s.target ? ` "${s.target}"` : s.url ? ` ${s.url}` : s.query ? ` "${s.query}"` : "")).join(" → ")}` },
    });

    // The first browser-bound step opens the panel.
    let browsed = false;
    const ensureBrowsing = () => {
      if (!browsed) {
        browsed = true;
        onEvent({ type: "browsing-started" });
      }
    };

    // ---- ASSIST (per stuck step) ----
    const assist = async (args: {
      goal: string;
      stuck: PlanStep;
      reason: string;
      index: PageIndex;
      candidates?: string[];
    }): Promise<PlanStep> => {
      onEvent({ type: "thinking" });
      try {
        const res = await client.messages.create({
          model,
          max_tokens: 512,
          system: ASSIST_SYSTEM_PROMPT,
          tools: [
            {
              name: "fix_step",
              description: "Return one corrected step.",
              input_schema: ASSIST_SCHEMA as unknown as Anthropic.Tool.InputSchema,
            },
          ],
          tool_choice: { type: "tool", name: "fix_step" },
          messages: [
            {
              role: "user",
              content: buildAssistPrompt(
                args.goal,
                args.stuck,
                args.reason,
                args.index,
                args.candidates,
              ),
            },
          ],
        });
        addUsage(`assist (stuck: ${args.reason})`, res.usage);
        const tu = res.content.find((b) => b.type === "tool_use");
        const fixed = tu && tu.type === "tool_use" ? coerceStep(tu.input) : null;
        return fixed ?? { kind: "finish" };
      } catch {
        return { kind: "finish" };
      }
    };

    // ---- SYNTHESIZE (one call) ----
    const synthesize = async (args: {
      goal: string;
      gathered: string[];
    }): Promise<string> => {
      onEvent({ type: "thinking" });
      const body =
        args.gathered.length > 0
          ? args.gathered.join("\n\n---\n\n").slice(0, 8000)
          : "(no content was extracted)";
      try {
        const res = await client.messages.create({
          model,
          max_tokens: 1024,
          system:
            "You answer the user's goal from the gathered page content below. Be clear and well-written; synthesize, don't dump. If the content is insufficient, say what's missing.",
          messages: [
            {
              role: "user",
              content: `GOAL: ${args.goal}\n\nGATHERED CONTENT:\n${body}\n\nAnswer the goal.`,
            },
          ],
        });
        addUsage("synthesize", res.usage);
        const text = res.content.find((b) => b.type === "text");
        return text && text.type === "text" ? text.text : "(no answer)";
      } catch (err) {
        return `Could not synthesize an answer: ${errMsg(err)}`;
      }
    };

    // ---- EXECUTE ----
    const executor = new Executor(driver);
    try {
      const result = await executor.run(plan, {
        assist,
        synthesize,
        signal,
        onEvent: (e) => {
          if (e.type === "action") ensureBrowsing();
          if (e.message) {
            const glyph =
              e.type === "stuck" ? "  ⚠ stuck: " :
              e.type === "assisted" ? "  ↳ assisted: " :
              e.type === "extracted" ? "  ✓ " :
              e.type === "error" ? "  ✗ " : "  · ";
            trace.push(glyph + e.message);
            // Map executor events to activity the renderer already understands.
            onEvent({ type: "observation", outcome: e.message });
          }
        },
      });
      onEvent({ type: "answer", text: result.answer });

      // ---- write the A/B trace ----
      trace.push("");
      trace.push("==============================================================================");
      trace.push("TOTALS (executor)");
      trace.push("==============================================================================");
      trace.push(`  LLM calls:      ${usage.calls}  (1 plan + ${result.assistCalls} assist + 1 synth)`);
      trace.push(`  input tokens:   ${usage.input.toLocaleString()}`);
      trace.push(`  output tokens:  ${usage.output.toLocaleString()}`);
      trace.push(`  plan steps:     ${plan.steps.length}`);
      trace.push(`  steps run:      ${result.stepsRun}`);
      trace.push(`  extracted:      ${result.gathered.length} cluster(s)`);
      trace.push("");
      trace.push("FINAL ANSWER:");
      trace.push(result.answer.slice(0, 3000));
      trace.push("");
      try {
        const path = join(app.getPath("userData"), "goldie-executor-trace.txt");
        writeFileSync(path, trace.join("\n"), "utf8");
        console.log(`[executor] trace -> ${path}`);
      } catch (e) {
        console.log(`[executor] trace write failed: ${String(e)}`);
      }
      console.log(
        `[executor] done — ${plan.steps.length} steps, ${result.assistCalls} assists, ${usage.calls} LLM calls · ${usage.input} in · ${usage.output} out`,
      );
    } catch (err) {
      onEvent({ type: "error", message: errMsg(err) });
    }
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
