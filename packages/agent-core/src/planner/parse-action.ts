import type { Action } from "../orchestrator/types";

/**
 * Coerce a raw model tool-call object into a valid Action, or throw. Defensive:
 * models occasionally omit a field or send a number as a string. We normalize
 * the common cases and reject the genuinely unusable ones (the orchestrator
 * surfaces the error as a failed step rather than crashing the run).
 */
export function parseAction(raw: unknown): Action {
  if (!raw || typeof raw !== "object") {
    throw new Error("planner returned a non-object action");
  }
  const o = raw as Record<string, unknown>;
  const type = String(o.type ?? "");

  switch (type) {
    case "navigate": {
      const url = String(o.url ?? "").trim();
      if (!url) throw new Error("navigate action missing url");
      return { type, url, reason: optStr(o.reason) };
    }
    case "click": {
      const id = toNum(o.id);
      if (id === undefined) throw new Error("click action missing id");
      return { type, id, reason: optStr(o.reason) };
    }
    case "type": {
      const id = toNum(o.id);
      if (id === undefined) throw new Error("type action missing id");
      return {
        type,
        id,
        text: String(o.text ?? ""),
        submit: Boolean(o.submit),
        reason: optStr(o.reason),
      };
    }
    case "search": {
      const query = String(o.query ?? o.text ?? "").trim();
      if (!query) throw new Error("search action missing query");
      return { type, query, reason: optStr(o.reason) };
    }
    case "scroll": {
      const direction = o.direction === "up" ? "up" : "down";
      const id = toNum(o.id);
      return {
        type,
        direction,
        ...(id !== undefined ? { id } : {}),
        reason: optStr(o.reason),
      };
    }
    case "finish":
    case "answer": {
      const answer = String(o.answer ?? "").trim();
      if (!answer) throw new Error(`${type} action missing answer`);
      return { type, answer };
    }
    default:
      throw new Error(`unknown action type: "${type}"`);
  }
}

function toNum(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v)))
    return Number(v);
  return undefined;
}

function optStr(v: unknown): string | undefined {
  const s = v === undefined || v === null ? "" : String(v).trim();
  return s ? s : undefined;
}
