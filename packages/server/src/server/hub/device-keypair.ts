import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type pino from "pino";
import { createHash, generateKeyPairSync, sign as cryptoSign } from "node:crypto";

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
  /** SPKI DER, base64 — the format the ginit hub verifies signatures with. */
  publicKeyB64: string;
  /** PKCS8 DER, base64. */
  secretKeyB64: string;
}

function isValidStoredKeyPair(parsed: StoredHubDeviceKeyPair): boolean {
  try {
    const publicKeyBytes = Buffer.from(parsed.publicKeyB64, "base64");
    const secretKeyBytes = Buffer.from(parsed.secretKeyB64, "base64");
    // Ed25519 SPKI DER is 44 bytes; PKCS8 DER is 48 bytes. Anything else is a
    // legacy raw-keypair file (e.g. X25519) and must be regenerated.
    if (publicKeyBytes.byteLength !== 44 || secretKeyBytes.byteLength !== 48) return false;
    cryptoSign(null, Buffer.from("probe"), { key: secretKeyBytes, format: "der", type: "pkcs8" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Load or create a Hub device keypair (Ed25519, SPKI/PKCS8 DER base64).
 * The deviceId is derived from the public key hash (UUID format).
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
      if (!isValidStoredKeyPair(parsed)) {
        throw new Error("Stored Hub device keypair is not an Ed25519 DER keypair");
      }

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

  // Generate a new Ed25519 keypair in the DER encodings the ginit hub expects.
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyB64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const secretKeyB64 = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");

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

/**
 * Signs the ginit hub hello canonical payload
 * (`2:<deviceId>:<daemonId>:<nonce>`, UTF-8) with the device secret key.
 * Returns base64 — the encoding `paseo_hub_gateway._verify_hello` expects.
 */
export function signHubHello(secretKeyB64: string, payload: string): string {
  const signature = cryptoSign(null, Buffer.from(payload, "utf8"), {
    key: Buffer.from(secretKeyB64, "base64"),
    format: "der",
    type: "pkcs8",
  });
  return signature.toString("base64");
}
