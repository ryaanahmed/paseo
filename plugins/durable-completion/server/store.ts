import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { WatchInput, WatchRecord, type Watch, type WatchRequest } from "../shared/contracts.js";

export class CompletionStore {
  private readonly records = new Map<string, Watch>();
  private loaded: Promise<void> | undefined;

  constructor(private readonly directory: string) {}

  async initialize(): Promise<void> {
    this.loaded ??= this.load();
    await this.loaded;
  }

  get(id: string): Watch | null {
    return this.records.get(id) ?? null;
  }

  pending(): Watch[] {
    return [...this.records.values()].filter(
      (record) => record.state === "pending" || record.state === "delivering",
    );
  }

  async watch(input: WatchRequest): Promise<Watch> {
    const request = WatchInput.parse(input);
    if (request.agentId === request.recipientId) throw new Error("completion_self_notification");
    const previous = this.get(request.id);
    if (previous) {
      if (JSON.stringify(WatchInput.parse(previous)) !== JSON.stringify(request)) {
        throw new Error("completion_watch_conflict");
      }
      return previous;
    }
    if (this.pending().length >= 256) throw new Error("completion_watch_capacity");
    return await this.save({
      ...request,
      deliveryId: `completion-${digest(JSON.stringify([this.directory, request.id]))}`,
      state: "pending",
    });
  }

  async save(record: Watch): Promise<Watch> {
    const parsed = WatchRecord.parse(record);
    const file = path.join(this.directory, `${digest(record.id)}.json`);
    const temporary = `${file}.${randomUUID()}.tmp`;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await writeFile(temporary, `${JSON.stringify(parsed)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, file);
    this.records.set(parsed.id, parsed);
    return parsed;
  }

  private async load(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    for (const name of await readdir(this.directory)) {
      if (!name.endsWith(".json")) continue;
      const record = WatchRecord.parse(
        JSON.parse(await readFile(path.join(this.directory, name), "utf8")),
      );
      if (name !== `${digest(record.id)}.json`)
        throw new Error("completion_record_identity_mismatch");
      this.records.set(record.id, record);
    }
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
