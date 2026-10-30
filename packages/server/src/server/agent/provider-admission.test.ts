import { ChildProcess } from "node:child_process";
import { expect, test } from "vitest";
import {
  prepareProviderLaunch,
  providerAdmissionConfig,
  ProviderAdmissionBlocked,
  type ProviderAdmissionPorts,
} from "./provider-admission.js";

const config = { helper: "/fixture/build/worker", bytes: 1024 };

function fixture(reply = JSON.stringify({ status: "acquired", id: "runtime-one", bytes: 1024 })) {
  const launches: Array<{ command: string; args: string[] }> = [];
  const child = new ChildProcess();
  const ports: ProviderAdmissionPorts = {
    reserve: async () => reply,
    cancel: async () => undefined,
    spawn: (command, args) => {
      launches.push({ command, args });
      return child;
    },
    newRuntimeId: () => "runtime-one",
  };
  return { ports, launches, child };
}

test("required gate with missing or malformed configuration refuses launch", () => {
  expect(providerAdmissionConfig({})).toBeNull();
  expect(() => providerAdmissionConfig({ PASEO_PROVIDER_ADMISSION: "required" })).toThrow(
    ProviderAdmissionBlocked,
  );
  expect(() =>
    providerAdmissionConfig({
      PASEO_PROVIDER_ADMISSION: "required",
      PASEO_PROVIDER_ADMISSION_HELPER: "relative",
      PASEO_PROVIDER_ADMISSION_BYTES: "1024",
    }),
  ).toThrow(ProviderAdmissionBlocked);
});

test("one physical runtime gets one custody wrapper; exact argv survives", async () => {
  const f = fixture();
  const ticket = await prepareProviderLaunch(config, f.ports);
  expect(f.launches).toEqual([]);
  expect(ticket.spawn("/provider", ["a b", "--regex=(x|y)"])).toBe(f.child);
  expect(f.launches).toEqual([
    {
      command: config.helper,
      args: [
        "memory",
        "launch",
        "--id",
        "runtime-one",
        "--bytes",
        "1024",
        "--",
        "/provider",
        "a b",
        "--regex=(x|y)",
      ],
    },
  ]);
  expect(() => ticket.spawn("/provider", [])).toThrow("already used");
  // An exited direct child does not release custody; only the Go supervisor can.
  f.child.emit("exit", 0, null);
  expect(f.launches).toHaveLength(1);
});

test.each([
  JSON.stringify({ status: "blocked", id: "runtime-one", reason: "Windows build held" }),
  JSON.stringify({ status: "acquired", id: "other", bytes: 1024 }),
  JSON.stringify({ status: "acquired", id: "runtime-one", bytes: 2048 }),
  "truncated",
])("blocked or uncertain reserve cannot start a provider: %s", async (reply) => {
  const f = fixture(reply);
  await expect(prepareProviderLaunch(config, f.ports)).rejects.toBeInstanceOf(
    ProviderAdmissionBlocked,
  );
  expect(f.launches).toEqual([]);
});

test("failed helper and late reserve response never launch hidden work", async () => {
  const f = fixture();
  f.ports.reserve = async () => {
    throw new Error("helper timed out");
  };
  await expect(prepareProviderLaunch(config, f.ports)).rejects.toThrow("helper timed out");
  expect(f.launches).toEqual([]);
});

test("disabled gate preserves the existing argv without a reservation", async () => {
  const f = fixture();
  f.ports.reserve = async () => {
    throw new Error("unexpected reserve");
  };
  const ticket = await prepareProviderLaunch(null, f.ports);
  ticket.spawn("/provider", ["app-server"]);
  expect(f.launches).toEqual([{ command: "/provider", args: ["app-server"] }]);
});

test("a lost reserve reply is fenced by no-start cancellation before retry", async () => {
  const f = fixture();
  const canceled: string[] = [];
  f.ports.reserve = async () => {
    throw new Error("lost acknowledgement");
  };
  f.ports.cancel = async (_config, runtimeId) => {
    canceled.push(runtimeId);
  };
  await expect(prepareProviderLaunch(config, f.ports)).rejects.toThrow("lost acknowledgement");
  expect(canceled).toEqual(["runtime-one"]);
  expect(f.launches).toEqual([]);
});

test("canceling an unused ticket fences a later spawn without releasing a launched scope", async () => {
  const f = fixture();
  const canceled: string[] = [];
  f.ports.cancel = async (_config, runtimeId) => {
    canceled.push(runtimeId);
  };
  const unused = await prepareProviderLaunch(config, f.ports);
  await unused.cancelUnused();
  expect(() => unused.spawn("/provider", [])).toThrow("already used");
  const launched = await prepareProviderLaunch(config, f.ports);
  launched.spawn("/provider", []);
  await launched.cancelUnused();
  expect(canceled).toEqual(["runtime-one"]);
  expect(f.launches).toHaveLength(1);
});
