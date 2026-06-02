import { describe, expect, it } from "vitest";
import { parseDuckDuckGo, parseMojeek, htmlToText } from "../src/research/parse";
import { research, type ResearchDeps } from "../src/research/pipeline";

// Mojeek result markup (the live search source). Title link is
// <a class="title" ... href> inside <h2>; snippet is <p class="s">.
const mojeekHtml = `
  <li class="r1">
    <a title="https://finance.yahoo.com/quote/NBIS" href="https://finance.yahoo.com/quote/NBIS" class="ob"><p class="i"><span class="url">finance.yahoo.com</span></p></a>
    <h2><a class="title" title="t" href="https://finance.yahoo.com/quote/NBIS">Yahoo NBIS Quote</a></h2>
    <p class="s">NBIS stock data and analyst ratings.</p>
  </li>
  <li class="r1">
    <a title="x" href="https://www.reuters.com/nebius" class="ob"></a>
    <h2><a class="title" href="https://www.reuters.com/nebius">Reuters Nebius</a></h2>
    <p class="s">Latest Nebius coverage.</p>
  </li>`;

describe("parseMojeek", () => {
  it("extracts title, direct url, and snippet", () => {
    const rs = parseMojeek(mojeekHtml);
    expect(rs.length).toBe(2);
    expect(rs[0].url).toBe("https://finance.yahoo.com/quote/NBIS");
    expect(rs[0].title).toBe("Yahoo NBIS Quote");
    expect(rs[0].snippet).toContain("analyst ratings");
    expect(rs[1].url).toBe("https://www.reuters.com/nebius");
  });

  it("handles class/href in any attribute order", () => {
    const rs = parseMojeek(
      `<a href="https://ex.com/a" class="title">Ex</a><p class="s">snip</p>`,
    );
    expect(rs[0]?.url).toBe("https://ex.com/a");
  });

  it("returns empty on junk (no crash)", () => {
    expect(parseMojeek("<html>nope</html>")).toEqual([]);
  });
});

describe("parseDuckDuckGo", () => {
  it("extracts results and decodes DDG redirect hrefs", () => {
    const html = `
      <div class="result">
        <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Ffinance.yahoo.com%2Fquote%2FNBIS&rut=abc">Nebius Group (NBIS) Stock</a>
        <a class="result__snippet">NBIS quote, price, analyst ratings.</a>
      </div>
      <div class="result">
        <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.reuters.com%2Fnebius">Nebius news - Reuters</a>
        <a class="result__snippet">Latest Nebius coverage.</a>
      </div>`;
    const rs = parseDuckDuckGo(html);
    expect(rs.length).toBe(2);
    expect(rs[0].url).toBe("https://finance.yahoo.com/quote/NBIS");
    expect(rs[0].title).toContain("Nebius Group");
    expect(rs[0].snippet).toContain("analyst ratings");
    expect(rs[1].url).toBe("https://www.reuters.com/nebius");
  });

  it("handles direct (non-redirect) hrefs too", () => {
    const html = `<a class="result__a" href="https://example.com/page">Example</a>`;
    const rs = parseDuckDuckGo(html);
    expect(rs[0].url).toBe("https://example.com/page");
  });

  it("dedupes the same destination url", () => {
    const html = `
      <a class="result__a" href="https://x.com/a">One</a>
      <a class="result__a" href="https://x.com/a/">Two</a>`;
    expect(parseDuckDuckGo(html).length).toBe(1);
  });

  it("returns empty on junk html (no crash)", () => {
    expect(parseDuckDuckGo("<html>nope</html>")).toEqual([]);
  });
});

describe("htmlToText", () => {
  it("strips scripts/styles/nav and keeps content text", () => {
    const html = `
      <html><head><title>T</title></head>
      <body>
        <nav><a>Home</a><a>About</a></nav>
        <script>var x = 1;</script>
        <style>.a{color:red}</style>
        <main><h1>Nebius</h1><p>P/E ratio is 239.</p><p>Operating margin -115%.</p></main>
        <footer>copyright</footer>
      </body></html>`;
    const t = htmlToText(html);
    expect(t).toContain("Nebius");
    expect(t).toContain("P/E ratio is 239");
    expect(t).toContain("Operating margin");
    expect(t).not.toContain("var x");
    expect(t).not.toContain("color:red");
    expect(t).not.toContain("Home"); // nav dropped
  });

  it("decodes entities and collapses whitespace", () => {
    const t = htmlToText("<p>AT&amp;T  &nbsp; earns&#39;t</p>");
    expect(t).toContain("AT&T");
    expect(t).toContain("earns't");
  });

  it("bounds length", () => {
    const big = "<p>" + "word ".repeat(5000) + "</p>";
    expect(htmlToText(big, 1000).length).toBeLessThanOrEqual(1000);
  });
});

describe("research pipeline", () => {
  const isSearch = (url: string) => url.startsWith("https://www.mojeek.com");

  it("runs end-to-end: query → search → fetch → synthesize", async () => {
    const events: string[] = [];
    const deps: ResearchDeps = {
      httpGet: async (url) => {
        if (isSearch(url)) return mojeekHtml;
        if (url.includes("yahoo"))
          return "<main><p>NBIS P/E 239, margin -115%, debt/equity 0.9.</p></main>";
        if (url.includes("reuters"))
          return "<main><p>Analysts rate Nebius a hold with mixed outlook on AI cloud growth.</p></main>";
        return "";
      },
      craftQuery: async () => "Nebius NBIS stock valuation analyst rating",
      synthesize: async ({ sources }) =>
        `Synthesized from ${sources.length} sources: ${sources.map((s) => s.title).join(", ")}`,
      onEvent: (e) => events.push(`${e.type}:${e.message}`),
    };

    const out = await research("is nebius a good stock to buy", deps, { topN: 2 });
    expect(out.query).toContain("Nebius");
    expect(out.results.length).toBe(2);
    expect(out.sources.length).toBe(2);
    expect(out.sources[0].text).toContain("P/E 239");
    expect(out.sources[0].via).toBe("http");
    expect(out.answer).toContain("2 sources");
    expect(events.some((e) => e.startsWith("search:"))).toBe(true);
  });

  it("falls back to renderPage when an http fetch is thin (JS-gated)", async () => {
    let rendered = false;
    const deps: ResearchDeps = {
      httpGet: async (url) => {
        if (isSearch(url)) return mojeekHtml;
        // Yahoo returns a near-empty shell over http (JS-gated).
        if (url.includes("yahoo")) return "<html><body><div id='app'></div></body></html>";
        return "<main><p>some real article text here that is long enough to keep.</p></main>";
      },
      renderPage: async () => {
        rendered = true;
        return "<main><p>RENDERED: NBIS P/E 239, margin -115%.</p></main>";
      },
      craftQuery: async () => "nebius",
      synthesize: async ({ sources }) => sources.map((s) => `${s.via}:${s.text}`).join(" | "),
    };

    const out = await research("nbis", deps, { topN: 2, thinThreshold: 500 });
    expect(rendered).toBe(true); // the thin yahoo page triggered render
    const yahoo = out.sources.find((s) => s.url.includes("yahoo"));
    expect(yahoo?.via).toBe("render");
    expect(yahoo?.text).toContain("RENDERED");
  });

  it("still synthesizes (with a note) when nothing is gathered", async () => {
    const deps: ResearchDeps = {
      httpGet: async (url) =>
        isSearch(url) ? "<html>no results</html>" : "",
      craftQuery: async () => "x",
      synthesize: async ({ sources }) =>
        sources.length === 0 ? "NO CONTENT" : "have content",
    };
    const out = await research("obscure", deps);
    expect(out.sources.length).toBe(0);
    expect(out.answer).toBe("NO CONTENT");
  });
});
