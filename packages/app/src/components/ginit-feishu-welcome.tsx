import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { LogIn } from "lucide-react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Button } from "@/components/ui/button";
import { useHostMutations } from "@/runtime/host-runtime";
import { openExternalUrl } from "@/utils/open-external-url";
import { StyleSheet } from "react-native-unistyles";

const GINIT_BASE_URL = "https://ginit.opensii.ai";
const GINIT_TOKEN_KEY = "@paseo:ginit-token-v1";

interface GinitDevice {
  device_id: string;
  daemon_id: string;
  name: string;
  status: string;
  public_key?: string;
  relay_endpoint?: string | null;
  relay_use_tls?: boolean | null;
  connection_ready?: boolean;
}

export function GinitFeishuWelcome() {
  const { upsertRelayConnection } = useHostMutations();
  const [state, setState] = useState<"idle" | "loading" | "devices" | "error">("idle");
  const [devices, setDevices] = useState<GinitDevice[]>([]);
  const [error, setError] = useState<string | null>(null);

  const login = useCallback(async () => {
    setState("loading");
    setError(null);
    try {
      const startResponse = await fetch(`${GINIT_BASE_URL}/auth/device/start`, { method: "POST" });
      if (!startResponse.ok) throw new Error(`Feishu login start failed (${startResponse.status})`);
      const start = (await startResponse.json()) as {
        device_code: string;
        verification_uri: string;
        expires_in: number;
      };
      await openExternalUrl(start.verification_uri);
      const deadline = Date.now() + start.expires_in * 1000;
      let token: string | null = null;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const pollResponse = await fetch(`${GINIT_BASE_URL}/auth/device/poll`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ device_code: start.device_code }),
        });
        if (pollResponse.status === 202) continue;
        if (!pollResponse.ok) throw new Error(`Feishu login poll failed (${pollResponse.status})`);
        const poll = (await pollResponse.json()) as { status: string; token?: string };
        if (poll.status === "completed" && poll.token) {
          token = poll.token;
          break;
        }
      }
      if (!token) throw new Error("Feishu login timed out");
      await AsyncStorage.setItem(GINIT_TOKEN_KEY, token);
      const devicesResponse = await fetch(`${GINIT_BASE_URL}/api/paseo/devices`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!devicesResponse.ok)
        throw new Error(`Unable to list Paseo hosts (${devicesResponse.status})`);
      const payload = (await devicesResponse.json()) as { items?: GinitDevice[] };
      setDevices(payload.items ?? []);
      setState("devices");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setState("error");
    }
  }, []);

  const connect = useCallback(
    async (device: GinitDevice) => {
      if (!device.connection_ready || !device.relay_endpoint || !device.public_key) return;
      await upsertRelayConnection({
        serverId: device.daemon_id,
        relayEndpoint: device.relay_endpoint,
        useTls: device.relay_use_tls ?? true,
        daemonPublicKeyB64: device.public_key,
        label: device.name,
      });
    },
    [upsertRelayConnection],
  );

  const handleLoginPress = useCallback(() => {
    void login();
  }, [login]);

  return (
    <View style={styles.panel} testID="welcome-ginit-login">
      {state === "devices" ? (
        <>
          <Text style={styles.title}>Your Paseo hosts</Text>
          {devices.map((device) => (
            <GinitDeviceRow key={device.device_id} device={device} onConnect={connect} />
          ))}
          {devices.length === 0 ? <Text style={styles.status}>No Paseo hosts found.</Text> : null}
        </>
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

function GinitDeviceRow({
  device,
  onConnect,
}: {
  device: GinitDevice;
  onConnect: (device: GinitDevice) => Promise<void>;
}) {
  const handleConnect = useCallback(() => {
    void onConnect(device);
  }, [device, onConnect]);
  return (
    <View style={styles.row}>
      <View style={styles.info}>
        <Text style={styles.name}>{device.name}</Text>
        <Text style={styles.status}>{device.status}</Text>
      </View>
      <Button
        variant="outline"
        size="sm"
        disabled={device.status !== "online" || !device.connection_ready}
        onPress={handleConnect}
        testID={`welcome-ginit-connect-${device.device_id}`}
      >
        {device.connection_ready ? "Connect" : "Update host"}
      </Button>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  panel: { width: "100%", maxWidth: 420, gap: theme.spacing[3], marginBottom: theme.spacing[4] },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
  },
  info: { flex: 1, gap: theme.spacing[1] },
  name: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  status: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.xs },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.xs },
}));
