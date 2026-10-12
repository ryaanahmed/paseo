import { z } from "zod";

// These are standing input limits, not total task spending or notification budgets.
export const ContextPolicySchema = z.object({
  providerWindowTokens: z.number().int().positive(),
  clientWindowTokens: z.number().int().positive(),
  outputReserveTokens: z.number().int().nonnegative(),
  thresholdTokens: z.number().int().positive(),
});

export type ContextPolicy = z.infer<typeof ContextPolicySchema>;

// A local scope-store reading, not proof of the next inference request's limits.
export const ContextPolicyStatusSchema = z.object({
  scopeId: z.string(),
  effectiveInputTokens: z.number().int().nonnegative(),
  inputCapacityTokens: z.number().int().nonnegative().nullable(),
  limitingReason: z.string(),
  baseThresholdTokens: z.number().int().nonnegative(),
  observedAt: z.string(),
});
export type ContextPolicyStatus = z.infer<typeof ContextPolicyStatusSchema>;
