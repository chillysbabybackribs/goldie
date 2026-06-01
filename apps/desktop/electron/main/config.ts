import { existsSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import { config as loadDotenv } from "dotenv";

/**
 * Secrets live ONLY in the main process. We load the .env explicitly here
 * (not via Vite's import.meta.env, which would bundle values into the
 * renderer). The renderer never sees a key — it asks main to run LLM calls
 * over IPC. See apps/desktop/.env.example for the expected shape.
 *
 * Lookup order for the .env file:
 *   1. apps/desktop/.env next to the app sources (dev)
 *   2. <userData>/.env (a place to drop keys for a packaged build)
 */
function locateEnvFile(): string | undefined {
  const candidates = [
    // In dev, cwd is apps/desktop (electron-vite runs from there).
    join(process.cwd(), ".env"),
    // Packaged fallback: the per-user app data dir.
    join(app.getPath("userData"), ".env"),
  ];
  return candidates.find((p) => existsSync(p));
}

let loaded = false;
function ensureLoaded(): void {
  if (loaded) return;
  const envPath = locateEnvFile();
  if (envPath) loadDotenv({ path: envPath });
  loaded = true;
}

export type ProviderId = "anthropic" | "gemini";

/** Returns the raw key for a provider, or undefined if not configured. */
export function getApiKey(provider: ProviderId): string | undefined {
  ensureLoaded();
  const raw =
    provider === "anthropic"
      ? process.env.ANTHROPIC_API_KEY
      : process.env.GEMINI_API_KEY;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * A renderer-safe summary: which providers have a key configured, WITHOUT
 * ever sending the key itself. The UI can use this to show status or disable
 * a model option that has no key.
 */
export function getProviderStatus(): Record<ProviderId, boolean> {
  return {
    anthropic: Boolean(getApiKey("anthropic")),
    gemini: Boolean(getApiKey("gemini")),
  };
}
