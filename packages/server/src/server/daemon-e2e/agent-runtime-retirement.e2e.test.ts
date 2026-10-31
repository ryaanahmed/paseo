import { expect, test } from "vitest";
import { createPaseoClient } from "@getpaseo/client";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";

// The test daemon uses deterministic local providers and a disposable home/port.
test("SDK retires an exact worker runtime and resumes its durable identity over RPC", async () => {
  const daemon = await createTestPaseoDaemon();
  const client = createPaseoClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  try {
    await client.connect();
    expect(client.agents.supportsRuntimeRetirement()).toBe(true);
    const workspace = await client.workspaces.create({
      source: { kind: "directory", path: daemon.staticDir },
      background: true,
    });
    const worker = await workspace.agents.create({
      config: { provider: "codex/gpt-5.4" },
      title: "Disposable RPC worker",
    });
    await worker.run("Say hello", { messageId: "first-turn", activeTurnBehavior: "reject" });
    const execution = await worker.execution({ kind: "latest" });
    expect(execution).toMatchObject({
      agentId: worker.id,
      clientMessageId: "first-turn",
      status: "completed",
    });
    if (!execution?.turnId) throw new Error("Test provider did not produce an exact turn");
    const expected = {
      executionId: execution.executionId,
      clientMessageId: "first-turn",
      turnId: execution.turnId,
      parentAgentId: null,
      cwd: daemon.staticDir,
    };
    await expect(worker.retireRuntime(expected)).resolves.toMatchObject({
      agentId: worker.id,
      executionId: execution.executionId,
      alreadyClosed: false,
    });
    await worker.refresh();
    expect(worker.current()).toMatchObject({
      id: worker.id,
      runtimeLoaded: false,
      status: "closed",
      archivedAt: null,
    });
    expect(await worker.execution({ kind: "submission", clientMessageId: "first-turn" })).toEqual(
      execution,
    );
    await worker.run("Say hello again", { messageId: "second-turn", activeTurnBehavior: "reject" });
    await worker.refresh();
    expect(worker.current()).toMatchObject({
      id: worker.id,
      runtimeLoaded: true,
      status: "idle",
      archivedAt: null,
    });
    expect(await worker.execution({ kind: "latest" })).toMatchObject({
      agentId: worker.id,
      clientMessageId: "second-turn",
      status: "completed",
    });
    await expect(worker.retireRuntime(expected)).rejects.toThrow(
      "agent_runtime_retirement_execution_changed",
    );
  } finally {
    await client.close();
    await daemon.close();
  }
}, 60_000);
