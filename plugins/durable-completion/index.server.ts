import type { PluginServerContext, PluginHandlerContext } from "@getpaseo/plugin/server";
import { watch, get, cancel } from "./shared/contracts.js";
import { CompletionStore } from "./server/store.js";
import { deliverPending } from "./server/delivery.js";

export default function contribute(server: PluginServerContext) {
  if (!server.onReady) throw new Error("durable-completion requires plugin startup support");
  const store = new CompletionStore(server.dataDirectory);
  const controller = new AbortController();
  let work = Promise.resolve();
  let timer: ReturnType<typeof setInterval> | undefined;
  let reconciling = false;

  // Serialize registration and delivery so reload and repeated registration preserve identity.
  function exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = work.then(async () => {
      await store.initialize();
      return await operation();
    });
    work = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  function reconcile(paseo: PluginHandlerContext["paseo"]) {
    if (reconciling || controller.signal.aborted) return;
    reconciling = true;
    void exclusive(() => deliverPending(store, paseo, controller.signal))
      .catch(() =>
        console.error("durable-completion: reconciliation failed; query persisted delivery state"),
      )
      .finally(() => {
        reconciling = false;
      });
  }

  server.handle(watch, (input, { paseo }) =>
    exclusive(async () => {
      // Capability-gated metadata query also validates the source before durable registration.
      await paseo.agents
        .ref(input.agentId)
        .execution({ kind: "submission", clientMessageId: input.clientMessageId });
      const recipient = (await paseo.agents.ref(input.recipientId).refresh())?.agent;
      if (!recipient || recipient.archivedAt) throw new Error("recipient_unavailable");
      return await store.watch(input);
    }),
  );
  server.handle(get, ({ id }) => exclusive(async () => store.get(id)));
  server.handle(cancel, ({ id }) =>
    exclusive(async () => {
      const record = store.get(id);
      if (!record || record.state === "delivered" || record.state === "unknown") return record;
      return await store.save({ ...record, state: "canceled" });
    }),
  );
  const removeReady = server.onReady(({ paseo, signal }) => {
    signal.addEventListener("abort", () => controller.abort(), { once: true });
    reconcile(paseo);
    // This is plugin I/O reconciliation; it does not schedule an agent polling turn.
    timer = setInterval(() => reconcile(paseo), 5000);
    timer.unref();
  });
  const removeEnded = server.on("agent.turn_ended", (_event, { paseo }) => reconcile(paseo));
  return async () => {
    controller.abort();
    if (timer) clearInterval(timer);
    removeReady();
    removeEnded();
    await work;
  };
}
