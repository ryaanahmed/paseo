import { mkdtemp, mkdir, copyFile, chmod, readFile, writeFile, readdir } from "node:fs/promises";
import { execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { strict as assert } from "node:assert";
import os from "node:os";
import path from "node:path";
const exec = promisify(execFile);
const sourceHelper = process.argv[2];
if (!sourceHelper || !path.isAbsolute(sourceHelper))
  throw new Error("Usage: prove-provider-admission.mts /absolute/path/to/candidate-worker");
const home = await mkdtemp(path.join(os.tmpdir(), "paseo-admission-bridge-"));
await exec("git", ["init", "-q", home]);
await mkdir(path.join(home, "build"), { mode: 0o700 });
const helper = path.join(home, "build/worker");
await copyFile(sourceHelper, helper);
await chmod(helper, 0o700);
const stateDir = path.join(home, "runs/.locks/host-memory");
await mkdir(stateDir, { recursive: true, mode: 0o700 });
const epoch = "a".repeat(32);
await writeFile(
  path.join(stateDir, "state.json"),
  JSON.stringify({
    schema: 1,
    policy: "observe",
    linuxBootId: (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(),
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
  }),
  { mode: 0o600 },
);
Object.assign(process.env, {
  PASEO_PROVIDER_ADMISSION: "required",
  PASEO_PROVIDER_ADMISSION_HELPER: helper,
  PASEO_PROVIDER_ADMISSION_BYTES: "1048576",
  PASEO_PROVIDER_ADMISSION_REGISTRATION: path.join(home, "owner.json"),
  PASEO_PROVIDER_ADMISSION_EPOCH: epoch,
  PASEO_PROVIDER_ADMISSION_MANIFEST: "b".repeat(64),
});
const bridge = await import("../packages/server/src/server/agent/provider-admission.js");
const ownerModule = await import("../packages/server/src/server/agent/provider-admission-owner.js");
const owner = ownerModule.providerAdmissionOwner;
const { AgentExecutionStore } =
  await import("../packages/server/src/server/agent/agent-execution-store.js");
const store = new AgentExecutionStore(path.join(home, "runtime/agent-executions"));
await mkdir(store.directoryPath, { recursive: true, mode: 0o700 });
await store.initialize();
let ownedChild: ChildProcess | null = null;
try {
  await owner.start(
    ownerModule.admissionOwnerConfig(bridge.providerAdmissionConfig()!, store.directoryPath),
  );
  assert(owner.isReady());
  await bridge.permitNewProviderWorker("fixture-agent");
  const child = await bridge.spawnProviderProcess("/bin/cat", [], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  ownedChild = child;
  const lines = createInterface({ input: child.stdout! });
  child.stderr!.on("data", (chunk) => process.stderr.write(chunk));
  async function echo(value: string) {
    const result = once(lines, "line");
    child.stdin!.write(value + "\n");
    assert.equal((await result)[0], value);
  }
  await echo("first warm turn");
  const runtimeId = bridge.getProviderRuntimeId(child)!;
  assert(runtimeId.startsWith("paseo-runtime-"));
  await store.create({
    agentId: "fixture-agent",
    executionId: "fixture-execution",
    provider: "fixture",
    turnId: "fixture-turn",
    status: "running",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  await bridge.recordProviderExecution(
    "execution-start",
    "fixture-agent",
    "fixture-execution",
    runtimeId,
  );
  await store.update("fixture-agent", "fixture-execution", { status: "completed" });
  await bridge.recordProviderExecution(
    "execution-end",
    "fixture-agent",
    "fixture-execution",
    runtimeId,
  );
  await echo("second warm turn");
  assert.equal(bridge.getProviderRuntimeId(child), runtimeId);
  const sibling = bridge.spawnProviderChild(child, "/bin/echo", ["internal child"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let siblingOutput = "";
  sibling.stdout!.on("data", (d) => (siblingOutput += d.toString()));
  assert.equal((await once(sibling, "exit"))[0], 0);
  assert.equal(siblingOutput, "internal child\n");
  const reservations = path.join(home, "runs/.locks/provider-reservations");
  assert.equal((await readdir(reservations)).filter((n) => n.endsWith(".json")).length, 1);
  owner.stop();
  await assert.rejects(bridge.spawnProviderProcess("/bin/false", []), /owner is unavailable/);
  await echo("warm runtime continues without owner");
  const closed = once(child, "close");
  child.stdin!.end();
  assert.equal((await closed)[0], 0);
  assert.equal(bridge.getProviderRuntimeId(child), null);
  const files = (await readdir(reservations)).filter((n) => n.endsWith(".json"));
  assert.equal(files.length, 0);
  const report = {
    fixture: home,
    runtimeId,
    ownerRegistration: true,
    logicalPermit: true,
    warmReuse: true,
    executionBinding: true,
    siblingCustody: true,
    ownerLossBlocksNew: true,
    warmAfterOwnerLoss: true,
    physicalRelease: true,
    liveEnforcementReady: false,
  };
  await writeFile(path.join(home, "proof.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  owner.stop();
  if (ownedChild && ownedChild.exitCode === null && ownedChild.signalCode === null) {
    ownedChild.stdin?.end();
    ownedChild.kill("SIGTERM");
    await once(ownedChild, "close");
  }
}
