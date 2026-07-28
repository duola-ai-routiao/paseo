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
      ginitBaseUrl: "https://ginit.example.com",
      ginitToken: "ginit_token",
    });
  });

  test("enroll notifies onHubConfigPersisted after persisting", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "paseo-ginit-notify-"));
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
    const onHubConfigPersisted = vi.fn(() => {
      // The hub config must already be on disk when the callback fires.
      expect(loadPersistedConfig(home).daemon?.hub?.token).toBe("pht_9");
    });
    const enroller = new GinitHubEnroller({
      paseoHome: home,
      logger: silentLogger,
      fetchImpl,
      onHubConfigPersisted,
    });

    await enroller.enroll("https://hub.example.org", "ginit_tok");
    expect(onHubConfigPersisted).toHaveBeenCalledTimes(1);
  });

  test("enroll honors GINIT_PASEO_HUB_WS_PORT for split HTTP/WS gateways", async () => {
    process.env.GINIT_PASEO_HUB_WS_PORT = "8235";
    try {
      const home = await mkdtemp(path.join(tmpdir(), "paseo-ginit-wsport-"));
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

      const enroller = new GinitHubEnroller({ paseoHome: home, logger: silentLogger, fetchImpl });
      const result = await enroller.enroll("http://150.5.173.43:8090", "ginit_tok");
      expect(result.hubUrl).toBe("ws://150.5.173.43:8235/ws/v1/paseo");
      expect(loadPersistedConfig(home).daemon?.hub?.url).toBe("ws://150.5.173.43:8235/ws/v1/paseo");
    } finally {
      delete process.env.GINIT_PASEO_HUB_WS_PORT;
    }
  });

  test("PASEO_GINIT_HUB_WS_URL overrides both scheme-swap and the legacy port env", async () => {
    process.env.PASEO_GINIT_HUB_WS_URL = "wss://hub.example.com/ws/v1/paseo";
    process.env.GINIT_PASEO_HUB_WS_PORT = "8235";
    try {
      const home = await mkdtemp(path.join(tmpdir(), "paseo-ginit-wsurl-"));
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

      const enroller = new GinitHubEnroller({ paseoHome: home, logger: silentLogger, fetchImpl });
      const result = await enroller.enroll("http://150.5.173.43:8090", "ginit_tok");
      expect(result.hubUrl).toBe("wss://hub.example.com/ws/v1/paseo");
      expect(loadPersistedConfig(home).daemon?.hub?.url).toBe("wss://hub.example.com/ws/v1/paseo");
    } finally {
      delete process.env.PASEO_GINIT_HUB_WS_URL;
      delete process.env.GINIT_PASEO_HUB_WS_PORT;
    }
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
      return new Response("some other redeem error", { status: 400 });
    }) as unknown as typeof fetch;

    const enroller = new GinitHubEnroller({ paseoHome: home, logger: silentLogger, fetchImpl });
    await expect(enroller.enroll("https://hub.example.org", "ginit_tok")).rejects.toThrow(
      /redemption failed/i,
    );
    expect(loadPersistedConfig(home).daemon?.hub).toBeUndefined();
  });

  test("re-enroll on an already-enrolled device keeps credentials and refreshes account token", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "paseo-ginit-reenroll-"));
    let redeemCalls = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = url.toString();
      if (href.endsWith("/api/paseo/enrollments")) {
        return jsonResponse({
          enrollment_id: "e",
          ticket: "pet_x",
          expires_at: "2099-01-01T00:00:00Z",
        });
      }
      redeemCalls += 1;
      if (redeemCalls === 1) {
        return jsonResponse({ device_id: "dev-123", token: "pht_secret" });
      }
      return new Response('{"error":"device_id already enrolled"}', { status: 400 });
    }) as unknown as typeof fetch;

    const enroller = new GinitHubEnroller({ paseoHome: home, logger: silentLogger, fetchImpl });
    await enroller.enroll("https://hub.example.org", "ginit_tok_first");

    const result = await enroller.enroll("https://hub.example.org", "ginit_tok_second");
    expect(result.deviceId).toBe("dev-123");

    const hub = loadPersistedConfig(home).daemon?.hub;
    expect(hub?.deviceId).toBe("dev-123");
    expect(hub?.token).toBe("pht_secret");
    expect(hub?.ginitToken).toBe("ginit_tok_second");
    expect(hub?.ginitBaseUrl).toBe("https://hub.example.org");
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

  test("deviceStart posts to the ginit device endpoint and normalizes the response", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "paseo-ginit-devstart-"));
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: url.toString(), init });
      return jsonResponse({
        device_code: "dc_abc",
        verification_uri: "https://ginit.example.com/device?code=dc_abc",
        expires_in: 600,
      });
    }) as unknown as typeof fetch;

    const enroller = new GinitHubEnroller({ paseoHome: home, logger: silentLogger, fetchImpl });
    const result = await enroller.deviceStart("https://ginit.example.com/");

    expect(result).toEqual({
      deviceCode: "dc_abc",
      verificationUri: "https://ginit.example.com/device?code=dc_abc",
      expiresIn: 600,
    });
    expect(calls[0]?.url).toBe("https://ginit.example.com/auth/device/start");
    expect(calls[0]?.init?.method).toBe("POST");
  });

  test("deviceStart throws on non-OK response", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "paseo-ginit-devstart-fail-"));
    const fetchImpl = vi.fn(
      async () => new Response("boom", { status: 502, statusText: "Bad Gateway" }),
    ) as unknown as typeof fetch;

    const enroller = new GinitHubEnroller({ paseoHome: home, logger: silentLogger, fetchImpl });
    await expect(enroller.deviceStart("https://ginit.example.com")).rejects.toThrow(
      /device start failed \(502/i,
    );
  });

  test("devicePoll maps 202 to pending and completed payload to token", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "paseo-ginit-devpoll-"));
    const bodies: string[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(String(init?.body));
      if (bodies.length === 1) {
        return new Response("", { status: 202 });
      }
      return jsonResponse({ status: "completed", token: "ginit_tok" });
    }) as unknown as typeof fetch;

    const enroller = new GinitHubEnroller({ paseoHome: home, logger: silentLogger, fetchImpl });

    const pending = await enroller.devicePoll("https://ginit.example.com", "dc_abc");
    expect(pending).toEqual({ status: "pending", token: null });
    expect(JSON.parse(bodies[0] ?? "{}")).toEqual({ device_code: "dc_abc" });

    const completed = await enroller.devicePoll("https://ginit.example.com", "dc_abc");
    expect(completed).toEqual({ status: "completed", token: "ginit_tok" });
  });

  test("devicePoll throws when completed payload carries no token", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "paseo-ginit-devpoll-notok-"));
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ status: "completed" }),
    ) as unknown as typeof fetch;

    const enroller = new GinitHubEnroller({ paseoHome: home, logger: silentLogger, fetchImpl });
    await expect(enroller.devicePoll("https://ginit.example.com", "dc_abc")).rejects.toThrow(
      /without a token/i,
    );
  });

  test("listDevices rejects when the daemon is not enrolled", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "paseo-ginit-list-none-"));
    const enroller = new GinitHubEnroller({ paseoHome: home, logger: silentLogger });
    await expect(enroller.listDevices()).rejects.toThrow(/re-login/i);
  });

  test("listDevices calls the ginit devices API with the cached token and marks self", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "paseo-ginit-list-"));
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = url.toString();
      calls.push({ url: href, init });
      if (href.endsWith("/api/paseo/enrollments")) {
        return jsonResponse({
          enrollment_id: "e",
          ticket: "pet_x",
          expires_at: "2099-01-01T00:00:00Z",
        });
      }
      if (href.endsWith("/api/paseo/enrollments/redeem")) {
        return jsonResponse({ device_id: "dev-self", token: "pht_self" });
      }
      if (href.endsWith("/api/paseo/devices")) {
        return jsonResponse({
          items: [
            {
              device_id: "dev-self",
              daemon_id: "daemon-a",
              name: "paseo-self",
              status: "online",
              last_seen_at: "2026-07-26T00:00:00Z",
            },
            {
              device_id: "dev-other",
              daemon_id: "daemon-b",
              name: "paseo-other",
              status: "offline",
            },
          ],
        });
      }
      throw new Error(`unexpected url ${href}`);
    }) as unknown as typeof fetch;

    const enroller = new GinitHubEnroller({ paseoHome: home, logger: silentLogger, fetchImpl });
    await enroller.enroll("https://ginit.example.com/", "ginit_user_tok");

    const result = await enroller.listDevices();
    expect(result.devices).toEqual([
      {
        deviceId: "dev-self",
        daemonId: "daemon-a",
        name: "paseo-self",
        status: "online",
        lastSeenAt: "2026-07-26T00:00:00Z",
        isSelf: true,
      },
      {
        deviceId: "dev-other",
        daemonId: "daemon-b",
        name: "paseo-other",
        status: "offline",
        lastSeenAt: null,
        isSelf: false,
      },
    ]);

    const listCall = calls.find((c) => c.url.endsWith("/api/paseo/devices"));
    expect(listCall?.url).toBe("https://ginit.example.com/api/paseo/devices");
    expect((listCall?.init?.headers as Record<string, string> | undefined)?.authorization).toBe(
      "Bearer ginit_user_tok",
    );
  });

  test("listDevices surfaces API failure", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "paseo-ginit-list-fail-"));
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = url.toString();
      if (href.endsWith("/api/paseo/enrollments")) {
        return jsonResponse({
          enrollment_id: "e",
          ticket: "pet_x",
          expires_at: "2099-01-01T00:00:00Z",
        });
      }
      if (href.endsWith("/api/paseo/enrollments/redeem")) {
        return jsonResponse({ device_id: "dev-self", token: "pht_self" });
      }
      return new Response("unauthorized", { status: 401, statusText: "Unauthorized" });
    }) as unknown as typeof fetch;

    const enroller = new GinitHubEnroller({ paseoHome: home, logger: silentLogger, fetchImpl });
    await enroller.enroll("https://ginit.example.com/", "ginit_user_tok");
    await expect(enroller.listDevices()).rejects.toThrow(/device list failed \(401/i);
  });
});
