# Headless API Telemetry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish real scalar telemetry from an explicitly configured managed headless run to the existing v2 scalar resource, then qualify FEM P2 against FDM/Newell and the artifact table on the same SP4 run.

**Architecture:** Default headless execution keeps API port `0`. An explicit nonzero `FULLMAG_API_PORT` is accepted only when it already serves a compatible Fullmag API; headless never spawns UI processes. Delta publication sends the dedicated scalar frame before session/runtime/mesh-bearing frames so large FEM payloads cannot prevent scalar visibility.

**Tech Stack:** Rust, `anyhow`, `reqwest::blocking`, Fullmag internal live bridge, OpenAPI v2 scalar resource, pytest qualification, managed container-backed FEM runtime.

## Global Constraints

- Without `FULLMAG_API_PORT`, `--headless` must retain literal API port `0`.
- `FULLMAG_API_PORT=0` must remain an explicit API opt-out.
- A nonzero headless port must already serve a compatible Fullmag API; fail before simulation otherwise.
- Headless must not launch an API process, frontend, or browser.
- Scalar frames must be attempted before session, runtime, field, or FEM mesh frames.
- Public `GET /v2/sessions/current/data/scalars` and its OpenAPI schema remain unchanged.
- Do not replay `scalars.csv` into API state or present artifact-derived JSON as live telemetry.
- Do not widen status or scalar JSON with heavy mesh/topology arrays.
- Do not commit, merge, or claim broad FEM/FDM equivalence during this plan.
- Native FEM build and runtime evidence must use repository `just` managed/container recipes.

---

### Task 1: Explicit compatible API port for headless mode

**Files:**
- Modify: `crates/fullmag-cli/src/control_room.rs`
- Modify: `crates/fullmag-cli/src/orchestrator.rs:6239-6245`

**Interfaces:**
- Consumes: existing `api_bridge_is_ready(port: u16) -> bool`, `RESOLVED_API_PORT`, and `FULLMAG_API_PORT`.
- Produces: `pub(crate) fn init_headless_api_port() -> Result<()>` and private pure resolver `resolve_headless_api_port_with` used by unit tests.

- [ ] **Step 1: Add RED tests for disabled, explicit compatible, invalid, and incompatible headless ports**

Add a focused `headless_api_port_tests` module in `control_room.rs` using a pure readiness closure:

```rust
#[cfg(test)]
mod headless_api_port_tests {
    use std::ffi::OsStr;

    use super::resolve_headless_api_port_with;

    #[test]
    fn absent_headless_api_port_stays_disabled() {
        assert_eq!(resolve_headless_api_port_with(None, |_| false).unwrap(), 0);
    }

    #[test]
    fn explicit_zero_headless_api_port_stays_disabled() {
        assert_eq!(
            resolve_headless_api_port_with(Some(OsStr::new("0")), |_| false).unwrap(),
            0
        );
    }

    #[test]
    fn explicit_nonzero_headless_api_port_requires_compatible_api() {
        assert_eq!(
            resolve_headless_api_port_with(Some(OsStr::new("18233")), |port| {
                port == 18233
            })
            .unwrap(),
            18233
        );
        let error = resolve_headless_api_port_with(Some(OsStr::new("18233")), |_| false)
            .unwrap_err();
        assert!(error.to_string().contains("compatible fullmag-api"));
    }

    #[test]
    fn malformed_headless_api_port_fails_closed() {
        let error = resolve_headless_api_port_with(Some(OsStr::new("invalid")), |_| true)
            .unwrap_err();
        assert!(error.to_string().contains("valid u16 port"));
    }
}
```

- [ ] **Step 2: Run the RED tests**

Run:

```bash
cargo test -p fullmag-cli headless_api_port_tests --no-fail-fast
```

Expected: compilation failure because `resolve_headless_api_port_with` does not exist.

- [ ] **Step 3: Implement strict headless port resolution**

In `control_room.rs`, import `OsStr` and add:

```rust
fn resolve_headless_api_port_with(
    raw: Option<&OsStr>,
    compatible: impl Fn(u16) -> bool,
) -> Result<u16> {
    let Some(raw) = raw else {
        return Ok(0);
    };
    let raw = raw.to_string_lossy();
    let port = raw
        .trim()
        .parse::<u16>()
        .with_context(|| format!("FULLMAG_API_PORT must be a valid u16 port, got '{raw}'"))?;
    if port == 0 {
        return Ok(0);
    }
    if !compatible(port) {
        bail!(
            "headless FULLMAG_API_PORT={port} must already serve a compatible fullmag-api"
        );
    }
    Ok(port)
}

pub(crate) fn init_headless_api_port() -> Result<()> {
    let port = resolve_headless_api_port_with(
        std::env::var_os("FULLMAG_API_PORT").as_deref(),
        api_bridge_is_ready,
    )?;
    init_api_port_explicit(port)
}
```

In `orchestrator.rs`, replace the unconditional headless zero initialization:

```rust
if args.headless {
    init_headless_api_port()?;
} else {
    init_api_port()?;
}
```

Update the existing `use crate::control_room::{...}` list to import `init_headless_api_port` and remove the now-unused direct headless use of `init_api_port_explicit` if no other caller remains.

- [ ] **Step 4: Run focused tests and formatting check**

Run:

```bash
cargo test -p fullmag-cli headless_api_port_tests --no-fail-fast
cargo fmt --check -- crates/fullmag-cli/src/control_room.rs crates/fullmag-cli/src/orchestrator.rs
```

Expected: four tests pass; changed files are formatted. If repository-wide formatting noise appears, format only the changed hunks and use `git diff --check` as the narrow gate.

- [ ] **Step 5: Review checkpoint without commit**

Inspect:

```bash
git diff --check -- crates/fullmag-cli/src/control_room.rs crates/fullmag-cli/src/orchestrator.rs
git diff -- crates/fullmag-cli/src/control_room.rs crates/fullmag-cli/src/orchestrator.rs
```

Expected: only strict headless port selection and its tests changed.

---

### Task 2: Scalar-first live delta routing

**Files:**
- Modify: `crates/fullmag-cli/src/control_room.rs:1090-1205`

**Interfaces:**
- Consumes: existing frame predicates and `sync_current_live_{scalar,session,runtime,field}_frame` functions.
- Produces: private generic `sync_current_live_delta_with` whose closure order is unit-testable; public behavior remains `sync_current_live_delta(session_id, payload) -> Result<()>`.

- [ ] **Step 1: Add RED routing-order tests**

Extend `live_delta_routing_tests` with a helper payload containing both a scalar row and session/runtime data. Use closures that push labels into `Vec<&str>`:

```rust
fn payload_with_scalar_session_and_runtime() -> CurrentLiveSnapshotPayload {
    CurrentLiveSnapshotPayload {
        session_status: Some("running".to_string()),
        latest_scalar_row: Some(CurrentLiveScalarRow {
            step: 1,
            time: 0.0,
            solver_dt: 0.0,
            error_estimate: None,
            max_error: None,
            dt_suggested: None,
            rejected_attempts: 0,
            pseudo_time_s: None,
            active_runtime_s: None,
            mx: 1.0,
            my: 0.0,
            mz: 0.0,
            e_ex: 0.0,
            e_demag: 1.0,
            e_ext: 0.0,
            e_ani: 0.0,
            e_dmi: 0.0,
            e_total: 1.0,
            max_dm_dt: 0.0,
            max_h_eff: 0.0,
            max_h_demag: 0.0,
            max_torque_Apm: 0.0,
            max_torque_T: 0.0,
            per_object_scalars: HashMap::new(),
            table_expressions: Vec::new(),
        }),
        engine_log: Some(Vec::new()),
        ..CurrentLiveSnapshotPayload::default()
    }
}

#[test]
fn scalar_frame_precedes_heavy_frames() {
    let payload = payload_with_scalar_session_and_runtime();
    let mut calls = Vec::new();
    sync_current_live_delta_with(
        "session-1",
        &payload,
        |_, _| { calls.push("scalar"); Ok(()) },
        |_, _| { calls.push("session"); Ok(()) },
        |_, _| { calls.push("runtime"); Ok(()) },
        |_, _| { calls.push("field"); Ok(()) },
    )
    .unwrap();
    assert_eq!(calls[..3], ["scalar", "session", "runtime"]);
}

#[test]
fn scalar_failure_stops_before_heavy_frames() {
    let payload = payload_with_scalar_session_and_runtime();
    let mut calls = Vec::new();
    let error = sync_current_live_delta_with(
        "session-1",
        &payload,
        |_, _| { calls.push("scalar"); Err(anyhow::anyhow!("scalar failed")) },
        |_, _| { calls.push("session"); Ok(()) },
        |_, _| { calls.push("runtime"); Ok(()) },
        |_, _| { calls.push("field"); Ok(()) },
    )
    .unwrap_err();
    assert_eq!(calls, ["scalar"]);
    assert!(error.to_string().contains("scalar failed"));
}
```

Import `std::collections::HashMap`, `CurrentLiveScalarRow`, and `CurrentLiveSnapshotPayload` in the test module.

- [ ] **Step 2: Run the RED tests**

Run:

```bash
cargo test -p fullmag-cli live_delta_routing_tests --no-fail-fast
```

Expected: compilation failure because `sync_current_live_delta_with` and the test helper do not yet exist.

- [ ] **Step 3: Implement the generic scalar-first router**

Add a private helper with four `FnMut` arguments. Its first branch must be:

```rust
if payload.latest_scalar_row.is_some() {
    scalar_sync(session_id, payload)?;
}
```

Then preserve the existing session, runtime, and field predicates in that order. Implement the production wrapper as:

```rust
pub(crate) fn sync_current_live_delta(
    session_id: &str,
    payload: &CurrentLiveSnapshotPayload,
) -> Result<()> {
    sync_current_live_delta_with(
        session_id,
        payload,
        sync_current_live_scalar_frame,
        sync_current_live_session_frame,
        sync_current_live_runtime_frame,
        sync_current_live_field_frame,
    )
}
```

Do not catch a scalar error and do not report success when any required frame fails.

- [ ] **Step 4: Run focused and existing publisher tests**

Run:

```bash
cargo test -p fullmag-cli live_delta_routing_tests --no-fail-fast
cargo test -p fullmag-cli publish_cycle_ --no-fail-fast
cargo test -p fullmag-cli live_scalar_telemetry_gate_ --no-fail-fast
```

Expected: routing, fallback, and telemetry cadence tests pass.

- [ ] **Step 5: Review checkpoint without commit**

Run:

```bash
git diff --check -- crates/fullmag-cli/src/control_room.rs
git diff -- crates/fullmag-cli/src/control_room.rs
```

Expected: scalar-first ordering is the only runtime publication semantic change.

---

### Task 3: Regression and resource-first contract gates

**Files:**
- Verify only: `crates/fullmag-cli/src/control_room.rs`
- Verify only: `crates/fullmag-cli/src/orchestrator.rs`
- Verify only: `crates/fullmag-api/src/router_v2/handlers/data/scalars.rs`
- Verify only: `apps/control-room` generated API and facade paths remain unchanged.

**Interfaces:**
- Consumes: Tasks 1-2 implementation.
- Produces: evidence that no public route/schema/frontend transport changed and no public v1 dependency was introduced.

- [ ] **Step 1: Run the focused CLI suite**

Run:

```bash
cargo test -p fullmag-cli headless_api_port_tests --no-fail-fast
cargo test -p fullmag-cli live_delta_routing_tests --no-fail-fast
cargo test -p fullmag-cli publish_cycle_ --no-fail-fast
cargo test -p fullmag-cli live_scalar_telemetry_gate_ --no-fail-fast
```

Expected: all selected tests pass.

- [ ] **Step 2: Prove the browser contract did not change**

Run:

```bash
git diff --name-only -- crates/fullmag-api apps/control-room docs/specs
rg '"/v1(?!/internal)' crates/fullmag-api/src/main.rs --pcre2
rg '"/v2/' apps/control-room/src --glob '!**/api/generated/**'
```

Expected: no changed files under public API/frontend paths from this task; no new public v1 route or ad-hoc frontend v2 path appears.

- [ ] **Step 3: Run repository resource-first guards**

Run:

```bash
./scripts/ci-resource-first-gates.sh --strict
./scripts/ci/contract_guard.sh --strict
```

Expected: both pass, or any pre-existing unrelated failure is recorded with exact output and not attributed to this patch.

- [ ] **Step 4: Review checkpoint without commit**

Confirm that OpenAPI v2, generated types/transport, frontend API modules/hooks/codecs/adapters, unified ribbon, and viewport have no diff because their public contract did not change.

---

### Task 4: Separate managed P2 runtime and same-run API capture

**Files:**
- Verify: `tests/standard_problems/mumag/sp4/fem/qualification_scenarios/demag_p1_p2_fixed_mesh_qualification.py`
- Verify: `tests/standard_problems/mumag/sp4/fem/demag_root_cause_qualification.py`
- Generate: `/tmp/fullmag-sp4-demag-diagnostic.nGZsgE/p2-refined-fixed-mesh-live-v6/`
- Generate: `/tmp/fullmag-sp4-demag-diagnostic.nGZsgE/p2-refined-fixed-mesh-live-v6/telemetry.json`
- Generate: `/tmp/fullmag-sp4-demag-diagnostic.nGZsgE/p2-refined-fixed-mesh-live-v6/p2-qualification.json`

**Interfaces:**
- Consumes: strict headless API port selection, scalar-first publication, accepted P1 report, restored fixed mesh.
- Produces: exact-match managed runtime identity, real v2 scalar response, final P2 qualification report.

- [ ] **Step 1: Revalidate the immutable mesh and accepted P1 gate**

Run the canonical mesh loader and assert:

```text
171808 nodes
1080866 elements
60304 boundary faces
planner topology fingerprint sha256:8537dd1c8a2ff41638cf17eb496a6cb1d693f700b178630a8683d994d443b1c3
```

Read `/tmp/fullmag-sp4-demag-diagnostic.nGZsgE/p1-refined-fixed-mesh-final-v5/root-cause-report.json` and require `verdict == "p1_approximation_error"` and `same_fixed_mesh == true`.

- [ ] **Step 2: Build the P2 managed runtime through `just`**

Run from the P2 worktree:

```bash
env TMPDIR=/tmp FULLMAG_RUNTIME_PRUNE=0 just ensure-managed-fem-runtime
```

Expected: exit `0`, `bundle: exact-match`, and a recorded source snapshot/variant identity.

- [ ] **Step 3: Start the packaged API on a fixed loopback port**

Start in a retained terminal session:

```bash
env FULLMAG_API_PORT=18233 \
  FULLMAG_PYTHON=.fullmag/local/python/bin/python \
  LD_LIBRARY_PATH=.fullmag/runtimes/fem-gpu-host/lib \
  .fullmag/runtimes/fem-gpu-host/bin/fullmag-api
```

Expected: compatible API responds on `127.0.0.1:18233`, scene helpers use the
managed Python environment, and no browser/frontend is started.

- [ ] **Step 4: Run managed P2 headless against that API and exact mesh**

Run:

```bash
env TMPDIR=/tmp \
  OMPI_MCA_orte_tmpdir_base=/tmp \
  FULLMAG_API_PORT=18233 \
  FULLMAG_PYTHON=.fullmag/local/python/bin/python \
  FULLMAG_RUNTIME_PRUNE=0 \
  FULLMAG_SP4_FIXED_MESH=/tmp/fullmag-sp4-demag-diagnostic.nGZsgE/sp4-p2-edge-refined-restored.fullmag-mesh \
  FULLMAG_RELAX_MAX_STEPS=1 \
  just fem-managed-headless cpu \
    tests/standard_problems/mumag/sp4/fem/qualification_scenarios/demag_p1_p2_fixed_mesh_qualification.py \
    /tmp/fullmag-sp4-demag-diagnostic.nGZsgE/p2-refined-fixed-mesh-live-v6
```

Expected: exit `0`, P2 potential order `2`, the exact fixed mesh counts, no lossy fallback, and initial scalar row publication.

- [ ] **Step 5: Capture the real public scalar resource**

Request:

```bash
curl -fsS \
  'http://127.0.0.1:18233/v2/sessions/current/data/scalars?since_revision=0&columns=step,time,mx,my,mz,e_demag,e_total'
```

Save the exact response as `telemetry.json` under the P2 output directory. Require at least the initial and final rows, matching session/run identity where exposed by adjacent thin status resources. Do not synthesize missing rows from artifacts.

- [ ] **Step 6: Stop only the API process started in Step 3**

Terminate the retained process explicitly and verify port `18233` is no longer served. Do not stop unrelated API/frontend processes.

---

### Task 5: Final scientific qualification and review

**Files:**
- Verify: `/tmp/fullmag-sp4-demag-diagnostic.nGZsgE/p1-refined-fixed-mesh-final-v5/root-cause-report.json`
- Verify: `/tmp/fullmag-sp4-demag-diagnostic.nGZsgE/p2-refined-fixed-mesh-live-v6/metadata.json`
- Verify: `/tmp/fullmag-sp4-demag-diagnostic.nGZsgE/p2-refined-fixed-mesh-live-v6/scalars.csv`
- Verify: `/tmp/fullmag-sp4-demag-diagnostic.nGZsgE/p2-refined-fixed-mesh-live-v6/telemetry.json`
- Generate: `/tmp/fullmag-sp4-demag-diagnostic.nGZsgE/p2-refined-fixed-mesh-live-v6/p2-qualification.json`

**Interfaces:**
- Consumes: same-run P2 artifacts and telemetry from Task 4.
- Produces: bounded scientific conclusion distinguishing P1 approximation error, P2 candidate accuracy, telemetry/table consistency, and remaining qualification limits.

- [ ] **Step 1: Run the qualification validator**

Run:

```bash
python3 tests/standard_problems/mumag/sp4/fem/demag_root_cause_qualification.py p2-edge \
  --artifacts /tmp/fullmag-sp4-demag-diagnostic.nGZsgE/p2-refined-fixed-mesh-live-v6 \
  --root-report /tmp/fullmag-sp4-demag-diagnostic.nGZsgE/p1-refined-fixed-mesh-final-v5/root-cause-report.json \
  --telemetry /tmp/fullmag-sp4-demag-diagnostic.nGZsgE/p2-refined-fixed-mesh-live-v6/telemetry.json \
  --output /tmp/fullmag-sp4-demag-diagnostic.nGZsgE/p2-refined-fixed-mesh-live-v6/p2-qualification.json
```

Expected: `status == "qualified"`, P2 initial demag relative error at most `0.01`, and no average-m mismatch.

- [ ] **Step 2: Run all qualification unit tests**

Run:

```bash
PYTHONPATH=packages/fullmag-py/src python3 -m pytest -q \
  tests/standard_problems/mumag/sp4/fem/test_demag_root_cause_qualification.py
```

Expected: all non-opt-in tests pass; managed opt-in test remains skipped unless explicitly enabled with real artifact paths.

- [ ] **Step 3: Inspect final diffs and obtain independent review**

Run:

```bash
git diff --check
git diff --name-only
```

Dispatch an independent reviewer for:

- strict headless default/explicit-port semantics,
- scalar-first failure behavior,
- absence of public API/frontend drift,
- validity of same-mesh/same-state P1 and P2 evidence,
- no broad FEM/FDM equivalence claim beyond the SP4 energy gate.

- [ ] **Step 4: Report the bounded conclusion without commit or merge**

Report separately:

- P1 root cause: approximation error versus operator/RHS/recovery mismatch,
- P2 initial and final energy errors versus FDM/Newell,
- table/API/recomputed global average magnetization consistency,
- managed runtime source and variant identities,
- remaining limitations, especially the transitional heavy internal JSON bridge and the distinction between this SP4 gate and broad backend equivalence.
