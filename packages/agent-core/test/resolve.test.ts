import { describe, expect, it } from "vitest";
import { resolveStep } from "../src/executor/resolve";
import type { PageIndex } from "../src/perception/page-index";
import type { PlanStep } from "../src/executor/types";

// A descriptor map modeled on a real Yahoo Finance NBIS quote page.
const yahoo: PageIndex = {
  url: "https://finance.yahoo.com/quote/NBIS",
  title: "Nebius Group (NBIS)",
  components: [
    { tag: "c1", kind: "tab", name: "Summary", backendNodeId: 11, rect: r() },
    { tag: "c2", kind: "tab", name: "News", backendNodeId: 12, rect: r() },
    { tag: "c3", kind: "tab", name: "Research", backendNodeId: 13, rect: r() },
    { tag: "c4", kind: "tab", name: "Statistics", backendNodeId: 14, rect: r() },
    { tag: "c5", kind: "tab", name: "Historical Data", backendNodeId: 15, rect: r() },
    { tag: "c6", kind: "link", name: "Trade NBIS on Coinbase", detail: "coinbase.com", backendNodeId: 16, rect: r() },
  ],
  clusters: [
    { tag: "s1", kind: "table", label: "Valuation Measures", text: "P/E 239.20 Market Cap 66.8B EPS -2.10", backendNodeId: 21, rect: r() },
    { tag: "s2", kind: "table", label: "Financial Highlights", text: "Revenue 399M Profit Margin -115%", backendNodeId: 22, rect: r() },
    { tag: "s3", kind: "list", label: "Latest News", text: "Nebius advances after Q1 earnings...", backendNodeId: 23, rect: r() },
  ],
};

function r() {
  return { x: 0, y: 0, width: 80, height: 20 };
}
const step = (s: Partial<PlanStep>): PlanStep => ({ kind: "click", ...s } as PlanStep);

describe("resolver — pass-through steps", () => {
  it("navigate passes the url through", () => {
    const res = resolveStep({ step: step({ kind: "navigate", url: "https://x.com" }), index: yahoo });
    expect(res).toEqual({ status: "navigate", url: "https://x.com" });
  });

  it("search passes the query through", () => {
    const res = resolveStep({ step: step({ kind: "search", query: "nbis pe ratio" }), index: yahoo });
    expect(res).toEqual({ status: "search", query: "nbis pe ratio" });
  });

  it("navigate with no url is stuck", () => {
    const res = resolveStep({ step: step({ kind: "navigate" }), index: yahoo });
    expect(res.status).toBe("stuck");
  });
});

describe("resolver — click matching", () => {
  it("resolves an exact tab name", () => {
    const res = resolveStep({ step: step({ target: "Statistics" }), index: yahoo });
    expect(res.status).toBe("click");
    if (res.status === "click") expect(res.tag).toBe("c4");
  });

  it("resolves a natural-language phrasing ('the Statistics tab')", () => {
    const res = resolveStep({ step: step({ target: "the Statistics tab" }), index: yahoo });
    expect(res.status).toBe("click");
    if (res.status === "click") expect(res.tag).toBe("c4");
  });

  it("resolves a descriptive target to the right link", () => {
    const res = resolveStep({ step: step({ target: "trade on coinbase" }), index: yahoo });
    expect(res.status).toBe("click");
    if (res.status === "click") expect(res.tag).toBe("c6");
  });

  it("is STUCK (not wrong) when nothing matches", () => {
    const res = resolveStep({ step: step({ target: "shopping cart checkout" }), index: yahoo });
    expect(res.status).toBe("stuck");
    if (res.status === "stuck") expect(res.candidates).toBeDefined();
  });

  it("is stuck when there are no components", () => {
    const empty = { ...yahoo, components: [] };
    const res = resolveStep({ step: step({ target: "Statistics" }), index: empty });
    expect(res.status).toBe("stuck");
  });
});

describe("resolver — extract matching", () => {
  it("resolves valuation metrics to the Valuation Measures table", () => {
    const res = resolveStep({ step: step({ kind: "extract", target: "valuation measures" }), index: yahoo });
    expect(res.status).toBe("extract");
    if (res.status === "extract") {
      expect(res.tag).toBe("s1");
      expect(res.text).toContain("P/E 239.20");
    }
  });

  it("resolves 'news' to the Latest News cluster", () => {
    const res = resolveStep({ step: step({ kind: "extract", target: "latest news" }), index: yahoo });
    expect(res.status).toBe("extract");
    if (res.status === "extract") expect(res.tag).toBe("s3");
  });

  it("is stuck when no cluster matches the target", () => {
    const res = resolveStep({ step: step({ kind: "extract", target: "employee org chart" }), index: yahoo });
    expect(res.status).toBe("stuck");
  });

  it("is stuck extracting when there are no clusters", () => {
    const noClusters = { ...yahoo, clusters: [] };
    const res = resolveStep({ step: step({ kind: "extract", target: "anything" }), index: noClusters });
    expect(res.status).toBe("stuck");
  });
});
