import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  main: {
    // Leave node_modules deps (Anthropic/Google SDKs and their native/optional
    // transitive deps like ws/bufferutil) as runtime requires rather than
    // bundling them — main runs in Node. But DO bundle the workspace package
    // @goldie/agent-core, which ships TypeScript source and must be transpiled.
    plugins: [externalizeDepsPlugin({ exclude: ["@goldie/agent-core"] })],
    build: {
      outDir: "dist-electron/main",
      lib: { entry: resolve(__dirname, "electron/main/index.ts") },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "dist-electron/preload",
      lib: { entry: resolve(__dirname, "electron/preload/index.ts") },
    },
  },
  renderer: {
    root: resolve(__dirname, "renderer"),
    build: {
      outDir: "dist-electron/renderer",
      rollupOptions: {
        input: resolve(__dirname, "renderer/index.html"),
      },
    },
    plugins: [react()],
  },
});
