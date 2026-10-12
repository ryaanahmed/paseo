import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  GobstopperContextManager,
  stripGobstopperScope,
  type GobstopperContextPolicy,
} from "./gobstopper-context.js";

const policy: GobstopperContextPolicy = {
  providerWindowTokens: 1_000_000,
  clientWindowTokens: 1_000_000,
  outputReserveTokens: 32_000,
  thresholdTokens: 512_000,
};

// Exercise the actual subprocess boundary without provider traffic or a shared Gobstopper store.
const cliSource = [
  "const fs = require('node:fs');",
  "const crypto = require('node:crypto');",
  "const args = process.argv.slice(2);",
  "const file = process.env.FAKE_SCOPE_STORE;",
  "const store = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};",
  "function save() { fs.writeFileSync(file, JSON.stringify(store)); }",
  "function arg(name) { return Number(args[args.indexOf(name) + 1]); }",
  "const command = args[2];",
  "if (command === 'create') {",
  "  const scope = crypto.randomBytes(32).toString('hex');",
  "  store[scope] = {",
  "    scope_id: crypto.createHash('sha256').update(scope).digest('hex'),",
  "    effective_input_tokens: arg('--threshold'),",
  "    input_capacity_tokens: Math.min(arg('--context-window'), arg('--client-context-window')) - arg('--output-reserve'),",
  "    limiting_reason: 'scope_threshold',",
  "    configured_provider_window: arg('--context-window'),",
  "    configured_client_window: arg('--client-context-window'),",
  "    output_reserve_tokens: arg('--output-reserve'),",
  "    base_threshold_tokens: 128000,",
  "    scope_threshold_tokens: arg('--threshold'),",
  "  };",
  "  save();",
  "  if (process.env.FAKE_BINDING_DIRECTORY) fs.chmodSync(process.env.FAKE_BINDING_DIRECTORY, 0o500);",
  "  if (process.env.FAKE_BAD_CREATE) {",
  "    process.stderr.write(scope); process.stdout.write(scope); process.exit(1);",
  "  }",
  "  process.stdout.write(JSON.stringify({scope, status: store[scope]}));",
  "} else if (command === 'status') {",
  "  const scope = process.env.GOBSTOPPER_SCOPE;",
  "  if (!store[scope]) { process.stderr.write('unknown scope ' + scope); process.exit(1); }",
  "  process.stdout.write(JSON.stringify(store[scope]));",
  "} else if (command === 'close') {",
  "  delete store[process.env.GOBSTOPPER_SCOPE]; save();",
  "  process.stdout.write(JSON.stringify({closed: true}));",
  "} else process.exit(2);",
].join("\n");

describe.skipIf(process.platform === "win32")("Gobstopper context ownership", () => {
  let root: string;
  let executable: string;
  let store: string;
  let stateDirectory: string;
  let proxyUrl: string;
  let server: Server;
  let available: boolean;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "paseo-context-"));
    executable = join(root, "gobstopper");
    store = join(root, "scopes.json");
    stateDirectory = join(root, "bindings");
    await writeFile(executable, "#!" + process.execPath + "\n" + cliSource, { mode: 0o700 });
    available = true;
    server = createServer((_request, response) => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected TCP server");
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          name: "gobstopper-proxy",
          port: address.port,
          draining: false,
          context_control: { available },
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP server");
    proxyUrl = "http://127.0.0.1:" + address.port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      }),
    );
    await rm(root, { recursive: true, force: true });
  });

  function manager(commandEnv: NodeJS.ProcessEnv = {}) {
    return new GobstopperContextManager({
      stateDirectory,
      executable,
      proxyUrl,
      commandEnv: { FAKE_SCOPE_STORE: store, ...commandEnv },
    });
  }

  function prepare(instance = manager()) {
    return instance.prepare({
      agentId: "worker",
      provider: "claude",
      policy,
      env: {
        ANTHROPIC_CUSTOM_HEADERS: "X-Trace: retained\nX-Gobstopper-Scope: inherited",
        GOBSTOPPER_SCOPE: "inherited",
      },
    });
  }

  async function bindingPath() {
    const paths = await readdir(stateDirectory);
    expect(paths).toHaveLength(1);
    const name = paths[0];
    if (!name) throw new Error("Expected one binding");
    return join(stateDirectory, name);
  }

  test("persists one private scope and reuses it after daemon restart and account changes", async () => {
    const first = await prepare();
    expect((await stat(await bindingPath())).mode & 0o777).toBe(0o600);
    expect((await stat(stateDirectory)).mode & 0o777).toBe(0o700);
    expect(first.env.ANTHROPIC_CUSTOM_HEADERS).toBe(
      "X-Trace: retained\nX-Gobstopper-Scope: " + first.env.GOBSTOPPER_SCOPE,
    );
    expect(first.snapshot).toMatchObject({
      effectiveInputTokens: 512000,
      baseThresholdTokens: 128000,
    });
    expect(JSON.stringify(first.snapshot)).not.toContain(first.env.GOBSTOPPER_SCOPE);
    const second = await manager().prepare({
      agentId: "worker",
      provider: "claude",
      policy,
      env: { CLAUDE_CONFIG_DIR: "/other/account" },
      requireExisting: true,
    });
    expect(second.env.GOBSTOPPER_SCOPE).toBe(first.env.GOBSTOPPER_SCOPE);
    expect(second.env.CLAUDE_CONFIG_DIR).toBe("/other/account");
    expect(Object.keys(JSON.parse(await readFile(store, "utf8")))).toHaveLength(1);
  });

  test("serializes concurrent opens of one agent and separates independent agents", async () => {
    const instance = manager();
    const [first, again] = await Promise.all([prepare(instance), prepare(instance)]);
    expect(first.env.GOBSTOPPER_SCOPE).toBe(again.env.GOBSTOPPER_SCOPE);
    const other = await instance.prepare({
      agentId: "other",
      provider: "claude",
      policy,
      env: first.env,
    });
    expect(other.env.GOBSTOPPER_SCOPE).not.toBe(first.env.GOBSTOPPER_SCOPE);
    expect(Object.keys(JSON.parse(await readFile(store, "utf8")))).toHaveLength(2);
  });

  test("routes Codex through a private per-session provider and preserves its account home", async () => {
    const result = await manager().prepare({
      agentId: "codex",
      provider: "codex",
      policy,
      env: { CODEX_HOME: "/account", ANTHROPIC_CUSTOM_HEADERS: "X-Gobstopper-Scope: parent" },
    });
    expect(result.env.CODEX_HOME).toBe("/account");
    expect(result.env.ANTHROPIC_CUSTOM_HEADERS).toBe("");
    expect(result.codexConfig).toEqual({
      model_provider: "paseo_gobstopper",
      model_providers: {
        paseo_gobstopper: {
          name: "Gobstopper",
          base_url: proxyUrl + "/backend-api/codex",
          wire_api: "responses",
          requires_openai_auth: true,
          env_http_headers: { "X-Gobstopper-Scope": "GOBSTOPPER_SCOPE" },
        },
      },
    });
    expect(JSON.stringify(result.codexConfig)).not.toContain(result.env.GOBSTOPPER_SCOPE);
  });

  test("refuses unavailable proxy before creating scope state", async () => {
    available = false;
    await expect(prepare()).rejects.toThrow("proxy_unavailable");
    await expect(stat(store)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("refuses missing binding on resume and altered policy", async () => {
    await expect(
      manager().prepare({
        agentId: "worker",
        provider: "claude",
        policy,
        env: {},
        requireExisting: true,
      }),
    ).rejects.toThrow("binding_missing");
    await prepare();
    await expect(
      manager().prepare({
        agentId: "worker",
        provider: "claude",
        policy: { ...policy, thresholdTokens: 400000 },
        env: {},
      }),
    ).rejects.toThrow("binding_mismatch");
  });

  test("refuses lost scope and does not expose its capability in errors", async () => {
    const ready = await prepare();
    await writeFile(store, "{}");
    const outcome = await prepare().catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(Error);
    expect(String(outcome)).toContain("scope_command_failed");
    expect(String(outcome)).not.toContain(ready.env.GOBSTOPPER_SCOPE);
  });

  test("retains uncertain creation and refuses automatic creation retry", async () => {
    await expect(prepare(manager({ FAKE_BAD_CREATE: "1" }))).rejects.toThrow(
      "scope_command_failed",
    );
    await expect(prepare()).rejects.toThrow("creation_outcome_unknown");
    const scopes = Object.keys(JSON.parse(await readFile(store, "utf8")));
    expect(scopes).toHaveLength(1);
    expect(await readFile(await bindingPath(), "utf8")).not.toContain(scopes[0]);
  });

  test("closes a known new scope if private persistence fails", async () => {
    try {
      await expect(prepare(manager({ FAKE_BINDING_DIRECTORY: stateDirectory }))).rejects.toThrow(
        "binding_write_failed",
      );
      expect(JSON.parse(await readFile(store, "utf8"))).toEqual({});
    } finally {
      await chmod(stateDirectory, 0o700);
    }
  });

  test("rejects mismatched scope status and insecure binding permissions", async () => {
    const ready = await prepare();
    const scope = ready.env.GOBSTOPPER_SCOPE;
    if (!scope) throw new Error("Expected scope capability");
    const scopes = JSON.parse(await readFile(store, "utf8"));
    scopes[scope].scope_threshold_tokens = 200000;
    await writeFile(store, JSON.stringify(scopes));
    await expect(prepare()).rejects.toThrow("scope_policy_mismatch");
    await chmod(await bindingPath(), 0o644);
    await expect(prepare()).rejects.toThrow("binding_not_private");
  });

  test("closes and removes a binding only through explicit release", async () => {
    await prepare();
    await manager().release("worker");
    expect(await readdir(stateDirectory)).toEqual([]);
    expect(JSON.parse(await readFile(store, "utf8"))).toEqual({});
  });

  test("rejects a threshold above declared capacity before side effects", async () => {
    await expect(
      manager().prepare({
        agentId: "worker",
        provider: "claude",
        policy: { ...policy, thresholdTokens: 999999 },
        env: {},
      }),
    ).rejects.toThrow("threshold_exceeds_capacity");
    await expect(stat(store)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

test("unscoped workers drop inherited capabilities without changing other routing", () => {
  const source = {
    GOBSTOPPER_SCOPE: "private",
    ANTHROPIC_BASE_URL: "http://127.0.0.1:8260",
    ANTHROPIC_CUSTOM_HEADERS: "X-Trace: retained\r\n  x-gobstopper-scope : private\n",
    OPENAI_BASE_URL: "route",
  };
  expect(stripGobstopperScope(source)).toEqual({
    GOBSTOPPER_SCOPE: "",
    ANTHROPIC_BASE_URL: source.ANTHROPIC_BASE_URL,
    ANTHROPIC_CUSTOM_HEADERS: "X-Trace: retained",
    OPENAI_BASE_URL: "route",
  });
  expect(source.GOBSTOPPER_SCOPE).toBe("private");
});
