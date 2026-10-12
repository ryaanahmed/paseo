import { describe, expect, it } from "vitest";
import type { AgentProfile } from "@getpaseo/protocol/messages";
import {
  materializeAgentProfile,
  reconcileMaterializedProfileMode,
  toAgentConfigApply,
} from "./materialize-profile";

function profile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: "ui-work",
    name: "UI work",
    provider: "claude",
    ...overrides,
  };
}

describe("materializeAgentProfile", () => {
  it("resolves every field a full profile names", () => {
    expect(
      materializeAgentProfile(
        profile({
          model: "claude-opus-5",
          modeId: "plan",
          thinkingOptionId: "think-hard",
          featureValues: { web_search: true },
        }),
      ),
    ).toEqual({
      provider: "claude",
      modelId: "claude-opus-5",
      modeId: "plan",
      thinkingOptionId: "think-hard",
      featureValues: { web_search: true },
    });
  });

  it("treats omitted and blank fields the same", () => {
    expect(materializeAgentProfile(profile({ model: "   ", modeId: "" }))).toEqual({
      provider: "claude",
      modelId: "",
      modeId: "",
      thinkingOptionId: "",
      featureValues: {},
    });
  });

  it("trims stored ids", () => {
    expect(materializeAgentProfile(profile({ model: " claude-opus-5 " })).modelId).toBe(
      "claude-opus-5",
    );
  });
});

describe("toAgentConfigApply", () => {
  it("sends every value the profile names", () => {
    expect(
      toAgentConfigApply(
        materializeAgentProfile(
          profile({
            model: "claude-opus-5",
            modeId: "plan",
            thinkingOptionId: "think-hard",
            featureValues: { web_search: true },
          }),
        ),
      ),
    ).toEqual({
      modelId: "claude-opus-5",
      modeId: "plan",
      thinkingOptionId: "think-hard",
      featureValues: { web_search: true },
    });
  });

  it("omits what the profile leaves alone rather than clearing it", () => {
    expect(toAgentConfigApply(materializeAgentProfile(profile({ modeId: "plan" })))).toEqual({
      modeId: "plan",
    });
  });

  it("omits an empty feature map so the agent keeps its own feature values", () => {
    expect(
      toAgentConfigApply(materializeAgentProfile(profile({ featureValues: {} }))),
    ).not.toHaveProperty("featureValues");
  });

  it("never carries a provider, which a running agent cannot change", () => {
    expect(
      toAgentConfigApply(materializeAgentProfile(profile({ model: "claude-opus-5" }))),
    ).not.toHaveProperty("provider");
  });
});

describe("reconcileMaterializedProfileMode", () => {
  it("waits when the current provider mode catalog is unknown", () => {
    expect(
      reconcileMaterializedProfileMode(materializeAgentProfile(profile({ modeId: "plan" })), null),
    ).toBeNull();
  });

  it("drops a profile mode removed from the current provider catalog", () => {
    expect(
      reconcileMaterializedProfileMode(
        materializeAgentProfile(profile({ modeId: "removed-mode" })),
        ["plan", "default"],
      ),
    ).toMatchObject({ modeId: "" });
  });

  it("preserves a profile mode still offered by the provider", () => {
    expect(
      reconcileMaterializedProfileMode(materializeAgentProfile(profile({ modeId: "plan" })), [
        "plan",
        "default",
      ]),
    ).toMatchObject({ modeId: "plan" });
  });
});

it("keeps context-policy profile identity for creation but excludes it from live config edits", () => {
  const resolved = materializeAgentProfile(
    profile({
      contextPolicy: {
        providerWindowTokens: 1000000,
        clientWindowTokens: 1000000,
        outputReserveTokens: 64000,
        thresholdTokens: 512000,
      },
    }),
  );
  expect(resolved.profileId).toBe("ui-work");
  expect(toAgentConfigApply(resolved)).not.toHaveProperty("profileId");
});

it("keeps role-only profile identity without applying role or context to a running agent", () => {
  const resolved = materializeAgentProfile(profile({ role: "ustad", model: "claude-opus-5" }));
  expect(resolved.profileId).toBe("ui-work");
  expect(toAgentConfigApply(resolved)).toEqual({ modelId: "claude-opus-5" });
});

it("does not infer a role from a saved variant name", () => {
  const resolved = materializeAgentProfile(profile({ name: "Ustad-Astra" }));
  expect(resolved).not.toHaveProperty("profileId");
  expect(resolved).not.toHaveProperty("role");
});
