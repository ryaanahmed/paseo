import { createHash } from "node:crypto";
import { readdir, readFile, mkdir, chmod } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { AgentExecution } from "@getpaseo/protocol/agent-execution";
import type { AgentPromptInput, AgentRunOptions } from "./agent-sdk-types.js";
import { writeJsonFileAtomic } from "../atomic-file.js";

export interface AgentMessageMetadata {
  sessionMode?: string;
  notifyOnFinish?: { callerAgentId: string };
}

const recordSchema = z.object({
  agentId: z.string().min(1),
  clientMessageId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  prompt: z.union([z.string(), z.array(z.record(z.string(), z.unknown()))]),
  options: z.record(z.string(), z.unknown()),
  metadata: z.object({
    sessionMode: z.string().optional(),
    notifyOnFinish: z.object({ callerAgentId: z.string() }).optional(),
  }),
  state: z.enum(["pending", "dispatching", "settled", "unknown", "blocked"]),
  errorCode: z.string().optional(),
});

export type QueuedAgentMessage = Omit<z.infer<typeof recordSchema>, "prompt" | "options"> & {
  prompt: AgentPromptInput;
  options: AgentRunOptions;
};

export interface AgentMessageQueuePorts {
  onState?(record: QueuedAgentMessage): void;
  recipient(agentId: string): Promise<"idle" | "busy" | "unavailable">;
  execution(agentId: string, clientMessageId: string): Promise<AgentExecution | null>;
  // Preparation cannot submit a prompt. Its durable record remains pending even on restart.
  prepare?(record: QueuedAgentMessage): Promise<"ready" | "admission_blocked">;
  // Admission must synchronously reserve the recipient after its last busy/archive check.
  dispatch(
    record: QueuedAgentMessage,
  ): Promise<"started" | "busy" | "unavailable" | "admission_blocked">;
}

/** Durable FIFO admission. Uncertain submissions block their recipient rather than replaying. */
export class AgentMessageQueue {
  private readonly records = new Map<string, QueuedAgentMessage>();
  private initialized?: Promise<void>;
  private mutation = Promise.resolve();
  private draining?: Promise<void>;
  private reconcileRequested = false;
  private nextSequence = 0;
  private stopped = false;

  constructor(
    private readonly directory: string,
    private readonly ports: AgentMessageQueuePorts,
  ) {}

  initialize(): Promise<void> {
    this.initialized ??= this.load();
    return this.initialized;
  }

  hasUncertainAdmission(agentId: string): boolean {
    return [...this.records.values()].some(
      (record) =>
        record.agentId === agentId &&
        (record.state === "dispatching" || record.state === "unknown"),
    );
  }

  async enqueue(input: {
    agentId: string;
    prompt: AgentPromptInput;
    options: AgentRunOptions & { clientMessageId: string };
    metadata?: AgentMessageMetadata;
  }): Promise<void> {
    await this.initialize();
    if (this.stopped) throw new Error("agent_message_queue_stopped");
    await this.exclusive(async () => {
      const id = key(input.agentId, input.options.clientMessageId);
      const existing = this.records.get(id);
      const content = {
        prompt: input.prompt,
        options: input.options,
        metadata: input.metadata ?? {},
      };
      if (existing) {
        if (
          canonicalJSON({
            prompt: existing.prompt,
            options: existing.options,
            metadata: existing.metadata,
          }) !== canonicalJSON(content)
        ) {
          throw new Error("agent_message_conflict");
        }
        return;
      }
      if ((await this.ports.recipient(input.agentId)) === "unavailable")
        throw new Error("agent_archived");
      const execution = await this.ports.execution(input.agentId, input.options.clientMessageId);
      let state: QueuedAgentMessage["state"] = "pending";
      if (execution) state = execution.status === "unknown" ? "unknown" : "dispatching";
      const record: QueuedAgentMessage = {
        agentId: input.agentId,
        clientMessageId: input.options.clientMessageId,
        sequence: this.nextSequence++,
        ...content,
        state,
      };
      await this.save(record);
    });
  }

  async get(agentId: string, clientMessageId: string): Promise<QueuedAgentMessage | null> {
    await this.initialize();
    await this.mutation;
    const record = this.records.get(key(agentId, clientMessageId));
    return record ? structuredClone(record) : null;
  }

  reconcile(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.reconcileRequested = true;
    this.draining ??= (async () => {
      do {
        this.reconcileRequested = false;
        await this.drain();
      } while (this.reconcileRequested && !this.stopped);
    })().finally(() => {
      this.draining = undefined;
    });
    return this.draining;
  }

  stop(): void {
    this.stopped = true;
  }

  async flush(): Promise<void> {
    await this.draining;
    await this.mutation;
  }

  private async drain(): Promise<void> {
    await this.initialize();
    const recipients = new Set([...this.records.values()].map((record) => record.agentId));
    // One recipient's running turn never holds up another recipient's admission.
    const results = await Promise.allSettled(
      [...recipients].map((agentId) => this.drainRecipient(agentId)),
    );
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }

  private async drainRecipient(agentId: string): Promise<void> {
    const ordered = [...this.records.values()]
      .filter((record) => record.agentId === agentId && record.state !== "settled")
      .sort((left, right) => left.sequence - right.sequence);
    for (const original of ordered) {
      if (this.stopped) return;
      let record = this.records.get(key(agentId, original.clientMessageId))!;
      if (record.state === "blocked") return;
      const execution = await this.ports.execution(agentId, record.clientMessageId);
      if (execution) {
        if (execution.status === "starting" || execution.status === "running") return;
        if (execution.status === "unknown") {
          if (record.state !== "unknown") {
            await this.exclusive(() =>
              this.save({ ...record, state: "unknown", errorCode: "execution_unknown" }),
            );
          }
          return;
        }
        await this.exclusive(() => this.save({ ...record, state: "settled" }));
        continue;
      }
      if (record.state === "dispatching" || record.state === "unknown") return;
      const recipient = await this.ports.recipient(agentId);
      if (recipient === "busy") return;
      if (recipient === "unavailable") {
        await this.exclusive(() =>
          this.save({ ...record, state: "blocked", errorCode: "recipient_unavailable" }),
        );
        return;
      }
      if (this.ports.prepare && (await this.ports.prepare(record)) === "admission_blocked") {
        await this.exclusive(() =>
          this.save({ ...record, state: "pending", errorCode: "provider_admission_blocked" }),
        );
        return;
      }
      record = { ...record, state: "dispatching", errorCode: undefined };
      await this.exclusive(() => this.save(record));
      if (this.stopped) {
        await this.exclusive(() => this.save({ ...record, state: "pending" }));
        return;
      }
      try {
        const admission = await this.ports.dispatch(record);
        if (admission !== "started") {
          await this.exclusive(() =>
            this.save({
              ...record,
              state: admission === "unavailable" ? "blocked" : "pending",
              errorCode: {
                admission_blocked: "provider_admission_blocked",
                busy: "recipient_busy",
                unavailable: "recipient_unavailable",
              }[admission],
            }),
          );
        }
      } catch {
        // Even a missing execution receipt cannot prove that a provider rejected the prompt.
        await this.exclusive(() =>
          this.save({ ...record, state: "unknown", errorCode: "admission_unknown" }),
        );
      }
      return;
    }
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const work = this.mutation.then(operation);
    this.mutation = work.then(
      () => undefined,
      () => undefined,
    );
    return work;
  }

  private async save(record: QueuedAgentMessage): Promise<void> {
    const parsed = recordSchema.parse(record) as QueuedAgentMessage;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const file = path.join(this.directory, `${key(record.agentId, record.clientMessageId)}.json`);
    await writeJsonFileAtomic(file, parsed);
    await chmod(file, 0o600);
    this.records.set(key(record.agentId, record.clientMessageId), parsed);
    this.ports.onState?.(parsed);
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
      let record = recordSchema.parse(
        JSON.parse(await readFile(path.join(this.directory, name), "utf8")),
      ) as QueuedAgentMessage;
      if (name !== `${key(record.agentId, record.clientMessageId)}.json`)
        throw new Error("agent_message_record_identity_mismatch");
      this.nextSequence = Math.max(this.nextSequence, record.sequence + 1);
      if (record.state === "dispatching") {
        const execution = await this.ports.execution(record.agentId, record.clientMessageId);
        record =
          execution && ["completed", "failed", "canceled"].includes(execution.status)
            ? { ...record, state: "settled" }
            : { ...record, state: "unknown", errorCode: "daemon_restarted_during_admission" };
        await this.save(record);
      } else {
        this.records.set(key(record.agentId, record.clientMessageId), record);
      }
    }
  }
}

function key(agentId: string, clientMessageId: string): string {
  return createHash("sha256")
    .update(JSON.stringify([agentId, clientMessageId]))
    .digest("hex");
}

function canonicalJSON(value: unknown): string {
  // Normalize the persisted JSON representation before sorting object keys for identity checks.
  const normalized: unknown = JSON.parse(JSON.stringify(value));
  return JSON.stringify(normalized, (_key, item) => {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((propertyName) => [propertyName, item[propertyName]]),
      );
    }
    return item;
  });
}
