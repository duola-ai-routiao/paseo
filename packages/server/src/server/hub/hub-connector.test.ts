import { EventEmitter } from "node:events";
import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { WebSocket } from "ws";
import { HubConnector } from "./hub-connector.js";
import { loadOrCreateHubDeviceKeyPair } from "./device-keypair.js";

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  child() {
    return silentLogger;
  },
};

class FakeWebSocket extends EventEmitter {
  static OPEN = 1;
  readyState = FakeWebSocket.OPEN;
  readonly url: string;
  readonly options: { headers?: Record<string, string> };
  readonly sent: string[] = [];
  closed = false;

  constructor(url: string, options: { headers?: Record<string, string> }) {
    super();
    this.url = url;
    this.options = options;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  terminate(): void {
    this.closed = true;
  }
}

type FakeWebSocketImpl = typeof WebSocket & { instances: FakeWebSocket[] };

function createFakeWebSocketImpl(): FakeWebSocketImpl {
  const instances: FakeWebSocket[] = [];
  const impl = class extends FakeWebSocket {
    constructor(url: string, options: { headers?: Record<string, string> }) {
      super(url, options);
      instances.push(this);
    }
  };
  return Object.assign(impl, { OPEN: FakeWebSocket.OPEN, instances }) as FakeWebSocketImpl;
}

async function writeHubConfig(home: string): Promise<void> {
  await writeFile(
    path.join(home, "config.json"),
    JSON.stringify({
      daemon: {
        hub: {
          enabled: true,
          url: "wss://hub.example.com/ws/v1/paseo",
          deviceId: "dev-1",
          token: "pht_secret",
        },
      },
    }),
    { mode: 0o600 },
  );
}

function startConnector(home: string, webSocketImpl: FakeWebSocketImpl): HubConnector {
  const connector = new HubConnector({
    paseoHome: home,
    logger: silentLogger,
    webSocketImpl,
  });
  connector.start();
  return connector;
}

describe.skipIf(process.platform === "win32")("HubConnector", () => {
  test("stays idle when no hub config exists", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "paseo-hub-connector-"));
    const webSocketImpl = createFakeWebSocketImpl();
    const connector = startConnector(home, webSocketImpl);

    expect(webSocketImpl.instances).toHaveLength(0);
    expect(connector.isConnected()).toBe(false);
    connector.stop();
  });

  test("sends a signed hub.hello the ginit gateway can verify", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "paseo-hub-connector-"));
    await writeHubConfig(home);
    const webSocketImpl = createFakeWebSocketImpl();
    const connector = startConnector(home, webSocketImpl);

    expect(webSocketImpl.instances).toHaveLength(1);
    const socket = webSocketImpl.instances[0];
    expect(socket.url).toBe("wss://hub.example.com/ws/v1/paseo");
    expect(socket.options.headers?.authorization).toBe("Bearer pht_secret");

    socket.emit("open");
    expect(socket.sent).toHaveLength(1);
    const hello = JSON.parse(socket.sent[0]);
    expect(hello.type).toBe("hub.hello");
    expect(hello.protocolVersion).toBe(2);
    expect(hello.nonce).toBeTruthy();

    // Verify the signature exactly the way paseo_hub_gateway._verify_hello does.
    const keypair = loadOrCreateHubDeviceKeyPair(home);
    expect(hello.deviceId).toBe(keypair.deviceId);
    expect(hello.publicKey).toBe(keypair.publicKeyB64);
    expect(hello.daemonId).toBeTruthy();
    const canonical = Buffer.from(`2:${hello.deviceId}:${hello.daemonId}:${hello.nonce}`, "utf8");
    const publicKey = createPublicKey({
      key: Buffer.from(keypair.publicKeyB64, "base64"),
      format: "der",
      type: "spki",
    });
    expect(cryptoVerify(null, canonical, publicKey, Buffer.from(hello.signature, "base64"))).toBe(
      true,
    );
    connector.stop();
  });

  test("sends workspace snapshot and starts heartbeats after hub.welcome", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "paseo-hub-connector-"));
    await writeHubConfig(home);
    vi.useFakeTimers();
    try {
      const webSocketImpl = createFakeWebSocketImpl();
      const connector = new HubConnector({
        paseoHome: home,
        logger: silentLogger,
        webSocketImpl,
        workspaceSnapshotProvider: () => [
          { id: "a1", title: "fix bug", cwd: "/repo", provider: "claude", status: "running" },
        ],
      });
      connector.start();
      const socket = webSocketImpl.instances[0];
      socket.emit("open");
      socket.emit(
        "message",
        Buffer.from(
          JSON.stringify({
            type: "hub.welcome",
            protocolVersion: 2,
            connectionId: "conn-1",
            heartbeatIntervalMs: 1000,
          }),
        ),
      );

      const snapshot = JSON.parse(socket.sent[1]);
      expect(snapshot.type).toBe("hub.workspace.snapshot");
      expect(snapshot.workspaces).toEqual([
        { id: "a1", title: "fix bug", cwd: "/repo", provider: "claude", status: "running" },
      ]);

      await vi.advanceTimersByTimeAsync(1100);
      const heartbeat = JSON.parse(socket.sent[2]);
      expect(heartbeat.type).toBe("hub.heartbeat");
      connector.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  test("connect() opens the socket after a late enrollment without restart", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "paseo-hub-connector-"));
    const webSocketImpl = createFakeWebSocketImpl();
    const connector = startConnector(home, webSocketImpl);
    expect(webSocketImpl.instances).toHaveLength(0);

    await writeHubConfig(home);
    connector.connect();
    expect(webSocketImpl.instances).toHaveLength(1);
    connector.stop();
  });

  test("reconnects with backoff after the socket closes", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "paseo-hub-connector-"));
    await writeHubConfig(home);
    vi.useFakeTimers();
    try {
      const webSocketImpl = createFakeWebSocketImpl();
      const connector = new HubConnector({
        paseoHome: home,
        logger: silentLogger,
        webSocketImpl,
        reconnectBaseDelayMs: 1000,
        reconnectMaxDelayMs: 5000,
      });

      connector.start();
      expect(webSocketImpl.instances).toHaveLength(1);
      const first = webSocketImpl.instances[0];
      first.emit("open");
      first.emit("close", 1006, Buffer.from(""));

      await vi.advanceTimersByTimeAsync(2000);
      expect(webSocketImpl.instances.length).toBeGreaterThanOrEqual(2);

      connector.stop();
      const countAfterStop = webSocketImpl.instances.length;
      webSocketImpl.instances[countAfterStop - 1].emit("close", 1006, Buffer.from(""));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(webSocketImpl.instances).toHaveLength(countAfterStop);
    } finally {
      vi.useRealTimers();
    }
  });
});
