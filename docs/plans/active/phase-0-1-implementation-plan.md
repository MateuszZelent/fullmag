# Phase 0–2 Implementation Plan: Execution-First FDM v1

- Status: phase-0-complete, phase-1-partially-implemented (kept active until closeout gaps are fixed)
- Last updated: 2026-03-23
- Parent spec: `docs/specs/exchange-only-full-solver-architecture-v1.md`
- Audit note: see `docs/plans/active/implementation-status-and-next-plans-2026-03-23.md`
- Phase 0 policy documents:
  - `docs/specs/geometry-policy-v0.md` (D0.1)
  - `docs/specs/magnetization-init-policy-v0.md` (D0.2)
  - `docs/specs/exchange-bc-policy-v0.md` (D0.3)
  - `docs/specs/output-naming-policy-v0.md` (D0.5)

---

## Guiding principle

> **First milestone = public execution on reference exchange-only FDM CPU with artifacts,
> diagnostics, and provenance.**

The architecture spec's north star — one problem running on FDM and FEM with shared semantics —
remains the long-term target (Phase 2+). But Phase 1's Definition of Done is intentionally
narrower: one exchange-only problem authored in Python must actually **compute** through the
public API, produce real numerical output, and carry full provenance.

FDM and FEM remain semantic peers in `ProblemIR`. Execution symmetry is deferred.

### Three-tier feature status model

Every feature in the capability matrix must carry one of three statuses:

| Status | Meaning |
|--------|---------|
| `semantic-only` | Legal in Python API and `ProblemIR`; can be serialized, validated, and planned. Not numerically implemented. |
| `internal-reference` | Numerically implemented inside `fullmag-engine` or equivalent crate, but not wired to the public `Simulation.run()` path. |
| `public-executable` | Fully wired: Python `Simulation.run()` → plan → runner → engine → artifacts. End-to-end. In the current audit, material propagation and field-artifact closeout still remain. |

This model prevents the API surface from silently implying more than the solver can deliver.

---

## Phase 0: Freeze exchange-only shared semantics

### Goal

Lock down the policies and naming conventions that all subsequent phases depend on.
No new code beyond policy documents and minor Python/IR fixes.

### Deliverables

#### D0.1 — Geometry primitive policy

> [!IMPORTANT]
> This is the single biggest API gap blocking Phase 1.

Create `docs/specs/geometry-policy-v0.md` specifying:

- `Box(size, name)` — axis-aligned cuboid
- `Cylinder(radius, height, name)` — axis-aligned cylinder
- `ImportedGeometry(source, name)` — existing, unchanged
- boolean composition is deferred (CSG is out of scope for exchange-only)
- `GeometryIR` must support both `imported_geometry` and `analytic_primitive` kinds

#### D0.2 — Initial magnetization policy

Create `docs/specs/magnetization-init-policy-v0.md` specifying:

- `uniform(vector)` — already done
- `random(seed)` — random unit vectors, deterministic from seed
- `from_function(fn, sample_points)` — callable sampled at lowering time, never in hot loop
- IR variants: `Uniform`, `RandomSeeded`, `SampledField`
- public Python names: `fm.init.uniform()`, `fm.init.random()`, `fm.init.from_function()`

#### D0.3 — Boundary condition policy

Create `docs/specs/exchange-bc-policy-v0.md` specifying:

- default: Neumann ∂m/∂n = 0 (current `fullmag-engine` behavior)
- FDM realization: mirror-image stencil at boundaries
- FEM realization: natural BC (no surface integral term needed for exchange)
- no user-facing BC API in exchange-only release — BC is implicit

#### D0.4 — LLG parameter policy

Update `docs/specs/problem-ir-v0.md` § `DynamicsIR::Llg` to clarify:

- `integrator`: enum, currently only `"heun"`
- `fixed_timestep`: hint for the runner, `None` means runner picks dt
- `gyromagnetic_ratio`: always in m/(A·s), default 2.211e5

#### D0.5 — Output naming policy

Create `docs/specs/output-naming-policy-v0.md` specifying the canonical observable dictionary:

| Name | Type | Unit | Description |
|------|------|------|-------------|
| `m` | vector field | dimensionless | reduced magnetization |
| `H_ex` | vector field | A/m | exchange effective field |
| `E_ex` | scalar | J | exchange energy |
| `time` | scalar | s | simulation time |
| `step` | scalar | 1 | step index |
| `solver_dt` | scalar | s | timestep used |

#### D0.6 — Comparison tolerances policy

Add a section to `docs/specs/capability-matrix-v0.md`:

- FDM vs FEM comparison is under **physical** tolerances, not bitwise
- default energy tolerance: 1% relative for refined meshes
- default field tolerance: L2 norm < 5% on matched grids
- convergence-rate study required before tolerance claims

### Acceptance criteria

- [x] All six policy documents exist
  - [x] D0.1: `docs/specs/geometry-policy-v0.md`
  - [x] D0.2: `docs/specs/magnetization-init-policy-v0.md`
  - [x] D0.3: `docs/specs/exchange-bc-policy-v0.md`
  - [x] D0.4: LLG params clarified in `docs/specs/problem-ir-v0.md`
  - [x] D0.5: `docs/specs/output-naming-policy-v0.md`
  - [x] D0.6: Tolerances added to `docs/specs/capability-matrix-v0.md`
- [x] `docs/specs/problem-ir-v0.md` updated with D0.4 clarifications
- [x] `docs/specs/capability-matrix-v0.md` updated with D0.6 tolerances
- [x] No code changes required (policy freeze only)

---

## Phase 1: Execution-first public FDM path

### Goal

Wire the existing reference exchange-only CPU engine to the public Python API.
At the end of Phase 1, a user can write `fm.Simulation(problem).run(until=2e-9)` and get
real numerical output with provenance — not a planning-only note.

### Public executable subset for Phase 1

The following combination is the **only** `public-executable` path after Phase 1:

```
Exchange + LLG(heun) + Box geometry + fdm/strict + one ferromagnet
+ canonical outputs (m, H_ex, E_ex, time, step, solver_dt)
+ honest error for anything outside this subset
```

Everything else in the Python API remains `semantic-only` or `internal-reference`.

### Deliverables

#### D1.1 — Analytic geometry primitives (Box, Cylinder)

`Box` is the entry point for public execution. It lowers directly to an axis-aligned FDM grid
without a generic voxelizer. `Cylinder` is added for API completeness (voxelized, not executed in Phase 1).

`ImportedGeometry` stays as a `semantic-only` planning target — not the first executable path.

##### Python: `packages/fullmag-py/src/fullmag/model/geometry.py`

```python
@dataclass(frozen=True, slots=True)
class Box:
    size: tuple[float, float, float]
    name: str = "box"
    def to_ir(self) -> dict: ...

@dataclass(frozen=True, slots=True)
class Cylinder:
    radius: float
    height: float
    name: str = "cylinder"
    def to_ir(self) -> dict: ...

Geometry = ImportedGeometry | Box | Cylinder
```

- Export `Box` and `Cylinder` from `fullmag.__init__`
- Update `Ferromagnet` to accept any `Geometry` (not just `ImportedGeometry`)
- Update `Problem._collect_geometry_imports` → `_collect_geometries` (handle both kinds)

##### Rust: `crates/fullmag-ir/src/lib.rs`

```rust
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum GeometryEntryIR {
    ImportedGeometry(ImportedGeometryIR),
    Box { name: String, size: [f64; 3] },
    Cylinder { name: String, radius: f64, height: f64 },
}
```

- Replace `GeometryIR { imports: Vec<ImportedGeometryIR> }` with `GeometryIR { entries: Vec<GeometryEntryIR> }`
- Update validation: geometry names unique, sizes positive
- Validation: `geometry.entries` must be non-empty (replaces `geometry.imports` check)
- Update `bootstrap_example()` to use `Box` instead of `ImportedGeometry`
- Update tests

#### D1.2 — Richer initial magnetization

`uniform` alone makes exchange trivially zero. `random(seed)` is essential for meaningful
exchange-only validation. `from_function` is deferred to Phase 2 (requires grid knowledge).

##### Python: `packages/fullmag-py/src/fullmag/init/magnetization.py`

```python
@dataclass(frozen=True, slots=True)
class RandomMagnetization:
    seed: int
    def to_ir(self) -> dict: ...

def random(seed: int) -> RandomMagnetization: ...
```

- Export `fm.init.random` from `fullmag.__init__`
- `from_function` → stub only, raises `NotImplementedError` with message pointing to Phase 2

##### Rust: `crates/fullmag-ir/src/lib.rs`

```rust
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum InitialMagnetizationIR {
    Uniform { value: [f64; 3] },
    RandomSeeded { seed: u64 },
    SampledField { values: Vec<[f64; 3]> },
}
```

- Update validation: `RandomSeeded` seed > 0, `SampledField` non-empty and unit-normed
- Update `MagnetIR` deserialization tests

#### D1.3 — Update ProblemIR typing and version bump

- `GeometryIR.imports` → `GeometryIR.entries` (Rust + Python serialization)
- Add `InitialMagnetizationIR::RandomSeeded` and `SampledField`
- Bump `IR_VERSION` to `"0.2.0"` in both Python and Rust
- Update round-trip tests
- Update validation: `geometry.entries` must be non-empty (not `geometry.imports`)

#### D1.4 — Extract `fullmag-plan` crate (narrow scope)

Create `crates/fullmag-plan/` with **only** the plan types that are actually consumed in Phase 1.
Do not speculate about `FemPlanIR` internals — there is no consumer yet.

##### Scope: only what the runner will consume

```rust
pub struct ExecutionPlanIR {
    pub common: CommonPlanMeta,
    pub backend_plan: BackendPlanIR,
    pub output_plan: OutputPlanIR,
    pub provenance: ProvenancePlanIR,
}

pub enum BackendPlanIR {
    ReferenceFdm(ReferenceFdmPlanIR),
    // Fem(FemPlanIR),  — deferred to Phase 2, no consumer exists
}

pub struct ReferenceFdmPlanIR {
    pub grid: [usize; 3],       // nx, ny, nz
    pub cell_size: [f64; 3],    // dx, dy, dz
    pub initial_magnetization: InitialMagnetizationPlan,
    pub exchange_stiffness: f64,
    pub saturation_magnetisation: f64,
    pub damping: f64,
    pub gyromagnetic_ratio: f64,
    pub integrator: String,
    pub fixed_timestep: Option<f64>,
}

pub enum InitialMagnetizationPlan {
    Uniform { value: [f64; 3] },
    RandomSeeded { seed: u64 },
    Sampled { values: Vec<[f64; 3]> },
}

pub struct OutputPlanIR {
    pub fields: Vec<FieldOutputPlan>,
    pub scalars: Vec<ScalarOutputPlan>,
}

pub struct CommonPlanMeta {
    pub problem_name: String,
    pub ir_version: String,
    pub backend_target: String,
    pub execution_mode: String,
}

pub struct ProvenancePlanIR {
    pub source_hash: Option<String>,
    pub engine_version: String,
    pub plan_timestamp: String,
}
```

- Move `ExecutionPlanSummary` from `fullmag-ir` to `fullmag-plan` (or keep both temporarily)
- Add `fullmag-plan` to workspace `Cargo.toml`
- `fullmag-plan` depends on `fullmag-ir` (reads `ProblemIR`)
- Planner logic: `ProblemIR` + `Box` geometry → `ReferenceFdmPlanIR` (grid from size/cell hints)

#### D1.5 — `fullmag-runner` crate and Simulation.run() wiring

This is the **highest-leverage** deliverable. Wire the public API to the reference engine.

##### Create `crates/fullmag-runner/`

```rust
// Consumes ReferenceFdmPlanIR, calls fullmag-engine, produces artifacts
pub fn run_reference_fdm(plan: &ReferenceFdmPlanIR, until: f64) -> RunResult { ... }

pub struct RunResult {
    pub status: RunStatus,
    pub step_stats: Vec<StepStats>,
    pub final_magnetization: Vec<[f64; 3]>,
    pub artifacts: ArtifactManifest,
}

pub struct StepStats {
    pub step: u64,
    pub time: f64,
    pub dt: f64,
    pub e_ex: f64,
    pub max_dm_dt: f64,
    pub max_abs_m_deviation: f64,
    pub wall_time_ns: u64,
}
```

- `fullmag-runner` depends on `fullmag-plan` and `fullmag-engine`
- The runner calls `fullmag-engine` exchange/LLG functions (already proven by 4 tests)
- Add `fullmag-runner` to workspace `Cargo.toml`

##### Wire Python `Simulation.run()`

Update `fullmag-py-core` to expose a `run_problem_json(ir_json: &str, until: f64) -> PyResult<String>`:

1. Deserialize `ProblemIR`
2. Plan → `ReferenceFdmPlanIR` (only for Box + Exchange + fdm/strict)
3. Run → `fullmag-engine`
4. Serialize `RunResult` as JSON back to Python

Update `Simulation.run()` in Python:
- For `Box + Exchange + fdm/strict`: call the Rust runner via PyO3, return real `Result` with `StepStats`
- For anything else: return `Result(status="not-executable", ...)` with honest error message

##### Wire CLI `fullmag-cli run`

Add `run-json <path> --until <seconds>` command to CLI that uses the same path.

#### D1.6 — Minimal artifact and provenance layer

Not a full HDF5/VTK/XDMF stack — just the minimum to make the first public run scientifically usable.

##### Artifact schema for Phase 1

```
run_output/
  metadata.json       # ProblemIR hash, plan, engine version, timestamps
  scalars.csv         # step, time, dt, E_ex, max_dm_dt, max_|m|-deviation
  m_initial.json      # initial magnetization snapshot
  m_final.json        # final magnetization snapshot
  m_snapshots/        # field snapshots at output intervals (optional)
    m_t0.000000e+00.json
    m_t1.000000e-11.json
```

- `metadata.json` carries full `ProvenancePlanIR` + `CommonPlanMeta`
- `scalars.csv` contains one row per timestep with canonical names from output-naming-policy
- Field snapshots are optional, triggered by `SaveField("m", every=...)` in the problem

#### D1.7 — Honest examples and tests

##### Canonical executable example: `examples/exchange_relax.py`

```python
import fullmag as fm

def build():
    strip = fm.Box(size=(200e-9, 20e-9, 5e-9), name="strip")
    mat = fm.Material(name="Py", Ms=800e3, A=13e-12, alpha=0.5)
    magnet = fm.Ferromagnet(
        name="strip", geometry=strip, material=mat,
        m0=fm.init.random(seed=42),
    )
    return fm.Problem(
        name="exchange_relax",
        magnets=[magnet],
        energy=[fm.Exchange()],
        dynamics=fm.LLG(),
        outputs=[
            fm.SaveField("m", every=100e-12),
            fm.SaveScalar("E_ex", every=10e-12),
        ],
        discretization=fm.DiscretizationHints(fdm=fm.FDM(cell=(2e-9, 2e-9, 5e-9))),
    )

problem = build()
result = fm.Simulation(problem, backend="fdm").run(until=2e-9)
```

This example must:
- Parse, serialize, validate, plan, run, and write artifacts end-to-end
- Use only `public-executable` features
- Pass in CI

##### Reclassify `examples/dw_track.py`

Move to `examples/semantic/dw_track.py` or add a comment header:

```python
# Semantic / planning-only example.
# Uses energy terms (Demag, DMI, Zeeman) that are not yet numerically implemented.
# This example validates IR serialization and planning, not execution.
```

##### Update tests

- `test_api.py`: add test cases for `Box`, `Cylinder`, `fm.init.random(seed=42)`
- `test_api.py`: add test that `exchange_relax` example produces valid IR
- New `test_executable.py`: test that `Simulation.run()` returns real `StepStats` for exchange-only Box
- Rust IR tests: new geometry variants, m0 variants, round-trip for Box-based IR
- Smoke script: update to exercise new IR shape and (optionally) CLI `run-json`

### File change summary

| File | Action |
|------|--------|
| `packages/fullmag-py/src/fullmag/model/geometry.py` | Add `Box`, `Cylinder`, `Geometry` union |
| `packages/fullmag-py/src/fullmag/model/structure.py` | Update `Ferromagnet` geometry type to `Geometry` |
| `packages/fullmag-py/src/fullmag/model/problem.py` | Rename `_collect_geometry_imports` → `_collect_geometries`, bump IR_VERSION to `"0.2.0"` |
| `packages/fullmag-py/src/fullmag/__init__.py` | Export `Box`, `Cylinder`, `random`; mark semantic-only terms in docstring |
| `packages/fullmag-py/src/fullmag/init/magnetization.py` | Add `RandomMagnetization`, `random()` |
| `packages/fullmag-py/src/fullmag/runtime/simulation.py` | Wire `run()` to PyO3 runner for executable subset |
| `packages/fullmag-py/src/fullmag/_core.py` | Add `run_problem_json()` binding |
| `crates/fullmag-ir/src/lib.rs` | `GeometryEntryIR`, new `InitialMagnetizationIR` variants, update validation |
| `crates/fullmag-plan/` | **[NEW CRATE]** `ReferenceFdmPlanIR`, `OutputPlanIR`, `ProvenancePlanIR`, planner for Box→grid |
| `crates/fullmag-runner/` | **[NEW CRATE]** `run_reference_fdm()`, `StepStats`, artifact writer |
| `crates/fullmag-py-core/src/lib.rs` | Add `run_problem_json()` function |
| `crates/fullmag-cli/src/main.rs` | Add `run-json` command |
| `examples/exchange_relax.py` | **[NEW]** canonical executable example |
| `examples/dw_track.py` | Reclassify as semantic/planning-only |
| `packages/fullmag-py/tests/test_api.py` | New test cases for Box, Cylinder, random m0 |
| `scripts/run_python_ir_smoke.py` | Update for new IR shape |
| `docs/specs/capability-matrix-v0.md` | Add three-tier status column |
| `docs/specs/problem-ir-v0.md` | Update geometry and m0 sections |
| `Cargo.toml` | Add `fullmag-plan` and `fullmag-runner` to workspace |

### Acceptance criteria

- [ ] `fm.Box(size=(200e-9, 20e-9, 5e-9))` serializes to valid IR
- [ ] `fm.init.random(seed=42)` serializes to valid IR
- [ ] Rust deserializes and validates both new geometry and m0 variants
- [ ] `IR_VERSION` is `"0.2.0"` in both Python and Rust
- [ ] `fullmag-plan` compiles with `ReferenceFdmPlanIR` and planner for Box geometry
- [ ] `fullmag-runner` compiles and can execute a Box+Exchange problem via `fullmag-engine`
- [ ] **`fm.Simulation(problem, backend="fdm").run(until=2e-9)` returns real numerical StepStats**
- [ ] **`fullmag-cli run-json exchange_relax.json --until 2e-9` produces artifacts**
- [ ] `examples/exchange_relax.py` runs end-to-end in CI (Python→IR→plan→run→artifacts)
- [ ] Artifact output includes `metadata.json`, `scalars.csv`, `m_final.json`
- [ ] Capability matrix updated with three-tier statuses
- [ ] `Simulation.run()` for non-executable subsets returns honest error, not silent planning note
- [ ] All existing tests pass (no regressions)
- [ ] `make py-test` and `make cargo-test` pass

---

## Phase 2: FEM path, voxelizer, and imported geometry (deferred)

### Goal

Extend execution symmetry to FEM. Add imported geometry execution path.
The north-star from the architecture spec lands here, not in Phase 1.

### Deliverables (sketch — detailed plan written after Phase 1 closes)

#### D2.1 — Imported geometry voxelizer (FDM path)

- STEP/STL → voxel mask pipeline
- `ImportedGeometry` becomes `public-executable` for FDM
- Region mask assignment

#### D2.2 — `from_function` initializer

- `fm.init.from_function(fn)` → sample at cell centers during lowering
- Requires grid knowledge from planner
- `SampledField` IR variant populated by planner, not user

#### D2.3 — FEM exchange operator and mesh pipeline

- `FemPlanIR` with mesh path, quadrature order, element type
- FEM exchange operator using Galerkin weak form
- `fullmag-runner` extended with `run_reference_fem()`
- Requires MFEM or equivalent library in container

#### D2.4 — Cross-backend comparison tooling

- `fullmag-compare` crate or script
- FDM vs FEM projection and L2 norm comparison
- Convergence-rate study for exchange-only Box problem

#### D2.5 — C ABI native backend layer

- `native/backends/fdm/` with CUDA exchange kernel
- Stable C ABI between Rust runner and native backends
- Performance parity testing against reference CPU

#### D2.6 — Expanded artifact formats

- HDF5 or VTK field output
- XDMF metadata
- Checkpoint/restart support

### What is explicitly NOT in Phase 2

- Demag, DMI, Zeeman, anisotropy (these remain `semantic-only`)
- Web/control-plane expansion beyond `/healthz`
- Multi-GPU, MPI, adaptive mesh refinement
- Hybrid execution
