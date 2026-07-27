import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { LogIn } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import {
  getHostRuntimeStore,
  isHostRuntimeConnected,
  useHostMutations,
  useHosts,
} from "@/runtime/host-runtime";
import { openExternalUrl } from "@/utils/open-external-url";
import { StyleSheet } from "react-native-unistyles";

const GINIT_BASE_URL = "https://ginit.opensii.ai";

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
  const hosts = useHosts();
  const { probeAndUpsertDirectConnection } = useHostMutations();
  const [state, setState] = useState<"idle" | "loading" | "enrolled" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  const login = useCallback(async () => {
    setState("loading");
    setError(null);
    try {
      const store = getHostRuntimeStore();
      const onlineHost = hosts.find((host) =>
        isHostRuntimeConnected(store.getSnapshot(host.serverId)),
      );
      const client = onlineHost ? store.getSnapshot(onlineHost.serverId)?.client : null;
      if (!onlineHost || !client) {
        throw new Error("No local Paseo host is connected yet — start the daemon and retry.");
      }

      // Device flow runs through the daemon so the browser never fetches the
      // ginit server directly (the ginit server sends no CORS headers).
      const start = await client.hubDeviceStart(GINIT_BASE_URL);
      await openExternalUrl(start.verificationUri);

      const deadline = Date.now() + start.expiresIn * 1000;
      let token: string | null = null;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const poll = await client.hubDevicePoll(GINIT_BASE_URL, start.deviceCode);
        if (poll.status === "completed") {
          token = poll.token;
          break;
        }
      }
      if (!token) throw new Error("Feishu login timed out");

      const enrollRes = await client.hubLoginGinit(GINIT_BASE_URL, token);
      if (!enrollRes.success) {
        throw new Error(enrollRes.error || "Enrollment failed");
      }

      // The enrolled daemon is now reachable through the hub/relay; make sure
      // it stays in the host list even if the direct LAN connection drops.
      const listen = new URL(enrollRes.hubUrl ?? GINIT_BASE_URL).host;
      await probeAndUpsertDirectConnection({ endpoint: listen, label: onlineHost.label });
      setState("enrolled");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setState("error");
    }
  }, [hosts, probeAndUpsertDirectConnection]);

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
