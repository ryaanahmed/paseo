import { z } from "zod";

// Execution settlement is independent of workspace handoff validation or acceptance.
export const AgentExecutionSchema = z.object({
  agentId: z.string(),
  executionId: z.string(),
  provider: z.string(),
  providerSessionId: z.string().optional(),
  turnId: z.string().nullable(),
  clientMessageId: z.string().optional(),
  status: z.enum(["starting", "running", "completed", "failed", "canceled", "unknown"]),
  startedAt: z.string(),
  updatedAt: z.string(),
  finishedAt: z.string().optional(),
  errorCode: z.string().optional(),
});
export type AgentExecution = z.infer<typeof AgentExecutionSchema>;

export const AgentExecutionQuerySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("execution"), executionId: z.string().min(1) }),
  z.object({ kind: z.literal("submission"), clientMessageId: z.string().min(1) }),
]);
export type AgentExecutionQuery = z.infer<typeof AgentExecutionQuerySchema>;
