import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { AgentExecution } from "@getpaseo/protocol/agent-execution";
import {
  AgentMessageQueue,
  type AgentMessageQueuePorts,
  type QueuedAgentMessage,
} from "./agent-message-queue.js";

let directory: string;
let state: "idle" | "busy" | "unavailable";
let dispatched: string[];
let executions: Map<string, AgentExecution>;
let ports: AgentMessageQueuePorts;
let queue: AgentMessageQueue;

function execution(id: string, status: AgentExecution["status"]): AgentExecution {
  return {
    agentId: "recipient",
    executionId: `execution-${id}`,
    provider: "test",
    turnId: `turn-${id}`,
    clientMessageId: id,
    status,
    startedAt: "2026-10-15T00:00:00Z",
    updatedAt: "2026-10-15T00:00:00Z",
  };
}

function enqueue(id: string, prompt = id) {
  return queue.enqueue({
    agentId: "recipient",
    prompt,
    options: { clientMessageId: id },
    metadata: { notifyOnFinish: { callerAgentId: "sender" } },
  });
}

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "agent-message-queue-"));
  state = "idle";
  dispatched = [];
  executions = new Map();
  ports = {
    recipient: async () => state,
    execution: async (_agentId, id) => executions.get(id) ?? null,
    dispatch: async (record) => {
      dispatched.push(record.clientMessageId);
      executions.set(record.clientMessageId, execution(record.clientMessageId, "running"));
      state = "busy";
      return "started";
    },
  };
  queue = new AgentMessageQueue(directory, ports);
});

afterEach(async () => {
  queue.stop();
  await queue.flush();
  await rm(directory, { recursive: true, force: true });
});

test("busy recipients keep FIFO messages durable until each preceding execution settles", async () => {
  state = "busy";
  await enqueue("first");
  await enqueue("second");
  await queue.reconcile();
  expect(dispatched).toEqual([]);
  expect((await queue.get("recipient", "first"))?.state).toBe("pending");
  state = "idle";
  await queue.reconcile();
  expect(dispatched).toEqual(["first"]);
  // An idle snapshot alone does not settle the first execution.
  state = "idle";
  await queue.reconcile();
  expect(dispatched).toEqual(["first"]);
  executions.set("first", execution("first", "completed"));
  await queue.reconcile();
  expect(dispatched).toEqual(["first", "second"]);
});

test("pending messages and notification metadata survive restart in original order", async () => {
  state = "busy";
  await enqueue("one");
  await enqueue("two");
  queue.stop();
  queue = new AgentMessageQueue(directory, ports);
  state = "idle";
  await queue.reconcile();
  expect(dispatched).toEqual(["one"]);
  expect((await queue.get("recipient", "one"))?.metadata).toEqual({
    notifyOnFinish: { callerAgentId: "sender" },
  });
});

test("stable message ids deduplicate and changed content is rejected", async () => {
  await Promise.all([enqueue("one"), enqueue("one")]);
  await expect(enqueue("one", "different")).rejects.toThrow("agent_message_conflict");
  await queue.reconcile();
  await enqueue("one");
  await queue.reconcile();
  expect(dispatched).toEqual(["one"]);
});

test("a busy admission race returns the message to pending without disturbing the active run", async () => {
  ports.dispatch = async () => "busy";
  await enqueue("one");
  await queue.reconcile();
  expect((await queue.get("recipient", "one"))?.state).toBe("pending");
  expect(dispatched).toEqual([]);
});

test("archived recipients block existing messages and reject new messages", async () => {
  await enqueue("one");
  state = "unavailable";
  await expect(enqueue("two")).rejects.toThrow("agent_archived");
  await queue.reconcile();
  expect((await queue.get("recipient", "one"))?.state).toBe("blocked");
  state = "idle";
  await queue.reconcile();
  expect(dispatched).toEqual([]);
});

test.each([null, "unknown"] as const)(
  "restart does not replay uncertain admission with %s receipt",
  async (status) => {
    ports.dispatch = async (record) => {
      dispatched.push(record.clientMessageId);
      return "started";
    };
    await enqueue("one");
    await enqueue("two");
    await queue.reconcile();
    if (status) executions.set("one", execution("one", status));
    queue.stop();
    queue = new AgentMessageQueue(directory, ports);
    await queue.reconcile();
    expect((await queue.get("recipient", "one"))?.state).toBe("unknown");
    expect((await queue.get("recipient", "two"))?.state).toBe("pending");
    expect(dispatched).toEqual(["one"]);
  },
);

test("restart advances only after exact terminal evidence for the dispatched item", async () => {
  await enqueue("one");
  await enqueue("two");
  await queue.reconcile();
  executions.set("one", execution("one", "completed"));
  queue.stop();
  queue = new AgentMessageQueue(directory, ports);
  state = "idle";
  await queue.reconcile();
  expect(dispatched).toEqual(["one", "two"]);
});

test("unknown admission blocks later messages and emits actionable state", async () => {
  const changes: QueuedAgentMessage[] = [];
  ports.onState = (record) => changes.push(record);
  ports.dispatch = async () => {
    throw new Error("acknowledgement lost");
  };
  await enqueue("one");
  await enqueue("two");
  await queue.reconcile();
  await queue.reconcile();
  expect((await queue.get("recipient", "one"))?.state).toBe("unknown");
  expect((await queue.get("recipient", "two"))?.state).toBe("pending");
  expect(changes.at(-1)).toMatchObject({
    agentId: "recipient",
    clientMessageId: "one",
    state: "unknown",
  });
});

test("a busy recipient does not block a different recipient", async () => {
  ports.recipient = async (agentId) => (agentId === "recipient" ? "busy" : "idle");
  await enqueue("one");
  await queue.enqueue({
    agentId: "other",
    prompt: "other",
    options: { clientMessageId: "other-message" },
  });
  await queue.reconcile();
  expect(dispatched).toEqual(["other-message"]);
});

test("an existing exact execution cannot be submitted again by a new queue record", async () => {
  executions.set("one", execution("one", "completed"));
  await enqueue("one");
  await queue.reconcile();
  expect(dispatched).toEqual([]);
  expect((await queue.get("recipient", "one"))?.state).toBe("settled");
});

test("reconciliation requested during dispatch runs again without waiting for the timer", async () => {
  let release!: () => void;
  const admission = new Promise<void>((resolve) => {
    release = resolve;
  });
  ports.dispatch = async (record) => {
    dispatched.push(record.clientMessageId);
    if (record.clientMessageId === "one") await admission;
    executions.set(record.clientMessageId, execution(record.clientMessageId, "completed"));
    return "started";
  };
  await enqueue("one");
  const draining = queue.reconcile();
  await expect.poll(() => dispatched.length).toBe(1);
  await enqueue("two");
  const rerun = queue.reconcile();
  release();
  await Promise.all([draining, rerun]);
  expect(dispatched).toEqual(["one", "two"]);
});

test("late conclusive receipt settles uncertain admission without replay and releases FIFO", async () => {
  ports.dispatch = async () => {
    throw new Error("acknowledgement lost");
  };
  await enqueue("one");
  await enqueue("two");
  await queue.reconcile();
  expect((await queue.get("recipient", "one"))?.state).toBe("unknown");
  executions.set("one", execution("one", "completed"));
  ports.dispatch = async (record) => {
    dispatched.push(record.clientMessageId);
    return "started";
  };
  await queue.reconcile();
  expect((await queue.get("recipient", "one"))?.state).toBe("settled");
  expect(dispatched).toEqual(["two"]);
});

test("deduplication ignores object property order and undefined after restart", async () => {
  const first = {
    agentId: "recipient",
    prompt: "body",
    options: {
      clientMessageId: "one",
      outputSchema: { type: "object", required: ["result"] },
      maxThinkingTokens: undefined,
    },
  };
  await queue.enqueue(first);
  queue.stop();
  queue = new AgentMessageQueue(directory, ports);
  await expect(
    queue.enqueue({
      ...first,
      options: { outputSchema: { required: ["result"], type: "object" }, clientMessageId: "one" },
    }),
  ).resolves.toBeUndefined();
  await queue.reconcile();
  expect(dispatched).toEqual(["one"]);
});
