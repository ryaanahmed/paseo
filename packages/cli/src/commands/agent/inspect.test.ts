import { expect, it, vi } from "vitest";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import { runInspectCommand } from "./inspect.js";
import { connectToDaemon } from "../../utils/client.js";

vi.mock("../../utils/client.js", () => ({ connectToDaemon: vi.fn() }));

async function inspect(extra: Partial<AgentSnapshotPayload>) {
  vi.mocked(connectToDaemon).mockResolvedValue({
    fetchAgent: async () => ({ agent: { id: "agent", provider: "codex", cwd: "/repo", ...extra } }),
    close: async () => {},
  } as unknown as Awaited<ReturnType<typeof connectToDaemon>>);
  return runInspectCommand(
    "agent",
    { daemonTarget: { kind: "endpoint", host: "localhost:6768" } },
    {} as never,
  );
}

it("includes requested policy and scope-store status in structured and table inspection", async () => {
  const contextPolicy = {
    providerWindowTokens: 1000000,
    clientWindowTokens: 1000000,
    outputReserveTokens: 64000,
    thresholdTokens: 512000,
  };
  const contextStatus = {
    scopeId: "scope",
    effectiveInputTokens: 512000,
    inputCapacityTokens: 936000,
    limitingReason: "threshold",
    baseThresholdTokens: 512000,
    observedAt: "2026-10-12T12:00:00.000Z",
  };
  const result = await inspect({ profileId: "worker", contextPolicy, contextStatus });
  expect(result.schema.serialize?.(result.data[0]!)).toMatchObject({
    ProfileId: "worker",
    ContextPolicy: contextPolicy,
    ContextStatus: contextStatus,
  });
  expect(result.data).toEqual(
    expect.arrayContaining([
      { key: "ProfileId", value: "worker" },
      { key: "ContextPolicy", value: JSON.stringify(contextPolicy) },
      { key: "ContextStatus", value: JSON.stringify(contextStatus) },
    ]),
  );
});

it("omits scope fields for an agent without a context policy", async () => {
  const result = await inspect({});
  const serialized = result.schema.serialize?.(result.data[0]!);
  expect(serialized).not.toHaveProperty("ContextPolicy");
  expect(serialized).not.toHaveProperty("ContextStatus");
  expect(serialized).not.toHaveProperty("ProfileId");
  expect(result.data.some((row) => row.key === "ContextPolicy")).toBe(false);
});
