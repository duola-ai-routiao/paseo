import { describe, expect, test } from "vitest";
import {
  HubExecutionCreateRequestSchema,
  HubExecutionAdoptRequestSchema,
  HubExecutionReleaseRequestSchema,
  HubExecutionStreamSchema,
  HubWorkspaceSnapshotMessageSchema,
  PaseoHubInboundMessageSchema,
  PaseoHubOutboundMessageSchema,
} from "./hub.js";

describe("Paseo Hub protocol", () => {
  test("accepts signed relay metadata on hello", () => {
    const message = PaseoHubOutboundMessageSchema.parse({
      type: "hub.hello",
      protocolVersion: 2,
      deviceId: "device-1",
      daemonId: "daemon-1",
      publicKey: "hub-public-key",
      nonce: "nonce-1",
      signature: "hello-signature",
      relay: {
        endpoint: "relay.example.com:443",
        use_tls: true,
        public_key: "relay-public-key",
        signature: "relay-signature",
      },
    });

    expect(message.relay).toEqual({
      endpoint: "relay.example.com:443",
      use_tls: true,
      public_key: "relay-public-key",
      signature: "relay-signature",
    });
  });

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

  test("keeps workspace session snapshots metadata-only", () => {
    const message = HubWorkspaceSnapshotMessageSchema.parse({
      type: "hub.workspace.snapshot",
      workspaces: [
        {
          workspaceId: "ws-1",
          cwd: "/repo",
          title: "repo",
          providers: [],
          agents: [
            {
              id: "agent-1",
              provider: "cursor-server",
              workspaceId: "ws-1",
              cwd: "/repo",
              title: "Investigate the oncall alert",
              status: "idle",
              lastActivityAt: "2026-07-24T00:00:00.000Z",
              adoptable: true,
              timeline: [{ text: "must not leave the device" }],
            },
          ],
        },
      ],
    });

    expect(message.workspaces[0]?.agents?.[0]).toEqual({
      id: "agent-1",
      provider: "cursor-server",
      workspaceId: "ws-1",
      cwd: "/repo",
      title: "Investigate the oncall alert",
      status: "idle",
      lastActivityAt: "2026-07-24T00:00:00.000Z",
      adoptable: true,
    });
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

  test("accepts explicit adoption of an existing workspace agent", () => {
    const message = HubExecutionAdoptRequestSchema.parse({
      type: "hub.execution.agent.adopt.request",
      requestId: "adopt-1",
      executionId: "exec-1",
      workspaceId: "ws-1",
      provider: "cursor-server",
      cwd: "/repo",
      paseoAgentId: "agent-existing",
      prompt: "continue the oncall investigation",
    });
    expect(PaseoHubInboundMessageSchema.parse(message)).toEqual(message);
  });

  test("does not require a prompt when only claiming an existing session", () => {
    expect(
      HubExecutionAdoptRequestSchema.parse({
        type: "hub.execution.agent.adopt.request",
        requestId: "adopt-1",
        executionId: "exec-1",
        workspaceId: "ws-1",
        provider: "cursor-server",
        cwd: "/repo",
        paseoAgentId: "agent-existing",
      }),
    ).not.toHaveProperty("prompt");
  });

  test("accepts explicit release before a session is reassigned", () => {
    const message = HubExecutionReleaseRequestSchema.parse({
      type: "hub.execution.agent.release.request",
      requestId: "release-1",
      executionId: "exec-1",
      paseoAgentId: "agent-existing",
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
