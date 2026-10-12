import type { AgentProfile } from "@getpaseo/protocol/agent-profile";
import type { AgentSessionConfig } from "../agent-sdk-types.js";

/** Resolve a launch profile once; persisted agents keep the resulting snapshot. */
export function resolveAgentProfile(
  config: Partial<AgentSessionConfig>,
  profiles: readonly AgentProfile[],
): Partial<AgentSessionConfig> & { provider: string } {
  const profile = findAgentProfile(config.profileId, profiles);
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
    role: config.role ?? profile?.role,
    contextPolicy: structuredClone(config.contextPolicy ?? profile?.contextPolicy),
  };
}

function findAgentProfile(profileId: string | undefined, profiles: readonly AgentProfile[]) {
  if (!profileId) return undefined;
  const profile = profiles.find((candidate) => candidate.id === profileId);
  if (!profile) throw new Error(`Agent profile ${profileId} not found`);
  return profile;
}
