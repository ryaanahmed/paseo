import type { AgentRole } from "@getpaseo/protocol/agent-profile";

export const AGENT_ROLE_DETAILS: Record<AgentRole, { label: string; description: string }> = {
  ustad: {
    label: "Ustad",
    description:
      "Coordinate the workspace, accept work and manage authorized integration and releases.",
  },
  mushir: {
    label: "Mushir",
    description: "Think and design with you, producing decisions or a design handoff.",
  },
  karigar: {
    label: "Karigar",
    description: "Own a substantial workstream and coordinate bounded assignments.",
  },
  shagird: {
    label: "Shagird",
    description:
      "Complete one bounded implementation, investigation, review or integration assignment.",
  },
};

export const AGENT_ROLES: readonly AgentRole[] = ["ustad", "mushir", "karigar", "shagird"];
