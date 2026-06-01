import type { PageIndex } from "../perception/page-index";
import type { Plan, PlanStep } from "./types";

/**
 * Prompts + schema for the PLAN-THEN-EXECUTE path. Two LLM touchpoints:
 *  - PLAN: once, turn the goal into an ordered list of semantic steps.
 *  - ASSIST: only when the deterministic executor gets stuck on a step — given
 *    the current page's descriptor map, repair just that step.
 *
 * The vocabulary is deliberately small and semantic (navigate/search/click/
 * extract/finish). Targets are natural-language descriptors, never element ids —
 * the deterministic resolver maps them to the live page.
 */

export const PLAN_SYSTEM_PROMPT = `You are Goldie's task PLANNER. Given a user goal, produce a short ordered PLAN of semantic steps a deterministic browser executor will carry out on its own. You are called ONCE up front — plan the whole task, then the executor runs without you unless it gets stuck.

Each step is one of:
- navigate: go to a URL (give a concrete, likely-correct URL for the goal).
- search: search for a query (used on a search engine or a site with search).
- click: activate the thing described by "target" (natural language, e.g. "the Statistics tab", "the first search result about Nebius analyst ratings").
- extract: read the content described by "target" (e.g. "valuation metrics", "the analyst ratings", "the article body").
- finish: synthesize the final answer from what was extracted.

Rules:
- Plan the most DIRECT path. Prefer navigating straight to a site likely to hold the answer over searching.
- Use natural-language targets a reader would understand — the executor resolves them against the live page. Do NOT invent element ids or selectors.
- Interleave navigate/click to REACH the right page, then extract to gather the data, then finish.
- End every plan with a single "finish" step.
- Keep it tight: 3–7 steps for most tasks.

Respond with the plan via the provided schema/tool.`;

export const PLAN_SCHEMA = {
  type: "object",
  properties: {
    steps: {
      type: "array",
      description: "Ordered semantic steps.",
      items: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: ["navigate", "search", "click", "extract", "finish"],
          },
          url: { type: "string", description: "For navigate." },
          query: { type: "string", description: "For search." },
          target: {
            type: "string",
            description:
              "For click/extract: natural-language descriptor of the target.",
          },
          note: { type: "string", description: "One short phrase: why." },
        },
        required: ["kind"],
        additionalProperties: false,
      },
    },
  },
  required: ["steps"],
  additionalProperties: false,
} as const;

/** Build the plan user message. */
export function buildPlanPrompt(goal: string): string {
  return `GOAL: ${goal}\n\nProduce the plan.`;
}

// ----- ASSIST (phone-home) -----

export const ASSIST_SYSTEM_PROMPT = `You are Goldie's executor ASSISTANT. The deterministic executor got STUCK on one step of a plan and needs a helping hand. You are shown the current page's actionable map (clickable components + extractable content clusters, each with a natural-language descriptor) and the step it couldn't resolve.

Return a SINGLE corrected step that WILL resolve against this page — pick a target that matches one of the descriptors shown, or a different kind of step (navigate/search/extract) that makes progress toward the goal. Do not restart the task; just unblock this step.

Respond with one step via the provided schema/tool.`;

export const ASSIST_SCHEMA = {
  type: "object",
  properties: {
    kind: {
      type: "string",
      enum: ["navigate", "search", "click", "extract", "finish"],
    },
    url: { type: "string" },
    query: { type: "string" },
    target: { type: "string" },
    note: { type: "string" },
  },
  required: ["kind"],
  additionalProperties: false,
} as const;

/** Build the assist user message from the stuck step + current page map. */
export function buildAssistPrompt(
  goal: string,
  stuck: PlanStep,
  reason: string,
  index: PageIndex,
  candidates?: string[],
): string {
  const parts: string[] = [];
  parts.push(`GOAL: ${goal}`);
  parts.push(`\nThe executor is stuck on this step:`);
  parts.push(`  ${JSON.stringify(stuck)}`);
  parts.push(`  reason: ${reason}`);
  if (candidates?.length) {
    parts.push(`  closest descriptors tried: ${candidates.join(" | ")}`);
  }
  parts.push(`\nCURRENT PAGE: "${index.title}" — ${index.url}`);
  parts.push(`\nCLICKABLE COMPONENTS:`);
  for (const c of index.components.slice(0, 60)) {
    parts.push(`  - ${c.kind} "${c.name}"${c.detail ? ` (${c.detail})` : ""}`);
  }
  parts.push(`\nEXTRACTABLE CONTENT:`);
  for (const s of index.clusters.slice(0, 30)) {
    parts.push(`  - ${s.kind} "${s.label}"`);
  }
  parts.push(`\nReturn one corrected step.`);
  return parts.join("\n");
}

/** Coerce a raw plan tool-call into a validated Plan. */
export function parsePlan(goal: string, raw: unknown): Plan {
  const o = (raw ?? {}) as Record<string, unknown>;
  const rawSteps = Array.isArray(o.steps) ? o.steps : [];
  const steps: PlanStep[] = [];
  for (const s of rawSteps) {
    const step = coerceStep(s);
    if (step) steps.push(step);
  }
  if (steps.length === 0 || steps[steps.length - 1].kind !== "finish") {
    steps.push({ kind: "finish", note: "synthesize answer" });
  }
  return { goal, steps };
}

/** Coerce a single raw step; returns null if unusable. */
export function coerceStep(raw: unknown): PlanStep | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const kind = String(o.kind ?? "");
  if (!["navigate", "search", "click", "extract", "finish"].includes(kind)) {
    return null;
  }
  const step: PlanStep = { kind: kind as PlanStep["kind"] };
  if (o.url) step.url = String(o.url);
  if (o.query) step.query = String(o.query);
  if (o.target) step.target = String(o.target);
  if (o.note) step.note = String(o.note);
  return step;
}
