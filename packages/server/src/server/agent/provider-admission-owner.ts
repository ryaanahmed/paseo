import { spawn } from "node:child_process";
import path from "node:path";
import { z } from "zod";
import type { ProviderAdmissionConfig } from "./provider-admission.js";

const identitySchema = z.object({
  pid: z.number().int().positive(),
  startTicks: z.number().int().positive(),
  executablePath: z.string().startsWith("/"),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
const registrationSchema = z.object({
  status: z.literal("registered"),
  registrationPath: z.string(),
  registration: z.object({
    schema: z.literal(1),
    executionRoot: z.string().startsWith("/"),
    linuxBootId: z.string().uuid(),
    consumerEpoch: z.string().regex(/^[0-9a-f]{32}$/),
    coverageManifestDigest: z.string().regex(/^[0-9a-f]{64}$/),
    owner: identitySchema,
    parent: identitySchema,
    roles: z.array(z.enum(["provider-launch", "utility-launch", "native-queue"])),
  }),
});

export interface AdmissionOwnerConfig {
  helper: string;
  registrationPath: string;
  epoch: string;
  manifest: string;
  parentPid: number;
  executionRoot: string;
}
export interface AdmissionOwnerHandle {
  registered: Promise<string>;
  closed: Promise<void>;
  stop(): void;
}
export interface AdmissionOwnerPorts {
  start(config: AdmissionOwnerConfig): AdmissionOwnerHandle;
}

function startOwner(config: AdmissionOwnerConfig): AdmissionOwnerHandle {
  const child = spawn(
    config.helper,
    [
      "memory",
      "owner",
      "--registration",
      config.registrationPath,
      "--epoch",
      config.epoch,
      "--coverage-digest",
      config.manifest,
      "--execution-root",
      config.executionRoot,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const registered = new Promise<string>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => {
      child.stdin.end();
      reject(new Error("Provider admission owner registration timed out"));
    }, 5_000);
    child.stdout.on("data", (data: Buffer) => {
      output += data.toString();
      if (output.length > 64 * 1024) {
        clearTimeout(timer);
        child.stdin.end();
        reject(new Error("Provider admission owner response exceeded limit"));
      } else if (output.includes("\n")) {
        clearTimeout(timer);
        resolve(output.slice(0, output.indexOf("\n")));
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("Provider admission owner exited before registration"));
    });
  });
  // Drain diagnostics without letting a full stderr pipe stall the local owner.
  child.stderr.resume();
  child.stdin.on("error", () => undefined);
  const closed = new Promise<void>((resolve) => {
    child.once("error", () => resolve());
    child.once("exit", () => resolve());
  });
  return { registered, closed, stop: () => child.stdin.end() };
}

export class ProviderAdmissionOwner {
  private handle: AdmissionOwnerHandle | null = null;
  private ready = false;
  private generation = 0;

  constructor(private readonly ports: AdmissionOwnerPorts = { start: startOwner }) {}

  isReady(): boolean {
    return this.ready;
  }

  async start(config: AdmissionOwnerConfig): Promise<void> {
    this.stop();
    const generation = this.generation;
    const handle = this.ports.start(config);
    this.handle = handle;
    let closed = false;
    void handle.closed.then(() => {
      closed = true;
      if (generation === this.generation) this.ready = false;
      return undefined;
    });
    try {
      const result = registrationSchema.parse(JSON.parse(await handle.registered));
      const record = result.registration;
      if (
        closed ||
        generation !== this.generation ||
        result.registrationPath !== config.registrationPath ||
        record.consumerEpoch !== config.epoch ||
        record.coverageManifestDigest !== config.manifest ||
        record.parent.pid !== config.parentPid ||
        record.executionRoot !== config.executionRoot ||
        !(["provider-launch", "utility-launch", "native-queue"] as const).every((role) =>
          record.roles.includes(role),
        )
      ) {
        throw new Error("Provider admission owner identity or coverage does not match");
      }
      this.ready = true;
    } catch (error) {
      handle.stop();
      throw error;
    }
  }

  stop(): void {
    this.generation++;
    this.ready = false;
    this.handle?.stop();
    this.handle = null;
  }
}

export const providerAdmissionOwner = new ProviderAdmissionOwner();

export function admissionOwnerConfig(
  config: ProviderAdmissionConfig,
  executionRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
): AdmissionOwnerConfig {
  const registrationPath = environment.PASEO_PROVIDER_ADMISSION_REGISTRATION;
  const epoch = environment.PASEO_PROVIDER_ADMISSION_EPOCH;
  const manifest = environment.PASEO_PROVIDER_ADMISSION_MANIFEST;
  if (
    !path.isAbsolute(executionRoot) ||
    !registrationPath ||
    !path.isAbsolute(registrationPath) ||
    !epoch ||
    !/^[0-9a-f]{32}$/.test(epoch) ||
    !manifest ||
    !/^[0-9a-f]{64}$/.test(manifest)
  ) {
    throw new Error("Required provider admission owner configuration is missing");
  }
  return {
    helper: config.helper,
    registrationPath,
    epoch,
    manifest,
    parentPid: process.pid,
    executionRoot,
  };
}
