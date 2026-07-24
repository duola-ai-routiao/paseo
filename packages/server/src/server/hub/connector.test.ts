import type { Logger } from "pino";
import { describe, expect, test, vi } from "vitest";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { ProviderSnapshotManager } from "../agent/provider-snapshot-manager.js";
import type { WorkspaceRegistry } from "../workspace-registry.js";
import type { WebSocket } from "ws";
import { PaseoHubConnector } from "./connector.js";

interface ConnectorPrivate {
  consumeRun(executionId: string, agentId: string, prompt: string): void;
  sendMessage(message: {
    type: "hub.execution.agent.send.request";
    requestId: string;
    executionId: string;
    paseoAgentId: string;
    messageId: string;
    text: string;
  }): Promise<void>;
  findExecutionRecord(executionId: string): Promise<{ id: string } | null>;
}

function asPrivate(connector: PaseoHubConnector): ConnectorPrivate {
  return connector as unknown as ConnectorPrivate;
}

function testLogger(): Logger {
  return {
    child: () => ({}),
    warn: () => undefined,
    info: () => undefined,
  } as unknown as Logger;
}

function testSocket(sent: unknown[]): WebSocket {
  return {
    readyState: 1,
    on: (event: string, callback: (...args: unknown[]) => void) => {
      if (event === "open") callback();
    },
    send: (value: string) => sent.push(JSON.parse(value)),
    close: () => undefined,
  } as unknown as WebSocket;
}

function createConnector(options?: {
  manager?: AgentManager;
  storage?: AgentStorage;
  sent?: unknown[];
  loadExecutionAgent?: (agentId: string) => Promise<void>;
}): PaseoHubConnector {
  const sent = options?.sent ?? [];
  const manager =
    options?.manager ??
    ({
      subscribe: () => () => undefined,
      getAgent: () => null,
      hasInFlightRun: () => false,
    } as unknown as AgentManager);
  const storage = options?.storage ?? ({} as AgentStorage);
  return new PaseoHubConnector({
    logger: testLogger(),
    config: { enabled: true, url: "wss://hub", deviceId: "device", token: "secret" },
    daemonId: "daemon",
    publicKey: "public",
    signCanonical: (value) => `signed:${value}`,
    workspaceRegistry: {} as WorkspaceRegistry,
    providerSnapshotManager: {} as ProviderSnapshotManager,
    agentManager: manager,
    agentStorage: storage,
    loadExecutionAgent: options?.loadExecutionAgent
      ? async (agentId) => options.loadExecutionAgent?.(agentId)
      : undefined,
    websocketFactory: () => testSocket(sent),
  });
}

describe("PaseoHubConnector", () => {
  test("signs the canonical handshake instead of hashing the bearer token", () => {
    const sent: unknown[] = [];
    const connector = createConnector({ sent });

    connector.start();

    expect(sent).toEqual([
      expect.objectContaining({
        type: "hub.hello",
        signature: expect.stringMatching(/^signed:2:device:daemon:/),
      }),
    ]);
  });

  test("resumes a collected execution agent before accepting a follow-up message", async () => {
    const sent: unknown[] = [];
    const agentId = "agent-1";
    const loadExecutionAgent = vi.fn().mockResolvedValue(undefined);
    const storage = {
      findByDaemonExecution: vi.fn().mockResolvedValue({ id: agentId, archivedAt: null }),
      list: vi.fn().mockResolvedValue([]),
    } as unknown as AgentStorage;
    const connector = createConnector({ sent, storage, loadExecutionAgent });
    connector.start();
    const connectorPrivate = asPrivate(connector);
    const consumeRun = vi.fn();
    connectorPrivate.consumeRun = consumeRun;

    await connectorPrivate.sendMessage({
      type: "hub.execution.agent.send.request",
      requestId: "request-1",
      executionId: "execution-1",
      paseoAgentId: agentId,
      messageId: "message-1",
      text: "follow up",
    });

    expect(sent.at(-1)).toEqual(
      expect.objectContaining({
        type: "hub.execution.agent.send.response",
        accepted: true,
        error: null,
      }),
    );
    expect(consumeRun).toHaveBeenCalledWith("execution-1", agentId, "follow up");
    expect(storage.findByDaemonExecution).toHaveBeenCalledWith({
      kind: "daemon",
      daemonId: "daemon",
      executionId: "execution-1",
    });
    expect(loadExecutionAgent).toHaveBeenCalledWith(agentId);
  });

  test("resumes a legacy Hub execution identified by its persisted labels", async () => {
    const agentId = "agent-legacy";
    const storage = {
      findByDaemonExecution: vi.fn().mockResolvedValue(null),
      list: vi.fn().mockResolvedValue([
        {
          id: agentId,
          archivedAt: null,
          labels: { "ginit.execution_id": "execution-legacy", "ginit.remote": "true" },
        },
      ]),
    } as unknown as AgentStorage;
    const connector = createConnector({ storage });

    await expect(asPrivate(connector).findExecutionRecord("execution-legacy")).resolves.toEqual({
      id: agentId,
      archivedAt: null,
      labels: { "ginit.execution_id": "execution-legacy", "ginit.remote": "true" },
    });
  });
});
