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

// On-disk format is the union of the two historical layouts so both parse:
//   - ours (ginit line):   { v, deviceId, publicKeyB64, secretKeyB64 }
//   - gair/main (paseo):   { v, publicKeyB64, privateKeyB64 }
// Missing fields are re-derived from the private key on load; the file is
// re-written in the full format on first load or regeneration.
const StoredHubKeyPairSchema = z.object({
  v: z.literal(1),
  deviceId: z.string().min(1).optional(),
  publicKeyB64: z.string().min(1),
  privateKeyB64: z.string().min(1).optional(),
  secretKeyB64: z.string().min(1).optional(),
});

const FILENAME = "hub-device-keypair.json";

export interface HubDeviceKeyPair {
  deviceId: string;
  /** SPKI DER, base64 — the format the hub verifies signatures with. */
  publicKeyB64: string;
  /** PKCS8 DER, base64. */
  privateKeyB64: string;
  /** COMPAT(ginit-hub-connector): base64 PKCS8 secret key for signHubHello; same value as privateKeyB64. */
  secretKeyB64: string;
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

function isValidPrivateKey(privateKeyB64: string): boolean {
  try {
    createPrivateKey({ key: Buffer.from(privateKeyB64, "base64"), format: "der", type: "pkcs8" });
    return true;
  } catch {
    return false;
  }
}

function buildBundle(privateKey: KeyObject): HubDeviceKeyPair {
  const publicKeyB64 = createPublicKey(privateKey)
    .export({ type: "spki", format: "der" })
    .toString("base64");
  const privateKeyB64 = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
  return {
    deviceId: deviceIdForPublicKey(publicKeyB64),
    publicKeyB64,
    privateKeyB64,
    secretKeyB64: privateKeyB64,
    privateKey,
    signCanonical: (value) => sign(null, Buffer.from(value), privateKey).toString("base64"),
  };
}

function persistKeypair(filePath: string, bundle: HubDeviceKeyPair): void {
  writePrivateFileAtomicSync(
    filePath,
    JSON.stringify(
      {
        v: 1,
        deviceId: bundle.deviceId,
        publicKeyB64: bundle.publicKeyB64,
        privateKeyB64: bundle.privateKeyB64,
        secretKeyB64: bundle.secretKeyB64,
      },
      null,
      2,
    ) + "\n",
  );
}

/**
 * Load or create a Hub device keypair (Ed25519, SPKI/PKCS8 DER base64).
 * The deviceId is derived from the public key hash (UUID format).
 * Persisted to $PASEO_HOME/hub-device-keypair.json
 */
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
      const privateKeyB64 = parsed.privateKeyB64 ?? parsed.secretKeyB64;
      if (!privateKeyB64 || !isValidPrivateKey(privateKeyB64)) {
        throw new Error("Stored Hub device keypair is not an Ed25519 PKCS8 keypair");
      }
      const bundle = buildBundle(
        createPrivateKey({
          key: Buffer.from(privateKeyB64, "base64"),
          format: "der",
          type: "pkcs8",
        }),
      );
      if (bundle.publicKeyB64 === parsed.publicKeyB64) {
        if (parsed.deviceId !== bundle.deviceId || !parsed.privateKeyB64 || !parsed.secretKeyB64) {
          persistKeypair(filePath, bundle);
        }
        log?.info({ filePath, deviceId: bundle.deviceId }, "Loaded Hub device keypair");
        return bundle;
      }
      throw new Error("Stored Hub device keypair public key does not match private key");
    } catch (error) {
      log?.warn({ err: error, filePath }, "Failed to load Hub device keypair, regenerating");
    }
  }
  const { privateKey } = generateKeyPairSync("ed25519");
  const bundle = buildBundle(privateKey);
  persistKeypair(filePath, bundle);
  log?.info({ filePath, deviceId: bundle.deviceId }, "Saved Hub device keypair");
  return bundle;
}

/**
 * Signs the ginit hub hello canonical payload
 * (`2:<deviceId>:<daemonId>:<nonce>`, UTF-8) with the device secret key.
 * Returns base64 — the encoding `paseo_hub_gateway._verify_hello` expects.
 */
export function signHubHello(secretKeyB64: string, payload: string): string {
  const signature = sign(null, Buffer.from(payload, "utf8"), {
    key: Buffer.from(secretKeyB64, "base64"),
    format: "der",
    type: "pkcs8",
  });
  return signature.toString("base64");
}
