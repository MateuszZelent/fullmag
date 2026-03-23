# Phase 0–1 Implementation Plan

- Status: phase-0-complete
- Last updated: 2026-03-23
- Parent spec: `docs/specs/exchange-only-full-solver-architecture-v1.md`
- Phase 0 policy documents:
  - `docs/specs/geometry-policy-v0.md` (D0.1)
  - `docs/specs/magnetization-init-policy-v0.md` (D0.2)
  - `docs/specs/exchange-bc-policy-v0.md` (D0.3)
  - `docs/specs/output-naming-policy-v0.md` (D0.5)

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

## Phase 1: Strengthen Python API and IR

### Goal

Implement the policies frozen in Phase 0 as working Python classes and Rust IR types.
At the end of Phase 1, the example from the architecture spec (§5) must parse and serialize without error.

### Deliverables

#### D1.1 — Analytic geometry primitives

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
```

- Add `Geometry = ImportedGeometry | Box | Cylinder` union type
- Export `Box` and `Cylinder` from `fullmag.__init__`
- Update `Ferromagnet` to accept any `Geometry`
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
- Update `bootstrap_example()` and tests

#### D1.2 — Richer initial magnetization

##### Python: `packages/fullmag-py/src/fullmag/init/magnetization.py`

```python
@dataclass(frozen=True, slots=True)
class RandomMagnetization:
    seed: int
    def to_ir(self) -> dict: ...

@dataclass(frozen=True, slots=True)
class SampledMagnetization:
    values: list[tuple[float, float, float]]
    def to_ir(self) -> dict: ...

def random(seed: int) -> RandomMagnetization: ...
def from_function(fn, ...) -> SampledMagnetization: ...
```

- Export `fm.init.random`, `fm.init.from_function`
- `from_function` is deferred to Phase 2 (depends on grid knowledge) — stub only

##### Rust: `crates/fullmag-ir/src/lib.rs`

```rust
pub enum InitialMagnetizationIR {
    Uniform { value: [f64; 3] },
    RandomSeeded { seed: u64 },
    SampledField { values: Vec<[f64; 3]> },
}
```

- Update validation: `RandomSeeded` seed > 0, `SampledField` non-empty
- Update `MagnetIR` deserialization tests

#### D1.3 — Update `ProblemIR` typing

- `GeometryIR.imports` → `GeometryIR.entries` (Rust + Python serialization)
- Add `InitialMagnetizationIR::RandomSeeded` and `SampledField`
- Bump `IR_VERSION` to `"0.2.0"` in both Python and Rust
- Update round-trip tests

#### D1.4 — Typed `ExecutionPlanIR` stub

##### Rust: `crates/fullmag-ir/src/lib.rs` (or new `crates/fullmag-plan/`)

```rust
pub struct ExecutionPlanIR {
    pub common: CommonPlanMeta,
    pub backend_plan: BackendPlanIR,
    pub output_plan: OutputPlanIR,
    pub provenance: ProvenancePlanIR,
}

pub enum BackendPlanIR {
    Fdm(FdmPlanIR),
    Fem(FemPlanIR),
}

pub struct FdmPlanIR {
    pub grid: GridDimensions,
    pub cell_size: [f64; 3],
    pub region_mask: Vec<u32>,
    pub initial_magnetization: Vec<[f64; 3]>,
    pub exchange_bc: ExchangeBoundaryCondition,
    pub integrator: IntegratorChoice,
    pub fixed_timestep: Option<f64>,
}
```

- This is a type-level skeleton — the planner logic comes in Phase 2
- The struct definitions establish the contract between plan and runner

#### D1.5 — Update example and tests

- Rewrite `examples/dw_track.py` to use `fm.Box(...)` instead of `fm.ImportedGeometry(...)`
- Add `examples/exchange_relax.py` matching the spec's §5 example
- Update `packages/fullmag-py/tests/test_api.py` with new classes
- Update Rust IR tests for new geometry and m0 variants
- Update smoke script to cover new IR shape

### File change summary

| File | Action |
|------|--------|
| `packages/fullmag-py/src/fullmag/model/geometry.py` | Add `Box`, `Cylinder`, `Geometry` union |
| `packages/fullmag-py/src/fullmag/model/structure.py` | Update `Ferromagnet` geometry type hint |
| `packages/fullmag-py/src/fullmag/model/problem.py` | Rename geometry collection, bump IR version |
| `packages/fullmag-py/src/fullmag/__init__.py` | Export `Box`, `Cylinder`, `random` |
| `packages/fullmag-py/src/fullmag/init/magnetization.py` | Add `RandomMagnetization`, `random()` |
| `crates/fullmag-ir/src/lib.rs` | `GeometryEntryIR`, `InitialMagnetizationIR` variants, `ExecutionPlanIR` stub |
| `examples/dw_track.py` | Use `fm.Box(...)` |
| `examples/exchange_relax.py` | **[NEW]** spec §5 example |
| `packages/fullmag-py/tests/test_api.py` | New test cases |
| `scripts/run_python_ir_smoke.py` | Update for new IR shape |
| `docs/specs/problem-ir-v0.md` | Update geometry and m0 sections |

### Acceptance criteria

- [ ] `fm.Box(size=(200e-9, 20e-9, 5e-9))` serializes to valid IR
- [ ] `fm.init.random(seed=42)` serializes to valid IR
- [ ] Rust deserializes and validates both new geometry and m0 variants
- [ ] `examples/exchange_relax.py` runs through the full Python→JSON→Rust round-trip
- [ ] `IR_VERSION` is `"0.2.0"` in both Python and Rust
- [ ] `ExecutionPlanIR` structs compile and serialize (no planner logic yet)
- [ ] All existing tests pass (no regressions)
- [ ] `make py-test` and `make cargo-test` pass in container
