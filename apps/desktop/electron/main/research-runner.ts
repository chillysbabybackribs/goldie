import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import Anthropic from "@anthropic-ai/sdk";
import { research, type ResearchDeps, type GatheredSource } from "@goldie/agent-core";
import { getApiKey } from "./config";
import type { BrowserManager } from "./browser";

/**
 * The desktop wiring for the deterministic research pipeline. Injects the real
 * I/O — Node fetch for HTTP, the embedded browser for the JS-render fallback,
 * and the Anthropic SDK for the two LLM touchpoints (craft query, synthesize).
 * Writes a human-readable trace so we can judge gathering vs. synthesis
 * independently. No UX yet — this runs the engine and logs the result.
 */
export class ResearchRunner {
  constructor(private browser: BrowserManager) {}

  async run(goal: string, signal?: AbortSignal): Promise<void> {
    const apiKey = getApiKey("anthropic");
    if (!apiKey) {
      console.log("[research] no Anthropic key configured");
      return;
    }
    const client = new Anthropic({ apiKey });
    const model = "claude-haiku-4-5-20251001";
    const usage = { input: 0, output: 0, calls: 0 };
    const addUsage = (u: { input_tokens: number; output_tokens: number }) => {
      usage.input += u.input_tokens;
      usage.output += u.output_tokens;
      usage.calls += 1;
    };

    const deps: ResearchDeps = {
      // Raw HTTP fetch with a real browser UA (DDG + many sites reject the
      // default Node UA). Bounded read; treats non-2xx as empty.
      httpGet: async (url) => {
        const res = await fetch(url, {
          signal,
          redirect: "follow",
          headers: {
            "User-Agent":
              "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
            Accept: "text/html,application/xhtml+xml",
          },
        });
        if (!res.ok) return "";
        return res.text();
      },
      // JS-render fallback via the embedded browser.
      renderPage: (url) => this.browser.fetchRendered(url),
      craftQuery: (g) => this.craftQuery(client, model, g, addUsage),
      synthesize: ({ goal, sources }) =>
        this.synthesize(client, model, goal, sources, addUsage),
      onEvent: (e) => console.log(`[research] ${e.type}: ${e.message}`),
    };

    try {
      const out = await research(goal, deps, { topN: 4, signal });
      this.writeTrace(out, usage);
      console.log(
        `[research] done — ${usage.calls} LLM calls · ${usage.input} in · ${usage.output} out · ${out.sources.length} sources`,
      );
    } catch (err) {
      console.log(`[research] failed: ${String(err)}`);
    }
  }

  private async craftQuery(
    client: Anthropic,
    model: string,
    goal: string,
    addUsage: (u: { input_tokens: number; output_tokens: number }) => void,
  ): Promise<string> {
    const res = await client.messages.create({
      model,
      max_tokens: 64,
      system:
        "Turn the user's request into a single concise web-search query (keywords, no punctuation, no quotes). Output ONLY the query text.",
      messages: [{ role: "user", content: goal }],
    });
    addUsage(res.usage);
    const t = res.content.find((b) => b.type === "text");
    return t && t.type === "text" ? t.text.trim() : goal;
  }

  private async synthesize(
    client: Anthropic,
    model: string,
    goal: string,
    sources: GatheredSource[],
    addUsage: (u: { input_tokens: number; output_tokens: number }) => void,
  ): Promise<string> {
    const body =
      sources.length > 0
        ? sources
            .map((s) => `SOURCE: ${s.title} (${s.url})\n${s.text}`)
            .join("\n\n---\n\n")
            .slice(0, 12000)
        : "(no sources gathered)";
    const res = await client.messages.create({
      model,
      max_tokens: 1024,
      system:
        "Answer the user's request from the gathered sources below. Synthesize across sources, cite specific figures, be clear and well-written. If the sources are insufficient, say what's missing.",
      messages: [
        { role: "user", content: `REQUEST: ${goal}\n\nSOURCES:\n${body}\n\nAnswer.` },
      ],
    });
    addUsage(res.usage);
    const t = res.content.find((b) => b.type === "text");
    return t && t.type === "text" ? t.text : "(no answer)";
  }

  private writeTrace(
    out: Awaited<ReturnType<typeof research>>,
    usage: { input: number; output: number; calls: number },
  ): void {
    const L: string[] = [];
    const rule = "=".repeat(78);
    L.push(rule, "GOLDIE RESEARCH TRACE (deterministic pipeline)", rule);
    L.push(`GOAL:  ${out.goal}`);
    L.push(`QUERY: ${out.query}`);
    L.push("");
    L.push(`SEARCH RESULTS (${out.results.length}):`);
    out.results.slice(0, 10).forEach((r, i) =>
      L.push(`  ${i + 1}. ${r.title}\n     ${r.url}\n     ${r.snippet.slice(0, 120)}`),
    );
    L.push("");
    L.push(`GATHERED SOURCES (${out.sources.length}):`);
    for (const s of out.sources) {
      L.push("-".repeat(78));
      L.push(`SOURCE: ${s.title}  [via ${s.via}]`);
      L.push(`URL: ${s.url}  (${s.text.length} chars)`);
      L.push("");
      L.push(s.text.slice(0, 1500));
      L.push("");
    }
    L.push(rule, "TOTALS", rule);
    L.push(`  LLM calls:  ${usage.calls}  (1 query + 1 synth)`);
    L.push(`  input:      ${usage.input.toLocaleString()}`);
    L.push(`  output:     ${usage.output.toLocaleString()}`);
    L.push(`  sources:    ${out.sources.length}`);
    L.push("");
    L.push("SYNTHESIZED ANSWER:");
    L.push(out.answer);
    L.push("");
    try {
      const path = join(app.getPath("userData"), "goldie-research-trace.txt");
      writeFileSync(path, L.join("\n"), "utf8");
      console.log(`[research] trace -> ${path}`);
    } catch (e) {
      console.log(`[research] trace write failed: ${String(e)}`);
    }
  }
}
