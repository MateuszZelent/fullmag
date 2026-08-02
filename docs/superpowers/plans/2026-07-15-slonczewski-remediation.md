# Canonical Slonczewski Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make canonical Slonczewski v1 physically exact on FDM CPU and impossible to execute silently with legacy CUDA or InterfaceFlux semantics.

**Architecture:** Add a backend-neutral formula discriminator to the engine configuration, keep separate legacy and v1 coefficient paths, preserve realization identity in FDM planning, and reject unsupported native CUDA/InterfaceFlux paths before execution. Normalize and validate canonical inputs at both Python and Rust boundaries.

**Tech Stack:** Rust, Python, CUDA FFI boundary, Cargo tests, pytest, repo `just` verification.

## Global Constraints

- Do not modify dynamic Oersted code or semantics.
- Preserve `slonczewski.legacy_fullmag.v0` bit compatibility.
- Never silently execute canonical v1 using legacy CUDA semantics.
- Use exact `e=1.602176634e-19` only for canonical v1.

---

### Task 1: IR, Python, and realization legality

**Files:**
- Modify: `crates/fullmag-ir/src/validation.rs`
- Modify: `crates/fullmag-ir/tests/ir_tests.rs`
- Modify: `crates/fullmag-plan/src/spin_torque.rs`
- Modify: `crates/fullmag-plan/src/fdm.rs`
- Modify: `crates/fullmag-ir/src/plan.rs`
- Modify: `packages/fullmag-py/src/fullmag/model/spin_torque.py`
- Test: `packages/fullmag-py/tests/test_spin_transport_runtime_roundtrip.py`

**Interfaces:**
- Produces: normalized canonical axes and preserved `SlonczewskiRealizationIR` in `FdmPlanIR`.
- Produces: FDM planning error for `slonczewski_interface_flux.v1`.

- [ ] Add failing Rust and Python tests for NaN/Inf rejection, unit-axis normalization, and InterfaceFlux FDM rejection.
- [ ] Run focused tests and confirm the intended failures.
- [ ] Implement finite validation, planner normalization, realization propagation, and fail-closed legality.
- [ ] Run focused tests until green.
- [ ] Commit the IR/Python/planner remediation.

### Task 2: Versioned FDM CPU evaluator

**Files:**
- Modify: `crates/fullmag-engine/src/fdm/shared/terms.rs`
- Modify: `crates/fullmag-engine/src/fdm/cpu/fields.rs`
- Modify: `crates/fullmag-runner/src/fdm/cpu/reference/interactions.rs`
- Modify: `crates/fullmag-runner/src/fdm/cpu/reference.rs`

**Interfaces:**
- Consumes: `FdmPlanIR.slonczewski_formula_version`.
- Produces: `SlonczewskiFormula::{LegacyFullmagV0, FullmagV1}` in `SlonczewskiSttConfig`.

- [ ] Add failing independent v1 macrospin tests for coefficients, exact SI scale, sign reversal, mask, and AoS/SoA parity.
- [ ] Run focused engine tests and confirm they fail against the legacy evaluator.
- [ ] Implement minimal formula-discriminated coefficient and constant paths.
- [ ] Run focused engine and runner tests until green.
- [ ] Commit the CPU remediation.

### Task 3: CUDA canonical fail-closed

**Files:**
- Modify: `crates/fullmag-runner/src/fdm/gpu/cuda/native.rs`
- Modify: `crates/fullmag-runner/src/fdm/gpu/cuda/native/tests.rs` when the external test module is active.

**Interfaces:**
- Consumes: `FdmPlanIR.slonczewski_formula_version`.
- Produces: `RunError` before FFI construction for canonical v1.

- [ ] Add a failing construction test expecting canonical v1 rejection.
- [ ] Run the focused CUDA-wrapper test and confirm failure.
- [ ] Add the narrow pre-FFI fail-closed guard; leave legacy descriptor fields unchanged.
- [ ] Run focused tests until green.
- [ ] Commit the CUDA legality remediation.

### Task 4: Final verification

**Files:**
- Verify only; no planned production edits.

**Interfaces:**
- Consumes all prior commits.
- Produces fresh test and build evidence.

- [ ] Run focused Rust engine/IR/planner/runner tests.
- [ ] Run focused Python round-trip and validation tests.
- [ ] Run `just check`.
- [ ] Inspect `git diff`, `git status`, and commit boundaries; confirm no Oersted changes.
