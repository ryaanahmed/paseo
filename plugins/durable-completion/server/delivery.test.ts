import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { CompletionStore } from "./store.js";
import { deliverPending, notification } from "./delivery.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
  directories.length = 0;
});
const request = {
  id: "assignment",
  agentId: "child",
  clientMessageId: "submission",
  recipientId: "parent",
  requireParentOwnership: true,
};

async function scenario() {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-completion-"));
  directories.push(directory);
  const store = new CompletionStore(directory);
  await store.initialize();
  await store.watch(request);
  const state = {
    outcome: "completed",
    recipientStatus: "idle",
    archivedAt: null as string | null,
    parentAgentId: "parent",
  };
  const accepted = new Set<string>();
  const send = vi.fn(async (_text: string, options: { messageId: string }) => {
    accepted.add(options.messageId);
  });
  const execution = vi.fn(async () => ({
    executionId: "execution",
    turnId: "turn",
    status: state.outcome,
    finalAnswer: "PRIVATE TRANSCRIPT MUST NEVER BE COPIED",
  }));
  const paseo = {
    agents: {
      ref: (id: string) => ({
        execution,
        refresh: async () => ({
          agent:
            id === "child"
              ? { labels: { "paseo.parent-agent-id": state.parentAgentId } }
              : { status: state.recipientStatus, archivedAt: state.archivedAt },
        }),
        send,
      }),
    },
  } as unknown as PluginHandlerContext["paseo"];
  const tick = (target = store) => deliverPending(target, paseo, new AbortController().signal);
  return { directory, store, state, send, execution, accepted, paseo, tick };
}

it.each(["completed", "failed", "canceled"])(
  "delivers bounded %s evidence once across restart",
  async (status) => {
    const test = await scenario();
    test.state.outcome = status;
    await test.tick();
    const record = test.store.get(request.id)!;
    expect(record.state).toBe("delivered");
    expect(record.outcome?.status).toBe(status);
    const text = notification(record);
    expect(Buffer.byteLength(text)).toBeLessThan(1200);
    expect(text).not.toContain("PRIVATE");
    expect(text).not.toContain("<paseo-system>");
    expect(test.send).toHaveBeenCalledWith(text, {
      messageId: record.deliveryId,
      sourceAgentId: request.agentId,
      activeTurnBehavior: "reject",
    });
    const restarted = new CompletionStore(test.directory);
    await restarted.initialize();
    await restarted.watch(request);
    await test.tick(restarted);
    expect(test.send).toHaveBeenCalledTimes(1);
  },
);

it("recovers subscription and terminal outcome without receiving a live event", async () => {
  const test = await scenario();
  const restarted = new CompletionStore(test.directory);
  await restarted.initialize();
  await test.tick(restarted);
  expect(restarted.get(request.id)?.state).toBe("delivered");
});

it("retains starting/running subscriptions without deriving success from recipient idle", async () => {
  const test = await scenario();
  test.state.outcome = "running";
  await test.tick();
  expect(test.store.get(request.id)?.state).toBe("pending");
  expect(test.send).not.toHaveBeenCalled();
});

it("keeps uncertain execution visible without waking the recipient", async () => {
  const test = await scenario();
  test.state.outcome = "unknown";
  await test.tick();
  expect(test.store.get(request.id)).toMatchObject({
    state: "unknown",
    errorCode: "execution_outcome_unknown",
  });
  expect(test.send).not.toHaveBeenCalled();
});

it("waits for a busy recipient and does not discard its terminal evidence", async () => {
  const test = await scenario();
  test.state.recipientStatus = "running";
  await test.tick();
  expect(test.store.get(request.id)).toMatchObject({
    state: "pending",
    outcome: { status: "completed" },
  });
  expect(test.send).not.toHaveBeenCalled();
  test.state.recipientStatus = "idle";
  await test.tick();
  expect(test.send).toHaveBeenCalledTimes(1);
});

it.each(["archive", "detach"])(
  "blocks %s without resurrecting or transferring ownership",
  async (kind) => {
    const test = await scenario();
    if (kind === "archive") test.state.archivedAt = "2026-10-12";
    else test.state.parentAgentId = "new-parent";
    await test.tick();
    expect(test.store.get(request.id)?.state).toBe("blocked");
    expect(test.send).not.toHaveBeenCalled();
  },
);

it("replays a crash-gap delivery with the same key and immutable body", async () => {
  const test = await scenario();
  await test.store.save({
    ...test.store.get(request.id)!,
    state: "delivering",
    outcome: { executionId: "execution", turnId: "turn", status: "completed" },
  });
  const original = notification(test.store.get(request.id)!);
  test.accepted.add(test.store.get(request.id)!.deliveryId);
  const restarted = new CompletionStore(test.directory);
  await restarted.initialize();
  await test.tick(restarted);
  expect(test.send).toHaveBeenCalledWith(original, {
    messageId: restarted.get(request.id)!.deliveryId,
    sourceAgentId: request.agentId,
    activeTurnBehavior: "reject",
  });
  expect(test.accepted.size).toBe(1);
  expect(restarted.get(request.id)?.state).toBe("delivered");
});

it("does not retry an uncertain recipient admission", async () => {
  const test = await scenario();
  test.send.mockRejectedValue(new Error("agent_request_outcome_unknown"));
  await test.tick();
  await test.tick();
  expect(test.store.get(request.id)).toMatchObject({
    state: "unknown",
    errorCode: "notification_admission_unknown",
  });
  expect(test.send).toHaveBeenCalledTimes(1);
});

it("rejects changed subscription identity and preserves private bounded records", async () => {
  const test = await scenario();
  await expect(test.store.watch({ ...request, recipientId: "different" })).rejects.toThrow(
    "completion_watch_conflict",
  );
  await test.tick();
  const names = await readdir(test.directory);
  expect(names).toHaveLength(1);
  const saved = await readFile(path.join(test.directory, names[0]!), "utf8");
  expect(saved).not.toContain("PRIVATE");
  expect(saved.length).toBeLessThan(1200);
});

it("aborts delivery on plugin shutdown", async () => {
  const test = await scenario();
  await deliverPending(test.store, test.paseo, AbortSignal.abort());
  expect(test.send).not.toHaveBeenCalled();
});

it("retains the same delivery identity when the recipient becomes busy after inspection", async () => {
  const test = await scenario();
  test.send.mockRejectedValueOnce(new Error("agent_busy"));
  await test.tick();
  expect(test.store.get(request.id)?.state).toBe("pending");
  await test.tick();
  expect(test.store.get(request.id)?.state).toBe("delivered");
  expect(test.send.mock.calls[0]?.[1]).toEqual(test.send.mock.calls[1]?.[1]);
});

it("blocks a recipient archived between inspection and submission", async () => {
  const test = await scenario();
  test.send.mockRejectedValueOnce(new Error("agent_archived"));
  await test.tick();
  expect(test.store.get(request.id)?.state).toBe("blocked");
});
