/**
 * Pure, deterministic parsing for the research pipeline — no network, no DOM.
 * These are the testable core: turn a search engine's HTML results page into
 * ranked links, and turn an arbitrary page's HTML into readable text.
 *
 * SEARCH SOURCE NOTE: DuckDuckGo's HTML/lite endpoints return HTTP 202 (bot
 * wall) from server IPs, so we use Mojeek as the primary source — a small
 * independent engine that serves scraper-tolerant HTML 200 with direct (non-
 * redirect) result links. Both parsers are kept; the pipeline picks one.
 */

export interface SearchResult {
  url: string;
  title: string;
  snippet: string;
}

/**
 * Parse Mojeek's results page (mojeek.com/search?q=). Each result's headline is
 * an `<a class="title" ... href="https://...">Headline</a>` (direct URL, no
 * redirect to decode), with the snippet in the following `<p class="s">`. We
 * match the `class="title"` anchor (attribute-order-agnostic) and pair it with
 * the next snippet paragraph in document order.
 */
export function parseMojeek(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  // class="title" anchor — class and href can appear in any order.
  const re =
    /<a\b(?=[^>]*class="title")(?=[^>]*href="(https?:\/\/[^"]+)")[^>]*>([\s\S]*?)<\/a>/gi;
  // Snippets in order, to pair by index.
  const snippetRe = /<p\s+class="s"[^>]*>([\s\S]*?)<\/p>/gi;
  const snippets: string[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = snippetRe.exec(html))) snippets.push(stripTags(sm[1]));

  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(html))) {
    const url = m[1];
    if (/^https?:\/\/(www\.)?mojeek\.com/i.test(url)) continue;
    results.push({ url, title: stripTags(m[2]), snippet: snippets[i] ?? "" });
    i++;
  }
  return dedupeByUrl(results);
}

/**
 * Parse DuckDuckGo's HTML endpoint (html.duckduckgo.com/html/) into results.
 * DDG wraps each result link in `<a class="result__a" href="...">title</a>` and
 * the snippet in `<a class="result__snippet">...</a>`. DDG also rewrites real
 * URLs through a redirect (`/l/?uddg=<encoded>`) — we decode that back to the
 * destination. Robust to minor markup drift: we match by the stable class names.
 */
export function parseDuckDuckGo(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  // Each result block. DDG uses result__a for the title link.
  const linkRe =
    /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  // Snippets, in document order, to pair with links.
  const snippetRe =
    /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;

  const snippets: string[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = snippetRe.exec(html))) snippets.push(stripTags(sm[1]));

  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = linkRe.exec(html))) {
    const url = decodeDdgHref(m[1]);
    if (!url || !/^https?:\/\//i.test(url)) {
      i++;
      continue;
    }
    results.push({
      url,
      title: stripTags(m[2]),
      snippet: snippets[i] ?? "",
    });
    i++;
  }
  return dedupeByUrl(results);
}

/** DDG hrefs are often `//duckduckgo.com/l/?uddg=<encoded>&rut=...` redirects. */
function decodeDdgHref(href: string): string {
  let h = href.trim();
  if (h.startsWith("//")) h = "https:" + h;
  try {
    const u = new URL(h, "https://duckduckgo.com");
    const uddg = u.searchParams.get("uddg");
    if (uddg) return decodeURIComponent(uddg);
    // Already a direct link.
    if (/^https?:/i.test(h)) return h;
  } catch {
    // fall through
  }
  return h;
}

function dedupeByUrl(rs: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const r of rs) {
    const key = r.url.replace(/[#?].*$/, "").replace(/\/$/, "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

/**
 * Convert a page's HTML into readable plain text — deterministic, dependency-
 * free. Drops scripts/styles/nav/footer/head, strips tags, decodes the common
 * entities, collapses whitespace, and bounds the length. Good enough to read an
 * article or a data page's text without a DOM.
 */
export function htmlToText(html: string, maxChars = 6000): string {
  let s = html;
  // Remove whole non-content sections.
  s = s.replace(/<head[\s\S]*?<\/head>/gi, " ");
  s = s.replace(/<script[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
  s = s.replace(/<nav[\s\S]*?<\/nav>/gi, " ");
  s = s.replace(/<footer[\s\S]*?<\/footer>/gi, " ");
  s = s.replace(/<svg[\s\S]*?<\/svg>/gi, " ");
  // Block elements → newlines so structure survives as line breaks.
  s = s.replace(/<\/(p|div|li|tr|h[1-6]|section|article|br)\s*>/gi, "\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  // Drop all remaining tags.
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  // Collapse whitespace per line, drop empties, dedupe consecutive dups.
  const lines: string[] = [];
  let last = "";
  for (const raw of s.split("\n")) {
    const line = raw.replace(/[ \t\f\v]+/g, " ").trim();
    if (line.length < 2) continue;
    if (line === last) continue;
    lines.push(line);
    last = line;
  }
  const text = lines.join("\n");
  return text.length > maxChars ? text.slice(0, maxChars - 1) + "…" : text;
}

/** How much real text a page yielded — used to decide curl was "too thin". */
export function textDensity(text: string): number {
  return text.replace(/\s+/g, "").length;
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => safeFromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => safeFromCharCode(parseInt(n, 16)));
}

function safeFromCharCode(code: number): string {
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}
