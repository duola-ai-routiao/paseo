import {
  ArrowDown,
  ArrowUp,
  ArrowUpToLine,
  ChevronRight,
  Globe,
  Monitor,
  Pencil,
  Plus,
  RotateCw,
  SquareTerminal,
  Trash2,
} from "lucide-react-native";
import type { TFunction } from "i18next";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Pressable, Text, TextInput, View } from "react-native";
import { StyleSheet, useUnistyles, withUnistyles } from "react-native-unistyles";
import type { TerminalProfile } from "@getpaseo/protocol/messages";
import {
  getTerminalProfileIcon,
  resolveTerminalProfiles,
} from "@getpaseo/protocol/terminal-profiles";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { AdaptiveRenameModal } from "@/components/rename-modal";
import { SettingsTextAreaCard } from "@/components/settings-textarea";
import { Alert as InlineAlert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  ProfileDraft,
  TerminalProfileEditModal,
} from "@/screens/settings/terminal-profile-edit-modal";
import { getIsElectron } from "@/constants/platform";
import { getGinitBaseUrl } from "@/constants/ginit-config";
import {
  getDesktopDaemonStatus,
  restartDesktopDaemon,
  startDesktopDaemon,
  stopDesktopDaemon,
} from "@/desktop/daemon/desktop-daemon";
import { LocalDaemonSection } from "@/desktop/components/desktop-updates-section";
import { useDaemonStatus } from "@/desktop/hooks/use-daemon-status";
import { loadDesktopSettings, useDesktopSettings } from "@/desktop/settings/desktop-settings";
import { PairDeviceModal } from "@/desktop/components/pair-device-modal";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useIsLocalDaemon } from "@/hooks/use-is-local-daemon";
import {
  getHostRuntimeStore,
  isHostRuntimeConnected,
  useHostMutations,
  useHostRuntimeClient,
  useHostRuntimeIsConnected,
  useHostRuntimeSnapshot,
  useHosts,
} from "@/runtime/host-runtime";
import {
  connectionFromListen,
  hostHasConnection,
  type HostConnection,
  type HostProfile,
} from "@/types/host-connection";
import { ProvidersSection } from "@/screens/settings/providers-section";
import { ProviderUsageSettingsSection } from "@/provider-usage/settings-section";
import { useProviderUsage } from "@/provider-usage/use-provider-usage";
import { SettingsSection } from "@/screens/settings/settings-section";
import { useSessionStore } from "@/stores/session-store";
import { settingsStyles } from "@/styles/settings";
import { confirmDialog } from "@/utils/confirm-dialog";
import { isVersionMismatch } from "@/desktop/updates/desktop-updates";
import { resolveAppVersion } from "@/utils/app-version";
import { formatConnectionStatus, getConnectionStatusTone } from "@/utils/daemons";
import { formatLatency } from "@/utils/latency";
import { ICON_SIZE } from "@/styles/theme";
import type { Theme } from "@/styles/theme";
import { getProviderIcon } from "@/components/provider-icons";
import { BrowserToolsOptInCard } from "./browser-tools-card";
import { hasDaemonReconnectedAfter, type DaemonConnectionMarker } from "./daemon-reconnect";
import { restartDaemonFromSettings } from "./daemon-restart";

const ThemedArrowUp = withUnistyles(ArrowUp);
const ThemedArrowDown = withUnistyles(ArrowDown);
const ThemedProfilePencil = withUnistyles(Pencil);
const ThemedTrash2 = withUnistyles(Trash2);
const ThemedProfileSquareTerminal = withUnistyles(SquareTerminal);
const ThemedPlus = withUnistyles(Plus);

interface DynamicProviderIconProps {
  iconKey: string;
  size: number;
  color?: string;
}

function DynamicProviderIcon({ iconKey, size, color = "" }: DynamicProviderIconProps) {
  const Icon = getProviderIcon(iconKey);
  return <Icon size={size} color={color} />;
}

const ThemedDynamicProviderIcon = withUnistyles(DynamicProviderIcon);

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const destructiveColorMapping = (theme: Theme) => ({ color: theme.colors.destructive });

const moveUpIcon = <ThemedArrowUp size={ICON_SIZE.sm} uniProps={mutedColorMapping} />;
const moveDownIcon = <ThemedArrowDown size={ICON_SIZE.sm} uniProps={mutedColorMapping} />;
const editProfileIcon = <ThemedProfilePencil size={ICON_SIZE.sm} uniProps={mutedColorMapping} />;
const removeProfileIcon = <ThemedTrash2 size={ICON_SIZE.sm} uniProps={destructiveColorMapping} />;
const addProfileIcon = <ThemedPlus size={ICON_SIZE.sm} uniProps={mutedColorMapping} />;

function formatHostConnectionLabel(connection: HostConnection, t: TFunction): string {
  if (connection.type === "relay") {
    return `${t("settings.host.badges.relay")} (${connection.relayEndpoint})`;
  }
  if (connection.type === "directSocket" || connection.type === "directPipe") {
    return `${t("settings.host.badges.local")} (${connection.path})`;
  }
  return `TCP (${connection.endpoint})`;
}

function formatActiveConnectionBadge(
  activeConnection: { type: HostConnection["type"]; display: string } | null,
  theme: ReturnType<typeof useUnistyles>["theme"],
  t: TFunction,
): { icon: React.ReactNode; text: string } | null {
  if (!activeConnection) return null;
  if (activeConnection.type === "relay") {
    return {
      icon: <Globe size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />,
      text: t("settings.host.badges.relay"),
    };
  }
  if (activeConnection.type === "directSocket" || activeConnection.type === "directPipe") {
    return {
      icon: <Monitor size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />,
      text: t("settings.host.badges.local"),
    };
  }
  return {
    icon: <Monitor size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />,
    text: activeConnection.display,
  };
}

function formatDaemonVersionBadge(version: string | null): string | null {
  const trimmed = version?.trim();
  if (!trimmed) return null;
  return trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
}

function useHostProfile(serverId: string): HostProfile | null {
  const daemons = useHosts();
  return daemons.find((entry) => entry.serverId === serverId) ?? null;
}

function HostNotFound() {
  const { t } = useTranslation();
  return (
    <View>
      <View style={[settingsStyles.card, styles.emptyCard]}>
        <Text style={styles.emptyText}>{t("settings.host.notFound")}</Text>
      </View>
    </View>
  );
}

function HostStatusBadges({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  const snapshot = useHostRuntimeSnapshot(serverId);
  const daemonVersion = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.version ?? null,
  );

  const connectionStatus = snapshot?.connectionStatus ?? "connecting";
  const activeConnection = snapshot?.activeConnection ?? null;
  const statusLabel = formatConnectionStatus(connectionStatus);
  const statusTone = getConnectionStatusTone(connectionStatus);
  let statusColor: string;
  if (statusTone === "success") {
    statusColor = theme.colors.palette.green[400];
  } else if (statusTone === "warning") {
    statusColor = theme.colors.palette.amber[500];
  } else if (statusTone === "error") {
    statusColor = theme.colors.destructive;
  } else {
    statusColor = theme.colors.foregroundMuted;
  }
  let statusPillBg: string;
  if (statusTone === "success") {
    statusPillBg = "rgba(74, 222, 128, 0.1)";
  } else if (statusTone === "warning") {
    statusPillBg = "rgba(245, 158, 11, 0.1)";
  } else if (statusTone === "error") {
    statusPillBg = "rgba(248, 113, 113, 0.1)";
  } else {
    statusPillBg = "rgba(161, 161, 170, 0.1)";
  }
  const connectionBadge = formatActiveConnectionBadge(activeConnection, theme, t);
  const versionBadgeText = formatDaemonVersionBadge(daemonVersion);

  const statusPillStyle = useMemo(
    () => [styles.statusPill, { backgroundColor: statusPillBg }],
    [statusPillBg],
  );
  const statusDotStyle = useMemo(
    () => [styles.statusDot, { backgroundColor: statusColor }],
    [statusColor],
  );
  const statusTextStyle = useMemo(() => [styles.statusText, { color: statusColor }], [statusColor]);

  return (
    <View style={styles.identityBadges} testID="host-page-identity">
      <View style={statusPillStyle}>
        <View style={statusDotStyle} />
        <Text style={statusTextStyle}>{statusLabel}</Text>
      </View>
      {connectionBadge ? (
        <View style={styles.badgePill}>
          {connectionBadge.icon}
          <Text style={styles.badgeText} numberOfLines={1}>
            {connectionBadge.text}
          </Text>
        </View>
      ) : null}
      {versionBadgeText ? (
        <View style={styles.badgePill}>
          <Text style={styles.badgeText} numberOfLines={1}>
            {versionBadgeText}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

function HostConnectionError({ serverId }: { serverId: string }) {
  const snapshot = useHostRuntimeSnapshot(serverId);
  const lastError = snapshot?.lastError ?? null;
  const connectionError =
    typeof lastError === "string" && lastError.trim().length > 0 ? lastError.trim() : null;
  if (!connectionError) return null;
  return <Text style={styles.errorText}>{connectionError}</Text>;
}

export function HostConnectionsPage({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const host = useHostProfile(serverId);
  const isLocalDaemon = useIsLocalDaemon(serverId);

  if (!host) {
    return <HostNotFound />;
  }

  return (
    <View>
      <HostConnectionError serverId={serverId} />
      <ConnectionsSection host={host} />
      {isLocalDaemon ? (
        <SettingsSection title={t("settings.host.pairDevices.title")}>
          <PairDeviceRow />
        </SettingsSection>
      ) : null}
    </View>
  );
}

export function HostAgentsPage({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const host = useHostProfile(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);

  if (!host) {
    return <HostNotFound />;
  }

  return (
    <View>
      {isConnected ? (
        <SettingsSection title={t("settings.hostSections.agents")}>
          <InjectPaseoToolsCard serverId={serverId} />
          <BrowserToolsOptInCard serverId={serverId} />
          <AppendSystemPromptCard serverId={serverId} />
        </SettingsSection>
      ) : (
        <View style={[settingsStyles.card, styles.emptyCard]}>
          <Text style={styles.emptyText}>{t("settings.host.agents.unavailable")}</Text>
        </View>
      )}
    </View>
  );
}

export function HostWorkspacesPage({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const host = useHostProfile(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);

  if (!host) {
    return <HostNotFound />;
  }

  return (
    <View>
      {isConnected ? (
        <SettingsSection title={t("settings.hostSections.workspaces")}>
          <AutoArchiveMergedWorkspacesCard serverId={serverId} />
        </SettingsSection>
      ) : (
        <View style={[settingsStyles.card, styles.emptyCard]}>
          <Text style={styles.emptyText}>{t("settings.host.workspaces.unavailable")}</Text>
        </View>
      )}
    </View>
  );
}

export function HostProvidersPage({ serverId }: { serverId: string }) {
  const host = useHostProfile(serverId);

  if (!host) {
    return <HostNotFound />;
  }

  return (
    <View>
      <ProvidersSection serverId={serverId} />
    </View>
  );
}

export function HostUsagePage({ serverId }: { serverId: string }) {
  const host = useHostProfile(serverId);
  const { view: providerUsageView, refresh: refreshProviderUsage } = useProviderUsage(serverId);
  const handleRefresh = useCallback(() => {
    void refreshProviderUsage();
  }, [refreshProviderUsage]);

  if (!host) {
    return <HostNotFound />;
  }

  return (
    <View>
      <ProviderUsageSettingsSection view={providerUsageView} onRefresh={handleRefresh} />
    </View>
  );
}

export function HostSettingsPage({
  serverId,
  onHostRemoved,
}: {
  serverId: string;
  onHostRemoved?: () => void;
}) {
  const host = useHostProfile(serverId);
  const isLocalDaemon = useIsLocalDaemon(serverId);

  if (!host) {
    return <HostNotFound />;
  }

  return (
    <View>
      <View style={styles.daemonHeader}>
        <Text style={styles.daemonHeaderLabel} numberOfLines={1}>
          {host.label}
        </Text>
        <HostRenameButton host={host} />
      </View>

      <HostStatusBadges serverId={serverId} />

      <GinitHubSection serverId={serverId} />

      {isLocalDaemon ? <LocalDaemonSection /> : null}

      {!isLocalDaemon ? <UpdateDaemonCard key={host.serverId} host={host} /> : null}

      <RemoveHostSection host={host} isLocalDaemon={isLocalDaemon} onRemoved={onHostRemoved} />
    </View>
  );
}

export function HostRenameButton({ host }: { host: HostProfile }) {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  const { renameHost } = useHostMutations();
  const [isEditing, setIsEditing] = useState(false);

  const handleSubmit = useCallback(
    async (value: string) => {
      const nextLabel = value.trim();
      if (nextLabel === host.label.trim()) return;
      await renameHost(host.serverId, nextLabel);
    },
    [host.label, host.serverId, renameHost],
  );

  const openEditor = useCallback(() => setIsEditing(true), []);
  const closeEditor = useCallback(() => setIsEditing(false), []);

  return (
    <>
      <Pressable
        onPress={openEditor}
        hitSlop={8}
        style={styles.identityEditButton}
        accessibilityRole="button"
        accessibilityLabel={t("settings.host.daemon.rename.editLabel")}
        testID="host-page-label-edit-button"
      >
        <Pencil size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
      </Pressable>

      <AdaptiveRenameModal
        visible={isEditing}
        title={t("settings.host.daemon.rename.title")}
        initialValue={host.label}
        placeholder={t("settings.host.daemon.rename.placeholder")}
        submitLabel={t("settings.host.daemon.rename.submit")}
        onClose={closeEditor}
        onSubmit={handleSubmit}
        testID="host-page-rename-modal"
      />
    </>
  );
}

interface HubListedDevice {
  deviceId: string;
  daemonId: string;
  name: string;
  status: string;
  lastSeenAt: string | null;
  isSelf: boolean;
  publicKey?: string;
  relayEndpoint?: string | null;
  relayUseTls?: boolean | null;
  connectionReady?: boolean;
}

const LAST_DEFAULT_HOST_STORAGE_KEY = "ginit.hub.lastDefaultHost";

async function loadLastDefaultHostListen(): Promise<string | null> {
  try {
    const { default: AsyncStorage } = await import("@react-native-async-storage/async-storage");
    const raw = await AsyncStorage.getItem(LAST_DEFAULT_HOST_STORAGE_KEY);
    const trimmed = raw?.trim() ?? "";
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

async function saveLastDefaultHostListen(listen: string): Promise<void> {
  try {
    const { default: AsyncStorage } = await import("@react-native-async-storage/async-storage");
    await AsyncStorage.setItem(LAST_DEFAULT_HOST_STORAGE_KEY, listen);
  } catch {
    // best-effort convenience only
  }
}

function GinitHubSection({ serverId }: { serverId: string }) {
  const daemonClient = useHostRuntimeClient(serverId);
  const hosts = useHosts();
  const { upsertRelayConnection } = useHostMutations();
  const [enrollStatus, setEnrollStatus] = useState<{
    enrolled: boolean;
    deviceId: string | null;
    hubUrl: string | null;
  } | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [hubDevices, setHubDevices] = useState<HubListedDevice[] | null>(null);
  const [isDevicesLoading, setIsDevicesLoading] = useState(false);
  const [defaultHostListen, setDefaultHostListen] = useState("");
  const [isSavingDefault, setIsSavingDefault] = useState(false);
  const [applyingDeviceId, setApplyingDeviceId] = useState<string | null>(null);
  const [appliedDeviceId, setAppliedDeviceId] = useState<string | null>(null);

  const refreshDevices = useCallback(async () => {
    if (!daemonClient) return;
    setIsDevicesLoading(true);
    try {
      const res = await daemonClient.hubListDevices();
      if (res.success) {
        setHubDevices(res.devices);
      } else {
        setErrorMessage(res.error ?? "Failed to load enrolled hosts");
      }
    } catch (error) {
      console.warn("[GinitHubSection] Failed to list hub devices", error);
    } finally {
      setIsDevicesLoading(false);
    }
  }, [daemonClient]);

  useEffect(() => {
    if (!daemonClient) return;
    daemonClient
      .hubGetEnrollStatus()
      .then((res) => {
        setEnrollStatus({ enrolled: res.enrolled, deviceId: res.deviceId, hubUrl: res.hubUrl });
        // Web/static hosts are not enrolled but may still hold a cached
        // account token from a previous Feishu login — they can list devices
        // read-only without being a hub device.
        void refreshDevices();
        return undefined;
      })
      .catch((err) => console.warn("[GinitHubSection] Failed to fetch status", err));
  }, [daemonClient, refreshDevices]);

  useEffect(() => {
    void loadLastDefaultHostListen().then((listen) => {
      if (listen) setDefaultHostListen(listen);
      return undefined;
    });
  }, []);

  const handleLogin = useCallback(async () => {
    if (!daemonClient) return;
    setIsLoading(true);
    setErrorMessage(null);

    try {
      const ginitBaseUrl = getGinitBaseUrl();
      // Device flow runs through the daemon so the browser never fetches the
      // ginit server directly (the ginit server sends no CORS headers).
      const start = await daemonClient.hubDeviceStart(ginitBaseUrl);

      const { openExternalUrl } = await import("@/utils/open-external-url");
      await openExternalUrl(start.verificationUri);

      const deadline = Date.now() + start.expiresIn * 1000;
      let token: string | null = null;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const poll = await daemonClient.hubDevicePoll(ginitBaseUrl, start.deviceCode);
        if (poll.status === "completed") {
          token = poll.token;
          break;
        }
      }
      if (!token) throw new Error("Login timeout");

      const enrollRes = await daemonClient.hubLoginGinit(ginitBaseUrl, token, {
        // The web host is a read-only Hub client and must never enroll itself.
        cacheOnly: true,
      });
      if (!enrollRes.success) {
        throw new Error(enrollRes.error || "Enrollment failed");
      }

      // A cache-only login returns no device identity: the host is a
      // web/static read-only view, not a hub device.
      const enrolled = enrollRes.deviceId !== null;
      setEnrollStatus({
        enrolled,
        deviceId: enrollRes.deviceId,
        hubUrl: enrollRes.hubUrl,
      });
      // Login persists a fresh account token, so the device list works
      // again even if a previous token had expired or was never cached.
      void refreshDevices();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsLoading(false);
    }
  }, [daemonClient, refreshDevices]);

  const handleSaveDefault = useCallback(async () => {
    const trimmed = defaultHostListen.trim();
    if (!trimmed) return;
    setIsSavingDefault(true);
    setErrorMessage(null);
    try {
      await saveLastDefaultHostListen(trimmed);
    } finally {
      setIsSavingDefault(false);
    }
  }, [defaultHostListen]);

  const handleApplyDevice = useCallback(
    async (device: HubListedDevice) => {
      if (device.status !== "online" || device.connectionReady !== true) {
        setErrorMessage(
          "This daemon is not ready for Relay connection. Update the host and retry.",
        );
        return;
      }
      if (!device.relayEndpoint || !device.publicKey) {
        setErrorMessage(
          "This daemon is missing Relay connection metadata. Update the host and retry.",
        );
        return;
      }
      setApplyingDeviceId(device.deviceId);
      setErrorMessage(null);
      try {
        await upsertRelayConnection({
          serverId: device.daemonId,
          relayEndpoint: device.relayEndpoint,
          useTls: device.relayUseTls ?? undefined,
          daemonPublicKeyB64: device.publicKey,
          label: device.name,
        });
        setAppliedDeviceId(device.deviceId);
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : String(error));
      } finally {
        setApplyingDeviceId(null);
      }
    },
    [upsertRelayConnection],
  );

  if (!daemonClient) return null;

  // A web/static host is never a hub device: it only proxies read-only
  // account reads for the browser. Once devices load, render the same
  // read-only list as the welcome screen instead of an enroll action.
  if (!enrollStatus?.enrolled && hubDevices !== null) {
    return (
      <SettingsSection title="Ginit Hub">
        <View style={settingsStyles.card}>
          <View style={ginitHubStyles.container}>
            <Text style={ginitHubStyles.deviceMeta}>
              This web host is read-only — it is not enrolled as a device. Only real daemons
              enrolled via the ginit CLI appear below.
            </Text>
            <GinitDeviceList
              devices={hubDevices}
              isLoading={isDevicesLoading}
              hosts={hosts}
              applyingDeviceId={applyingDeviceId}
              appliedDeviceId={appliedDeviceId}
              defaultHostListen={defaultHostListen}
              isSavingDefault={isSavingDefault}
              needsRelogin={false}
              isLoggingIn={isLoading}
              isEnrolled={false}
              onChangeDefaultListen={setDefaultHostListen}
              onSaveDefault={handleSaveDefault}
              onRefresh={refreshDevices}
              onRelogin={handleLogin}
              onApply={handleApplyDevice}
            />
            {errorMessage ? <Text style={ginitHubStyles.errorText}>{errorMessage}</Text> : null}
          </View>
        </View>
      </SettingsSection>
    );
  }

  return (
    <SettingsSection title="Ginit Hub">
      <View style={settingsStyles.card}>
        {enrollStatus?.enrolled ? (
          <View style={ginitHubStyles.container}>
            <Text style={ginitHubStyles.enrolledLabel}>Device enrolled</Text>
            <Text style={ginitHubStyles.deviceId}>{enrollStatus.deviceId}</Text>

            <GinitDeviceList
              devices={hubDevices}
              isLoading={isDevicesLoading}
              hosts={hosts}
              applyingDeviceId={applyingDeviceId}
              appliedDeviceId={appliedDeviceId}
              defaultHostListen={defaultHostListen}
              isSavingDefault={isSavingDefault}
              needsRelogin={errorMessage !== null && hubDevices === null}
              isLoggingIn={isLoading}
              onChangeDefaultListen={setDefaultHostListen}
              onSaveDefault={handleSaveDefault}
              onRefresh={refreshDevices}
              onRelogin={handleLogin}
              onApply={handleApplyDevice}
            />
            {errorMessage ? <Text style={ginitHubStyles.errorText}>{errorMessage}</Text> : null}
          </View>
        ) : (
          <View style={ginitHubStyles.container}>
            <Button onPress={handleLogin} disabled={isLoading} style={ginitHubStyles.loginButton}>
              {isLoading ? "Logging in..." : "Login with Feishu"}
            </Button>
            {errorMessage ? <Text style={ginitHubStyles.errorText}>{errorMessage}</Text> : null}
          </View>
        )}
      </View>
    </SettingsSection>
  );
}

function GinitDeviceRow(props: {
  device: HubListedDevice;
  canApply: boolean;
  isApplying: boolean;
  isApplied: boolean;
  isSelf: boolean;
  onApply: (device: HubListedDevice) => void;
}) {
  const { device, canApply, isApplying, isApplied, isSelf, onApply } = props;
  const handlePress = useCallback(() => {
    onApply(device);
  }, [onApply, device]);

  let applyLabel = "Connect here";
  if (isApplied) {
    applyLabel = "Added";
  } else if (isApplying) {
    applyLabel = "Adding...";
  }

  return (
    <View style={ginitHubStyles.deviceRow}>
      <View style={ginitHubStyles.deviceInfo}>
        <Text style={ginitHubStyles.deviceName} numberOfLines={1}>
          {device.name}
          {isSelf ? " (this host)" : ""}
        </Text>
        <Text style={ginitHubStyles.deviceMeta} numberOfLines={1}>
          {device.status} · {device.daemonId.slice(0, 8)}
        </Text>
      </View>
      <Button
        variant="outline"
        size="sm"
        onPress={handlePress}
        disabled={!canApply || isApplying || isApplied}
        testID={`ginit-hub-apply-${device.deviceId}`}
      >
        {applyLabel}
      </Button>
    </View>
  );
}

function GinitDeviceList(props: {
  devices: HubListedDevice[] | null;
  isLoading: boolean;
  hosts: HostProfile[];
  applyingDeviceId: string | null;
  appliedDeviceId: string | null;
  defaultHostListen: string;
  isSavingDefault: boolean;
  needsRelogin: boolean;
  isLoggingIn: boolean;
  isEnrolled?: boolean;
  onChangeDefaultListen: (value: string) => void;
  onSaveDefault: () => void;
  onRefresh: () => void;
  onRelogin: () => void;
  onApply: (device: HubListedDevice) => void;
}) {
  const {
    devices,
    isLoading,
    hosts,
    applyingDeviceId,
    appliedDeviceId,
    defaultHostListen,
    isSavingDefault,
    needsRelogin,
    isLoggingIn,
    isEnrolled = true,
    onChangeDefaultListen,
    onSaveDefault,
    onRefresh,
    onRelogin,
    onApply,
  } = props;

  const defaultConnection = useMemo(() => {
    const trimmed = defaultHostListen.trim();
    return trimmed ? connectionFromListen(trimmed) : null;
  }, [defaultHostListen]);

  const defaultAlreadyAdded = useMemo(() => {
    if (!defaultConnection) return false;
    return hosts.some((host) => hostHasConnection(host, defaultConnection));
  }, [hosts, defaultConnection]);

  const handleRefresh = useCallback(() => {
    void onRefresh();
  }, [onRefresh]);

  const handleSaveDefaultPress = useCallback(() => {
    void onSaveDefault();
  }, [onSaveDefault]);

  const handleReloginPress = useCallback(() => {
    void onRelogin();
  }, [onRelogin]);

  return (
    <View style={ginitHubStyles.deviceListContainer} testID="ginit-hub-device-list">
      <View style={ginitHubStyles.deviceListHeader}>
        <Text style={ginitHubStyles.deviceListTitle}>My enrolled hosts</Text>
        <Button
          variant="ghost"
          size="sm"
          onPress={handleRefresh}
          disabled={isLoading}
          testID="ginit-hub-refresh-devices"
        >
          {isLoading ? "Refreshing..." : "Refresh"}
        </Button>
      </View>

      {devices && devices.length > 0 ? (
        devices.map((device) => (
          <GinitDeviceRow
            key={device.deviceId}
            device={device}
            canApply={
              device.status === "online" &&
              device.connectionReady === true &&
              !!device.relayEndpoint &&
              !!device.publicKey
            }
            isApplying={applyingDeviceId === device.deviceId}
            isApplied={
              appliedDeviceId === device.deviceId || (device.isSelf && defaultAlreadyAdded)
            }
            isSelf={isEnrolled && device.isSelf}
            onApply={onApply}
          />
        ))
      ) : (
        <View style={ginitHubStyles.deviceEmptyState}>
          <Text style={ginitHubStyles.deviceMeta}>
            {isLoading ? "Loading devices..." : "No enrolled hosts found for this account."}
          </Text>
          {needsRelogin ? (
            <Button
              variant="outline"
              size="sm"
              onPress={handleReloginPress}
              disabled={isLoggingIn}
              testID="ginit-hub-relogin"
            >
              {isLoggingIn ? "Logging in..." : "Login with Feishu again"}
            </Button>
          ) : null}
        </View>
      )}

      <View style={ginitHubStyles.defaultHostSection}>
        <Text style={ginitHubStyles.deviceListTitle}>Default host address</Text>
        <Text style={ginitHubStyles.deviceMeta}>
          New Feishu logins connect here automatically — no host or password needed.
        </Text>
        <View style={ginitHubStyles.defaultHostRow}>
          <View style={ginitHubStyles.defaultHostInputWrapper}>
            <TextInput
              style={ginitHubStyles.defaultHostInput}
              value={defaultHostListen}
              onChangeText={onChangeDefaultListen}
              placeholder="192.168.3.2:8234"
              autoCapitalize="none"
              autoCorrect={false}
              testID="ginit-hub-default-host-input"
            />
          </View>
          <Button
            variant="outline"
            size="sm"
            onPress={handleSaveDefaultPress}
            disabled={isSavingDefault || defaultHostListen.trim().length === 0}
            testID="ginit-hub-save-default-host"
          >
            {isSavingDefault ? "Saving..." : "Set default"}
          </Button>
        </View>
      </View>
    </View>
  );
}

function ConnectionsSection({ host }: { host: HostProfile }) {
  const { t } = useTranslation();
  const { removeConnection } = useHostMutations();
  const snapshot = useHostRuntimeSnapshot(host.serverId);
  const probeByConnectionId = snapshot?.probeByConnectionId ?? new Map();
  const [pendingRemoveConnection, setPendingRemoveConnection] = useState<{
    connectionId: string;
    title: string;
  } | null>(null);
  const [isRemovingConnection, setIsRemovingConnection] = useState(false);
  const removeConnectionHeader = useMemo<SheetHeader>(
    () => ({ title: t("settings.host.connections.removeTitle") }),
    [t],
  );

  const handleRequestRemove = useCallback(
    (connection: HostConnection) => {
      setPendingRemoveConnection({
        connectionId: connection.id,
        title: formatHostConnectionLabel(connection, t),
      });
    },
    [t],
  );

  const handleCloseConfirm = useCallback(() => {
    if (isRemovingConnection) return;
    setPendingRemoveConnection(null);
  }, [isRemovingConnection]);

  const handleCancelConfirm = useCallback(() => {
    setPendingRemoveConnection(null);
  }, []);

  const handleConfirmRemove = useCallback(() => {
    if (!pendingRemoveConnection) return;
    const { connectionId } = pendingRemoveConnection;
    setIsRemovingConnection(true);
    void removeConnection(host.serverId, connectionId)
      .then(() => setPendingRemoveConnection(null))
      .catch((error) => {
        console.error("[HostPage] Failed to remove connection", error);
        Alert.alert(
          t("settings.host.connections.removeErrorTitle"),
          t("settings.host.connections.removeErrorMessage"),
        );
      })
      .finally(() => setIsRemovingConnection(false));
  }, [pendingRemoveConnection, removeConnection, host.serverId, t]);

  return (
    <SettingsSection title={t("settings.host.connections.title")}>
      <View style={settingsStyles.card} testID="host-page-connections-card">
        {host.connections.map((conn, index) => {
          const probe = probeByConnectionId.get(conn.id);
          return (
            <ConnectionRow
              key={conn.id}
              connection={conn}
              showBorder={index > 0}
              latencyMs={probe?.status === "available" ? probe.latencyMs : undefined}
              latencyLoading={!probe || probe.status === "pending"}
              latencyError={probe?.status === "unavailable"}
              onRemove={handleRequestRemove}
            />
          );
        })}
      </View>

      {pendingRemoveConnection ? (
        <AdaptiveModalSheet
          header={removeConnectionHeader}
          visible
          onClose={handleCloseConfirm}
          testID="remove-connection-confirm-modal"
        >
          <Text style={styles.confirmText}>
            {t("settings.host.connections.removeMessage", {
              name: pendingRemoveConnection.title,
            })}
          </Text>
          <View style={styles.confirmActions}>
            <Button
              variant="secondary"
              size="sm"
              style={FLEX_1_STYLE}
              onPress={handleCancelConfirm}
              disabled={isRemovingConnection}
            >
              {t("common.actions.cancel")}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              style={FLEX_1_STYLE}
              onPress={handleConfirmRemove}
              disabled={isRemovingConnection}
              testID="remove-connection-confirm"
            >
              {t("settings.host.connections.removeAction")}
            </Button>
          </View>
        </AdaptiveModalSheet>
      ) : null}
    </SettingsSection>
  );
}

function ConnectionRow({
  connection,
  showBorder,
  latencyMs,
  latencyLoading,
  latencyError,
  onRemove,
}: {
  connection: HostConnection;
  showBorder: boolean;
  latencyMs: number | null | undefined;
  latencyLoading: boolean;
  latencyError: boolean;
  onRemove: (connection: HostConnection) => void;
}) {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  const title = formatHostConnectionLabel(connection, t);

  const latencyText = (() => {
    if (latencyLoading) return "...";
    if (latencyError) return t("settings.host.connections.timeout");
    if (latencyMs != null) return formatLatency(latencyMs);
    return "—";
  })();
  const latencyColor = latencyError ? theme.colors.palette.red[300] : theme.colors.foregroundMuted;

  const handlePressRemove = useCallback(() => {
    onRemove(connection);
  }, [onRemove, connection]);

  const rowStyle = useMemo(
    () => [settingsStyles.row, showBorder && settingsStyles.rowBorder],
    [showBorder],
  );
  const latencyTextStyle = useMemo(
    () => [styles.connectionLatency, { color: latencyColor }],
    [latencyColor],
  );
  const destructiveTextStyle = useMemo(
    () => ({ color: theme.colors.destructive }),
    [theme.colors.destructive],
  );

  return (
    <View style={rowStyle}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle} numberOfLines={1}>
          {title}
        </Text>
      </View>
      <Text style={latencyTextStyle}>{latencyText}</Text>
      <Button
        variant="ghost"
        size="sm"
        textStyle={destructiveTextStyle}
        onPress={handlePressRemove}
      >
        {t("settings.host.connections.removeAction")}
      </Button>
    </View>
  );
}

const delay = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

function RestartDaemonCard({ host }: { host: HostProfile }) {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  const daemonClient = useHostRuntimeClient(host.serverId);
  const isConnected = useHostRuntimeIsConnected(host.serverId);
  const runtime = getHostRuntimeStore();
  const [isRestarting, setIsRestarting] = useState(false);
  const isMountedRef = useRef(true);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const isHostConnected = useCallback(
    () => isHostRuntimeConnected(runtime.getSnapshot(host.serverId)),
    [host.serverId, runtime],
  );

  const waitForCondition = useCallback(
    async (predicate: () => boolean, timeoutMs: number, intervalMs = 250) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (!isMountedRef.current) return false;
        if (predicate()) return true;
        await delay(intervalMs);
      }
      return predicate();
    },
    [],
  );

  const waitForDaemonRestart = useCallback(
    async (restartRequest: Promise<void>) => {
      const disconnectTimeoutMs = 30000;
      const reconnectTimeoutMs = 30000;
      const requestFailureDisconnectGraceMs = 2000;
      const disconnectedPromise = isHostConnected()
        ? waitForCondition(() => !isHostConnected(), disconnectTimeoutMs)
        : Promise.resolve(true);
      const restartResult = await restartRequest.then(
        () => ({ status: "accepted" as const }),
        async (error) => ({
          status: "rejected" as const,
          error,
          disconnectedAfterFailure: await waitForCondition(
            () => !isHostConnected(),
            requestFailureDisconnectGraceMs,
            100,
          ),
        }),
      );
      if (!isMountedRef.current) return;

      if (restartResult.status === "rejected" && !restartResult.disconnectedAfterFailure) {
        console.error(`[HostPage] Failed to restart daemon ${host.label}`, restartResult.error);
        setIsRestarting(false);
        Alert.alert(
          t("settings.host.daemon.restart.requestFailedTitle"),
          t("settings.host.daemon.restart.requestFailedMessage"),
        );
        return;
      }

      const disconnected =
        restartResult.status === "rejected"
          ? restartResult.disconnectedAfterFailure
          : await disconnectedPromise;
      const reconnected =
        disconnected && (await waitForCondition(() => isHostConnected(), reconnectTimeoutMs));
      if (isMountedRef.current) {
        setIsRestarting(false);
        if (!reconnected) {
          Alert.alert(
            t("settings.host.daemon.restart.unableToReconnectTitle"),
            t("settings.host.daemon.restart.unableToReconnectMessage", { name: host.label }),
          );
        }
      }
    },
    [host.label, isHostConnected, t, waitForCondition],
  );

  const handleRestart = useCallback(() => {
    if (!daemonClient) {
      Alert.alert(
        t("settings.host.daemon.restart.unavailableTitle"),
        t("settings.host.daemon.restart.unavailableMessage"),
      );
      return;
    }
    if (!isHostConnected()) {
      Alert.alert(
        t("settings.host.daemon.restart.offlineTitle"),
        t("settings.host.daemon.restart.offlineMessage"),
      );
      return;
    }

    void confirmDialog({
      title: t("settings.host.daemon.restart.confirmTitle", { name: host.label }),
      message: t("settings.host.daemon.restart.confirmMessage"),
      confirmLabel: t("settings.host.daemon.restart.confirm"),
      cancelLabel: t("common.actions.cancel"),
      destructive: true,
    })
      .then((confirmed) => {
        if (!confirmed) return;
        setIsRestarting(true);
        const restartRequest = restartDaemonFromSettings(
          host.serverId,
          `settings_daemon_restart_${host.serverId}`,
          {
            getIsElectron,
            getDesktopDaemonStatus,
            getDesktopSettings: loadDesktopSettings,
            restartDesktopDaemon,
            restartServer: (reason) => daemonClient.restartServer(reason),
          },
        );
        void waitForDaemonRestart(restartRequest);
        return;
      })
      .catch((error) => {
        console.error(`[HostPage] Failed to open restart confirmation for ${host.label}`, error);
        Alert.alert(
          t("settings.host.daemon.restart.requestFailedTitle"),
          t("settings.host.daemon.restart.dialogFailedMessage"),
        );
      });
  }, [daemonClient, host.label, host.serverId, isHostConnected, t, waitForDaemonRestart]);

  const restartIcon = useMemo(
    () => <RotateCw size={theme.iconSize.sm} color={theme.colors.foreground} />,
    [theme.iconSize.sm, theme.colors.foreground],
  );

  return (
    <View style={settingsStyles.card} testID="host-page-restart-card">
      <View style={settingsStyles.row}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>{t("settings.host.daemon.restart.title")}</Text>
          <Text style={settingsStyles.rowHint}>{t("settings.host.daemon.restart.hint")}</Text>
        </View>
        <Button
          variant="outline"
          size="sm"
          leftIcon={restartIcon}
          onPress={handleRestart}
          disabled={isRestarting || !daemonClient || !isConnected}
          testID="host-page-restart-button"
        >
          {isRestarting
            ? t("settings.host.daemon.restart.restarting")
            : t("settings.host.daemon.restart.confirm")}
        </Button>
      </View>
    </View>
  );
}

type DaemonUpdateState =
  | { status: "idle" }
  | { status: "updating"; phase: string }
  | { status: "failed"; title: string; message: string };

function UpdateDaemonCard({ host }: { host: HostProfile }) {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  const daemonClient = useHostRuntimeClient(host.serverId);
  const isConnected = useHostRuntimeIsConnected(host.serverId);
  const runtime = getHostRuntimeStore();
  const [updateState, setUpdateState] = useState<DaemonUpdateState>({ status: "idle" });
  const isMountedRef = useRef(true);
  const unsubscribeRef = useRef<(() => void) | null>(null);

  const daemonVersion = useSessionStore(
    (state) => state.sessions[host.serverId]?.serverInfo?.version ?? null,
  );
  const supportsSelfUpdate = useSessionStore(
    (state) => state.sessions[host.serverId]?.serverInfo?.features?.daemonSelfUpdate === true,
  );
  const desktopManaged = useSessionStore(
    (state) => state.sessions[host.serverId]?.serverInfo?.desktopManaged === true,
  );

  const appVersion = resolveAppVersion();
  const hasVersionMismatch = isVersionMismatch(appVersion, daemonVersion);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
      unsubscribeRef.current?.();
    };
  }, []);

  const isHostConnected = useCallback(
    () => isHostRuntimeConnected(runtime.getSnapshot(host.serverId)),
    [host.serverId, runtime],
  );
  const hasReconnectedAfter = useCallback(
    (startMarker: DaemonConnectionMarker | null) =>
      hasDaemonReconnectedAfter(runtime.getSnapshot(host.serverId), startMarker),
    [host.serverId, runtime],
  );

  const waitForCondition = useCallback(
    async (predicate: () => boolean, timeoutMs: number, intervalMs = 250) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (!isMountedRef.current) return false;
        if (predicate()) return true;
        await delay(intervalMs);
      }
      return predicate();
    },
    [],
  );

  const waitForDaemonRestart = useCallback(
    async (startMarker: DaemonConnectionMarker | null) => {
      const disconnectTimeoutMs = 15000;
      const reconnectTimeoutMs = 120000; // 2 minutes — npm update + restart can take a while
      if (!hasReconnectedAfter(startMarker) && isHostConnected()) {
        await waitForCondition(
          () => !isHostConnected() || hasReconnectedAfter(startMarker),
          disconnectTimeoutMs,
        );
      }
      const reconnected =
        hasReconnectedAfter(startMarker) ||
        (await waitForCondition(() => hasReconnectedAfter(startMarker), reconnectTimeoutMs));
      if (isMountedRef.current) {
        if (!reconnected) {
          setUpdateState({
            status: "failed",
            title: t("settings.host.daemon.update.unableToReconnectTitle"),
            message: t("settings.host.daemon.update.unableToReconnectMessage", {
              name: host.label,
            }),
          });
          return;
        }
        setUpdateState({ status: "idle" });
      }
    },
    [hasReconnectedAfter, host.label, isHostConnected, t, waitForCondition],
  );

  const handleUpdate = useCallback(() => {
    if (!daemonClient) {
      setUpdateState({
        status: "failed",
        title: t("settings.host.daemon.update.unavailableTitle"),
        message: t("settings.host.daemon.update.unavailableMessage"),
      });
      return;
    }
    if (!isHostConnected()) {
      setUpdateState({
        status: "failed",
        title: t("settings.host.daemon.update.offlineTitle"),
        message: t("settings.host.daemon.update.offlineMessage"),
      });
      return;
    }

    void confirmDialog({
      title: t("settings.host.daemon.update.confirmTitle", { name: host.label }),
      message: t("settings.host.daemon.update.confirmMessage"),
      confirmLabel: t("settings.host.daemon.update.confirm"),
      cancelLabel: t("common.actions.cancel"),
      destructive: false,
    })
      .then((confirmed) => {
        if (!confirmed || !isMountedRef.current) return;
        const startSnapshot = runtime.getSnapshot(host.serverId);
        const startMarker = startSnapshot
          ? {
              clientGeneration: startSnapshot.clientGeneration,
              lastOnlineAt: startSnapshot.lastOnlineAt,
            }
          : null;
        setUpdateState({
          status: "updating",
          phase: t("settings.host.daemon.update.phaseStarting"),
        });
        const requestId = `settings_daemon_update_${host.serverId}`;

        const unsubscribe = daemonClient.on("daemon.update.progress", (message) => {
          if (message.payload.requestId !== requestId) return;
          if (!isMountedRef.current) return;
          const { phase } = message.payload;
          if (phase === "starting")
            setUpdateState({
              status: "updating",
              phase: t("settings.host.daemon.update.phaseStarting"),
            });
          else if (phase === "downloading")
            setUpdateState({
              status: "updating",
              phase: t("settings.host.daemon.update.phaseDownloading"),
            });
          else if (phase === "installing")
            setUpdateState({
              status: "updating",
              phase: t("settings.host.daemon.update.phaseInstalling"),
            });
          else if (phase === "complete")
            setUpdateState({
              status: "updating",
              phase: t("settings.host.daemon.update.phaseComplete"),
            });
        });
        unsubscribeRef.current = unsubscribe;

        void daemonClient
          .updateDaemon(requestId)
          .then((response) => {
            unsubscribeRef.current = null;
            unsubscribe();
            if (!response.success) {
              if (!isMountedRef.current) return undefined;
              setUpdateState({
                status: "failed",
                title: t("settings.host.daemon.update.requestFailedTitle"),
                message: t("settings.host.daemon.update.requestFailedMessage", {
                  error: response.error ?? "Unknown error",
                }),
              });
              return undefined;
            }
            // Update succeeded — wait for daemon to restart and reconnect
            void waitForDaemonRestart(startMarker);
            return undefined;
          })
          .catch((error) => {
            unsubscribeRef.current = null;
            unsubscribe();
            console.error(`[HostPage] Failed to update daemon ${host.label}`, error);
            if (!isMountedRef.current) return;
            setUpdateState({
              status: "failed",
              title: t("settings.host.daemon.update.requestFailedTitle"),
              message: t("settings.host.daemon.update.requestFailedMessage", {
                error: error instanceof Error ? error.message : "Unknown error",
              }),
            });
          });
        return;
      })
      .catch((error) => {
        console.error(`[HostPage] Failed to open update confirmation for ${host.label}`, error);
        if (!isMountedRef.current) return;
        setUpdateState({
          status: "failed",
          title: t("settings.host.daemon.update.requestFailedTitle"),
          message: t("settings.host.daemon.update.dialogFailedMessage"),
        });
      });
  }, [daemonClient, host.label, host.serverId, isHostConnected, runtime, t, waitForDaemonRestart]);

  const updateIcon = useMemo(
    () => <ArrowUpToLine size={theme.iconSize.sm} color={theme.colors.foreground} />,
    [theme.iconSize.sm, theme.colors.foreground],
  );

  const shouldShowUpdate = hasVersionMismatch && (supportsSelfUpdate || desktopManaged);
  if (!shouldShowUpdate) {
    return null;
  }

  const isUpdating = updateState.status === "updating";
  const buttonLabel = isUpdating ? updateState.phase : t("settings.host.daemon.update.confirm");

  return (
    <View style={settingsStyles.card} testID="host-page-update-card">
      <View style={settingsStyles.row}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>{t("settings.host.daemon.update.title")}</Text>
          <Text style={settingsStyles.rowHint}>
            {desktopManaged
              ? t("settings.host.daemon.update.desktopManagedHint")
              : t("settings.host.daemon.update.hint")}
          </Text>
        </View>
        <Button
          variant="outline"
          size="sm"
          leftIcon={updateIcon}
          onPress={handleUpdate}
          disabled={desktopManaged || isUpdating || !daemonClient || !isConnected}
          testID="host-page-update-button"
        >
          {buttonLabel}
        </Button>
      </View>
      {updateState.status === "failed" ? (
        <View style={styles.updateFailure}>
          <InlineAlert
            variant="error"
            title={updateState.title}
            description={updateState.message}
            testID="host-page-update-error"
          />
        </View>
      ) : null}
    </View>
  );
}

function InjectPaseoToolsCard({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const isConnected = useHostRuntimeIsConnected(serverId);
  const { config, patchConfig } = useDaemonConfig(serverId);

  const handleValueChange = useCallback(
    (next: boolean) => {
      void patchConfig({
        mcp: {
          injectIntoAgents: next,
        },
      });
    },
    [patchConfig],
  );

  if (!isConnected) return null;

  return (
    <View style={settingsStyles.card} testID="host-page-inject-mcp-card">
      <View style={settingsStyles.row}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>
            {t("settings.host.orchestration.enableTools.title")}
          </Text>
          <Text style={settingsStyles.rowHint}>
            {t("settings.host.orchestration.enableTools.hint")}
          </Text>
        </View>
        <Switch
          value={config?.mcp.injectIntoAgents !== false}
          onValueChange={handleValueChange}
          accessibilityLabel={t("settings.host.orchestration.enableTools.accessibilityLabel")}
        />
      </View>
    </View>
  );
}

function AutoArchiveMergedWorkspacesCard({ serverId }: { serverId: string }) {
  const isConnected = useHostRuntimeIsConnected(serverId);
  const { config, patchConfig } = useDaemonConfig(serverId);

  const handleValueChange = useCallback(
    (next: boolean) => {
      void patchConfig({ autoArchiveAfterMerge: next }).catch((error) => {
        console.error("[HostPage] Failed to update auto-archive after merge", error);
        Alert.alert(
          "Unable to update workspaces",
          error instanceof Error ? error.message : String(error),
        );
      });
    },
    [patchConfig],
  );

  if (!isConnected) return null;

  return (
    <View style={settingsStyles.card} testID="host-page-auto-archive-merged-workspaces-card">
      <View style={settingsStyles.row}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>Archive merged PR workspaces</Text>
          <Text style={settingsStyles.rowHint}>
            Automatically archive clean Paseo workspaces after their pull request is merged
          </Text>
        </View>
        <Switch
          value={config?.autoArchiveAfterMerge === true}
          onValueChange={handleValueChange}
          accessibilityLabel="Archive merged PR workspaces"
          testID="host-page-auto-archive-merged-workspaces-switch"
        />
      </View>
    </View>
  );
}

function EnableTerminalAgentHooksCard({ serverId }: { serverId: string }) {
  const isConnected = useHostRuntimeIsConnected(serverId);
  const { config, patchConfig } = useDaemonConfig(serverId);

  const handleValueChange = useCallback(
    (next: boolean) => {
      void patchConfig({ enableTerminalAgentHooks: next }).catch((error) => {
        console.error("[HostPage] Failed to update terminal agent hooks", error);
        Alert.alert(
          "Unable to update terminal agent hooks",
          error instanceof Error ? error.message : String(error),
        );
      });
    },
    [patchConfig],
  );

  if (!isConnected) return null;

  return (
    <View style={settingsStyles.card} testID="host-page-terminal-agent-hooks-card">
      <View style={settingsStyles.row}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>Enable terminal agent hooks</Text>
          <Text style={settingsStyles.rowHint}>
            Get notifications and status from terminal agents. This installs hooks in your agent
            config files.
          </Text>
        </View>
        <Switch
          value={config?.enableTerminalAgentHooks === true}
          onValueChange={handleValueChange}
          accessibilityLabel="Enable terminal agent hooks"
          testID="host-page-terminal-agent-hooks-switch"
        />
      </View>
    </View>
  );
}

function AppendSystemPromptCard({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const isConnected = useHostRuntimeIsConnected(serverId);
  const { config, patchConfig } = useDaemonConfig(serverId);
  const persistedPrompt = config?.appendSystemPrompt ?? "";
  const [draft, setDraft] = useState(persistedPrompt);
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const header = useMemo<SheetHeader>(
    () => ({ title: t("settings.host.orchestration.systemPrompt.sheetTitle") }),
    [t],
  );

  useEffect(() => {
    setDraft(persistedPrompt);
  }, [persistedPrompt]);

  const hasChanges = draft !== persistedPrompt;

  const handleOpen = useCallback(() => {
    setDraft(persistedPrompt);
    setIsEditing(true);
  }, [persistedPrompt]);

  const handleClose = useCallback(() => {
    if (isSaving) return;
    setDraft(persistedPrompt);
    setIsEditing(false);
  }, [isSaving, persistedPrompt]);

  const handleSave = useCallback(() => {
    setIsSaving(true);
    void patchConfig({ appendSystemPrompt: draft })
      .then(() => {
        setIsEditing(false);
        return;
      })
      .catch((error) => {
        console.error("[HostPage] Failed to save append system prompt", error);
      })
      .finally(() => setIsSaving(false));
  }, [draft, patchConfig]);

  const handleReset = useCallback(() => {
    setDraft(persistedPrompt);
  }, [persistedPrompt]);

  if (!isConnected) return null;

  return (
    <>
      <View style={settingsStyles.card} testID="host-page-append-system-prompt-card">
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>
              {t("settings.host.orchestration.systemPrompt.title")}
            </Text>
            <Text style={settingsStyles.rowHint}>
              {t("settings.host.orchestration.systemPrompt.hint")}
            </Text>
          </View>
          <Button
            variant="outline"
            size="sm"
            onPress={handleOpen}
            testID="host-page-append-system-prompt-edit"
          >
            {t("settings.host.orchestration.systemPrompt.edit")}
          </Button>
        </View>
      </View>

      {isEditing ? (
        <AdaptiveModalSheet
          header={header}
          visible
          onClose={handleClose}
          testID="host-page-append-system-prompt-sheet"
          desktopMaxWidth={560}
        >
          <SettingsTextAreaCard
            testID="host-page-append-system-prompt-input"
            accessibilityLabel={t("settings.host.orchestration.systemPrompt.accessibilityLabel")}
            value={draft}
            onChangeText={setDraft}
            placeholder={t("settings.host.orchestration.systemPrompt.placeholder")}
          />
          <View style={styles.appendPromptActions}>
            <Button
              variant="ghost"
              size="sm"
              onPress={handleReset}
              disabled={!hasChanges || isSaving}
              testID="host-page-append-system-prompt-reset"
            >
              {t("settings.host.orchestration.systemPrompt.reset")}
            </Button>
            <Button
              variant="default"
              size="sm"
              onPress={handleSave}
              disabled={!hasChanges || isSaving}
              testID="host-page-append-system-prompt-save"
            >
              {isSaving
                ? t("settings.host.orchestration.systemPrompt.saving")
                : t("settings.host.orchestration.systemPrompt.save")}
            </Button>
          </View>
        </AdaptiveModalSheet>
      ) : null}
    </>
  );
}

function PairDeviceRow() {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  const [isModalOpen, setIsModalOpen] = useState(false);

  const handleOpen = useCallback(() => setIsModalOpen(true), []);
  const handleClose = useCallback(() => setIsModalOpen(false), []);

  return (
    <View style={settingsStyles.card}>
      <Pressable
        style={settingsStyles.row}
        onPress={handleOpen}
        accessibilityRole="button"
        testID="host-page-pair-device-row"
      >
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>{t("settings.host.pairDevices.rowTitle")}</Text>
          <Text style={settingsStyles.rowHint}>{t("settings.host.pairDevices.rowHint")}</Text>
        </View>
        <ChevronRight size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
      </Pressable>

      <PairDeviceModal
        visible={isModalOpen}
        onClose={handleClose}
        testID="host-page-pair-device-card"
      />
    </View>
  );
}

function RemoveHostSection({
  host,
  isLocalDaemon,
  onRemoved,
}: {
  host: HostProfile;
  isLocalDaemon: boolean;
  onRemoved?: () => void;
}) {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  const { removeHost } = useHostMutations();
  const { updateSettings } = useDesktopSettings();
  const { data: daemonStatusData, setStatus } = useDaemonStatus();
  const [isConfirming, setIsConfirming] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);
  const daemonStatus = daemonStatusData?.status ?? null;
  const removeHostHeader = useMemo<SheetHeader>(
    () => ({
      title: isLocalDaemon
        ? t("settings.host.daemon.remove.localConfirmTitle")
        : t("settings.host.daemon.remove.title"),
    }),
    [isLocalDaemon, t],
  );

  const destructiveTextStyle = useMemo(
    () => ({ color: theme.colors.destructive }),
    [theme.colors.destructive],
  );

  const handleOpenConfirm = useCallback(() => setIsConfirming(true), []);
  const handleCloseConfirm = useCallback(() => {
    if (isRemoving) return;
    setIsConfirming(false);
  }, [isRemoving]);
  const handleCancel = useCallback(() => setIsConfirming(false), []);
  const rollbackLocalhostRemoval = useCallback(
    async (shouldRestartDaemon: boolean) => {
      await updateSettings({ daemon: { manageBuiltInDaemon: true } });
      if (!shouldRestartDaemon) {
        return;
      }
      setStatus(await startDesktopDaemon());
    },
    [setStatus, updateSettings],
  );
  const handleConfirmRemove = useCallback(() => {
    setIsRemoving(true);
    const remove = async () => {
      let didDisableDaemonManagement = false;
      let didStopDaemon = false;
      if (isLocalDaemon) {
        try {
          await updateSettings({ daemon: { manageBuiltInDaemon: false } });
          didDisableDaemonManagement = true;
          if (daemonStatus?.status === "running" && daemonStatus.desktopManaged) {
            setStatus(await stopDesktopDaemon("host_remove"));
            didStopDaemon = true;
          }
          await removeHost(host.serverId);
        } catch (error) {
          if (didDisableDaemonManagement) {
            try {
              await rollbackLocalhostRemoval(didStopDaemon);
            } catch (rollbackError) {
              console.error("[HostPage] Failed to roll back localhost removal", rollbackError);
            }
          }
          throw error;
        }
        return;
      }
      await removeHost(host.serverId);
    };
    void remove()
      .then(() => {
        setIsConfirming(false);
        onRemoved?.();
        return;
      })
      .catch((error) => {
        console.error("[HostPage] Failed to remove host", error);
        Alert.alert(
          t("settings.host.daemon.remove.errorTitle"),
          isLocalDaemon
            ? t("settings.host.daemon.remove.localErrorMessage")
            : t("settings.host.daemon.remove.errorMessage"),
        );
      })
      .finally(() => setIsRemoving(false));
  }, [
    daemonStatus,
    host.serverId,
    isLocalDaemon,
    onRemoved,
    removeHost,
    rollbackLocalhostRemoval,
    setStatus,
    t,
    updateSettings,
  ]);

  const removeIcon = useMemo(
    () => <Trash2 size={theme.iconSize.sm} color={theme.colors.destructive} />,
    [theme.iconSize.sm, theme.colors.destructive],
  );

  return (
    <SettingsSection
      title={t("settings.host.daemon.dangerZone")}
      testID="host-page-remove-host-card"
    >
      <RestartDaemonCard host={host} />

      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>
              {isLocalDaemon
                ? t("settings.host.daemon.remove.localTitle")
                : t("settings.host.daemon.remove.title")}
            </Text>
            <Text style={settingsStyles.rowHint}>
              {isLocalDaemon
                ? t("settings.host.daemon.remove.localHint")
                : t("settings.host.daemon.remove.hint")}
            </Text>
          </View>
          <Button
            variant="outline"
            size="sm"
            leftIcon={removeIcon}
            textStyle={destructiveTextStyle}
            onPress={handleOpenConfirm}
            testID="host-page-remove-host-button"
          >
            {t("settings.host.connections.removeAction")}
          </Button>
        </View>
      </View>

      {isConfirming ? (
        <AdaptiveModalSheet
          header={removeHostHeader}
          visible
          onClose={handleCloseConfirm}
          testID="remove-host-confirm-modal"
        >
          <Text style={styles.confirmText}>
            {isLocalDaemon
              ? t("settings.host.daemon.remove.localConfirmMessage")
              : t("settings.host.daemon.remove.confirmMessage", { name: host.label })}
          </Text>
          <View style={styles.confirmActions}>
            <Button
              variant="secondary"
              size="sm"
              style={FLEX_1_STYLE}
              onPress={handleCancel}
              disabled={isRemoving}
            >
              {t("common.actions.cancel")}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              style={FLEX_1_STYLE}
              onPress={handleConfirmRemove}
              disabled={isRemoving}
              testID="remove-host-confirm"
            >
              {t("settings.host.connections.removeAction")}
            </Button>
          </View>
        </AdaptiveModalSheet>
      ) : null}
    </SettingsSection>
  );
}

// ---------------------------------------------------------------------------
// Terminal Profiles
// ---------------------------------------------------------------------------

function generateProfileId(): string {
  return `profile_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

function parseArgsString(raw: string): string[] | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  return trimmed
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const EMPTY_PROFILE_DRAFT: ProfileDraft = { name: "", command: "", args: "" };

interface TerminalProfileRowProps {
  profile: TerminalProfile;
  isFirst: boolean;
  isLast: boolean;
  onEdit: (id: string) => void;
  onRemove: (id: string) => void;
  onMoveUp: (id: string) => void;
  onMoveDown: (id: string) => void;
}

function TerminalProfileRow({
  profile,
  isFirst,
  isLast,
  onEdit,
  onRemove,
  onMoveUp,
  onMoveDown,
}: TerminalProfileRowProps) {
  const { t } = useTranslation();

  const handleEdit = useCallback(() => onEdit(profile.id), [onEdit, profile.id]);
  const handleRemove = useCallback(() => onRemove(profile.id), [onRemove, profile.id]);
  const handleMoveUp = useCallback(() => onMoveUp(profile.id), [onMoveUp, profile.id]);
  const handleMoveDown = useCallback(() => onMoveDown(profile.id), [onMoveDown, profile.id]);

  const commandText =
    profile.args && profile.args.length > 0
      ? `${profile.command} ${profile.args.join(" ")}`
      : profile.command;

  const rowStyle = useMemo(
    () => [settingsStyles.row, !isFirst && settingsStyles.rowBorder, terminalProfileStyles.row],
    [isFirst],
  );

  const icon = getTerminalProfileIcon(profile);

  return (
    <View style={rowStyle} testID={`terminal-profile-row-${profile.id}`}>
      <View style={terminalProfileStyles.iconWrapper}>
        {icon ? (
          <ThemedDynamicProviderIcon
            iconKey={icon}
            size={ICON_SIZE.md}
            uniProps={mutedColorMapping}
          />
        ) : (
          <ThemedProfileSquareTerminal size={ICON_SIZE.md} uniProps={mutedColorMapping} />
        )}
      </View>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle} numberOfLines={1}>
          {profile.name}
        </Text>
        <Text style={settingsStyles.rowHint} numberOfLines={1}>
          {commandText}
        </Text>
      </View>
      <View style={terminalProfileStyles.rowActions}>
        <Button
          variant="ghost"
          size="sm"
          leftIcon={moveUpIcon}
          onPress={handleMoveUp}
          disabled={isFirst}
          accessibilityLabel={t("settings.host.terminalProfiles.moveUp")}
          testID={`terminal-profile-move-up-${profile.id}`}
        />
        <Button
          variant="ghost"
          size="sm"
          leftIcon={moveDownIcon}
          onPress={handleMoveDown}
          disabled={isLast}
          accessibilityLabel={t("settings.host.terminalProfiles.moveDown")}
          testID={`terminal-profile-move-down-${profile.id}`}
        />
        <Button
          variant="ghost"
          size="sm"
          leftIcon={editProfileIcon}
          onPress={handleEdit}
          accessibilityLabel={t("settings.host.terminalProfiles.editProfile")}
          testID={`terminal-profile-edit-${profile.id}`}
        />
        <Button
          variant="ghost"
          size="sm"
          leftIcon={removeProfileIcon}
          onPress={handleRemove}
          accessibilityLabel={t("settings.host.terminalProfiles.remove")}
          testID={`terminal-profile-remove-${profile.id}`}
        />
      </View>
    </View>
  );
}

function TerminalProfilesSection({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const isConnected = useHostRuntimeIsConnected(serverId);
  const { config, patchConfig } = useDaemonConfig(serverId);
  const [editingProfile, setEditingProfile] = useState<{
    id: string;
    draft: ProfileDraft;
  } | null>(null);
  const [isAdding, setIsAdding] = useState(false);

  const profiles = useMemo(
    () => (config ? resolveTerminalProfiles(config.terminalProfiles) : null),
    [config],
  );

  const saveProfiles = useCallback(
    async (next: TerminalProfile[]) => {
      await patchConfig({ terminalProfiles: next });
    },
    [patchConfig],
  );

  const handleAddOpen = useCallback(() => setIsAdding(true), []);
  const handleAddClose = useCallback(() => setIsAdding(false), []);

  const handleAddSave = useCallback(
    async (draft: ProfileDraft) => {
      const current = profiles ? [...profiles] : [];
      const next: TerminalProfile[] = [
        ...current,
        {
          id: generateProfileId(),
          name: draft.name,
          command: draft.command,
          args: parseArgsString(draft.args),
        },
      ];
      await saveProfiles(next);
      setIsAdding(false);
    },
    [profiles, saveProfiles],
  );

  const handleEditOpen = useCallback(
    (id: string) => {
      const profile = profiles?.find((p) => p.id === id);
      if (!profile) return;
      setEditingProfile({
        id,
        draft: {
          name: profile.name,
          command: profile.command,
          args: profile.args ? profile.args.join(" ") : "",
        },
      });
    },
    [profiles],
  );

  const handleEditClose = useCallback(() => setEditingProfile(null), []);

  const handleEditSave = useCallback(
    async (draft: ProfileDraft) => {
      if (!editingProfile || !profiles) return;
      const next: TerminalProfile[] = profiles.map((p) =>
        p.id === editingProfile.id
          ? {
              ...p,
              name: draft.name,
              command: draft.command,
              args: parseArgsString(draft.args),
            }
          : p,
      );
      await saveProfiles(next);
      setEditingProfile(null);
    },
    [editingProfile, profiles, saveProfiles],
  );

  const handleRemove = useCallback(
    (id: string) => {
      const profile = profiles?.find((p) => p.id === id);
      if (!profile) return;
      void confirmDialog({
        title: t("settings.host.terminalProfiles.removeConfirmTitle"),
        message: t("settings.host.terminalProfiles.removeConfirmMessage", {
          name: profile.name,
        }),
        confirmLabel: t("settings.host.terminalProfiles.remove"),
        cancelLabel: t("common.actions.cancel"),
        destructive: true,
      }).then(async (confirmed) => {
        if (!confirmed || !profiles) return;
        try {
          await saveProfiles(profiles.filter((p) => p.id !== id));
        } catch (error) {
          Alert.alert(
            t("common.errors.unableToSave"),
            error instanceof Error ? error.message : String(error),
          );
        }
        return;
      });
    },
    [profiles, saveProfiles, t],
  );

  const handleMoveUp = useCallback(
    async (id: string) => {
      if (!profiles) return;
      const index = profiles.findIndex((p) => p.id === id);
      if (index <= 0) return;
      const next = [...profiles];
      const [item] = next.splice(index, 1);
      next.splice(index - 1, 0, item);
      try {
        await saveProfiles(next);
      } catch (error) {
        Alert.alert(
          t("common.errors.unableToSave"),
          error instanceof Error ? error.message : String(error),
        );
      }
    },
    [profiles, saveProfiles, t],
  );

  const handleMoveDown = useCallback(
    async (id: string) => {
      if (!profiles) return;
      const index = profiles.findIndex((p) => p.id === id);
      if (index < 0 || index >= profiles.length - 1) return;
      const next = [...profiles];
      const [item] = next.splice(index, 1);
      next.splice(index + 1, 0, item);
      try {
        await saveProfiles(next);
      } catch (error) {
        Alert.alert(
          t("common.errors.unableToSave"),
          error instanceof Error ? error.message : String(error),
        );
      }
    },
    [profiles, saveProfiles, t],
  );

  const addButton = useMemo(
    () => (
      <Button
        variant="ghost"
        size="sm"
        leftIcon={addProfileIcon}
        onPress={handleAddOpen}
        disabled={!isConnected || !profiles}
        testID="terminal-profiles-add-button"
      />
    ),
    [handleAddOpen, isConnected, profiles],
  );

  if (!isConnected) {
    return (
      <View style={settingsStyles.card} testID="terminal-profiles-unavailable">
        <View style={terminalProfileStyles.emptyCard}>
          <Text style={terminalProfileStyles.emptyText}>
            {t("settings.host.terminalProfiles.unavailable")}
          </Text>
        </View>
      </View>
    );
  }

  return (
    <>
      <SettingsSection
        title={t("settings.host.terminalProfiles.sectionTitle")}
        trailing={addButton}
        testID="terminal-profiles-section"
      >
        <View style={settingsStyles.card} testID="terminal-profiles-card">
          {profiles && profiles.length > 0 ? (
            profiles.map((profile, index) => (
              <TerminalProfileRow
                key={profile.id}
                profile={profile}
                isFirst={index === 0}
                isLast={index === profiles.length - 1}
                onEdit={handleEditOpen}
                onRemove={handleRemove}
                onMoveUp={handleMoveUp}
                onMoveDown={handleMoveDown}
              />
            ))
          ) : (
            <View style={terminalProfileStyles.emptyCard}>
              <Text style={terminalProfileStyles.emptyText}>
                {t("settings.host.terminalProfiles.emptyState")}
              </Text>
            </View>
          )}
        </View>
      </SettingsSection>

      <TerminalProfileEditModal
        visible={isAdding}
        title={t("settings.host.terminalProfiles.addProfileTitle")}
        initialDraft={EMPTY_PROFILE_DRAFT}
        onClose={handleAddClose}
        onSave={handleAddSave}
        testID="terminal-profile-edit-modal"
      />

      {editingProfile ? (
        <TerminalProfileEditModal
          visible
          title={t("settings.host.terminalProfiles.editProfileTitle")}
          initialDraft={editingProfile.draft}
          onClose={handleEditClose}
          onSave={handleEditSave}
        />
      ) : null}
    </>
  );
}

export function HostTerminalsPage({ serverId }: { serverId: string }) {
  const host = useHostProfile(serverId);

  if (!host) {
    return <HostNotFound />;
  }

  return (
    <View>
      <SettingsSection title="Terminal agents">
        <EnableTerminalAgentHooksCard serverId={serverId} />
      </SettingsSection>
      <TerminalProfilesSection serverId={serverId} />
    </View>
  );
}

const terminalProfileStyles = StyleSheet.create((theme) => ({
  row: {
    gap: theme.spacing[2],
    minHeight: 56,
  },
  iconWrapper: {
    width: theme.iconSize.md,
    alignItems: "center",
    justifyContent: "center",
  },
  rowActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 0,
  },
  emptyCard: {
    padding: theme.spacing[4],
    alignItems: "center",
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
}));

const ginitHubStyles = StyleSheet.create((theme) => ({
  container: {
    padding: theme.spacing[4],
  },
  enrolledLabel: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    marginBottom: theme.spacing[2],
  },
  deviceId: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  loginButton: {
    marginBottom: theme.spacing[2],
  },
  errorText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.destructive,
    marginTop: theme.spacing[2],
  },
  deviceListContainer: {
    marginTop: theme.spacing[4],
    gap: theme.spacing[2],
  },
  deviceListHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  deviceListTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  deviceRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  deviceInfo: {
    flex: 1,
    gap: 2,
  },
  deviceName: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  deviceMeta: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  deviceEmptyState: {
    gap: theme.spacing[2],
    alignItems: "flex-start",
  },
  defaultHostSection: {
    marginTop: theme.spacing[3],
    gap: theme.spacing[2],
  },
  defaultHostRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  defaultHostInputWrapper: {
    flex: 1,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
    overflow: "hidden",
  },
  defaultHostInput: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
  },
}));

const styles = StyleSheet.create((theme) => ({
  updateFailure: {
    marginHorizontal: theme.spacing[4],
    marginBottom: theme.spacing[4],
  },
  identityEditButton: {
    padding: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
  },
  daemonHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    marginBottom: theme.spacing[4],
  },
  daemonHeaderLabel: {
    flexShrink: 1,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  identityBadges: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flexWrap: "wrap",
    marginBottom: theme.spacing[6],
  },
  statusPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 4,
    borderRadius: theme.borderRadius.full,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: theme.borderRadius.full,
  },
  statusText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
  },
  badgePill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 4,
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface3,
    maxWidth: 200,
  },
  badgeText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
    flexShrink: 1,
  },
  errorText: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.xs,
    marginBottom: theme.spacing[2],
  },
  connectionLatency: {
    fontSize: theme.fontSize.sm,
    marginRight: theme.spacing[2],
  },
  confirmText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  confirmActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    marginTop: theme.spacing[4],
  },
  appendPromptActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
  emptyCard: {
    padding: theme.spacing[4],
    alignItems: "center",
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));

const FLEX_1_STYLE = { flex: 1 };
