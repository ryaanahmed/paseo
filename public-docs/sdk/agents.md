---
title: Agents with the SDK
description: Create, run, find, reuse, parent, and archive coding agents from TypeScript.
nav: Agents
order: 52
category: TypeScript SDK
---

# Agents with the SDK

An agent handle keeps a stable agent ID and exposes the turn lifecycle without exposing daemon RPCs.

## Run an initial prompt

```ts
const agent = await client.agents.create({
  config: {
    provider: "claude/claude-sonnet-5",
  },
  cwd: "/Users/me/dev/storefront",
  prompt: "Review the checkout flow and propose one focused fix.",
  labels: { source: "checkout-review" },
});

const result = await agent.waitForFinish();
console.log(result.status, result.lastMessage);
```

`waitForFinish()` returns one of four statuses:

| Status       | Meaning                                                           |
| ------------ | ----------------------------------------------------------------- |
| `idle`       | The agent is idle; this does not identify an exact turn outcome.  |
| `permission` | The agent needs a person to answer a permission request in Paseo. |
| `error`      | The provider ended the turn with an error.                        |
| `timeout`    | The wait deadline elapsed; the agent may still be running.        |

A timeout does not cancel the agent.

## Keep a session alive for follow-ups

Create an idle session when prompts arrive later:

```ts
const reviewer = await client.agents.create({
  config: {
    provider: "codex/gpt-5.5",
  },
  cwd: "/Users/me/dev/storefront",
  title: "Checkout reviewer",
});

const first = await reviewer.run("Review the current diff.");

if (first.status === "idle") {
  const second = await reviewer.run("Now focus on failure recovery.");
  console.log(second.lastMessage);
}
```

Use `send()` to submit without waiting for idle. Use `run()` to submit and wait for the agent to become idle or need attention. For exact execution settlement, retain the message ID and query its execution record.

## Query durable execution outcomes

On hosts advertising `agentExecutionOutcomes`, read one execution without fetching conversation history:

```ts
const messageId = crypto.randomUUID();
await reviewer.send("Review the current diff.", { messageId });

// Keep the agent ID and message ID in your integration's durable record.
const execution = await reviewer.execution({
  kind: "submission",
  clientMessageId: messageId,
});
```

You can query the same record after reconnecting with `{ kind: "execution", executionId }`. The result contains IDs, provider, execution status and timestamps. It contains no transcript or final answer. Status is `starting`, `running`, `completed`, `failed`, `canceled` or `unknown`.

`null` means there is no matching record. `unknown` means Paseo cannot prove settlement; neither result permits an automatic resubmission. A completed execution still requires your workspace's handoff validation and acceptance. This API reports execution evidence and grants no integration or release authority.

The equivalent CLI query is `paseo agent execution <exact-agent-id> --client-message-id <id> --json`, or `--execution-id <id>`. It returns an array containing the metadata record, or an empty array when absent.

For a notification that must not interrupt active work, send with `activeTurnBehavior: "reject"` and a stable `messageId`. The daemon refuses a busy or archived recipient; it does not steer, replace, queue or unarchive it. A lost acknowledgement remains an inspection problem. Query and non-interrupting send both require the host capability; an older host produces an explicit update error.

## Find agents by label

Set `labels` at creation, then filter on them. The daemon does the matching:

```ts
const page = await client.agents.list({
  filter: { labels: { "issue-provider": "my-tracker" } },
});

for (const { agent } of page.entries) {
  console.log(agent.id, agent.title, agent.status);
}
```

## Continue an agent by ID

```ts
const agent = client.agents.ref("agent_01H8X...");

const result = await agent.run("Now write the fix.");
console.log(result.lastMessage);
```

`ref()` does not contact the daemon. Call `refresh()` first when you need to know whether the agent still exists; it returns `null` if it does not.

## Create a subagent

Create a child through its workspace. The handle owns placement, so the caller does not repeat its directory:

```ts
if (!parent.workspaceId) throw new Error("Parent has no workspace");

const workspace = client.workspaces.ref(parent.workspaceId);
const child = await workspace.agents.create({
  config: {
    provider: "codex/gpt-5.5",
  },
  parent,
  title: "Implement checkout fix",
  prompt: "Implement the accepted checkout plan and run focused tests.",
});
```

`parent` establishes parentage. Archiving a parent cascade-archives its children. Call `detach()` first when a child should continue independently.

## Request structured output

```ts
const schema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    risk: { type: "string", enum: ["low", "medium", "high"] },
  },
  required: ["summary", "risk"],
  additionalProperties: false,
};

const agent = await client.agents.create({
  config: {
    provider: "codex/gpt-5.5",
  },
  cwd: "/Users/me/dev/storefront",
  outputSchema: schema,
  prompt: "Assess the release risk of the current diff.",
});

const result = await agent.waitForFinish();
if (result.status !== "idle" || !result.lastMessage) {
  throw new Error(result.error ?? "Agent returned no structured output");
}

const assessment = JSON.parse(result.lastMessage) as {
  summary: string;
  risk: "low" | "medium" | "high";
};
```

Validate the parsed value in your application before using it as trusted input.

## Read the current state of an agent

```ts
const agent = client.agents.ref("agent_01H8X...");
await agent.refresh();

if (agent.pendingPermissions?.length) {
  console.log(`Waiting on ${agent.pendingPermissions.length} permission request(s)`);
}
console.log(agent.lastUsage?.totalCostUsd, agent.runtimeInfo?.sessionId);
```

In the personal fork, `agent.current()?.role` reads the optional role saved at
creation. Pass `role` or select a `profileId` when creating an agent on a host
advertising `agentRoles`. Role/profile launches against older hosts fail with
update guidance. The saved role survives resume, provider changes and later
profile edits; it grants no authority and is not a runtime configuration setting.

The handle exposes `status`, `capabilities`, `availableModes`, `pendingPermissions`, `activeTurn`, `lastUsage`, `lastError`, `features`, `runtimeInfo`, `archivedAt`, `workspaceId`, and `cwd` as properties. All of them read the last snapshot the handle observed and never fetch.

A handle from `ref()` has observed nothing, so every one of them is `null` until `refresh()`, `run()`, `waitForFinish()`, a timeline refetch, or `subscribe()` delivers a snapshot. Optional values in an observed snapshot also read as `null`. Use `current()` when you need the whole snapshot or need to distinguish those states.

`subscribe()` is a local listener. An owned agent-directory observation supplies its updates:

```ts
const unsubscribe = agent.subscribe(() => {
  if (agent.status === "error") console.error(agent.lastError);
});
const directory = await client.agents.list({ subscribe: {} });

// When this view closes:
unsubscribe();
await directory.subscription.release();
```

## List the commands a session loaded

```ts
const { commands, error } = await agent.commands();
if (error) throw new Error(error);

const skills = commands.filter((command) => command.kind === "skill");
```

The answer comes from the running session, not from a directory scan, so it includes commands and skills built into the provider that never appear on disk. `kind` is the provider's own classification and is optional; treat a missing `kind` as unclassified rather than assuming `"command"`.

A provider that cannot produce a list reports that in `error` and returns an empty `commands` array. The call does not reject.

## Archive or detach

```ts
await agent.archive(); // Soft-deletes the agent and closes its runtime.
await child.detach(); // Keeps the child alive but removes its parent relationship.
```

Closing the SDK connection does not archive agents. Archive temporary agents explicitly, preferably in `finally`.
