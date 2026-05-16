# FEM CPU Cubic Axes Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close CPU-only Etap 8.5 by aligning Rust FEM reference and FEM planner cubic anisotropy axis validation with native CPU FEM.

**Architecture:** Add small local validation helpers instead of a broad material refactor. The Rust reference and planner both enforce the native CPU tolerances and error message while leaving GPU files untouched.

**Tech Stack:** Rust `fullmag-engine`, Rust `fullmag-plan`, existing cargo tests.

---

### Task 1: Rust FEM Reference Validation

**Files:**
- Modify: `crates/fullmag-engine/src/fem.rs`

- [x] **Step 1: Write failing reference tests**

Add tests near the existing cubic anisotropy test:

```rust
#[test]
fn cubic_anisotropy_rejects_parallel_axes_in_reference_semantics() {
    let problem = unit_tet_problem_with_cubic_axes([1.0, 0.0, 0.0], [2.0, 0.0, 0.0]);
    let err = problem
        .validate_reference_semantics()
        .expect_err("parallel cubic axes must fail validation");
    assert!(err
        .to_string()
        .contains("cubic anisotropy axes must be finite, normalized and mutually orthogonal"));
}

#[test]
fn cubic_anisotropy_accepts_nonunit_orthogonal_axes_in_reference_semantics() {
    let problem = unit_tet_problem_with_cubic_axes([2.0, 0.0, 0.0], [0.0, -3.0, 0.0]);
    problem
        .validate_reference_semantics()
        .expect("non-unit orthogonal cubic axes should be normalized and accepted");
}
```

- [x] **Step 2: Run RED**

Run:

```bash
cargo test -p fullmag-engine cubic_anisotropy_rejects_parallel_axes_in_reference_semantics cubic_anisotropy_accepts_nonunit_orthogonal_axes_in_reference_semantics
```

Expected: at least the parallel-axis test fails because Rust reference has no cubic-axis validation yet.

- [x] **Step 3: Implement validation helper**

Add a helper that normalizes axes, rejects non-finite/zero/nonorthogonal axes, and call it from `validate_reference_semantics`.

- [x] **Step 4: Run GREEN**

Run:

```bash
cargo test -p fullmag-engine cubic_anisotropy
```

Expected: all cubic anisotropy tests pass.

### Task 2: FEM Planner Validation

**Files:**
- Modify: `crates/fullmag-plan/src/fem.rs`
- Modify: `crates/fullmag-plan/src/tests.rs`

- [x] **Step 1: Write failing planner test**

Add a test that sets FEM cubic axes to parallel vectors and expects `plan(&ir)` to fail with the native-compatible error message.

- [x] **Step 2: Run RED**

Run:

```bash
cargo test -p fullmag-plan fem_plan_rejects_invalid_cubic_anisotropy_axes
```

Expected: the test fails because the planner currently accepts the axes.

- [x] **Step 3: Implement planner validation**

Add a local helper in `crates/fullmag-plan/src/fem.rs` and call it for all FEM materials before `FemPlanIR` construction.

- [x] **Step 4: Run GREEN**

Run:

```bash
cargo test -p fullmag-plan fem_plan_rejects_invalid_cubic_anisotropy_axes
```

Expected: planner test passes.

### Task 3: Report And Final Verification

**Files:**
- Modify: `docs/reports/15.05.2026/fem-solver-physics-performance-audit.md`

- [x] **Step 1: Update report status**

Mark Etap 8.5 closed for Rust CPU reference and FEM planner only.

- [x] **Step 2: Run final gates**

Run:

```bash
cargo test -p fullmag-engine cubic_anisotropy
cargo test -p fullmag-plan fem_plan_rejects_invalid_cubic_anisotropy_axes
cargo fmt --check -p fullmag-engine
cargo fmt --check -p fullmag-plan
git diff --check
```

Expected: all commands exit 0.
