# Mesh Failure Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose a sanitized, actionable shared-domain mesh failure cause in the CLI and v2 preparation resource.

**Architecture:** Preserve the existing stable summary and error code. Propagate an optional bounded `detail` from Python's existing `mesh_build_failed` event through the bridge, CLI preparation state and log tail, then the API snapshot and OpenAPI schema. HTTP v2 remains authoritative; realtime only invalidates the resource.

**Tech Stack:** Python progress events, Rust, serde, utoipa/OpenAPI, Cargo tests.

**Implementation status (2026-07-30):** Implemented and exercised by the
managed SP4 failure run. The v2 resource now returned the sanitized phase and
cell-level reason; the focused CLI bridge and v2 projection/OpenAPI tests pass.

## Global Constraints

- Do not change mesh generation or classification.
- Do not expose filesystem paths, control characters, or unbounded mesher output.
- Preserve `summary = Shared-domain mesh build failed` and `error_code = mesh_build_failed`.
- Do not add an endpoint or extend realtime content.

---

### Task 1: Preserve the diagnostic in CLI preparation state

**Files:**

- Modify: `crates/fullmag-cli/src/python_bridge.rs:16-105,1769-1785`
- Modify: `crates/fullmag-cli/src/simulation_preparation.rs:214-220,520-575,628-660`
- Modify: `crates/fullmag-cli/src/live_workspace.rs:4248-4274,2550-2574`
- Modify: `crates/fullmag-cli/src/orchestrator.rs:539-617`

**Interfaces:** Input is `{kind: "mesh_build_failed", phase: str, error: str}`. Output is `PythonMeshPreparationUpdate::Failed { stage_id, summary, detail: Option<String> }` and `PreparationFailure { detail: Option<String>, .. }`.

- [ ] **Step 1: Write failing bridge tests**

```rust
assert_eq!(
    python_mesh_preparation_update("mesh_build_failed", &serde_json::json!({
        "phase": "postprocessing", "error": "unsupported cell type hex8"
    })),
    Some(PythonMeshPreparationUpdate::Failed {
        stage_id: PreparationStageId::MeshPostprocessing,
        summary: "Shared-domain mesh build failed".to_string(),
        detail: Some("postprocessing: unsupported cell type hex8".to_string()),
    })
);
```

Add a path case (`/private/model/stderr`) asserting `detail: None`.

- [ ] **Step 2: Verify RED**

Run: `cargo test -p fullmag-cli structured_mesh_failure_projects_phase_qualified_sanitized_detail -- --exact`

Expected: FAIL because `Failed` has no detail.

- [ ] **Step 3: Implement minimal plumbing**

```rust
Failed { stage_id: PreparationStageId, summary: String, detail: Option<String> }

fn sanitize_mesh_failure_detail(phase: &str, error: Option<&str>) -> Option<String> {
    Some(format!("{phase}: {}", error.and_then(sanitize_preparation_progress_label)?))
}
```

Add `detail: Option<String>` to `PreparationFailure`. Keep current general transition helpers as `None` wrappers; add detailed variants for mesh failures. Emit the detail as the error log when present. Use it in both live and deferred failure paths.

- [ ] **Step 4: Verify GREEN**

Run: `cargo test -p fullmag-cli structured_mesh_failure -- --nocapture`

Expected: PASS.

- [ ] **Step 5: Commit**

Run: `git add crates/fullmag-cli/src/python_bridge.rs crates/fullmag-cli/src/simulation_preparation.rs crates/fullmag-cli/src/live_workspace.rs crates/fullmag-cli/src/orchestrator.rs`

Run: `git commit -m "fix: preserve mesh failure diagnostics"`

### Task 2: Expose detail through v2 preparation and OpenAPI

**Files:**

- Modify: `crates/fullmag-api/src/types.rs:742-748`
- Modify: `crates/fullmag-api/src/schemas/preparation.rs:98-113`
- Modify: `crates/fullmag-api/src/router_v2/handlers/simulation/runtime.rs:155-172`
- Modify: `crates/fullmag-api/src/router_v2/tests.rs:809-816,16507-16530,16759-16762`
- Modify: CLI-to-API conversion constructing `SimulationPreparationFailureSnapshot`

**Interfaces:** Input is `PreparationFailure.detail: Option<String>`. Output is `PreparationFailureResource.detail: Option<String>` with `max_length = 1024`.

- [ ] **Step 1: Write failing route and OpenAPI assertions**

```rust
assert_eq!(body["failure"]["detail"], "meshing: no valid tetrahedra");
assert!(schemas["PreparationFailureResource"]["properties"].get("detail").is_some());
```

Put `detail: Some("meshing: no valid tetrahedra".to_string())` in the failed fixture.

- [ ] **Step 2: Verify RED**

Run: `cargo test -p fullmag-api simulation_preparation_returns_failed_projection -- --exact`

Expected: FAIL because failure lacks detail.

- [ ] **Step 3: Implement schema and mapping**

```rust
#[schema(max_length = 1024)]
pub detail: Option<String>,
```

Copy detail through `SimulationPreparationFailureSnapshot`; map it in `get_simulation_preparation` using `bounded_preparation_string(..., 1024)`. Leave websocket contents unchanged.

- [ ] **Step 4: Verify GREEN**

Run: `cargo test -p fullmag-api simulation_preparation_returns_failed_projection -- --exact`

Expected: PASS.

- [ ] **Step 5: Commit**

Run: `git add crates/fullmag-api/src/types.rs crates/fullmag-api/src/schemas/preparation.rs crates/fullmag-api/src/router_v2/handlers/simulation/runtime.rs crates/fullmag-api/src/router_v2/tests.rs`

Run: `git commit -m "feat: expose preparation failure detail"`

### Task 3: Verify the complete projection

**Files:**

- Modify: `crates/fullmag-cli/src/live_workspace.rs` test module

**Interfaces:** A postprocessing failure results in matching `failure.detail` and error log message, without raw paths.

- [ ] **Step 1: Write a failing workspace test**

```rust
assert_eq!(failure.detail.as_deref(), Some("postprocessing: unsupported pyramid5"));
assert!(preparation.log_tail.iter().any(|entry| entry.message == "postprocessing: unsupported pyramid5"));
```

- [ ] **Step 2: Verify RED**

Run: `cargo test -p fullmag-cli mesh_failure_records_diagnostic_detail -- --exact`

Expected: FAIL until Task 1 propagation is used by the workspace.

- [ ] **Step 3: Complete only any missing live/deferred projection**

Use the bridge detail in both paths. Do not duplicate sanitization.

- [ ] **Step 4: Verify final focused suite**

Run: `cargo test -p fullmag-cli mesh_failure -- --nocapture`

Run: `cargo test -p fullmag-api simulation_preparation_returns_failed_projection -- --exact`

Expected: PASS.

- [ ] **Step 5: Commit follow-up tests if they are not included above**

Run: `git add crates/fullmag-cli/src/live_workspace.rs crates/fullmag-cli/src/orchestrator.rs`

Run: `git commit -m "test: cover mesh failure diagnostic projection"`

## Self-review

- Tasks cover sanitization, stable summary, CLI logs, v2 resource and OpenAPI.
- No task changes mesh algorithms or stores raw Gmsh stderr.
- `detail: Option<String>` is consistent at every layer.
