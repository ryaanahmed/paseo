import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import type { AgentExecution } from "@getpaseo/protocol/agent-execution";
import { AgentExecutionStore } from "./agent-execution-store.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-executions-"));
  directories.push(directory);
  return { directory, store: new AgentExecutionStore(directory) };
}

function record(executionId: string, overrides: Partial<AgentExecution> = {}): AgentExecution {
  return {
    agentId: "worker",
    executionId,
    provider: "codex",
    turnId: null,
    clientMessageId: executionId,
    status: "starting",
    startedAt: "2026-10-12T12:00:00.000Z",
    updatedAt: "2026-10-12T12:00:00.000Z",
    ...overrides,
  };
}

test.each(["completed", "failed", "canceled"] as const)(
  "exact %s execution survives store restart and late conflicting callbacks",
  async (status) => {
    const { directory, store } = await fixture();
    await store.create(record("execution"));
    await store.update("worker", "execution", {
      status: "running",
      turnId: "provider-turn",
      providerSessionId: "provider-session",
    });
    await store.update("worker", "execution", { status });
    await store.update("worker", "execution", { status: "unknown" });
    const restarted = new AgentExecutionStore(directory);
    const result = await restarted.get("worker", {
      kind: "submission",
      clientMessageId: "execution",
    });
    expect(result).toMatchObject({
      status,
      executionId: "execution",
      turnId: "provider-turn",
      providerSessionId: "provider-session",
      finishedAt: expect.any(String),
    });
  },
);

test("restart preserves uncertain acceptance without inventing a terminal timestamp", async () => {
  const { directory, store } = await fixture();
  await store.create(record("not-acknowledged"));
  await store.create(record("accepted", { status: "running", turnId: "turn" }));
  const restarted = new AgentExecutionStore(directory);
  for (const executionId of ["not-acknowledged", "accepted"]) {
    const result = await restarted.get("worker", { kind: "execution", executionId });
    expect(result).toMatchObject({ status: "unknown", errorCode: "daemon_restarted" });
    expect(result?.finishedAt).toBeUndefined();
    await restarted.update("worker", executionId, { status: "completed" });
    expect(await restarted.get("worker", { kind: "execution", executionId })).toEqual(result);
  }
});

test("agent and execution identity isolate reused provider turn IDs", async () => {
  const { store } = await fixture();
  await store.create(record("old", { turnId: "same", providerSessionId: "old-session" }));
  await store.update("worker", "old", { status: "completed" });
  await store.create(record("new", { turnId: "same", providerSessionId: "new-session" }));
  await store.create(record("new", { agentId: "other", turnId: "same" }));
  await store.update("worker", "old", { status: "failed" });
  expect(await store.get("worker", { kind: "submission", clientMessageId: "new" })).toMatchObject({
    status: "starting",
    providerSessionId: "new-session",
  });
  expect(await store.get("other", { kind: "execution", executionId: "new" })).toMatchObject({
    agentId: "other",
    status: "starting",
  });
  expect(await store.get("missing", { kind: "execution", executionId: "new" })).toBeNull();
});

test("durable records exclude prompt and error prose", async () => {
  const { directory, store } = await fixture();
  const input = { ...record("metadata"), prompt: "private task", error: "private error" };
  await store.create(input);
  const files = await readdir(directory);
  expect(files).toHaveLength(1);
  const content = await readFile(path.join(directory, files[0]!), "utf8");
  expect(content).not.toContain("private");
});

test("external admission reads the same durable terminal evidence through the store path", async () => {
  const { directory, store } = await fixture();
  await store.create(record("finishing-proof", { status: "running", turnId: "native-turn" }));
  expect(store.directoryPath).toBe(directory);
  const file = store.pathForExecution("worker", "finishing-proof");
  expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
    agentId: "worker",
    executionId: "finishing-proof",
    status: "running",
    turnId: "native-turn",
  });
  await store.update("worker", "finishing-proof", { status: "completed" });
  expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ status: "completed" });
});
