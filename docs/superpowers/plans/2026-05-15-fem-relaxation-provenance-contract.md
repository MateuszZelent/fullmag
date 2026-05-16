# FEM Relaxation Provenance Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Separate FEM relaxation time-integrator provenance from direct energy-minimizer provenance.

**Architecture:** Add optional energy-minimizer fields to `ExecutionProvenance` and populate them only for `projected_gradient_bb` / `nonlinear_cg` relaxation stages. Keep native/GPU solver code untouched and describe the current FEM implementation as `bootstrap_snapshot_tangent_gradient`.

**Tech Stack:** Rust, serde provenance metadata, `fullmag-runner`, existing relaxation docs.

---

### Task 1: Planning Artifacts

**Files:**
- Create: `docs/superpowers/specs/2026-05-15-fem-relaxation-provenance-contract-design.md`
- Create: `docs/superpowers/plans/2026-05-15-fem-relaxation-provenance-contract.md`

- [x] **Step 1: Record approved scope**

Expected: spec states that this is provenance/contract fencing only and excludes native/GPU hot-loop or tangent-plane implementation.

### Task 2: RED Tests

**Files:**
- Modify: `crates/fullmag-runner/src/types.rs`

- [x] **Step 1: Add provenance serialization tests**

Expected tests:

```text
fem_relaxation_provenance_serializes_bootstrap_energy_minimizer
fem_relaxation_provenance_omits_minimizer_for_llg_time_integration
```

- [x] **Step 2: Run focused tests**

Run:

```bash
cargo test -p fullmag-runner fem_relaxation_provenance -- --nocapture
```

Expected before implementation: FAIL because `ExecutionProvenance` does not yet contain energy-minimizer fields.

### Task 3: Minimal Provenance Implementation

**Files:**
- Modify: `crates/fullmag-runner/src/types.rs`
- Modify: `crates/fullmag-runner/src/dispatch.rs`
- Modify: `crates/fullmag-runner/src/interactive_runtime.rs`
- Modify: `crates/fullmag-runner/src/fem_reference.rs`

- [x] **Step 1: Add optional provenance fields**

Add optional serde fields:

```text
requested_energy_minimizer
resolved_energy_minimizer
energy_minimizer_realization
```

- [x] **Step 2: Add helper mapping for relaxation algorithms**

For `projected_gradient_bb` and `nonlinear_cg`, return the algorithm name and realization `bootstrap_snapshot_tangent_gradient`. For `llg_overdamped`, return no minimizer.

- [x] **Step 3: Populate FEM provenance constructors**

Apply the helper to native FEM dispatch and interactive provenance paths. Keep FDM behavior unchanged unless a path already uses direct minimization metadata.

### Task 4: Documentation And Verification

**Files:**
- Modify: `docs/physics/0510-fem-relaxation-algorithms-mfem-gpu.md`
- Modify: `docs/reports/15.05.2026/fem-solver-physics-performance-audit.md`
- Modify: `docs/superpowers/plans/2026-05-15-fem-relaxation-provenance-contract.md`

- [x] **Step 1: Update physics note and audit**

Expected: docs say provenance separation is closed, while production FE-metric/tangent-plane minimizers remain open.

- [x] **Step 2: Run focused verification**

Run:

```bash
cargo test -p fullmag-runner fem_relaxation_provenance -- --nocapture
cargo test -p fullmag-runner relaxation_convergence --no-fail-fast
cargo fmt --check -p fullmag-runner
git diff --check
```

Expected: all commands exit 0.

Actual 2026-05-15:

- `cargo test -p fullmag-runner fem_relaxation_provenance -- --nocapture`: PASS, 2/2.
- `cargo test -p fullmag-runner relaxation_convergence --no-fail-fast`: PASS, 4/4.
- `rustfmt --check` on files touched by this slice: PASS.
- `git diff --check`: PASS.
- `cargo fmt --check -p fullmag-runner`: blocked by an unrelated existing `native_fem.rs` format diff in the native/GPU-owned area, left untouched by this CPU-safe slice.
