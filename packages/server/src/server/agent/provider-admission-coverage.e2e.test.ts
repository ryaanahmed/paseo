import { once } from "node:events";
import { createPaseoClient } from "@getpaseo/client";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { providerAdmissionOwner } from "./provider-admission-owner.js";
import { providerAdmissionConfig, spawnProviderProcess } from "./provider-admission.js";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { expect, test, vi } from "vitest";

const execute = promisify(execFile);
const serverRoot = fileURLToPath(new URL("../../..", import.meta.url));
const root = path.resolve(serverRoot, "../..");

// This isolated process configures required admission before importing adapters.
// A marker executable proves that no fallback silently spawns around a missing owner.
test("enabled adapters and Codex utility paths fail closed without required physical coverage", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "paseo-admission-coverage-"));
  try {
    const marker = path.join(home, "spawned");
    const provider = path.join(home, "provider.mjs");
    await writeFile(
      provider,
      `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(marker)}, 'launched\\n');\n`,
    );
    const script = `
      import pino from 'pino';
      import { buildProviderRegistry } from './src/server/agent/provider-registry.ts';
      import { OpenCodeV2AgentClient } from './src/server/agent/providers/opencode/v2/agent.ts';
      import { ProviderAdmissionBlocked } from './src/server/agent/provider-admission.ts';
      const logger = pino({level:'silent'});
      const cwd = ${JSON.stringify(home)};
      const settings = {command:{mode:'replace',argv:[process.execPath,${JSON.stringify(provider)}]}};
      const providers = ['codex','claude','copilot','pi','omp','opencode'];
      const registry = buildProviderRegistry(logger,{runtimeSettings:Object.fromEntries(providers.map(p=>[p,settings]))});
      const results = [];
      async function check(name, operation) {
        try { await operation(); results.push([name,'unexpected success']); }
        catch(error) { results.push([name,error instanceof ProviderAdmissionBlocked ? 'blocked' : error.message]); }
      }
      for (const provider of providers) {
        const client = registry[provider].createClient(logger);
        await check(provider+' create', async()=>{
          const session = await client.createSession({provider,cwd});
          try { await session.prepareRuntime?.(); } finally { await session.close(); }
        });
      }
      const codex = registry.codex.createClient(logger);
      const config = {provider:'codex',cwd};
      const handle = {provider:'codex',sessionId:'00000000-0000-4000-8000-000000000000'};
      await check('codex resume',()=>codex.resumeSession(handle,config));
      await check('codex history',()=>codex.resumeSession(handle,config,{purpose:'history'}));
      await check('codex models',()=>codex.fetchCatalog({scope:'global',force:true}));
      await check('codex import list',()=>codex.listImportableSessions({cwd}));
      await check('codex import',()=>codex.importSession({providerHandleId:handle.sessionId,cwd},{config,storedConfig:config}));
      await check('codex archive',()=>codex.archiveNativeSession(handle));
      await check('codex unarchive',()=>codex.unarchiveNativeSession(handle));
      const v2 = new OpenCodeV2AgentClient({logger,settings});
      await check('opencode v2 models',()=>v2.fetchCatalog({scope:'global',force:true}));
      await v2.shutdown();
      console.log(JSON.stringify(results));
    `;
    const result = await execute(
      process.execPath,
      [
        "--import",
        path.join(root, "node_modules/tsx/dist/loader.mjs"),
        "--input-type=module",
        "--eval",
        script,
      ],
      {
        cwd: serverRoot,
        env: {
          ...process.env,
          HOME: home,
          XDG_CONFIG_HOME: home,
          XDG_CACHE_HOME: home,
          PASEO_HOME: path.join(home, "paseo"),
          PASEO_PROVIDER_ADMISSION: "required",
          PASEO_PROVIDER_ADMISSION_HELPER: path.join(home, "worker"),
          PASEO_PROVIDER_ADMISSION_BYTES: "1024",
        },
        timeout: 20_000,
        maxBuffer: 1024 * 1024,
      },
    );
    const results = JSON.parse(result.stdout.trim());
    expect(results).toHaveLength(14);
    expect(results.filter(([, outcome]: [string, string]) => outcome !== "blocked")).toEqual([]);
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 30_000);

// The test daemon supplies credential-free Codex/Claude sessions. Its admission
// code and SDK are real; any attempt to start a host owner fails this test.
test("default daemon creates Codex and Claude without host admission or a helper", async () => {
  vi.stubEnv("PASEO_PROVIDER_ADMISSION", undefined);
  vi.stubEnv("PASEO_PROVIDER_ADMISSION_HELPER", path.resolve("missing-host-admission-helper"));
  vi.stubEnv("PASEO_PROVIDER_ADMISSION_BYTES", undefined);
  vi.stubEnv("PASEO_PROVIDER_ADMISSION_REGISTRATION", undefined);
  vi.stubEnv("PASEO_PROVIDER_ADMISSION_EPOCH", undefined);
  vi.stubEnv("PASEO_PROVIDER_ADMISSION_MANIFEST", undefined);
  const startOwner = vi
    .spyOn(providerAdmissionOwner, "start")
    .mockRejectedValue(new Error("Default mode must never require a host-specific owner"));
  const daemon = await createTestPaseoDaemon();
  const client = createPaseoClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  try {
    expect(providerAdmissionConfig()).toBeNull();
    expect(daemon.port).not.toBe(6767);
    expect(daemon.port).not.toBe(6768);
    await client.connect();
    expect(client.agents.supportsRequiredHostAdmission()).toBe(false);
    expect(providerAdmissionOwner.isReady()).toBe(false);
    const workspace = await client.workspaces.create({
      source: { kind: "directory", path: daemon.staticDir },
    });
    for (const provider of ["codex", "claude"]) {
      const agent = await workspace.agents.create({
        config: { provider: `${provider}/test-model` },
      });
      await agent.run("Default-mode turn", {
        messageId: `default-${provider}`,
        activeTurnBehavior: "reject",
      });
      expect(await agent.execution({ kind: "latest" })).toMatchObject({
        provider,
        status: "completed",
      });
    }
    // The physical launch wrapper also uses the ordinary executable directly.
    // process.execPath keeps this check independent of Linux paths and services.
    const child = await spawnProviderProcess(
      process.execPath,
      ["-e", "process.stdout.write('ordinary launch')"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout!.on("data", (chunk) => (output += chunk));
    expect((await once(child, "close"))[0]).toBe(0);
    expect(output).toBe("ordinary launch");
    expect(startOwner).not.toHaveBeenCalled();
  } finally {
    await client.close();
    await daemon.close();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }
}, 30_000);
