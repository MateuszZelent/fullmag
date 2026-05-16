# Native FEM CPU Demag Hot-Path Profile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose CPU Poisson-demag assemble/solve/recover/energy timing through native FEM step stats and artifacts.

**Architecture:** Add detailed demag timing fields to the native C ABI, carry them through the Rust FFI wrapper into `StepStats`/`StepDiagnostics`, and publish the latest profile in `metadata.json`.

**Tech Stack:** C++17 native FEM backend, Rust FFI bindings, Rust runner diagnostics, Fullmag artifact metadata.

---

### Task 1: Physics And Design Artifacts

**Files:**
- Create: `docs/physics/0817-native-fem-cpu-demag-hot-path-profile.md`
- Create: `docs/superpowers/specs/2026-05-15-native-fem-cpu-demag-hot-path-profile-design.md`
- Create: `docs/superpowers/plans/2026-05-15-native-fem-cpu-demag-hot-path-profile.md`

- [x] **Step 1: Record non-physics telemetry contract**

Expected: docs state no physics equation changes and define the four diagnostic timing fields.

### Task 2: RED ABI And Diagnostics Tests

**Files:**
- Modify: `crates/fullmag-fem-sys/src/lib.rs`
- Modify: `crates/fullmag-runner/src/types.rs`

- [x] **Step 1: Add failing tests**

Add tests that access:

```rust
demag_assemble_wall_time_ns
demag_solve_wall_time_ns
demag_recover_wall_time_ns
demag_energy_wall_time_ns
```

on `fullmag_fem_step_stats`, `StepStats`, and `StepDiagnostics`.

- [x] **Step 2: Run RED**

```bash
cargo test -p fullmag-fem-sys demag_profile -- --nocapture
cargo test -p fullmag-runner demag_profile -- --nocapture
```

Expected: FAIL because the fields do not exist.

### Task 3: Native And Rust Data Model

**Files:**
- Modify: `native/include/fullmag_fem.h`
- Modify: `crates/fullmag-fem-sys/src/lib.rs`
- Modify: `native/backends/fem/src/mfem_bridge.cpp`
- Modify: `crates/fullmag-runner/src/native_fem.rs`
- Modify: `crates/fullmag-runner/src/types.rs`
- Modify: `crates/fullmag-quantities/src/step_data.rs`

- [x] **Step 1: Add fields to native and Rust stats structs**

Fields must be `uint64_t` / `u64`.

- [x] **Step 2: Record native phase timers**

`context_compute_demag_poisson` must add to `PhaseTimings` for assemble, solve,
recover, and energy. `recover_demag_field` should report energy timing
separately from field recovery.

- [x] **Step 3: Map FFI stats into runner stats**

`NativeFemBackend::step` and `snapshot_step_stats` must copy the fields.

### Task 4: Artifact Metadata

**Files:**
- Modify: `crates/fullmag-runner/src/artifacts.rs`

- [x] **Step 1: Publish latest demag hot-path profile**

`demag_runtime` metadata must include:

```json
"timings_ns": {
  "assemble": ...,
  "solve": ...,
  "recover": ...,
  "energy": ...,
  "total": ...
}
```

### Task 5: Report Update

**Files:**
- Modify: `docs/reports/15.05.2026/fem-cpu-module-implementation-report.md`

- [x] **Step 1: Mark demag profiling source-level closure**

The report must say structured CPU demag timings are exposed, while full
benchmark values still require MFEM/hypre.

### Task 6: Verification

**Files:**
- Test: `crates/fullmag-fem-sys`
- Test: `crates/fullmag-runner`

- [x] **Step 1: Run ABI test**

```bash
cargo test -p fullmag-fem-sys demag_profile -- --nocapture
```

Expected: PASS.

- [x] **Step 2: Run runner diagnostics test**

```bash
cargo test -p fullmag-runner demag_profile -- --nocapture
```

Expected: PASS.

- [x] **Step 3: Run source checks**

```bash
git diff --check
```

Expected: PASS.

- [x] **Step 4: Record MFEM-host blocker**

```bash
scripts/check_mfem_host_env.sh
```

Expected on this workstation: FAIL with missing `MFEMConfig.cmake` /
`mfem-config.cmake`.
