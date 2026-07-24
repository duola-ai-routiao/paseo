import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type pino from "pino";
import { createHash } from "node:crypto";

import {
  generateKeyPair,
  exportPublicKey,
  exportSecretKey,
  importPublicKey,
  importSecretKey,
} from "@getpaseo/relay/e2ee";
import { ensurePrivateFile, writePrivateFileAtomicSync } from "../private-files.js";

const HubDeviceKeyPairSchema = z.object({
  v: z.literal(1),
  deviceId: z.string().min(1),
  publicKeyB64: z.string().min(1),
  secretKeyB64: z.string().min(1),
});

type StoredHubDeviceKeyPair = z.infer<typeof HubDeviceKeyPairSchema>;

const KEYPAIR_FILENAME = "hub-device-keypair.json";

export interface HubDeviceKeyPairBundle {
  deviceId: string;
  publicKeyB64: string;
  secretKeyB64: string;
}

/**
 * Load or create a Hub device keypair (Ed25519).
 * The deviceId is derived from the public key hash (UUID v4 format).
 * Persisted to $PASEO_HOME/hub-device-keypair.json
 */
export function loadOrCreateHubDeviceKeyPair(
  paseoHome: string,
  logger?: pino.Logger,
): HubDeviceKeyPairBundle {
  const log = logger?.child({ module: "hub-device-keypair" });
  const filePath = path.join(paseoHome, KEYPAIR_FILENAME);

  if (existsSync(filePath)) {
    try {
      ensurePrivateFile(filePath);
      const raw = readFileSync(filePath, "utf8");
      const parsed = HubDeviceKeyPairSchema.parse(JSON.parse(raw));

      // Validate the keypair can be imported
      importPublicKey(parsed.publicKeyB64);
      importSecretKey(parsed.secretKeyB64);

      log?.info({ filePath, deviceId: parsed.deviceId }, "Loaded Hub device keypair");
      return {
        deviceId: parsed.deviceId,
        publicKeyB64: parsed.publicKeyB64,
        secretKeyB64: parsed.secretKeyB64,
      };
    } catch (error) {
      log?.warn({ err: error, filePath }, "Failed to load Hub device keypair, regenerating");
    }
  }

  // Generate new Ed25519 keypair
  const keyPair = generateKeyPair();
  const publicKeyB64 = exportPublicKey(keyPair.publicKey);
  const secretKeyB64 = exportSecretKey(keyPair.secretKey);

  // Derive deviceId from public key (first 16 bytes of SHA-256 hash, as UUID)
  const publicKeyBytes = Buffer.from(publicKeyB64, "base64");
  const hash = createHash("sha256").update(publicKeyBytes).digest();
  const deviceId = [
    hash.subarray(0, 4).toString("hex"),
    hash.subarray(4, 6).toString("hex"),
    hash.subarray(6, 8).toString("hex"),
    hash.subarray(8, 10).toString("hex"),
    hash.subarray(10, 16).toString("hex"),
  ].join("-");

  const payload: StoredHubDeviceKeyPair = {
    v: 1,
    deviceId,
    publicKeyB64,
    secretKeyB64,
  };

  writePrivateFileAtomicSync(filePath, JSON.stringify(payload, null, 2) + "\n");
  log?.info({ filePath, deviceId }, "Saved Hub device keypair");

  return { deviceId, publicKeyB64, secretKeyB64 };
}
