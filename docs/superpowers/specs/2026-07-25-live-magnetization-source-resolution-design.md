# Live Magnetization Source Resolution Design

## Problem

The live FEM GPU solver publishes current magnetization through
`latest_fields["m"]` with `source_step`, `source_revision`, and materialization
metadata. The API also carries an older compatibility copy in
`live_state.latest_step.magnetization`. Field metadata selects the current
materialized field, while the FMVP vector route and revision tracker select the
legacy copy unconditionally. This lets the color range advance while the 3D
texture, ETag, and field revision remain frozen at the initial state.

The defect was reproduced against the running API on port 8080: metadata
advanced from source step 14960 to 15019, while two FMVP responses were byte
identical, retained field revision 1, and contained uniform magnetic-node
values `(1, 0.1, 0)`.

## Decision

Use one source-selection function for current in-memory field data. It resolves
`latest_fields`, `preview_cache`, and the legacy live magnetization channel
before metadata, FMVP serialization, and revision change detection consume the
field.

For magnetization:

1. Select between valid `latest_fields["m"]` and `preview_cache["m"]` using the
   existing ordered provenance tuple `(source_step, source_revision,
   materialized_at_unix_ms)`.
2. A selected preview field is authoritative because the preview contract
   always carries explicit provenance.
3. A selected latest field is authoritative when it carries at least one
   explicit provenance field: `source_step`, `source_revision`,
   `materialized_at_unix_ms`, `field_revision`, or `revision`.
4. Use `live_state.latest_step.magnetization` only when no valid authoritative
   cached source exists, or when the only cached latest field is an unversioned
   legacy payload.

For other quantities, preserve the existing latest-versus-preview precedence.

## Compatibility and Scope

- No endpoint, JSON schema, OpenAPI document, FMVP encoding, or frontend type
  changes.
- Preserve unversioned legacy live-magnetization behavior.
- Preserve persisted hysteresis snapshot precedence over all live sources.
- Reject invalid or wrong-domain sources exactly as today.
- Do not modify solver, GPU snapshot, FMVP codec, mesh indexing, or viewport
  rendering.

## Verification

An integration regression test starts with legacy live magnetization `A`, then
applies provenance-rich field frames `B` and `C`. After each frame it verifies:

- metadata statistics and freshness describe the same values as FMVP;
- FMVP uses `B`, then `C`, never `A`;
- the field revision and ETag advance;
- conditional requests using the prior ETag do not return 304 after a newer
  field frame;
- the old unversioned latest-field fixture still prefers current legacy live
  magnetization.

Focused API tests, the full `fullmag-api` router suite, resource-first contract
gates, formatting, and `git diff --check` must pass. A rebuilt API must then be
queried twice during a running simulation to prove changing provenance,
payload hash, revision, and ETag.
