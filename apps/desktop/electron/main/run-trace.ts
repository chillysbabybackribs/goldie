import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import type { TraceEntry } from "@goldie/agent-core";

/**
 * Collects per-turn TraceEntries from one agent run and writes a single
 * human-readable .txt file at the end — no JS, no markdown, truncated so a heavy
 * page can't bloat it. The point is to SEE, per turn, exactly what was sent to
 * the LLM, what it decided, what it cost, and what happened — so we can find
 * where the tokens and turns actually go before optimizing.
 *
 * Files land in the app's userData dir (logged to the main console on write).
 */
export class RunTracer {
  private entries: TraceEntry[] = [];

  add = (entry: TraceEntry): void => {
    this.entries.push(entry);
  };

  /** Write the run to a plain-text file. Returns the path (or "" on no-op). */
  write(goal: string, finalAnswer: string): string {
    if (this.entries.length === 0) return "";

    const L: string[] = [];
    const rule = "=".repeat(78);
    const thin = "-".repeat(78);

    L.push(rule);
    L.push("GOLDIE RUN TRACE");
    L.push(rule);
    L.push(`PROMPT: ${goal}`);
    L.push(`TURNS:  ${this.entries.length}`);
    L.push("");

    let totalIn = 0;
    let totalOut = 0;
    let totalCached = 0;
    let biggestSent = 0;
    let biggestSentStep = 0;

    for (const e of this.entries) {
      const u = e.turnUsage;
      if (u) {
        totalIn += u.input;
        totalOut += u.output;
        totalCached += u.cacheRead ?? 0;
      }
      const sentTokApprox = Math.round(e.sentMessage.length / 4);
      if (sentTokApprox > biggestSent) {
        biggestSent = sentTokApprox;
        biggestSentStep = e.step;
      }

      L.push(thin);
      L.push(
        `TURN ${e.step}` +
          (u ? `   [${u.input} in / ${u.output} out${u.cacheRead ? ` / ${u.cacheRead} cached` : ""}]` : ""),
      );
      L.push(thin);
      L.push("");
      L.push(`  SENT TO LLM (~${sentTokApprox} tokens):`);
      L.push(indent(truncateBlock(e.sentMessage, 80, 4000), "    | "));
      L.push("");
      L.push(`  DECIDED: ${describeAction(e.action)}`);
      const reason = "reason" in e.action ? e.action.reason : undefined;
      if (reason) L.push(`  REASON:  ${oneLine(reason, 160)}`);
      if (e.outcome) L.push(`  OUTCOME: ${oneLine(e.outcome, 200)}`);
      L.push("");
    }

    L.push(rule);
    L.push("TOTALS");
    L.push(rule);
    L.push(`  input tokens:   ${totalIn.toLocaleString()}`);
    L.push(`  output tokens:  ${totalOut.toLocaleString()}`);
    if (totalCached) L.push(`  cached reads:   ${totalCached.toLocaleString()}`);
    L.push(`  turns:          ${this.entries.length}`);
    L.push(
      `  fattest turn:   turn ${biggestSentStep} sent ~${biggestSent.toLocaleString()} tokens`,
    );
    L.push("");
    L.push("FINAL ANSWER:");
    L.push(indent(truncateBlock(finalAnswer, 80, 3000), "  "));
    L.push("");

    const path = join(app.getPath("userData"), "goldie-run-trace.txt");
    try {
      writeFileSync(path, L.join("\n"), "utf8");
      console.log(`[trace] wrote run trace -> ${path}`);
      return path;
    } catch (err) {
      console.log(`[trace] failed to write: ${String(err)}`);
      return "";
    }
  }
}

/** Action → readable one-liner (mirrors the planner's action vocabulary). */
function describeAction(a: TraceEntry["action"]): string {
  switch (a.type) {
    case "navigate":
      return `navigate -> ${a.url}`;
    case "click":
      return `click element ${a.id}`;
    case "type":
      return `type "${oneLine(a.text, 60)}" into element ${a.id}${a.submit ? " + submit" : ""}`;
    case "search":
      return `search "${oneLine(a.query, 80)}"`;
    case "scroll":
      return a.id !== undefined
        ? `scroll element ${a.id} into view`
        : `scroll ${a.direction ?? "down"}`;
    case "finish":
    case "answer":
      return `${a.type.toUpperCase()} (answer: "${oneLine(a.answer, 80)}")`;
    default:
      return JSON.stringify(a);
  }
}

/** Collapse whitespace and hard-cap a single line. */
function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

/**
 * Truncate a multi-line block two ways so it stays readable, not PDF-sized:
 * cap each line's width, and cap the total line count (keeping head + tail).
 */
function truncateBlock(s: string, lineWidth: number, maxChars: number): string {
  let body = s;
  if (body.length > maxChars) {
    const head = body.slice(0, Math.floor(maxChars * 0.7));
    const tail = body.slice(body.length - Math.floor(maxChars * 0.2));
    body = `${head}\n    … [${s.length - maxChars} chars truncated] …\n${tail}`;
  }
  const lines = body.split("\n").map((ln) =>
    ln.length > lineWidth ? ln.slice(0, lineWidth - 1) + "…" : ln,
  );
  const maxLines = 60;
  if (lines.length > maxLines) {
    const head = lines.slice(0, 45);
    const tail = lines.slice(lines.length - 10);
    return [...head, `    … [${lines.length - 55} lines truncated] …`, ...tail].join("\n");
  }
  return lines.join("\n");
}

function indent(s: string, prefix: string): string {
  return s
    .split("\n")
    .map((ln) => prefix + ln)
    .join("\n");
}
