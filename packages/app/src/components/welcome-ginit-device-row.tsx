import { useCallback, useMemo } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet } from "react-native-unistyles";

export interface WelcomeHubDevice {
  deviceId: string;
  daemonId: string;
  name: string;
  status: string;
  lastSeenAt: string | null;
  publicKey?: string;
  relayPublicKey?: string;
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
    Boolean(device.relayPublicKey);
  const handlePress = useCallback(() => {
    if (!canConnect) return;
    void onConnect(device);
  }, [device, onConnect, canConnect]);

  // Explain why the button is disabled — otherwise users see a grey button
  // with no idea what to do. The hint lands on `title` (web) and
  // `accessibilityHint` (native), so it shows on hover/screen-reader.
  let disabledReason: string | null = null;
  if (device.status !== "online") {
    disabledReason = "Host is offline — start the daemon on that machine, then Refresh.";
  } else if (device.connectionReady !== true || !device.relayEndpoint || !device.relayPublicKey) {
    disabledReason =
      "Host is missing Relay metadata — update the daemon on that machine, then Refresh.";
  }

  // The whole row is tappable on touch devices (native already keeps the
  // controls always visible; this enlarges the hit target to the full row).
  const pressableStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [
      styles.deviceRow,
      pressed && styles.deviceRowPressed,
    ],
    [],
  );
  const accessibilityState = useMemo(
    () => (canConnect ? undefined : { disabled: true }),
    [canConnect],
  );

  return (
    <Pressable
      style={pressableStyle}
      onPress={handlePress}
      disabled={!canConnect}
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      accessibilityHint={disabledReason ?? undefined}
      testID={`welcome-ginit-row-${device.deviceId}`}
    >
      <View style={styles.deviceInfo}>
        <Text style={styles.deviceName} numberOfLines={1}>
          {device.name}
        </Text>
        <Text style={styles.deviceMeta} numberOfLines={1}>
          {device.status} · {device.daemonId.slice(0, 8)}
        </Text>
      </View>
      <Text style={[styles.connectLabel, !canConnect && styles.connectLabelDisabled]}>
        {canConnect ? "Connect" : "Offline"}
      </Text>
    </Pressable>
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
    paddingVertical: theme.spacing[3],
    gap: theme.spacing[2],
    minHeight: 56,
  },
  deviceRowPressed: {
    backgroundColor: theme.colors.surface1,
  },
  deviceInfo: { flex: 1, minWidth: 0 },
  deviceName: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  deviceMeta: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.xs },
  connectLabel: {
    color: theme.colors.accent,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  connectLabelDisabled: {
    color: theme.colors.foregroundMuted,
  },
}));
