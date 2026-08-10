# Per-object absorbing boundary layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans (recommended) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a validated per-object `film.alpha.absorbing_boundary(...)` module, propagate it through Python/ProblemIR/planner/authoring UI, and rewrite the 4.5 GHz FEM scenario as a flat `study` script.

**Architecture:** The Python alpha proxy stores one immutable `AbsorbingBoundaryLayer`. `Ferromagnet.to_ir()` lowers it to an optional typed `MagnetIR` field. The planner adds the closed profile after region-owned alpha resolution, producing the existing cellwise/nodal alpha fields. Authoring scene and script-builder objects carry the same optional IR value for UI round-trip.

**Tech Stack:** Python dataclasses and loader capture; Rust `serde` ProblemIR/planner/authoring; existing FDM/FEM material-field ABI; React inspector/OpenAPI generated types; managed `just` verification for native FEM.

## Global Constraints

- Preserve unrelated dirty worktree changes and ignored `tests/vlad/` files.
- Keep the feature physics-first and fail closed for unsupported FDM CUDA cellwise alpha.
- Keep object ownership in the API, IR, planner, scene, and script export; do not add a global damping setting.
- Use `apply_patch` for edits and write a failing focused test before each implementation slice.
- Native FEM build/runtime evidence uses the repository container-backed `justfile` route.

## Task 1: Python contract and proxy tests

**Files:** `packages/fullmag-py/tests/test_absorbing_boundary.py`, scenario loader tests.

- [ ] Add tests for numeric alpha assignment/read compatibility, default object frame, parameter serialization, profile values, replacement, and validation errors.
- [ ] Add a loader assertion for the flat `tests/vlad/4.5GHz_fem.py` and its three-face layer.
- [ ] Run the focused tests and capture the expected red failure before implementation.

## Task 2: Python model and ProblemIR lowering

**Files:** `packages/fullmag-py/src/fullmag/model/absorbing_boundary.py`, model/fullmag exports, `world.py`, `structure.py`.

- [ ] Implement validated `AbsorbingBoundaryLayer` and `AlphaControl`.
- [ ] Add `MagnetHandle.alpha` property/setter without breaking numeric assignment.
- [ ] Attach the config to `Ferromagnet` and serialize it from `to_ir()`.
- [ ] Run Python unit tests and loader tests.

## Task 3: Rust IR validation and planner materialization

**Files:** `crates/fullmag-ir/src/model.rs`, `lib.rs`, `crates/fullmag-plan/src/material.rs`, `validate.rs`, tests.

- [ ] Add typed IR enums/struct and optional `MagnetIR` field; update Rust struct literals with `None`.
- [ ] Validate all numeric/enumerated fields and duplicate faces.
- [ ] Apply object/universe bounds and smootherstep/linear/quadratic profiles after region alpha resolution.
- [ ] Add FDM CUDA fail-closed capability validation for authored layers.
- [ ] Add unit tests for profiles, translations, corners, universe fallback, and capability errors.

## Task 4: Authoring and UI round-trip

**Files:** `crates/fullmag-authoring/src/{scene,builder,adapters}.rs`, API schemas/generated types, inspector panel/tests.

- [ ] Add optional object-level layer field to scene and script builder.
- [ ] Preserve it through both adapter directions and geometry override JSON.
- [ ] Expose editable width/ramp/damping/faces/profile/frame controls in the object inspector using existing resource-first and `fm-*` conventions.
- [ ] Add round-trip and UI model tests; regenerate OpenAPI/frontend types if the repo generator is available.

## Task 5: Flat FEM scenario and verification

**Files:** `tests/vlad/4.5GHz_fem.py`, scenario tests, `AGENTS.md` learning.

- [ ] Rewrite the script with module-level `study = fm.study(...)`, direct configuration calls, and only small geometry helpers where repetition warrants them.
- [ ] Replace the local ABC helper with `film.alpha.absorbing_boundary(...)` on the appropriate object(s), preserving antenna, end damping gradient, and stage sequence.
- [ ] Run `py_compile`, loader tests, and focused Python/Rust suites.
- [ ] Run the matching managed FEM contract recipe if dependencies permit; report any existing build blocker without claiming physics qualification.

## Completion gates

- [ ] No unsupported device silently drops the layer.
- [ ] Python and UI export the same object-level semantics.
- [ ] Focused tests pass; full relevant workspace checks are run or their blockers are recorded.
- [ ] Final report distinguishes source/tests, planner behavior, native build, and scientific runtime qualification.
