import { Command } from "commander";
import { expect, test } from "vitest";
import { addExecutionOptions, runExecutionCommand } from "./execution.js";

test.each([
  {},
  { executionId: "execution-1", clientMessageId: "message-1" },
  { executionId: "  " },
])(
  "execution query refuses missing or conflicting identities before connecting: %j",
  async (options) => {
    const command = addExecutionOptions(new Command("execution"));
    await expect(runExecutionCommand("agent-1", options, command)).rejects.toMatchObject({
      code: "INVALID_EXECUTION_QUERY",
    });
  },
);
