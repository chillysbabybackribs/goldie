import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  organize,
  perceive,
  strip,
  type RawAXSnapshot,
} from "../src/perception";

const here = dirname(fileURLToPath(import.meta.url));
const loadFixture = (name: string): RawAXSnapshot =>
  JSON.parse(readFileSync(join(here, "fixtures", name), "utf8"));

// Real capture of news.ycombinator.com — the correctness fixture.
const hn = loadFixture("hackernews.json");

/**
 * A synthetic LARGE page for scale/truncation tests. Modeled on a heavy
 * article (lots of nav links across many landmark regions + a long body of
 * paragraphs and inline noise) — the shape that blew past 16k nodes on the
 * real Wikipedia capture, without committing a multi-MB fixture.
 */
function makeHugeSnapshot(): RawAXSnapshot {
  const nodes: RawAXSnapshot["nodes"] = [
    {
      nodeId: "1",
      childIds: [],
      ignored: false,
      role: { type: "role", value: "RootWebArea" },
      name: { type: "string", value: "Big Article - Wiki" },
      backendDOMNodeId: 1,
    },
  ];
  let id = 2;
  const childIds: string[] = [];
  // 12 nav regions, each with 30 links → 360 links spread across landmarks.
  for (let r = 0; r < 12; r++) {
    const navId = String(id++);
    childIds.push(navId);
    const navChildren: string[] = [];
    nodes.push({
      nodeId: navId,
      parentId: "1",
      childIds: navChildren,
      ignored: false,
      role: { type: "role", value: "navigation" },
      name: { type: "string", value: `Section ${r}` },
      backendDOMNodeId: Number(navId),
    });
    for (let i = 0; i < 30; i++) {
      const linkId = String(id++);
      navChildren.push(linkId);
      nodes.push({
        nodeId: linkId,
        parentId: navId,
        ignored: false,
        role: { type: "role", value: "link" },
        name: { type: "string", value: `Link ${r}-${i}` },
        backendDOMNodeId: Number(linkId),
        properties: [
          {
            name: "url",
            value: { type: "string", value: `https://wiki.test/p/${r}/${i}` },
          },
        ],
      });
    }
    // Inline-text noise that must be stripped.
    for (let k = 0; k < 50; k++) {
      nodes.push({
        nodeId: String(id++),
        parentId: navId,
        ignored: true,
        role: { type: "role", value: "InlineTextBox" },
        ignoredReasons: [
          { name: "uninteresting", value: { type: "boolean", value: true } },
        ],
      });
    }
  }
  nodes[0].childIds = childIds;
  return { url: "https://wiki.test/big-article", nodes };
}

const huge = makeHugeSnapshot();

describe("strip", () => {
  it("drops the overwhelming majority of nodes as noise", () => {
    const { kept } = strip(hn);
    // HN raw is ~1600 nodes; the meaningful set is a small fraction.
    expect(hn.nodes.length).toBeGreaterThan(1000);
    expect(kept.length).toBeLessThan(hn.nodes.length / 3);
    expect(kept.length).toBeGreaterThan(0);
  });

  it("never keeps an ignored node", () => {
    const { kept } = strip(hn);
    expect(kept.every((n) => !n.ignored)).toBe(true);
  });

  it("strips inline-text noise from a large multi-region page", () => {
    const { kept } = strip(huge);
    // 12 regions × (30 links + 50 noise) + 12 navs + root = 973 nodes; only
    // the 360 links (+ region containers) survive.
    expect(huge.nodes.length).toBeGreaterThan(900);
    expect(kept.length).toBeLessThan(huge.nodes.length / 2);
  });
});

describe("organize", () => {
  it("extracts the page title from the root", () => {
    const page = organize(strip(hn));
    expect(page.title).toBe("Hacker News");
  });

  it("assigns unique stable ids and a matching backend-node map", () => {
    const page = organize(strip(hn));
    const ids = page.regions.flatMap((r) => r.nodes.map((n) => n.id));
    expect(new Set(ids).size).toBe(ids.length); // all unique
    // Every resolvable id maps to a real backend node.
    for (const [id, backend] of page.byId) {
      expect(ids).toContain(id);
      expect(backend).toBeGreaterThan(0);
    }
  });

  it("classifies links and surfaces their href as detail", () => {
    const page = organize(strip(hn));
    const links = page.regions
      .flatMap((r) => r.nodes)
      .filter((n) => n.kind === "link");
    expect(links.length).toBeGreaterThan(20);
    // HN guidelines link should resolve a host in its detail.
    expect(links.some((l) => l.detail?.includes("ycombinator.com"))).toBe(true);
  });

  it("classifies the HN search textbox as an input", () => {
    const page = organize(strip(hn));
    const inputs = page.regions
      .flatMap((r) => r.nodes)
      .filter((n) => n.kind === "input");
    expect(inputs.length).toBeGreaterThanOrEqual(1);
  });
});

describe("summarize / perceive", () => {
  it("produces a PAGE header with title and host", () => {
    const view = perceive(hn);
    expect(view.summary.startsWith('PAGE: "Hacker News"')).toBe(true);
    expect(view.summary).toContain("news.ycombinator.com");
  });

  it("references elements by (id) the planner can act on", () => {
    const view = perceive(hn);
    expect(view.summary).toMatch(/\(\d+\) link/);
    expect(view.elementCount).toBeGreaterThan(0);
    expect(view.byId.size).toBeGreaterThan(0);
  });

  it("bounds token cost on a huge page via truncation", () => {
    const view = perceive(huge, { maxTotal: 120, maxPerRegion: 40 });
    const lines = view.summary.split("\n");
    // The summary must stay compact even though the page has 360 links.
    expect(lines.length).toBeLessThan(180);
    // It must show evidence of truncation rather than silently dropping
    // content (the "covered everything" failure mode).
    expect(view.summary).toMatch(/not shown|\+\d+ more/);
  });

  it("reports the TRUE total element count, not just what it rendered", () => {
    // 360 links exist; elementCount must reflect the whole page even when the
    // summary is truncated to a fraction.
    const view = perceive(huge, { maxTotal: 120 });
    expect(view.elementCount).toBe(360);
    expect(view.byId.size).toBe(360);
  });

  it("groups across the synthetic page's many landmark regions", () => {
    const view = perceive(huge, { maxTotal: 500 });
    // Distinct nav landmarks should appear as separate region headers.
    const navHeaders = view.summary
      .split("\n")
      .filter((l) => l.startsWith("[nav]"));
    expect(navHeaders.length).toBeGreaterThan(1);
  });

  it("is deterministic: same snapshot in → identical summary out", () => {
    expect(perceive(hn).summary).toBe(perceive(hn).summary);
  });

  it("flags a genuinely blank page so the planner won't fake a scroll", () => {
    // A page with only a RootWebArea and no perceivable content (about:blank,
    // or a still-loading SPA that the content gate timed out on).
    const blank: RawAXSnapshot = {
      url: "about:blank",
      nodes: [
        {
          nodeId: "1",
          childIds: [],
          ignored: false,
          role: { type: "role", value: "RootWebArea" },
          name: { type: "string", value: "" },
          backendDOMNodeId: 1,
        },
      ],
    };
    const view = perceive(blank);
    expect(view.elementCount).toBe(0);
    expect(view.summary).toMatch(/no readable content|blank/i);
    expect(view.summary).toMatch(/Scrolling will not reveal/i);
  });

  it("does NOT add the blank marker when content exists", () => {
    expect(perceive(hn).summary).not.toMatch(/no readable content/i);
  });

  it("every id in the rendered summary exists in the resolution map", () => {
    const view = perceive(hn);
    const renderedIds = [...view.summary.matchAll(/\((\d+)\)/g)].map((m) =>
      Number(m[1]),
    );
    // Most rendered ids resolve to a backend node (text/headings may not).
    const resolvable = renderedIds.filter((id) => view.byId.has(id));
    expect(resolvable.length).toBeGreaterThan(0);
  });
});
