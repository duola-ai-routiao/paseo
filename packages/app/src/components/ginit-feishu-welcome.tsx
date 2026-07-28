import { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import { LogIn, RefreshCw } from "lucide-react-native";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { Button } from "@/components/ui/button";
import { getGinitBaseUrl } from "@/constants/ginit-config";
import {
  getHostRuntimeStore,
  isHostRuntimeConnected,
  useHostMutations,
  useHosts,
} from "@/runtime/host-runtime";
import { openExternalUrl } from "@/utils/open-external-url";
import { StyleSheet } from "react-native-unistyles";

/**
 * Ginit hub base URL for the Feishu device flow. Resolved at runtime from the
 * serving daemon's injected config (`PASEO_GINIT_BASE_URL` / persisted
 * `daemon.hub.ginitBaseUrl`), never hardcoded per environment. Falls back to
 * the public staging hub for Metro dev builds.
 */
function ginitBaseUrl(): string {
  return getGinitBaseUrl();
}

/** A device row as returned by the hub account API `GET /api/paseo/devices`. */
interface HubDeviceRow {
  deviceId: string;
  daemonId: string;
  name: string;
  status: string;
  lastSeenAt: string | null;
}

const GINIT_TOKEN_STORAGE_KEY = "ginit.account.userToken";

async function loadStoredToken(): Promise<string | null> {
  try {
    const { default: AsyncStorage } = await import("@react-native-async-storage/async-storage");
    const raw = await AsyncStorage.getItem(GINIT_TOKEN_STORAGE_KEY);
    const trimmed = raw?.trim() ?? "";
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

async function storeToken(token: string): Promise<void> {
  try {
    const { default: AsyncStorage } = await import("@react-native-async-storage/async-storage");
    await AsyncStorage.setItem(GINIT_TOKEN_STORAGE_KEY, token);
  } catch {
    // best-effort convenience only
  }
}

function findConnectedClient(): DaemonClient | null {
  const store = getHostRuntimeStore();
  for (const host of store.getHosts()) {
    const snapshot = store.getSnapshot(host.serverId);
    if (isHostRuntimeConnected(snapshot) && snapshot?.client) {
      return snapshot.client;
    }
  }
  return null;
}

async function resolveDaemonClient(
  probeAndUpsertDirectConnection: ReturnType<
    typeof useHostMutations
  >["probeAndUpsertDirectConnection"],
): Promise<DaemonClient> {
  const connected = findConnectedClient();
  if (connected) return connected;
  // No host is connected yet (fresh browser profile hitting a deployed web
  // UI). The welcome screen only makes sense when it can reach the daemon
  // that served this page, so probe it directly.
  if (typeof window === "undefined" || !window.location?.host) {
    throw new Error("No local Paseo host is connected yet — start the daemon and retry.");
  }
  const probed = await probeAndUpsertDirectConnection({ endpoint: window.location.host });
  const client = getHostRuntimeStore().getSnapshot(probed.serverId)?.client;
  if (!client) {
    throw new Error("Connected to the host but no runtime client is available.");
  }
  return client;
}

async function pollForGinitToken(
  client: DaemonClient,
  deviceCode: string,
  expiresIn: number,
): Promise<string> {
  const deadline = Date.now() + expiresIn * 1000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const poll = await client.hubDevicePoll(ginitBaseUrl(), deviceCode);
    if (poll.status === "completed" && poll.token) {
      return poll.token;
    }
  }
  throw new Error("Feishu login timed out");
}

/**
 * Queries the hub account API directly with the user token. The browser is an
 * anonymous/read-only client of the hub — it never enrolls the web host as a
 * device. Falls back to the serving daemon's proxy when the hub sends no CORS
 * headers (bare-IP testbed).
 */
async function listDevicesAsUser(token: string, client: DaemonClient): Promise<HubDeviceRow[]> {
  const normalized = ginitBaseUrl().replace(/\/+$/, "");
  try {
    const res = await fetch(`${normalized}/api/paseo/devices`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      throw new Error(`Device list failed (${res.status})`);
    }
    const data = (await res.json()) as {
      items?: Array<{
        device_id: string;
        daemon_id: string;
        name: string;
        status: string;
        last_seen_at?: string | null;
      }>;
    };
    return (data.items ?? []).map((item) => ({
      deviceId: item.device_id,
      daemonId: item.daemon_id,
      name: item.name,
      status: item.status,
      lastSeenAt: item.last_seen_at ?? null,
    }));
  } catch (directError) {
    // The ginit server sends no CORS headers on the bare-IP testbed, so the
    // direct fetch never leaves the tab. Proxy the read through the serving
    // daemon instead — after login it caches the user token (cacheOnly) purely
    // for these account reads, without enrolling as a device.
    const res = await client.hubListDevices();
    if (!res.success) {
      throw new Error(res.error ?? "Failed to load devices", { cause: directError });
    }
    return res.devices.map((device) => ({
      deviceId: device.deviceId,
      daemonId: device.daemonId,
      name: device.name,
      status: device.status,
      lastSeenAt: device.lastSeenAt,
    }));
  }
}

/**
 * Feishu login on the welcome screen.
 *
 * New model: the web host (paseo-web) is NOT a hub device. It only serves the
 * static bundle; the browser logs in with Feishu to get a *user* token, then
 * queries the hub's account API directly for the devices bound to that
 * account (the real daemons running the ginit controlled service). Nothing
 * here enrolls the serving daemon.
 *
 * Auth boundary: the daemon itself is passwordless in the local-testbed
 * topology; the Feishu login is what identifies the user to the hub.
 */
export function GinitFeishuWelcome() {
  useHosts();
  const { probeAndUpsertDirectConnection } = useHostMutations();
  const [state, setState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [devices, setDevices] = useState<HubDeviceRow[] | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const refreshDevices = useCallback(async (token: string, client: DaemonClient) => {
    const rows = await listDevicesAsUser(token, client);
    setDevices(rows);
  }, []);

  const login = useCallback(async () => {
    setState("loading");
    setError(null);
    try {
      const client = await resolveDaemonClient(probeAndUpsertDirectConnection);

      // Device flow runs through the daemon so the browser never fetches the
      // ginit server directly (the ginit server sends no CORS headers).
      const start = await client.hubDeviceStart(ginitBaseUrl());
      await openExternalUrl(start.verificationUri);
      const token = await pollForGinitToken(client, start.deviceCode, start.expiresIn);

      // User-token login only — cache the account token on the serving daemon
      // (cacheOnly: no device enrollment) so it can proxy account reads around
      // the hub's missing CORS headers. The web host never becomes a device.
      await client.hubLoginGinit(ginitBaseUrl(), token, { cacheOnly: true });
      await storeToken(token);
      await refreshDevices(token, client);
      setState("ready");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setState("error");
    }
  }, [probeAndUpsertDirectConnection, refreshDevices]);

  // A returning browser session reloads the device list with the stored user
  // token — no new Feishu round-trip, still no enrollment.
  useEffect(() => {
    void (async () => {
      const token = await loadStoredToken();
      if (!token) return;
      setState("loading");
      try {
        const client = await resolveDaemonClient(probeAndUpsertDirectConnection);
        await refreshDevices(token, client);
        setState("ready");
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        setState("error");
      }
    })();
  }, [probeAndUpsertDirectConnection, refreshDevices]);

  const handleLoginPress = useCallback(() => {
    void login();
  }, [login]);

  const handleRefreshPress = useCallback(() => {
    void (async () => {
      setIsRefreshing(true);
      setError(null);
      try {
        const token = await loadStoredToken();
        if (!token) throw new Error("Login with Feishu first");
        const client = await resolveDaemonClient(probeAndUpsertDirectConnection);
        await refreshDevices(token, client);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setIsRefreshing(false);
      }
    })();
  }, [probeAndUpsertDirectConnection, refreshDevices]);

  return (
    <View style={styles.panel} testID="welcome-ginit-login">
      {state === "ready" ? (
        <View style={styles.deviceList} testID="welcome-ginit-devices">
          <View style={styles.deviceListHeader}>
            <Text style={styles.deviceListTitle}>My hosts</Text>
            <Button
              variant="ghost"
              size="sm"
              leftIcon={RefreshCw}
              onPress={handleRefreshPress}
              disabled={isRefreshing}
              testID="welcome-ginit-refresh"
            >
              {isRefreshing ? "Refreshing..." : "Refresh"}
            </Button>
          </View>
          {devices && devices.length > 0 ? (
            devices.map((device) => (
              <View key={device.deviceId} style={styles.deviceRow}>
                <Text style={styles.deviceName} numberOfLines={1}>
                  {device.name}
                </Text>
                <Text style={styles.deviceMeta} numberOfLines={1}>
                  {device.status} · {device.daemonId.slice(0, 8)}
                </Text>
              </View>
            ))
          ) : (
            <Text style={styles.deviceMeta}>
              No enrolled daemons on this account yet. Enroll a daemon with the ginit CLI to see it
              here.
            </Text>
          )}
        </View>
      ) : (
        <Button
          variant="default"
          size="lg"
          leftIcon={LogIn}
          onPress={handleLoginPress}
          disabled={state === "loading"}
          testID="welcome-feishu-login"
        >
          {state === "loading" ? "Waiting for Feishu..." : "Login with Feishu"}
        </Button>
      )}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  panel: { width: "100%", maxWidth: 420, gap: theme.spacing[3], marginBottom: theme.spacing[4] },
  deviceList: { gap: theme.spacing[2] },
  deviceListHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  deviceListTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  deviceRow: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    gap: 2,
  },
  deviceName: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  deviceMeta: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.xs },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.xs },
}));
