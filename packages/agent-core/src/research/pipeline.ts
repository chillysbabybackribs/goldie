import { parseMojeek, htmlToText, textDensity, type SearchResult } from "./parse";

/**
 * THE RESEARCH PIPELINE — prompt in, usable information out. Deterministic
 * gathering with two small LLM touchpoints (craft query, synthesize). The heavy
 * lifting — searching, fetching, extracting — is pure mechanics.
 *
 * agent-core stays Electron-free: all I/O is INJECTED. The host provides:
 *  - `httpGet(url)`     — fetch raw bytes/text of a URL (DDG + result pages).
 *  - `renderPage(url)`  — OPTIONAL: render a JS-heavy page and return its text
 *                         (the embedded-browser fallback). If absent, we only
 *                         use httpGet.
 *  - `craftQuery(goal)` — LLM: turn the goal into a good search query.
 *  - `synthesize(...)`  — LLM: write the answer from gathered content.
 *
 * Returns BOTH the per-source extracted text and the synthesized answer, so the
 * gathering quality can be judged independently of the synthesis quality.
 */

export interface ResearchDeps {
  httpGet: (url: string) => Promise<string>;
  renderPage?: (url: string) => Promise<string>;
  craftQuery: (goal: string) => Promise<string>;
  synthesize: (args: {
    goal: string;
    sources: GatheredSource[];
  }) => Promise<string>;
  onEvent?: (e: ResearchEvent) => void;
}

export interface ResearchEvent {
  type: "query" | "search" | "fetch" | "thin" | "rendered" | "synthesize" | "error";
  message: string;
}

export interface GatheredSource {
  url: string;
  title: string;
  text: string;
  /** "http" (curl) or "render" (browser fallback) — which path got the text. */
  via: "http" | "render";
}

export interface ResearchResult {
  goal: string;
  query: string;
  results: SearchResult[];
  sources: GatheredSource[];
  answer: string;
}

export interface ResearchOptions {
  /** How many search results to fetch + extract. */
  topN?: number;
  /** Below this much text from httpGet, try the render fallback. */
  thinThreshold?: number;
  /** Per-source extracted-text cap. */
  maxCharsPerSource?: number;
  signal?: AbortSignal;
}

// Mojeek: scraper-tolerant (HTTP 200 from server IPs, unlike DDG's 202 wall),
// direct result links. Primary search source.
const SEARCH = "https://www.mojeek.com/search?q=";

export async function research(
  goal: string,
  deps: ResearchDeps,
  opts: ResearchOptions = {},
): Promise<ResearchResult> {
  const topN = opts.topN ?? 4;
  const thin = opts.thinThreshold ?? 500;
  const maxChars = opts.maxCharsPerSource ?? 6000;
  const emit = (e: ResearchEvent) => deps.onEvent?.(e);

  // 1) Craft a search query from the goal (LLM).
  const query = (await deps.craftQuery(goal)).trim() || goal;
  emit({ type: "query", message: query });

  // 2) Search DuckDuckGo (deterministic).
  let results: SearchResult[] = [];
  try {
    const html = await deps.httpGet(SEARCH + encodeURIComponent(query));
    results = parseMojeek(html);
    emit({ type: "search", message: `${results.length} results for "${query}"` });
  } catch (err) {
    emit({ type: "error", message: `search failed: ${errMsg(err)}` });
  }

  // 3) Fetch + extract the top N (deterministic, httpGet with render fallback).
  const sources: GatheredSource[] = [];
  for (const r of results.slice(0, topN)) {
    if (opts.signal?.aborted) break;
    let text = "";
    let via: "http" | "render" = "http";
    try {
      const raw = await deps.httpGet(r.url);
      text = htmlToText(raw, maxChars);
      emit({ type: "fetch", message: `${r.url} (${textDensity(text)} chars)` });
    } catch (err) {
      emit({ type: "error", message: `fetch failed ${r.url}: ${errMsg(err)}` });
    }
    // Thin (JS-gated) page → try the browser-render fallback if available.
    if (textDensity(text) < thin && deps.renderPage) {
      emit({ type: "thin", message: `${r.url} thin via http — rendering` });
      try {
        const rendered = await deps.renderPage(r.url);
        const rt = htmlToText(rendered, maxChars);
        if (textDensity(rt) > textDensity(text)) {
          text = rt;
          via = "render";
          emit({ type: "rendered", message: `${r.url} (${textDensity(text)} chars)` });
        }
      } catch (err) {
        emit({ type: "error", message: `render failed ${r.url}: ${errMsg(err)}` });
      }
    }
    // Keep any source that yielded real text. The render fallback above already
    // gave thin pages their best shot; whatever text we have now is what we use.
    if (textDensity(text) > 0) {
      sources.push({ url: r.url, title: r.title, text, via });
    }
  }

  // 4) Synthesize the answer from gathered content (LLM).
  emit({ type: "synthesize", message: `synthesizing from ${sources.length} sources` });
  const answer = await deps.synthesize({ goal, sources });

  return { goal, query, results, sources, answer };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
