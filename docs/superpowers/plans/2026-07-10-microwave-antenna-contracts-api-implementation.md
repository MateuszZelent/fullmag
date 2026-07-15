# Microwave Antenna Contracts and API Implementation Plan

> Supersession note (2026-07-15): regional prescribed-field clauses are
> superseded by ADR 0019, physics note 0920, and the 2026-07-15 regional-field
> implementation plan. This document remains canonical for solved antenna
> layouts, field-solve artifacts, and `SolvedAntennaDrive`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce the canonical variable-width antenna, staged field-solve, solved-drive, regional-drive, artifact, capability, and OpenAPI contracts without implementing the native numerical solve.

**Architecture:** Python and UI authoring lower into the same typed `SceneDocument` and `ProblemIR`. `StudyPipelineDocument` owns `antenna_field_solve` ordering and stage dependencies. The planner resolves the precompute separately from the downstream LLG lane. OpenAPI v2 exposes revisioned model, stage, solution, field-analysis, and spectrum resources; generated transport remains low-level and HTTP remains authoritative.

**Tech Stack:** Python dataclasses and unittest/pytest, Rust/Serde and Cargo tests, Axum/Utoipa OpenAPI v2, generated TypeScript transport with openapi-typescript, Vitest contract tests.

## Global Constraints

- Implement after `docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md`, `docs/adr/0017-staged-antenna-field-basis-workflow.md`, and `docs/superpowers/specs/2026-07-10-microwave-antenna-field-basis-design.md`; those documents are normative.
- This is plan 1 of 3. Complete it before the numerical backend plan and before the UI plan.
- Do not make `CurrentTransport(model="ohmic_poisson")` the antenna contract. It remains a separate charge-transport semantic.
- New authoring emits `AntennaLayout`, `SolvedAntennaDrive`, or `RegionalFieldDrive`. Legacy `mqs_2p5d_az` is read-only compatibility with explicit provenance.
- `H_ant` is A/m. `amplitude_b_t` remains the public regional-drive convenience and lowers by division by `mu0`; it does not rename `H_ant` to `B_ext`.
- A waveform is excluded from the field-solution signature. Geometry, ports, mesh, conductivity, solver, sampling points, and projection topology are included.
- Frozen wire names across all three plans are `quasistatic_conduction_biot_savart_3d`, `antenna_field_solution.v1`, `normalization_current_a`, `stage_local`, `H_ant_basis`, `source-spectrum`, `local-k-spectrum`, and `dynamic-structure-factor`; do not introduce aliases.
- Forced unsupported field-solve lanes fail. There is no silent FEM GPU to CPU fallback.
- Do not add heavy arrays to status, JSON stage records, or websocket events.
- Do not edit generated TypeScript files manually; regenerate them with `pnpm --dir apps/control-room generate:api`.
- Preserve unrelated worktree changes. Commit only files named by the current task.

---

## Task 1: Add canonical Python antenna layouts and drives

**Files:**

- Modify: `packages/fullmag-py/src/fullmag/model/antenna.py`
- Modify: `packages/fullmag-py/src/fullmag/__init__.py`
- Modify: `packages/fullmag-py/src/fullmag/model/problem.py`
- Test: `packages/fullmag-py/tests/test_current_transport.py`

- [ ] **Step 1: Write failing constructor and serialization tests**

Add tests that construct a constricted CPW, a solved drive, and a regional drive:

```python
def test_variable_width_cpw_serializes_stations_and_balanced_port() -> None:
    layout = fm.CPWAntennaLayout(
        name="cpw_constriction",
        length=12e-6,
        thickness=120e-9,
        conductivity=58e6,
        stations=[
            fm.CPWWidthStation.symmetric(s=0.0, signal_width=2e-6, gap=1e-6, ground_width=4e-6),
            fm.CPWWidthStation.symmetric(s=0.5, signal_width=260e-9, gap=95e-9, ground_width=1.2e-6),
            fm.CPWWidthStation.symmetric(s=1.0, signal_width=2e-6, gap=1e-6, ground_width=4e-6),
        ],
        port_modes=[fm.AntennaPortMode.symmetric_cpw(name="drive_mode")],
    )
    ir = layout.to_ir()
    assert ir["kind"] == "cpw"
    assert [station["s"] for station in ir["stations"]] == [0.0, 0.5, 1.0]
    assert sum(t["current_weight"] for t in ir["port_modes"][0]["terminals"]) == 0.0


def test_solved_drive_references_earlier_stage_output() -> None:
    drive = fm.SolvedAntennaDrive(
        name="cpw_sinc_drive",
        solution=fm.StageOutputRef(stage_id="solve_cpw_field", output_id="field_basis"),
        port_mode="drive_mode",
        peak_current=0.01,
        waveform=fm.SincPulse(cutoff_hz=25e9, t0=100e-12),
        active_stages=["run_spin_waves"],
    )
    assert drive.to_ir()["solution_ref"]["stage_id"] == "solve_cpw_field"


def test_regional_drive_preserves_b_amplitude_and_h_identity() -> None:
    drive = fm.RegionalFieldDrive(
        name="fmr_drive",
        region="film",
        B=1e-3,
        direction=(0.0, 1.0, 0.0),
        waveform=fm.Sinusoidal(frequency_hz=10e9),
    )
    assert drive.to_ir()["amplitude_B_T"] == 1e-3
    assert drive.to_ir()["quantity"] == "H_ant"
```

- [ ] **Step 2: Run the focused tests and confirm they fail on missing public classes**

Run: `python -m pytest packages/fullmag-py/tests/test_current_transport.py -q`

Expected: collection or attribute failures for `CPWAntennaLayout`, `CPWWidthStation`, `AntennaPortMode`, `SolvedAntennaDrive`, `StageOutputRef`, and `RegionalFieldDrive`.

- [ ] **Step 3: Implement immutable Python authoring types**

Add these public types in `model/antenna.py` and export them from `fullmag/__init__.py`:

```python
@dataclass(frozen=True, slots=True)
class CPWWidthStation:
    s: float
    signal_width: float
    left_gap: float
    right_gap: float
    left_ground_width: float
    right_ground_width: float

    @classmethod
    def symmetric(
        cls, *, s: float, signal_width: float, gap: float, ground_width: float
    ) -> "CPWWidthStation":
        return cls(s, signal_width, gap, gap, ground_width, ground_width)

    def to_ir(self) -> dict[str, float]:
        return {
            "s": self.s,
            "signal_width_m": self.signal_width,
            "left_gap_m": self.left_gap,
            "right_gap_m": self.right_gap,
            "left_ground_width_m": self.left_ground_width,
            "right_ground_width_m": self.right_ground_width,
        }


@dataclass(frozen=True, slots=True)
class StageOutputRef:
    stage_id: str
    output_id: str

    def to_ir(self) -> dict[str, str]:
        return {"stage_id": self.stage_id, "output_id": self.output_id}
```

Implement equivalent complete types for `MicrostripWidthStation`, `AntennaTerminalGroup`, `AntennaPortMode`, `MicrostripAntennaLayout`, `CPWAntennaLayout`, `AntennaFieldSolve`, `SolvedAntennaDrive`, and `RegionalFieldDrive`. Constructor validation must enforce finite positive lengths, conductivity, thickness, nonzero directions, endpoint stations at `0` and `1`, strictly increasing station positions, unique ids, and current-weight balance within `1e-12`.

The CPW convenience constructor must lower symmetric values to distinct left/right values; the stored representation must never lose asymmetry.

- [ ] **Step 4: Integrate layouts and field drives into `Problem`**

Add typed collections:

```python
antenna_layouts: Sequence[AntennaLayout] = ()
field_drives: Sequence[FieldDrive] = ()
```

Serialize them at top level as `antenna_layouts` and `field_drives`. Validate unique names and references. Keep `current_modules` readable during migration but reject a new solved drive that also attempts to encode the same source through `current_modules`.

- [ ] **Step 5: Run focused and public API tests**

Run:

```bash
python -m pytest packages/fullmag-py/tests/test_current_transport.py -q
python -m pytest packages/fullmag-py/tests/test_api.py -q
```

Expected: both pass.

- [ ] **Step 6: Commit the Python surface**

```bash
git add packages/fullmag-py/src/fullmag/model/antenna.py packages/fullmag-py/src/fullmag/model/problem.py packages/fullmag-py/src/fullmag/__init__.py packages/fullmag-py/tests/test_current_transport.py
git commit -m "feat(py): add canonical antenna layouts and drives"
```

---

## Task 2: Add typed ProblemIR antenna and drive semantics

**Files:**

- Modify: `crates/fullmag-ir/src/study.rs`
- Modify: `crates/fullmag-ir/src/model.rs`
- Modify: `crates/fullmag-ir/src/lib.rs`
- Modify: `crates/fullmag-ir/src/validation.rs`
- Modify: `crates/fullmag-ir/src/plan.rs`
- Test: inline unit tests in the files above

- [ ] **Step 1: Write failing Serde and validation tests**

Add tests for a variable CPW round-trip, unbalanced ports, a missing return conductor, nonmonotone stations, and a solved drive with a dangling stage output.

```rust
#[test]
fn cpw_layout_round_trips_asymmetric_stations() {
    let layout = AntennaLayoutIR::Cpw {
        id: "cpw".into(),
        length_m: 12e-6,
        thickness_m: 120e-9,
        conductivity_s_per_m: 58e6,
        transform: AntennaTransformIR::identity(),
        stations: vec![
            CpwStationIR::symmetric(0.0, 2e-6, 1e-6, 4e-6),
            CpwStationIR {
                s: 1.0,
                signal_width_m: 1e-6,
                left_gap_m: 0.2e-6,
                right_gap_m: 0.3e-6,
                left_ground_width_m: 2e-6,
                right_ground_width_m: 3e-6,
            },
        ],
        port_modes: vec![AntennaPortModeIR::symmetric_cpw("drive_mode")],
    };
    let json = serde_json::to_value(&layout).unwrap();
    let decoded: AntennaLayoutIR = serde_json::from_value(json).unwrap();
    assert_eq!(decoded, layout);
}
```

- [ ] **Step 2: Run focused IR tests and confirm the types are missing**

Run: `cargo test -p fullmag-ir antenna --no-fail-fast`

Expected: compile failures for the new antenna IR types.

- [ ] **Step 3: Add normalized IR types**

Add the exact types from section 5 of the approved design: `MicrostripStationIR`, `CpwStationIR`, `BoundarySelectorIR::LocalUMin`, `BoundarySelectorIR::LocalUMax`, `AntennaTerminalGroupIR`, `AntennaPortModeIR`, `AntennaTransformIR`, `AntennaLayoutIR`, `AntennaFieldSolveIR`, `StageOutputRefIR`, `SolvedAntennaDriveIR`, `RegionalFieldDriveIR`, `TimeOriginIR`, `ResolvedStageDependencyIR`, and `FieldDriveIR`.

Use tagged snake-case Serde enums:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FieldDriveIR {
    SolvedAntenna(SolvedAntennaDriveIR),
    Regional(RegionalFieldDriveIR),
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TimeOriginIR {
    StageLocal,
    Absolute,
}
```

Do not retain the old constant-width `AntennaIR` as the normalized shape. Keep it only as a deserialization migration input.

- [ ] **Step 4: Extend `ProblemIR` and plan types**

Add:

```rust
#[serde(default, skip_serializing_if = "Vec::is_empty")]
pub antenna_layouts: Vec<AntennaLayoutIR>,
#[serde(default, skip_serializing_if = "Vec::is_empty")]
pub field_drives: Vec<FieldDriveIR>,
#[serde(default, skip_serializing_if = "Vec::is_empty")]
pub resolved_stage_dependencies: Vec<ResolvedStageDependencyIR>,
```

Define versioned `AntennaFieldSolutionManifestIR`, state, requested/resolved execution, signatures, field entries, and bounded diagnostics in `plan.rs`. Manifest types carry metadata and field references only; numeric buffers remain data-plane artifacts.

- [ ] **Step 5: Implement validation and normalization**

Validation must accumulate path-specific errors for:

- endpoint and station ordering;
- positive widths, gaps, thickness, length, and conductivity;
- terminal uniqueness and conductor-part existence;
- exactly `1.0` normalization current in schema v1;
- current-weight sum within `1e-12`;
- microstrip return-plane requirement;
- dangling layout, stage, output, region, port, and active-stage references;
- solved drive reference to a later stage;
- time-dependent drive activation during minimization;
- raw callback or unknown waveform kinds.

Normalize legacy constant-width microstrip/CPW to two endpoint stations. Normalize `prescribed_zeeman_mask` to `FieldDriveIR::Regional`. Preserve `mqs_2p5d_az` as a compatibility record with realization `legacy_infinite_strip_biot_savart`.

- [ ] **Step 6: Run IR tests**

Run: `cargo test -p fullmag-ir --no-fail-fast`

Expected: pass.

- [ ] **Step 7: Commit the canonical IR**

```bash
git add crates/fullmag-ir/src/study.rs crates/fullmag-ir/src/model.rs crates/fullmag-ir/src/lib.rs crates/fullmag-ir/src/validation.rs crates/fullmag-ir/src/plan.rs
git commit -m "feat(ir): define staged antenna field contracts"
```

---

## Task 3: Extend SceneDocument and canonical script round-trip

**Files:**

- Modify: `crates/fullmag-authoring/src/builder.rs`
- Modify: `crates/fullmag-authoring/src/scene.rs`
- Modify: `crates/fullmag-authoring/src/adapters.rs`
- Modify: `crates/fullmag-authoring/src/validation.rs`
- Modify: `packages/fullmag-py/src/fullmag/runtime/scene_document.py`
- Modify: `packages/fullmag-py/src/fullmag/runtime/script_builder.py`
- Test: `packages/fullmag-py/tests/test_current_transport.py`
- Test: `packages/fullmag-py/tests/test_api.py`

- [ ] **Step 1: Add failing round-trip tests**

The test fixture must contain three CPW stations, an explicit port mode, a field-solve stage, and a solved sinc drive. Assert:

```python
assert rebuilt["antenna_layouts"] == draft["antenna_layouts"]
assert rebuilt["field_drives"] == draft["field_drives"]
assert rebuilt["study_pipeline"]["nodes"][0]["stage_kind"] == "antenna_field_solve"
assert 'fm.CPWAntennaLayout(' in rendered_source
assert 'fm.antenna_field_solve(' in rendered_source
assert 'fm.SolvedAntennaDrive(' in rendered_source
```

- [ ] **Step 2: Run the tests and confirm data is dropped**

Run:

```bash
python -m pytest packages/fullmag-py/tests/test_current_transport.py -q
python -m pytest packages/fullmag-py/tests/test_api.py -q -k antenna
```

Expected: failures because the typed collections and stage kind are not projected.

- [ ] **Step 3: Add typed SceneDocument collections**

Add `antenna_layouts` and `field_drives` to `ScriptBuilderState`, `SceneDocument`, adapters, validation, and Python scene projections. Add `AntennaFieldSolve` to `StudyPrimitiveStageKind`.

The authoring transaction boundary must update these collections atomically. New writes must not construct a raw replacement `current_modules.modules` array.

- [ ] **Step 4: Add canonical script rendering**

Add dedicated renderers:

```python
def _render_antenna_layouts(problem: Problem, *, surface: str) -> list[str]:
    return [
        _render_antenna_layout(layout, surface=surface)
        for layout in problem.antenna_layouts
    ]


def _render_field_drives(problem: Problem, *, surface: str) -> list[str]:
    return [
        _render_field_drive(drive, surface=surface)
        for drive in problem.field_drives
    ]
```

Render every station, terminal weight, transform, stage output reference, time origin, active-stage id, and waveform. Do not collapse variable stations back to a constant width.

- [ ] **Step 5: Add migration projections**

Read old `current_modules` and project them into typed layout/drive data for display and export. The new scene writer stores typed fields. Compatibility export uses an explicit `LegacyInfiniteStripAntennaSource` constructor and emits one deprecation warning per loaded script.

- [ ] **Step 6: Run authoring tests**

Run:

```bash
cargo test -p fullmag-authoring --no-fail-fast
python -m pytest packages/fullmag-py/tests/test_current_transport.py packages/fullmag-py/tests/test_api.py -q
```

Expected: pass.

- [ ] **Step 7: Commit round-trip support**

```bash
git add crates/fullmag-authoring/src packages/fullmag-py/src/fullmag/runtime/scene_document.py packages/fullmag-py/src/fullmag/runtime/script_builder.py packages/fullmag-py/tests/test_current_transport.py packages/fullmag-py/tests/test_api.py
git commit -m "feat(authoring): round-trip antenna workflows"
```

---

## Task 4: Add stage graph validation and field-solve planning

**Files:**

- Create: `crates/fullmag-plan/src/antenna_field_solve.rs`
- Create: `crates/fullmag-plan/src/stage_dependencies.rs`
- Modify: `crates/fullmag-plan/src/lib.rs`
- Modify: `crates/fullmag-plan/src/fdm.rs`
- Modify: `crates/fullmag-plan/src/fem.rs`
- Modify: `crates/fullmag-plan/src/current_transport.rs`
- Modify: `crates/fullmag-plan/src/tests.rs`

- [ ] **Step 1: Write failing graph and lane-resolution tests**

Cover:

```rust
#[test]
fn solved_drive_requires_earlier_field_solve() {
    let problem = fixture_with_drive_before_solution();
    let error = plan_problem(&problem).unwrap_err();
    assert!(error.reasons.iter().any(|reason| reason.contains("earlier antenna_field_solve")));
}

#[test]
fn forced_gpu_field_solve_is_rejected_without_fallback() {
    let problem = fixture_with_field_solve_device(DeviceIntent::Gpu);
    let error = plan_problem(&problem).unwrap_err();
    assert!(error.reasons.iter().any(|reason| reason.contains("FEM GPU field solve is unsupported")));
}

#[test]
fn fdm_gpu_llg_may_depend_on_resolved_fem_cpu_field_solve() {
    let plans = plan_pipeline(&fixture_fdm_gpu_llg_with_auto_precompute()).unwrap();
    assert_eq!(plans[0].resolved.discretization, Discretization::Fem);
    assert_eq!(plans[0].resolved.device, Device::Cpu);
    assert_eq!(plans[2].resolved.discretization, Discretization::Fdm);
    assert_eq!(plans[2].resolved.device, Device::Gpu);
}
```

- [ ] **Step 2: Run planner tests and confirm failures**

Run: `cargo test -p fullmag-plan antenna --no-fail-fast`

Expected: failures because field-solve planning and graph resolution do not exist.

- [ ] **Step 3: Implement graph normalization**

`stage_dependencies.rs` must topologically validate enabled pipeline nodes, resolve stage/output references, reject cycles and forward references, and materialize `ResolvedStageDependencyIR` with schema and content hash. Imported artifacts must pass schema, normalization, domain, and signature compatibility checks.

- [ ] **Step 4: Implement independent precompute execution resolution**

`antenna_field_solve.rs` resolves only `QuasistaticConductionBiotSavart3d` to `fem_cpu_native`, double precision, strict mode. Auto device resolves to CPU with an explicit note. Forced GPU rejects. The downstream LLG plan remains independently selected.

The resolved plan must contain conductor mesh policy, port ids, field sampling, targets, solver/quadrature policy, requested execution, resolved execution, and expected output ids. It must not contain numeric field arrays.

- [ ] **Step 5: Separate compatibility handling from current transport**

Replace `has_mqs_antenna_field_source` as a production capability decision. New solved drives are validated through field-solve dependencies. Old `mqs_2p5d_az` remains explicitly compatibility-only. `OhmicPoisson` remains semantic-only until separately implemented.

- [ ] **Step 6: Preserve the live-step protocol boundary**

Keep `SequenceStage` and `LiveControlCommand` limited to cooperative time-step runtime control. `solve` remains a structured orchestrator command and must continue to return `None` from `parse_session_command`. The typed stage-target request is added to the command schema in Task 6; the numerical handler remains for plan 2.

- [ ] **Step 7: Run planner and runner contract tests**

Run:

```bash
cargo test -p fullmag-plan --no-fail-fast
```

Expected: pass.

- [ ] **Step 8: Commit planner semantics**

```bash
git add crates/fullmag-plan/src
git commit -m "feat(plan): resolve staged antenna field dependencies"
```

---

## Task 5: Publish capability vocabulary without over-promoting runtime status

**Files:**

- Modify: `crates/fullmag-runner/src/capabilities.rs`
- Modify: `crates/fullmag-api/src/schemas/status.rs`
- Modify: `docs/specs/capability-matrix-v0.json`
- Modify: `docs/specs/capability-matrix-v0.md`
- Test: `crates/fullmag-runner/src/capabilities.rs`
- Test: `crates/fullmag-api/src/openapi_v2.rs`

- [ ] **Step 1: Add failing capability tests**

Assert that the session map contains all names from section 7.1 of the design and distinguishes `authorable`, `semantic_only`, `executable`, `validated`, and `unsupported`.

- [ ] **Step 2: Implement one canonical capability map**

At the end of this plan, set:

- layout, explicit ports, regional-drive authoring: `authorable`;
- field-solve and basis consumers: `semantic_only`;
- analysis products: `semantic_only`;
- forced FEM GPU field solve: `unsupported` with remediation.

Do not mark any native lane executable until plan 2 produces managed runtime evidence.

- [ ] **Step 3: Validate JSON and status vocabulary**

Run:

```bash
jq empty docs/specs/capability-matrix-v0.json
cargo test -p fullmag-runner capabilities --no-fail-fast
cargo test -p fullmag-api openapi_v2 --no-fail-fast
```

Expected: pass.

- [ ] **Step 4: Commit capability exposure**

```bash
git add crates/fullmag-runner/src/capabilities.rs crates/fullmag-api/src/schemas/status.rs docs/specs/capability-matrix-v0.json docs/specs/capability-matrix-v0.md crates/fullmag-api/src/openapi_v2.rs
git commit -m "feat(capabilities): expose antenna workflow status"
```

---

## Task 6: Add OpenAPI model, stage, solution, line-cut, and spectrum schemas

**Files:**

- Create: `crates/fullmag-api/src/schemas/antenna.rs`
- Modify: `crates/fullmag-api/src/schemas/mod.rs`
- Modify: `crates/fullmag-api/src/schemas/authoring.rs`
- Modify: `crates/fullmag-api/src/schemas/runtime.rs`
- Modify: `crates/fullmag-api/src/schemas/commands.rs`
- Modify: `crates/fullmag-api/src/schemas/fields.rs`
- Create: `crates/fullmag-api/src/router_v2/handlers/model/antennas.rs`
- Create: `crates/fullmag-api/src/router_v2/handlers/simulation/antenna.rs`
- Create: `crates/fullmag-api/src/router_v2/handlers/data/antenna.rs`
- Create: `crates/fullmag-api/src/router_v2/handlers/analysis/antenna.rs`
- Modify: corresponding `mod.rs` files
- Modify: `crates/fullmag-api/src/router_v2/mod.rs`
- Modify: `crates/fullmag-api/src/openapi_v2.rs`

- [ ] **Step 1: Write failing router and OpenAPI tests**

Tests must verify all approved paths, `base_revision` conflicts, typed stage states, ETag/304, and that no heavy arrays appear in status or websocket schemas.

```rust
#[test]
fn openapi_contains_antenna_solution_and_spectrum_resources() {
    let spec = openapi_v2_json();
    let paths = spec["paths"].as_object().unwrap();
    assert!(paths.contains_key("/v2/sessions/current/model/antennas"));
    assert!(paths.contains_key("/v2/sessions/current/data/antenna-field-solutions/{solution_id}"));
    assert!(paths.contains_key("/v2/sessions/current/analysis/antenna-excitation/{solution_id}/source-spectrum"));
}
```

- [ ] **Step 2: Run API tests and confirm missing paths**

Run: `cargo test -p fullmag-api router_v2 --no-fail-fast`

Expected: path assertions fail.

- [ ] **Step 3: Add schema types**

Define schemas for antenna layouts, stations, terminals, port modes, field drives, stage plan/progress/diagnostics, solution list/detail/projection, line-cut request/product, spectrum metadata, raster descriptor, requested/resolved execution, signatures, and structured errors.

Use string revisions or the existing exact-u64 transport representation. Never serialize a revision that TypeScript will coerce through an unsafe number.

Register this complete route set:

```text
GET    /v2/sessions/current/model/antennas
POST   /v2/sessions/current/model/antennas
PATCH  /v2/sessions/current/model/antennas/{antenna_id}
DELETE /v2/sessions/current/model/antennas/{antenna_id}
GET    /v2/sessions/current/model/field-drives
POST   /v2/sessions/current/model/field-drives
PATCH  /v2/sessions/current/model/field-drives/{drive_id}
DELETE /v2/sessions/current/model/field-drives/{drive_id}
GET    /v2/sessions/current/simulation/stages/{stage_id}/antenna-field-solve/plan
GET    /v2/sessions/current/simulation/stages/{stage_id}/antenna-field-solve/progress
GET    /v2/sessions/current/simulation/stages/{stage_id}/antenna-field-solve/diagnostics
GET    /v2/sessions/current/data/antenna-field-solutions
GET    /v2/sessions/current/data/antenna-field-solutions/{solution_id}
GET    /v2/sessions/current/data/antenna-field-solutions/{solution_id}/projections
POST   /v2/sessions/current/analysis/field-line-cuts
GET    /v2/sessions/current/analysis/field-line-cuts/{line_cut_id}
GET    /v2/sessions/current/analysis/antenna-excitation/{solution_id}/source-spectrum
GET    /v2/sessions/current/analysis/antenna-excitation/{solution_id}/local-k-spectrum
GET    /v2/sessions/current/analysis/spin-wave-response/{run_id}/dynamic-structure-factor
```

- [ ] **Step 4: Add model mutation handlers**

Implement GET/POST/PATCH/DELETE under `model/antennas` and `model/field-drives`. Every write accepts `base_revision`, commits a `SceneDocument` transaction, and returns the typed projection plus `scene_revision`. Reuse standard not-found, validation, conflict, and unsupported errors.

Add the typed structured command variant `{ "kind": "solve", "target": { "kind": "stage", "stage_id": string } }` in `schemas/commands.rs`. Validate a nonempty stage id and route it through the existing orchestrator command path, not through `LiveControlCommand`.

- [ ] **Step 5: Add stage and solution read handlers**

Stage routes read the canonical stage execution/resource state. Solution routes read manifest metadata and projection references from runner artifacts. Before plan 2, missing runtime data returns a typed `missing` state rather than fabricated numeric content.

- [ ] **Step 6: Add line-cut and spectrum product contracts**

`POST /analysis/field-line-cuts` creates a revisioned analysis request keyed by field id, component policy, and polyline. GET returns product metadata and sample references. Spectrum endpoints return metadata and a versioned tiled-raster reference, not the raster matrix in JSON.

- [ ] **Step 7: Keep realtime invalidation-only**

Add exact resource invalidation ids for antenna model, stage, solution, line-cut, and spectrum resources. Do not put progress traces, manifests, fields, or matrices into websocket events.

- [ ] **Step 8: Run API tests**

Run: `cargo test -p fullmag-api --no-fail-fast`

Expected: pass.

- [ ] **Step 9: Commit OpenAPI backend contracts**

```bash
git add crates/fullmag-api/src
git commit -m "feat(api): add antenna workflow resources"
```

---

## Task 7: Regenerate and validate the TypeScript transport contract

**Files:**

- Regenerate: `apps/control-room/src/kernel/api/generated/openapi-v2.json`
- Regenerate: `apps/control-room/src/kernel/api/generated/openapi-v2-types.ts`
- Regenerate: `apps/control-room/src/kernel/api/generated/openapi-v2-client.ts`
- Regenerate: `apps/control-room/src/kernel/api/generated/openapi-v2-paths.ts`
- Modify: `apps/control-room/src/kernel/api/openapiV2GeneratedContract.test.ts`
- Modify: `apps/control-room/src/kernel/api/apiTypes.ts`

- [ ] **Step 1: Add generated-contract assertions**

Assert the new route literals exist in `openapi-v2-paths.ts` and that generated schemas type-check through aliases in `apiTypes.ts`.

- [ ] **Step 2: Regenerate from the Rust OpenAPI source**

Run: `pnpm --dir apps/control-room generate:api`

Expected: the four generated files change together without manual edits.

- [ ] **Step 3: Add only domain-facing type aliases by generated lookup**

```typescript
export type AntennaLayoutResource = components["schemas"]["AntennaLayoutResource"];
export type AntennaFieldSolutionResource = components["schemas"]["AntennaFieldSolutionResource"];
export type AntennaSpectrumMetaResource = components["schemas"]["AntennaSpectrumMetaResource"];
```

Do not copy generated transport shapes into handwritten duplicate interfaces.

- [ ] **Step 4: Run generated contract checks**

Run:

```bash
pnpm --dir apps/control-room test -- --run src/kernel/api/openapiV2GeneratedContract.test.ts
pnpm --dir apps/control-room typecheck
```

Expected: pass.

- [ ] **Step 5: Commit generated transport**

```bash
git add apps/control-room/src/kernel/api/generated apps/control-room/src/kernel/api/apiTypes.ts apps/control-room/src/kernel/api/openapiV2GeneratedContract.test.ts
git commit -m "chore(api): regenerate antenna workflow transport"
```

---

## Task 8: Add fixture-backed API recovery and invalidation tests

**Files:**

- Modify: `crates/fullmag-api/src/router_v2/handlers/model/antennas.rs`
- Modify: `crates/fullmag-api/src/router_v2/handlers/simulation/antenna.rs`
- Modify: `crates/fullmag-api/src/router_v2/handlers/data/antenna.rs`
- Modify: `crates/fullmag-api/src/router_v2/handlers/analysis/antenna.rs`
- Modify: `crates/fullmag-api/src/router_v2/tests.rs` or nearest existing router test module
- Modify: `docs/specs/resource-first-control-room-api-v2.md`

- [ ] **Step 1: Test exact invalidation scope**

Prove that station, port, conductivity, mesh, solver, or sampling edits invalidate the field solution; peak current and waveform edits invalidate only drive/instantaneous-field/analysis consumers.

- [ ] **Step 2: Test HTTP recovery after missed events**

Create a solution fixture, advance its resource revision without delivering a websocket event, then GET the resource and assert the complete current state is recovered through HTTP with a fresh ETag.

- [ ] **Step 3: Test structured stale reasons**

Assert responses identify the changed dependency path and old/new signature or revision. Do not expose a generic stale boolean alone.

- [ ] **Step 4: Run resource-first gates**

Run:

```bash
cargo test -p fullmag-api router_v2 --no-fail-fast
pnpm --dir apps/control-room check:api-hygiene
./scripts/ci-resource-first-gates.sh --strict
./scripts/ci/contract_guard.sh --strict
```

Expected: pass. If a repo-wide gate reports an unrelated pre-existing failure, record the exact command and output; do not weaken the gate.

- [ ] **Step 5: Commit API behavior documentation and tests**

```bash
git add crates/fullmag-api/src docs/specs/resource-first-control-room-api-v2.md
git commit -m "test(api): verify antenna resource invalidation"
```

---

## Task 9: Contract-plan final verification

- [ ] **Step 1: Run all contract suites**

```bash
python -m pytest packages/fullmag-py/tests/test_current_transport.py packages/fullmag-py/tests/test_api.py -q
cargo test -p fullmag-ir --no-fail-fast
cargo test -p fullmag-authoring --no-fail-fast
cargo test -p fullmag-plan --no-fail-fast
cargo test -p fullmag-api --no-fail-fast
pnpm --dir apps/control-room generate:api
pnpm --dir apps/control-room test -- --run src/kernel/api/openapiV2GeneratedContract.test.ts
pnpm --dir apps/control-room typecheck
jq empty docs/specs/capability-matrix-v0.json
```

- [ ] **Step 2: Scan for architectural regressions**

```bash
rg 'mqs_2p5d_az' packages/fullmag-py crates apps/control-room/src --glob '!**/generated/**'
rg 'fetch\(' apps/control-room/src
rg '"/v2/' apps/control-room/src --glob '!kernel/api/generated/**' --glob '!kernel/api/apiPaths.ts'
rg 'antenna.*(T[B]D|T[O]DO|F[I]XME)' docs packages crates apps/control-room/src
```

Expected: `mqs_2p5d_az` appears only in compatibility paths/tests; direct fetch/path searches show no new module-level transport; placeholder scan is empty.

- [ ] **Step 3: Confirm contract-only capability status**

The capability matrix must still say semantic-only for the field solve and basis consumers. No numerical production claim is permitted until plan 2 passes its managed runtime gates.

- [ ] **Step 4: Record the handoff**

Update the implementation tracker with the exact commits, OpenAPI revision, IR version/migration behavior, and the first task of plan 2. Do not combine plan 2 implementation into this final commit.
