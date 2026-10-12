import { memo, useCallback, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useShallow } from "zustand/shallow";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { useSessionStore } from "@/stores/session-store";
import { AGENT_ROLE_DETAILS } from "./roles";

const DETAILS_HEADER = { title: "Role and context" };

/** Read the agent snapshot; mutable profiles never supply an existing agent's role or limits. */
export const AgentLaunchDetails = memo(function AgentLaunchDetails({
  serverId,
  agentId,
}: {
  serverId: string;
  agentId: string;
}) {
  const [open, setOpen] = useState(false);
  const showDetails = useCallback(() => setOpen(true), []);
  const hideDetails = useCallback(() => setOpen(false), []);
  const launch = useSessionStore(
    useShallow((state) => {
      const session = state.sessions[serverId];
      const agent = session?.agents?.get(agentId);
      return {
        role: agent?.role,
        policy: agent?.contextPolicy,
        status: agent?.contextStatus,
        hostname: session?.serverInfo?.hostname,
      };
    }),
  );
  if (!launch.role && !launch.policy) return null;
  const role = launch.role ? AGENT_ROLE_DETAILS[launch.role] : null;
  const label = role?.label ?? "Context";

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onPress={showDetails}
        accessibilityLabel="Inspect saved role and context"
        testID="agent-launch-details-trigger"
      >
        {label}
      </Button>
      <AdaptiveModalSheet
        visible={open}
        onClose={hideDetails}
        header={DETAILS_HEADER}
        testID="agent-launch-details"
      >
        <View style={styles.content}>
          {launch.hostname ? <Detail label="Execution host" value={launch.hostname} /> : null}
          {role ? (
            <View style={styles.section}>
              <Detail label="Role at creation" value={role.label} />
              <Text style={styles.hint}>{role.description}</Text>
              <Text style={styles.hint}>
                Workspace instructions determine ownership and authority.
              </Text>
            </View>
          ) : null}
          <Text style={styles.hint}>
            These launch settings belong to this agent. Editing a profile or applying its model
            settings does not change them.
          </Text>
          {launch.policy ? (
            <View style={styles.section}>
              <Text style={styles.heading}>Requested context</Text>
              <Detail label="Provider window" value={tokens(launch.policy.providerWindowTokens)} />
              <Detail label="Client window" value={tokens(launch.policy.clientWindowTokens)} />
              <Detail label="Output reserve" value={tokens(launch.policy.outputReserveTokens)} />
              <Detail label="Compaction threshold" value={tokens(launch.policy.thresholdTokens)} />
            </View>
          ) : (
            <Text style={styles.hint}>
              Context uses the host default. No explicit limits were saved.
            </Text>
          )}
          {launch.status ? (
            <View style={styles.section}>
              <Text style={styles.heading}>Observed scope limits</Text>
              <Detail label="Effective input" value={tokens(launch.status.effectiveInputTokens)} />
              <Detail label="Base threshold" value={tokens(launch.status.baseThresholdTokens)} />
              <Detail label="Limiting factor" value={launch.status.limitingReason} />
              <Detail
                label="Observed at"
                value={new Date(launch.status.observedAt).toLocaleString()}
              />
              <Text style={styles.hint}>
                This is the last scope reading, not a measurement of the next request.
              </Text>
            </View>
          ) : (
            <Text style={styles.hint}>No effective scope reading is available.</Text>
          )}
        </View>
      </AdaptiveModalSheet>
    </>
  );
});

function tokens(value: number): string {
  return `${value.toLocaleString()} tokens`;
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.detail}>
      <Text style={styles.hint}>{label}</Text>
      <Text style={styles.value}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  content: { gap: theme.spacing[4] },
  section: { gap: theme.spacing[2] },
  detail: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  heading: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  value: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  hint: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
