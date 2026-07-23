# Task 5 independent re-review after remediation

Reviewed range: `7599f78968ca21014685d1617eb14f3dc8a69bca..09f00cce7c21f7943079525f96f72198d3038374`

Task 5 implementation commit: `ad67da90cfa678c750a4bc1f1dabb4ca73483ae8`

Remediation commit: `09f00cce7c21f7943079525f96f72198d3038374`

## Remediation submission 2026-07-23

`IMPLEMENTER_STATUS: READY_FOR_INDEPENDENT_REREVIEW`

The verdicts below are the prior independent review and remain reviewer-owned.
This submission records implementation evidence for a fresh review; it does not
self-approve or replace those verdicts.

- Public freshness is again the canonical four-state enum. Internal supersession
  is not exposed, retained values keep retained source provenance, and focused API
  and Control Room regressions cover pending, superseded, and error combinations.
- CPU element-DG0 `M_s` is planner- and native-reachable only for ordinary time
  evolution with mandatory consistent-mass exchange and optional Poisson demag or
  Zeeman. GPU DG0 and every unsupported owner combination remain fail-closed.
- DG0 field-dot preview energies use the exact conservative P1 tetrahedron
  weak-form projection. Five independent managed fixtures qualify CPU DG0 plus GPU
  uniaxial, cubic, interfacial DMI, and bulk DMI against native scalar terms.
- The stale non-`task5_` callback test was repaired and explicitly added to the
  managed review recipe. The recipe passed the exact callback test and 16/16
  Task 5 runner tests.
- The removed exchange source assertion checked only for a sentence in an absent,
  untracked report file. No executable exchange coverage was removed:
  `fem_exchange_contract` remains part of the managed native material gate and
  passed there.

The first post-change matrix invocation completed all 216 executions but failed
its heterogeneous-row CSV write with `KeyError: 'energy_projection_location'`.
Its 180 measured rows are preserved at
`.fullmag/reports/fem-preview-surface-matrix/20260723-081559/raw_rows.json` and are
RED evidence only. The serializer now uses the explicit union of row columns and
null-fills missing cells; focused serializer contracts and the complete 13/13
verifier unit suite pass. The fresh post-fix matrix then exited 0 with 36 warmups
and 180 measured rows; its authoritative artifact is
`.fullmag/reports/fem-preview-surface-matrix/20260723-090252/summary.json`.

Submission gates recorded by the implementer:

- `verify-fem-preview-review-unit-contract`: passed, including the exact callback
  regression and 16/16 `task5_` runner tests.
- `verify-fem-material-element-ms-contract`: passed every executable native target,
  including exchange and DG0-aware step metrics.
- `verify-fem-preview-energy-qualification`: passed all five separate managed
  CPU/GPU energy fixtures.
- The fresh canonical matrix passed 216/216 invocations with callback maximum
  1,105,207 ns, callback-plus-fence maximum 1,414,746 ns, thread-CPU maximum
  1,077,007 ns, 60 live asynchronous rows, 30 energy-comparison rows, and zero
  wall-time outliers.
- Control Room typecheck, zero-warning lint, 392-file/3765-test suite, and API
  hygiene passed. React Doctor remains unrun: its sandboxed package fetch failed
  with `EAI_AGAIN`, and the required escalation was rejected because it would run
  an unpinned third-party package.

## Verdicts

`SPEC_VERDICT: CHANGES_REQUIRED`

`QUALITY_VERDICT: CHANGES_REQUIRED`

The remediation closes the original callback-measurement, live-magnetization provenance, cross-session cache identity, worker-failure isolation, and duplicate `last_good` ownership defects. The bounded CUDA snapshot implementation and the corrected matrix are credible production-executable evidence for the exercised GPU fixture. Acceptance is still blocked by a public freshness/provenance contract violation, incomplete native energy-density qualification relative to the newly canonical note, and a failing runner test hidden by the managed review recipe's name filter.

## Required findings

### [P1] Public field freshness conflates request state with retained-payload provenance and adds an unauthorized fifth state

Files:

- `docs/adr/0011-resource-first-api.md:127-138`
- `docs/specs/resource-first-control-room-api-v2.md:223-245`
- `.superpowers/sdd/task-5-brief.md:65-78`
- `crates/fullmag-api/src/schemas/fields.rs:15-23`
- `crates/fullmag-api/src/router_v2/handlers/data/fields.rs:762-785`
- `crates/fullmag-api/src/router_v2/handlers/data/fields.rs:920-950`
- `crates/fullmag-api/src/router_v2/handlers/data/fields.rs:1140-1200`
- `crates/fullmag-api/src/router_v2/tests.rs:24298-24370`
- `apps/control-room/src/kernel/api/generated/openapi-v2-types.ts:4095`
- `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts:1575`

The canonical resource contract has exactly four public states: `complete | stale_complete | pending | error`. It defines `pending` as no complete payload being available and requires a compatible retained payload to remain `stale_complete`. The implementation instead publishes internal queue state directly, adds public `superseded`, and overwrites an existing descriptor/meta object's `source_step` and `source_revision` with the newer request identity.

This makes the returned metadata cease to describe the returned field. The API regression at lines 24298-24370 intentionally constructs a retained complete `H_demag` payload, injects a step-9 pending request, then expects `available=true`, `state=pending`, `source_step=9`, and readable statistics from the older payload. `get_field_meta` performs the same replacement through `materializer_freshness.unwrap_or(freshness)`. A client therefore receives old values labelled with the unmaterialized request's provenance. The same problem applies to `superseded`, and the generated OpenAPI/UI now normalize the spec drift instead of detecting it.

Required change: keep `LiveFieldMaterializationState::Superseded` as internal bounded-handoff telemetry. Public catalog/meta must describe the payload actually returned: retain its source step/revision/timestamp and expose `stale_complete` while a newer request is pending or superseded. `pending` may be used only when there is no complete compatible payload. Define the retained-payload/error combination explicitly without replacing payload provenance, regenerate OpenAPI/types, remove `superseded` from the public enum, and invert the current API/UI regressions to assert the canonical four-state semantics.

### [P1] The promised native energy-density qualification is still incomplete and its DG0 branch is unreachable in a production plan

Files:

- `docs/physics/0890-energy-density-observables.md:54-78`
- `docs/physics/0890-energy-density-observables.md:98-111`
- `docs/plans/2026-07-22-task-5-preview-review-remediation.md:5-10`
- `crates/fullmag-runner/src/native_fem.rs:1078-1187`
- `crates/fullmag-runner/src/native_fem.rs:3517-3620`
- `crates/fullmag-plan/src/fem.rs:128-143`
- `examples/fem_preview_surface_matrix.py:44-63`
- `scripts/verify_fem_preview_surface_matrix.py:923-1003`

The cubic term and volume-lumped DG0 projection helper repair the original formula-level defect, and the payload is truthfully labelled `fem_nodal_visualization_projection`. But the canonical note now requires native qualification of separate uniaxial/cubic activation, interfacial/bulk DMI selection, uniform/nodal-P1/element-DG0 `M_s`, and `eden_total` against native scalar terms. The remediation plan likewise requires native DG0/regional-Ms regressions.

The managed 30-row comparison exercises one nodal `material.ms_field` fixture with cubic anisotropy, exchange, demag, and external field. The verifier explicitly rejects the fixture unless `material.ms_field` exists; it does not require `ms_element_field`. The fixture has no DMI. DG0 is covered only by the pure two-tetrahedron helper test. More importantly, `elementwise_material_legality_error` rejects every `ms_element_field` plan on both CPU and GPU, so the new production preview branch that reads `plan.ms_element_field` cannot be reached through the current planner/runtime path.

Required change: either qualify a production-executable DG0 plan and add managed scalar-density comparisons for DG0 plus separate interfacial/bulk DMI cases, or revise the physics note/capability contract to mark DG0 preview materialization unsupported and remove unreachable support claims/code. Do not count a nodal regional override or a helper-only projection test as DG0 production qualification.

## Code-quality finding

### [P2] A runner contract test fails, but the managed Task 5 recipe filters it out

Files:

- `crates/fullmag-runner/src/lib.rs:4453-4485`
- `crates/fullmag-runner/src/fem/relax/preview.rs`
- `justfile:2038-2050`
- `.superpowers/sdd/task-5-report.md:99-105`

`fem_preview_materialization_stays_outside_callback_deadline` still requires the removed duplicate-retention strings `let mut last_good_field = field.clone();` and `result.last_good_field`. The current preview implementation intentionally has neither. Running that exact test against the managed runtime libraries fails at `crates/fullmag-runner/src/lib.rs:4481` with exit 101.

The managed recipe runs only tests matching `task5_`, so this older non-prefixed Task 5 contract is silently excluded while the report cites 15/15 runner tests. This is not merely absent coverage: the repository's runner suite is red for the reviewed source.

Required change: update or delete the stale source assertion so it checks the new single-owner retention contract, then run at least the full `fullmag-runner` test target (or a managed recipe that explicitly includes this test) instead of relying only on the `task5_` filter.

## Original-finding closure audit

### Closed

1. **Real callback/live/browser evidence:** the verifier now reads pre-terminal production solver-profile samples rather than timing `PendingFemPreviewJob::Test`. All 90 enabled interactive measured rows carry production callback samples; 60 primary live rows prove a pre-terminal async field. The Control Room smoke hashes the binary response observed on the page's own request and checks a live WebGL canvas. The dedicated 80 ms run checks retained pending/stale display.
2. **Live `m` provenance:** `FemLiveMagnetizationPayload` carries source step/revision/materialization timing. CLI ingestion stores it in canonical `latest_fields`; scalar-only frames preserve the older capture identity. The API regression expects step 4 to remain `stale_complete` at live step 9.
3. **Session-scoped caches/ETags:** session identity is present in vector, scalar projection, empty-mask projection, scalar-slice, and arrow-slice keys/ETags, with focused cross-session regressions.
4. **Optional materializer failures:** worker and terminal failures become explicit materialization status without aborting the solver; focused runner/API tests cover error publication and retained payload readability.
5. **Duplicate `last_good` clone:** the unused runner-side full-field clone/map was removed. Retention remains owned by the downstream CLI/API caches.

### Partially closed

1. **Energy density:** cubic composition, per-node `M_s`, masking, and projection location were repaired. DG0 and DMI production qualification remains open as described above.
2. **Behavioral tests versus source checks:** production matrix coverage is materially stronger, but the stale failing source-contract test and filtered recipe remain open.
3. **Materializer freshness:** internal pending/superseded/error state is now real and failure-isolated, but projecting it directly into public payload freshness introduces the P1 contract/provenance defect above.

## Bounded callback and CUDA-path audit

- The handoff remains bounded to one worker job, staged descriptors, a finite queue/cache cycle, and an eight-slot preallocated native snapshot pool.
- Solver callback code stages/dispatches work and does not call field `wait` or synchronous `copy_live_preview_field` for async energy/cache requests.
- GPU snapshot creation enqueues device-to-device staging and pinned-host `cudaMemcpy2DAsync` on the persistent I/O stream. `wait_snapshot_payload` remains worker-side. The compute/I/O ordering uses events; the scheduling fence is outside the callback and is measured separately.
- The authoritative artifact reports callback max 1,191,293 ns, thread-CPU max 954,799 ns, schedule-fence max 988,911 ns, and callback-plus-fence max 1,479,260 ns against the 2,000,000 ns deadline. No measured wall outlier was recorded.

No callback D2H wait or approximately 79 ms callback spike was found in the reviewed production path. This conclusion is limited to the exercised device/fixture and does not waive the public freshness or energy-qualification findings.

## 216-run matrix assessment

Authoritative artifact: `.fullmag/reports/fem-preview-surface-matrix/20260723-032852/summary.json`

- Shape is correct: 4 modes x 3 cadences x 3 surfaces x (1 warmup + 5 measured) = 36 warmups + 180 measured = 216 matrix rows.
- The source contains one direct `run_row` call per row and no per-row retry loop. Polls use `time.monotonic()` and elapsed measurements use `time.perf_counter()`.
- Interactive production evidence is substantive: 90 enabled interactive rows have real callback samples, 60 primary-field rows prove pre-terminal async publication, all 45 enabled Control Room rows observe a pre-terminal browser state/response, and 30 full-cache interactive rows compare integrated projected energy against native scalar columns.
- The 60 headless rows prove actual GPU provenance and 52 scalar steps, not live preview publication. This is an appropriate no-consumer headless invariant, but it must not be described as headless exercise of the async preview callback.
- Payload/mask equality for `m` and `H_demag`, terminal Zarr `H_demag`, full-cache quantity inventory, and the dedicated retained-frame run are internally consistent with the raw rows.
- The matrix qualifies this bounded nodal/cubic fixture. It does not qualify DG0 or DMI energy semantics and therefore is not by itself full closure of the canonical energy note.

## Verification performed during re-review

- `git diff --check 7599f78968ca21014685d1617eb14f3dc8a69bca..09f00cce7c21f7943079525f96f72198d3038374`: passed.
- `python3 -m unittest scripts.test_verify_fem_preview_surface_matrix`: 10/10 passed.
- Mechanical audit of `summary.json`, `raw_rows.json`, `matrix.csv`, and `retention_proof.json`: counts and reported extrema match the artifacts.
- Exact runner diagnostic using the exported managed FEM libraries: `cargo +nightly test -p fullmag-runner --features fem-gpu fem_preview_materialization_stays_outside_callback_deadline -- --nocapture`: failed, 0 passed / 1 failed / 773 filtered, at line 4481.
- An attempt to run that exact test through the identified Docker-backed recipe environment did not reach compilation/test execution because Docker reported `all predefined address pools have been fully subnetted`. The failing Rust test result above is therefore diagnostic host execution against managed libraries, not new managed runtime qualification. Existing managed success claims are assessed from the submitted artifacts and source.

The pre-existing unrelated modification to `.superpowers/sdd/progress.md` was preserved and not reviewed as part of this range.
