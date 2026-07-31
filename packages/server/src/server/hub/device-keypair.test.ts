import { statSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPublicKey, verify } from "node:crypto";
import { describe, expect, test } from "vitest";
import { loadOrCreateHubDeviceKeyPair } from "./device-keypair.js";

describe.skipIf(process.platform === "win32")("Hub device keypair", () => {
  test("persists an Ed25519 key in a private file", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "paseo-hub-key-"));
    const first = loadOrCreateHubDeviceKeyPair(home);
    const second = loadOrCreateHubDeviceKeyPair(home);
    expect(second.deviceId).toBe(first.deviceId);
    expect(statSync(path.join(home, "hub-device-keypair.json")).mode & 0o777).toBe(0o600);
    const canonical = `2:${first.deviceId}:daemon:nonce`;
    const publicKey = createPublicKey({
      key: Buffer.from(first.publicKeyB64, "base64"),
      format: "der",
      type: "spki",
    });
    expect(
      verify(
        null,
        Buffer.from(canonical),
        publicKey,
        Buffer.from(first.signCanonical(canonical), "base64"),
      ),
    ).toBe(true);
  });
});
