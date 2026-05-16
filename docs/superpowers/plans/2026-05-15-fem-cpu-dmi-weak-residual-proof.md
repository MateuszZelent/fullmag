# FEM CPU DMI Weak-Residual Proof Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a CPU-only proof fixture showing that current Rust FEM DMI is a strong-form bootstrap and not the target weak-residual/mass-projection formulation.

**Architecture:** Keep production behavior unchanged. Add test-only residual-action helpers inside `crates/fullmag-engine/src/fem.rs` tests, compare them with existing `dmi_fields_from_vectors`, and update documentation so the audit remains explicit about the open Etap 6 gap.

**Tech Stack:** Rust `cargo test`, existing `fullmag-engine` FEM CPU reference tests, markdown physics/spec/plan docs.

---

### Task 1: Physics And Design Artifacts

**Files:**
- Create: `docs/physics/0812-fem-dmi-weak-residual-proof-fixture.md`
- Create: `docs/superpowers/specs/2026-05-15-fem-cpu-dmi-weak-residual-proof-design.md`
- Create: `docs/superpowers/plans/2026-05-15-fem-cpu-dmi-weak-residual-proof.md`

- [x] **Step 1: Write the physics note**

Record the interfacial and bulk residual formulas, units, CPU-only scope, and the exact comparison between current mass action and target weak residual.

- [x] **Step 2: Write the design**

Record the CPU-only test fixture design and explicitly exclude native/GPU work.

- [x] **Step 3: Write this plan**

Make the implementation executable through TDD.

### Task 2: RED Tests

**Files:**
- Modify: `crates/fullmag-engine/src/fem.rs`

- [x] **Step 1: Add tests before helpers exist**

Add tests named:

```rust
interfacial_dmi_strong_form_action_differs_from_target_weak_residual_on_free_tet
bulk_dmi_strong_form_action_differs_from_target_weak_residual_on_free_tet
```

Each test should call helper functions that do not exist yet, so the first run fails for the expected missing fixture implementation.

- [x] **Step 2: Run RED**

Run:

```bash
cargo test -p fullmag-engine dmi_strong_form_action_differs_from_target_weak_residual -- --nocapture
```

Expected: compile failure because the weak-residual fixture helper functions are not defined.

### Task 3: GREEN Helper Implementation

**Files:**
- Modify: `crates/fullmag-engine/src/fem.rs`

- [x] **Step 1: Add test-only helper functions**

Add helpers in the existing test module:

```rust
fn p1_gradient_for_vectors(problem: &FemLlgProblem, field: &[Vector3]) -> [[f64; 3]; 3]
fn p1_centroid(field: &[Vector3]) -> Vector3
fn dmi_strong_form_mass_action(problem: &FemLlgProblem, field: &[Vector3], perturbation: &[Vector3], interfacial: bool) -> f64
fn interfacial_dmi_weak_residual_action(problem: &FemLlgProblem, field: &[Vector3], perturbation: &[Vector3]) -> f64
fn bulk_dmi_weak_residual_action(problem: &FemLlgProblem, field: &[Vector3], perturbation: &[Vector3]) -> f64
```

- [x] **Step 2: Run GREEN**

Run:

```bash
cargo test -p fullmag-engine dmi_strong_form_action_differs_from_target_weak_residual -- --nocapture
```

Expected: both tests pass and print no unexpected failures.

### Task 4: Existing DMI Regression

**Files:**
- Modify: `docs/reports/15.05.2026/fem-solver-physics-performance-audit.md`

- [x] **Step 1: Update audit status**

Add a short note that the CPU proof fixture now makes the weak-residual gap executable, but does not close Etap 6.

- [x] **Step 2: Run DMI suite**

Run:

```bash
cargo test -p fullmag-engine dmi
```

Expected: existing DMI tests and the new proof fixture pass.

### Task 5: Final Verification

**Files:**
- All changed files from this slice.

- [x] **Step 1: Formatting**

Run:

```bash
cargo fmt --check -p fullmag-engine
```

Expected: exit 0.

- [x] **Step 2: Whitespace**

Run:

```bash
git diff --check
```

Expected: exit 0.
