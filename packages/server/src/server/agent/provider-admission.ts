import { providerAdmissionOwner } from "./provider-admission-owner.js";
import { execFile, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { spawnProcess, execCommand, type SpawnProcessOptions } from "../../utils/spawn.js";

export class ProviderAdmissionBlocked extends Error {
  constructor(readonly reason: string) {
    super(`Provider launch is waiting for host admission: ${reason}`);
    this.name = "ProviderAdmissionBlocked";
  }
}

export interface ProviderAdmissionConfig {
  helper: string;
  bytes: number;
}

export interface ProviderAdmissionPorts {
  reserve(config: ProviderAdmissionConfig, runtimeId: string): Promise<string>;
  cancel(config: ProviderAdmissionConfig, runtimeId: string): Promise<void>;
  spawn(command: string, args: string[], options?: SpawnProcessOptions): ChildProcess;
  newRuntimeId(): string;
}

const reservationSchema = z.object({
  status: z.enum(["acquired", "blocked"]),
  id: z.string(),
  bytes: z.number().int().positive().optional(),
  reason: z.string().optional(),
});

// This is daemon configuration, never provider-supplied environment. Missing
// configuration in required mode is an admission failure, not an optional hook.
export function providerAdmissionConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ProviderAdmissionConfig | null {
  const mode = environment.PASEO_PROVIDER_ADMISSION;
  if (mode === undefined || mode === "disabled") return null;
  if (mode !== "required") throw new ProviderAdmissionBlocked("invalid admission mode");
  const helper = environment.PASEO_PROVIDER_ADMISSION_HELPER;
  const bytes = Number(environment.PASEO_PROVIDER_ADMISSION_BYTES);
  if (!helper || !path.isAbsolute(helper) || !Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new ProviderAdmissionBlocked("required admission helper or allowance is missing");
  }
  return { helper, bytes };
}

function reserve(config: ProviderAdmissionConfig, runtimeId: string): Promise<string> {
  if (!providerAdmissionOwner.isReady())
    return Promise.reject(new ProviderAdmissionBlocked("required admission owner is unavailable"));
  return new Promise((resolve, reject) => {
    execFile(
      config.helper,
      ["memory", "reserve", "--id", runtimeId, "--bytes", String(config.bytes)],
      { timeout: 5_000, maxBuffer: 64 * 1024, encoding: "utf8" },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}

function cancel(config: ProviderAdmissionConfig, runtimeId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      config.helper,
      ["memory", "release", "--id", runtimeId],
      { timeout: 5_000, maxBuffer: 64 * 1024, encoding: "utf8" },
      (commandError, stdout) => {
        if (commandError) {
          reject(commandError);
          return;
        }
        try {
          const response = z
            .object({ id: z.literal(runtimeId), status: z.literal("released") })
            .parse(JSON.parse(stdout));
          if (response.status === "released") resolve();
        } catch (error) {
          reject(error);
        }
      },
    );
  });
}

const productionPorts: ProviderAdmissionPorts = {
  reserve,
  cancel,
  spawn: spawnProcess,
  newRuntimeId: () => `paseo-runtime-${randomUUID()}`,
};

interface RuntimeCustody {
  helper: string;
  runtimeId: string;
}
const runtimeCustody = new WeakMap<ChildProcess, RuntimeCustody>();

export class ProviderLaunch {
  private consumed = false;

  constructor(
    private readonly config: ProviderAdmissionConfig | null,
    readonly runtimeId: string | null,
    private readonly ports: ProviderAdmissionPorts,
  ) {}

  async cancelUnused(): Promise<void> {
    if (this.consumed) return;
    this.consumed = true;
    if (this.config && this.runtimeId) await this.ports.cancel(this.config, this.runtimeId);
  }

  command(command: string, args: string[]): { command: string; args: string[] } {
    if (this.consumed) throw new ProviderAdmissionBlocked("runtime launch ticket already used");
    this.consumed = true;
    if (!this.config || !this.runtimeId) return { command, args };
    // The helper owns physical process-tree custody and release. A provider turn
    // ending or the wrapper's leader exiting is never release evidence here.
    return {
      command: this.config.helper,
      args: [
        "memory",
        "launch",
        "--id",
        this.runtimeId,
        "--bytes",
        String(this.config.bytes),
        "--",
        command,
        ...args,
      ],
    };
  }

  spawn(command: string, args: string[], options?: SpawnProcessOptions): ChildProcess {
    const launch = this.command(command, args);
    const child = this.ports.spawn(launch.command, launch.args, options);
    if (this.config && this.runtimeId)
      runtimeCustody.set(child, { helper: this.config.helper, runtimeId: this.runtimeId });
    return child;
  }
}

export async function prepareProviderLaunch(
  config = providerAdmissionConfig(),
  ports: ProviderAdmissionPorts = productionPorts,
): Promise<ProviderLaunch> {
  if (!config) return new ProviderLaunch(null, null, ports);
  const runtimeId = ports.newRuntimeId();
  try {
    const result = reservationSchema.parse(JSON.parse(await ports.reserve(config, runtimeId)));
    if (result.id !== runtimeId) throw new Error("reservation identity mismatch");
    if (result.status === "blocked")
      throw new ProviderAdmissionBlocked(result.reason ?? "capacity");
    if (result.bytes !== config.bytes) throw new Error("reservation allowance mismatch");
  } catch (error) {
    if (error instanceof ProviderAdmissionBlocked) throw error;
    // No launch ticket has escaped. The helper's cancellation tombstone fences
    // even a reserve that arrives after its timeout; failure retains uncertainty.
    const reason = error instanceof Error ? error.message : String(error);
    try {
      await ports.cancel(config, runtimeId);
    } catch {
      throw new ProviderAdmissionBlocked(
        `${reason}; no-start cancellation requires reconciliation (${runtimeId})`,
      );
    }
    throw new ProviderAdmissionBlocked(reason);
  }
  return new ProviderLaunch(config, runtimeId, ports);
}

export async function spawnProviderProcess(
  command: string,
  args: string[],
  options?: SpawnProcessOptions,
): Promise<ChildProcess> {
  const launch = await prepareProviderLaunch();
  return launch.spawn(command, args, options);
}

export async function execProviderCommand(
  command: string,
  args: string[],
  options?: Parameters<typeof execCommand>[2],
): ReturnType<typeof execCommand> {
  const ticket = await prepareProviderLaunch();
  const launch = ticket.command(command, args);
  return execCommand(launch.command, launch.args, options);
}

// ACP asks the daemon to spawn terminal siblings. They belong to the admitted
// runtime scope, so an active agent can finish while new runtime grants wait.
export function spawnProviderChild(
  parent: ChildProcess | null,
  command: string,
  args: string[],
  options?: SpawnProcessOptions,
): ChildProcess {
  const custody = parent ? runtimeCustody.get(parent) : undefined;
  if (custody) {
    return spawnProcess(
      custody.helper,
      ["memory", "child", "--id", custody.runtimeId, "--", command, ...args],
      options,
    );
  }
  if (providerAdmissionConfig())
    throw new ProviderAdmissionBlocked("runtime child has no admitted physical parent");
  return spawnProcess(command, args, options);
}

export function getProviderRuntimeId(child: ChildProcess | null): string | null {
  if (!child || child.exitCode !== null || child.signalCode !== null) return null;
  return runtimeCustody.get(child)?.runtimeId ?? null;
}

export async function permitNewProviderWorker(id: string): Promise<void> {
  const config = providerAdmissionConfig();
  if (!config) return;
  if (!providerAdmissionOwner.isReady())
    throw new ProviderAdmissionBlocked("required admission owner is unavailable");
  await new Promise<void>((resolve, reject) => {
    execFile(
      config.helper,
      ["memory", "permit-worker", "--id", id],
      { timeout: 5_000, maxBuffer: 64 * 1024, encoding: "utf8" },
      (commandError, stdout) => {
        try {
          if (commandError) throw commandError;
          const response = reservationSchema.parse(JSON.parse(stdout));
          if (response.id !== id || response.status !== "acquired")
            throw new Error(response.reason ?? "worker permit unavailable");
          resolve();
        } catch (error) {
          reject(
            new ProviderAdmissionBlocked(error instanceof Error ? error.message : String(error)),
          );
        }
      },
    );
  });
}

const executionUpdates = new Map<string, Promise<void>>();

export async function recordProviderExecution(
  operation: "execution-start" | "execution-end",
  agentId: string,
  executionId: string,
  runtimeId: string,
): Promise<void> {
  const config = providerAdmissionConfig();
  if (!config) return;
  const ownerRegistrationPath = process.env.PASEO_PROVIDER_ADMISSION_REGISTRATION;
  if (!ownerRegistrationPath || !path.isAbsolute(ownerRegistrationPath))
    throw new Error("Missing execution owner registration");
  const predecessor = executionUpdates.get(executionId) ?? Promise.resolve();
  const update = predecessor
    .catch(() => undefined)
    .then(
      () =>
        new Promise<void>((resolve, reject) => {
          const child = execFile(
            config.helper,
            ["finishing", operation],
            { timeout: 5_000, maxBuffer: 64 * 1024, encoding: "utf8" },
            (error) => {
              if (error) reject(error);
              else resolve();
            },
          );
          child.stdin?.on("error", () => undefined);
          child.stdin?.end(
            JSON.stringify({ schema: 1, agentId, executionId, runtimeId, ownerRegistrationPath }),
          );
        }),
    );
  executionUpdates.set(executionId, update);
  try {
    await update;
  } finally {
    if (executionUpdates.get(executionId) === update) executionUpdates.delete(executionId);
  }
}
