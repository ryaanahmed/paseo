import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const identity = z.string().min(1).max(200);
export const WatchInput = z.object({
  id: z.string().regex(/^[a-zA-Z0-9._-]{1,128}$/),
  agentId: identity,
  clientMessageId: identity,
  recipientId: identity,
  requireParentOwnership: z.boolean().default(false),
});
export const WatchRecord = WatchInput.extend({
  deliveryId: z.string(),
  state: z.enum(["pending", "delivering", "delivered", "unknown", "blocked", "canceled"]),
  outcome: z
    .object({
      executionId: identity,
      turnId: identity.nullable(),
      status: z.enum(["completed", "failed", "canceled"]),
    })
    .optional(),
  errorCode: z.string().optional(),
});
export type Watch = z.infer<typeof WatchRecord>;
export type WatchRequest = z.infer<typeof WatchInput>;
export const watch = defineRpc({
  name: "completion.watch",
  input: WatchInput,
  output: WatchRecord,
});
export const get = defineRpc({
  name: "completion.get",
  input: WatchInput.pick({ id: true }),
  output: WatchRecord.nullable(),
});
export const cancel = defineRpc({
  name: "completion.cancel",
  input: WatchInput.pick({ id: true }),
  output: WatchRecord.nullable(),
});
