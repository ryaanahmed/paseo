import type { AgentProfile } from "@getpaseo/protocol/agent-profile";
import type { AgentSessionConfig } from "../agent-sdk-types.js";

/** Resolve a launch profile once; persisted agents keep the resulting snapshot. */
export function resolveAgentProfile(
  config: Partial<AgentSessionConfig>,
  profiles: readonly AgentProfile[],
): Partial<AgentSessionConfig> & { provider: string } {
  const profile = config.profileId
    ? profiles.find((candidate) => candidate.id === config.profileId)
    : undefined;
  if (config.profileId && !profile) {
    throw new Error(`Agent profile ${config.profileId} not found`);
  }
  const provider = config.provider ?? profile?.provider;
  if (!provider) {
    throw new Error("Agent creation requires a provider or profileId");
  }

  // Undefined request fields must not erase required policy or profile defaults.
  return {
    ...config,
    provider,
    model: config.model ?? profile?.model,
    modeId: config.modeId ?? profile?.modeId,
    thinkingOptionId: config.thinkingOptionId ?? profile?.thinkingOptionId,
    featureValues:
      config.featureValues || profile?.featureValues
        ? structuredClone({ ...profile?.featureValues, ...config.featureValues })
        : undefined,
    contextPolicy: structuredClone(config.contextPolicy ?? profile?.contextPolicy),
  };
}
