import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { loadPersistedConfig } from "../persisted-config.js";
import { getOrCreateServerId } from "../server-id.js";
import { loadOrCreateHubDeviceKeyPair, signHubHello } from "./device-keypair.js";

/**
 * Minimal logger surface used by the connector. Kept structural so tests can
 * pass a stub without depending on pino.
 */
export interface HubConnectorLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
  child(bindings: Record<string, unknown>): HubConnectorLogger;
}

export interface HubConnectionStatus {
  connected: boolean;
  hubUrl: string | null;
  deviceId: string | null;
  lastError: string | null;
}

/** A running service (agent) the daemon advertises to the hub. */
export interface HubWorkspaceSnapshotEntry {
  id: string;
  title: string | null;
  cwd: string;
  provider: string | null;
  status: string;
}

export interface HubConnectorOptions {
  paseoHome: string;
  logger: HubConnectorLogger;
  /** Injectable for tests; defaults to `ws`. */
  webSocketImpl?: typeof WebSocket;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
  /** Snapshot of running services sent after `hub.welcome`. */
  workspaceSnapshotProvider?: () => HubWorkspaceSnapshotEntry[];
  /**
   * Runtime relay metadata advertised to the hub. Called on every hello so
   * endpoint/TLS changes propagate without re-enrollment. Return null/omit
   * fields when relay is disabled — the hub keeps its last known values.
   */
  relayMetadataProvider?: () => {
    endpoint: string;
    useTls: boolean;
    publicKey: string;
  } | null;
}

const WS_CLOSE_NORMAL = 1000;
const DEFAULT_RECONNECT_BASE_DELAY_MS = 1_000;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 30_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 20_000;

/**
 * Connects the daemon to the ginit Hub WebSocket (`daemon.hub` config written
 * by GinitHubEnroller) and keeps the connection alive with bounded
 * exponential-backoff reconnects.
 *
 * Protocol (see ginit-server `paseo_hub_gateway.py`):
 *   1. open socket with `Authorization: Bearer pht_...`
 *   2. send signed `hub.hello` (protocolVersion 2, Ed25519 signature over
 *      `2:<deviceId>:<daemonId>:<nonce>`)
 *   3. receive `hub.welcome` (carries heartbeatIntervalMs)
 *   4. send `hub.workspace.snapshot` with running services, then heartbeats
 *
 * The hub marks the device online on hello, so this is what makes the
 * daemon's running services visible to the owner in ginit.
 */
export class HubConnector {
  private readonly logger: HubConnectorLogger;
  private readonly webSocketImpl: typeof WebSocket;
  private readonly reconnectBaseDelayMs: number;
  private readonly reconnectMaxDelayMs: number;

  private socket: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private running = false;
  private generation = 0;
  private lastError: string | null = null;

  constructor(private readonly options: HubConnectorOptions) {
    this.logger = options.logger.child({ module: "hub-connector" });
    this.webSocketImpl = options.webSocketImpl ?? WebSocket;
    this.reconnectBaseDelayMs = options.reconnectBaseDelayMs ?? DEFAULT_RECONNECT_BASE_DELAY_MS;
    this.reconnectMaxDelayMs = options.reconnectMaxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS;
  }

  /**
   * Starts the connector. If `daemon.hub` is configured, opens the hub socket
   * immediately; otherwise stays idle until `connect()` is called (e.g. right
   * after a fresh enrollment).
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    const hub = this.readHubConfig();
    if (hub) {
      this.openSocket(hub);
    } else {
      this.logger.info("Hub not configured; connector idle until enrollment");
    }
  }

  stop(): void {
    this.running = false;
    this.generation += 1;
    this.clearReconnectTimer();
    this.clearHeartbeatTimer();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try {
        socket.close(WS_CLOSE_NORMAL);
      } catch {
        socket.terminate();
      }
    }
  }

  /** True while the hub socket is open. */
  isConnected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  /**
   * Pushes the current running-services snapshot to the hub. Called by the
   * daemon whenever agents change so the hub view stays fresh without
   * waiting for a reconnect.
   */
  pushWorkspaceSnapshot(): void {
    if (this.isConnected() && this.socket) {
      this.sendWorkspaceSnapshot(this.socket);
    }
  }

  status(): HubConnectionStatus {
    const hub = this.readHubConfig();
    return {
      connected: this.isConnected(),
      hubUrl: hub?.url ?? null,
      deviceId: hub?.deviceId ?? null,
      lastError: this.lastError,
    };
  }

  /**
   * Opens the hub socket now. Called by the enrollment RPC right after the
   * hub config is persisted so a freshly enrolled daemon comes online on the
   * hub without waiting for a daemon restart.
   */
  connect(): void {
    if (!this.running) return;
    const hub = this.readHubConfig();
    if (!hub) return;
    if (this.isConnected()) return;
    this.clearReconnectTimer();
    this.reconnectAttempt = 0;
    this.openSocket(hub);
  }

  private readHubConfig(): { url: string; deviceId: string; token: string } | null {
    try {
      const hub = loadPersistedConfig(this.options.paseoHome).daemon?.hub;
      if (hub?.enabled && hub.url && hub.deviceId && hub.token) {
        return { url: hub.url, deviceId: hub.deviceId, token: hub.token };
      }
      return null;
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to read Hub config");
      return null;
    }
  }

  private buildHello(): Record<string, unknown> {
    const keypair = loadOrCreateHubDeviceKeyPair(this.options.paseoHome);
    const daemonId = getOrCreateServerId(this.options.paseoHome);
    const nonce = randomUUID();
    const signature = signHubHello(
      keypair.secretKeyB64,
      `2:${keypair.deviceId}:${daemonId}:${nonce}`,
    );
    // Relay metadata rides the signed hello so the hub treats it as a
    // daemon-authenticated runtime update rather than enrollment-time state.
    const relay = this.options.relayMetadataProvider?.() ?? null;
    const relaySignature = relay
      ? signHubHello(
          keypair.secretKeyB64,
          JSON.stringify(["relay-v1", relay.endpoint, relay.useTls, relay.publicKey]),
        )
      : null;
    return {
      type: "hub.hello",
      protocolVersion: 2,
      deviceId: keypair.deviceId,
      daemonId,
      publicKey: keypair.publicKeyB64,
      nonce,
      signature,
      ...(relay
        ? {
            relay: {
              endpoint: relay.endpoint,
              use_tls: relay.useTls,
              public_key: relay.publicKey,
              signature: relaySignature,
            },
          }
        : {}),
    };
  }

  private openSocket(hub: { url: string; deviceId: string; token: string }): void {
    const generation = ++this.generation;
    const socket = new this.webSocketImpl(hub.url, {
      headers: { authorization: `Bearer ${hub.token}` },
    });
    this.socket = socket;

    socket.once("open", () => {
      if (generation !== this.generation) return;
      this.reconnectAttempt = 0;
      this.lastError = null;
      try {
        socket.send(JSON.stringify(this.buildHello()));
        this.logger.info({ hubUrl: hub.url, deviceId: hub.deviceId }, "Sent hub.hello");
      } catch (error) {
        this.logger.warn({ err: error }, "Failed to send hub.hello");
        socket.close();
      }
    });
    socket.on("message", (data) => {
      if (generation !== this.generation) return;
      this.handleFrame(socket, data);
    });
    socket.once("close", (code, reason) => {
      if (generation !== this.generation) return;
      this.socket = null;
      this.clearHeartbeatTimer();
      this.lastError = `Hub socket closed (${code}${reason.length ? `: ${reason}` : ""})`;
      this.logger.warn({ code, reason: reason.toString() }, "Hub connection closed");
      this.scheduleReconnect();
    });
    socket.once("error", (error) => {
      this.logger.warn({ err: error }, "Hub socket error");
      // A close event follows every error on ws; reconnect happens there.
    });
    socket.once("unexpected-response", (_request, response) => {
      if (generation !== this.generation) {
        response.destroy();
        return;
      }
      this.lastError = `Hub rejected the connection (${response.statusCode})`;
      this.logger.warn({ statusCode: response.statusCode }, "Hub rejected the connection");
      response.destroy();
      socket.terminate();
    });
  }

  private handleFrame(socket: WebSocket, data: WebSocket.RawData): void {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(data.toString()) as Record<string, unknown>;
    } catch {
      return;
    }
    if (frame.type === "hub.welcome") {
      const heartbeatIntervalMs =
        typeof frame.heartbeatIntervalMs === "number" && frame.heartbeatIntervalMs > 0
          ? frame.heartbeatIntervalMs
          : DEFAULT_HEARTBEAT_INTERVAL_MS;
      this.lastError = null;
      this.logger.info(
        { connectionId: frame.connectionId, heartbeatIntervalMs },
        "Hub welcome received; device online",
      );
      this.sendWorkspaceSnapshot(socket);
      this.startHeartbeat(socket, heartbeatIntervalMs);
    }
  }

  private sendWorkspaceSnapshot(socket: WebSocket): void {
    try {
      const workspaces = this.options.workspaceSnapshotProvider?.() ?? [];
      socket.send(JSON.stringify({ type: "hub.workspace.snapshot", workspaces }));
      this.logger.info({ workspaceCount: workspaces.length }, "Sent hub.workspace.snapshot");
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to send hub.workspace.snapshot");
    }
  }

  private startHeartbeat(socket: WebSocket, intervalMs: number): void {
    this.clearHeartbeatTimer();
    this.heartbeatTimer = setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN) return;
      try {
        socket.send(JSON.stringify({ type: "hub.heartbeat" }));
      } catch (error) {
        this.logger.warn({ err: error }, "Failed to send hub.heartbeat");
      }
    }, intervalMs);
    this.heartbeatTimer.unref?.();
  }

  private clearHeartbeatTimer(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (!this.running) return;
    if (this.reconnectTimer) return;
    const base = Math.min(
      this.reconnectMaxDelayMs,
      this.reconnectBaseDelayMs * 2 ** this.reconnectAttempt++,
    );
    const delay = Math.round(base * (0.75 + Math.random() * 0.5));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.running) return;
      const hub = this.readHubConfig();
      if (hub) this.openSocket(hub);
    }, delay);
    this.reconnectTimer.unref?.();
  }
}
