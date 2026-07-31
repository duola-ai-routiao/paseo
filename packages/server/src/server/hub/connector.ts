import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import type { Logger } from "pino";
import {
  PaseoHubInboundMessageSchema,
  PaseoHubProtocolVersion,
  type PaseoHubInboundMessage,
  type PaseoHubOutboundMessage,
} from "@getpaseo/protocol/hub";
import type { AgentManager, AgentManagerEvent } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import { ensureUnarchivedAgentLoaded } from "../agent/agent-loading.js";
import { type DaemonAgentOwner } from "../agent/agent-owner.js";
import type { ProviderSnapshotManager } from "../agent/provider-snapshot-manager.js";
import type { WorkspaceRegistry } from "../workspace-registry.js";

const DEFAULT_HEARTBEAT_MS = 20_000;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

interface HubConnectorConfig {
  enabled: boolean;
  url: string;
  deviceId: string;
  token: string;
}

export interface HubConnectorStatus {
  enabled: boolean;
  connected: boolean;
  url: string | null;
  deviceId: string | null;
  lastError: string | null;
}

type ExecutionAgentLoader = (
  agentId: string,
  deps: {
    agentManager: AgentManager;
    agentStorage: AgentStorage;
    logger: Logger;
  },
) => Promise<void>;

interface HubConnectorOptions {
  logger: Logger;
  config: HubConnectorConfig;
  daemonId: string;
  publicKey: string;
  signCanonical: (value: string) => string;
  workspaceRegistry: WorkspaceRegistry;
  providerSnapshotManager: ProviderSnapshotManager;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  loadExecutionAgent?: ExecutionAgentLoader;
  websocketFactory?: (url: string, token: string) => WebSocket;
}

function defaultWebsocketFactory(url: string, token: string): WebSocket {
  return new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
}

function executionIdFromLabels(labels: Record<string, string>): string | null {
  return labels["ginit.execution_id"] ?? null;
}

export class PaseoHubConnector {
  private readonly logger: Logger;
  private readonly options: HubConnectorOptions;
  private readonly websocketFactory: (url: string, token: string) => WebSocket;
  private readonly loadExecutionAgent: ExecutionAgentLoader;
  private socket: WebSocket | null = null;
  private stopped = true;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectDelayMs = RECONNECT_MIN_MS;
  private readonly requestResponses = new Map<string, PaseoHubOutboundMessage>();
  private readonly executionAgents = new Map<string, string>();
  private readonly adoptingAgents = new Map<string, string>();
  private readonly eventSeq = new Map<string, number>();
  private unsubscribeAgents: (() => void) | null = null;
  private lastError: string | null = null;

  constructor(options: HubConnectorOptions) {
    this.options = options;
    this.logger = options.logger.child({ module: "ginit-hub" });
    this.websocketFactory = options.websocketFactory ?? defaultWebsocketFactory;
    this.loadExecutionAgent =
      options.loadExecutionAgent ??
      (async (agentId, deps) => {
        await ensureUnarchivedAgentLoaded(agentId, deps);
      });
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.unsubscribeAgents = this.options.agentManager.subscribe(
      (event) => this.forwardAgentEvent(event),
      { replayState: false },
    );
    this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearTimers();
    this.unsubscribeAgents?.();
    this.unsubscribeAgents = null;
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState < WebSocket.CLOSING) {
      socket.close(1000, "daemon stopping");
    }
  }

  status(): HubConnectorStatus {
    return {
      enabled: this.options.config.enabled,
      connected: this.socket?.readyState === WebSocket.OPEN,
      url: this.options.config.url || null,
      deviceId: this.options.config.deviceId || null,
      lastError: this.lastError,
    };
  }

  private connect(): void {
    if (this.stopped || this.socket) return;
    const socket = this.websocketFactory(this.options.config.url, this.options.config.token);
    this.socket = socket;

    socket.on("open", () => {
      this.reconnectDelayMs = RECONNECT_MIN_MS;
      const nonce = randomUUID();
      this.send({
        type: "hub.hello",
        protocolVersion: PaseoHubProtocolVersion,
        deviceId: this.options.config.deviceId,
        daemonId: this.options.daemonId,
        publicKey: this.options.publicKey,
        nonce,
        signature: this.options.signCanonical(
          `${PaseoHubProtocolVersion}:${this.options.config.deviceId}:${this.options.daemonId}:${nonce}`,
        ),
      });
    });
    socket.on("message", (data) => this.handleMessage(data.toString()));
    socket.on("error", (error) => {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.logger.warn({ err: error }, "Hub socket error");
    });
    socket.on("close", () => {
      if (this.socket === socket) this.socket = null;
      this.clearHeartbeat();
      this.scheduleReconnect();
    });
  }

  private handleMessage(raw: string): void {
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      this.logger.warn("Ignored malformed Hub JSON frame");
      return;
    }
    const parsed = PaseoHubInboundMessageSchema.safeParse(decoded);
    if (!parsed.success) {
      this.logger.warn({ issues: parsed.error.issues }, "Ignored invalid Hub frame");
      return;
    }
    void this.dispatch(parsed.data);
  }

  private async dispatch(message: PaseoHubInboundMessage): Promise<void> {
    switch (message.type) {
      case "hub.welcome":
        if (message.protocolVersion !== PaseoHubProtocolVersion) {
          this.socket?.close(4406, "unsupported protocol version");
          return;
        }
        this.startHeartbeat(message.heartbeatIntervalMs);
        await this.sendWorkspaceSnapshot();
        return;
      case "hub.heartbeat":
        this.send({ type: "hub.heartbeat", sentAt: new Date().toISOString() });
        return;
      case "hub.execution.agent.create.request":
        await this.createExecution(message);
        return;
      case "hub.execution.agent.adopt.request":
        await this.adoptExecution(message);
        return;
      case "hub.execution.agent.release.request":
        await this.releaseExecution(message);
        return;
      case "hub.execution.agent.send.request":
        await this.sendMessage(message);
        return;
      case "hub.execution.agent.cancel.request":
        await this.cancelExecution(message);
        return;
      case "hub.execution.agent.approval.respond.request":
        await this.respondToApproval(message);
        return;
      case "hub.execution.agent.stream.ack":
        return;
      case "hub.execution.agent.snapshot.request": {
        const agent = this.options.agentManager.getAgent(message.paseoAgentId);
        this.send({
          type: "hub.execution.agent.snapshot.response",
          requestId: message.requestId,
          executionId: message.executionId,
          snapshot: agent,
          lastSeq: this.eventSeq.get(message.executionId) ?? 0,
          error: agent ? null : "agent not found",
        });
      }
    }
  }

  private async sendMessage(
    message: Extract<PaseoHubInboundMessage, { type: "hub.execution.agent.send.request" }>,
  ): Promise<void> {
    let error: string | null = null;
    try {
      const agentId = await this.resolveExecutionAgent(message.executionId);
      if (agentId !== message.paseoAgentId) {
        error = "execution is bound to a different agent";
      } else if (this.options.agentManager.hasInFlightRun(agentId)) {
        error = "agent is already running";
      }
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "agent session unavailable";
    }
    const accepted = error === null;
    const response: PaseoHubOutboundMessage = {
      type: "hub.execution.agent.send.response",
      requestId: message.requestId,
      executionId: message.executionId,
      accepted,
      error,
    };
    this.send(response);
    if (accepted) this.consumeRun(message.executionId, message.paseoAgentId, message.text);
  }

  private async cancelExecution(
    message: Extract<PaseoHubInboundMessage, { type: "hub.execution.agent.cancel.request" }>,
  ): Promise<void> {
    try {
      const result = await this.options.agentManager.cancelAgentRun(message.paseoAgentId);
      const accepted = result.status === "settled";
      this.send({
        type: "hub.execution.agent.cancel.response",
        requestId: message.requestId,
        executionId: message.executionId,
        accepted,
        error: null,
      });
    } catch (error) {
      this.send({
        type: "hub.execution.agent.cancel.response",
        requestId: message.requestId,
        executionId: message.executionId,
        accepted: false,
        error: error instanceof Error ? error.message : "cancel failed",
      });
    }
  }

  private async respondToApproval(
    message: Extract<
      PaseoHubInboundMessage,
      { type: "hub.execution.agent.approval.respond.request" }
    >,
  ): Promise<void> {
    try {
      await this.options.agentManager.respondToPermission(
        message.paseoAgentId,
        message.approvalId,
        {
          behavior: message.decision,
        },
      );
      this.send({
        type: "hub.execution.agent.approval.respond.response",
        requestId: message.requestId,
        executionId: message.executionId,
        accepted: true,
        error: null,
      });
    } catch (error) {
      this.send({
        type: "hub.execution.agent.approval.respond.response",
        requestId: message.requestId,
        executionId: message.executionId,
        accepted: false,
        error: error instanceof Error ? error.message : "approval failed",
      });
    }
  }

  private async createExecution(
    message: Extract<PaseoHubInboundMessage, { type: "hub.execution.agent.create.request" }>,
  ): Promise<void> {
    const cached = this.requestResponses.get(message.requestId);
    if (cached) {
      this.send(cached);
      return;
    }
    try {
      const workspace = await this.options.workspaceRegistry.get(message.workspaceId);
      if (!workspace || workspace.archivedAt) throw new Error("workspace not found");
      if (workspace.cwd !== message.cwd) throw new Error("workspace path mismatch");
      const agent = await this.options.agentManager.createAgent(
        { provider: message.provider, cwd: message.cwd },
        undefined,
        {
          workspaceId: message.workspaceId,
          owner: this.executionOwner(message.executionId),
          labels: {
            ...message.labels,
            "ginit.execution_id": message.executionId,
            "ginit.remote": "true",
          },
        },
      );
      this.executionAgents.set(message.executionId, agent.id);
      const response: PaseoHubOutboundMessage = {
        type: "hub.execution.agent.create.response",
        requestId: message.requestId,
        executionId: message.executionId,
        accepted: true,
        paseoAgentId: agent.id,
        error: null,
      };
      this.requestResponses.set(message.requestId, response);
      this.send(response);
      this.consumeRun(message.executionId, agent.id, message.prompt);
    } catch (error) {
      const response: PaseoHubOutboundMessage = {
        type: "hub.execution.agent.create.response",
        requestId: message.requestId,
        executionId: message.executionId,
        accepted: false,
        paseoAgentId: null,
        error: error instanceof Error ? error.message : "create failed",
      };
      this.requestResponses.set(message.requestId, response);
      this.send(response);
    }
  }

  private async adoptExecution(
    message: Extract<PaseoHubInboundMessage, { type: "hub.execution.agent.adopt.request" }>,
  ): Promise<void> {
    const cached = this.requestResponses.get(message.requestId);
    if (cached) {
      this.send(cached);
      return;
    }

    let response: PaseoHubOutboundMessage;
    try {
      const existing = await this.findExecutionRecord(message.executionId);
      if (existing) {
        if (existing.id !== message.paseoAgentId) {
          throw new Error("execution is already bound to a different agent");
        }
        this.executionAgents.set(message.executionId, existing.id);
        response = this.adoptResponse(message, true, existing.id, null);
      } else {
        const agentId = await this.claimExistingAgent(message);
        this.executionAgents.set(message.executionId, agentId);
        response = this.adoptResponse(message, true, agentId, null);
        if (message.prompt?.trim()) {
          this.consumeRun(message.executionId, agentId, message.prompt);
        }
      }
    } catch (error) {
      response = this.adoptResponse(
        message,
        false,
        null,
        error instanceof Error ? error.message : "adopt failed",
      );
    }
    this.requestResponses.set(message.requestId, response);
    this.send(response);
  }

  private adoptResponse(
    message: Extract<PaseoHubInboundMessage, { type: "hub.execution.agent.adopt.request" }>,
    accepted: boolean,
    paseoAgentId: string | null,
    error: string | null,
  ): PaseoHubOutboundMessage {
    return {
      type: "hub.execution.agent.adopt.response",
      requestId: message.requestId,
      executionId: message.executionId,
      accepted,
      paseoAgentId,
      error,
    };
  }

  private async releaseExecution(
    message: Extract<PaseoHubInboundMessage, { type: "hub.execution.agent.release.request" }>,
  ): Promise<void> {
    const cached = this.requestResponses.get(message.requestId);
    if (cached) {
      this.send(cached);
      return;
    }
    let response: PaseoHubOutboundMessage;
    try {
      const agentId = await this.resolveExecutionAgent(message.executionId);
      if (agentId !== message.paseoAgentId) {
        throw new Error("execution is bound to a different agent");
      }
      await this.options.agentManager.releaseDaemonExecution(
        agentId,
        this.executionOwner(message.executionId),
      );
      this.executionAgents.delete(message.executionId);
      response = {
        type: "hub.execution.agent.release.response",
        requestId: message.requestId,
        executionId: message.executionId,
        accepted: true,
        error: null,
      };
    } catch (error) {
      response = {
        type: "hub.execution.agent.release.response",
        requestId: message.requestId,
        executionId: message.executionId,
        accepted: false,
        error: error instanceof Error ? error.message : "release failed",
      };
    }
    this.requestResponses.set(message.requestId, response);
    this.send(response);
  }

  private async claimExistingAgent(
    message: Extract<PaseoHubInboundMessage, { type: "hub.execution.agent.adopt.request" }>,
  ): Promise<string> {
    const claimant = this.adoptingAgents.get(message.paseoAgentId);
    if (claimant && claimant !== message.executionId) {
      throw new Error("agent is already being adopted by another execution");
    }
    this.adoptingAgents.set(message.paseoAgentId, message.executionId);
    try {
      const workspace = await this.options.workspaceRegistry.get(message.workspaceId);
      if (!workspace || workspace.archivedAt || workspace.cwd !== message.cwd) {
        throw new Error("workspace not found or path mismatch");
      }
      const record = await this.options.agentStorage.get(message.paseoAgentId);
      if (!record || record.archivedAt) throw new Error("agent not found");
      if (
        record.workspaceId !== message.workspaceId ||
        record.cwd !== message.cwd ||
        record.provider !== message.provider
      ) {
        throw new Error("agent does not belong to the requested execution target");
      }
      if (record.owner || record.labels["ginit.execution_id"]) {
        throw new Error("agent is already managed by a Hub execution");
      }
      await this.loadExecutionAgent(record.id, {
        agentManager: this.options.agentManager,
        agentStorage: this.options.agentStorage,
        logger: this.logger,
      });
      if (this.options.agentManager.hasInFlightRun(record.id)) {
        throw new Error("agent is already running");
      }
      await this.options.agentManager.claimDaemonExecution(
        record.id,
        this.executionOwner(message.executionId),
      );
      return record.id;
    } finally {
      if (this.adoptingAgents.get(message.paseoAgentId) === message.executionId) {
        this.adoptingAgents.delete(message.paseoAgentId);
      }
    }
  }

  private consumeRun(executionId: string, agentId: string, prompt: string): void {
    void (async () => {
      try {
        for await (const _event of this.options.agentManager.streamAgent(agentId, prompt)) {
          // AgentManager subscriptions are the single outbound event path.
        }
      } catch (error) {
        this.logger.warn({ err: error, executionId, agentId }, "Hub execution failed");
      }
    })();
  }

  private executionOwner(executionId: string): DaemonAgentOwner {
    return { kind: "daemon", daemonId: this.options.daemonId, executionId };
  }

  private async resolveExecutionAgent(executionId: string): Promise<string> {
    const rememberedAgentID = this.executionAgents.get(executionId);
    if (rememberedAgentID) {
      await this.loadExecutionAgent(rememberedAgentID, {
        agentManager: this.options.agentManager,
        agentStorage: this.options.agentStorage,
        logger: this.logger,
      });
      return rememberedAgentID;
    }

    const record = await this.findExecutionRecord(executionId);
    if (!record || record.archivedAt) {
      throw new Error("agent session not found");
    }
    await this.loadExecutionAgent(record.id, {
      agentManager: this.options.agentManager,
      agentStorage: this.options.agentStorage,
      logger: this.logger,
    });
    this.executionAgents.set(executionId, record.id);
    return record.id;
  }

  private async findExecutionRecord(executionId: string) {
    const owned = await this.options.agentStorage.findByDaemonExecution(
      this.executionOwner(executionId),
    );
    if (owned) return owned;
    // COMPAT(hub-legacy-execution-labels): records created before 2026-07-24 lack owner; remove after 2027-01-24.
    const legacy = (await this.options.agentStorage.list()).find(
      (record) =>
        record.labels?.["ginit.execution_id"] === executionId &&
        record.labels?.["ginit.remote"] === "true",
    );
    return legacy ?? null;
  }

  private forwardAgentEvent(event: AgentManagerEvent): void {
    let agent = null;
    if (event.type === "agent_state") {
      agent = event.agent;
    } else if (event.type === "agent_stream") {
      agent = this.options.agentManager.getAgent(event.agentId);
    }
    if (!agent) return;
    const executionId = executionIdFromLabels(agent.labels);
    if (!executionId) return;
    const seq = (this.eventSeq.get(executionId) ?? 0) + 1;
    this.eventSeq.set(executionId, seq);
    const eventType = event.type === "agent_stream" ? event.event.type : `state:${agent.lifecycle}`;
    this.send({
      type: "hub.execution.agent.stream",
      executionId,
      paseoAgentId: agent.id,
      workspaceId: agent.workspaceId ?? "",
      turnId:
        event.type === "agent_stream" && "turnId" in event.event
          ? (event.event.turnId ?? null)
          : agent.activeForegroundTurnId,
      eventId: randomUUID(),
      seq,
      eventType,
      payload: event,
    });
  }

  private async sendWorkspaceSnapshot(): Promise<void> {
    const workspaces = (await this.options.workspaceRegistry.list()).filter(
      (workspace) => !workspace.archivedAt,
    );
    const agents = await this.options.agentStorage.list();
    const snapshots = await Promise.all(
      workspaces.map(async (workspace) => {
        await this.options.providerSnapshotManager.warmUpSnapshotForCwd({ cwd: workspace.cwd });
        const providers = this.options.providerSnapshotManager
          .getSnapshot(workspace.cwd)
          .map((entry) => ({
            id: entry.provider,
            status: entry.status,
            capabilities: {},
          }));
        return {
          workspaceId: workspace.workspaceId,
          cwd: workspace.cwd,
          title: workspace.title ?? workspace.displayName,
          providers,
          agents: agents
            .filter(
              (agent) => agent.workspaceId === workspace.workspaceId && agent.cwd === workspace.cwd,
            )
            .map((agent) => ({
              id: agent.id,
              provider: agent.provider,
              workspaceId: agent.workspaceId ?? "",
              cwd: agent.cwd,
              title: agent.title ?? null,
              status: agent.lastStatus,
              lastActivityAt: agent.lastActivityAt ?? null,
              adoptable:
                !agent.archivedAt &&
                !agent.owner &&
                !agent.labels["ginit.execution_id"] &&
                agent.lastStatus !== "initializing" &&
                agent.lastStatus !== "running",
            })),
        };
      }),
    );
    this.send({ type: "hub.workspace.snapshot", workspaces: snapshots });
  }

  private send(message: PaseoHubOutboundMessage): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(message));
  }

  private startHeartbeat(intervalMs: number): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(
      () => {
        this.send({ type: "hub.heartbeat", sentAt: new Date().toISOString() });
      },
      Math.max(1_000, intervalMs || DEFAULT_HEARTBEAT_MS),
    );
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private clearTimers(): void {
    this.clearHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(RECONNECT_MAX_MS, this.reconnectDelayMs * 2);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
