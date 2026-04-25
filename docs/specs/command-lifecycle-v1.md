# Command Lifecycle v1

- Status: canonical command read-model contract
- Last updated: 2026-04-25
- Parent runtime spec: `docs/specs/session-run-api-v1.md`
- API reference: `docs/specs/control-room-api-endpoint-reference-v1.md`
- Program ADR: `docs/adr/0012-canonicalization-backbone.md`

## Purpose

This spec defines the command lifecycle read-model used by the resource-first
control room API. Command state is not inferred from transient UI events.

## Canonical States

Public command `status` values are:

- `queued`: accepted into the local command queue and waiting for runtime pickup.
- `accepted`: accepted by the control plane but not yet represented as queued work.
- `dispatched`: handed to the runtime command lane.
- `running`: actively being executed by the runtime.
- `completed`: terminal successful command processing.
- `rejected`: terminal validation/admission rejection.
- `failed`: terminal runtime/control-plane failure.

`completion_status` is an outcome field, not the queue state. Current outcome
values are `succeeded`, `completed`, `cancelled`, `rejected`, `failed`, and
`unknown`.

## Resources

The canonical read-model resources are:

- `GET /v1/live/current/commands/status`
- `GET /v1/live/current/commands/{command_id}`

Both resources expose command ids, queue sequence, command kind, lifecycle
status, timestamps, optional completion outcome, and error details.

`status.resources.command_completion_revision` is the canonical invalidation
pointer for command completion. It advances from the command ledger sequence and
is separate from `commands_revision`, which remains the queue/ledger collection
revision.

## Rules

- UI must use command resources or resource hooks, not local event inference.
- Terminal state rendering must key off `status`, not `completion_status`.
- `completion_status` may be absent until terminal completion data exists.
- New public lifecycle states require this spec, OpenAPI, Rust DTOs, and
  TypeScript contracts to change together.
