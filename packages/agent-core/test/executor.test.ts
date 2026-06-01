import { describe, expect, it } from "vitest";
import { Executor } from "../src/executor/executor";
import type { Plan, PlanStep } from "../src/executor/types";
import type { PageIndex } from "../src/perception/page-index";
import type { BrowserDriver, RawAXSnapshot } from "../src/index";

function r() {
  return { x: 0, y: 0, width: 80, height: 20 };
}

// A driver whose page index can change after navigation (to simulate landing on
// a new page). Records the actions performed.
class MockDriver implements BrowserDriver {
  calls: string[] = [];
  constructor(private index: PageIndex) {}
  setIndex(idx: PageIndex) {
    this.index = idx;
  }
  async url() {
    return this.index.url;
  }
  async navigate(u: string) {
    this.calls.push(`navigate:${u}`);
  }
  async snapshot() {
    return { url: this.index.url, nodes: [] } as RawAXSnapshot;
  }
  async pageIndex() {
    return this.index;
  }
  async click(id: number) {
    this.calls.push(`click:${id}`);
  }
  async type(id: number, t: string) {
    this.calls.push(`type:${id}:${t}`);
  }
  async pressEnter(id: number) {
    this.calls.push(`pressEnter:${id}`);
  }
  async search(q: string) {
    this.calls.push(`search:${q}`);
    return true;
  }
  async scroll(d: "down" | "up") {
    this.calls.push(`scroll:${d}`);
  }
  async scrollIntoView(id: number) {
    this.calls.push(`scrollIntoView:${id}`);
  }
}

const yahoo: PageIndex = {
  url: "https://finance.yahoo.com/quote/NBIS",
  title: "NBIS",
  components: [
    { tag: "c4", kind: "tab", name: "Statistics", backendNodeId: 14, rect: r() },
  ],
  clusters: [
    { tag: "s1", kind: "table", label: "Valuation Measures", text: "P/E 239 EPS -2.1", backendNodeId: 21, rect: r() },
  ],
};

const neverAssist = async () => {
  throw new Error("assist should not have been called");
};
const synth = async ({ gathered }: { goal: string; gathered: string[] }) =>
  `ANSWER from ${gathered.length} sources: ${gathered.join(" | ")}`;

describe("Executor — autonomous run", () => {
  it("runs a clean plan with ZERO assist calls", async () => {
    const driver = new MockDriver(yahoo);
    const plan: Plan = {
      goal: "is nbis a good buy",
      steps: [
        { kind: "navigate", url: "https://finance.yahoo.com/quote/NBIS" },
        { kind: "click", target: "Statistics tab" },
        { kind: "extract", target: "valuation measures" },
        { kind: "finish" },
      ],
    };
    const out = await new Executor(driver).run(plan, {
      assist: neverAssist,
      synthesize: synth,
    });
    expect(out.assistCalls).toBe(0);
    expect(driver.calls).toEqual([
      "navigate:https://finance.yahoo.com/quote/NBIS",
      "click:14",
    ]);
    expect(out.gathered.length).toBe(1);
    expect(out.answer).toContain("P/E 239");
  });

  it("phones home on a stuck step and RESUMES (no restart)", async () => {
    const driver = new MockDriver(yahoo);
    let assisted = 0;
    const plan: Plan = {
      goal: "is nbis a good buy",
      steps: [
        // This target won't match anything → stuck → assist fixes it.
        { kind: "click", target: "the quarterly earnings widget thingy" },
        { kind: "extract", target: "valuation measures" },
        { kind: "finish" },
      ],
    };
    const assist = async () => {
      assisted++;
      return { kind: "click", target: "Statistics" } as PlanStep;
    };
    const out = await new Executor(driver).run(plan, { assist, synthesize: synth });
    expect(assisted).toBe(1); // exactly one helping hand
    expect(out.assistCalls).toBe(1);
    // It resumed: the click landed AND the later extract still ran.
    expect(driver.calls).toContain("click:14");
    expect(out.gathered.length).toBe(1); // extract step still executed
    expect(out.answer).toContain("P/E 239");
  });

  it("gives up on a step after max assists without restarting the task", async () => {
    const driver = new MockDriver(yahoo);
    const plan: Plan = {
      goal: "x",
      steps: [
        { kind: "click", target: "nonexistent" },
        { kind: "extract", target: "valuation measures" },
        { kind: "finish" },
      ],
    };
    // Assist keeps returning something that also won't match.
    const assist = async () => ({ kind: "click", target: "still nonexistent zzz" } as PlanStep);
    const out = await new Executor(driver).run(plan, {
      assist,
      synthesize: synth,
      maxAssistPerStep: 2,
    });
    // Gave up on step 1 after 2 assists, but step 2 (extract) still ran.
    expect(out.assistCalls).toBe(2);
    expect(out.gathered.length).toBe(1);
  });
});
