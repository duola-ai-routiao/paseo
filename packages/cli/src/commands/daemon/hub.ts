import path from "node:path";
import { Command } from "commander";
import {
  getOrCreateServerId,
  loadOrCreateHubDeviceKeyPair,
  loadPersistedConfig,
  savePersistedConfig,
} from "@getpaseo/server";
import { resolveLocalPaseoHome } from "./local-daemon.js";

export function createHubCommand(): Command {
  const hub = new Command("hub").description("Manage Ginit Hub attachment");
  hub
    .command("identity")
    .option("--home <path>")
    .option("--json")
    .action((options: { home?: string; json?: boolean }) => {
      const home = resolveLocalPaseoHome(options.home);
      const key = loadOrCreateHubDeviceKeyPair(home);
      const identity = {
        device_id: key.deviceId,
        daemon_id: getOrCreateServerId(home),
        public_key: key.publicKeyB64,
      };
      console.log(
        options.json
          ? JSON.stringify(identity)
          : `device_id=${identity.device_id}\ndaemon_id=${identity.daemon_id}\npublic_key=${identity.public_key}`,
      );
    });
  hub
    .command("attach")
    .requiredOption("--url <url>")
    .requiredOption("--device-id <id>")
    .requiredOption("--token <token>")
    .option("--home <path>")
    .action((options: { url: string; deviceId: string; token: string; home?: string }) => {
      const home = resolveLocalPaseoHome(options.home);
      const key = loadOrCreateHubDeviceKeyPair(home);
      if (key.deviceId !== options.deviceId) throw new Error("device identity mismatch");
      const config = loadPersistedConfig(home);
      savePersistedConfig(home, {
        ...config,
        daemon: {
          ...config.daemon,
          hub: {
            enabled: true,
            url: options.url,
            deviceId: options.deviceId,
            token: options.token,
          },
        },
      });
      console.log(`Hub attachment saved to ${path.join(home, "config.json")}`);
    });
  hub
    .command("status")
    .option("--home <path>")
    .option("--json")
    .action((options: { home?: string; json?: boolean }) => {
      const home = resolveLocalPaseoHome(options.home);
      const value = loadPersistedConfig(home).daemon?.hub;
      const status = {
        enabled: value?.enabled === true,
        url: value?.url ?? null,
        device_id: value?.deviceId ?? null,
      };
      console.log(
        options.json
          ? JSON.stringify(status)
          : `enabled=${status.enabled}\nurl=${status.url ?? "-"}\ndevice_id=${status.device_id ?? "-"}`,
      );
    });
  hub
    .command("detach")
    .option("--home <path>")
    .action((options: { home?: string }) => {
      const home = resolveLocalPaseoHome(options.home);
      const config = loadPersistedConfig(home);
      savePersistedConfig(home, { ...config, daemon: { ...config.daemon, hub: undefined } });
      console.log("Hub attachment removed");
    });
  return hub;
}
