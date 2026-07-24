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
}

export interface HubGinitEnrollerOptions {
  paseoHome: string;
  logger: GinitEnrollerLogger;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
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

/**
 * Turns a ginit-server HTTP origin into the Paseo Hub WebSocket URL.
 * Mirrors the ginit-cli logic: swap only the scheme so ports/paths survive.
 */
function toHubWebSocketUrl(ginitBaseUrl: string): string {
  const trimmed = ginitBaseUrl.replace(/\/+$/, "");
  const wsBase = trimmed.replace(/^https:\/\//, "wss://").replace(/^http:\/\//, "ws://");
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
      throw new Error(
        `Ginit enrollment redemption failed (${redeemRes.status})${detail ? `: ${detail}` : ""}`,
      );
    }
    const redemption = RedemptionResultSchema.parse(await redeemRes.json());

    // Step 3: persist hub config. The bootstrap poller connects automatically.
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
        },
      },
    });

    this.logger.info({ deviceId: redemption.device_id, hubUrl }, "Ginit Hub enrollment complete");
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
}
