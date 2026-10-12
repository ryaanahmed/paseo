import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { ContextPolicySchema, type ContextPolicy } from "@getpaseo/protocol/agent-context-policy";
import type { CodexCustomProviderConfig } from "./agent-sdk-types.js";

const execFileAsync = promisify(execFile);
const PolicySchema = ContextPolicySchema;
export type GobstopperContextPolicy = ContextPolicy;

const StatusSchema = z.object({
  scope_id: z.string().regex(/^[0-9a-f]{64}$/),
  effective_input_tokens: z.number().int().nonnegative(),
  input_capacity_tokens: z.number().int().nonnegative().nullable(),
  limiting_reason: z.string(),
  configured_provider_window: z.number().int().nullable(),
  configured_client_window: z.number().int().nullable(),
  output_reserve_tokens: z.number().int(),
  base_threshold_tokens: z.number().int(),
  scope_threshold_tokens: z.number().int().nullable(),
});

const BindingFields = {
  agentId: z.string(),
  provider: z.enum(["claude", "codex"]),
  policy: PolicySchema,
  proxyUrl: z.string(),
  storeIdentity: z.string(),
};
const BindingSchema = z.discriminatedUnion("state", [
  z.object({ ...BindingFields, state: z.literal("creating") }),
  z.object({
    ...BindingFields,
    state: z.literal("ready"),
    scope: z.string().regex(/^[0-9a-f]{64}$/),
  }),
]);
type Binding = z.infer<typeof BindingSchema>;
type ReadyBinding = Extract<Binding, { state: "ready" }>;

export interface GobstopperContextOptions {
  stateDirectory: string;
  executable?: string;
  proxyUrl?: string;
  commandEnv?: NodeJS.ProcessEnv;
}

export interface PrepareGobstopperContext {
  agentId: string;
  provider: string;
  policy: GobstopperContextPolicy;
  env: NodeJS.ProcessEnv;
  requireExisting?: boolean;
}

export interface GobstopperContextSnapshot {
  scopeId: string;
  effectiveInputTokens: number;
  inputCapacityTokens: number | null;
  limitingReason: string;
  baseThresholdTokens: number;
  observedAt: string;
}

export interface PreparedGobstopperContext {
  env: Record<string, string>;
  codexConfig?: CodexCustomProviderConfig;
  snapshot: GobstopperContextSnapshot;
}

export class GobstopperContextError extends Error {
  constructor(public readonly code: string) {
    super(`Gobstopper context policy could not be applied (${code}); no session was opened.`);
    this.name = "GobstopperContextError";
  }
}

// A daemon owns the scope; provider processes receive only their own capability.
export class GobstopperContextManager {
  private readonly executable: string;
  private readonly proxyUrl: string;
  private readonly commandEnv: NodeJS.ProcessEnv;
  private readonly storeIdentity: string;
  private readonly operations = new Map<string, Promise<unknown>>();

  constructor(private readonly options: GobstopperContextOptions) {
    this.executable = options.executable ?? "gobstopper";
    const proxy = new URL(options.proxyUrl ?? "http://127.0.0.1:8260");
    const local = ["127.0.0.1", "localhost", "[::1]"].includes(proxy.hostname);
    if (
      !local ||
      proxy.protocol !== "http:" ||
      proxy.username ||
      proxy.password ||
      proxy.pathname !== "/" ||
      proxy.search ||
      proxy.hash
    ) {
      throw new GobstopperContextError("invalid_proxy_url");
    }
    this.proxyUrl = proxy.origin;
    this.commandEnv = { ...process.env, ...options.commandEnv };
    delete this.commandEnv.GOBSTOPPER_SCOPE;
    this.storeIdentity = createHash("sha256")
      .update(
        JSON.stringify({
          home: this.commandEnv.HOME,
          userProfile: this.commandEnv.USERPROFILE,
          data: this.commandEnv.GOBSTOPPER_DATA_DIR,
          xdg: this.commandEnv.XDG_DATA_HOME,
        }),
      )
      .digest("hex");
  }

  prepare(input: PrepareGobstopperContext): Promise<PreparedGobstopperContext> {
    return this.serial(input.agentId, () => this.prepareOne(input));
  }

  // Call only after permanent deletion and confirmed provider-process shutdown.
  release(agentId: string): Promise<void> {
    return this.serial(agentId, async () => {
      const binding = await this.readBinding(agentId);
      if (!binding) return;
      if (binding.state !== "ready") throw new GobstopperContextError("creation_outcome_unknown");
      if (binding.agentId !== agentId || binding.proxyUrl !== this.proxyUrl) {
        throw new GobstopperContextError("binding_mismatch");
      }
      if (binding.storeIdentity !== this.storeIdentity)
        throw new GobstopperContextError("store_changed");
      await this.command(["context", "close"], binding.scope);
      await unlink(this.bindingPath(agentId));
    });
  }

  private async serial<T>(agentId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(agentId);
    const next = (previous ?? Promise.resolve()).catch(() => undefined).then(operation);
    this.operations.set(agentId, next);
    try {
      return await next;
    } finally {
      if (this.operations.get(agentId) === next) this.operations.delete(agentId);
    }
  }

  private async prepareOne(input: PrepareGobstopperContext): Promise<PreparedGobstopperContext> {
    const policy = validatePolicy(input);
    await this.checkProxy();
    await this.prepareDirectory();

    let binding = await this.readBinding(input.agentId);
    if (!binding) {
      if (input.requireExisting) throw new GobstopperContextError("binding_missing");
      binding = await this.createBinding(input, policy);
    }
    if (binding.state !== "ready") throw new GobstopperContextError("creation_outcome_unknown");
    const samePolicy = Object.keys(policy).every(
      (key) => Reflect.get(policy, key) === Reflect.get(binding.policy, key),
    );
    if (
      binding.agentId !== input.agentId ||
      binding.provider !== input.provider ||
      !samePolicy ||
      binding.proxyUrl !== this.proxyUrl ||
      binding.storeIdentity !== this.storeIdentity
    ) {
      throw new GobstopperContextError("binding_mismatch");
    }

    const result = await this.command(["context", "status", "--json"], binding.scope);
    const status = StatusSchema.safeParse(result);
    if (!status.success) throw new GobstopperContextError("invalid_scope_status");
    const actual = status.data;
    const scopeId = createHash("sha256").update(binding.scope).digest("hex");
    if (
      actual.scope_id !== scopeId ||
      actual.scope_threshold_tokens !== policy.thresholdTokens ||
      actual.configured_provider_window !== policy.providerWindowTokens ||
      actual.configured_client_window !== policy.clientWindowTokens ||
      actual.output_reserve_tokens !== policy.outputReserveTokens
    ) {
      throw new GobstopperContextError("scope_policy_mismatch");
    }

    const env = stripGobstopperScope(input.env);
    env.GOBSTOPPER_SCOPE = binding.scope;
    let codexConfig: CodexCustomProviderConfig | undefined;
    if (input.provider === "claude") {
      env.ANTHROPIC_BASE_URL = this.proxyUrl;
      const headers = env.ANTHROPIC_CUSTOM_HEADERS;
      const scopeHeader = `X-Gobstopper-Scope: ${binding.scope}`;
      env.ANTHROPIC_CUSTOM_HEADERS = headers ? `${headers}\n${scopeHeader}` : scopeHeader;
    } else {
      // A dedicated per-session provider prevents shared account config from changing the route.
      codexConfig = {
        model_provider: "paseo_gobstopper",
        model_providers: {
          paseo_gobstopper: {
            name: "Gobstopper",
            base_url: `${this.proxyUrl}/backend-api/codex`,
            wire_api: "responses",
            requires_openai_auth: true,
            env_http_headers: { "X-Gobstopper-Scope": "GOBSTOPPER_SCOPE" },
          },
        },
      };
    }
    return {
      env,
      codexConfig,
      snapshot: {
        scopeId,
        effectiveInputTokens: actual.effective_input_tokens,
        inputCapacityTokens: actual.input_capacity_tokens,
        limitingReason: actual.limiting_reason,
        baseThresholdTokens: actual.base_threshold_tokens,
        observedAt: new Date().toISOString(),
      },
    };
  }

  private async createBinding(
    input: PrepareGobstopperContext,
    policy: GobstopperContextPolicy,
  ): Promise<ReadyBinding> {
    const pending: Binding = {
      state: "creating",
      agentId: input.agentId,
      provider: input.provider === "claude" ? "claude" : "codex",
      policy,
      proxyUrl: this.proxyUrl,
      storeIdentity: this.storeIdentity,
    };
    // Retain intent before a non-idempotent CLI call, including across daemon death.
    await this.writeBinding(pending, true);
    const result = await this.command([
      "context",
      "create",
      "--context-window",
      String(policy.providerWindowTokens),
      "--client-context-window",
      String(policy.clientWindowTokens),
      "--output-reserve",
      String(policy.outputReserveTokens),
      "--threshold",
      String(policy.thresholdTokens),
      "--port",
      new URL(this.proxyUrl).port || "80",
      "--json",
    ]);
    const created = z.object({ scope: z.string().regex(/^[0-9a-f]{64}$/) }).safeParse(result);
    if (!created.success) throw new GobstopperContextError("creation_outcome_unknown");
    const ready: ReadyBinding = { ...pending, state: "ready", scope: created.data.scope };
    try {
      await this.writeBinding(ready, false);
    } catch (error) {
      // No provider was started, so a known capability can be reclaimed safely.
      try {
        await this.command(["context", "close"], ready.scope);
        await unlink(this.bindingPath(input.agentId));
      } catch {
        // Retain the binding or intent when cleanup is uncertain; never recreate silently.
      }
      throw error;
    }
    return ready;
  }

  private async checkProxy(): Promise<void> {
    try {
      const response = await fetch(`${this.proxyUrl}/gobstopper/status`, {
        signal: AbortSignal.timeout(5_000),
        redirect: "error",
      });
      if (!response.ok) throw new GobstopperContextError("proxy_unavailable");
      const health = z
        .object({
          name: z.literal("gobstopper-proxy"),
          port: z.number().int(),
          draining: z.literal(false),
          context_control: z.object({ available: z.literal(true) }),
        })
        .safeParse(await response.json());
      const expectedPort = Number(new URL(this.proxyUrl).port || "80");
      if (!health.success || health.data.port !== expectedPort)
        throw new GobstopperContextError("proxy_unavailable");
    } catch {
      throw new GobstopperContextError("proxy_unavailable");
    }
  }

  private async command(args: string[], scope?: string): Promise<unknown> {
    try {
      const env = { ...this.commandEnv };
      if (scope) env.GOBSTOPPER_SCOPE = scope;
      const result = await execFileAsync(this.executable, ["--no-update", ...args], {
        env,
        timeout: 10_000,
        maxBuffer: 64 * 1024,
        encoding: "utf8",
      });
      return JSON.parse(result.stdout);
    } catch {
      // Subprocess errors embed argv/stdout/stderr, which may contain a capability.
      throw new GobstopperContextError("scope_command_failed");
    }
  }

  private bindingPath(agentId: string): string {
    const name = createHash("sha256").update(agentId).digest("hex");
    return join(this.options.stateDirectory, `${name}.json`);
  }

  private async prepareDirectory(): Promise<void> {
    await mkdir(this.options.stateDirectory, { recursive: true, mode: 0o700 });
    const directory = await lstat(this.options.stateDirectory);
    if (
      !directory.isDirectory() ||
      (process.platform !== "win32" && (directory.mode & 0o077) !== 0)
    ) {
      throw new GobstopperContextError("state_directory_not_private");
    }
  }

  private async readBinding(agentId: string): Promise<Binding | null> {
    try {
      const path = this.bindingPath(agentId);
      const metadata = await lstat(path);
      const privateMode = process.platform === "win32" || (metadata.mode & 0o077) === 0;
      if (!metadata.isFile() || metadata.nlink !== 1 || !privateMode)
        throw new GobstopperContextError("binding_not_private");
      const parsed = BindingSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
      if (!parsed.success) throw new GobstopperContextError("binding_invalid");
      return parsed.data;
    } catch (error) {
      if (error instanceof GobstopperContextError) throw error;
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw new GobstopperContextError("binding_unreadable");
    }
  }

  private async writeBinding(binding: Binding, exclusive: boolean): Promise<void> {
    const destination = this.bindingPath(binding.agentId);
    const path = exclusive ? destination : `${destination}.${randomUUID()}.tmp`;
    try {
      const file = await open(path, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(binding));
        await file.sync();
      } finally {
        await file.close();
      }
      if (!exclusive) await rename(path, destination);
      if (process.platform !== "win32") await chmod(destination, 0o600);
      if (process.platform !== "win32") {
        const directory = await open(this.options.stateDirectory, "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
    } catch {
      throw new GobstopperContextError("binding_write_failed");
    }
  }
}

// Inherited scope identity must never silently bind an independent worker to its parent.
export function stripGobstopperScope(input: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) env[key] = value;
  }
  env.GOBSTOPPER_SCOPE = "";
  const headers = input.ANTHROPIC_CUSTOM_HEADERS ?? process.env.ANTHROPIC_CUSTOM_HEADERS;
  if (headers !== undefined) {
    const kept = headers
      .split(/\r?\n/)
      .filter((line) => !/^\s*x-gobstopper-scope\s*:/i.test(line) && line.trim() !== "");
    env.ANTHROPIC_CUSTOM_HEADERS = kept.join("\n");
  }
  return env;
}

function validatePolicy(input: PrepareGobstopperContext): ContextPolicy {
  if (input.provider !== "claude" && input.provider !== "codex")
    throw new GobstopperContextError("unsupported_provider");
  const providerEnv = { ...process.env, ...input.env };
  const alternateClaudeRoute = [
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
  ].some((key) => providerEnv[key] === "1" || providerEnv[key] === "true");
  if (input.provider === "claude" && alternateClaudeRoute) {
    throw new GobstopperContextError("unsupported_provider_route");
  }
  const parsed = PolicySchema.safeParse(input.policy);
  if (!parsed.success) throw new GobstopperContextError("invalid_policy");
  const policy = parsed.data;
  if (Object.values(policy).some((value) => value > 8_000_000)) {
    throw new GobstopperContextError("invalid_policy");
  }
  const capacity =
    Math.min(policy.providerWindowTokens, policy.clientWindowTokens) - policy.outputReserveTokens;
  if (capacity < policy.thresholdTokens)
    throw new GobstopperContextError("threshold_exceeds_capacity");
  return policy;
}
