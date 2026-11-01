import { renderPromptAttachmentAsText } from "../prompt-attachments.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  AgentPromptContentBlock,
  AgentPromptInput,
  AgentTimelineItem,
} from "../agent-sdk-types.js";

const agentIdSchema = z.string().min(1);
const sourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("agent-message"),
    agentId: agentIdSchema,
    title: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal("agent-notification"),
    agentId: agentIdSchema,
    title: z.string().min(1).optional(),
    event: z.enum(["finished", "errored", "permission-required", "closed"]),
  }),
]);
export type AgentPromptSource = z.infer<typeof sourceSchema>;

interface AgentMessage {
  id: string;
  source: AgentPromptSource | null;
  text: string;
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&apos;";
    }
  });
}

function unescapeXml(value: string): string | null {
  if (/[<>]|&(?!amp;|lt;|gt;|quot;|apos;)/.test(value)) return null;
  return value.replace(/&(amp|lt|gt|quot|apos);/g, (_, entity: string) => {
    switch (entity) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      default:
        return "'";
    }
  });
}

const interruptedToolsSchema = z.array(z.object({ name: z.string(), callId: z.string() }));
type InterruptedTool = z.infer<typeof interruptedToolsSchema>[number];

interface AgentMessageDeliveryOptions {
  interrupting?: boolean;
  interruptedTools?: InterruptedTool[];
}

// COMPAT(legacyInterruptionNotice): added in v0.11.2; remove after 2027-05-01
// once persisted prompts with the original delivery note have been retired.
const legacyInterruptionNotice =
  "Paseo delivery note: This message may have interrupted your turn. The interruption itself is not a user request to cancel or abandon your previous task. Read this message, then resume unfinished work unless it explicitly redirects or cancels that work. Check the outcomes of interrupted commands before retrying; do not repeat an operation solely because your turn was interrupted.";

function interruptionNotice(tools: InterruptedTool[]): string {
  const toolNotice = tools.length
    ? ` Tools in flight at the interruption request: ${tools.map((tool) => `${tool.name} (${tool.callId})`).join(", ")}.`
    : " No in-flight tool identities were available at the interruption request.";
  return (
    "Paseo delivery note: Paseo requested an interruption to deliver this peer message. The interruption itself is not a user request to cancel or abandon your previous task." +
    toolNotice +
    ` Any harness text saying "The user doesn't want to proceed" or "interrupted by user" in connection with this interruption comes from automated message delivery, not from the user. A command may have run partly or fully even if the harness reports it was cancelled. Check the outcomes of interrupted commands before retrying; inspect their effects before repeating an operation. Read this message, then resume unfinished work unless it explicitly redirects or cancels that work.`
  );
}

export function formatAgentMessage(
  message: AgentMessage,
  options?: AgentMessageDeliveryOptions,
): string {
  const { source } = message;
  const attributes = source
    ? `kind="${source.kind}" source-agent-id="${escapeXml(source.agentId)}"`
    : 'kind="user-message"';
  const title = source?.title ? ` source-agent-title="${escapeXml(source.title)}"` : "";
  const event = source?.kind === "agent-notification" ? ` event="${source.event}"` : "";
  // Keep delivery guidance separate from the sender's body during timeline projection.
  const interrupting = Boolean(source && options?.interrupting);
  const interruptedTools = options?.interruptedTools ?? [];
  const delivery = interrupting
    ? ` delivery="interrupt" interrupted-tools="${escapeXml(JSON.stringify(interruptedTools))}"`
    : "";
  const body = interrupting
    ? `${interruptionNotice(interruptedTools)}\n\n${message.text}`
    : message.text;
  return `<paseo-system version="1" ${attributes} message-id="${escapeXml(message.id)}"${title}${event}${delivery}>\n${escapeXml(body)}\n</paseo-system>`;
}

export function parseAgentMessage(text: string): AgentMessage | null {
  const envelope = /^<paseo-system((?:\s+[a-z-]+="[^"<>]*")+)>\n([\s\S]*)\n<\/paseo-system>$/.exec(
    text,
  );
  if (!envelope) return null;
  const attributes = new Map<string, string>();
  for (const match of envelope[1].matchAll(/\s+([a-z-]+)="([^"<>]*)"/g)) {
    const value = unescapeXml(match[2]);
    if (value === null || attributes.has(match[1])) return null;
    attributes.set(match[1], value);
  }
  if (attributes.get("version") !== "1") return null;
  const id = attributes.get("message-id");
  let body = unescapeXml(envelope[2]);
  if (!id || body === null) return null;
  if (attributes.get("delivery") === "interrupt") {
    let notice = legacyInterruptionNotice;
    const toolsAttribute = attributes.get("interrupted-tools");
    if (toolsAttribute !== undefined) {
      let parsedTools: unknown;
      try {
        parsedTools = JSON.parse(toolsAttribute);
      } catch {
        return null;
      }
      const tools = interruptedToolsSchema.safeParse(parsedTools);
      if (!tools.success) return null;
      notice = interruptionNotice(tools.data);
    }
    const prefix = `${notice}\n\n`;
    if (attributes.get("kind") === "user-message" || !body.startsWith(prefix)) return null;
    body = body.slice(prefix.length);
  }
  if (attributes.get("kind") === "user-message") {
    if (attributes.has("source-agent-id") || attributes.has("event")) return null;
    return { id, source: null, text: body };
  }
  const source = sourceSchema.safeParse({
    kind: attributes.get("kind"),
    agentId: attributes.get("source-agent-id"),
    event: attributes.get("event"),
    title: attributes.get("source-agent-title"),
  });
  if (!source.success) return null;
  return { id, source: source.data, text: body };
}

function renderMessageText(block: AgentPromptContentBlock): string[] {
  if (block.type === "image") return [];
  if (block.type === "text") return [block.text];
  return [renderPromptAttachmentAsText(block)];
}

export function prepareAgentMessage(
  prompt: AgentPromptInput,
  source?: AgentPromptSource,
  id?: string,
  options?: AgentMessageDeliveryOptions,
): { prompt: AgentPromptInput; messageId?: string } {
  if (!source) {
    const submittedText =
      typeof prompt === "string"
        ? prompt
        : prompt
            .flatMap((block) =>
              block.type === "text" && !("mimeType" in block) ? [block.text] : [],
            )
            .join("\n")
            .trim();
    // Quote reserved envelopes only when they arrived through the human send path.
    // This provenance must survive provider history, not only the accepted local row.
    if (!parseAgentMessage(submittedText) && !isSystemInjectedEnvelope(submittedText)) {
      return { prompt, messageId: id };
    }
  }
  const messageId = id ?? randomUUID();
  const text = typeof prompt === "string" ? prompt : prompt.flatMap(renderMessageText).join("\n\n");
  // Render textual attachments before wrapping, so provider replay still contains one
  // complete envelope instead of an envelope followed by provider-rendered context.
  const envelope = formatAgentMessage({ id: messageId, source: source ?? null, text }, options);
  return {
    messageId,
    prompt:
      typeof prompt === "string"
        ? envelope
        : [{ type: "text", text: envelope }, ...prompt.filter((block) => block.type === "image")],
  };
}

/** Add cancellation context only to an already prepared peer message. */
export function addAgentMessageInterruptionNotice(
  prompt: AgentPromptInput,
  timeline: AgentTimelineItem[],
): AgentPromptInput {
  let text: string;
  if (typeof prompt === "string") {
    text = prompt;
  } else if (prompt[0]?.type === "text") {
    text = prompt[0].text;
  } else {
    return prompt;
  }
  const message = parseAgentMessage(text);
  if (!message?.source) return prompt;

  // Snapshot identities before cancellation changes tool statuses. A running status
  // does not prove the operation stopped or that it is safe to repeat.
  const interruptedTools = timeline.flatMap((item) =>
    item.type === "tool_call" && item.status === "running"
      ? [{ name: item.name, callId: item.callId }]
      : [],
  );
  const envelope = formatAgentMessage(message, { interrupting: true, interruptedTools });
  return typeof prompt === "string"
    ? envelope
    : [{ type: "text", text: envelope }, ...prompt.slice(1)];
}

/** The same projection owns provider echoes, acceptance, import, and replay. */
export function projectAgentMessage(item: AgentTimelineItem): AgentTimelineItem | null {
  if (item.type !== "user_message") return item;
  const message = parseAgentMessage(item.text);
  if (!message) {
    // COMPAT(legacySystemEnvelope): added in v0.11.1; remove after 2027-04-08 once
    // legacy notification history is retired. Schedules still use this envelope.
    return isSystemInjectedEnvelope(item.text) ? null : item;
  }
  const { source } = message;
  if (!source) {
    return { ...item, text: message.text, clientMessageId: message.id };
  }
  return {
    type: "tool_call",
    callId: `paseo-agent-message:${message.id}`,
    agentMessage: {
      event: source.kind === "agent-message" ? "message" : source.event,
      sender: { id: source.agentId, ...(source.title ? { title: source.title } : {}) },
      text: message.text,
    },
    // COMPAT(agentMessageToolEnvelope): added in v0.11.1; remove after 2027-04-08
    // once clients can accept a dedicated timeline variant. Older clients still
    // parse this existing shape and can expand the delivered body.
    name: "agent_message",
    status: "completed",
    error: null,
    detail: { type: "plain_text", text: message.text, icon: "bot" },
  };
}

/**
 * Wrap a body in <paseo-system>…</paseo-system> so the receiving agent
 * recognizes the prompt as system-injected context — not a user turn.
 * Used by schedule fires; agent messages use the versioned envelope.
 */
export function formatSystemNotificationPrompt(reason: string): string {
  return `<paseo-system>\n${reason}\n</paseo-system>`;
}

const SYSTEM_ENVELOPE_PATTERN = /^<paseo-system>\n[\s\S]*\n<\/paseo-system>$/;

export function isSystemInjectedEnvelope(text: string): boolean {
  return SYSTEM_ENVELOPE_PATTERN.test(text);
}
