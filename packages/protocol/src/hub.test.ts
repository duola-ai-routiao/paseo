import { describe, expect, test } from "vitest";
import {
  HubExecutionCreateRequestSchema,
  HubExecutionStreamSchema,
  HubExecutionStreamAckSchema,
  HubWorkspaceSnapshotMessageSchema,
  PaseoHubInboundMessageSchema,
  PaseoHubOutboundMessageSchema,
} from "./hub.js";

describe("Paseo Hub protocol", () => {
  test("accepts workspace/provider snapshots", () => {
    const message = HubWorkspaceSnapshotMessageSchema.parse({
      type: "hub.workspace.snapshot",
      workspaces: [
        {
          workspaceId: "ws-1",
          cwd: "/repo",
          title: "repo",
          repoIdentity: { remote: "git@example/repo", fingerprint: "sha256:abc" },
          providers: [{ id: "cursor", status: "ready", capabilities: { streaming: true } }],
        },
      ],
    });
    expect(message.workspaces[0]?.providers[0]?.id).toBe("cursor");
    expect(PaseoHubOutboundMessageSchema.parse(message)).toEqual(message);
  });

  test("keeps execution requests idempotent by request id", () => {
    const message = HubExecutionCreateRequestSchema.parse({
      type: "hub.execution.agent.create.request",
      requestId: "req-1",
      executionId: "exec-1",
      workspaceId: "ws-1",
      provider: "codex",
      cwd: "/repo",
      prompt: "inspect the failing test",
    });
    expect(PaseoHubInboundMessageSchema.parse(message)).toEqual(message);
  });

  test("accepts opaque stream payloads without rewriting provider events", () => {
    const message = HubExecutionStreamSchema.parse({
      type: "hub.execution.agent.stream",
      executionId: "exec-1",
      paseoAgentId: "agent-1",
      workspaceId: "ws-1",
      eventId: "event-1",
      seq: 3,
      eventType: "agent_update",
      payload: { status: "running" },
    });
    expect(message.payload).toEqual({ status: "running" });
  });

  test("accepts correlated control responses and stream acknowledgements", () => {
    expect(
      PaseoHubOutboundMessageSchema.parse({
        type: "hub.execution.agent.send.response",
        requestId: "req-2",
        executionId: "exec-1",
        accepted: true,
        error: null,
      }),
    ).toMatchObject({ requestId: "req-2" });
    expect(
      PaseoHubInboundMessageSchema.parse({
        type: "hub.execution.agent.stream.ack",
        executionId: "exec-1",
        seq: 3,
      }),
    ).toEqual({ type: "hub.execution.agent.stream.ack", executionId: "exec-1", seq: 3 });
  });
});
