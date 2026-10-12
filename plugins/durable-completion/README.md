# Durable completion notifications

This optional server plugin watches exact, keyed agent submissions and delivers
bounded outcome metadata to an explicitly selected coordinator. It does not
launch workers, inspect their answers, parse handoffs, or grant integration
authority. SA and BandLab retain their own workspace rules and model defaults.

Install this directory explicitly on a fork daemon advertising
`agentExecutionOutcomes`. Stock 0.11.2 is insufficient despite the manifest's
version range. This plugin also requires `onReady` and `dataDirectory` from the
plugin server API. It is not enabled by the builtin plugin registry.

## Submission contract

1. Allocate a stable client message ID and a unique watch ID.
2. Register `completion.watch` through the plugin RPC API, supplying `id`,
   `agentId`, `clientMessageId`, `recipientId`, and `requireParentOwnership`.
3. Submit the worker prompt with that exact client message ID.
4. Query `completion.get` with the watch ID to inspect notification delivery.
5. Use `completion.cancel` to retire a watch whose submission was abandoned.

Register before submitting, so fast completion cannot outrun the subscription.
Re-registering the same watch is idempotent; changed identity is rejected. Use a
new watch and submission ID for a new assignment. At most 256 watches can await
delivery per installation. Public APIs operate against the selected daemon;
execution IDs must be resolved on that same host.

Only primary foreground executions are tracked by submission. Steers,
out-of-band commands and autonomous provider turns are not new assignments.
An absent record does not establish that submission was safe to repeat.

## Delivery and recovery

A subscription remains pending while its execution is starting/running, or
while its recipient is busy. Explicit completed, failed and canceled outcomes
produce a small notification with delivery, agent, submission, execution and
turn IDs. The plugin never requests a transcript or copies a final answer.
Permission pauses do not settle an execution. Delivery never registers a
reciprocal completion callback.

The plugin checks the requested parent relationship before delivery when
`requireParentOwnership` is true. An archived/missing recipient or changed parent
blocks delivery. The daemon's `reject` send mode refuses concurrent work without
interrupting or unarchiving the recipient. A notification remains execution
evidence; it cannot confer a workspace seat or authorize integration.

Records live in the installation's private `dataDirectory`, isolated by plugin
ID under the daemon home. Atomic file replacement survives process restart;
this does not claim transactional power-loss durability. Startup and lifecycle
events reconcile pending records; a five-second I/O timer retries pending
queries and busy recipients without creating polling agent turns.

A delivery interrupted by plugin shutdown reuses its persisted message ID and
body. Native message receipts deduplicate known accepted messages. Uncertain
admission remains `unknown`, with no automatic retry. An execution surviving
only as a running record after daemon restart is also `unknown`; idle status
cannot repair missing provider evidence. Query/storage failures stay pending
with a bounded error code. These limitations are visible through `completion.get`.

## Workspace adoption

Enable one notification owner per assignment. Disable the former terminal
notification path for that assignment before adopting this plugin. Existing
SA receipts/dispatch and BL's ACPX/CakeBuild mechanisms remain until their
consumer bridges are explicitly migrated and verified. A foreground agent's
outcome never establishes the result of a detached CakeBuild job.
