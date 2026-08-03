# Headless API Telemetry Design

Date: 2026-08-03

## Objective

Allow an explicitly configured headless Fullmag run to publish its real live scalar rows to the existing resource-first API. This is required to qualify that `tableautosave`, live telemetry, and independently recomputed global average magnetization describe the same solver state during the FEM P2 versus FDM/Newell SP4 comparison.

The default headless behavior remains API-free. No scalar data may be reconstructed or replayed from artifacts and presented as live API evidence.

## Current failure

`run_script_mode()` currently calls `init_api_port_explicit(0)` for every `--headless` execution. This ignores an explicit nonzero `FULLMAG_API_PORT`, leaves no API endpoint to query, and causes the live publisher to target `localhost:0`.

The non-headless workaround is unsuitable for the fixed SP4 mesh. Startup synchronously posts a full JSON snapshot containing large metadata and FEM topology. With approximately 1.08 million elements, that request exceeds the 180-second bootstrap timeout before the solver starts.

## Selected design

### Headless port selection

- Without `FULLMAG_API_PORT`, `--headless` keeps the existing literal port `0` behavior.
- With an explicitly configured nonzero `FULLMAG_API_PORT`, headless resolves and validates that port through the existing port resolver.
- Headless never launches a browser, frontend, or API process. The caller must start a compatible `fullmag-api` process on the requested port.
- `FULLMAG_API_PORT=0` remains an explicit opt-out.
- An invalid, occupied, or incompatible explicit port fails before simulation rather than silently reverting to API-free execution.

### Scalar-first publication

For an existing compatible API, `sync_current_live_delta()` sends the scalar frame before session, runtime, field, or mesh-bearing frames. A scalar row is therefore committed through the dedicated internal scalar bridge before a large metadata or FEM runtime frame can time out.

The scalar frame keeps the existing `session_id`, row-upsert, scalar revision, and table-autosave cadence contracts. Publication failure remains visible in live-publisher diagnostics; it is not converted into a successful run claim.

This ordering is deliberately narrow. It does not make the legacy internal JSON bridge an acceptable long-term transport for heavy FEM topology.

## Data flow

1. The caller starts the packaged `fullmag-api` on a known loopback port.
2. The managed headless command receives the same nonzero port through `FULLMAG_API_PORT`.
3. The CLI validates compatibility but does not spawn UI processes.
4. The solver emits a real `CurrentLiveScalarRow` according to `tableautosave` cadence.
5. The publisher first posts that row to `/v1/internal/live/current/scalars`.
6. The API updates the current session's scalar resource and revision.
7. Qualification reads the authoritative public resource `GET /v2/sessions/current/data/scalars`.
8. The returned `mx`, `my`, `mz`, and `e_demag` are compared with `scalars.csv` from the same run and with magnetization recomputed from `m_final` using magnetic-volume weighting.

## Resource-first contract

- The browser-facing source of truth remains `GET /v2/sessions/current/data/scalars`.
- No public `/v1` route is added or exposed to frontend consumers.
- OpenAPI v2 schemas, generated TypeScript types, generated transport, frontend facades, hooks, codecs, ribbon, and viewport are unchanged because the public resource shape is unchanged.
- The existing `/v1/internal/live/current/*` bridge remains transitional runtime plumbing only.
- Heavy topology remains owned by the v2 binary/scoped data plane. This change does not widen status or scalar JSON with mesh arrays.
- Removal criterion for the transitional internal mesh/runtime JSON bridge: replace it with a bounded binary or resource-identity publication path, then remove heavy `fem_mesh` and mesh-bearing metadata from internal JSON frames.

## Error handling

- Explicit nonzero headless API port with no compatible API: fail closed before solver execution.
- Scalar frame rejected or timed out: record publication failure and fail the telemetry qualification; artifact rows alone are insufficient evidence.
- Heavy session/runtime frame timeout after a scalar succeeds: preserve the scalar resource, expose the heavy-frame failure diagnostically, and do not claim full control-room synchronization.
- API scalar resource lacking the expected run/session or final row: qualification fails.
- Any mismatch between API telemetry, `scalars.csv`, and independently weighted `m_final`: qualification fails.

## Verification

### Focused tests

- Headless without `FULLMAG_API_PORT` resolves port `0`.
- Headless with explicit `FULLMAG_API_PORT=18233` resolves and validates `18233` without spawning control-room processes.
- Explicit `FULLMAG_API_PORT=0` remains disabled.
- Delta publication calls scalar synchronization before a deliberately blocking/failing heavy frame.
- Scalar failure remains a failed publication cycle.
- Existing non-headless port resolution and publisher fallback tests remain green.

### Managed scientific qualification

- Build a separate exact-match managed P2 runtime.
- Run the fixed SP4 mesh and state used by the P1 root-cause gate.
- Capture the real `/v2/sessions/current/data/scalars` response during that same run.
- Require P2 initial demag energy relative error versus FDM/Newell to be at most 1%.
- Require API and table `mx`, `my`, `mz` equality within `1e-9` absolute tolerance.
- Require the table/API average to match magnetic-volume-weighted `m_final` within `1e-9`.
- Preserve P1 evidence that variational and recovered energies agree internally while P1 differs from FDM/Newell by approximately 5.23%.

## Scope exclusions

- No frontend or OpenAPI v2 change.
- No automatic API or browser launch in headless mode.
- No replay of artifact data into API state.
- No merge, commit, or FEM/FDM equivalence claim from this change alone.
- No claim that the heavy topology transport problem is solved.
