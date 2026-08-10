# Spin Transport Authoring Parameter Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task with verification checkpoints.

**Goal:** Add a fail-closed, leaf-by-leaf parity gate proving that the public Python transport/torque/Oersted authoring contract, scene resources, ProblemIR/planner semantics, and Control Room drafts preserve the same parameters.

**Architecture:** A versioned JSON manifest is the inventory only; Python, Rust, OpenAPI, and TypeScript remain semantic owners. Python and TypeScript tests consume the manifest directly, while a managed repository recipe aggregates their results and writes provenance without promoting numerical capabilities.

**Tech Stack:** Python `unittest`/pytest, Rust `fullmag-ir`/`fullmag-plan` tests, TypeScript Vitest, JSON manifest, repository `justfile`.

## Global Constraints

- Unsupported execution lanes must preserve authoring data or fail closed; they must never silently fall back to another backend/device.
- Existing SI units, signs, formula versions, and `ProblemIR` field names are authoritative; the manifest cannot redefine physics.
- Native FEM/MFEM/CUDA verification uses the container-backed `just` workflow; this authoring gate itself must not claim FEM/GPU numerical qualification.
- Existing unrelated dirty files remain unstaged and untouched.

---

### Task 1: Freeze the manifest inventory

**Files:**
- Create: `docs/specs/spin-transport-authoring-parameter-parity-v1.json`
- Test: `scripts/test_spin_transport_authoring_parameter_parity.py`

**Interfaces:**
- Produces one manifest object with `schema_version`, `families`, `parameters`, and `unsupported_cases`.
- Each parameter entry contains `id`, `family`, `variant`, `python_path`, `ir_path`, `ui_field`, `unit`, `kind`, `status`, `round_trip`, and `planner_error_class`.

- [ ] **Step 1: Write the failing manifest-loader test.**

Create a Python test that loads the manifest, requires unique parameter IDs,
requires the three status values and three round-trip policies, and rejects an
entry that omits any of the four cross-layer path fields. The test must also
require at least these family/variant rows:

```python
required_variants = {
    ("current_transport", "prescribed_density"),
    ("current_transport", "ohmic_poisson"),
    ("spin_transport", "steady"),
    ("spin_transport", "transient"),
    ("spin_torque", "zhang_li"),
    ("spin_torque", "slonczewski"),
    ("spin_torque", "prescribed_sot"),
    ("oersted", "oersted_cylinder"),
    ("oersted", "oersted_field"),
}
```

Run:

```text
PYTHONPATH=packages/fullmag-py/src python3 -m unittest scripts.test_spin_transport_authoring_parameter_parity -v
```

Expected: FAIL because the manifest file does not exist.

- [ ] **Step 2: Add the manifest with every currently public leaf.**

List required leaves for current source identity/model/drive/coupling, charge
materials/boundaries/gauge/solver, spin source/domain/materials/interfaces/
boundaries/solver/nonlinear policy/execution, torque formula/drive/target
fields, and Oersted geometry/source/time envelope. Mark raw JSON collections as
`declared_unsupported` with `preserve_and_reject` only when the UI does not
provide typed leaves. Mark absent future MQS/skin/FEM-GPU controls explicitly
as `declared_unsupported`; do not omit them.

- [ ] **Step 3: Run the loader test.**

Run the same unittest command. Expected: PASS with all IDs unique and all
required variants present.

- [ ] **Step 4: Commit the manifest and loader test.**

```text
git add docs/specs/spin-transport-authoring-parameter-parity-v1.json scripts/test_spin_transport_authoring_parameter_parity.py
git diff --cached --name-only
git commit -m "test(transport): freeze authoring parity manifest"
```

### Task 2: Verify Python DSL and scene-document round-trip

**Files:**
- Create: `packages/fullmag-py/tests/test_spin_transport_authoring_parameter_parity.py`
- Modify: `scripts/test_spin_transport_authoring_parameter_parity.py`
- Read-only dependencies: `packages/fullmag-py/src/fullmag/model/current_transport.py`, `packages/fullmag-py/src/fullmag/model/spin_transport.py`, `packages/fullmag-py/src/fullmag/model/spin_torque.py`, `packages/fullmag-py/src/fullmag/model/energy.py`, `packages/fullmag-py/src/fullmag/runtime/scene_document.py`

**Interfaces:**
- Produces `build_parity_fixtures() -> dict[str, dict[str, object]]` in the
  Python test module, keyed by manifest family/variant.
- Produces a path resolver supporting dotted keys and `[*]` list selectors.

- [ ] **Step 1: Write fixture coverage tests.**

Build typed fixtures with non-default signed values so a dropped field cannot
hide behind a default. Assert every manifest `python_path` resolves in the
corresponding `to_ir()` payload and that `preserve_and_reject` entries survive
`build_scene_document_from_builder()` followed by
`build_builder_from_scene_document()`.

- [ ] **Step 2: Run the focused Python test before implementation.**

```text
PYTHONPATH=packages/fullmag-py/src python3 -m pytest -q packages/fullmag-py/tests/test_spin_transport_authoring_parameter_parity.py
```

Expected: FAIL for each missing fixture/path or missing manifest mapping.

- [ ] **Step 3: Implement only fixture/path helpers required by the test.**

Use the existing typed constructors. Do not add new public physics fields in
this task. For a `declared_unsupported` execution case, assert the existing
planner-facing representation is preserved and the unsupported status remains
explicit.

- [ ] **Step 4: Run the focused Python tests and the existing spin transport suite.**

```text
PYTHONPATH=packages/fullmag-py/src python3 -m pytest -q packages/fullmag-py/tests/test_spin_transport_authoring_parameter_parity.py packages/fullmag-py/tests/test_spin_drift_diffusion.py
```

Expected: all selected tests pass.

- [ ] **Step 5: Commit the Python evidence.**

```text
git add packages/fullmag-py/tests/test_spin_transport_authoring_parameter_parity.py scripts/test_spin_transport_authoring_parameter_parity.py
git diff --cached --name-only
git commit -m "test(python): cover transport authoring round-trip"
```

### Task 3: Verify Rust/ProblemIR fail-closed semantics

**Files:**
- Modify: `crates/fullmag-ir/tests/ir_tests.rs`
- Modify: `crates/fullmag-plan/src/spin_transport.rs` only if an existing error lacks the manifest-declared class
- Modify: `crates/fullmag-plan/src/tests.rs`
- Test fixture: `scripts/fixtures/spin_transport_authoring_parity.json`

**Interfaces:**
- Produces a Rust test helper that loads the checked-in manifest and asserts
  every executable IR path is serializable and every unsupported case returns
  its declared error class.

- [ ] **Step 1: Add a red test for manifest/ProblemIR coverage.**

The test must deserialize each fixture resource into `ProblemIR`, serialize it
again, and compare the manifest-listed paths. It must include one strict GPU
request for an unqualified FEM transport lane and assert the planner rejects it
without changing `resolved_device` to CPU.

- [ ] **Step 2: Run the focused Rust tests.**

```text
CARGO_TARGET_DIR=/tmp/fullmag-zfn2-build/cargo-targets/spin-transport-parity CARGO_INCREMENTAL=0 cargo test -p fullmag-ir --test ir_tests spin_transport
CARGO_TARGET_DIR=/tmp/fullmag-zfn2-build/cargo-targets/spin-transport-parity CARGO_INCREMENTAL=0 cargo test -p fullmag-plan spin_transport
```

Expected: the new test fails until the fixture and error-class assertions are
connected.

- [ ] **Step 3: Implement the smallest mapping/error corrections.**

Reuse existing `ProblemIR` serde and planner validation. Add no silent
fallback. If an error already has the correct semantic cause, assert its
stable class instead of changing production code.

- [ ] **Step 4: Re-run focused Rust tests and source checks.**

Expected: selected tests pass with no changed capability status.

- [ ] **Step 5: Commit the Rust evidence.**

```text
git add crates/fullmag-ir/tests/ir_tests.rs crates/fullmag-plan/src/tests.rs crates/fullmag-plan/src/spin_transport.rs scripts/fixtures/spin_transport_authoring_parity.json
git diff --cached --name-only
git commit -m "test(ir): enforce transport parity and fail-closed lanes"
```

### Task 4: Verify Control Room draft coverage

**Files:**
- Modify: `apps/control-room/src/modules/inspector/panels/TransportAuthoringInspectorModel.ts`
- Modify: `apps/control-room/src/modules/inspector/panels/TransportAuthoringInspectorModel.test.ts`
- Modify: `apps/control-room/src/modules/inspector/panels/SpinAuthoringInspectorModel.ts`
- Modify: `apps/control-room/src/modules/inspector/panels/SpinAuthoringInspectorModel.test.ts`
- Modify: `apps/control-room/src/modules/inspector/panels/SpinAuthoringInspector.tsx` only if builder field inventory must be exported

**Interfaces:**
- Produces exported test-only inventories for current/spin transport drafts
  and torque/Oersted draft keys.
- Preserves current unknown-record lossless read-only behavior.

- [ ] **Step 1: Add red Vitest assertions.**

Load the manifest from the repository, compare executable `ui_field` values
against the draft inventories, and require every raw JSON collection to carry
`ui_kind="opaque_json_collection"` plus `preserve_and_reject`.

- [ ] **Step 2: Run the focused Vitest tests.**

```text
pnpm --dir apps/control-room exec vitest run src/modules/inspector/panels/TransportAuthoringInspectorModel.test.ts src/modules/inspector/panels/SpinAuthoringInspectorModel.test.ts
```

Expected: FAIL for any manifest field not represented by a draft inventory.

- [ ] **Step 3: Add the minimal inventory exports and field mappings.**

Do not create a second UI schema. The inventory must be derived from the
existing draft keys/builders and only classify opaque JSON fields explicitly.

- [ ] **Step 4: Re-run the focused tests and typecheck.**

```text
pnpm --dir apps/control-room exec vitest run src/modules/inspector/panels/TransportAuthoringInspectorModel.test.ts src/modules/inspector/panels/SpinAuthoringInspectorModel.test.ts
pnpm --dir apps/control-room typecheck
```

Expected: selected tests and typecheck pass.

- [ ] **Step 5: Commit the UI evidence.**

```text
git add apps/control-room/src/modules/inspector/panels/TransportAuthoringInspectorModel.ts apps/control-room/src/modules/inspector/panels/TransportAuthoringInspectorModel.test.ts apps/control-room/src/modules/inspector/panels/SpinAuthoringInspectorModel.ts apps/control-room/src/modules/inspector/panels/SpinAuthoringInspectorModel.test.ts apps/control-room/src/modules/inspector/panels/SpinAuthoringInspector.tsx
git diff --cached --name-only
git commit -m "test(ui): enforce transport authoring parameter coverage"
```

### Task 5: Add the managed parity recipe and documentation evidence

**Files:**
- Modify: `justfile`
- Create: `scripts/verify_spin_transport_authoring_parameter_parity.py`
- Modify: `docs/raports/2026-07-15_audyt-stt-sot-she-fem-fdm/PLAN_WDROZENIA_I_SPECYFIKACJA_FIZYKI.md`
- Modify: `docs/specs/capability-matrix-v0.md` only to document the gate boundary; no capability promotion

**Interfaces:**
- Recipe: `just verify-spin-transport-authoring-parameter-parity`.
- Report schema: `fullmag.spin_transport_authoring_parameter_parity.v1` with
  manifest digest, source commit, Python/Rust/UI results, and explicit
  `qualification_boundary`.

- [ ] **Step 1: Add a red verifier test for report shape and command wiring.**

Require the recipe name, manifest path, report schema, and all three layer
results. Reject a report that contains `validated` or a hidden fallback.

- [ ] **Step 2: Implement the verifier using repository-managed commands.**

Use `PYTHONPATH=packages/fullmag-py/src`, the task-specific Cargo target under
`/tmp/fullmag-zfn2-build`, and the existing Control Room package scripts. Keep
large native artifacts on the managed `/zfn2`-backed storage path.

- [ ] **Step 3: Run the managed gate.**

```text
just verify-spin-transport-authoring-parameter-parity
```

Expected: report status `pass`, all layer results `pass`, unsupported cases
listed explicitly, and no capability promotion.

- [ ] **Step 4: Update the plan with exact evidence.**

Record the command, report path, manifest SHA-256, source commit, test counts,
and remaining numerical/runtime blockers. Do not replace historical addenda.

- [ ] **Step 5: Commit the gate and documentation.**

```text
git add justfile scripts/verify_spin_transport_authoring_parameter_parity.py docs/raports/2026-07-15_audyt-stt-sot-she-fem-fdm/PLAN_WDROZENIA_I_SPECYFIKACJA_FIZYKI.md docs/specs/capability-matrix-v0.md
git diff --cached --name-only
git commit -m "test(transport): add managed authoring parity gate"
```

## Final verification for this slice

Run the manifest loader, focused Python tests, focused Rust tests, focused
Vitest/typecheck, the managed recipe, `git diff --check`, and the scientific
documentation validator. The gate proves authoring parity only; it does not
close FEM/FDM continuum convergence, GPU residency, BORIS parity, or the
remaining TSan environment blocker.
