import { FunctionCallingConfigMode, GoogleGenAI, Type } from "@google/genai";
import type { PlanInput, PlanResult, Planner } from "../orchestrator/types";
import { parseAction } from "./parse-action";
import { SYSTEM_PROMPT, buildPlanMessage } from "./prompt";

/**
 * Planner backed by Google Gemini (default: Gemini 3 Flash). Uses a single
 * function declaration so the model returns a structured Action, mirroring the
 * Anthropic planner's behavior.
 */
export class GeminiPlanner implements Planner {
  readonly id = "gemini";
  private client: GoogleGenAI;
  private model: string;

  constructor(apiKey: string, model = "gemini-3-flash") {
    this.client = new GoogleGenAI({ apiKey });
    this.model = model;
  }

  async plan(input: PlanInput): Promise<PlanResult> {
    const res = await this.client.models.generateContent({
      model: this.model,
      contents: buildPlanMessage(input),
      config: {
        systemInstruction: SYSTEM_PROMPT,
        tools: [{ functionDeclarations: [ACT_DECLARATION] }],
        toolConfig: {
          functionCallingConfig: { mode: FunctionCallingConfigMode.ANY },
        },
      },
    });

    const call = res.functionCalls?.[0];
    if (!call) throw new Error("Gemini planner returned no function call");
    const meta = res.usageMetadata;
    return {
      action: parseAction(call.args),
      usage: meta
        ? {
            input: meta.promptTokenCount ?? 0,
            output: meta.candidatesTokenCount ?? 0,
          }
        : undefined,
    };
  }
}

// Gemini uses its own Schema enum types (Type.*) rather than raw JSON Schema.
const ACT_DECLARATION = {
  name: "act",
  description: "Take the single next action.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      type: {
        type: Type.STRING,
        enum: ["navigate", "click", "type", "finish", "answer"],
        description: "The single action to take next.",
      },
      url: { type: Type.STRING, description: "For 'navigate': the URL." },
      id: {
        type: Type.NUMBER,
        description: "For 'click'/'type': element id from the current outline.",
      },
      text: { type: Type.STRING, description: "For 'type': text to enter." },
      submit: {
        type: Type.BOOLEAN,
        description: "For 'type': press Enter to submit after typing.",
      },
      answer: {
        type: Type.STRING,
        description: "For 'finish'/'answer': the final answer for the user.",
      },
      reason: {
        type: Type.STRING,
        description: "One short phrase: why this action.",
      },
    },
    required: ["type"],
  },
};
