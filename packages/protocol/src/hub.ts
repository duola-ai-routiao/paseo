import { z } from "zod";

export const PaseoHubProtocolVersion = 2 as const;

export const HubProviderSnapshotSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["ready", "loading", "error", "unavailable"]),
  capabilities: z.record(z.string(), z.boolean()).optional(),
});

export const HubWorkspaceAgentSchema = z.object({
  id: z.string().min(1),
  provider: z.string().min(1),
  workspaceId: z.string().min(1),
  cwd: z.string().min(1),
  title: z.string().nullable(),
  status: z.string().min(1),
  lastActivityAt: z.string().nullable(),
  adoptable: z.boolean(),
});

export const HubRepoIdentitySchema = z.object({
  remote: z.string().nullable().optional(),
  fingerprint: z.string().nullable().optional(),
});

export const HubWorkspaceSnapshotSchema = z.object({
  workspaceId: z.string().min(1),
  cwd: z.string().min(1),
  title: z.string().min(1),
  repoIdentity: HubRepoIdentitySchema.optional(),
  providers: z.array(HubProviderSnapshotSchema),
  agents: z.array(HubWorkspaceAgentSchema).optional(),
});

export const HubHelloSchema = z.object({
  type: z.literal("hub.hello"),
  protocolVersion: z.number().int().positive(),
  deviceId: z.string().min(1),
  daemonId: z.string().min(1),
  publicKey: z.string().min(1),
  nonce: z.string().min(1),
  signature: z.string().min(1),
  relay: z
    .object({
      endpoint: z.string().min(1),
      use_tls: z.boolean(),
      public_key: z.string().min(1),
      signature: z.string().min(1),
    })
    .optional(),
});

export const HubWelcomeSchema = z.object({
  type: z.literal("hub.welcome"),
  protocolVersion: z.number().int().positive(),
  connectionId: z.string().min(1),
  heartbeatIntervalMs: z.number().int().positive(),
});

export const HubHeartbeatSchema = z.object({
  type: z.literal("hub.heartbeat"),
  sentAt: z.string().datetime(),
});

export const HubWorkspaceSnapshotMessageSchema = z.object({
  type: z.literal("hub.workspace.snapshot"),
  workspaces: z.array(HubWorkspaceSnapshotSchema),
});

export const HubTargetRemoveSchema = z.object({
  type: z.literal("hub.target.remove"),
  workspaceId: z.string().min(1),
});

export const HubExecutionEnvelopeSchema = z.object({
  executionId: z.string().min(1),
  paseoAgentId: z.string().min(1),
  workspaceId: z.string().min(1),
  turnId: z.string().nullable().optional(),
  eventId: z.string().min(1),
  seq: z.number().int().nonnegative(),
});

export const HubExecutionCreateRequestSchema = z.object({
  type: z.literal("hub.execution.agent.create.request"),
  requestId: z.string().min(1),
  executionId: z.string().min(1),
  workspaceId: z.string().min(1),
  provider: z.string().min(1),
  cwd: z.string().min(1),
  prompt: z.string(),
  scopeBrief: z
    .object({
      access: z.enum(["read", "write", "read_only"]).optional(),
      projectCount: z.number().int().nonnegative().optional(),
    })
    .optional(),
  labels: z.record(z.string(), z.string()).optional(),
});

export const HubExecutionCreateResponseSchema = z.object({
  type: z.literal("hub.execution.agent.create.response"),
  requestId: z.string().min(1),
  executionId: z.string().min(1),
  accepted: z.boolean(),
  paseoAgentId: z.string().nullable(),
  error: z.string().nullable(),
});

export const HubExecutionAdoptRequestSchema = z.object({
  type: z.literal("hub.execution.agent.adopt.request"),
  requestId: z.string().min(1),
  executionId: z.string().min(1),
  workspaceId: z.string().min(1),
  provider: z.string().min(1),
  cwd: z.string().min(1),
  paseoAgentId: z.string().min(1),
  prompt: z.string().optional(),
});

export const HubExecutionAdoptResponseSchema = z.object({
  type: z.literal("hub.execution.agent.adopt.response"),
  requestId: z.string().min(1),
  executionId: z.string().min(1),
  accepted: z.boolean(),
  paseoAgentId: z.string().nullable(),
  error: z.string().nullable(),
});

export const HubExecutionReleaseRequestSchema = z.object({
  type: z.literal("hub.execution.agent.release.request"),
  requestId: z.string().min(1),
  executionId: z.string().min(1),
  paseoAgentId: z.string().min(1),
});

export const HubExecutionReleaseResponseSchema = z.object({
  type: z.literal("hub.execution.agent.release.response"),
  requestId: z.string().min(1),
  executionId: z.string().min(1),
  accepted: z.boolean(),
  error: z.string().nullable(),
});

export const HubExecutionSendResponseSchema = z.object({
  type: z.literal("hub.execution.agent.send.response"),
  requestId: z.string().min(1),
  executionId: z.string().min(1),
  accepted: z.boolean(),
  error: z.string().nullable(),
});

export const HubExecutionSendRequestSchema = z.object({
  type: z.literal("hub.execution.agent.send.request"),
  requestId: z.string().min(1),
  executionId: z.string().min(1),
  paseoAgentId: z.string().min(1),
  messageId: z.string().min(1),
  text: z.string(),
});

export const HubExecutionCancelRequestSchema = z.object({
  type: z.literal("hub.execution.agent.cancel.request"),
  requestId: z.string().min(1),
  executionId: z.string().min(1),
  paseoAgentId: z.string().min(1),
});

export const HubExecutionCancelResponseSchema = z.object({
  type: z.literal("hub.execution.agent.cancel.response"),
  requestId: z.string().min(1),
  executionId: z.string().min(1),
  accepted: z.boolean(),
  error: z.string().nullable(),
});

export const HubExecutionApprovalResponseSchema = z.object({
  type: z.literal("hub.execution.agent.approval.respond.request"),
  requestId: z.string().min(1),
  executionId: z.string().min(1),
  paseoAgentId: z.string().min(1),
  approvalId: z.string().min(1),
  decisionId: z.string().min(1),
  decision: z.enum(["allow", "deny"]),
});

export const HubExecutionApprovalResultSchema = z.object({
  type: z.literal("hub.execution.agent.approval.respond.response"),
  requestId: z.string().min(1),
  executionId: z.string().min(1),
  accepted: z.boolean(),
  error: z.string().nullable(),
});

export const HubExecutionStreamSchema = HubExecutionEnvelopeSchema.extend({
  type: z.literal("hub.execution.agent.stream"),
  eventType: z.string().min(1),
  payload: z.unknown(),
});

export const HubExecutionSnapshotRequestSchema = z.object({
  type: z.literal("hub.execution.agent.snapshot.request"),
  requestId: z.string().min(1),
  executionId: z.string().min(1),
  paseoAgentId: z.string().min(1),
});

export const HubExecutionSnapshotResponseSchema = z.object({
  type: z.literal("hub.execution.agent.snapshot.response"),
  requestId: z.string().min(1),
  executionId: z.string().min(1),
  snapshot: z.unknown(),
  lastSeq: z.number().int().nonnegative(),
  error: z.string().nullable(),
});

export const HubExecutionStreamAckSchema = z.object({
  type: z.literal("hub.execution.agent.stream.ack"),
  executionId: z.string().min(1),
  seq: z.number().int().nonnegative(),
});

export const HubExecutionReconcileRequestSchema = z.object({
  type: z.literal("hub.execution.agent.reconcile.request"),
  requestId: z.string().min(1),
  executions: z.array(
    z.object({
      executionId: z.string().min(1),
      paseoAgentId: z.string().min(1),
      lastSeq: z.number().int().nonnegative(),
    }),
  ),
});

export const HubExecutionReconcileResponseSchema = z.object({
  type: z.literal("hub.execution.agent.reconcile.response"),
  requestId: z.string().min(1),
  executions: z.array(
    z.object({
      executionId: z.string().min(1),
      lastSeq: z.number().int().nonnegative(),
      snapshot: z.unknown().nullable(),
      error: z.string().nullable(),
    }),
  ),
});

export const PaseoHubInboundMessageSchema = z.discriminatedUnion("type", [
  HubWelcomeSchema,
  HubHeartbeatSchema,
  HubExecutionCreateRequestSchema,
  HubExecutionAdoptRequestSchema,
  HubExecutionReleaseRequestSchema,
  HubExecutionSendRequestSchema,
  HubExecutionCancelRequestSchema,
  HubExecutionApprovalResponseSchema,
  HubExecutionSnapshotRequestSchema,
  HubExecutionStreamAckSchema,
  HubExecutionReconcileRequestSchema,
]);

export const PaseoHubOutboundMessageSchema = z.discriminatedUnion("type", [
  HubHelloSchema,
  HubHeartbeatSchema,
  HubWorkspaceSnapshotMessageSchema,
  HubTargetRemoveSchema,
  HubExecutionCreateResponseSchema,
  HubExecutionAdoptResponseSchema,
  HubExecutionReleaseResponseSchema,
  HubExecutionSendResponseSchema,
  HubExecutionCancelResponseSchema,
  HubExecutionApprovalResultSchema,
  HubExecutionStreamSchema,
  HubExecutionSnapshotResponseSchema,
  HubExecutionReconcileResponseSchema,
]);

export type PaseoHubInboundMessage = z.infer<typeof PaseoHubInboundMessageSchema>;
export type PaseoHubOutboundMessage = z.infer<typeof PaseoHubOutboundMessageSchema>;
