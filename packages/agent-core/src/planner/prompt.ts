import type { PlanInput } from "../orchestrator/types";

/**
 * The shared planner contract. Both the Anthropic and Gemini planners use this
 * system prompt and the same Action JSON shape, so behavior is consistent
 * across providers — only the transport differs.
 */
export const SYSTEM_PROMPT = `You are Goldie's browsing planner. You decide ONE next action at a time to accomplish the user's goal, then you are shown the resulting page and decide again.

Each turn you are shown the page in two parts: an OUTLINE where every interactable element has a numbered (id) you act on, and a "READABLE CONTENT" block containing the page's full visible text (paragraphs, tables, labeled values like prices/metrics). You cannot invent ids; only use ids present in the CURRENT outline.

IMPORTANT: the READABLE CONTENT block already contains the WHOLE page's text, not just the top — it is captured regardless of scroll position. If the information you need is anywhere on the page, it is in that block now. Do NOT scroll to "reveal more text"; scrolling will not add content you can already read. Read the block and, if it answers the goal, FINISH.

Rules:
- If the goal needs no web browsing (general question, chat), respond with the "answer" action directly. Do not browse unnecessarily.
- To browse, start with a "navigate" action to a relevant URL.
- After ANY action you are automatically shown the resulting page outline next turn. NEVER repeat the action you just took — especially do not navigate to a URL you already navigated to. If the outline you were just given already lets you answer the goal, FINISH now; do not take another action first.
- Use "click" / "type" with an element id from the current outline. For search boxes, "type" with submit:true to run the search.
- The READABLE CONTENT block is the full page text already — do NOT scroll to read more. Only use "scroll" to bring a specific interactable element into view before clicking it (pass its id); never scroll the viewport hoping text appears.
- If the page outline says it is blank / has no readable content, do NOT scroll — there is nothing to reveal. Navigate to a different, content-rich URL instead. Never scroll a blank page hoping content appears.
- Prefer navigating directly to a site that has the answer (e.g. a news site, a specific domain, Wikipedia) over searching on a general search engine, whose results pages are often unreadable to you.
- Element ids change between pages — always use ids from the latest outline.
- When the current page already contains enough to answer the goal, respond with the "finish" action and a clear, well-written answer for the user. Synthesize; don't dump raw page text. Prefer finishing early over taking extra steps.
- Be efficient. Take the single most direct action toward the goal each turn. Never repeat a prior action (failed OR successful) identically.

You must respond with exactly one action via the provided schema/tool.`;

/** JSON Schema for the Action — used for tool-calling on both providers. */
export const ACTION_SCHEMA = {
  type: "object",
  properties: {
    type: {
      type: "string",
      enum: ["navigate", "click", "type", "scroll", "finish", "answer"],
      description: "The single action to take next.",
    },
    url: { type: "string", description: "For 'navigate': the URL to load." },
    id: {
      type: "number",
      description:
        "For 'click'/'type': the element id from the current outline. For 'scroll': optional element to scroll into view.",
    },
    text: { type: "string", description: "For 'type': the text to enter." },
    direction: {
      type: "string",
      enum: ["down", "up"],
      description: "For 'scroll': which way to move the viewport (default down).",
    },
    submit: {
      type: "boolean",
      description: "For 'type': press Enter to submit after typing.",
    },
    answer: {
      type: "string",
      description:
        "For 'finish'/'answer': the final answer to show the user.",
    },
    reason: {
      type: "string",
      description: "One short phrase: why this action (shown as activity).",
    },
  },
  required: ["type"],
  additionalProperties: false,
} as const;

/** Build the user-turn content: the goal, the current page, and history. */
export function buildPlanMessage(input: PlanInput): string {
  const parts: string[] = [];

  // Prior-conversation context (turn 1 only). Lets follow-ups like "open it"
  // resolve against earlier turns without re-sending past page summaries.
  if (input.conversation) {
    parts.push(input.conversation);
    parts.push("");
  }
  if (input.browserState) {
    parts.push(input.browserState);
  }

  parts.push(`GOAL: ${input.goal}`);
  parts.push(`STEP ${input.step} of ${input.maxSteps}.`);

  if (input.history.length > 0) {
    parts.push("\nSO FAR:");
    for (const h of input.history) {
      parts.push(`- ${describeAction(h)} → ${h.outcome}`);
    }
  }

  if (input.page) {
    parts.push(
      `\nCURRENT PAGE (${input.page.elementCount} interactable elements):`,
    );
    parts.push(input.page.summary);
  } else {
    parts.push("\nNo page is loaded yet.");
  }

  parts.push("\nDecide the single next action.");
  return parts.join("\n");
}

function describeAction(h: { action: { type: string } }): string {
  const a = h.action as Record<string, unknown>;
  switch (a.type) {
    case "navigate":
      return `navigate ${a.url}`;
    case "click":
      return `click ${a.id}`;
    case "type":
      return `type "${a.text}" into ${a.id}`;
    case "scroll":
      return a.id !== undefined
        ? `scroll element ${a.id} into view`
        : `scroll ${a.direction ?? "down"}`;
    default:
      return String(a.type);
  }
}
