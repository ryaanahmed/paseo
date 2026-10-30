import { expect, test } from "vitest";
import { ProviderAdmissionOwner, type AdmissionOwnerConfig } from "./provider-admission-owner.js";

const config: AdmissionOwnerConfig = {
  helper: "/fixture/build/worker",
  registrationPath: "/fixture/owner.json",
  epoch: "a".repeat(32),
  manifest: "b".repeat(64),
  parentPid: 42,
  executionRoot: "/fixture/executions",
};
function registration(parentPid = 42) {
  const identity = {
    pid: 43,
    startTicks: 100,
    executablePath: "/fixture/worker",
    sha256: "c".repeat(64),
  };
  return JSON.stringify({
    status: "registered",
    registrationPath: config.registrationPath,
    registration: {
      schema: 1,
      executionRoot: config.executionRoot,
      linuxBootId: "00000000-0000-4000-8000-000000000000",
      consumerEpoch: config.epoch,
      coverageManifestDigest: config.manifest,
      owner: identity,
      parent: { ...identity, pid: parentPid },
      roles: ["provider-launch", "utility-launch", "native-queue"],
    },
  });
}

test("missing owner and physical owner closure close new admission", async () => {
  let close!: () => void;
  let stops = 0;
  const owner = new ProviderAdmissionOwner({
    start: () => ({
      registered: Promise.resolve(registration()),
      closed: new Promise<void>((resolve) => {
        close = resolve;
      }),
      stop: () => {
        stops++;
      },
    }),
  });
  expect(owner.isReady()).toBe(false);
  await owner.start(config);
  expect(owner.isReady()).toBe(true);
  close();
  await Promise.resolve();
  expect(owner.isReady()).toBe(false);
  owner.stop();
  expect(stops).toBe(1);
});

test("wrong parent and lost owner response never publish readiness", async () => {
  let stops = 0;
  const owner = new ProviderAdmissionOwner({
    start: () => ({
      registered: Promise.resolve(registration(99)),
      closed: new Promise<void>(() => undefined),
      stop: () => {
        stops++;
      },
    }),
  });
  await expect(owner.start(config)).rejects.toThrow("identity or coverage");
  expect(owner.isReady()).toBe(false);
  expect(stops).toBe(1);
});

test("stopped registration cannot later reopen admission", async () => {
  let acknowledge!: (value: string) => void;
  const owner = new ProviderAdmissionOwner({
    start: () => ({
      registered: new Promise<string>((resolve) => {
        acknowledge = resolve;
      }),
      closed: new Promise<void>(() => undefined),
      stop: () => undefined,
    }),
  });
  const starting = owner.start(config);
  owner.stop();
  acknowledge(registration());
  await expect(starting).rejects.toThrow("identity or coverage");
  expect(owner.isReady()).toBe(false);
});
