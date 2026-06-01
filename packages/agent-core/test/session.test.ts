import { describe, expect, it } from "vitest";
import { ChatSession } from "../src/orchestrator";

describe("ChatSession", () => {
  it("starts empty", () => {
    const s = new ChatSession();
    expect(s.hasHistory()).toBe(false);
    expect(s.renderHistory()).toBe("");
  });

  it("renders recorded turns as compact conclusions", () => {
    const s = new ChatSession();
    s.record({ user: "top HN story?", conclusion: "answered 'X'; browser on HN" });
    const h = s.renderHistory();
    expect(h).toContain("CONVERSATION SO FAR");
    expect(h).toContain("top HN story?");
    expect(h).toContain("answered 'X'");
  });

  it("keeps history BOUNDED via the rolling window (the token guarantee)", () => {
    const s = new ChatSession(6);
    // 30 turns, each with a chunky conclusion.
    for (let i = 0; i < 30; i++) {
      s.record({
        user: `question number ${i} with some length to it`,
        conclusion: `a fairly wordy conclusion for turn ${i} describing what happened`,
      });
    }
    const h = s.renderHistory();
    const lines = h.split("\n");
    // Header + at most one recap line + the windowed turns (6) → small + flat.
    expect(lines.length).toBeLessThanOrEqual(8);
    // The most recent turns are present verbatim in the window.
    expect(h).toContain("question number 29");
    expect(h).toContain("question number 24");
    // The folded recap acknowledges earlier turns exist...
    expect(h).toContain("(earlier)");
    // ...but the OLDEST folded turn (0) has been dropped from the bounded recap
    // (front-truncation keeps recent-but-folded over ancient).
    expect(h).not.toContain("turn 0 describing");
    // The whole rendered history stays compact regardless of conversation length.
    expect(h.length).toBeLessThan(1400);
  });

  it("reports the live browser state, ignoring blank pages", () => {
    const s = new ChatSession();
    expect(s.renderBrowserState()).toBe("");
    s.setBrowserState("about:blank", "");
    expect(s.renderBrowserState()).toBe("");
    s.setBrowserState("https://news.ycombinator.com/", "Hacker News");
    const note = s.renderBrowserState();
    expect(note).toContain("Hacker News");
    expect(note).toContain("news.ycombinator.com");
  });
});
