# Task 5 report: materialize FEM previews outside the solver deadline

Status: `REMEDIATED_AWAITING_INDEPENDENT_REREVIEW`

Base revision: `7599f78968ca21014685d1617eb14f3dc8a69bca`

## Outcome

### Independent re-review remediation submitted 2026-07-23

This implementation closes both P1 findings and the P2 finding from the independent
re-review. The prior reviewer verdict remains reviewer-owned; this report marks the
implementation ready for a new independent review, not accepted or complete.

- The public field freshness enum is again exactly `complete | stale_complete |
  pending | error`. `superseded` remains internal bounded-handoff telemetry. A
  compatible retained payload stays `stale_complete` during a newer pending or
  superseded request and preserves the retained payload's source step, revision,
  timestamp, wall time, and statistics. A newer failure reports `error` without
  relabelling retained values with failed-request provenance.
- Element-DG0 `M_s` is production-reachable only on native FEM CPU ordinary time
  evolution with consistent-mass exchange. Poisson demag and Zeeman may be added;
  demag-only and Zeeman-only plans do not promote DG0 support. GPU DG0, direct
  relaxation, anisotropy, DMI, thermal, STT, Oersted, and magnetoelastic DG0 plans
  remain fail-closed.
- DG0 field-dot energy projections now preserve the exact P1-tetrahedron weak-form
  integral, including consistent-mass off-diagonal terms, and carry
  `fem_nodal_conservative_tetra_projection`. Uniform and nodal-P1 previews retain
  `fem_nodal_visualization_projection`.
- Five separate managed fixtures reached real Python -> ProblemIR -> planner ->
  runner execution: CPU DG0 `M_s`, and GPU uniform-`M_s` uniaxial, cubic,
  interfacial-DMI, and bulk-DMI. Every advertised projected term and `eden_total`
  was integrated at source step 52 and compared with its matching native scalar.
- The exact non-`task5_`
  `fem_preview_materialization_stays_outside_callback_deadline` regression now
  asserts the single-owner retention contract and is explicitly run by the managed
  review recipe. The managed runner group passed 16/16 Task 5 tests.
- The removed `exchange_contract.cpp` assertion only searched for a stale,
  untracked report-document sentence. The executable native
  `fem_exchange_contract` target remains in
  `verify-fem-material-element-ms-contract` and passed in the final native gate.

All five energy runs were written under
`.fullmag/reports/fem-preview-energy-qualification/` and passed their independent
native-scalar comparisons:

| Variant | Device / material | Projection | Compared terms | Maximum relative error |
|---|---|---|---|---:|
| `dg0-ms` | CPU, element-DG0 `M_s` | `fem_nodal_conservative_tetra_projection` | `eden_ex`, `eden_demag`, `eden_ext`, `eden_total` | 1.9450934198233654e-09 |
| `uniaxial` | GPU, uniform `M_s` | `fem_nodal_visualization_projection` | `eden_ani`, `eden_total` | 3.2853607098039007e-11 |
| `cubic` | GPU, uniform `M_s` | `fem_nodal_visualization_projection` | `eden_ani`, `eden_total` | 3.8805584161779044e-11 |
| `interfacial-dmi` | GPU, uniform `M_s` | `fem_nodal_visualization_projection` | `eden_dmi`, `eden_total` | 2.7557566216410217e-11 |
| `bulk-dmi` | GPU, uniform `M_s` | `fem_nodal_visualization_projection` | `eden_dmi`, `eden_total` | 4.1634656172889099e-11 |

The first post-change 216-run invocation completed all row executions but failed
during final CSV serialization because heterogeneous rows were projected through
the first row's singular energy key. That run is preserved as RED evidence at
`.fullmag/reports/fem-preview-surface-matrix/20260723-081559/raw_rows.json`.
The serializer now builds an explicit ordered union of public columns and writes
missing cells as `null`; two focused RED/GREEN contracts and the full 13/13
verifier suite cover the schema. This failed invocation is not acceptance proof.

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
9. Independent review found that headless and interactive execution did not enter the first GPU demag solve with the same fresh-initial-guess intent. Headless now calls the same native `begin_stage` contract, and interactive snapshotting preserves the pending fresh-demag intent through the pre-solve snapshot. A native snapshot contract and a four-way profiler-off/on A/B run prove exact terminal `m`, `H_demag`, and step-1 scalar parity.
10. Independent review found that a backward host wall-clock adjustment could abort script preparation even though ordering and duration already use monotonic state. Preparation now preserves the raw observed Unix timestamp, exposes a bounded `clock_adjustment` diagnostic, and continues to derive duration and ordering from monotonic/revision state. Focused CLI and v2 API RED/GREEN contracts cover a 32-second backward adjustment.
11. The Python preflight could select a resolved interpreter path outside the canonical managed environment and the verifier still contained a one-row startup-clock retry. Interpreter identity now preserves the selected symlink path and checks `sys.prefix` before imports. The retry path was deleted completely; the verifier source contract asserts that every row calls `run_row` exactly once.
12. Final diff audit removed the temporary `FULLMAG_TASK5_STAGE_TRACE` and `FULLMAG_PREVIEW_TRACE` diagnostics. No environment lookup, diagnostic hashing, or trace output remains in runtime or solver hot paths; the opt-in bounded solver profiler remains the only performance instrumentation.
13. The final relaxation source gate detected an exact-inventory hash change. A base/current multiset audit showed unchanged counts (191 `.fem_mesh` accesses and 64 mesh producers) and only one-for-one rustfmt statement wrapping changes: two API test assertions plus five existing stage-owner/test producers. No production mesh access or producer was added, removed, moved into a callback/loop, or associated with D2H/synchronization. The exact golden hashes were updated to the audited inventory and the semantic source gate was rerun.

## Preview matrix evidence

Authoritative post-serializer-fix report: `.fullmag/reports/fem-preview-surface-matrix/20260723-090252/summary.json`

- Modes: disabled, `m`, `H_demag`, full cache.
- Cadences: 10, 25, 50.
- Surfaces: headless, interactive without browser, Control Room.
- Repeats: one warmup plus five measured runs per variant.
- Completed: 36 warmups + 180 measured = 216/216 runs.
- Median end-to-end surface elapsed time: 9623.050 ms.
- Production callback characterization: 60 live asynchronous rows; callback maximum 1,105,207 ns, callback plus scheduling fence maximum 1,414,746 ns, thread-CPU maximum 1,077,007 ns, and zero wall-time outliers. Every accepted row stayed below the 2,000,000 ns deadline.
- Preview `m`: one exact payload SHA-256, `6c8dff3a5a6245440ead7e13866029cb3ad2f6dc1d1e02028341c0dc817a8b63`.
- Preview `H_demag`: one exact payload SHA-256, `2610fdaf301c221f8200644653f6a2c24575b8fd183d71056730e287c57fef45`.
- Both masks: exact SHA-256 `af5570f5a1810b7af78caf4bc70a660f0df51e42baf91d4de5b2328de0e83dfc`.
- Cross-surface raw preview differences for both quantities: max absolute 0, max scaled relative 0, max ULP 0.
- Final durable `m` artifacts also had one exact hash, `eb2f5b65d1a3f853ff1623aeaf71e1fabc53b245ba540568a8e5d05349fafff2`, with maximum cross-surface absolute difference 0.
- Terminal `H_demag` was checked against durable Zarr in 60 measured rows; all reported `source_step=52`, `state=complete`, and the same exact payload hash.
- Full-cache terminal payload and mask SHA-256 values were recorded for all 12 materialized quantities. Energy comparison covered 30 managed rows.
- The dedicated delayed-production-path retention proof preserved `stale_complete` materialization without clearing the retained browser canvas; its callback maximum was 193,395 ns.

Clock/retry note: there is no retry implementation. Poll deadlines use `time.monotonic()` and elapsed measurements use `time.perf_counter()`. Preparation retains raw Unix timestamps for evidence but uses monotonic duration and revision/canonical-stage ordering. The authoritative run invoked each of its 216 rows exactly once.

The first canonical invocation in the restricted tool sandbox stopped before row 1 because the API listener bind returned `EPERM`; its preserved diagnostic is `.fullmag/reports/fem-preview-surface-matrix/20260723-032805/api.log`. The exact canonical command was then executed with permission to bind the local API/browser listener. This was a whole-workflow environment restart, not a row retry. An earlier pre-remediation run at `.fullmag/reports/fem-preview-surface-matrix/20260723-021635/` stopped after 107 measured rows when the host wall clock moved backwards by 32.508 seconds; that failure produced the monotonic clock-adjustment contracts above and was not continued or retried.

## Verification

### Managed/native gates

- `env COMPOSE_PROJECT_NAME=fullmag just ensure-managed-fem-runtime`: passed after the final runtime rebuild; the exported portable bundle validator reported `bundle: valid`.
- `env COMPOSE_PROJECT_NAME=fullmag just verify-fem-relaxation-runtime`: passed. Source/native contracts passed; managed GPU LLG overdamped, projected-gradient BB, and nonlinear-CG lanes passed; the expected GPU tangent-plane skip remained explicit; CPU relaxation lanes including tangent-plane passed.
- `env COMPOSE_PROJECT_NAME=fullmag just verify-fem-preview-review-unit-contract`: passed sequentially against the validated final bundle. The exact non-`task5_` callback regression passed, the runner group passed 16/16 `task5_` tests, and the backend source-layout group passed 2/2, in addition to the recipe's focused CLI/API/planner transport, freshness, precedence, clock-adjustment, and merge contracts.
- `env COMPOSE_PROJECT_NAME=fullmag just verify-fem-material-element-ms-contract`: passed the planner-aligned native material/context/element-quadrature/exchange/Zeeman/anisotropy/demag contracts and the DG0-aware step-metrics contract.
- `env COMPOSE_PROJECT_NAME=fullmag just verify-fem-preview-energy-qualification`: passed the verifier unit suite, managed bundle validation, static Control Room build, and all five separate native energy fixtures.
- Managed `preview_enqueue_matrix_stays_below_solver_deadline`: passed all 60 measured samples.
- `env COMPOSE_PROJECT_NAME=fullmag just verify-fem-preview-surface-matrix`: passed all 216 rows with the equivalence results above; the authoritative post-serializer-fix report is `.fullmag/reports/fem-preview-surface-matrix/20260723-090252/summary.json`.

Two earlier review-gate launches are excluded from proof: the restricted-sandbox attempt could not access the Docker socket, and a concurrently launched attempt collided with the runtime exporter's clean/replacement window and exited 127 because `libfullmag_fem.so.0` was temporarily absent. No product assertion is based on either launch. The final result above was obtained only after the relaxation rebuild, a separate successful bundle validation, and a fully sequential review-gate invocation.

### Rust/API gates

- `cargo test -p fullmag-cli`: 233 passed.
- `python3 -m unittest scripts.test_verify_fem_preview_surface_matrix`: 13/13 verifier contracts passed, including no row retries, five distinct energy operator payloads, and heterogeneous CSV schema/rectangularization.
- `python3 -m unittest scripts.test_ensure_python_recipe`: 3/3 managed-Python bootstrap contracts passed.
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

- `env TMPDIR=/tmp corepack pnpm --dir apps/control-room test`: 392 files passed, 1 skipped; 3765 tests passed, 1 skipped.
- `corepack pnpm --dir apps/control-room audit:compute-performance`: passed; no idle-redraw regression.
- `corepack pnpm --dir apps/control-room typecheck`: passed.
- `corepack pnpm --dir apps/control-room lint`: passed with zero warnings.
- `corepack pnpm --dir apps/control-room check:api-hygiene`: passed.
- Final focused viewport resource-frame test: 1 file and 103 tests passed, including both `stale_complete` and `pending` payload retention.
- Static Control Room production build: passed.
- OpenAPI managed-binary output versus generated JSON: byte-for-byte `cmp` passed; TypeScript types and generated client regenerated successfully.
- `python3 -m py_compile` for the fixture/verifier, `node --check` for the browser smoke, and `git diff --check`: passed.
- Final source audit found no `FULLMAG_TASK5_STAGE_TRACE` or `FULLMAG_PREVIEW_TRACE` markers and no production row-retry helper or `clock-retry` path. `apps/control-room/next-env.d.ts` has no Task 5 diff.

React Doctor could not run: the sandboxed `npx` attempt failed with `EAI_AGAIN`, and escalation was rejected because it would execute an unpinned third-party package. No dependency was installed.

## Scope and remaining concerns

- Task changes are confined to the existing runner/native preview path, runtime publication, v2 field resources, generated frontend transport, compatible Control Room consumers/tests, qualification tooling, and required docs.
- `.superpowers/sdd/progress.md` is a pre-existing modification and is deliberately excluded from the Task 5 commit.
- The four full-API failures above remain repository baseline defects. They are documented, reproduced, and intentionally not repaired by this preview task.
- Repo-wide `cargo fmt --all -- --check` remains nonzero because it proposes broad formatting across existing untouched code and large mixed-history files. No broad mechanical rewrite was applied; the new preview module and the task's focused changed files were checked separately, and compilation/tests are green as recorded above.
- Native GPU and managed-runtime success proves the preview path is production-executable on the exercised device. The matrix proves exact preview equivalence for this bounded fixture; it is not a general physics-validation claim beyond that fixture and contract.
