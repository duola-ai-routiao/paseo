import { existsSync, readFileSync } from "node:fs";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";
import path from "node:path";
import { z } from "zod";
import type pino from "pino";
import { ensurePrivateFile, writePrivateFileAtomicSync } from "../private-files.js";

const StoredHubKeyPairSchema = z.object({
  v: z.literal(1),
  publicKeyB64: z.string().min(1),
  privateKeyB64: z.string().min(1),
});

const FILENAME = "hub-device-keypair.json";

export interface HubDeviceKeyPair {
  deviceId: string;
  publicKeyB64: string;
  privateKey: KeyObject;
  signCanonical(value: string): string;
}

function deviceIdForPublicKey(publicKeyB64: string): string {
  const chars = createHash("sha256").update(publicKeyB64).digest("hex").slice(0, 32).split("");
  chars[12] = "5";
  chars[16] = "a";
  const hex = chars.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function loadOrCreateHubDeviceKeyPair(
  paseoHome: string,
  logger?: pino.Logger,
): HubDeviceKeyPair {
  const filePath = path.join(paseoHome, FILENAME);
  const log = logger?.child({ module: "hub-device-keypair" });
  if (existsSync(filePath)) {
    try {
      ensurePrivateFile(filePath);
      const parsed = StoredHubKeyPairSchema.parse(JSON.parse(readFileSync(filePath, "utf8")));
      const privateKey = createPrivateKey({
        key: Buffer.from(parsed.privateKeyB64, "base64"),
        format: "der",
        type: "pkcs8",
      });
      const publicKey = createPublicKey(privateKey);
      const publicKeyB64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");
      if (publicKeyB64 === parsed.publicKeyB64) {
        return {
          deviceId: deviceIdForPublicKey(publicKeyB64),
          publicKeyB64,
          privateKey,
          signCanonical: (value) => sign(null, Buffer.from(value), privateKey).toString("base64"),
        };
      }
    } catch (error) {
      log?.warn({ err: error, filePath }, "Failed to load Hub device keypair, regenerating");
    }
  }
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyB64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const privateKeyB64 = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
  writePrivateFileAtomicSync(
    filePath,
    JSON.stringify({ v: 1, publicKeyB64, privateKeyB64 }, null, 2) + "\n",
  );
  log?.info({ filePath }, "Saved Hub device keypair");
  return {
    deviceId: deviceIdForPublicKey(publicKeyB64),
    publicKeyB64,
    privateKey,
    signCanonical: (value) => sign(null, Buffer.from(value), privateKey).toString("base64"),
  };
}
