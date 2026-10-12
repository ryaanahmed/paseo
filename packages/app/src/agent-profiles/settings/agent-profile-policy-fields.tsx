import { useCallback, type ReactElement } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AgentRoleSchema } from "@getpaseo/protocol/agent-profile";
import type { FieldControlSize } from "@/components/ui/control-geometry";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SelectField, type SelectFieldOption } from "@/components/ui/select-field";
import { AGENT_ROLES, AGENT_ROLE_DETAILS } from "../roles";
import type {
  AgentProfileFormModel,
  AgentProfileFormState,
  ContextPolicyField,
} from "../internal/profile-form-model";

const noRoleDisplay = { label: "No role" };
const hostDefaultDisplay = { label: "Host default" };
const explicitDisplay = { label: "Explicit limits" };
const roleOptions: SelectFieldOption<string>[] = [
  { id: "none", value: "", label: "No role", testID: "agent-profile-role-option-none" },
  ...AGENT_ROLES.map((role) => ({
    id: role,
    value: role,
    label: AGENT_ROLE_DETAILS[role].label,
    description: AGENT_ROLE_DETAILS[role].description,
    testID: `agent-profile-role-option-${role}`,
  })),
];
const contextModeOptions: SelectFieldOption<"host-default" | "explicit">[] = [
  {
    id: "host-default",
    value: "host-default",
    label: "Host default",
    testID: "agent-profile-context-option-host-default",
  },
  {
    id: "explicit",
    value: "explicit",
    label: "Explicit limits",
    testID: "agent-profile-context-option-explicit",
  },
];
interface ContextField {
  id: ContextPolicyField;
  label: string;
}
const contextFields: readonly ContextField[] = [
  { id: "providerWindowTokens", label: "Provider window (tokens)" },
  { id: "clientWindowTokens", label: "Client window (tokens)" },
  { id: "outputReserveTokens", label: "Output reserve (tokens)" },
  { id: "thresholdTokens", label: "Compaction threshold (tokens)" },
];

interface AgentProfilePolicyFieldsProps {
  model: AgentProfileFormModel;
  state: AgentProfileFormState;
  size: FieldControlSize;
}

export function AgentProfilePolicyFields({
  model,
  state,
  size,
}: AgentProfilePolicyFieldsProps): ReactElement {
  const handleRoleChange = useCallback(
    (value: string) => model.setRole(value ? AgentRoleSchema.parse(value) : null),
    [model],
  );
  const roleDisplay = state.role ? AGENT_ROLE_DETAILS[state.role] : noRoleDisplay;
  const contextDisplay = state.contextMode === "explicit" ? explicitDisplay : hostDefaultDisplay;
  const unsupported = !state.capabilities.agentRoles || !state.capabilities.agentContextPolicy;
  return (
    <>
      {state.capabilities.agentRoles ? (
        <SelectField
          label="Role"
          value={state.role ?? ""}
          selectedDisplay={roleDisplay}
          options={roleOptions}
          onChange={handleRoleChange}
          emptyText="No roles"
          placeholder="No role"
          title="Role"
          hint="Describes responsibility; workspace rules still control authority."
          disabled={state.isSubmitting}
          size={size}
          testID="agent-profile-role-field"
          triggerTestID="agent-profile-role-trigger"
        />
      ) : null}
      {state.capabilities.agentContextPolicy ? (
        <SelectField
          label="Context policy"
          value={state.contextMode}
          selectedDisplay={contextDisplay}
          options={contextModeOptions}
          onChange={model.setContextMode}
          title="Context policy"
          emptyText="No context policies"
          placeholder="Host default"
          disabled={state.isSubmitting}
          size={size}
          testID="agent-profile-context-field"
          triggerTestID="agent-profile-context-trigger"
        />
      ) : null}
      {state.capabilities.agentContextPolicy && state.contextMode === "explicit" ? (
        <View style={styles.fields}>
          {contextFields.map((field) => (
            <ContextTokenField
              key={field.id}
              field={field}
              state={state}
              model={model}
              size={size}
            />
          ))}
          {state.contextError ? (
            <Text style={styles.error} testID="agent-profile-context-error">
              {state.contextError}
            </Text>
          ) : null}
        </View>
      ) : null}
      {unsupported ? (
        <Text style={styles.notice} testID="agent-profile-capability-notice">
          Update this host to edit all profile settings. Existing roles and context policies are
          preserved.
        </Text>
      ) : null}
    </>
  );
}

interface ContextTokenFieldProps extends AgentProfilePolicyFieldsProps {
  field: ContextField;
}

function ContextTokenField({ field, state, model, size }: ContextTokenFieldProps): ReactElement {
  const handleChange = useCallback(
    (value: string) => model.setContextInput(field.id, value),
    [field.id, model],
  );
  return (
    <Field label={field.label} testID={`agent-profile-${field.id}-field`}>
      <FormTextInput
        initialValue={state.contextInputs[field.id]}
        onChangeText={handleChange}
        keyboardType="number-pad"
        editable={!state.isSubmitting}
        size={size}
        accessibilityLabel={field.label}
        testID={`agent-profile-${field.id}-input`}
      />
    </Field>
  );
}

const styles = StyleSheet.create((theme) => ({
  fields: { gap: theme.spacing[4] },
  error: { color: theme.colors.statusDanger, fontSize: theme.fontSize.base },
  notice: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
