import { once } from "node:events";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { createPaseoClient } from "@getpaseo/client";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { providerAdmissionOwner } from "./provider-admission-owner.js";
import { providerAdmissionConfig, spawnProviderProcess } from "./provider-admission.js";

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
