import { describe, expect, test } from "vitest";
import { daemonPublicKeyFingerprint } from "./daemon-fingerprint";

const KEY_A = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc="; // 0x07 × 32
const KEY_B = "CAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg="; // 0x08 × 32

describe("daemonPublicKeyFingerprint", () => {
  test("is stable for the same key", async () => {
    const first = await daemonPublicKeyFingerprint(KEY_A);
    const second = await daemonPublicKeyFingerprint(KEY_A);
    expect(first).toBe(second);
  });

  test("differs across keys and uses grouped 16-hex format", async () => {
    const a = await daemonPublicKeyFingerprint(KEY_A);
    const b = await daemonPublicKeyFingerprint(KEY_B);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/);
  });

  test("rejects keys that are not 32 raw bytes", async () => {
    await expect(daemonPublicKeyFingerprint("c2hvcnQ=")).rejects.toThrow(/32 bytes/);
  });
});
