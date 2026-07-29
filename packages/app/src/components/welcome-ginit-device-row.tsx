import { useCallback } from "react";
import { Text, View } from "react-native";
import { Button } from "@/components/ui/button";
import { StyleSheet } from "react-native-unistyles";

export interface WelcomeHubDevice {
  deviceId: string;
  daemonId: string;
  name: string;
  status: string;
  lastSeenAt: string | null;
  publicKey?: string;
  relayEndpoint?: string | null;
  relayUseTls?: boolean | null;
  connectionReady?: boolean;
}

export function WelcomeGinitDeviceRow({
  device,
  onConnect,
}: {
  device: WelcomeHubDevice;
  onConnect: (device: WelcomeHubDevice) => void;
}) {
  const canConnect =
    device.status === "online" &&
    device.connectionReady === true &&
    Boolean(device.relayEndpoint) &&
    Boolean(device.publicKey);
  const handlePress = useCallback(() => {
    void onConnect(device);
  }, [device, onConnect]);

  return (
    <View style={styles.deviceRow}>
      <View style={styles.deviceInfo}>
        <Text style={styles.deviceName} numberOfLines={1}>
          {device.name}
        </Text>
        <Text style={styles.deviceMeta} numberOfLines={1}>
          {device.status} · {device.daemonId.slice(0, 8)}
        </Text>
      </View>
      <Button
        variant="outline"
        size="sm"
        onPress={handlePress}
        disabled={!canConnect}
        testID={`welcome-ginit-connect-${device.deviceId}`}
      >
        Connect
      </Button>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  deviceRow: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    gap: theme.spacing[2],
  },
  deviceInfo: { flex: 1, minWidth: 0 },
  deviceName: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  deviceMeta: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.xs },
}));
