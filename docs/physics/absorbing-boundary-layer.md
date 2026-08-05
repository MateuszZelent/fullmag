# Per-object absorbing boundary layer for micromagnetics

- Status: draft
- Owners: Fullmag backend team
- Last updated: 2026-08-04
- Related ADRs: none
- Related specs: `docs/superpowers/specs/2026-08-04-absorbing-boundary-layer-design.md`

(problem-statement)=
## 1. Problem statement

Finite micromagnetic domains reflect spin waves at their numerical boundary.
Fullmag needs the MuMax-style `ext_SetAbsorbingBoundaryAdvanced` behavior as a
first-class, per-object damping module that can be authored in Python, edited
in the control room, lowered to `ProblemIR`, and materialized by FEM/FDM
planners without a backend-specific script callback.

The public entry point is attached to the object's damping control:

```python
film.alpha = 0.01
film.alpha.absorbing_boundary(
    total_width=400e-9,
    ramp_width=300e-9,
    max_damping=0.5,
    faces=("x+", "y-", "y+"),
    profile="smootherstep",
    frame="object",
)
```

`frame="universe"` is available when the layer must use the explicit study
universe, matching the original MuMax source. The default is object-local so
the same object configuration remains stable when the object is translated.

## 2. Physical model

(governing-equations)=
### 2.1 Governing equations

The module does not add an energy term or a magnetic field. It changes the
dimensionless Gilbert damping coefficient supplied to the LLG equation:

```{math}
:label: eq-alpha-additive

\alpha(\mathbf r)=\alpha_0+\Delta\alpha(\mathbf r),\qquad
\Delta\alpha(\mathbf r)=\alpha_{\max}\max_{f\in F} w_f(\mathbf r).
```

For a selected face, let $d_f$ be the inward distance from that face to a
point. With full layer width $W$ and taper width $R$,

```{math}
:label: eq-profile-coordinate

t_f=\operatorname{clamp}\left(\frac{W-d_f}{R},0,1\right),
\qquad w_f=p(t_f).
```

where the profile is zero outside the layer and increases to one at the
outer boundary. The default smootherstep profile is

```{math}
:label: eq-smootherstep

p(t)=6t^5-15t^4+10t^3.
```

At corners the face contributions are combined by `max`, so the requested
maximum damping is not multiplied by the number of faces.

(symbols-and-si-units)=
### 2.2 Symbols and SI units

| Symbol | Python parameter | Type/default | Unit | Validation | Meaning | Backend support | `ProblemIR` destination |
|---|---|---|---:|---|---|---|---|
| $\alpha(\mathbf r)$ | resolved field | derived | 1 | finite, non-negative | local Gilbert damping supplied to LLG | FDM CPU/FEM CPU/GPU; CUDA FDM rejects cellwise fields | `FdmMaterialIR.material.alpha_field` / FEM material alpha field |
| $\alpha_0$ | `film.alpha` | `float`, required base assignment | 1 | finite, non-negative | base Gilbert damping | FDM CPU/FEM CPU/GPU | material damping |
| $W$ | `total_width` | `float`, required | $\mathrm{m}$ | finite, $W>0$ | full inward extent of the layer | FDM CPU/FEM CPU/GPU | `magnets[].absorbing_boundary.total_width_m` |
| $R$ | `ramp_width` | `float`, required | $\mathrm{m}$ | finite, $0<R\le W$ | taper extent | FDM CPU/FEM CPU/GPU | `magnets[].absorbing_boundary.ramp_width_m` |
| $\alpha_{\max}$ | `max_damping` | `float`, required | 1 | finite, $\alpha_{\max}\ge0$ | additive damping at the selected face | FDM CPU/FEM CPU/GPU | `magnets[].absorbing_boundary.max_damping` |
| $F$ | `faces` | `tuple[str, ...]`, `("x+",)` | 1 | non-empty, unique `x±/y±/z±` | selected boundary faces | FDM CPU/FEM CPU/GPU; CUDA FDM rejects cellwise fields | `magnets[].absorbing_boundary.faces` |
| $p$ | `profile` | `str`, `"smootherstep"` | 1 | `linear`, `quadratic`, or `smootherstep` | taper profile | FDM CPU/FEM CPU/GPU; CUDA FDM rejects cellwise fields | `magnets[].absorbing_boundary.profile` |
| — | `frame` | `str`, `"object"` | 1 | `object` or `universe` | coordinate frame for bounds | FDM CPU/FEM CPU/GPU; CUDA FDM rejects cellwise fields | `magnets[].absorbing_boundary.frame` |
| $d_f$ | internal | derived | $\mathrm{m}$ | finite sampled point and bounds | inward distance from face $f$ | planner only | not serialized |
| $t_f$ | internal | derived | 1 | clamped to $[0,1]$ | profile coordinate | planner only | not serialized |
| $w_f(\mathbf r)$ | internal | derived | 1 | profile output in $[0,1]$ | selected-face profile weight | planner only | not serialized |
| $p(t)$ | `profile` implementation | derived | 1 | selected profile formula | scalar taper profile | planner only | not serialized |

Faces use `x+`, `x-`, `y+`, `y-`, `z+`, and `z-`. `frame="object"` uses the
axis-aligned bounds of the object's sampled magnetic points after removing
the object's translation. `frame="universe"` uses the explicit study-universe
box; when the universe is automatic, the planner uses the sampled object
bounds as the deterministic fallback.

(assumptions-and-validity)=
### 2.3 Assumptions and approximations

The layer is a local damping approximation. It does not solve electromagnetic
radiation, conductor currents, or PML equations. The object frame is
axis-aligned; rotation-aware object frames are deferred. The damping is
materialized at the planner's FDM cells or FEM nodes, so convergence requires
the ramp to be resolved by the selected mesh.

(discrete-realization)=
## 3. Numerical interpretation

### 3.1 FDM

The planner evaluates the same closed profile at cell sample points and writes
the resulting values to `FdmMaterialIR.material.alpha_field`. FDM CPU consumes
the field. Native FDM CUDA currently rejects all cellwise `Ms/Aex/alpha`
fields, therefore strict FDM GPU planning fails closed with a capability error
rather than silently dropping the layer.

### 3.2 FEM

The planner evaluates the profile at FEM mesh points and writes
`FemPlanIR.material.alpha_field`. The existing FEM CPU and GPU native ABI
already carries `alpha_field`; this feature does not change the equation or
the ABI. Managed runtime execution remains subject to the existing FEM
qualification gates and must not be inferred from source support alone.

### 3.3 Hybrid

No hybrid-specific realization is introduced. The planner preserves the
object-owned module and applies the same scalar field in each participating
material realization. Cross-backend parity is a validation result, not an
implicit promise.

## 4. API, IR, and planner impact

(python-api)=
### 4.1 Python API surface

`MagnetHandle.alpha` remains assignment-compatible with numeric values. Reads
return an alpha control proxy exposing `absorbing_boundary(...)`; assigning a
number updates the base damping. The module is one-per-object and a second
call replaces the previous configuration. The configuration is represented by
`AbsorbingBoundaryLayer` and serializes to a finite, typed dictionary.

```python
# %% Authoring intent
import fullmag as fm

study = fm.study("absorbing_boundary_example")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")

# %% Object-owned damping layer
film = study.geometry(fm.Box(1.2e-6, 0.6e-6, 20e-9), name="film")
film.Ms = 800e3
film.Aex = 13e-12
film.alpha = 0.01
film.alpha.absorbing_boundary(
    total_width=200e-9,
    ramp_width=150e-9,
    max_damping=0.5,
    faces=("x+", "x-"),
    profile="smootherstep",
    frame="object",
)

# %% Interactions and stage
study.exchange()
study.demag(realization="poisson_robin")
study.stages.add_run(stage_id="run", until=1e-12)
```

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | `ProblemIR` mapping |
|---|---|---|---|---|---|---|---|
| `film.alpha` | `float` | required | 1 | finite and >= 0 | Base Gilbert damping | FDM CPU/FEM CPU/FEM GPU; FDM CUDA only when no cellwise field is produced | `magnets[].material.damping` |
| `film.alpha.absorbing_boundary(total_width=...)` | module | disabled | m and 1 by parameter | positive widths; ramp <= total; non-negative max_damping; valid unique faces/profile/frame | Per-object additive damping layer | FDM CPU/FEM CPU/FEM GPU; FDM CUDA rejects cellwise alpha | `magnets[].absorbing_boundary` |

(problem-ir)=
### 4.2 ProblemIR representation

`MagnetIR.absorbing_boundary` is optional and contains
`total_width_m`, `ramp_width_m`, `max_damping`, `faces`, `profile`, and `frame`.
IR validation rejects non-finite values, non-positive widths, `ramp_width_m`
greater than `total_width_m`, negative damping, duplicate/unknown faces, and
unknown profile/frame names.

(round-trip-and-failure-semantics)=
### 4.3 Round-trip and failure semantics

The requested intent is preserved as `MagnetIR.absorbing_boundary` and is also
retained in the scene resource and canonical script export. The resolved execution
is the planner-produced `alpha_field` at FDM cells or FEM nodes; it is not
inferred from the base material after planning. Invalid values fail at Python or
IR validation with structured validation errors. Unsupported combinations are
reported before execution: a request for FDM CUDA with this cellwise module fails
before native launch with `fdm_cuda_absorbing_boundary_unsupported`; no hidden CPU
fallback is selected.
The UI sends an omitted field for no change, `null` to clear the module, and a
typed object to set it, so scene/script round-trip does not collapse intent.

(implementation-mapping)=
### 4.4 Implementation mapping

| Contract | Source symbol | Responsibility |
|---|---|---|
| Python module | `packages/fullmag-py/src/fullmag/model/absorbing_boundary.py:AbsorbingBoundaryLayer` | parameter validation and profile serialization |
| Object API | `packages/fullmag-py/src/fullmag/world.py:AlphaControl.absorbing_boundary` | per-object attachment |
| Canonical IR | `crates/fullmag-ir/src/model.rs:MagnetIR` | typed optional module |
| IR validation | `crates/fullmag-ir/src/lib.rs:validate_absorbing_boundary` | fail-closed schema validation |
| FDM/FEM lowering | `crates/fullmag-plan/src/material.rs:apply_absorbing_boundary_layer` | cell/node alpha-field materialization |
| UI authoring | `apps/control-room/src/modules/inspector/panels/ObjectAbsorbingBoundaryPanel.tsx:ObjectAbsorbingBoundaryPanel` | v2 scene-resource editing |

### 4.5 Planner and capability-matrix impact

The planner applies the layer after region-owned alpha resolution. This keeps
the module additive to the object's base/region material semantics. The
capability matrix marks FEM CPU/GPU as planner-supported and FDM CPU as
supported; FDM CUDA is explicitly unsupported while cellwise material fields
remain rejected by the native path. The UI and script builder carry the same
optional object field and round-trip it without moving the module to global
study state.

(validation)=
## 5. Validation strategy

### 5.1 Analytical checks

Test zero contribution outside `total_width`, unit contribution at the outer
face, exact smootherstep midpoint, additive base damping, and `max` corner
combination. Test object translation invariance and universe-frame behavior.

### 5.2 Cross-backend checks

Compare FDM cell samples and FEM nodal samples on the same box and mesh. The
comparison is a field/materialization check; it is not a claim of converged
spin-wave absorption. A qualified FEM run must use the managed `just` recipe
and record the actual device/runtime provenance.

### 5.3 Regression tests

Python tests cover proxy compatibility, validation, IR lowering, and script
round-trip. Rust tests cover IR validation, planner profiles, region ordering,
and FDM CUDA fail-closed capability. Authoring tests cover scene and script
builder round-trip. The `tests/vlad/4.5GHz_fem.py` loader test verifies the
flat top-level `study` style and the per-object layer parameters.

## 6. Completeness checklist

- [x] Python API
- [x] ProblemIR
- [x] Planner
- [x] Capability matrix
- [x] FDM backend
- [x] FEM backend
- [ ] Hybrid backend
- [x] Outputs / observables
- [x] Tests / benchmarks
- [x] Documentation

(limitations)=
## 7. Known limits and deferred work

Rotation-aware object frames, FEM boundary-integral/PML absorption, native FDM
CUDA cellwise damping, and quantitative spin-wave reflection qualification are
deferred. The module must remain visible as unsupported where those limits
apply.

(scientific-bibliography)=
## 8. References

- [Absorbing boundary layers for spin wave micromagnetics](https://pstorage-loughborough-53465.s3.amazonaws.com/17027408/1706.03325v1.pdf)

(source-code-index)=
## 9. Source-code index

The adjacent source map is the machine-readable index for every equation, API
parameter, backend lane, and implementation symbol cited here:
`docs/physics/absorbing-boundary-layer.source-map.json`.

| Source path | Symbol | Role |
|---|---|---|
| `packages/fullmag-py/src/fullmag/model/absorbing_boundary.py` | `class AbsorbingBoundaryLayer` | Python module validation and serialization |
| `packages/fullmag-py/src/fullmag/world.py` | `absorbing_boundary` | Per-object alpha attachment |
| `packages/fullmag-py/src/fullmag/model/problem.py` | `class Problem` | Python-to-IR lowering |
| `crates/fullmag-ir/src/lib.rs` | `validate_absorbing_boundary` | IR validation |
| `crates/fullmag-plan/src/material.rs` | `apply_absorbing_boundary_layer` | FDM/FEM alpha-field materialization |
| `crates/fullmag-plan/src/fem.rs` | `build_region_material_fields` | FEM material-field handoff |
| `crates/fullmag-plan/src/validate.rs` | `validate_region_owned_planning` | FDM CUDA fail-closed gate |
| `apps/control-room/src/modules/inspector/panels/ObjectAbsorbingBoundaryPanel.tsx` | `ObjectAbsorbingBoundaryPanel` | UI authoring and persistence |
