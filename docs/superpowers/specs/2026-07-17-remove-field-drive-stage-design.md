# Remove Field Drive Stage Design

- Status: approved for implementation
- Owners: Fullmag core
- Last updated: 2026-07-17
- Canonical physics note: `docs/physics/0920-time-domain-microstrip-antenna-zeeman-mask.md`

## Problem

Fullmag models Study as ordered persistent state. `study.stages.add_field_drive(...)`
adds a drive that is visible to every subsequent time-evolution stage, while
`study.stages.add_run(...)` only advances LLG. The public API currently has no
symmetrical command for removing a drive from later stages. Users are otherwise
forced to couple a drive to explicit Run identifiers through
`DriveActivation.stage_ids(...)`, which is not the MuMax-style command model.

## Selected design

Add this public command:

```python
study.stages.remove_field_drive(
    "k0-sinc-antenna",
    stage_id="remove-antenna",
)
```

The required positional `drive_id` identifies the persistent
`RegionalFieldDrive` to remove. The optional keyword-only `stage_id` identifies
the zero-duration removal action itself and follows the meaning of `stage_id`
on every other Study command. It never identifies a Run stage or the earlier
`add_field_drive` action.

`RemoveFieldDrive` preserves magnetization, mesh, material state, absolute
solver time, device residency, and output configuration. Its only state change
is removal of exactly one matching entry from `ProblemIR.field_drives` for all
subsequent pipeline stages. The action is visible in stage execution,
provenance, exported Python, and the OpenAPI primitive-stage catalog.

Removing an unknown or already removed `drive_id` fails at the action boundary
with a diagnostic naming the missing identifier. Removing and later adding a
new drive with the same identifier is valid because uniqueness is checked
against the current persistent state. Multiple active drives are independent;
removing one leaves every other drive unchanged.

Automatic sinc sampling is resolved from the state immediately before each
Run. If removal leaves no applicable active sinc drive while automatic sampling
is enabled, the existing fail-closed planner diagnostic remains correct.

## Rejected alternatives

### Mutate `enabled=False`

This would retain a disabled drive inside persistent physical state, blur the
difference between an authored disabled source and an explicit lifecycle
command, and complicate re-adding a replacement with the same identifier.

### Rewrite activation to `stage_ids`

This would couple the source to future Run names, require advance knowledge of
the pipeline, and recreate the exact accidental complexity this feature is
intended to remove.

### Remove by add-stage identifier

This would make one action refer to another action rather than to the physical
source. Moving or renaming the add stage would then alter removal semantics.
The stable physical identifier is `RegionalFieldDrive.id`.

## Contract propagation

### Python and round-trip

`StudyStagesBuilder.remove_field_drive(drive_id, *, stage_id=None)` validates a
non-empty identifier, verifies that the drive exists in current state, records
a typed `remove_field_drive` action using the pre-action problem snapshot, and
removes the drive before later stages are captured. Canonical script export
must reproduce the call with a human-readable string identifier and preserve
the optional action `stage_id`.

### ProblemIR and pipeline

No new persistent `ProblemIR` field is required. The canonical state after the
action is represented by the existing `ProblemIR.field_drives` list without the
removed entry. The pipeline primitive payload is:

```json
{
  "kind": "remove_field_drive",
  "entrypoint_kind": "flat_remove_field_drive",
  "drive_id": "k0-sinc-antenna"
}
```

The authoring primitive-stage enum gains `remove_field_drive`. Unknown payload
fields remain subject to the existing pipeline compatibility rules.

### Planner and runtime

Both explicit script-stage actions and primitive pipeline materialization
remove the drive from the current IR before planning later compute stages. The
synthetic action stage continues in place and emits a bounded stage record
containing `kind`, `drive_id`, and vector count. Its transition metadata is
`continue_in_place`, with no state-transfer operator; normal per-stage backend
materialization remains an implementation detail.

### OpenAPI and Control Room

The OpenAPI extension `x-fullmag-study-primitive-stage-kinds` gains
`remove_field_drive`. There is no new HTTP resource, command endpoint, realtime
event, binary codec, generated transport route, ribbon path, or viewport data
path. HTTP v2 remains the source of truth and websocket behavior remains
event/invalidation-only. Existing generic Study-pipeline consumers receive the
new typed primitive kind and must fail closed if their local catalog is stale.

## Validation

Tests must prove:

1. Python state is unchanged before the action and lacks the selected drive in
   every later Run.
2. Removing one of two drives preserves the other.
3. Unknown and repeated removals fail with the missing `drive_id`.
4. A removed identifier may be added again later.
5. Python export and reload preserve action order, `drive_id`, and action
   `stage_id`.
6. Rust authoring deserializes the new primitive kind and OpenAPI publishes it.
7. CLI explicit-action and primitive-pipeline lowering remove the correct drive
   and preserve continuation metadata.
8. Runtime synthetic-stage provenance records the removal.
9. Automatic sampling after removal considers only drives still present and
   fails closed when none remain.

No native FEM/FDM operator changes are required because the compiled backends
already consume the planner-resolved active drive list for each Run. The
managed host runtime bundle must nevertheless be rebuilt before end-to-end
qualification because the packaged executable contains the changed CLI
pipeline materializer.

## Scope boundary

This change does not add bulk clearing, wildcard removal, enable/disable
mutation, Run-local drive arguments, or automatic source expiry. Those features
would require separate physical and lifecycle contracts.
