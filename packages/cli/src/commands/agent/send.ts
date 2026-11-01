import { AgentMessageRejectedError } from "@getpaseo/client/internal/daemon-client";
import { randomUUID } from "node:crypto";
import type { AgentExecution } from "@getpaseo/protocol/agent-execution";
import type { ActiveTurnBehavior } from "@getpaseo/protocol/messages";
import { type Command, Option } from "commander";
import { collectMultiple } from "../../utils/command-options.js";
import { connectToDaemon } from "../../utils/client.js";
import type {
  CommandOptions,
  SingleResult,
  OutputSchema,
  CommandError,
} from "../../output/index.js";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";

/** Result type for agent send command */
export interface AgentSendResult {
  agentId: string;
  status: "queued" | "sent" | "completed" | "timeout" | "permission" | "error" | "unknown";
  messageId?: string;
  executionId?: string;
  message: string;
}

/** Schema for agent send output */
export const agentSendSchema: OutputSchema<AgentSendResult> = {
  idField: "agentId",
  columns: [
    { header: "AGENT ID", field: "agentId", width: 12 },
    { header: "STATUS", field: "status", width: 12 },
    { header: "MESSAGE ID", field: "messageId" },
    { header: "MESSAGE", field: "message", width: 40 },
  ],
};

export interface AgentSendOptions extends CommandOptions {
  wait?: boolean;
  interrupt?: boolean;
  steer?: boolean;
  queue?: boolean;
  image?: string[];
  prompt?: string;
  promptFile?: string;
}

function resolveDeliveryBehavior(
  options: AgentSendOptions,
  sourceAgentId: string | undefined,
): ActiveTurnBehavior {
  if (options.queue) return "queue";
  if (options.interrupt) return "interrupt";
  if (options.steer) return "steer";
  return sourceAgentId ? "steer" : "interrupt";
}

export function addSendOptions(cmd: Command): Command {
  return cmd
    .description(
      "Send a message/task to an existing agent (agent messages steer; human messages interrupt)",
    )
    .argument("<id>", "Agent ID (or prefix)")
    .argument("[prompt]", "The message to send")
    .option("--prompt <text>", "Provide the message inline as a flag")
    .option("--prompt-file <path>", "Read the message from a UTF-8 text file")
    .option("--image <path>", "Attach image(s) to the message", collectMultiple, [])
    .option("--interrupt", "Interrupt the active turn (default for human messages)")
    .addOption(
      new Option("--steer", "Steer the active turn (default for agent messages)").conflicts([
        "interrupt",
        "queue",
      ]),
    )
    .addOption(
      new Option("--queue", "Queue until the recipient is available").conflicts([
        "interrupt",
        "steer",
      ]),
    )
    .option("--wait", "Wait for this message to finish", true)
    .option("--no-wait", "Return after acceptance without waiting for completion");
}

/**
 * Read image files and convert them to base64 data URIs
 */
async function readImageFiles(
  imagePaths: string[],
): Promise<Array<{ data: string; mimeType: string }>> {
  return Promise.all(
    imagePaths.map(async (path) => {
      try {
        const buffer = await readFile(path);
        const ext = extname(path).toLowerCase();

        let mimeType = "image/jpeg";
        switch (ext) {
          case ".png":
            mimeType = "image/png";
            break;
          case ".jpg":
          case ".jpeg":
            mimeType = "image/jpeg";
            break;
          case ".gif":
            mimeType = "image/gif";
            break;
          case ".webp":
            mimeType = "image/webp";
            break;
          default:
            mimeType = "image/jpeg";
        }

        return { data: buffer.toString("base64"), mimeType };
      } catch (err) {
        if (err && typeof err === "object" && "code" in err) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw {
          code: "IMAGE_READ_ERROR",
          message: `Failed to read image file: ${path}`,
          details: message,
        } satisfies CommandError;
      }
    }),
  );
}

async function resolvePromptInput(options: {
  promptArgument: string | undefined;
  promptOption: string | undefined;
  promptFile: string | undefined;
}): Promise<string> {
  const promptText = options.promptArgument?.trim();
  const promptOptionText = options.promptOption?.trim();
  const promptFilePath = options.promptFile?.trim();
  const providedSourceCount = [promptText, promptOptionText, promptFilePath].filter(Boolean).length;

  if (providedSourceCount > 1) {
    const error: CommandError = {
      code: "CONFLICTING_PROMPT_INPUT",
      message: "Provide exactly one of prompt argument, --prompt, or --prompt-file",
    };
    throw error;
  }

  if (promptText) {
    return options.promptArgument as string;
  }

  if (promptOptionText) {
    return options.promptOption as string;
  }

  if (!promptFilePath) {
    const error: CommandError = {
      code: "MISSING_PROMPT",
      message: "A prompt is required",
      details:
        "Usage: paseo agent send [options] <id> [prompt] | --prompt <text> | --prompt-file <path>",
    };
    throw error;
  }

  try {
    return await readFile(resolve(promptFilePath), "utf8");
  } catch (err) {
    if (err && typeof err === "object" && "code" in err) throw err;
    const message = err instanceof Error ? err.message : String(err);
    const error: CommandError = {
      code: "PROMPT_FILE_READ_ERROR",
      message: `Failed to read prompt file: ${promptFilePath}`,
      details: message,
    };
    throw error;
  }
}

type SendWaitState = Awaited<
  ReturnType<Awaited<ReturnType<typeof connectToDaemon>>["waitForFinish"]>
>;

function buildSendResult(
  agentIdArg: string,
  state: SendWaitState,
  activeTurnBehavior: ActiveTurnBehavior,
): AgentSendResult {
  const agentId = state.final?.id ?? agentIdArg;
  if (state.status === "timeout") {
    return { agentId, status: "timeout", message: "Timed out waiting for agent to finish" };
  }
  if (state.status === "permission") {
    return { agentId, status: "permission", message: "Agent is waiting for permission" };
  }
  if (state.status === "error") {
    return {
      agentId,
      status: "error",
      message: state.error ?? "Agent finished with error",
    };
  }
  if (activeTurnBehavior === "steer") {
    return {
      agentId,
      status: "sent",
      message:
        "Message accepted; recipient is idle. Completion of this steered message was not independently verified.",
    };
  }
  return { agentId, status: "completed", message: "Agent completed processing the message" };
}

// A queued send can outlive the current turn; only its submission receipt establishes completion.
async function waitForQueuedMessage(input: {
  client: Awaited<ReturnType<typeof connectToDaemon>>;
  agentId: string;
  messageId: string;
}): Promise<AgentSendResult> {
  const deadline = Date.now() + 600000;
  while (Date.now() < deadline) {
    const execution = await input.client.getAgentExecution(input.agentId, {
      kind: "submission",
      clientMessageId: input.messageId,
    });
    if (execution) {
      const result = queuedExecutionResult(execution, input.messageId);
      if (result) return result;
    }
    await new Promise((finishDelay) => setTimeout(finishDelay, 1000));
  }
  return {
    agentId: input.agentId,
    messageId: input.messageId,
    status: "timeout",
    message: "Timed out waiting for this message; it may still be queued or running",
  };
}

function queuedExecutionResult(
  execution: AgentExecution,
  messageId: string,
): AgentSendResult | null {
  if (execution.status === "starting" || execution.status === "running") return null;
  const completed = execution.status === "completed";
  return {
    agentId: execution.agentId,
    messageId,
    executionId: execution.executionId,
    status: completed ? "completed" : "error",
    message: completed
      ? "Agent completed processing this message"
      : `Message execution ${execution.status}${execution.errorCode ? `: ${execution.errorCode}` : ""}`,
  };
}

interface AcceptedSendInput {
  agentId: string;
  messageId: string;
  queued?: boolean;
}

function buildAcceptedSendResult(input: AcceptedSendInput): AgentSendResult {
  return {
    agentId: input.agentId,
    messageId: input.messageId,
    status: input.queued ? "queued" : "sent",
    message: input.queued
      ? "Message queued; not waiting for execution"
      : "Message accepted; not waiting for completion",
  };
}

export async function runSendCommand(
  agentIdArg: string,
  prompt: string | undefined,
  options: AgentSendOptions,
  _command: Command,
): Promise<SingleResult<AgentSendResult>> {
  // Validate arguments
  if (!agentIdArg || agentIdArg.trim().length === 0) {
    const error: CommandError = {
      code: "MISSING_AGENT_ID",
      message: "Agent ID is required",
      details: "Usage: paseo agent send [options] <id> [prompt]",
    };
    throw error;
  }

  const promptInput = await resolvePromptInput({
    promptArgument: prompt,
    promptOption: options.prompt,
    promptFile: options.promptFile,
  });

  const client = await connectToDaemon({ target: options.daemonTarget });
  let attempted: { agentId: string; messageId: string } | null = null;
  let accepted: { agentId: string; messageId: string } | null = null;

  try {
    // Read image files if provided
    const images =
      options.image && options.image.length > 0 ? await readImageFiles(options.image) : undefined;

    const recipient = await client.fetchAgent({ agentId: agentIdArg });
    if (!recipient) throw new AgentMessageRejectedError(`Agent not found: ${agentIdArg}`);
    const messageId = randomUUID();
    attempted = { agentId: recipient.agent.id, messageId };
    const sourceAgentId = process.env.PASEO_AGENT_ID?.trim() || undefined;
    const activeTurnBehavior = resolveDeliveryBehavior(options, sourceAgentId);
    const acknowledgement = await client.sendAgentMessage(recipient.agent.id, promptInput, {
      images,
      messageId,
      activeTurnBehavior,
      sourceAgentId,
    });
    accepted = { agentId: acknowledgement.agentId, messageId };

    // If --no-wait, return immediately
    if (options.wait === false) {
      return {
        type: "single",
        data: buildAcceptedSendResult({ ...acknowledgement, messageId }),
        schema: agentSendSchema,
      };
    }

    let result: AgentSendResult;
    if (activeTurnBehavior === "queue") {
      result = await waitForQueuedMessage({ client, agentId: acknowledgement.agentId, messageId });
    } else {
      const state = await client.waitForFinish(acknowledgement.agentId, 600000);
      result = {
        ...buildSendResult(acknowledgement.agentId, state, activeTurnBehavior),
        messageId,
      };
    }
    return {
      type: "single",
      data: result,
      schema: agentSendSchema,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Durable acceptance survives losing the connection used to observe its execution.
    if (accepted) {
      return {
        type: "single",
        data: {
          ...accepted,
          status: "unknown",
          message: `Message accepted; completion could not be observed: ${message}`,
        },
        schema: agentSendSchema,
      };
    }

    if (err instanceof AgentMessageRejectedError) {
      throw {
        code: "SEND_REJECTED",
        message: err.message,
        ...(attempted ? { details: attempted } : {}),
      } satisfies CommandError;
    }
    // A missing acknowledgement cannot distinguish a rejected send from a persisted queue entry.
    if (attempted) {
      return {
        type: "single",
        data: {
          ...attempted,
          status: "unknown",
          message: `Submission acknowledgement was lost; acceptance is unknown: ${message}. Query this message ID before taking further action.`,
        },
        schema: agentSendSchema,
      };
    }

    // Re-throw CommandError as-is
    if (err && typeof err === "object" && "code" in err) {
      throw err;
    }

    const error: CommandError = {
      code: "SEND_FAILED",
      message: `Failed to send message: ${message}`,
    };
    throw error;
  } finally {
    await client.close().catch(() => {});
  }
}
