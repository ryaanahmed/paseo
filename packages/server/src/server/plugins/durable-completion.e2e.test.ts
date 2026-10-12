import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPaseoApi } from "@getpaseo/client";
import { expect, test } from "vitest";
import { WatchRecord } from "../../../../../plugins/durable-completion/shared/contracts.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { createTestAgentClient, createTestAgentClients } from "../test-utils/fake-agent-client.js";

// Exercise the installed plugin and real SDK; only provider execution is synthetic.
test("opt-in completion recovers a missed outcome and sends one metadata-only notification", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-completion-e2e-"));
  const notifications: string[] = [];
  const daemon = await createTestPaseoDaemon({
    agentClients: {
      ...createTestAgentClients(),
      pi: createTestAgentClient("pi", {
        onStartTurn(prompt) {
          notifications.push(
            typeof prompt === "string"
              ? prompt
              : prompt
                  .filter((block) => block.type === "text")
                  .map((block) => block.text)
                  .join("\n"),
          );
        },
      }),
    },
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.11.2",
  });
  const api = createPaseoApi(client);
  try {
    await client.connect();
    expect((await client.listPlugins()).map((plugin) => plugin.id)).not.toContain(
      "durable-completion",
    );
    await client.patchDaemonConfig({ pluginsEnabled: true });
    const pluginDirectory = fileURLToPath(
      new URL("../../../../../plugins/durable-completion", import.meta.url),
    );
    await expect(client.installDirectoryPlugin(pluginDirectory)).resolves.toMatchObject({
      id: "durable-completion",
      status: "running",
    });
    const coordinator = await api.agents.create({
      config: { provider: "pi/test", modeId: "full-access" },
      cwd: directory,
      title: "Coordinator",
    });
    const child = await api.agents.create({
      config: { provider: "claude/test", modeId: "full-access" },
      cwd: directory,
      parent: coordinator,
      title: "Child",
    });
    const watch = {
      id: "bounded-assignment",
      agentId: child.id,
      clientMessageId: "bounded-submission",
      recipientId: coordinator.id,
      requireParentOwnership: true,
    };
    await expect(
      client.invokePluginRpc("durable-completion", "completion.watch", watch),
    ).resolves.toMatchObject({
      ...watch,
      state: "pending",
    });

    // Lose the live event deliberately; reactivation must query durable evidence itself.
    await client.disablePlugin("durable-completion");
    await child.send("PRIVATE CHILD PROMPT", {
      messageId: watch.clientMessageId,
      activeTurnBehavior: "reject",
    });
    await expect
      .poll(() => child.execution({ kind: "submission", clientMessageId: watch.clientMessageId }))
      .toMatchObject({ status: "completed" });
    expect(notifications).toEqual([]);
    await client.enablePlugin("durable-completion");
    await expect
      .poll(
        async () => {
          const value = await client.invokePluginRpc("durable-completion", "completion.get", {
            id: watch.id,
          });
          return WatchRecord.parse(value).state;
        },
        { timeout: 10_000 },
      )
      .toBe("delivered");
    const record = WatchRecord.parse(
      await client.invokePluginRpc("durable-completion", "completion.get", { id: watch.id }),
    );
    expect(record.outcome).toMatchObject({ status: "completed" });
    expect(notifications).toHaveLength(1);
    const notification = notifications[0]!;
    expect(notification).toContain(record.deliveryId);
    expect(notification).toContain(child.id);
    expect(notification).toContain(watch.clientMessageId);
    expect(notification).not.toContain("PRIVATE CHILD PROMPT");
    expect(notification).not.toContain("Hello world");
    expect(Buffer.byteLength(notification)).toBeLessThan(1200);

    const storage = path.join(daemon.paseoHome, "plugin-data", "durable-completion");
    const files = (await readdir(storage)).filter((file) => file.endsWith(".json"));
    expect(files).toHaveLength(1);
    expect(
      WatchRecord.parse(JSON.parse(await readFile(path.join(storage, files[0]!), "utf8"))),
    ).toEqual(record);
    await client.reloadPlugin("durable-completion");
    await expect(
      client.invokePluginRpc("durable-completion", "completion.watch", watch),
    ).resolves.toEqual(record);
    expect(notifications).toHaveLength(1);
  } finally {
    await api.dispose();
    await client.close().catch(() => undefined);
    await daemon.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
