import { isWeb } from "@/constants/platform";

const GINIT_CONFIG_GLOBAL_KEY = "__PASEO_GINIT_CONFIG__";

export interface GinitRuntimeConfig {
  /** ginit-server HTTP API origin (device flow, enrollments, devices). */
  baseUrl?: string;
  /** Hub WebSocket URL the daemon enrolls against (informational). */
  hubWsUrl?: string;
}

/** Reads runtime Ginit endpoints injected by the serving daemon. */
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

/** Metro development fallback only. */
const DEFAULT_GINIT_BASE_URL = "https://ginit.opensii.ai";

export function getGinitBaseUrl(): string {
  return getInjectedGinitConfig()?.baseUrl ?? DEFAULT_GINIT_BASE_URL;
}
