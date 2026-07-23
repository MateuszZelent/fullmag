# Task 5 preview review remediation plan

**Goal:** close every P1/P2 finding in the independent Task 5 review with production-path behavioral evidence.

1. Update the canonical FEM energy-density note before changing numerical behavior. Define cubic-anisotropy composition, sharp DG0 `Ms` projection, and truthful nodal visualization provenance.
2. Add RED behavioral regressions for live-`m` capture provenance, bounded materializer pending/superseded/error state, optional worker-failure isolation, and single-owner last-good retention.
3. Add RED cross-session regressions for scalar projection, empty-mask projection, scalar-slice, and arrow-slice cache keys and ETags; add session identity and bump every key format.
4. Add RED native-energy regressions for cubic anisotropy and DG0/regional `Ms`; make asynchronous and synchronous preview composition share one resolved term/material contract.
5. Replace synthetic/terminal-only acceptance with real callback-profile timing, pre-terminal asynchronous publication, independent energy-cache validation, headless runtime evidence, and hashing of the exact Control Room-consumed response.
6. Regenerate API/frontend types where contracts change, then run focused Rust/UI tests, managed native FEM verification, and only then the corrected 216-row matrix.
7. Update `.superpowers/sdd/task-5-report.md` with exact RED/GREEN commands and evidence. Preserve `.superpowers/sdd/progress.md`, inspect staged scope separately, and commit only Task 5 corrections.

## Independent re-review closure

### Task 8: Restore the canonical four-state freshness contract

**Files:** `crates/fullmag-api/src/schemas/fields.rs`, `crates/fullmag-api/src/router_v2/handlers/data/fields.rs`, `crates/fullmag-api/src/router_v2/tests.rs`, generated OpenAPI v2 files, `ControlRoomApi` tests, and viewport resource-frame tests.

- [x] Add API RED coverage proving that a retained complete payload remains `stale_complete` during a newer pending or superseded request and keeps the retained payload's source step, revision, timestamp, wall time, and statistics.
- [x] Add API RED coverage proving that a retained payload plus a failed newer request reports `error` and the failure text without relabelling the retained payload with the failed request identity.
- [x] Remove public `superseded`; keep it internal to the bounded materializer. Preserve `pending` only when no compatible completed payload exists.
- [x] Regenerate OpenAPI/types, remove frontend handling of the fifth state, and run focused API and Control Room tests.

### Task 9: Make the supported CPU DG0 material lane planner-reachable

**Files:** `docs/physics/0890-energy-density-observables.md`, `docs/specs/capability-matrix-v0.md`, `crates/fullmag-plan/src/fem.rs`, planner tests, `backends/fem/core/fem_material_fields.cpp`, and native material contract tests.

- [x] Add planner/native RED contracts for CPU `Ms_element_field` with mandatory consistent-mass exchange and optional Poisson-demag and Zeeman quadrature owners; Zeeman-only and demag-only remain illegal.
- [x] Keep GPU DG0 and CPU DG0 plans containing anisotropy, DMI, thermal, STT, Oersted, or magnetoelastic owners fail-closed with the first unsupported owner named.
- [x] Replace the blanket CPU rejection with the narrow allowlist in both planner and native validation; do not add fallback, test-only entrypoints, or runner-side planner bypasses.

### Task 10: Add managed DG0 and DMI energy qualification

**Files:** the Task 5 FEM fixture/verifier, managed `just` recipe, and verifier tests.

- [x] Add real Python-to-IR-to-planner-to-runner variants for CPU DG0 `M_s` plus uniform-`M_s` GPU uniaxial, cubic, interfacial DMI, and bulk DMI.
- [x] For each variant require the expected execution plan payload and independently integrate every advertised `eden_*` projection at its source step against the corresponding native scalar column.
- [x] Keep the 216-row GPU preview matrix unchanged; run the five energy variants as a separate managed qualification gate.

### Task 11: Repair and include the callback-deadline source contract

**Files:** `crates/fullmag-runner/src/lib.rs` and `justfile`.

- [x] Change `fem_preview_materialization_stays_outside_callback_deadline` to assert the current single-owner handoff and absence of runner-side heavy retention clones/readers.
- [x] Run the exact test RED before the assertion update and GREEN afterwards.
- [x] Invoke the exact non-`task5_` test explicitly from `verify-fem-preview-review-unit-contract` so filtering cannot hide it.

### Task 12: Sequential final proof and delivery

- [x] Run managed runtime rebuild/validation, the review-unit contract, the separate energy-qualification gate, API/frontend quality gates, and the canonical matrix when implementation changes can affect it.
- [x] Update `.superpowers/sdd/task-5-report.md` with exact RED/GREEN commands, artifacts, limits, and failures that are not proof.
- [x] Inspect `git diff --cached --name-only` in a separate command, exclude `.superpowers/sdd/progress.md`, and commit only Task 5 re-review closure.
