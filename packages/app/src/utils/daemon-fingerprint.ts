import nacl from "tweetnacl";

/**
 * Stable fingerprint of a daemon's Curve25519 public key (base64-encoded raw
 * 32 bytes). SHA-512 (NaCl hash) over the decoded raw key, truncated to 16
 * lowercase hex chars grouped in 4s — short enough to read aloud, long enough
 * to detect substitution. Never derive it from the base64 text: equivalent
 * encodings must not produce different fingerprints.
 *
 * Uses tweetnacl (already a relay dependency, pure JS) so it runs identically
 * on web, native, and in tests.
 */
export async function daemonPublicKeyFingerprint(daemonPublicKeyB64: string): Promise<string> {
  const raw = decodeBase64(daemonPublicKeyB64.trim());
  if (raw.length !== 32) {
    throw new Error(`Invalid daemon public key length (expected 32 bytes, got ${raw.length})`);
  }
  const hex = bytesToHex(nacl.hash(raw)).slice(0, 16);
  return [hex.slice(0, 4), hex.slice(4, 8), hex.slice(8, 12), hex.slice(12, 16)].join("-");
}

function decodeBase64(value: string): Uint8Array {
  if (typeof atob === "function") {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  return new Uint8Array(Buffer.from(value, "base64"));
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}
