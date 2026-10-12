import type { Command } from "commander";
import type { AgentExecution, AgentExecutionQuery } from "@getpaseo/protocol/agent-execution";
import { connectToDaemon } from "../../utils/client.js";
import type { CommandError, CommandOptions, ListResult, OutputSchema } from "../../output/index.js";

interface AgentExecutionOptions extends CommandOptions {
  executionId?: string;
  clientMessageId?: string;
}

const executionSchema: OutputSchema<AgentExecution> = {
  idField: "executionId",
  columns: [
    { header: "EXECUTION", field: "executionId" },
    { header: "AGENT", field: "agentId" },
    { header: "STATUS", field: "status" },
    { header: "TURN", field: "turnId" },
    { header: "UPDATED", field: "updatedAt" },
  ],
};

export function addExecutionOptions(cmd: Command): Command {
  return cmd
    .description("Read one durable execution record; an empty result means no record")
    .argument("<agent-id>", "Exact agent ID")
    .option("--execution-id <id>", "Exact execution ID")
    .option("--client-message-id <id>", "Exact submitted message ID");
}

export async function runExecutionCommand(
  agentId: string,
  options: AgentExecutionOptions,
  _command: Command,
): Promise<ListResult<AgentExecution>> {
  const executionId = options.executionId?.trim();
  const clientMessageId = options.clientMessageId?.trim();
  let query: AgentExecutionQuery;
  if (executionId && !clientMessageId) {
    query = { kind: "execution", executionId };
  } else if (clientMessageId && !executionId) {
    query = { kind: "submission", clientMessageId };
  } else {
    throw {
      code: "INVALID_EXECUTION_QUERY",
      message: "Supply exactly one of --execution-id or --client-message-id.",
    } satisfies CommandError;
  }

  const client = await connectToDaemon({ target: options.daemonTarget });
  try {
    const execution = await client.getAgentExecution(agentId, query);
    return { type: "list", data: execution ? [execution] : [], schema: executionSchema };
  } finally {
    await client.close().catch(() => undefined);
  }
}
