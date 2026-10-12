import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  AgentExecutionSchema,
  type AgentExecution,
  type AgentExecutionQuery,
} from "@getpaseo/protocol/agent-execution";
import { writeJsonFileAtomic } from "../atomic-file.js";

type ExecutionUpdate = Pick<AgentExecution, "status"> &
  Partial<Pick<AgentExecution, "providerSessionId" | "turnId" | "errorCode">>;

/** Execution evidence only. Keyed admission and project acceptance have separate owners. */
export class AgentExecutionStore {
  private readonly records = new Map<string, AgentExecution>();
  private readonly submissions = new Map<string, string | null>();
  private initialized: Promise<void> | undefined;
  private mutation: Promise<void> = Promise.resolve();

  constructor(private readonly directory: string) {}

  initialize(): Promise<void> {
    this.initialized ??= this.load();
    return this.initialized;
  }

  async get(agentId: string, query: AgentExecutionQuery): Promise<AgentExecution | null> {
    await this.initialize();
    await this.mutation;
    if (query.kind === "execution") {
      const record = this.records.get(key(agentId, query.executionId));
      return record ? { ...record } : null;
    }
    // A submission has one primary execution. Steers deliberately have no mapping here.
    const executionKey = this.submissions.get(key(agentId, query.clientMessageId));
    if (executionKey === null) throw new Error("agent_execution_submission_ambiguous");
    const record = executionKey ? this.records.get(executionKey) : undefined;
    return record ? { ...record } : null;
  }

  create(record: AgentExecution): Promise<void> {
    return this.mutate(async () => {
      const parsed = AgentExecutionSchema.parse(record);
      const id = key(parsed.agentId, parsed.executionId);
      if (this.records.has(id)) throw new Error("agent_execution_already_exists");
      await this.write(parsed);
      this.index(parsed);
    });
  }

  update(agentId: string, executionId: string, update: ExecutionUpdate): Promise<void> {
    return this.mutate(async () => {
      const id = key(agentId, executionId);
      const previous = this.records.get(id);
      if (!previous) throw new Error("agent_execution_not_found");
      // Late callbacks cannot rewrite a settled execution, including uncertain acceptance.
      if (previous.status !== "starting" && previous.status !== "running") return;
      const updatedAt = new Date().toISOString();
      const settled = ["completed", "failed", "canceled"].includes(update.status);
      const record = AgentExecutionSchema.parse({
        ...previous,
        ...update,
        updatedAt,
        ...(settled ? { finishedAt: updatedAt } : {}),
      });
      await this.write(record);
      this.records.set(id, record);
    });
  }

  private mutate(operation: () => Promise<void>): Promise<void> {
    const result = this.mutation.then(async () => {
      await this.initialize();
      return operation();
    });
    this.mutation = result.catch(() => undefined);
    return result;
  }

  private async load(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      let record = AgentExecutionSchema.parse(
        JSON.parse(await readFile(path.join(this.directory, name), "utf8")),
      );
      if (name !== `${key(record.agentId, record.executionId)}.json`) {
        throw new Error("agent_execution_record_identity_mismatch");
      }
      // A previous daemon's running snapshot cannot prove how provider execution ended.
      if (record.status === "starting" || record.status === "running") {
        const updatedAt = new Date().toISOString();
        record = {
          ...record,
          status: "unknown",
          errorCode: "daemon_restarted",
          updatedAt,
        };
        await this.write(record);
      }
      this.index(record);
    }
  }

  private index(record: AgentExecution): void {
    const executionKey = key(record.agentId, record.executionId);
    this.records.set(executionKey, record);
    if (!record.clientMessageId) return;
    const submissionKey = key(record.agentId, record.clientMessageId);
    const existing = this.submissions.get(submissionKey);
    this.submissions.set(
      submissionKey,
      existing === undefined || existing === executionKey ? executionKey : null,
    );
  }

  private write(record: AgentExecution): Promise<void> {
    return writeJsonFileAtomic(
      path.join(this.directory, `${key(record.agentId, record.executionId)}.json`),
      record,
    );
  }
}

function key(agentId: string, executionId: string): string {
  return createHash("sha256")
    .update(JSON.stringify([agentId, executionId]))
    .digest("hex");
}
