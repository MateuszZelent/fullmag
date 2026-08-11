# FDM multilayer — P0 containment and memory preflight

> **For implementing agents:** REQUIRED SKILL: use
> `subagent-driven-development` and execute the tasks sequentially, with a
> separate review after each task.

**Goal:** Remove the possibility of executing a non-canonical CUDA multilayer
operator, fix the ABI v2 memory under-estimate, and reject `boundary_*` semantics
that the multilayer plan cannot preserve.

**Architecture:** The planner and runner use one containment contract and one
checked pair-cost model. The first increment remains conservative: ABI v2 is
budgeted for all `L²` ordered pairs without claiming unimplemented reuse. Do not
change the equations or the CPU operator.

**Technologies:** Rust, Fullmag ProblemIR/planner/runner, CUDA ABI v2, MyST,
and source-map JSON.

## Global constraints

- Explicit `multilayer_convolution` must not be reinterpreted as native single-grid.
- Non-canonical CUDA-assisted execution must stop before device probing, allocation, or FFI.
- CPU FP64 keeps the current scope of `two_d_stack`, heterogeneous `h_z`, and `push_pull`.
- The only CUDA multilayer path allowed in this increment is `three_d + identity` with a valid certificate.
- `estimated_unique_kernels` remains telemetry; ABI v2 admission uses the `L²` cost.
- All sizes and costs use checked arithmetic, with no narrowing `as` casts.
- No silent fallback of device, strategy, transfer, or boundary semantics.
- Tests are written RED before implementation and GREEN after the minimal change.

---

### Task 1: Fail-closed CUDA multilayer containment

**Pliki:**

- Modyfikuj: `crates/fullmag-plan/src/fdm.rs`
- Modyfikuj: `crates/fullmag-plan/src/lib.rs`
- Test: `crates/fullmag-plan/src/tests.rs`
- Modyfikuj: `crates/fullmag-runner/src/fdm/gpu/cuda/multilayer.rs`
- Modyfikuj: `crates/fullmag-runner/src/fdm/gpu/cuda/native.rs`

**Interfaces:**

- Produce a shared helper returning stable reason codes for
  `two_d_stack`, `push_pull`, heterogenicznego native `h_z` i XY offsetu.
- The runner uses the helper as defense in depth for historical and deserialized plans.

- [ ] Write RED planner tests for the four unqualified CUDA classes and the CPU control.
- [ ] Write RED runner tests proving rejection before CUDA probe/allocation.
- [ ] Implement the shared helper and planner fail-close for forced CUDA.
- [ ] Forbid the native-stacked single-grid fast path for explicit `multilayer_convolution`.
- [ ] Preserve `three_d + identity` and the auto-strategy fast path within their existing legal scope.
- [ ] Run focused planner/runner tests, formatting, and the diff check.
- [ ] Commit and perform a separate compliance/spec-quality review.

### Task 2: Conservative checked ABI v2 memory preflight

**Pliki:**

- Modyfikuj: `crates/fullmag-plan/src/fdm.rs`
- Modyfikuj: `crates/fullmag-plan/src/lib.rs`
- Test: `crates/fullmag-plan/src/tests.rs`
- Modyfikuj: `crates/fullmag-runner/src/fdm/mod.rs`
- Test: the appropriate runner test module

**Interfaces:**

- Produce `checked_multilayer_pair_kernel_footprint(common_cells, layer_count)`
  returning the full host tensor-payload cost for ABI v2.
- The planner records this cost in `estimated_kernel_bytes`; the runner computes
  it with the same helper and rejects stale or forged summaries.

- [ ] Write a RED test for the exact cost at `L=3`, `common=[4,5,6]`: `829440` B.
- [ ] Write a threshold RED test where shift-only passes but `L²` exceeds 8 GiB.
- [ ] Write RED tests for `L² > u32::MAX` and padded-cell/byte overflow.
- [ ] Implement the helper using only `try_from` and `checked_mul`.
- [ ] Replace shift-only admission in the planner and runner with the ABI v2 `L²` cost.
- [ ] Keep the unique-shift count only as explicit telemetry, without claiming allocation.
- [ ] Run focused planner/runner tests, formatting, and the diff check.
- [ ] Commit and perform a separate compliance/spec-quality review.

### Task 3: Fail-closed `boundary_*` for multilayer

**Pliki:**

- Modyfikuj: `crates/fullmag-plan/src/fdm.rs`
- Test: `crates/fullmag-plan/src/tests.rs`
- Modyfikuj: `docs/physics/0421-fdm-multilayer-convolution-demag.md`
- Modyfikuj: `docs/physics/0421-fdm-multilayer-convolution-demag.source-map.json`
- Modyfikuj: `docs/specs/capability-matrix-v0.md`

**Interfaces:**

- Neutral intent is exactly `boundary_correction in {None, "none"}` with both
  tuning parameters equal to `None`.
- Every explicit `boundary_phi_floor` or `boundary_delta_min`, including `0.0`,
  is rejected because the plan has no field that can preserve this intent.

- [ ] Write RED tests for the neutral and every non-neutral variant.
- [ ] Add one planner validation before layer construction.
- [ ] Update the note, source map, and capability matrix without claiming runtime proof.
- [ ] Run planner tests and the documentation validator.
- [ ] Commit and perform a separate compliance/spec-quality review.

## Final gate for this wave

- All three task reviews are approved without Critical/Important findings.
- The complete focused planner and runner suites pass.
- The scientific-documentation validator and `git diff --check` pass.
- Managed CUDA runtime is not promoted to production-qualified; this increment
  proves containment and preflight, not device parity.
