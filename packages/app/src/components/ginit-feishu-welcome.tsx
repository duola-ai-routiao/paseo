import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Text, TextInput, View } from "react-native";
import { LogIn, RefreshCw, Save } from "lucide-react-native";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { Button } from "@/components/ui/button";
import {
  getGinitBaseUrl,
  getNativeGinitBaseUrl,
  setNativeGinitBaseUrl,
  getInjectedGinitConfig,
} from "@/constants/ginit-config";
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

/**
 * Resolves the Hub HTTP origin for the current runtime.
 * - Web: the serving daemon's injected config (throws if missing).
 * - Native: the account-configured base URL, or the default when unset.
 * The caller passes the resolved value so async native storage is loaded once.
 */
function ginitBaseUrl(nativeBaseUrl: string | null): string {
  const configured = getInjectedGinitConfig()?.baseUrl;
  if (isWeb && typeof window !== "undefined") {
    if (!configured) {
      throw new Error("Ginit Hub endpoint is not configured on this Paseo daemon.");
    }
    return configured;
  }
  return nativeBaseUrl?.trim() || getGinitBaseUrl();
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

const RUNTIME_CLIENT_WAIT_MS = 15_000;

async function waitForRuntimeClient(serverId: string): Promise<DaemonClient> {
  const store = getHostRuntimeStore();
  const immediate = store.getSnapshot(serverId);
  if (immediate?.client && isHostRuntimeConnected(immediate)) {
    return immediate.client;
  }

  return new Promise((resolve, reject) => {
    let unsubscribe = () => {};
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let settled = false;

    const finish = (error: Error | null, client?: DaemonClient) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      if (timeout) clearTimeout(timeout);
      if (error) {
        reject(error);
      } else if (client) {
        resolve(client);
      } else {
        reject(new Error("Connected to the host but no runtime client is available."));
      }
    };

    const check = () => {
      const snapshot = store.getSnapshot(serverId);
      if (snapshot?.client && isHostRuntimeConnected(snapshot)) {
        finish(null, snapshot.client);
      }
    };

    timeout = setTimeout(() => {
      const lastError = store.getSnapshot(serverId)?.lastError;
      finish(
        new Error(
          lastError
            ? `Connected to the host but runtime client did not become ready: ${lastError}`
            : "Connected to the host but no runtime client is available.",
        ),
      );
    }, RUNTIME_CLIENT_WAIT_MS);
    unsubscribe = store.subscribe(serverId, check);
    check();
  });
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
    useTls: window.location.protocol === "https:",
    ...(password?.trim() ? { password: password.trim() } : {}),
  });
  return waitForRuntimeClient(probed.serverId);
}

async function pollForGinitToken(
  client: DaemonClient | null,
  baseUrl: string,
  deviceCode: string,
  expiresIn: number,
): Promise<string> {
  const deadline = Date.now() + expiresIn * 1000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    try {
      const poll = await pollGinitDeviceFlow(client, baseUrl, deviceCode);
      if (poll.status === "completed" && poll.token) return poll.token;
    } catch (cause) {
      if (!isWeb || !(cause instanceof TypeError)) throw cause;
    }
  }
  throw new Error("Feishu login timed out");
}

async function startGinitDeviceFlow(
  client: DaemonClient | null,
  baseUrl: string,
): Promise<{
  deviceCode: string;
  verificationUri: string;
  expiresIn: number;
}> {
  const normalized = baseUrl.replace(/\/+$/, "");
  try {
    const response = await fetch(`${normalized}/auth/device/start`, { method: "POST" });
    if (!response.ok) throw new Error(`Ginit device start failed (${response.status})`);
    const data = (await response.json()) as {
      device_code: string;
      verification_uri: string;
      expires_in: number;
    };
    return {
      deviceCode: data.device_code,
      verificationUri: data.verification_uri,
      expiresIn: data.expires_in,
    };
  } catch (directError) {
    // Native standalone apps and web both prefer direct HTTP (no CORS on
    // native). Fall back to the connected daemon's RPC when direct HTTP is
    // unavailable (e.g. a browser being served by a daemon without CORS).
    if (!client) throw directError;
    return client.hubDeviceStart(baseUrl);
  }
}

async function pollGinitDeviceFlow(
  client: DaemonClient | null,
  baseUrl: string,
  deviceCode: string,
): Promise<{ status: "pending" | "completed"; token: string | null }> {
  const normalized = baseUrl.replace(/\/+$/, "");
  try {
    const response = await fetch(`${normalized}/auth/device/poll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_code: deviceCode }),
    });
    if (response.status === 202) return { status: "pending", token: null };
    if (!response.ok) throw new Error(`Ginit device poll failed (${response.status})`);
    const data = (await response.json()) as { status: "pending" | "completed"; token?: string };
    return { status: data.status, token: data.token ?? null };
  } catch (directError) {
    if (!client) throw directError;
    return client.hubDevicePoll(baseUrl, deviceCode);
  }
}

async function listDevicesAsUser(
  token: string,
  client: DaemonClient | null,
  baseUrl: string,
): Promise<WelcomeHubDevice[]> {
  const normalized = baseUrl.replace(/\/+$/, "");
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
        relay_public_key?: string;
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
      if (item.relay_public_key) device.relayPublicKey = item.relay_public_key;
      if (item.relay_endpoint !== undefined) device.relayEndpoint = item.relay_endpoint;
      if (item.relay_use_tls !== undefined) {
        device.relayUseTls = item.relay_use_tls === true || item.relay_use_tls === 1;
      }
      if (item.connection_ready !== undefined) device.connectionReady = item.connection_ready;
      return device;
    });
  } catch (directError) {
    if (!client) throw directError;
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
      if (item.relayPublicKey) device.relayPublicKey = item.relayPublicKey;
      if (item.relayEndpoint !== undefined) device.relayEndpoint = item.relayEndpoint;
      if (item.relayUseTls !== undefined) device.relayUseTls = item.relayUseTls;
      if (item.connectionReady !== undefined) device.connectionReady = item.connectionReady;
      return device;
    });
  }
}

export function GinitFeishuWelcome({ onConnected }: { onConnected?: (serverId: string) => void }) {
  useHosts();
  const { probeAndUpsertDirectConnection, upsertRelayConnection } = useHostMutations();
  const [state, setState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [devices, setDevices] = useState<WelcomeHubDevice[] | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [password, setPassword] = useState("");
  const [needsPassword, setNeedsPassword] = useState(false);
  const [nativeBaseUrl, setNativeBaseUrl] = useState<string | null>(null);
  const [baseUrlDraft, setBaseUrlDraft] = useState<string>("");
  const [showBaseUrlEditor, setShowBaseUrlEditor] = useState(false);

  useEffect(() => {
    if (isWeb) return;
    let cancelled = false;
    void (async () => {
      const value = await getNativeGinitBaseUrl();
      if (cancelled) return;
      setNativeBaseUrl(value);
      setBaseUrlDraft(value ?? "");
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshDevices = useCallback(
    async (token: string, client: DaemonClient | null) => {
      setDevices(await listDevicesAsUser(token, client, ginitBaseUrl(nativeBaseUrl)));
    },
    [nativeBaseUrl],
  );

  // Resolve the daemon client. On web we prefer the serving/probed daemon
  // (so the browser can reach the Hub through it); on native standalone apps
  // there is no local daemon, so we talk to the Hub directly (client = null).
  const resolveClient = useCallback(
    async (passwordOverride?: string): Promise<DaemonClient | null> => {
      if (!isWeb) return null;
      return resolveDaemonClient(probeAndUpsertDirectConnection, passwordOverride);
    },
    [probeAndUpsertDirectConnection],
  );

  const login = useCallback(
    async (passwordOverride?: string) => {
      setState("loading");
      setError(null);
      setNeedsPassword(false);
      try {
        const baseUrl = ginitBaseUrl(nativeBaseUrl);
        const client = await resolveClient(passwordOverride);
        const start = await startGinitDeviceFlow(client, baseUrl);
        await openExternalUrl(start.verificationUri);
        const token = await pollForGinitToken(client, baseUrl, start.deviceCode, start.expiresIn);
        if (client) {
          await client.hubLoginGinit(baseUrl, token, { cacheOnly: true });
        }
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
    [resolveClient, refreshDevices, nativeBaseUrl],
  );

  useEffect(() => {
    void (async () => {
      const token = await loadStoredToken();
      if (!token) return;
      setState("loading");
      try {
        const client = await resolveClient();
        await refreshDevices(token, client);
        setState("ready");
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        setState("error");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolveClient, refreshDevices, nativeBaseUrl]);

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
        const client = await resolveClient();
        await refreshDevices(token, client);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setIsRefreshing(false);
      }
    })();
  }, [resolveClient, refreshDevices]);

  const handleConnectDevice = useCallback(
    async (device: WelcomeHubDevice) => {
      if (device.status !== "online" || device.connectionReady !== true) {
        setError("This daemon is not ready for Relay connection. Update the host and retry.");
        return;
      }
      if (!device.relayEndpoint || !device.relayPublicKey) {
        setError("This daemon is missing Relay connection metadata. Update the host and retry.");
        return;
      }
      try {
        await upsertRelayConnection({
          serverId: device.daemonId,
          relayEndpoint: device.relayEndpoint,
          useTls: device.relayUseTls ?? undefined,
          daemonPublicKeyB64: device.relayPublicKey,
          label: device.name,
        });
        onConnected?.(device.daemonId);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [onConnected, upsertRelayConnection],
  );

  const handleSaveBaseUrl = useCallback(async () => {
    const next = baseUrlDraft.trim();
    await setNativeGinitBaseUrl(next);
    setNativeBaseUrl(next.length > 0 ? next : null);
    setShowBaseUrlEditor(false);
    setError(null);
  }, [baseUrlDraft]);

  const handleShowBaseUrlEditor = useCallback(() => setShowBaseUrlEditor(true), []);

  const baseUrlEditor = isWeb ? null : (
    <View style={styles.baseUrlGroup} testID="welcome-ginit-baseurl">
      {showBaseUrlEditor ? (
        <>
          <Text style={styles.deviceMeta}>
            Hub HTTP origin (e.g. https://staging.ginit.opensii.ai). Leave blank for the default.
          </Text>
          <TextInput
            style={styles.passwordInput}
            value={baseUrlDraft}
            onChangeText={setBaseUrlDraft}
            placeholder="https://staging.ginit.opensii.ai"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            testID="welcome-ginit-baseurl-input"
          />
          <Button
            variant="default"
            size="sm"
            leftIcon={Save}
            onPress={handleSaveBaseUrl}
            disabled={state === "loading"}
            testID="welcome-ginit-baseurl-save"
          >
            Save Hub URL
          </Button>
        </>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          onPress={handleShowBaseUrlEditor}
          testID="welcome-ginit-baseurl-edit"
        >
          {nativeBaseUrl ? `Hub: ${nativeBaseUrl}` : "Configure Hub URL"}
        </Button>
      )}
    </View>
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
      {baseUrlEditor}
      {content}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  panel: { width: "100%", maxWidth: 420, gap: theme.spacing[3], marginBottom: theme.spacing[4] },
  baseUrlGroup: { gap: theme.spacing[2] },
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
