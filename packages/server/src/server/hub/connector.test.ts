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
  adoptExecution(message: {
    type: "hub.execution.agent.adopt.request";
    requestId: string;
    executionId: string;
    workspaceId: string;
    provider: string;
    cwd: string;
    paseoAgentId: string;
    prompt?: string;
  }): Promise<void>;
  releaseExecution(message: {
    type: "hub.execution.agent.release.request";
    requestId: string;
    executionId: string;
    paseoAgentId: string;
  }): Promise<void>;
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
  relayMetadata?: { endpoint: string; useTls: boolean; publicKey: string };
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
    relayMetadataProvider: options?.relayMetadata ? () => options.relayMetadata ?? null : undefined,
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

  test("includes signed relay metadata in the handshake", () => {
    const sent: unknown[] = [];
    const connector = createConnector({
      sent,
      relayMetadata: {
        endpoint: "relay.example.com:443",
        useTls: true,
        publicKey: "relay-public-key",
      },
    });

    connector.start();

    expect(sent).toEqual([
      expect.objectContaining({
        type: "hub.hello",
        relay: {
          endpoint: "relay.example.com:443",
          use_tls: true,
          public_key: "relay-public-key",
          signature: 'signed:["relay-v1","relay.example.com:443",true,"relay-public-key"]',
        },
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

  test("claims an eligible existing agent before forwarding its first Hub turn", async () => {
    const sent: unknown[] = [];
    const agentId = "agent-existing";
    const manager = {
      subscribe: () => () => undefined,
      getAgent: () => null,
      hasInFlightRun: () => false,
      claimDaemonExecution: vi.fn().mockResolvedValue(undefined),
    };
    const storage = {
      findByDaemonExecution: vi.fn().mockResolvedValue(null),
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue({
        id: agentId,
        archivedAt: null,
        owner: undefined,
        labels: {},
        workspaceId: "workspace-1",
        cwd: "/repo",
        provider: "cursor-server",
      }),
    } as unknown as AgentStorage;
    const workspaceRegistry = {
      get: vi
        .fn()
        .mockResolvedValue({ workspaceId: "workspace-1", cwd: "/repo", archivedAt: null }),
    } as unknown as WorkspaceRegistry;
    const connector = new PaseoHubConnector({
      logger: testLogger(),
      config: { enabled: true, url: "wss://hub", deviceId: "device", token: "secret" },
      daemonId: "daemon",
      publicKey: "public",
      signCanonical: (value) => `signed:${value}`,
      workspaceRegistry,
      providerSnapshotManager: {} as ProviderSnapshotManager,
      agentManager: manager as unknown as AgentManager,
      agentStorage: storage,
      loadExecutionAgent: vi.fn().mockResolvedValue(undefined),
      websocketFactory: () => testSocket(sent),
    });
    connector.start();
    const connectorPrivate = asPrivate(connector);
    const consumeRun = vi.fn();
    connectorPrivate.consumeRun = consumeRun;

    await connectorPrivate.adoptExecution({
      type: "hub.execution.agent.adopt.request",
      requestId: "adopt-1",
      executionId: "execution-1",
      workspaceId: "workspace-1",
      provider: "cursor-server",
      cwd: "/repo",
      paseoAgentId: agentId,
      prompt: "continue",
    });

    expect(manager.claimDaemonExecution).toHaveBeenCalledWith(agentId, {
      kind: "daemon",
      daemonId: "daemon",
      executionId: "execution-1",
    });
    expect(consumeRun).toHaveBeenCalledWith("execution-1", agentId, "continue");
    expect(sent.at(-1)).toEqual(
      expect.objectContaining({
        type: "hub.execution.agent.adopt.response",
        accepted: true,
        paseoAgentId: agentId,
      }),
    );
  });

  test("rejects adoption when the agent is outside the requested target", async () => {
    const sent: unknown[] = [];
    const claimDaemonExecution = vi.fn().mockResolvedValue(undefined);
    const manager = {
      subscribe: () => () => undefined,
      getAgent: () => null,
      hasInFlightRun: () => false,
      claimDaemonExecution,
    };
    const storage = {
      findByDaemonExecution: vi.fn().mockResolvedValue(null),
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue({
        id: "agent-existing",
        archivedAt: null,
        owner: undefined,
        labels: {},
        workspaceId: "workspace-1",
        cwd: "/repo",
        provider: "codex",
      }),
    } as unknown as AgentStorage;
    const workspaceRegistry = {
      get: vi
        .fn()
        .mockResolvedValue({ workspaceId: "workspace-1", cwd: "/repo", archivedAt: null }),
    } as unknown as WorkspaceRegistry;
    const connector = new PaseoHubConnector({
      logger: testLogger(),
      config: { enabled: true, url: "wss://hub", deviceId: "device", token: "secret" },
      daemonId: "daemon",
      publicKey: "public",
      signCanonical: (value) => `signed:${value}`,
      workspaceRegistry,
      providerSnapshotManager: {} as ProviderSnapshotManager,
      agentManager: manager as unknown as AgentManager,
      agentStorage: storage,
      loadExecutionAgent: vi.fn().mockResolvedValue(undefined),
      websocketFactory: () => testSocket(sent),
    });
    connector.start();

    await asPrivate(connector).adoptExecution({
      type: "hub.execution.agent.adopt.request",
      requestId: "adopt-2",
      executionId: "execution-2",
      workspaceId: "workspace-1",
      provider: "cursor-server",
      cwd: "/repo",
      paseoAgentId: "agent-existing",
    });

    expect(claimDaemonExecution).not.toHaveBeenCalled();
    expect(sent.at(-1)).toEqual(
      expect.objectContaining({
        type: "hub.execution.agent.adopt.response",
        accepted: false,
        error: "agent does not belong to the requested execution target",
      }),
    );
  });

  test("rejects an agent that is already claimed by another Hub execution", async () => {
    const sent: unknown[] = [];
    const claimDaemonExecution = vi.fn().mockResolvedValue(undefined);
    const manager = {
      subscribe: () => () => undefined,
      getAgent: () => null,
      hasInFlightRun: () => false,
      claimDaemonExecution,
    };
    const storage = {
      findByDaemonExecution: vi.fn().mockResolvedValue(null),
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue({
        id: "agent-existing",
        archivedAt: null,
        owner: { kind: "daemon", daemonId: "daemon", executionId: "other" },
        labels: { "ginit.execution_id": "other" },
        workspaceId: "workspace-1",
        cwd: "/repo",
        provider: "cursor-server",
      }),
    } as unknown as AgentStorage;
    const workspaceRegistry = {
      get: vi
        .fn()
        .mockResolvedValue({ workspaceId: "workspace-1", cwd: "/repo", archivedAt: null }),
    } as unknown as WorkspaceRegistry;
    const connector = new PaseoHubConnector({
      logger: testLogger(),
      config: { enabled: true, url: "wss://hub", deviceId: "device", token: "secret" },
      daemonId: "daemon",
      publicKey: "public",
      signCanonical: (value) => `signed:${value}`,
      workspaceRegistry,
      providerSnapshotManager: {} as ProviderSnapshotManager,
      agentManager: manager as unknown as AgentManager,
      agentStorage: storage,
      loadExecutionAgent: vi.fn().mockResolvedValue(undefined),
      websocketFactory: () => testSocket(sent),
    });
    connector.start();

    await asPrivate(connector).adoptExecution({
      type: "hub.execution.agent.adopt.request",
      requestId: "adopt-3",
      executionId: "execution-3",
      workspaceId: "workspace-1",
      provider: "cursor-server",
      cwd: "/repo",
      paseoAgentId: "agent-existing",
    });

    expect(claimDaemonExecution).not.toHaveBeenCalled();
    expect(sent.at(-1)).toEqual(
      expect.objectContaining({
        type: "hub.execution.agent.adopt.response",
        accepted: false,
        error: "agent is already managed by a Hub execution",
      }),
    );
  });

  test("releases an idle adopted agent so it can be reassigned", async () => {
    const sent: unknown[] = [];
    const releaseDaemonExecution = vi.fn().mockResolvedValue(undefined);
    const manager = {
      subscribe: () => () => undefined,
      getAgent: () => null,
      hasInFlightRun: () => false,
      releaseDaemonExecution,
    };
    const storage = {
      findByDaemonExecution: vi.fn().mockResolvedValue({ id: "agent-existing", archivedAt: null }),
      list: vi.fn().mockResolvedValue([]),
    } as unknown as AgentStorage;
    const loadExecutionAgent = vi.fn().mockResolvedValue(undefined);
    const connector = createConnector({
      sent,
      manager: manager as unknown as AgentManager,
      storage,
      loadExecutionAgent,
    });
    connector.start();

    await asPrivate(connector).releaseExecution({
      type: "hub.execution.agent.release.request",
      requestId: "release-1",
      executionId: "execution-1",
      paseoAgentId: "agent-existing",
    });

    expect(releaseDaemonExecution).toHaveBeenCalledWith("agent-existing", {
      kind: "daemon",
      daemonId: "daemon",
      executionId: "execution-1",
    });
    expect(sent.at(-1)).toEqual(
      expect.objectContaining({
        type: "hub.execution.agent.release.response",
        accepted: true,
        error: null,
      }),
    );
  });
});
