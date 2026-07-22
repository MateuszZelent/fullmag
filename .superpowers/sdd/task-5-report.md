# Task 5 report: materialize FEM previews outside the solver deadline

Status: `IMPLEMENTED_AND_QUALIFIED_WITH_BASELINE_CONCERNS`

Base revision: `7599f78968ca21014685d1617eb14f3dc8a69bca`

## Outcome

The existing FEM preview path now owns one bounded asynchronous materializer. Solver callbacks enqueue one snapshot only when the handoff can accept it, retain the last complete compatible payload while work is pending, and account for superseded requests. Magnetization, demagnetizing field, other cached vector fields, and energy-density materialization no longer perform their heavy snapshot copy/materialization inside the solver callback deadline.

The v2 field resources now expose source provenance and freshness without adding payload to thin session status. Control Room keeps topology-compatible `stale_complete` and `pending` data visible instead of clearing the viewport. The managed 4 x 3 x 3 surface matrix completed all warmups and repeats with exact preview payload equivalence.

## Implementation

### Runner and native FEM

- Extended the existing `FemPreviewHandoff` and `PendingFemPreviewState`; no competing preview worker was added.
- The handoff has a single in-flight job, `can_accept`, nonblocking completion polling, `last_good`, cache-cycle ownership, and a `preview_superseded_count`.
- Solver callbacks check capacity before creating a snapshot. A full handoff preserves the previous complete field and increments the superseded count.
- `PendingFemPreviewJob` covers vector fields and energy-density work. The energy job owns the required `m`, `H_*`, per-node `Ms`, active mask, and term prefactors.
- Energy density is evaluated on the worker as `prefactor * mu0 * Ms * dot(m, h)` for active terms and magnetic nodes. No new physics was added to the FFI.
- Final cached fields are stamped with the terminal solver step/revision so post-solver cache refresh cannot regress their provenance.
- CUDA snapshot staging now records the staging event and makes the compute stream wait for it before reuse, preventing staging-buffer reuse while the asynchronous D2H copy is in flight.

### CLI/runtime publication

- Added an explicit positive `FULLMAG_PREVIEW_EVERY_N` override while preserving FEM cadence 10, FDM cadence 50, and disabled preview semantics.
- Published and pending cache entries are reconciled per quantity by `(source_step, source_revision, materialized_at_unix_ms)`; an idle refresh cannot overwrite a newer terminal field.
- Idle snapshots are promoted to the current live step before reconciliation.
- Latest-field source metadata is carried into live workspace publication.

### API contract

- Added `source_step`, `source_revision`, `materialized_at_unix_ms`, `stale_by_steps`, `materialization_wall_time_ns`, and `state` to field catalog/meta resources.
- Freshness states are `complete`, `stale_complete`, `pending`, and `error`.
- Catalog, metadata, and vector handlers choose the newest compatible source candidate instead of preferring storage order.
- Invalid/non-finite or wrong-sized live magnetization is not advertised as a pending usable field.
- Missing legacy `source_step` remains step 0 instead of being relabelled as current.
- Projection-cache identity and ETags include session identity, preventing cross-session reuse.
- Thin status remains revision-only; freshness payload is confined to field resources.
- OpenAPI JSON was regenerated from the current managed API binary, byte-compared successfully with that binary's `--print-openapi-v2` output, and the TypeScript transport was regenerated.

### Control Room

- Field-resource normalization carries freshness metadata and revision changes.
- Viewport scene selection retains a topology-compatible complete payload while the selected quantity is `pending` or `stale_complete`.
- Visualization and inspector models consume the same resource state; no component endpoint string, direct `fetch()`, or parallel state path was introduced.
- Added focused tests for stale/pending retention and freshness propagation.

### Qualification tooling and documentation

- Added `examples/fem_preview_surface_matrix.py` as the bounded real FEM GPU fixture.
- Added `scripts/verify_fem_preview_surface_matrix.py`, the Control Room freshness smoke, package script, and `just verify-fem-preview-surface-matrix`.
- Added initial/final durable `H_demag` snapshots so artifact provenance is checked independently of preview-resource identity.
- Updated ADR 0011 and the v2 resource-first API specification.

## TDD and defect chronology

1. A fake 80 ms job first characterized the synchronous deadline violation. GREEN keeps five measured callback handoffs below 2 ms while `last_good` remains available and the worker finishes later.
2. The same-revision cache test exposed a cadence cycle that did not restart. Cache cadence now starts a fresh cycle without adding another worker.
3. Energy-density tests fixed worker ownership of `m`, field terms, masks, and per-node `Ms`, and assert the exact existing energy formula.
4. Native snapshot contract review exposed staging-buffer reuse without a compute-stream dependency. The CUDA event wait and source contract close that race.
5. API RED showed projection cache identity omitted session identity. The key/ETag now includes the session id.
6. Early matrix runs exposed final `H_demag` reporting step 0 and selecting stale storage. Terminal stamping and newest-source selection make every accepted row report source step 52.
7. Interactive shutdown exposed post-solver idle refresh replacing the terminal field. Monotonic per-quantity reconciliation now rejects provenance regression.
8. Full API verification exposed legacy latest-field metadata and invalid live `m` being treated as current/pending. Focused regressions now pass.

## Preview matrix evidence

Authoritative report: `.fullmag/reports/fem-preview-surface-matrix/20260722-021728/summary.json`

- Modes: disabled, `m`, `H_demag`, full cache.
- Cadences: 10, 25, 50.
- Surfaces: headless, interactive without browser, Control Room.
- Repeats: one warmup plus five measured runs per variant.
- Completed: 36 warmups + 180 measured = 216/216 runs.
- Median end-to-end surface elapsed time: 5909.333 ms.
- Enqueue characterization: 60 measured callback samples; every sample below 2 ms, non-disabled p50 values were approximately 41-61 microseconds, and the maximum was approximately 108 microseconds. No approximately 79-80 ms worker delay appeared in the callback.
- Preview `m`: one exact payload SHA-256, `9e5197ada6d825b13a3fc34a9e4532e7b6dd878e9fa86eb987c48b1748bb73b4`.
- Preview `H_demag`: one exact payload SHA-256, `25ce5f9b8c04ecfa32678c5947a63b634993d6178022a30680b464e3bd3b0e6d`.
- Both masks: exact SHA-256 `af5570f5a1810b7af78caf4bc70a660f0df51e42baf91d4de5b2328de0e83dfc`.
- Cross-surface raw preview differences for both quantities: max absolute 0, max scaled relative 0, max ULP 0.
- Final durable `m` artifacts had two exact hashes across surfaces with maximum absolute difference `6.253331186201194e-13`. This is reported separately and did not weaken the exact preview-resource gate.
- Every focused post-fix `H_demag` Control Room run reported terminal `source_step=52` and the same exact payload hash.

Clock/retry note: the accepted 216-row run used no `clock-retry` row. Poll deadlines use `time.monotonic()` and elapsed measurements use `time.perf_counter()`. The verifier allows one explicitly labelled retry only for the known host-clock startup regression; none was consumed in the authoritative run. The report directory date is 2026-07-22 because the full workflow crossed midnight after starting on 2026-07-21.

## Verification

### Managed/native gates

- `just rebuild-fem-runtime`: passed; release runtime exported and portable bundle validated.
- `env COMPOSE_PROJECT_NAME=fullmag just verify-fem-relaxation-runtime`: passed. Source/native contracts passed; managed GPU LLG overdamped, projected-gradient BB, and nonlinear-CG lanes passed; the expected GPU tangent-plane skip remained explicit; CPU relaxation lanes including tangent-plane passed.
- Managed `preview_enqueue_matrix_stays_below_solver_deadline`: passed all 60 measured samples.
- `just verify-fem-preview-surface-matrix`: passed all 216 rows with the equivalence results above.

### Rust/API gates

- `cargo test -p fullmag-cli`: 233 passed.
- Fresh focused API tests after final OpenAPI regeneration all passed:
  - `field_vector_cache_identity_includes_session_id`
  - `v2_field_catalog_rejects_non_finite_live_magnetization`
  - `v2_field_catalog_rejects_fem_live_magnetization_with_wrong_point_count`
  - `v2_field_vector_prefers_fresh_m_preview_cache_over_stale_latest_field`
  - `v2_h_demag_resource_prefers_newer_preview_cache_over_stale_latest_field`
  - `cached_preview_merge_never_regresses_source_provenance`
- Full `fullmag-api` suite: 668 passed, 4 failed. This gate is not reported green. All four failures reproduce at exact base `7599f78968ca21014685d1617eb14f3dc8a69bca` with the same values:
  - `display_patch_accepts_partial_update`: `presentation.vector_glyphs` is false.
  - `hysteresis_progress_endpoint_averages_only_magnetic_fem_nodes`: actual `[0.0, 0.5, 0.0]`, expected `[0.0, 1.0, 0.0]`.
  - `hysteresis_progress_endpoint_uses_fem_element_volume_weights_for_live_average`: expected x component `1/28` assertion fails.
  - `object_metrics_endpoint_uses_mesh_part_node_indices_for_shared_fem_nodes`: actual `11.5`, expected `3.0`.
- The display and simulation runtime handlers exercised by those four tests are unchanged by Task 5. The detached base reproduction establishes that they are baseline failures, not a claim inferred only from diff locality.

### Control Room gates

- `corepack pnpm --dir apps/control-room test`: 390 files passed, 1 skipped; 3736 tests passed, 1 skipped.
- `corepack pnpm --dir apps/control-room audit:compute-performance`: passed; no idle-redraw regression.
- `corepack pnpm --dir apps/control-room typecheck`: passed.
- `corepack pnpm --dir apps/control-room lint`: passed with zero warnings.
- `corepack pnpm --dir apps/control-room check:api-hygiene`: passed.
- Final focused viewport resource-frame test: 1 file and 103 tests passed, including both `stale_complete` and `pending` payload retention.
- Static Control Room production build: passed.
- OpenAPI managed-binary output versus generated JSON: byte-for-byte `cmp` passed; TypeScript types and generated client regenerated successfully.
- `python3 -m py_compile` for the fixture/verifier, `node --check` for the browser smoke, and `git diff --check`: passed.

React Doctor could not run: the sandboxed `npx` attempt failed with `EAI_AGAIN`, and escalation was rejected because it would execute an unpinned third-party package. No dependency was installed.

## Scope and remaining concerns

- Task changes are confined to the existing runner/native preview path, runtime publication, v2 field resources, generated frontend transport, compatible Control Room consumers/tests, qualification tooling, and required docs.
- `.superpowers/sdd/progress.md` is a pre-existing modification and is deliberately excluded from the Task 5 commit.
- The four full-API failures above remain repository baseline defects. They are documented, reproduced, and intentionally not repaired by this preview task.
- Repo-wide `cargo fmt --all -- --check` remains nonzero because it proposes broad formatting across existing untouched code and large mixed-history files. No broad mechanical rewrite was applied; the new preview module and the task's focused changed files were checked separately, and compilation/tests are green as recorded above.
- Native GPU and managed-runtime success proves the preview path is production-executable on the exercised device. The matrix proves exact preview equivalence for this bounded fixture; it is not a general physics-validation claim beyond that fixture and contract.
