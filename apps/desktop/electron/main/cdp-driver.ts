import type { BrowserDriver, RawAXSnapshot } from "@goldie/agent-core";
import type { BrowserManager } from "./browser";

/**
 * The concrete BrowserDriver for Electron — the ONLY place agent-core meets the
 * embedded WebContentsView. It adapts BrowserManager (CDP via
 * webContents.debugger) to the abstract interface agent-core depends on. Swap
 * this for a PlaywrightDriver later and nothing in agent-core changes.
 *
 * `click`/`type`/`pressEnter` throw the driver's native error on a stale node;
 * the orchestrator catches "No node found for given backend id" and re-plans.
 */
export class ElectronCdpDriver implements BrowserDriver {
  constructor(private browser: BrowserManager) {}

  async url(): Promise<string> {
    return this.browser.currentUrl();
  }

  async navigate(url: string): Promise<void> {
    await this.browser.navigateAndWait(url);
  }

  async snapshot(): Promise<RawAXSnapshot> {
    return this.browser.snapshot();
  }

  async pageIndex() {
    return this.browser.pageIndex();
  }

  async click(backendNodeId: number): Promise<void> {
    const r = await this.browser.clickNode(backendNodeId);
    if (!r.clicked) {
      throw new Error(
        `No node found for given backend id (no geometry for ${backendNodeId})`,
      );
    }
  }

  async type(backendNodeId: number, text: string): Promise<void> {
    await this.browser.typeNode(backendNodeId, text);
  }

  async pressEnter(backendNodeId: number): Promise<void> {
    await this.browser.pressEnterNode(backendNodeId);
  }

  async search(query: string): Promise<boolean> {
    return this.browser.search(query);
  }

  async scroll(direction: "down" | "up"): Promise<void> {
    await this.browser.scrollViewport(direction);
  }

  async scrollIntoView(backendNodeId: number): Promise<void> {
    await this.browser.scrollNodeIntoView(backendNodeId);
  }
}
