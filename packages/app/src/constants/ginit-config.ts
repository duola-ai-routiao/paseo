import { isWeb } from "@/constants/platform";

const GINIT_CONFIG_GLOBAL_KEY = "__PASEO_GINIT_CONFIG__";

export interface GinitRuntimeConfig {
  /** ginit-server HTTP API origin (device flow, enrollments, devices). */
  baseUrl?: string;
  /** Hub WebSocket URL the daemon enrolls against (informational). */
  hubWsUrl?: string;
}

/**
 * Reads the runtime ginit hub endpoints injected by the serving daemon into
 * index.html (`window.__PASEO_GINIT_CONFIG__`). Returns null when the page was
 * not served by a daemon (Metro dev) or no ginit endpoints are configured —
 * callers should then fall back to `getDefaultGinitBaseUrl`.
 */
export function getInjectedGinitConfig(): GinitRuntimeConfig | null {
  if (!isWeb) return null;
  const raw = (globalThis as Record<string, unknown>)[GINIT_CONFIG_GLOBAL_KEY];
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const baseUrl = typeof record.baseUrl === "string" ? record.baseUrl.trim() : "";
  const hubWsUrl = typeof record.hubWsUrl === "string" ? record.hubWsUrl.trim() : "";
  if (!baseUrl && !hubWsUrl) return null;
  return {
    ...(baseUrl ? { baseUrl } : {}),
    ...(hubWsUrl ? { hubWsUrl } : {}),
  };
}

/**
 * Last-resort default used when the page was not served by a configured
 * daemon (e.g. Expo Go / Metro dev). Points at the public staging hub so dev
 * builds still reach a real environment instead of a stale testbed IP.
 */
const DEFAULT_GINIT_BASE_URL = "https://ginit.opensii.ai";

export function getGinitBaseUrl(): string {
  return getInjectedGinitConfig()?.baseUrl ?? DEFAULT_GINIT_BASE_URL;
}
