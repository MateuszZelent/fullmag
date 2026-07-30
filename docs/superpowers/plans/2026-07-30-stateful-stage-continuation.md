# Stateful Stage Continuation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run compatible consecutive interactive study stages on one solver context so switching PG-BB to LLG/RK23 preserves magnetization, native FEM demag state, and live field data.

**Architecture:** Keep exact plan equality for callers that need it, but add a separate continuation-compatibility predicate.  The predicate compares persistent backend context and intentionally ignores stage controls.  The CLI host uses it when deciding whether to retain or create `InteractiveRuntime`; execution keeps consuming the current stage plan for its algorithm and stop rules.

**Tech Stack:** Rust, Fullmag `ExecutionPlanIR`, `InteractiveRuntime`, native FEM runtime, managed `just` FEM verification.

## Global Constraints

- Do not change Python DSL, ProblemIR, OpenAPI, v2 transport, field encoding, or viewport topology ownership.
- A mesh/grid, material/energy model, demag realization, device/precision, or backend change remains a rebuild boundary.
- A compatible transition must not upload sampled `final_magnetization` or recreate the backend.
- Native FEM runtime proof uses the repository-managed `just` route.

---

### Task 1: Define and prove the continuation compatibility contract

**Files:**
- Modify: `crates/fullmag-runner/src/interactive/backend.rs`
- Modify: `crates/fullmag-runner/src/interactive/runtime.rs`
- Modify: `crates/fullmag-runner/src/interactive_runtime.rs`
- Test: `crates/fullmag-runner/src/interactive_runtime.rs`

**Interfaces:**
- Produces: `InteractiveRuntime::can_continue_with_plan(&ExecutionPlanIR) -> Result<bool, RunError>`.
- Produces: backend-specific continuation signature that excludes `initial_magnetization`, relaxation/integrator/timestep controls, field-refresh policy, and stage time context.

- [ ] **Step 1: Write the failing runner test**

```rust
#[test]
fn fem_runtime_continuation_ignores_relaxation_controls_but_not_mesh_identity() {
    let first = make_fem_plan_with_pgbb();
    let mut second = first.clone();
    second.relaxation = Some(llg_overdamped_control());
    second.integrator = Some(IntegratorChoice::Rk23);
    second.fixed_timestep = Some(1e-15);

    assert!(fem_plans_share_runtime_context(&first, &second));
    second.mesh.nodes[0][0] += 1e-12;
    assert!(!fem_plans_share_runtime_context(&first, &second));
}
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `cargo test -p fullmag-runner interactive_runtime::tests::fem_runtime_continuation_ignores_relaxation_controls_but_not_mesh_identity -- --exact`

Expected: compilation failure because the continuation predicate does not yet exist.

- [ ] **Step 3: Implement the minimal predicate and trait method**

```rust
fn normalize_fem_runtime_context_signature(plan: &FemPlanIR) -> FemPlanIR {
    let mut context = normalize_fem_plan_signature(plan);
    context.relaxation = None;
    context.integrator = None;
    context.fixed_timestep = None;
    context.adaptive_timestep = None;
    context.field_refresh = None;
    context.time_stage = Default::default();
    context
}
```

Expose the equivalent FDM predicate through `InteractiveBackend` and delegate it from `InteractiveRuntime`.

- [ ] **Step 4: Run the focused test and confirm GREEN**

Run: `cargo test -p fullmag-runner interactive_runtime::tests::fem_runtime_continuation_ignores_relaxation_controls_but_not_mesh_identity -- --exact`

Expected: PASS.

### Task 2: Retain the solver context across compatible CLI stages

**Files:**
- Modify: `crates/fullmag-cli/src/interactive_runtime_host.rs`
- Test: `crates/fullmag-cli/src/interactive_runtime_host.rs`

**Interfaces:**
- Consumes: `InteractiveRuntime::can_continue_with_plan` from Task 1.
- Produces: host runtime reuse for compatible stage plans; reconstruction only at an explicit incompatible boundary.

- [ ] **Step 1: Write the failing host source-contract test**

```rust
#[test]
fn stage_runtime_reuse_uses_continuation_compatibility() {
    let source = include_str!("interactive_runtime_host.rs");
    let ensure = source.split("fn ensure_interactive_preview_runtime(").nth(1).unwrap();
    assert!(ensure.contains("can_continue_with_plan(plan)"));
    assert!(!ensure.contains("current.matches_plan(plan)"));
}
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `cargo test -p fullmag-cli interactive_runtime_host::tests::stage_runtime_reuse_uses_continuation_compatibility -- --exact`

Expected: FAIL because the host still compares full plans.

- [ ] **Step 3: Make the host use continuation compatibility**

```rust
let needs_rebuild = runtime.as_ref().map_or(true, |current| {
    !current.can_continue_with_plan(plan).unwrap_or(false)
});
```

Keep the existing creation path and explicit continuation-magnetization input solely for a new/incompatible runtime.

- [ ] **Step 4: Run the focused test and confirm GREEN**

Run: `cargo test -p fullmag-cli interactive_runtime_host::tests::stage_runtime_reuse_uses_continuation_compatibility -- --exact`

Expected: PASS.

### Task 3: Verify the regression at runner and managed FEM boundaries

**Files:**
- Test: `crates/fullmag-runner/src/interactive_runtime.rs`
- Test: `crates/fullmag-cli/src/interactive_runtime_host.rs`
- Test script: temporary bounded two-stage FEM scenario under `/tmp` only.

- [ ] **Step 1: Run the focused Rust regressions**

Run:

```bash
cargo test -p fullmag-runner interactive_runtime::tests::fem_runtime_continuation_ignores_relaxation_controls_but_not_mesh_identity -- --exact
cargo test -p fullmag-cli interactive_runtime_host::tests::stage_runtime_reuse_uses_continuation_compatibility -- --exact
```

Expected: both PASS.

- [ ] **Step 2: Run the managed FEM build/runtime preflight**

Run: `just ensure-managed-fem-runtime`

Expected: managed runtime available without a hand-built host FEM binary.

- [ ] **Step 3: Run a bounded managed two-relax scenario on isolated outputs**

Run the repository managed FEM command with a temporary script containing PG-BB followed by LLG/RK23 and a unique output directory.  Verify stage two has a non-empty `H_demag` vector payload and reports one continued runtime context.

- [ ] **Step 4: Review the diff and commit only task files**

Run `git diff --check`, inspect `git diff --cached --name-only` separately, then commit the runner, CLI, tests, and this plan with a descriptive message.
