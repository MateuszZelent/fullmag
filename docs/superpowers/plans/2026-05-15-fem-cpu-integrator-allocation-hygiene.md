# FEM CPU Integrator Allocation Hygiene Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove per-accepted-step ABM3 history allocation from the Rust FEM CPU-reference workspace stepping path.

**Architecture:** Keep `FemLlgProblem::step_with_workspace` and the existing ABM3 equations. Add a reusable-copy history push API to `AbmHistory`, then call it from `abm3_step_ws` instead of materializing `to_vec()` on every accepted step.

**Tech Stack:** Rust, `fullmag-engine`, existing unit tests in `crates/fullmag-engine/src/fem.rs`.

---

### Task 1: ABM3 History Reuse Test

**Files:**
- Modify: `crates/fullmag-engine/src/fem.rs`

- [ ] **Step 1: Write the failing test**

Add a unit test near the existing FEM tests:

```rust
#[test]
fn abm3_workspace_reuses_history_slots_after_startup() {
    let mut problem = unit_tet_problem();
    problem.dynamics.integrator = TimeIntegrator::ABM3;
    let mut state = problem
        .new_state(vec![[1.0, 0.0, 0.0]; problem.topology.n_nodes])
        .expect("state");
    let mut ws = FemIntegratorWorkspace::new(problem.topology.n_nodes);

    for _ in 0..3 {
        problem
            .step_with_workspace(&mut state, 1e-13, &mut ws)
            .expect("startup step");
    }

    let ptrs_before = state.abm_history_slot_ptrs().expect("ready history");

    for _ in 0..4 {
        problem
            .step_with_workspace(&mut state, 1e-13, &mut ws)
            .expect("abm step");
    }

    let ptrs_after = state.abm_history_slot_ptrs().expect("ready history");
    assert_eq!(ptrs_before, ptrs_after);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p fullmag-engine abm3_workspace_reuses_history_slots_after_startup`

Expected before implementation: FAIL, because the helper is missing or the history slot pointers change after `to_vec()` pushes.

### Task 2: Reusable ABM3 History Push

**Files:**
- Modify: `crates/fullmag-engine/src/fdm_state.rs`
- Modify: `crates/fullmag-engine/src/fem.rs`

- [ ] **Step 1: Add reusable history API**

Add `AbmHistory::push_copy_from_slice(&mut self, f: &[Vector3], dt: f64)` that preserves the existing `dt` restart behavior, allocates missing slots during startup, and after readiness rotates slots via `Option::take()` and copies into the reused oldest slot with `clear()` and `extend_from_slice()`.

- [ ] **Step 2: Use it in workspace ABM3**

Replace both `state.abm_history.push(ws.k[..][..n].to_vec(), dt)` calls in `abm3_step_ws` with `push_copy_from_slice(&ws.k[..][..n], dt)`.

- [ ] **Step 3: Keep compatibility path unchanged**

Leave the `#[allow(dead_code)]` allocating ABM3 helper as a parity/compatibility path.

- [ ] **Step 4: Run focused tests**

Run: `cargo test -p fullmag-engine abm`

Expected: PASS.

### Task 3: Documentation And Final Gates

**Files:**
- Modify: `docs/physics/0490-fem-higher-order-and-adaptive-time-integrators-mfem-gpu.md`
- Modify: `docs/reports/15.05.2026/fem-solver-physics-performance-audit.md`

- [ ] **Step 1: Update docs**

Record that CPU-reference ABM3 workspace history now reuses slots after startup and that this does not change integrator physics.

- [ ] **Step 2: Run final verification**

Run:

```bash
cargo test -p fullmag-engine abm
cargo test -p fullmag-engine fem_integrator
cargo fmt --check -p fullmag-engine
git diff --check
```

Expected: all commands exit 0.

