import type { Planner } from "../orchestrator/types";
import { AnthropicPlanner } from "./anthropic-planner";
import { GeminiPlanner } from "./gemini-planner";

export { AnthropicPlanner } from "./anthropic-planner";
export { GeminiPlanner } from "./gemini-planner";
export { SYSTEM_PROMPT, ACTION_SCHEMA } from "./prompt";
export { parseAction } from "./parse-action";

export type ProviderId = "anthropic" | "gemini";

/** Build the planner for a provider from its api key (+ optional model). */
export function createPlanner(
  provider: ProviderId,
  apiKey: string,
  model?: string,
): Planner {
  switch (provider) {
    case "anthropic":
      return new AnthropicPlanner(apiKey, model);
    case "gemini":
      return new GeminiPlanner(apiKey, model);
    default:
      throw new Error(`unknown provider: ${provider}`);
  }
}
