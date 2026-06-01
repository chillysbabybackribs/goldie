import { describe, expect, it } from "vitest";
import { Orchestrator } from "../src/orchestrator/orchestrator";
import type { Action, PlanInput, Planner, PlanResult } from "../src/orchestrator/types";
import type { BrowserDriver } from "../src/driver/browser-driver";
import type { RawAXSnapshot } from "../src/perception/ax-types";

/**
 * Regression coverage for the "scroll" action. Before this, the planner could
 * emit a scroll the orchestrator had no handler for, killing the run with
 * `unknown action type: "scroll"`. These tests prove both scroll variants
 * (viewport + element-targeted) route to the right driver method, and that the
 * resulting outcome is surfaced as a normal step (no throw).
 */

/** A planner that replays a fixed script of actions, one per turn. */
class ScriptedPlanner implements Planner {
  readonly id = "scripted";
  private i = 0;
  constructor(private script: Action[]) {}
  async plan(_input: PlanInput): Promise<PlanResult> {
    const action = this.script[Math.min(this.i, this.script.length - 1)];
    this.i += 1;
    return { action, usage: { input: 1, output: 1 } };
  }
}

/** A driver that records calls and serves a one-element page so ids resolve. */
class RecordingDriver implements BrowserDriver {
  calls: string[] = [];
  async url() {
    return "https://example.com/";
  }
  async navigate(u: string) {
    this.calls.push(`navigate:${u}`);
  }
  async snapshot(): Promise<RawAXSnapshot> {
    // One real interactable node so PageView.byId has id 1 → backend 100.
    return {
      url: "https://example.com/",
      nodes: [
        {
          nodeId: "1",
          ignored: false,
          role: { type: "role", value: "link" },
          name: { type: "computedString", value: "A link" },
          properties: [],
          backendDOMNodeId: 100,
        },
      ],
    } as unknown as RawAXSnapshot;
  }
  async click(id: number) {
    this.calls.push(`click:${id}`);
  }
  async type(id: number, text: string) {
    this.calls.push(`type:${id}:${text}`);
  }
  async pressEnter(id: number) {
    this.calls.push(`pressEnter:${id}`);
  }
  async search(query: string) {
    this.calls.push(`search:${query}`);
    return true;
  }
  async scroll(direction: "down" | "up") {
    this.calls.push(`scroll:${direction}`);
  }
  async scrollIntoView(id: number) {
    this.calls.push(`scrollIntoView:${id}`);
  }
}

describe("orchestrator scroll action", () => {
  it("routes a viewport scroll to driver.scroll and continues the run", async () => {
    const driver = new RecordingDriver();
    const planner = new ScriptedPlanner([
      { type: "navigate", url: "https://example.com" },
      { type: "scroll", direction: "down" },
      { type: "finish", answer: "done" },
    ]);
    const result = await new Orchestrator(planner, driver).run("read more");

    expect(driver.calls).toContain("scroll:down");
    expect(result.answer).toBe("done");
    const scrollStep = result.steps.find((s) => s.action.type === "scroll");
    // A single viewport scroll still happens; the outcome now also reminds the
    // planner the full text is already shown (scroll-loop prevention).
    expect(scrollStep?.outcome).toMatch(/^scrolled down/);
  });

  it("hard-stops a viewport scroll-loop after a couple in a row", async () => {
    const driver = new RecordingDriver();
    const planner = new ScriptedPlanner([
      { type: "navigate", url: "https://example.com" },
      { type: "scroll", direction: "down" },
      { type: "scroll", direction: "down" },
      { type: "scroll", direction: "down" }, // 3rd consecutive — refused
      { type: "finish", answer: "ok" },
    ]);
    const result = await new Orchestrator(planner, driver).run("stop looping");
    // Only the first two scrolls reach the driver; the third is refused.
    expect(driver.calls.filter((c) => c === "scroll:down").length).toBe(2);
    const last = result.steps[result.steps.length - 1];
    expect(last.outcome).toMatch(/scrolling does not reveal new text/i);
  });

  it("defaults scroll direction to down when omitted", async () => {
    const driver = new RecordingDriver();
    const planner = new ScriptedPlanner([
      { type: "navigate", url: "https://example.com" },
      { type: "scroll" },
      { type: "finish", answer: "ok" },
    ]);
    await new Orchestrator(planner, driver).run("scroll please");
    expect(driver.calls).toContain("scroll:down");
  });

  it("routes an element-targeted scroll through byId to driver.scrollIntoView", async () => {
    const driver = new RecordingDriver();
    const planner = new ScriptedPlanner([
      { type: "navigate", url: "https://example.com" },
      { type: "scroll", id: 1 },
      { type: "finish", answer: "ok" },
    ]);
    const result = await new Orchestrator(planner, driver).run("scroll to it");

    expect(driver.calls).toContain("scrollIntoView:100");
    const scrollStep = result.steps.find((s) => s.action.type === "scroll");
    expect(scrollStep?.outcome).toBe("scrolled element 1 into view");
  });

  it("routes a search action to driver.search in one step", async () => {
    const driver = new RecordingDriver();
    const planner = new ScriptedPlanner([
      { type: "navigate", url: "https://www.google.com" },
      { type: "search", query: "nebius stock" },
      { type: "finish", answer: "ok" },
    ]);
    const result = await new Orchestrator(planner, driver).run("search it");
    expect(driver.calls).toContain("search:nebius stock");
    const step = result.steps.find((s) => s.action.type === "search");
    expect(step?.outcome).toMatch(/searched for "nebius stock"/);
  });

  it("reports cleanly when a search finds no box", async () => {
    class NoBoxDriver extends RecordingDriver {
      async search(query: string) {
        this.calls.push(`search:${query}`);
        return false;
      }
    }
    const driver = new NoBoxDriver();
    const planner = new ScriptedPlanner([
      { type: "navigate", url: "https://example.com" },
      { type: "search", query: "x" },
      { type: "finish", answer: "ok" },
    ]);
    const result = await new Orchestrator(planner, driver).run("search nowhere");
    const step = result.steps.find((s) => s.action.type === "search");
    expect(step?.outcome).toMatch(/no search box/i);
  });

  it("reports a clean outcome when scrolling an id not on the page", async () => {
    const driver = new RecordingDriver();
    const planner = new ScriptedPlanner([
      { type: "navigate", url: "https://example.com" },
      { type: "scroll", id: 999 },
      { type: "finish", answer: "ok" },
    ]);
    const result = await new Orchestrator(planner, driver).run("scroll to ghost");

    expect(driver.calls).not.toContain("scrollIntoView:999");
    const scrollStep = result.steps.find((s) => s.action.type === "scroll");
    expect(scrollStep?.outcome).toBe("element 999 is not on the current page");
  });
});
