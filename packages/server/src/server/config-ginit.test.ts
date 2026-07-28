import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { loadConfig } from "./config.js";

const roots: string[] = [];

async function createPaseoHome(config: unknown): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-config-ginit-"));
  roots.push(root);
  const paseoHome = path.join(root, ".paseo");
  await mkdir(paseoHome, { recursive: true });
  await writeFile(path.join(paseoHome, "config.json"), JSON.stringify(config, null, 2));
  return paseoHome;
}

describe("daemon ginit hub config", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test("returns nulls when no ginit hub is configured", async () => {
    const home = await createPaseoHome({ version: 1, daemon: {} });
    expect(loadConfig(home, { env: {} }).ginitHub).toEqual({ baseUrl: null, hubWsUrl: null });
  });

  test("reads persisted hub endpoints", async () => {
    const home = await createPaseoHome({
      version: 1,
      daemon: {
        hub: {
          ginitBaseUrl: "https://hub.example.com",
          url: "wss://hub.example.com/ws/v1/paseo",
        },
      },
    });
    expect(loadConfig(home, { env: {} }).ginitHub).toEqual({
      baseUrl: "https://hub.example.com",
      hubWsUrl: "wss://hub.example.com/ws/v1/paseo",
    });
  });

  test("env vars override persisted endpoints", async () => {
    const home = await createPaseoHome({
      version: 1,
      daemon: {
        hub: {
          ginitBaseUrl: "http://150.5.173.43:8090",
          url: "ws://150.5.173.43:8235/ws/v1/paseo",
        },
      },
    });
    const config = loadConfig(home, {
      env: {
        PASEO_GINIT_BASE_URL: "https://hub.example.com",
        PASEO_GINIT_HUB_WS_URL: "wss://hub.example.com/ws/v1/paseo",
      },
    });
    expect(config.ginitHub).toEqual({
      baseUrl: "https://hub.example.com",
      hubWsUrl: "wss://hub.example.com/ws/v1/paseo",
    });
  });
});
