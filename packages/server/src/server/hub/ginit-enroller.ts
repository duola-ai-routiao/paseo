import { z } from "zod";
import { loadPersistedConfig, savePersistedConfig } from "../persisted-config.js";
import { getOrCreateServerId } from "../server-id.js";
import { loadOrCreateHubDeviceKeyPair } from "./device-keypair.js";

/**
 * Minimal logger surface used by the enroller. Kept structural so tests can
 * pass a stub without depending on pino.
 */
export interface GinitEnrollerLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  child(bindings: Record<string, unknown>): GinitEnrollerLogger;
}

export interface HubGinitEnroller {
  enroll(ginitBaseUrl: string, ginitToken: string): Promise<{ deviceId: string; hubUrl: string }>;
  getStatus(): { enrolled: boolean; deviceId: string | null; hubUrl: string | null };
  deviceStart(ginitBaseUrl: string): Promise<{
    deviceCode: string;
    verificationUri: string;
    expiresIn: number;
  }>;
  devicePoll(
    ginitBaseUrl: string,
    deviceCode: string,
  ): Promise<{ status: "pending" | "completed"; token: string | null }>;
  listDevices(): Promise<{ devices: HubGinitDeviceEntry[] }>;
}

export interface HubGinitDeviceEntry {
  deviceId: string;
  daemonId: string;
  name: string;
  status: string;
  lastSeenAt: string | null;
  isSelf: boolean;
}

export interface HubGinitEnrollerOptions {
  paseoHome: string;
  logger: GinitEnrollerLogger;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /**
   * Called right after the hub config is persisted so the daemon connects to
   * the hub immediately instead of waiting for a restart.
   */
  onHubConfigPersisted?: () => void;
}

const EnrollmentTicketSchema = z.object({
  enrollment_id: z.string(),
  ticket: z.string().min(1),
  expires_at: z.string(),
});

const RedemptionResultSchema = z.object({
  device_id: z.string().min(1),
  token: z.string().min(1),
  hub_protocol: z.number().optional(),
});

const DeviceStartResultSchema = z.object({
  device_code: z.string().min(1),
  verification_uri: z.string().min(1),
  expires_in: z.number(),
});

const DevicePollResultSchema = z.object({
  status: z.enum(["pending", "completed"]),
  token: z.string().min(1).optional(),
});

const DeviceListItemSchema = z.object({
  device_id: z.string(),
  daemon_id: z.string(),
  name: z.string(),
  status: z.string(),
  last_seen_at: z.string().nullable().optional(),
});

const DeviceListResultSchema = z.object({
  items: z.array(DeviceListItemSchema),
});

/**
 * Turns a ginit-server HTTP origin into the Paseo Hub WebSocket URL.
 * Mirrors the ginit-cli logic: swap only the scheme so ports/paths survive.
 * Deployments that split HTTP and WebSocket gateways onto different ports
 * (e.g. testbed: HTTP API on 8090, hub WS gateway on 8235) advertise the WS
 * port via GINIT_PASEO_HUB_WS_PORT.
 */
function toHubWebSocketUrl(ginitBaseUrl: string): string {
  const trimmed = ginitBaseUrl.replace(/\/+$/, "");
  const wsBase = trimmed.replace(/^https:\/\//, "wss://").replace(/^http:\/\//, "ws://");
  const wsPort = process.env.GINIT_PASEO_HUB_WS_PORT?.trim();
  if (wsPort) {
    const parsed = new URL(wsBase);
    parsed.port = wsPort;
    return `${parsed.toString().replace(/\/+$/, "")}/ws/v1/paseo`;
  }
  return `${wsBase}/ws/v1/paseo`;
}

/**
 * Drives the ginit-server Paseo enrollment flow from inside the daemon:
 *   1. POST /api/paseo/enrollments      (Bearer ginit_ token) -> enrollment ticket
 *   2. POST /api/paseo/enrollments/redeem { ticket, device }  -> pht_ device token
 *   3. persist daemon.hub config; bootstrap's syncHubConnector picks it up.
 *
 * Account interconnection is automatic: the Bearer token identifies the ginit
 * user (union_id anchor), and the redeemed device row is bound to that user.
 */
export class GinitHubEnroller implements HubGinitEnroller {
  private readonly logger: GinitEnrollerLogger;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: HubGinitEnrollerOptions) {
    this.logger = options.logger.child({ module: "ginit-hub-enroller" });
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async enroll(
    ginitBaseUrl: string,
    ginitToken: string,
  ): Promise<{ deviceId: string; hubUrl: string }> {
    const normalized = ginitBaseUrl.replace(/\/+$/, "");

    // Step 1: create enrollment ticket.
    const enrollRes = await this.fetchImpl(`${normalized}/api/paseo/enrollments`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ginitToken}`,
      },
    });
    if (!enrollRes.ok) {
      throw new Error(
        `Ginit enrollment request failed (${enrollRes.status} ${enrollRes.statusText})`,
      );
    }
    const ticket = EnrollmentTicketSchema.parse(await enrollRes.json());

    // Step 2: identify this daemon and redeem the ticket for a device token.
    const keypair = loadOrCreateHubDeviceKeyPair(this.options.paseoHome);
    const serverId = getOrCreateServerId(this.options.paseoHome);
    const redeemRes = await this.fetchImpl(`${normalized}/api/paseo/enrollments/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ticket: ticket.ticket,
        device: {
          device_id: keypair.deviceId,
          daemon_id: serverId,
          public_key: keypair.publicKeyB64,
          name: `paseo-${serverId.slice(0, 8)}`,
        },
      }),
    });
    if (!redeemRes.ok) {
      const detail = await redeemRes.text().catch(() => "");
      // A re-login on an already-enrolled device fails redeem with
      // "device_id already enrolled". Keep the existing device credentials
      // and only refresh the cached account token + base URL below.
      if (redeemRes.status === 400 && detail.includes("device_id already enrolled")) {
        const hubUrl = toHubWebSocketUrl(normalized);
        const config = loadPersistedConfig(this.options.paseoHome);
        const existingHub = config.daemon?.hub;
        if (existingHub?.enabled && existingHub.deviceId && existingHub.token) {
          savePersistedConfig(this.options.paseoHome, {
            ...config,
            daemon: {
              ...config.daemon,
              hub: {
                ...existingHub,
                url: existingHub.url ?? hubUrl,
                ginitBaseUrl: normalized,
                ginitToken,
              },
            },
          });
          this.logger.info(
            { deviceId: existingHub.deviceId },
            "Ginit re-login: kept existing device credentials, refreshed account token",
          );
          this.options.onHubConfigPersisted?.();
          return { deviceId: existingHub.deviceId, hubUrl: existingHub.url ?? hubUrl };
        }
      }
      throw new Error(
        `Ginit enrollment redemption failed (${redeemRes.status})${detail ? `: ${detail}` : ""}`,
      );
    }
    const redemption = RedemptionResultSchema.parse(await redeemRes.json());

    // Step 3: persist hub config. The bootstrap poller connects automatically.
    // The ginit user token is cached alongside so clients can proxy account
    // APIs (device list) through this daemon without re-running device auth.
    const hubUrl = toHubWebSocketUrl(normalized);
    const config = loadPersistedConfig(this.options.paseoHome);
    savePersistedConfig(this.options.paseoHome, {
      ...config,
      daemon: {
        ...config.daemon,
        hub: {
          enabled: true,
          url: hubUrl,
          deviceId: redemption.device_id,
          token: redemption.token,
          ginitBaseUrl: normalized,
          ginitToken,
        },
      },
    });

    this.logger.info({ deviceId: redemption.device_id, hubUrl }, "Ginit Hub enrollment complete");
    this.options.onHubConfigPersisted?.();
    return { deviceId: redemption.device_id, hubUrl };
  }

  getStatus(): { enrolled: boolean; deviceId: string | null; hubUrl: string | null } {
    const config = loadPersistedConfig(this.options.paseoHome);
    const hub = config.daemon?.hub;
    if (hub?.enabled && hub.url && hub.deviceId && hub.token) {
      return { enrolled: true, deviceId: hub.deviceId, hubUrl: hub.url };
    }
    return { enrolled: false, deviceId: null, hubUrl: null };
  }

  /**
   * Starts the ginit device-auth flow. Proxied through the daemon so browser
   * clients never hit the ginit server directly (avoids CORS).
   */
  async deviceStart(ginitBaseUrl: string): Promise<{
    deviceCode: string;
    verificationUri: string;
    expiresIn: number;
  }> {
    const normalized = ginitBaseUrl.replace(/\/+$/, "");
    const res = await this.fetchImpl(`${normalized}/auth/device/start`, { method: "POST" });
    if (!res.ok) {
      throw new Error(`Ginit device start failed (${res.status} ${res.statusText})`);
    }
    const data = DeviceStartResultSchema.parse(await res.json());
    return {
      deviceCode: data.device_code,
      verificationUri: data.verification_uri,
      expiresIn: data.expires_in,
    };
  }

  /**
   * Polls the ginit device-auth flow. `pending` means the user has not yet
   * authorized; `completed` carries the ginit_ user token.
   */
  async devicePoll(
    ginitBaseUrl: string,
    deviceCode: string,
  ): Promise<{ status: "pending" | "completed"; token: string | null }> {
    const normalized = ginitBaseUrl.replace(/\/+$/, "");
    const res = await this.fetchImpl(`${normalized}/auth/device/poll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_code: deviceCode }),
    });
    if (res.status === 202) {
      return { status: "pending", token: null };
    }
    if (!res.ok) {
      throw new Error(`Ginit device poll failed (${res.status} ${res.statusText})`);
    }
    const data = DevicePollResultSchema.parse(await res.json());
    if (data.status === "completed") {
      if (!data.token) {
        throw new Error("Ginit device poll completed without a token");
      }
      return { status: "completed", token: data.token };
    }
    return { status: "pending", token: null };
  }

  /**
   * Lists the paseo devices bound to the same ginit account this daemon
   * enrolled with, using the cached user token. `isSelf` marks this daemon's
   * own row so clients can tell "the host I'm connected to" apart from the
   * other enrolled hosts.
   */
  async listDevices(): Promise<{ devices: HubGinitDeviceEntry[] }> {
    const hub = loadPersistedConfig(this.options.paseoHome).daemon?.hub;
    if (!hub?.enabled || !hub.ginitBaseUrl || !hub.ginitToken || !hub.deviceId) {
      throw new Error(
        "Ginit hub device list needs a re-login (no cached account token); run Login with Feishu again",
      );
    }
    const normalized = hub.ginitBaseUrl.replace(/\/+$/, "");
    const res = await this.fetchImpl(`${normalized}/api/paseo/devices`, {
      headers: { authorization: `Bearer ${hub.ginitToken}` },
    });
    if (!res.ok) {
      throw new Error(`Ginit device list failed (${res.status} ${res.statusText})`);
    }
    const data = DeviceListResultSchema.parse(await res.json());
    return {
      devices: data.items.map((item) => ({
        deviceId: item.device_id,
        daemonId: item.daemon_id,
        name: item.name,
        status: item.status,
        lastSeenAt: item.last_seen_at ?? null,
        isSelf: item.device_id === hub.deviceId,
      })),
    };
  }
}
