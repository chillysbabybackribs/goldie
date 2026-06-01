import Anthropic from "@anthropic-ai/sdk";
import type { PlanInput, PlanResult, Planner } from "../orchestrator/types";
import { parseAction } from "./parse-action";
import { ACTION_SCHEMA, SYSTEM_PROMPT, buildPlanMessage } from "./prompt";

/**
 * Planner backed by Anthropic (default model: Haiku 4.5 — fast + cheap for a
 * loop that calls the model repeatedly). Forces a single structured Action via
 * a tool with the shared ACTION_SCHEMA.
 */
export class AnthropicPlanner implements Planner {
  readonly id = "anthropic";
  private client: Anthropic;
  private model: string;

  constructor(apiKey: string, model = "claude-haiku-4-5-20251001") {
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  async plan(input: PlanInput): Promise<PlanResult> {
    // Cache the STABLE prefix: the request lays out as [system][tools][messages].
    // The system prompt and tool schema are byte-identical every turn (~789
    // tokens), so a cache_control breakpoint on each marks that whole prefix as
    // cacheable. After the first turn it's read from cache at ~10% the price;
    // only the per-turn user message (the page outline) is billed fresh.
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: 1024,
      system: [
        {
          type: "text",
          text: SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
      tools: [
        {
          name: "act",
          description: "Take the single next action.",
          input_schema: ACTION_SCHEMA as unknown as Anthropic.Tool.InputSchema,
          cache_control: { type: "ephemeral" },
        },
      ],
      tool_choice: { type: "tool", name: "act" },
      messages: [{ role: "user", content: buildPlanMessage(input) }],
    });

    const toolUse = res.content.find((b) => b.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") {
      throw new Error("Anthropic planner returned no tool call");
    }
    return {
      action: parseAction(toolUse.input),
      usage: {
        // input_tokens excludes cached reads; report cache hits/writes
        // separately so the running total reflects true fresh input.
        input: res.usage.input_tokens,
        output: res.usage.output_tokens,
        cacheRead: res.usage.cache_read_input_tokens ?? undefined,
        cacheWrite: res.usage.cache_creation_input_tokens ?? undefined,
      },
    };
  }
}
