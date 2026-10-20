import { Command } from "commander";
import { afterEach, expect, it, vi } from "vitest";
import { AgentSnapshotPayloadSchema } from "@getpaseo/protocol/messages";
import { AgentMessageRejectedError, DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { AgentExecution } from "@getpaseo/protocol/agent-execution";
import { renderTable } from "../../output/table.js";
import { connectToDaemon } from "../../utils/client.js";
import { addSendOptions, runSendCommand } from "./send.js";

vi.mock("../../utils/client.js", () => ({ connectToDaemon: vi.fn() }));

const daemonTarget = { kind: "endpoint", host: "localhost:6768" } as const;

function recordingClient() {
  const client = new DaemonClient({ url: "ws://localhost:6768", clientId: "send-test" });
  const fetch = vi.spyOn(client, "fetchAgent").mockResolvedValue({
    agent: AgentSnapshotPayloadSchema.parse({
      id: "resolved-recipient",
      provider: "codex",
      cwd: "/repo",
      model: null,
      createdAt: "2026-10-15T00:00:00.000Z",
      updatedAt: "2026-10-15T00:00:00.000Z",
      lastUserMessageAt: null,
      status: "idle",
      currentModeId: null,
      availableModes: [],
      pendingPermissions: [],
      persistence: null,
      title: "Recipient",
      capabilities: {
        supportsStreaming: true,
        supportsSessionPersistence: true,
        supportsDynamicModes: false,
        supportsMcpServers: true,
        supportsReasoningStream: true,
        supportsToolInvocations: true,
      },
    }),
    project: null,
  });
  const send = vi.spyOn(client, "sendAgentMessage").mockResolvedValue({
    requestId: "request",
    agentId: "resolved-recipient",
    accepted: true,
    queued: true,
    error: null,
  });
  const execution = vi.spyOn(client, "getAgentExecution").mockResolvedValue(null);
  const wait = vi.spyOn(client, "waitForFinish").mockResolvedValue({
    requestId: "unrelated-turn",
    status: "idle",
    final: null,
    error: null,
    lastMessage: null,
  });
  const close = vi.spyOn(client, "close").mockResolvedValue();
  vi.mocked(connectToDaemon).mockResolvedValue(client);
  return { client, fetch, send, execution, wait, close };
}

function receipt(status: AgentExecution["status"]): AgentExecution {
  return {
    agentId: "resolved-recipient",
    executionId: "this-execution",
    provider: "codex",
    turnId: "this-turn",
    status,
    startedAt: "2026-10-15T00:00:00.000Z",
    updatedAt: "2026-10-15T00:00:00.000Z",
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

it("queues ordinary CLI sends and reports durable acceptance with a stable message ID", async () => {
  vi.stubEnv("PASEO_AGENT_ID", "");
  const client = recordingClient();
  const result = await runSendCommand(
    "recipient",
    "hello",
    { daemonTarget, wait: false },
    new Command(),
  );
  expect(client.send).toHaveBeenCalledWith("resolved-recipient", "hello", {
    images: undefined,
    sourceAgentId: undefined,
    activeTurnBehavior: "queue",
    messageId: expect.any(String),
  });
  expect(result.data).toEqual({
    agentId: "resolved-recipient",
    status: "queued",
    messageId: client.send.mock.calls[0]?.[2]?.messageId,
    message: "Message queued; not waiting for execution",
  });
  expect(client.wait).not.toHaveBeenCalled();
  expect(client.execution).not.toHaveBeenCalled();
  expect(client.close).toHaveBeenCalledOnce();
});

it("makes interruption explicit without coupling it to --no-wait", async () => {
  vi.stubEnv("PASEO_AGENT_ID", "sender");
  const client = recordingClient();
  client.send.mockResolvedValue({
    requestId: "request",
    agentId: "recipient",
    accepted: true,
    error: null,
  });
  const result = await runSendCommand(
    "recipient",
    "urgent",
    { daemonTarget, interrupt: true, wait: false },
    new Command(),
  );
  expect(client.send.mock.calls[0]?.[2]).toMatchObject({
    sourceAgentId: "sender",
    activeTurnBehavior: "interrupt",
  });
  expect(result.data.status).toBe("sent");
  expect(client.wait).not.toHaveBeenCalled();
});

it("waits for its own queued submission across an unrelated turn finishing", async () => {
  vi.useFakeTimers();
  const client = recordingClient();
  client.execution
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce(receipt("running"))
    .mockResolvedValueOnce(receipt("completed"));
  let finished = false;
  const pending = runSendCommand("recipient", "next", { daemonTarget }, new Command()).then(
    (result) => {
      finished = true;
      return result;
    },
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(finished).toBe(false);
  await vi.advanceTimersByTimeAsync(1000);
  expect(finished).toBe(false);
  await vi.advanceTimersByTimeAsync(1000);
  const result = await pending;
  const messageId = client.send.mock.calls[0]?.[2]?.messageId;
  expect(client.execution.mock.calls).toEqual(
    Array.from({ length: 3 }, () => [
      "resolved-recipient",
      { kind: "submission", clientMessageId: messageId },
    ]),
  );
  expect(client.wait).not.toHaveBeenCalled();
  expect(result.data).toMatchObject({
    status: "completed",
    messageId,
    executionId: "this-execution",
  });
});

it.each(["failed", "canceled", "unknown"] as const)(
  "does not report %s execution as completed",
  async (status) => {
    const client = recordingClient();
    client.execution.mockResolvedValue(receipt(status));
    const result = await runSendCommand("recipient", "next", { daemonTarget }, new Command());
    expect(result.data).toMatchObject({
      status: "error",
      executionId: "this-execution",
      message: `Message execution ${status}`,
    });
  },
);

it("times out while the exact submission remains pending instead of declaring idle success", async () => {
  vi.useFakeTimers();
  const client = recordingClient();
  const pending = runSendCommand("recipient", "next", { daemonTarget }, new Command());
  await vi.advanceTimersByTimeAsync(600000);
  expect((await pending).data).toMatchObject({ status: "timeout", messageId: expect.any(String) });
  expect(client.wait).not.toHaveBeenCalled();
});

it("accepts --interrupt with --no-wait and defaults to waiting", () => {
  const defaultCommand = addSendOptions(new Command());
  defaultCommand.parse(["recipient", "hello"], { from: "user" });
  expect(defaultCommand.opts().wait).toBe(true);
  const command = addSendOptions(new Command());
  command.parse(["recipient", "hello", "--interrupt", "--no-wait"], { from: "user" });
  expect(command.opts()).toMatchObject({ interrupt: true, wait: false });
});

it.each(["queue", "steer", "interrupt"] as const)(
  "honors explicit %s behavior without changing --no-wait",
  async (behavior) => {
    vi.stubEnv("PASEO_AGENT_ID", "sender");
    const client = recordingClient();
    const command = addSendOptions(new Command());
    command.parse(["recipient", "hello", "--behavior", behavior, "--no-wait"], { from: "user" });
    await runSendCommand("recipient", "hello", { daemonTarget, ...command.opts() }, command);
    expect(client.send.mock.calls[0]?.[2]).toMatchObject({
      activeTurnBehavior: behavior,
      sourceAgentId: "sender",
    });
    expect(client.wait).not.toHaveBeenCalled();
    expect(client.execution).not.toHaveBeenCalled();
  },
);

it("rejects conflicting delivery options before submitting a message", () => {
  const command = addSendOptions(new Command())
    .exitOverride()
    .configureOutput({ writeErr: () => {} });
  expect(() =>
    command.parse(["recipient", "hello", "--interrupt", "--behavior", "steer"], { from: "user" }),
  ).toThrow("cannot be used with option");
});

it("preserves durable acceptance when the connection drops while observing execution", async () => {
  const client = recordingClient();
  client.execution.mockRejectedValue(
    Object.assign(new Error("connection closed"), { code: "ECONNRESET" }),
  );
  const result = await runSendCommand("recipient", "next", { daemonTarget }, new Command());
  expect(result.data).toEqual({
    agentId: "resolved-recipient",
    messageId: client.send.mock.calls[0]?.[2]?.messageId,
    status: "unknown",
    message: "Message accepted; completion could not be observed: connection closed",
  });
  expect(client.send).toHaveBeenCalledOnce();
  expect(client.wait).not.toHaveBeenCalled();
  expect(client.close).toHaveBeenCalledOnce();
});

it("retains the exact submission identity when durable enqueue succeeds but its acknowledgement is lost", async () => {
  const client = recordingClient();
  const persisted: Array<{ agentId: string; messageId: string | undefined }> = [];
  client.send.mockImplementation(async (agentId, _text, options) => {
    persisted.push({ agentId, messageId: options?.messageId });
    throw Object.assign(new Error("acknowledgement timed out"), { code: "DAEMON_REQUEST_TIMEOUT" });
  });
  const result = await runSendCommand("recipient-prefix", "next", { daemonTarget }, new Command());
  expect(client.fetch).toHaveBeenCalledWith({ agentId: "recipient-prefix" });
  expect(persisted).toEqual([{ agentId: "resolved-recipient", messageId: expect.any(String) }]);
  expect(result.data).toMatchObject({
    agentId: "resolved-recipient",
    messageId: persisted[0]?.messageId,
    status: "unknown",
  });
  expect(result.data.message).toContain("acceptance is unknown");
  const output = renderTable(result, {
    format: "table",
    quiet: false,
    noHeaders: false,
    noColor: true,
  });
  expect(output).toContain(persisted[0]?.messageId);
  expect(output).toContain("resolved-recipient");
  expect(client.send).toHaveBeenCalledOnce();
  expect(client.execution).not.toHaveBeenCalled();
  expect(client.close).toHaveBeenCalledOnce();
});

it("distinguishes explicit rejection from uncertain submission and preserves its attempted identity", async () => {
  const client = recordingClient();
  client.send.mockRejectedValue(new AgentMessageRejectedError("Update the Paseo host"));
  const pending = runSendCommand("recipient", "next", { daemonTarget }, new Command());
  await expect(pending).rejects.toMatchObject({
    code: "SEND_REJECTED",
    message: "Update the Paseo host",
    details: { agentId: "resolved-recipient", messageId: expect.any(String) },
  });
  expect(client.send).toHaveBeenCalledOnce();
  expect(client.close).toHaveBeenCalledOnce();
});
