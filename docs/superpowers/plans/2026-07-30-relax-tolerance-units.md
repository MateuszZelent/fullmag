# Relaxation Tolerance Units Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the ambiguous public `tol` relaxation threshold with default tesla-valued `tolT` and explicit A/m-valued `tolA`, while preserving a single A/m threshold in `ProblemIR` and runtime execution.

**Architecture:** Python entry points normalize exactly one public unit into `RelaxStop.torque_tolerance_apm`; no backend or `ProblemIR` unit change is required. Script export performs the inverse conversion and always renders `tolT`, so Python and UI exports remain in the canonical public unit.

**Tech Stack:** Python 3, pytest, existing Fullmag Python DSL, Rust `ProblemIR` JSON contract, MyST/Sphinx documentation.

## Global Constraints

- Public default: `tolT=1e-6` in tesla.
- `tolA` and `tolT` are mutually exclusive; `tol` is rejected, never interpreted.
- `tolT / (4π×10⁻⁷ T m A⁻¹)` is the canonical `torque_tolerance_apm`.
- The internal stop criterion and every backend remain A/m-valued.
- Preserve unrelated dirty changes on `master`; do not commit them.

---

### Task 1: Publish the unit contract

**Files:**
- Modify: `docs/physics/0580-canonical-relaxation-equilibrium-contract.md`
- Modify: `docs/physics/0580-canonical-relaxation-equilibrium-contract.source-map.json`
- Test: `.agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py`

**Interfaces:**
- Produces: the physics-first contract for `tolT`, `tolA`, `torque_tolerance_apm`, and script export.

- [ ] Add `tolT=1e-6 T` as the default public authoring threshold, `tolA` as the A/m alternative, and the conversion equation.
- [ ] State the exact rejection semantics for legacy `tol` and for both unit parameters.
- [ ] Keep the stop equation `max_torque_Apm <= torque_tolerance_apm` and update the source map with the Python normalizer and script-export symbols.
- [ ] Run the scientific source-map validator for this page and record its exit status.

### Task 2: Establish API regression tests

**Files:**
- Modify: `packages/fullmag-py/tests/test_api.py`
- Modify: `packages/fullmag-py/tests/test_script_builder_roundtrip.py`

**Interfaces:**
- Consumes: `StudyStagesBuilder.add_relax`, `relax_stage`, and flat `relax` APIs.
- Produces: failing tests for public units, invalid combinations, IR lowering, and export.

- [ ] Add a test asserting omitted tolerance lowers to `1e-6 / μ₀ A/m`.
- [ ] Add separate tests asserting `tolT=1e-6` and `tolA=0.7957747154594767` lower to the same canonical threshold.
- [ ] Add tests rejecting `tol=...` and simultaneous `tolA` plus `tolT` with migration-oriented messages.
- [ ] Add a script-builder round-trip test asserting canonical output contains `tolT=` and not `tol=`.
- [ ] Run those tests and confirm they fail because the new keywords and exported form do not exist yet.

### Task 3: Normalize public units at all relaxation facades

**Files:**
- Modify: `packages/fullmag-py/src/fullmag/world.py`
- Modify: `packages/fullmag-py/src/fullmag/model/study.py`
- Modify: `packages/fullmag-py/src/fullmag/runtime/script_builder.py`

**Interfaces:**
- Produces: `tolT: object = _RELAX_UNSET`, `tolA: object = _RELAX_UNSET` on every public relax/minimize/staged facade.
- Produces: canonical `RelaxStop.torque_tolerance_apm: float`.

- [ ] Introduce one local unit normalizer that defaults `tolT`, validates finite positive values, rejects `tol`, and rejects both explicit unit parameters.
- [ ] Route `relax_stage`, `StudyStagesBuilder.add_relax`, `add_minimize`, and flat relaxation/minimization functions through it.
- [ ] Keep `RelaxStop` and `ProblemIR` storage in A/m.
- [ ] Render script-builder direct calls as `tolT=<μ₀ × torque_tolerance_apm>`.
- [ ] Run the focused API and round-trip tests until they pass.

### Task 4: Migrate repository-owned callers

**Files:**
- Modify: every non-vendored Python script, test, and documentation example found by a scoped `rg` for relaxation calls using `tol=`.
- Test: `packages/fullmag-py/tests/test_api.py`, `packages/fullmag-py/tests/test_script_builder_roundtrip.py`, selected relaxation contract tests.

**Interfaces:**
- Consumes: removed `tol` keyword.
- Produces: explicit `tolT` when preserving the former numerical A/m threshold is not intended, otherwise `tolA` with that exact old value.

- [ ] Classify each caller: use `tolA=<old value>` to preserve its execution threshold; use `tolT` only where the script deliberately adopts the new tesla public default.
- [ ] Replace all non-vendored public relaxation-call `tol=` occurrences; do not alter unrelated numerical tolerances.
- [ ] Run a scoped search proving no relax call still uses `tol=`.
- [ ] Run the focused Python relaxation suite and inspect failures individually.

### Task 5: Final validation

**Files:**
- Verify: all modified files.

- [ ] Run `git diff --check`.
- [ ] Run the focused Python API, script-builder, and relaxation-contract test files.
- [ ] Run the scientific-documentation source-map validator.
- [ ] Inspect `git diff` and `git status --short`; report changed files and any unrelated pre-existing edits separately.
