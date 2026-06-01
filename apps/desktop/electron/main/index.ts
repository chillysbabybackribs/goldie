import { join } from "node:path";
import { app, BrowserWindow, ipcMain } from "electron";
import type { AgentEvent } from "@goldie/agent-core";
import { getProviderStatus } from "./config";
import { BrowserManager, type SlotBounds } from "./browser";
import { AgentRunner } from "./agent";

// The deep charcoal canvas — matches the renderer so there is no white flash
// on launch and the window feels like one continuous surface.
const CANVAS = "#16181b";

let mainWindow: BrowserWindow | null = null;
let browser: BrowserManager | null = null;
let agent: AgentRunner | null = null;
// In-flight chat runs, so the renderer can abort one by id.
const runs = new Map<string, AbortController>();

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 832,
    minWidth: 720,
    minHeight: 520,
    show: false,
    frame: false,
    titleBarStyle: "hidden",
    backgroundColor: CANVAS,
    // A small inset traffic-light position on macOS keeps the window controls
    // clear of the floating card's rounded corner.
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
      sandbox: false,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());

  // Window-control IPC for the custom titlebar (frameless => we draw our own).
  ipcMain.handle("window:minimize", () => mainWindow?.minimize());
  ipcMain.handle("window:toggleMaximize", () => {
    if (!mainWindow) return false;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return mainWindow.isMaximized();
  });
  ipcMain.handle("window:close", () => mainWindow?.close());

  // Renderer can ask WHICH providers have a key configured — never the key.
  ipcMain.handle("config:providerStatus", () => getProviderStatus());

  // Embedded browser. The manager pushes state changes to the renderer so the
  // URL pill / nav buttons stay in sync with the live page.
  browser = new BrowserManager(mainWindow, (state) => {
    mainWindow?.webContents.send("browser:state", state);
  });
  // The agent's first navigate asks the panel to open (and waits for it to be
  // positioned) via this handler, so the page paints into the right place.
  browser.setPrepareHandler(() => {
    mainWindow?.webContents.send("agent:open-browser");
  });
  ipcMain.handle("browser:show", () => browser?.show());
  ipcMain.handle("browser:hide", () => browser?.hide());
  ipcMain.handle("browser:setBounds", (_e, b: SlotBounds) =>
    browser?.setBounds(b),
  );
  ipcMain.handle("browser:navigate", (_e, url: string) =>
    browser?.navigate(url),
  );
  ipcMain.handle("browser:back", () => browser?.goBack());
  ipcMain.handle("browser:forward", () => browser?.goForward());
  ipcMain.handle("browser:reload", () => browser?.reload());

  // The agent. Keys live in main (config) and never cross to the renderer.
  agent = new AgentRunner(browser);

  // A chat turn: run the agent, streaming events back tagged with the run id.
  // When browsing starts, auto-open the browser panel in the renderer.
  ipcMain.handle(
    "chat:send",
    async (_e, payload: { id: string; task: string; model: string }) => {
      const { id, task, model } = payload;
      const controller = new AbortController();
      runs.set(id, controller);
      const send = (event: AgentEvent) => {
        if (event.type === "browsing-started") {
          mainWindow?.webContents.send("agent:open-browser");
        }
        mainWindow?.webContents.send("chat:event", { id, event });
      };
      try {
        await agent?.run(task, model, send, controller.signal);
      } finally {
        runs.delete(id);
        mainWindow?.webContents.send("chat:event", {
          id,
          event: { type: "done" },
        });
      }
    },
  );

  ipcMain.handle("chat:abort", (_e, id: string) => {
    runs.get(id)?.abort();
  });

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    mainWindow.loadURL(devUrl);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
