import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import pino from "pino";

// Production modules come exclusively from this checkout's compiled release.
// The fixture injects local echo processes instead of credentialed providers.
const execute = promisify(execFile);
const [sourceHelper, pluginRoot, evidenceRoot] = process.argv.slice(2);
for (const value of [sourceHelper, pluginRoot, evidenceRoot]) assert(path.isAbsolute(value));
const root = await fs.mkdtemp(path.join(os.tmpdir(), "sa-joined-bridge-"));
await execute("git", ["init", "-q", root]);
await fs.writeFile(path.join(root, ".gitignore"), ".paseo-worker.json\nruns/\nbuild/\n");
await fs.mkdir(path.join(root, "build"));
const helper = path.join(root, "build/worker");
await fs.copyFile(sourceHelper, helper);
await fs.chmod(helper, 0o700);
const stateDir = path.join(root, "runs/.locks/host-memory");
await fs.mkdir(path.join(stateDir, "coverage"), { recursive: true });
const boot = (await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
const epoch = "a".repeat(32);
const digest = "b".repeat(64);
const registration = path.join(root, "owner.json");
const statePath = path.join(stateDir, "state.json");
const json = async (file, value) =>
  fs.writeFile(
    file,
    JSON.stringify(
      value,
      (_, item) => (typeof item === "bigint" ? `BIGINT:${item}` : item),
      2,
    ).replace(/"BIGINT:(\d+)"/g, "$1"),
    { mode: 0o600 },
  );
await json(statePath, {
  schema: 1,
  policy: "observe",
  linuxBootId: boot,
  consumerEpoch: epoch,
  epochHistory: [epoch],
  lastBoottimeMs: 0,
  generation: 0,
  windowsBootId: "",
  syncSequence: 0,
  challenge: null,
  snapshot: null,
  lastAck: null,
  receipts: {},
  coverageManifestDigest: null,
});
Object.assign(process.env, {
  PASEO_PROVIDER_ADMISSION: "required",
  PASEO_PROVIDER_ADMISSION_HELPER: helper,
  PASEO_PROVIDER_ADMISSION_BYTES: "1048576",
  PASEO_PROVIDER_ADMISSION_REGISTRATION: registration,
  PASEO_PROVIDER_ADMISSION_EPOCH: epoch,
  PASEO_PROVIDER_ADMISSION_MANIFEST: digest,
});
const fixtureEnv = { ...process.env, WORKSPACE: root };
for (const key of Object.keys(fixtureEnv)) {
  if (key.startsWith("SA_HEAVY_") || key === "PASEO_AGENT_ID") delete fixtureEnv[key];
}
const responses = [];
async function command(args, input, allowFailure = false) {
  const child = spawn(helper, args, {
    cwd: root,
    env: fixtureEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
  const [code] = await once(child, "close");
  const result = stdout.trim() ? JSON.parse(stdout) : null;
  responses.push({ args, input, code, result, stderr });
  if (!allowFailure) assert.equal(code, 0, `${args.join(" ")}: ${stderr} ${stdout}`);
  return { code, result };
}
const query = async () => (await command(["host-memory", "query"], { schema: 1 })).result.state;
const bridge = await import("../packages/server/dist/server/server/agent/provider-admission.js");
const { createPaseoDaemon } = await import("../packages/server/dist/server/server/bootstrap.js");
const { createPaseoClient } = await import("../packages/client/dist/index.js");
const { MockLoadTestAgentClient } =
  await import("../packages/server/dist/server/server/agent/providers/mock-load-test-agent.js");
const { AgentExecutionStore } =
  await import("../packages/server/dist/server/server/agent/agent-execution-store.js");
const { Orchestrator } = await import(
  pathToFileURL(path.join(pluginRoot, "server/orchestrator.mjs"))
);
const scopes = [];
const children = new Set();
const provider = new MockLoadTestAgentClient(pino({ level: "silent" }));
provider.provider = "codex";
for (const method of ["createSession", "resumeSession"]) {
  const original = provider[method].bind(provider);
  provider[method] = async (...args) => {
    const session = await original(...args);
    session.provider = "codex";
    let child;
    session.prepareRuntime = async () => {
      if (child) return;
      child = await bridge.spawnProviderProcess("/bin/cat", [], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      children.add(child);
      child.stderr.on("data", (chunk) => process.stderr.write(chunk));
      const echoed = once(child.stdout, "data");
      child.stdin.write("scope ready\n");
      await echoed;
      scopes.push(bridge.getProviderRuntimeId(child));
    };
    session.getPhysicalRuntimeId = () => (child ? bridge.getProviderRuntimeId(child) : null);
    const close = session.close.bind(session);
    session.close = async () => {
      await close();
      if (child) {
        const closed = once(child, "close");
        child.stdin.end();
        assert.equal((await closed)[0], 0);
        children.delete(child);
        child = undefined;
      }
    };
    await session.prepareRuntime();
    return session;
  };
}
const paseoHome = path.join(root, "paseo");
await fs.mkdir(paseoHome);
const daemon = await createPaseoDaemon(
  {
    listen: "127.0.0.1:0",
    paseoHome,
    corsAllowedOrigins: [],
    hostnames: true,
    mcpEnabled: false,
    staticDir: root,
    mcpDebug: false,
    agentClients: { codex: provider },
    agentStoragePath: path.join(paseoHome, "agents"),
    relayEnabled: false,
    relayEndpoint: "relay.paseo.sh:443",
    appBaseUrl: "https://app.paseo.sh",
    repositoryAutoRefresh: false,
    pluginsEnabled: false,
  },
  pino({ level: "info" }, pino.destination({ dest: path.join(root, "daemon.log"), sync: true })),
);
let client;
const plugin = new Orchestrator({ workspaceRoot: root });
const checks = {};
let sequence = 0,
  revision = 0,
  generation = 1;
let windowsBoot = "11111111-1111-4111-8111-111111111111";
async function challenge() {
  return (
    await command(["host-memory", "challenge"], {
      schema: 1,
      producer: "cakebuild",
      windowsHost: "rahmed-windesktop",
      windowsBootId: windowsBoot,
      generation,
      syncSequence: ++sequence,
      syncNonce: randomUUID().replaceAll("-", ""),
    })
  ).result.challenge;
}
async function snapshot(jobs) {
  const ticket = await challenge();
  const result = await command(["host-memory", "apply"], {
    schema: 1,
    challenge: ticket,
    snapshot: {
      schema: 1,
      producer: "cakebuild",
      windowsHost: "rahmed-windesktop",
      windowsBootId: windowsBoot,
      generation,
      revision: ++revision,
      compileJobs: jobs,
    },
  });
  return result.result;
}
const reservations = async () =>
  (await fs.readdir(path.join(root, "runs/.locks/provider-reservations"))).filter((n) =>
    n.endsWith(".json"),
  );
try {
  await daemon.start();
  const startup = (await fs.readFile(path.join(root, "daemon.log"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  for (const pluginId of ["antigravity-provider", "muse-provider"]) {
    assert(
      startup.some(
        (entry) =>
          entry.pluginId === pluginId &&
          entry.msg === "Failed to start built-in plugin" &&
          entry.err?.message.includes("has no physical launch coverage"),
      ),
    );
  }
  checks.uncoveredAdaptersRefusedLocally = true;
  const port = daemon.getListenTarget().port;
  assert(![6767, 6768].includes(port));
  client = createPaseoClient({ url: `ws://127.0.0.1:${port}/ws` });
  await client.connect();
  assert(client.agents.supportsRequiredHostAdmission());
  await plugin.start();
  await plugin.ready(client);
  checks.daemon = { port, compiled: true, requiredCapability: true };

  // Only the attestation fixture is injected. All snapshot/grant/owner checks
  // run through the compiled helper. This is not installed coverage evidence.
  const owner = JSON.parse(await fs.readFile(registration));
  const stat = await fs.stat(registration, { bigint: true });
  await json(path.join(stateDir, "coverage", `${digest}.verified.json`), {
    schema: 1,
    manifestDigest: digest,
    linuxBootId: boot,
    consumerEpoch: epoch,
    version: "sa-host-memory/1",
    revisions: [
      {
        path: registration,
        device: Number(stat.dev),
        inode: Number(stat.ino),
        size: Number(stat.size),
        modifiedNs: stat.mtimeNs,
        changedNs: stat.ctimeNs,
        mode: Number(stat.mode) & 0o777,
      },
    ],
    owners: { [registration]: owner },
  });
  const ledger = JSON.parse(await fs.readFile(statePath));
  await json(statePath, { ...ledger, policy: "enforce", coverageManifestDigest: digest });
  assert.equal((await snapshot([])).state.barrier, "clear");
  const admitted = plugin.register({
    attemptId: "clear-admission",
    clientMessageId: "clear-admission",
    notifyOnCompletion: false,
    cwd: root,
    runDirectory: path.join(root, "runs/clear-admission"),
    title: "sa-worker:clear-admission",
  });
  assert(await plugin.admitWorker(admitted));
  checks.clearPluginAdmission = true;

  const workspace = await client.workspaces.create({
    background: true,
    source: { kind: "directory", path: root },
  });
  const agent = await workspace.agents.create({
    config: { provider: "codex/gpt-5.4", featureValues: { mockAssistantResponse: "done" } },
  });
  await agent.run("First turn", { messageId: "first", activeTurnBehavior: "reject" });
  const first = await agent.execution({ kind: "latest" });
  const scope = scopes.at(-1);
  assert(first?.turnId);
  assert.equal((await reservations()).length, 1);
  checks.onePhysicalCharge = { scope, agentId: agent.id, reservations: await reservations() };

  // Two exact running native records exercise finite declarations on admitted
  // physical work. These records are fixture inputs, not fabricated live turns.
  const store = new AgentExecutionStore(owner.executionRoot);
  await store.initialize();
  await fs.writeFile(path.join(root, "go.mod"), "module fixture\n\ngo 1.23\n");
  await fs.writeFile(
    path.join(root, "slot_test.go"),
    'package fixture\nimport ("testing";"time")\nfunc TestSlot(t *testing.T) { time.Sleep(2*time.Second) }\n',
  );
  const go = (await execute("which", ["go"])).stdout.trim();
  for (const id of ["finishing-one", "finishing-two"]) {
    await store.create({
      agentId: agent.id,
      executionId: id,
      provider: "codex",
      turnId: id,
      status: "running",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await bridge.recordProviderExecution("execution-start", agent.id, id, scope);
    await command(["finishing", "declare"], {
      schema: 1,
      id,
      executionId: id,
      runtimeId: scope,
      cwd: root,
      args: [go, "test", "-count=1", "."],
      maxAttempts: 1,
    });
  }
  const held = await snapshot(["c".repeat(32)]);
  assert.equal(held.state.barrier, "held");
  assert.equal(
    (await command(["memory", "reserve", "--id", "blocked-runtime", "--bytes", "1048576"])).result
      .status,
    "blocked",
  );
  const queued = plugin.register({
    attemptId: "held-worker",
    clientMessageId: "held-worker",
    notifyOnCompletion: false,
    cwd: root,
    runDirectory: path.join(root, "runs/held-worker"),
    title: "sa-worker:held-worker",
  });
  await plugin.submit(queued.attemptId, {
    prompt: "pending",
    config: { provider: "codex", model: "gpt-5.4", effort: "low", permissions: "all" },
  });
  assert(queued.admissionPending);
  assert.equal(queued.createStartedAt, undefined);
  await plugin.withdrawAdmission(
    queued.attemptId,
    Object.fromEntries(
      ["agentId", "clientMessageId", "cwd", "runDirectory", "host"].map((k) => [k, queued[k]]),
    ),
  );
  assert.equal(queued.status, "not-submitted");
  assert.equal((await command(["memory", "release", "--id", scope])).result.status, "retained");
  checks.heldAdmission = {
    pluginQueued: true,
    noProviderCreated: true,
    withdrawn: true,
    physicalReleaseRetained: true,
  };

  const finishing = spawn(
    helper,
    ["heavy", "--finishing", "finishing-one", "--", go, "test", "-count=1", "."],
    { cwd: root, env: fixtureEnv, stdio: ["ignore", "pipe", "pipe"] },
  );
  let finishOutput = "";
  finishing.stdout.on("data", (c) => (finishOutput += c));
  finishing.stderr.on("data", (c) => (finishOutput += c));
  const finishClose = once(finishing, "close");
  let active;
  for (let i = 0; i < 100; i++) {
    active = (await command(["finishing", "status"], { schema: 1 })).result.state;
    if (active.active) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(active.active?.id, "finishing-one");
  const second = await command(
    ["heavy", "--try", "--finishing", "finishing-two", "--", go, "test", "-count=1", "."],
    undefined,
    true,
  );
  assert.notEqual(second.code, 0);
  assert.equal((await finishClose)[0], 0, finishOutput);
  checks.finishingSlot = { oneSucceeded: true, secondRefused: true, active, output: finishOutput };
  for (const id of ["finishing-one", "finishing-two"]) {
    await store.update(agent.id, id, { status: "completed" });
    await bridge.recordProviderExecution("execution-end", agent.id, id, scope);
  }

  // Stop renewal as a crashed producer would. Real CLOCK_BOOTTIME expiry must
  // retain the held set, refuse new work, and recover on a fresh full snapshot.
  await new Promise((resolve) => setTimeout(resolve, 31000));
  const expired = await query();
  assert.equal(expired.barrier, "unknown");
  assert(expired.reasonCodes.includes("authority_expired"));
  assert.deepEqual(expired.snapshot.compileJobs, ["c".repeat(32)]);
  assert.equal(
    (await command(["memory", "reserve", "--id", "expired-runtime", "--bytes", "1048576"])).result
      .status,
    "blocked",
  );
  assert.equal((await snapshot([])).state.barrier, "clear");
  checks.producerCrash = { expired, recovered: true };

  const oldWindows = windowsBoot;
  windowsBoot = "22222222-2222-4222-8222-222222222222";
  generation++;
  assert.equal((await snapshot([])).state.barrier, "clear");
  const currentWindows = windowsBoot;
  windowsBoot = oldWindows;
  generation--;
  assert.notEqual(
    (
      await command(
        ["host-memory", "challenge"],
        {
          schema: 1,
          producer: "cakebuild",
          windowsHost: "rahmed-windesktop",
          windowsBootId: windowsBoot,
          generation,
          syncSequence: ++sequence,
          syncNonce: randomUUID().replaceAll("-", ""),
        },
        true,
      )
    ).code,
    0,
  );
  windowsBoot = currentWindows;
  generation++;
  checks.windowsBootFence = true;

  // Restore the actual daemon's latest execution after the explicit fixture
  // records, then retire and reopen the same durable agent through real RPCs.
  await agent.run("Second turn", { messageId: "second", activeTurnBehavior: "reject" });
  const current = await agent.execution({ kind: "latest" });
  await agent.retireRuntime({
    executionId: current.executionId,
    clientMessageId: current.clientMessageId,
    turnId: current.turnId,
    parentAgentId: null,
    cwd: root,
  });
  assert.equal((await reservations()).length, 0);
  assert.notEqual(
    (await command(["memory", "reserve", "--id", scope, "--bytes", "1048576"], undefined, true))
      .code,
    0,
  );
  await agent.run("Cold continuation", { messageId: "third", activeTurnBehavior: "reject" });
  assert.notEqual(scopes.at(-1), scope);
  assert.equal((await reservations()).length, 1);
  checks.sameAgentColdReopen = {
    agentId: agent.id,
    firstScope: scope,
    nextScope: scopes.at(-1),
    oldScopeTombstoned: true,
  };

  const stale = await challenge();
  await command(["host-memory", "readiness"], {
    schema: 1,
    action: "invalidate",
    expectedLinuxBootId: boot,
    expectedConsumerEpoch: epoch,
    reason: "coverage_change",
  });
  assert.notEqual(
    (
      await command(
        ["host-memory", "apply"],
        {
          schema: 1,
          challenge: stale,
          snapshot: {
            schema: 1,
            producer: "cakebuild",
            windowsHost: "rahmed-windesktop",
            windowsBootId: windowsBoot,
            generation,
            revision: ++revision,
            compileJobs: [],
          },
        },
        true,
      )
    ).code,
    0,
  );
  assert.equal((await query()).barrier, "unknown");
  checks.epochFence = true;
  const oldBootLedger = JSON.parse(await fs.readFile(statePath));
  await json(statePath, { ...oldBootLedger, linuxBootId: "33333333-3333-4333-8333-333333333333" });
  const changedBoot = await query();
  assert.equal(changedBoot.barrier, "unknown");
  await challenge();
  assert.notEqual((await query()).consumerEpoch, oldBootLedger.consumerEpoch);
  checks.linuxBootFence = true;
} finally {
  await plugin.close();
  await client?.close();
  await daemon.stop();
  for (const child of children) child.kill("SIGTERM");
  await fs.mkdir(evidenceRoot, { recursive: true });
  await fs.copyFile(path.join(root, "daemon.log"), path.join(evidenceRoot, "bridge-daemon.log"));
  await json(path.join(evidenceRoot, "bridge-responses.json"), responses);
  await json(path.join(evidenceRoot, "bridge-proof.json"), {
    fixture: root,
    checks,
    fixtureCoverageOnly: true,
    fixtureNativeFinishingRecords: true,
    installedEnforcementReady: false,
    helperSha256: createHash("sha256")
      .update(await fs.readFile(helper))
      .digest("hex"),
  });
}
console.log(JSON.stringify({ fixture: root, checks: Object.keys(checks), passed: true }));
