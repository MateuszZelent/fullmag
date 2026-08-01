# Bounded FEM Mixed Prism-Airbox Runtime Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fail-closed managed CPU one-step runtime gate for the exact checked-in SP4 mixed prism/pyramid shared-domain scenario without changing its authored defaults.

**Architecture:** A focused Python tool prepares exactly one temporary `max_steps=1` source and validates the resulting artifact bundle. A `just` recipe delegates execution to the existing `fem-managed-headless cpu` route and stores hashes plus validated runtime evidence.

**Tech Stack:** Python standard library, `unittest`, Just, existing Fullmag managed FEM runtime and headless artifact schema.

## Global Constraints

- Do not modify the canonical SP4 scenario.
- Require exactly one `max_steps=50_000` source occurrence before rewriting.
- Preserve authored `device=auto`; require a separate managed CPU override.
- Require strict FEM double, `fem_cpu_native`, no fallback, exact certificate/fingerprint identity, one executed step, and finite energies/torque.
- Do not promote capability status and do not run the managed recipe before explicit root clearance.

---

### Task 1: Prepare and validate the bounded runtime evidence

**Files:**
- Create: `scripts/verify_fem_mixed_prism_airbox_runtime.py`
- Create: `scripts/test_verify_fem_mixed_prism_airbox_runtime.py`

**Interfaces:**
- Produces: `prepare_bounded_scenario(source: Path, output: Path) -> dict[str, object]`
- Produces: `validate_runtime_artifacts(source: Path, bounded_source: Path, artifacts: Path) -> dict[str, object]`

- [x] **Step 1: Write failing tests for exact source replacement and fail-closed mutations**

Create tests that require one replacement, unchanged canonical bytes, an accepted synthetic bundle, and rejection of wrong device/engine/fallback/fingerprint/report/step/non-finite fields.

- [x] **Step 2: Run tests and confirm RED**

Run: `python3 -m unittest scripts.test_verify_fem_mixed_prism_airbox_runtime`

Expected: import failure because the verifier module does not exist.

- [x] **Step 3: Implement the standard-library prepare and validate modes**

Use exact object/list/string/number checks, `math.isfinite`, CSV parsing, and SHA-256 hashes. Write the summary only after all validation succeeds.

- [x] **Step 4: Run tests and confirm GREEN**

Run: `python3 -m unittest scripts.test_verify_fem_mixed_prism_airbox_runtime`

Expected: all tests pass.

### Task 2: Publish the repository-managed runtime recipe

**Files:**
- Modify: `justfile`
- Modify: `docs/physics/0106-fem-mixed-prism-pyramid-shared-domain.md`
- Modify: `.superpowers/sdd/progress.md`

**Interfaces:**
- Consumes: verifier `prepare` and `validate` CLI modes.
- Produces: `just verify-fem-mixed-prism-airbox-runtime`.

- [x] **Step 1: Add a failing recipe-source contract test**

Extend the verifier test module to require the named recipe, canonical scenario,
existing `fem-managed-headless cpu` route, explicit artifact output, and final
validator invocation.

- [x] **Step 2: Run the focused test and confirm RED**

Run: `python3 -m unittest scripts.test_verify_fem_mixed_prism_airbox_runtime`

Expected: failure because the recipe is absent.

- [x] **Step 3: Add the minimal recipe and truthful documentation**

The recipe prepares a temporary source, runs the managed CPU route, preserves
the bounded source and log under `.fullmag/reports/fem-mixed-prism-airbox-runtime`,
and writes `summary.v1.json` only through the validator. Documentation records
the gate as pending until it is actually run.

- [x] **Step 4: Run non-managed verification only**

Run the unittest module, Python compile checks, `just --summary`, and scoped
`git diff --check`. Do not invoke the new managed recipe.
