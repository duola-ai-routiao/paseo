import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { LogIn } from "lucide-react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { Button } from "@/components/ui/button";
import {
  getHostRuntimeStore,
  isHostRuntimeConnected,
  useHostMutations,
  useHosts,
} from "@/runtime/host-runtime";
import type { HostMutations } from "@/runtime/host-runtime";
import { openExternalUrl } from "@/utils/open-external-url";
import { StyleSheet } from "react-native-unistyles";

const GINIT_BASE_URL = resolveGinitBaseUrl();

function resolveGinitBaseUrl(): string {
  // Local/self-hosted deployments can point the Web UI at a co-located ginit
  // server by setting window.__PASEO_GINIT_BASE_URL__ or serving the UI from
  // the LAN. Production (app.paseo.sh) always uses the canonical hub.
  if (typeof window !== "undefined") {
    const injected = (window as { __PASEO_GINIT_BASE_URL__?: string }).__PASEO_GINIT_BASE_URL__;
    if (typeof injected === "string" && injected.trim()) {
      return injected.trim().replace(/\/+$/, "");
    }
    const origin = window.location?.origin ?? "";
    if (origin.startsWith("http://127.0.0.1:") || origin.startsWith("http://localhost:")) {
      return `${window.location.protocol}//${window.location.hostname}:18080`;
    }
    if (
      /^https?:\/\/(10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+)(:\d+)?$/.test(
        origin,
      )
    ) {
      return `${window.location.protocol}//${window.location.hostname}:18080`;
    }
  }
  return "https://ginit.opensii.ai";
}
const HOST_PASSWORD_STORAGE_KEY = "@paseo:host-password-v1";

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

/**
 * Probes the daemon that served this page (window.location.host). The daemon
 * may require a password; prompt once and cache it so the host registry entry
 * keeps reconnecting on later visits.
 */
async function probePageDaemon(
  probeAndUpsertDirectConnection: HostMutations["probeAndUpsertDirectConnection"],
): Promise<DaemonClient> {
  let password = await AsyncStorage.getItem(HOST_PASSWORD_STORAGE_KEY);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const probed = await probeAndUpsertDirectConnection({
        endpoint: window.location.host,
        ...(password ? { password } : {}),
      });
      const client = getHostRuntimeStore().getSnapshot(probed.serverId)?.client;
      if (client) return client;
      throw new Error("Connected to the host but no runtime client is available.");
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (!/password/i.test(message)) throw cause;
      const entered = window.prompt("Enter the Paseo host password:", "");
      if (entered === null) {
        throw new Error("Login cancelled — host password required.", { cause });
      }
      password = entered.trim();
      await AsyncStorage.setItem(HOST_PASSWORD_STORAGE_KEY, password);
    }
  }
  throw new Error("Unable to connect to the local Paseo host with the provided password.");
}

async function resolveDaemonClient(
  probeAndUpsertDirectConnection: HostMutations["probeAndUpsertDirectConnection"],
): Promise<DaemonClient> {
  const connected = findConnectedClient();
  if (connected) return connected;
  // No host is connected yet (fresh browser profile hitting a deployed web
  // UI). The welcome screen only makes sense when it can reach the daemon
  // that served this page, so probe it directly.
  if (typeof window === "undefined" || !window.location?.host) {
    throw new Error("No local Paseo host is connected yet — start the daemon and retry.");
  }
  return probePageDaemon(probeAndUpsertDirectConnection);
}

async function pollForGinitToken(
  client: DaemonClient,
  deviceCode: string,
  expiresIn: number,
): Promise<string> {
  const deadline = Date.now() + expiresIn * 1000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const poll = await client.hubDevicePoll(GINIT_BASE_URL, deviceCode);
    if (poll.status === "completed" && poll.token) {
      return poll.token;
    }
  }
  throw new Error("Feishu login timed out");
}

/**
 * Feishu login on the welcome screen.
 *
 * The browser cannot call the ginit server directly — it sends no CORS
 * headers, so `fetch("https://ginit.opensii.ai/...")` from a LAN origin like
 * http://192.168.3.2:8234 is blocked before it leaves the tab. The local
 * daemon already proxies the whole device-auth flow (see host-page.tsx), so
 * here we reuse the runtime client of any connected host and let the daemon
 * talk to ginit on our behalf.
 */
export function GinitFeishuWelcome() {
  useHosts();
  const { probeAndUpsertDirectConnection } = useHostMutations();
  const [state, setState] = useState<"idle" | "loading" | "enrolled" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  const login = useCallback(async () => {
    setState("loading");
    setError(null);
    try {
      const client = await resolveDaemonClient(probeAndUpsertDirectConnection);

      // Device flow runs through the daemon so the browser never fetches the
      // ginit server directly (the ginit server sends no CORS headers).
      const start = await client.hubDeviceStart(GINIT_BASE_URL);
      await openExternalUrl(start.verificationUri);
      const token = await pollForGinitToken(client, start.deviceCode, start.expiresIn);

      const enrollRes = await client.hubLoginGinit(GINIT_BASE_URL, token);
      if (!enrollRes.success) {
        throw new Error(enrollRes.error || "Enrollment failed");
      }
      setState("enrolled");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setState("error");
    }
  }, [probeAndUpsertDirectConnection]);

  const handleLoginPress = useCallback(() => {
    void login();
  }, [login]);

  return (
    <View style={styles.panel} testID="welcome-ginit-login">
      {state === "enrolled" ? (
        <Text style={styles.status}>Host enrolled — opening your workspace…</Text>
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
  status: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.xs },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.xs },
}));
