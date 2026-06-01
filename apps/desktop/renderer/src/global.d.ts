import type { GoldieApi } from "../../electron/preload";

declare global {
  interface Window {
    goldie: GoldieApi;
  }
}

export {};
