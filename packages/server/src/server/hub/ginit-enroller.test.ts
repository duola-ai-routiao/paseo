import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { loadPersistedConfig } from "../persisted-config.js";
import { GinitHubEnroller } from "./ginit-enroller.js";

const silentLogger = {
  info: () => {},
  warn: () => {},
  child() {
    return silentLogger;
  },
};

function jsonResponse(body: unknown, init?: { status?: number }): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

describe.skipIf(process.platform === "win32")("GinitHubEnroller", () => {
  test("enroll drives start -> redeem and persists daemon.hub config", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "paseo-ginit-enroll-"));
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = url.toString();
      calls.push({ url: href, init });
      if (href.endsWith("/api/paseo/enrollments")) {
        return jsonResponse({
          enrollment_id: "enr-1",
          ticket: "pet_abc",
          expires_at: "2099-01-01T00:00:00Z",
        });
      }
      if (href.endsWith("/api/paseo/enrollments/redeem")) {
        return jsonResponse({ device_id: "dev-123", token: "pht_secret", hub_protocol: 2 });
      }
      throw new Error(`unexpected fetch ${href}`);
    }) as unknown as typeof fetch;

    const enroller = new GinitHubEnroller({ paseoHome: home, logger: silentLogger, fetchImpl });
    const result = await enroller.enroll("https://ginit.example.com/", "ginit_token");

    expect(result).toEqual({ deviceId: "dev-123", hubUrl: "wss://ginit.example.com/ws/v1/paseo" });

    // Enrollment request carried the bearer token.
    const enrollCall = calls.find((c) => c.url.endsWith("/api/paseo/enrollments"));
    expect((enrollCall?.init?.headers as Record<string, string> | undefined)?.authorization).toBe(
      "Bearer ginit_token",
    );

    // Redeem request carried the device identity.
    const redeemCall = calls.find((c) => c.url.endsWith("/redeem"));
    const redeemBody = JSON.parse(String(redeemCall?.init?.body));
    expect(redeemBody.ticket).toBe("pet_abc");
    expect(redeemBody.device.device_id).toBeTruthy();
    expect(redeemBody.device.daemon_id).toBeTruthy();
    expect(redeemBody.device.public_key).toBeTruthy();

    // Config persisted for the bootstrap poller.
    const config = loadPersistedConfig(home);
    expect(config.daemon?.hub).toEqual({
      enabled: true,
      url: "wss://ginit.example.com/ws/v1/paseo",
      deviceId: "dev-123",
      token: "pht_secret",
    });
  });

  test("getStatus reflects persisted enrollment", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "paseo-ginit-status-"));
    const enroller = new GinitHubEnroller({ paseoHome: home, logger: silentLogger });
    expect(enroller.getStatus()).toEqual({ enrolled: false, deviceId: null, hubUrl: null });

    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = url.toString();
      if (href.endsWith("/api/paseo/enrollments")) {
        return jsonResponse({
          enrollment_id: "e",
          ticket: "pet_x",
          expires_at: "2099-01-01T00:00:00Z",
        });
      }
      return jsonResponse({ device_id: "dev-9", token: "pht_9" });
    }) as unknown as typeof fetch;
    const enroller2 = new GinitHubEnroller({ paseoHome: home, logger: silentLogger, fetchImpl });
    await enroller2.enroll("https://hub.example.org", "ginit_tok");

    expect(enroller.getStatus()).toEqual({
      enrolled: true,
      deviceId: "dev-9",
      hubUrl: "wss://hub.example.org/ws/v1/paseo",
    });
  });

  test("enroll throws and does not persist on redeem failure", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "paseo-ginit-fail-"));
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = url.toString();
      if (href.endsWith("/api/paseo/enrollments")) {
        return jsonResponse({
          enrollment_id: "e",
          ticket: "pet_x",
          expires_at: "2099-01-01T00:00:00Z",
        });
      }
      return new Response("device_id already enrolled", { status: 400 });
    }) as unknown as typeof fetch;

    const enroller = new GinitHubEnroller({ paseoHome: home, logger: silentLogger, fetchImpl });
    await expect(enroller.enroll("https://hub.example.org", "ginit_tok")).rejects.toThrow(
      /redemption failed/i,
    );
    expect(loadPersistedConfig(home).daemon?.hub).toBeUndefined();
  });

  test("enroll surfaces enrollment auth failure", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "paseo-ginit-auth-"));
    const fetchImpl = vi.fn(
      async () => new Response("unauthorized", { status: 401, statusText: "Unauthorized" }),
    ) as unknown as typeof fetch;

    const enroller = new GinitHubEnroller({ paseoHome: home, logger: silentLogger, fetchImpl });
    await expect(enroller.enroll("https://hub.example.org", "bad")).rejects.toThrow(
      /enrollment request failed \(401/i,
    );
  });
});
