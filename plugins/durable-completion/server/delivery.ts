import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { CompletionStore } from "./store.js";
import type { Watch } from "../shared/contracts.js";

type Paseo = PluginHandlerContext["paseo"];

export function notification(record: Watch): string {
  if (!record.outcome) throw new Error("completion_outcome_missing");
  const metadata = {
    deliveryId: record.deliveryId,
    agentId: record.agentId,
    clientMessageId: record.clientMessageId,
    ...record.outcome,
  };
  return `<paseo-system>\nExecution outcome; apply your workspace's acceptance rules. Query the exact execution for evidence.\n${JSON.stringify(metadata)}\n</paseo-system>`;
}

export async function deliverPending(
  store: CompletionStore,
  paseo: Paseo,
  signal: AbortSignal,
): Promise<void> {
  for (const record of store.pending()) {
    if (signal.aborted) return;
    try {
      await deliverOne(store, paseo, record, signal);
    } catch {
      // Query/storage failures remain visible and can be retried without submitting a prompt.
      await store.save({
        ...(store.get(record.id) ?? record),
        errorCode: "completion_reconcile_failed",
      });
    }
  }
}

async function deliverOne(
  store: CompletionStore,
  paseo: Paseo,
  record: Watch,
  signal: AbortSignal,
): Promise<void> {
  let ready = record;
  const source = paseo.agents.ref(record.agentId);
  if (!ready.outcome) {
    const outcome = await source.execution({
      kind: "submission",
      clientMessageId: record.clientMessageId,
    });
    if (!outcome || outcome.status === "starting" || outcome.status === "running") return;
    if (outcome.status === "unknown") {
      await store.save({ ...record, state: "unknown", errorCode: "execution_outcome_unknown" });
      return;
    }
    ready = await store.save({
      ...record,
      outcome: { executionId: outcome.executionId, turnId: outcome.turnId, status: outcome.status },
      errorCode: undefined,
    });
  }

  const recipient = paseo.agents.ref(record.recipientId);
  const snapshot = (await recipient.refresh())?.agent;
  if (!snapshot || snapshot.archivedAt) {
    await store.save({ ...ready, state: "blocked", errorCode: "recipient_unavailable" });
    return;
  }
  if (
    record.requireParentOwnership &&
    getParentAgentIdFromLabels((await source.refresh())?.agent.labels) !== record.recipientId
  ) {
    await store.save({ ...ready, state: "blocked", errorCode: "parent_ownership_changed" });
    return;
  }
  // Idle is an admission hint, never evidence that the source completed.
  if (snapshot.status !== "idle" || signal.aborted) return;
  const delivering = await store.save({ ...ready, state: "delivering", errorCode: undefined });
  if (signal.aborted) return;
  try {
    // Stable keyed admission deduplicates a known delivery after plugin/daemon restart.
    // reject refuses concurrent work and never resurrects an archived recipient.
    await recipient.send(notification(delivering), {
      messageId: delivering.deliveryId,
      activeTurnBehavior: "reject",
    });
  } catch (error) {
    if (error instanceof Error && error.message === "agent_busy") {
      await store.save({ ...delivering, state: "pending", errorCode: "recipient_busy" });
      return;
    }
    if (error instanceof Error && error.message === "agent_archived") {
      await store.save({ ...delivering, state: "blocked", errorCode: "recipient_unavailable" });
      return;
    }
    // The provider may have accepted before the acknowledgement was lost. Never blindly retry.
    await store.save({
      ...delivering,
      state: "unknown",
      errorCode: "notification_admission_unknown",
    });
    return;
  }
  await store.save({ ...delivering, state: "delivered" });
}
