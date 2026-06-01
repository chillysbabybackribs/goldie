import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

export interface SlotBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserState {
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

/**
 * Agent events surfaced to the renderer. Mirrors agent-core's AgentEvent plus a
 * terminal "done" marker the main process appends. Kept as a local structural
 * type so the preload doesn't import agent-core into the sandbox.
 */
export type ChatEvent =
  | { type: "thinking" }
  | { type: "action"; action: ChatAction; step: number }
  | { type: "observation"; outcome: string }
  | { type: "browsing-started" }
  | { type: "answer"; text: string }
  | {
      type: "usage";
      usage: {
        input: number;
        output: number;
        calls: number;
        cacheRead?: number;
        cacheWrite?: number;
      };
    }
  | { type: "error"; message: string }
  | { type: "done" };

export interface ChatAction {
  type: "navigate" | "click" | "type" | "scroll" | "finish" | "answer";
  url?: string;
  id?: number;
  text?: string;
  direction?: "down" | "up";
  reason?: string;
  answer?: string;
}

// The renderer is sandboxed and never touches Node/Electron directly.
// Everything it can do crosses this explicit, typed bridge.
const api = {
  window: {
    minimize: (): Promise<void> => ipcRenderer.invoke("window:minimize"),
    toggleMaximize: (): Promise<boolean> =>
      ipcRenderer.invoke("window:toggleMaximize"),
    close: (): Promise<void> => ipcRenderer.invoke("window:close"),
  },
  config: {
    // Returns { anthropic: boolean, gemini: boolean } — configured-or-not.
    // The actual key never crosses this bridge.
    providerStatus: (): Promise<{ anthropic: boolean; gemini: boolean }> =>
      ipcRenderer.invoke("config:providerStatus"),
  },
  browser: {
    show: (): Promise<void> => ipcRenderer.invoke("browser:show"),
    hide: (): Promise<void> => ipcRenderer.invoke("browser:hide"),
    setBounds: (b: SlotBounds): Promise<void> =>
      ipcRenderer.invoke("browser:setBounds", b),
    navigate: (url: string): Promise<void> =>
      ipcRenderer.invoke("browser:navigate", url),
    back: (): Promise<void> => ipcRenderer.invoke("browser:back"),
    forward: (): Promise<void> => ipcRenderer.invoke("browser:forward"),
    reload: (): Promise<void> => ipcRenderer.invoke("browser:reload"),
    /** Subscribe to live page state. Returns an unsubscribe fn. */
    onState: (cb: (state: BrowserState) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, state: BrowserState) =>
        cb(state);
      ipcRenderer.on("browser:state", listener);
      return () => ipcRenderer.removeListener("browser:state", listener);
    },
    /** Main asks the renderer to open the panel when the agent starts browsing. */
    onOpenRequest: (cb: () => void): (() => void) => {
      const listener = () => cb();
      ipcRenderer.on("agent:open-browser", listener);
      return () => ipcRenderer.removeListener("agent:open-browser", listener);
    },
  },
  chat: {
    /** Start an agent run for this message id. Events arrive via onEvent. */
    send: (id: string, task: string, model: string): Promise<void> =>
      ipcRenderer.invoke("chat:send", { id, task, model }),
    abort: (id: string): Promise<void> => ipcRenderer.invoke("chat:abort", id),
    /** Subscribe to streamed agent events. Returns an unsubscribe fn. */
    onEvent: (
      cb: (id: string, event: ChatEvent) => void,
    ): (() => void) => {
      const listener = (
        _e: IpcRendererEvent,
        payload: { id: string; event: ChatEvent },
      ) => cb(payload.id, payload.event);
      ipcRenderer.on("chat:event", listener);
      return () => ipcRenderer.removeListener("chat:event", listener);
    },
  },
};

contextBridge.exposeInMainWorld("goldie", api);

export type GoldieApi = typeof api;
