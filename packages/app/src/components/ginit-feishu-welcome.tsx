import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Text, TextInput, View } from "react-native";
import { LogIn, RefreshCw } from "lucide-react-native";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { Button } from "@/components/ui/button";
import { getGinitBaseUrl, getInjectedGinitConfig } from "@/constants/ginit-config";
import { isWeb } from "@/constants/platform";
import {
  getHostRuntimeStore,
  isHostRuntimeConnected,
  useHostMutations,
  useHosts,
} from "@/runtime/host-runtime";
import { openExternalUrl } from "@/utils/open-external-url";
import { StyleSheet } from "react-native-unistyles";
import { WelcomeGinitDeviceRow, type WelcomeHubDevice } from "./welcome-ginit-device-row";

function ginitBaseUrl(): string {
  const configured = getInjectedGinitConfig()?.baseUrl;
  if (isWeb && typeof window !== "undefined") {
    if (!configured) {
      throw new Error("Ginit Hub endpoint is not configured on this Paseo daemon.");
    }
    return configured;
  }
  return configured ?? getGinitBaseUrl();
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
    if (isHostRuntimeConnected(snapshot) && snapshot?.client) return snapshot.client;
  }
  return null;
}

function findServingHostClient(): DaemonClient | null {
  if (typeof window === "undefined" || !window.location?.host) return null;
  const store = getHostRuntimeStore();
  for (const host of store.getHosts()) {
    const serving = host.connections.some(
      (connection) =>
        connection.type === "directTcp" && connection.endpoint === window.location.host,
    );
    if (!serving) continue;
    const snapshot = store.getSnapshot(host.serverId);
    if (isHostRuntimeConnected(snapshot) && snapshot?.client) return snapshot.client;
  }
  return null;
}

async function resolveDaemonClient(
  probeAndUpsertDirectConnection: ReturnType<
    typeof useHostMutations
  >["probeAndUpsertDirectConnection"],
  password?: string,
): Promise<DaemonClient> {
  const serving = findServingHostClient();
  if (serving) return serving;
  const connected = findConnectedClient();
  if (connected) return connected;
  if (typeof window === "undefined" || !window.location?.host) {
    throw new Error("No local Paseo host is connected yet — start the daemon and retry.");
  }
  const probed = await probeAndUpsertDirectConnection({
    endpoint: window.location.host,
    ...(password?.trim() ? { password: password.trim() } : {}),
  });
  const client = getHostRuntimeStore().getSnapshot(probed.serverId)?.client;
  if (!client) throw new Error("Connected to the host but no runtime client is available.");
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
    if (poll.status === "completed" && poll.token) return poll.token;
  }
  throw new Error("Feishu login timed out");
}

async function listDevicesAsUser(token: string, client: DaemonClient): Promise<WelcomeHubDevice[]> {
  const normalized = ginitBaseUrl().replace(/\/+$/, "");
  try {
    const response = await fetch(`${normalized}/api/paseo/devices`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`Device list failed (${response.status})`);
    const data = (await response.json()) as {
      items?: Array<{
        device_id: string;
        daemon_id: string;
        name: string;
        status: string;
        last_seen_at?: string | null;
        public_key?: string;
        relay_endpoint?: string | null;
        relay_use_tls?: boolean | number | null;
        connection_ready?: boolean;
      }>;
    };
    return (data.items ?? []).map((item) => {
      const device: WelcomeHubDevice = {
        deviceId: item.device_id,
        daemonId: item.daemon_id,
        name: item.name,
        status: item.status,
        lastSeenAt: item.last_seen_at ?? null,
      };
      if (item.public_key) device.publicKey = item.public_key;
      if (item.relay_endpoint !== undefined) device.relayEndpoint = item.relay_endpoint;
      if (item.relay_use_tls !== undefined) {
        device.relayUseTls = item.relay_use_tls === true || item.relay_use_tls === 1;
      }
      if (item.connection_ready !== undefined) device.connectionReady = item.connection_ready;
      return device;
    });
  } catch (directError) {
    const response = await client.hubListDevices();
    if (!response.success) {
      throw new Error(response.error ?? "Failed to load devices", { cause: directError });
    }
    return response.devices.map((item) => {
      const device: WelcomeHubDevice = {
        deviceId: item.deviceId,
        daemonId: item.daemonId,
        name: item.name,
        status: item.status,
        lastSeenAt: item.lastSeenAt,
      };
      if (item.publicKey) device.publicKey = item.publicKey;
      if (item.relayEndpoint !== undefined) device.relayEndpoint = item.relayEndpoint;
      if (item.relayUseTls !== undefined) device.relayUseTls = item.relayUseTls;
      if (item.connectionReady !== undefined) device.connectionReady = item.connectionReady;
      return device;
    });
  }
}

export function GinitFeishuWelcome() {
  useHosts();
  const { probeAndUpsertDirectConnection, upsertRelayConnection } = useHostMutations();
  const [state, setState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [devices, setDevices] = useState<WelcomeHubDevice[] | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [password, setPassword] = useState("");
  const [needsPassword, setNeedsPassword] = useState(false);

  const refreshDevices = useCallback(async (token: string, client: DaemonClient) => {
    setDevices(await listDevicesAsUser(token, client));
  }, []);

  const login = useCallback(
    async (passwordOverride?: string) => {
      setState("loading");
      setError(null);
      setNeedsPassword(false);
      try {
        const client = await resolveDaemonClient(probeAndUpsertDirectConnection, passwordOverride);
        const start = await client.hubDeviceStart(ginitBaseUrl());
        await openExternalUrl(start.verificationUri);
        const token = await pollForGinitToken(client, start.deviceCode, start.expiresIn);
        await client.hubLoginGinit(ginitBaseUrl(), token, { cacheOnly: true });
        await storeToken(token);
        await refreshDevices(token, client);
        setState("ready");
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        const passwordRequired = /password required/i.test(message);
        setNeedsPassword(passwordRequired);
        setError(
          passwordRequired
            ? "This daemon requires a password. Enter it below, then sign in again."
            : message,
        );
        setState("error");
      }
    },
    [probeAndUpsertDirectConnection, refreshDevices],
  );

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

  const handlePasswordLoginPress = useCallback(() => {
    void login(password);
  }, [login, password]);

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

  const handleConnectDevice = useCallback(
    async (device: WelcomeHubDevice) => {
      if (device.status !== "online" || device.connectionReady !== true) {
        setError("This daemon is not ready for Relay connection. Update the host and retry.");
        return;
      }
      if (!device.relayEndpoint || !device.publicKey) {
        setError("This daemon is missing Relay connection metadata. Update the host and retry.");
        return;
      }
      try {
        await upsertRelayConnection({
          serverId: device.daemonId,
          relayEndpoint: device.relayEndpoint,
          useTls: device.relayUseTls ?? undefined,
          daemonPublicKeyB64: device.publicKey,
          label: device.name,
        });
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [upsertRelayConnection],
  );

  let content: ReactNode;
  if (state === "ready") {
    content = (
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
            <WelcomeGinitDeviceRow
              key={device.deviceId}
              device={device}
              onConnect={handleConnectDevice}
            />
          ))
        ) : (
          <Text style={styles.deviceMeta}>
            No enrolled daemons on this account yet. Enroll a daemon with the ginit CLI to see it
            here.
          </Text>
        )}
      </View>
    );
  } else if (needsPassword) {
    content = (
      <View style={styles.passwordGroup} testID="welcome-password-group">
        <TextInput
          style={styles.passwordInput}
          value={password}
          onChangeText={setPassword}
          placeholder="Daemon password"
          secureTextEntry
          autoFocus
          onSubmitEditing={handlePasswordLoginPress}
          testID="welcome-password-input"
        />
        <Button
          variant="default"
          size="lg"
          leftIcon={LogIn}
          onPress={handlePasswordLoginPress}
          disabled={state === "loading" || password.trim().length === 0}
          testID="welcome-password-login"
        >
          {state === "loading" ? "Connecting..." : "Sign in with password"}
        </Button>
      </View>
    );
  } else {
    content = (
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
    );
  }

  return (
    <View style={styles.panel} testID="welcome-ginit-login">
      {content}
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
  deviceMeta: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.xs },
  passwordGroup: { gap: theme.spacing[2] },
  passwordInput: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.xs },
}));
