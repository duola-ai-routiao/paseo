import { isWeb } from "@/constants/platform";

const GINIT_CONFIG_GLOBAL_KEY = "__PASEO_GINIT_CONFIG__";

/** AsyncStorage key where a native app persists its Hub HTTP API origin. */
export const NATIVE_GINIT_BASE_URL_STORAGE_KEY = "ginit.native.baseUrl";

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

/**
 * Native (mobile) apps have no serving daemon to inject the Hub endpoint, so
 * the account can configure it. Persisted under NATIVE_GINIT_BASE_URL_STORAGE_KEY.
 * Returns null when unset so callers can prompt instead of silently using prod.
 */
export async function getNativeGinitBaseUrl(): Promise<string | null> {
  try {
    const { default: AsyncStorage } = await import("@react-native-async-storage/async-storage");
    const raw = await AsyncStorage.getItem(NATIVE_GINIT_BASE_URL_STORAGE_KEY);
    const trimmed = raw?.trim() ?? "";
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

export async function setNativeGinitBaseUrl(value: string): Promise<void> {
  try {
    const { default: AsyncStorage } = await import("@react-native-async-storage/async-storage");
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      await AsyncStorage.setItem(NATIVE_GINIT_BASE_URL_STORAGE_KEY, trimmed);
    } else {
      await AsyncStorage.removeItem(NATIVE_GINIT_BASE_URL_STORAGE_KEY);
    }
  } catch {
    // best-effort persistence only
  }
}

/**
 * Resolves the Hub HTTP origin for the current runtime.
 * - Web: the serving daemon's injected config wins; otherwise the fallback.
 * - Native: the account-configured value wins; otherwise the fallback.
 */
export function getGinitBaseUrl(): string {
  if (!isWeb) {
    // Native resolution is async (AsyncStorage); callers that need the
    // persisted value should use getNativeGinitBaseUrl(). This sync helper
    // only returns the fallback on native so existing call sites keep working.
    return DEFAULT_GINIT_BASE_URL;
  }
  return getInjectedGinitConfig()?.baseUrl ?? DEFAULT_GINIT_BASE_URL;
}
