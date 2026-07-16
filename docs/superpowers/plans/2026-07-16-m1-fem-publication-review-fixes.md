# M1 FEM Publication Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the bounded FEM CPU-double steady-transport result survive canonical artifact persistence and the v2 field data plane without changing its physics or capability status.

**Architecture:** Keep the native solver and typed transport bundle unchanged, but publish the bundle through the artifact pipeline owner after the main FEM execution has supplied canonical run provenance. Partition steady-transport quantities from the time-domain snapshot scheduler, fail closed on multiple modules until resource identity supports them, and harden descriptor validation against the actual mesh before any ABI call.

**Tech Stack:** Rust, serde JSON, Fullmag artifact pipeline, OpenAPI v2 field data plane, MFEM managed runtime, `just`.

## Global Constraints

- FEM M1 remains CPU, double precision, strict mode, conforming H1/P1, transparent interfaces, and one-way coupling.
- Capability status remains `reference_executable`; implementation and validation evidence remain `executable` and `algebra_validated`.
- No hidden fallback, no physics/operator change, and no CUDA semantic change.
- Native FEM proof uses `just verify-fem-steady-transport-native-contract`.
- HTTP v2 remains the field source of truth; websocket behavior and OpenAPI shapes do not change.

---

### Task 1: Artifact lifecycle and units

**Files:**
- Modify: `crates/fullmag-runner/src/artifact_pipeline.rs`
- Modify: `crates/fullmag-runner/src/dispatch.rs`
- Modify: `crates/fullmag-runner/src/artifacts.rs`
- Test: `crates/fullmag-runner/src/artifacts.rs`

**Interfaces:**
- Consumes: `NativeFemSteadyTransportBundle.field_snapshots` and final `ExecutionProvenance`.
- Produces: a sender method that enqueues canonical `FieldSnapshot` jobs and catalog-owned artifact units.

- [ ] Add a streaming regression test proving scalar, vector, and tensor transport records are written by the pipeline.
- [ ] Run the focused test and confirm the expected missing-publication failure.
- [ ] Add a non-streaming regression test proving all five transport units serialize without panic.
- [ ] Run the focused test and confirm the expected unsupported-observable failure.
- [ ] Implement sender publication after FEM execution and resolve units through `fullmag_quantities::quantity_spec`.
- [ ] Run both focused tests and confirm clean passes.

### Task 2: Schedule and identity fail-closed behavior

**Files:**
- Modify: `crates/fullmag-runner/src/native_fem/steady_transport/publication.rs`
- Modify: `crates/fullmag-runner/src/dispatch.rs`
- Modify: `crates/fullmag-runner/src/native_fem/steady_transport/descriptor.rs`
- Test: `crates/fullmag-runner/src/native_fem/steady_transport.rs`

**Interfaces:**
- Consumes: `OutputIR` field/snapshot records and `FemPlanIR.spin_transport_plans`.
- Produces: time-domain output filtering for the five already-materialized steady quantities and an explicit single-module M1 preflight contract.

- [ ] Add failing tests for transport output filtering and multiple-module rejection before FFI.
- [ ] Implement the five-ID classifier/filter and explicit one-module guard.
- [ ] Run focused tests and confirm clean passes.

### Task 3: Mesh-bound descriptor integrity

**Files:**
- Modify: `crates/fullmag-runner/src/native_fem/steady_transport/descriptor.rs`
- Test: `crates/fullmag-runner/src/native_fem/steady_transport.rs`

**Interfaces:**
- Consumes: the actual `MeshIR` plus the resolved descriptor.
- Produces: fail-closed validation for full-domain masks, conductivity length, boundary attributes, Dirichlet attributes, and torque-target masks.

- [ ] Add failing mutation tests for wrong mask length, false mask entries, absent boundary attributes, and invalid torque-target masks.
- [ ] Pass the mesh into contradiction validation and implement the minimum exact checks.
- [ ] Run focused tests and confirm clean passes.

### Task 4: V2 data-plane proof and orphan review

**Files:**
- Modify: `crates/fullmag-api/src/router_v2/tests.rs`
- Review without changing: `crates/fullmag-runner/src/interactive_runtime/fem/cpu.rs`
- Modify: `justfile`

**Interfaces:**
- Consumes: existing `LatestFields` JSON and `/v2/sessions/current/data/fields/{quantity_id}/samples/vector` FMVP response.
- Produces: route-level proof that catalog component counts 1, 3, and 9 survive the canonical v2 reader without an OpenAPI shape change.

- [ ] Add a failing route test with `V_electric`, `J_charge`, and `spin_current_tensor` payloads.
- [ ] Make only the generic reader correction required by that test, if any.
- [x] Keep the split file out of this remediation diff; its mandatory snapshot metadata
  must remain carrier-compatible if the module is wired later.
- [ ] Extend the managed recipe with exact integrated runner and API tests.
- [ ] Run focused route and runner tests.

### Task 5: Documentation, managed proof, and handoff

**Files:**
- Modify: `docs/physics/0970-spin-hall-drift-diffusion-transport.md`
- Modify: `/tmp/fullmag-spin-transport/.superpowers/sdd/m1-fem-report.md`

**Interfaces:**
- Consumes: fresh focused and managed verification output.
- Produces: an evidence-backed closure report with remaining qualification boundaries.

- [ ] Update the physics note to state the one-module artifact identity boundary and recorder-owned persistence.
- [ ] Run `just verify-fem-steady-transport-native-contract` and read its complete output.
- [ ] Run `git diff --check`, inspect status/diff, and verify no unrelated changes.
- [ ] Update the report with exact commands, counts, warnings, and gaps.
- [ ] Commit with a descriptive message and return the commit hash.
