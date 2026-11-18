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

For the `logarithmic` and `tanh` choices the normalized taper is

```{math}
:label: eq-abl-normalized-profiles

p_{\mathrm{log}}(t)=\frac{\ln(1+9t)}{\ln 10},\qquad
p_{\mathrm{tanh}}(t)=\frac{1+\tanh(4t-2)/\tanh 2}{2}.
```

The constants 9 and 4 are dimensionless and fixed for these presets. The
`custom` choice evaluates the authored scalar `expression`, with `u` equal to
the dimensionless ramp coordinate $t_f$. For example, `u**3` is a cubic taper.
The accepted operators are `+ - * / **` and parentheses. Available single-argument
functions are `abs`, `sqrt`, `exp`, `log` (natural logarithm), `log1p`, `tanh`,
`sin`, and `cos`. Numeric literals use decimal or scientific notation. The
expression is limited to 256 ASCII characters.

The expression must give $p(0)=0$ and $p(1)=1$ within $10^{-12}$ and output
finite values in $[0,1]$ within the same tolerance. Validation probes 257 evenly
spaced values including the endpoints. Planning additionally checks every
evaluated ramp sample and rejects invalid values. The probe is a finite
validation check. Continuity and monotonicity between samples are properties
of the user's formula. The adjoining plateau has width $W-R$ and exact weight
one. Points outside the layer receive zero weight.

At corners the face contributions are combined by `max`, so the requested
maximum damping is not multiplied by the number of faces.

(symbols-and-si-units)=
### 2.2 Symbols and SI units

| Symbol | Python parameter | Type/default | Unit | Validation | Meaning | Backend support | `ProblemIR` destination |
|---|---|---|---:|---|---|---|---|
| $\alpha(\mathbf r)$ | resolved field | derived | 1 | finite, non-negative | local Gilbert damping supplied to LLG | FDM CPU, single-grid FDM CUDA, FEM CPU/GPU | `FdmMaterialIR.material.alpha_field` / FEM material alpha field |
| $\alpha_0$ | `film.alpha` | `float`, required base assignment | 1 | finite, non-negative | base Gilbert damping | FDM CPU, single-grid FDM CUDA, FEM CPU/GPU | material damping |
| $W$ | `total_width` | `float`, required | $\mathrm{m}$ | finite, $W>0$ | full inward extent of the layer | FDM CPU, single-grid FDM CUDA, FEM CPU/GPU | `magnets[].absorbing_boundary.total_width_m` |
| $R$ | `ramp_width` | `float`, required | $\mathrm{m}$ | finite, $0<R\le W$ | taper extent | FDM CPU, single-grid FDM CUDA, FEM CPU/GPU | `magnets[].absorbing_boundary.ramp_width_m` |
| $\alpha_{\max}$ | `max_damping` | `float`, required | 1 | finite, $\alpha_{\max}\ge0$ | additive damping at the selected face | FDM CPU, single-grid FDM CUDA, FEM CPU/GPU | `magnets[].absorbing_boundary.max_damping` |
| $F$ | `faces` | `tuple[str, ...]`, `("x+",)` | 1 | non-empty, unique `x±/y±/z±` | selected boundary faces | FDM CPU, single-grid FDM CUDA, FEM CPU/GPU | `magnets[].absorbing_boundary.faces` |
| $p$ | `profile` | `str`, `"smootherstep"` | 1 | `linear`, `quadratic`, `smootherstep`, `logarithmic`, `tanh`, or `custom` | taper profile | common material-field planner | `magnets[].absorbing_boundary.profile` |
| $u$ | `expression` | optional `str`, `None` | 1 | required for `custom`, using the normalized coordinate and rules above | user-authored taper | common material-field planner | `magnets[].absorbing_boundary.expression` |
| — | `frame` | `str`, `"object"` | 1 | `object` or `universe` | coordinate frame for bounds | FDM CPU, single-grid FDM CUDA, FEM CPU/GPU | `magnets[].absorbing_boundary.frame` |
| $d_f$ | internal | derived | $\mathrm{m}$ | finite sampled point and bounds | inward distance from face $f$ | planner only | not serialized |
| $t_f$ | internal | derived | 1 | clamped to $[0,1]$ | profile coordinate | planner only | not serialized |
| $w_f(\mathbf r)$ | internal | derived | 1 | profile output in $[0,1]$ | selected-face profile weight | planner only | not serialized |
| $p(t)$ | `profile` implementation | derived | 1 | selected profile formula | scalar taper profile | planner only | not serialized |

Faces use `x+`, `x-`, `y+`, `y-`, `z+`, and `z-`. `frame="object"` uses the
axis-aligned bounds of the object's sampled magnetic points after removing
the object's translation. `frame="universe"` uses the explicit study-universe
box; when the universe is automatic, the planner uses the sampled object
bounds as the deterministic fallback.

W FEM bounds obejmują sumę węzłów wszystkich segmentów należących do jednego
obiektu, z deduplikacją wspólnych węzłów. Marker podregionu konformalnego nie
tworzy nowego brzegu warstwy tłumiącej. Pole alpha obiektu jest rozwiązywane
raz dla tej sumy, więc kolejność markerów nie zmienia profilu ani wartości na
ich wspólnej granicy. Ta sama reguła dotyczy fallbacku automatycznego universe;
różne obiekty zachowują odrębne bounds. Regresja planera sprawdza mapę alpha,
bez deklaracji nowej kwalifikacji dynamiki FEM CPU/GPU.

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
the field. Single-grid FDM CUDA plans cellwise damping and its LLG kernels
read local alpha. This records source support. Managed GPU execution and parity
for the new profiles require evidence.

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
| `film.alpha` | `float` | required | 1 | finite and >= 0 | Base Gilbert damping | FDM CPU, single-grid FDM CUDA, FEM CPU/GPU | `magnets[].material.damping` |
| `film.alpha.absorbing_boundary(total_width=...)` | module | disabled | m and 1 by parameter | positive widths; ramp <= total; non-negative max_damping; valid unique faces/profile/frame | Per-object additive damping layer | FDM CPU, single-grid FDM CUDA, FEM CPU/GPU | `magnets[].absorbing_boundary` |
| `film.alpha.absorbing_boundary(expression=...)` | `str or None` | None | 1 | Required for custom; finite normalized scalar ramp with endpoints 0 and 1 | Formula in dimensionless ramp position u | Common material-field planner | `magnets[].absorbing_boundary.expression` |

(problem-ir)=
### 4.2 ProblemIR representation

`MagnetIR.absorbing_boundary` is optional and contains
`total_width_m`, `ramp_width_m`, `max_damping`, `faces`, `profile`, and `frame`.
The optional `expression` string is present only for `profile="custom"`. Older
profiles retain their existing representation. The inspector shows an expression
field for `Custom`, and canonical script export writes the same expression as a
string keyword to `.alpha.absorbing_boundary(...)`.
IR validation rejects non-finite values, non-positive widths, `ramp_width_m`
greater than `total_width_m`, negative damping, duplicate/unknown faces, and
unknown profile/frame names.

(round-trip-and-failure-semantics)=
### 4.3 Round-trip and failure semantics

The requested intent is preserved as `MagnetIR.absorbing_boundary` and is also
retained in the scene resource and canonical script export. The resolved execution
is the planner-produced `alpha_field` at FDM cells or FEM nodes; it is not
inferred from the base material after planning. Invalid values fail at Python or
IR validation with structured validation errors. The v2 authoring mutation
also validates a profile before saving the object. The UI writes a typed
configuration via the same optional scene field used for existing profiles.
An explicit `null` is currently interpreted as omission by the object patch
deserializer. The profile extension leaves that limitation open. Unsupported combinations,
including forced CUDA multilayer with unqualified cellwise material fields, are
still rejected by the execution planner.

(implementation-mapping)=
### 4.4 Implementation mapping

| Contract | Source symbol | Responsibility |
|---|---|---|
| Python module | `packages/fullmag-py/src/fullmag/model/absorbing_boundary.py:AbsorbingBoundaryLayer` | parameter validation and profile serialization |
| Object API | `packages/fullmag-py/src/fullmag/world.py:AlphaControl.absorbing_boundary` | per-object attachment |
| Canonical IR | `crates/fullmag-ir/src/model.rs:MagnetIR` | typed optional module |
| IR validation | `crates/fullmag-ir/src/lib.rs:validate_absorbing_boundary` | fail-closed schema validation |
| Shared ramp evaluator | `crates/fullmag-ir/src/absorbing_boundary.rs:ResolvedAbsorbingBoundaryProfile` | normalized presets and checked scalar expression sampling |
| FDM/FEM lowering | `crates/fullmag-plan/src/material.rs:apply_absorbing_boundary_layer` | cell/node alpha-field materialization |
| UI authoring | `apps/control-room/src/modules/inspector/panels/ObjectAbsorbingBoundaryPanel.tsx:ObjectAbsorbingBoundaryPanel` | v2 scene-resource editing |

### 4.5 Planner and capability-matrix impact

The planner applies the layer after region-owned alpha resolution. This keeps
the module additive to the object's base/region material semantics. The
existing single-grid FDM CUDA and FEM/CPU routes receive the resolved alpha
samples through their existing material field. The UI and script builder carry
the same optional object field. The new profiles add no device selection, native
ABI or capability field.

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
round-trip. The new profile tests check analytic midpoint values, exact plateau,
invalid custom expressions, and Python export. Rust tests cover IR validation,
planner profiles, region ordering,
and single-grid FDM CUDA planner materialization. Authoring tests cover scene and script
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
new-profile GPU/CPU parity, and quantitative spin-wave reflection qualification are
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
| `crates/fullmag-ir/src/absorbing_boundary.rs` | `ResolvedAbsorbingBoundaryProfile` | Shared preset and expression evaluator |
| `packages/fullmag-py/src/fullmag/model/_absorbing_boundary_expression.py` | `compile_expression` | Python expression validation and analytic sampling |
| `packages/fullmag-py/src/fullmag/runtime/script_builder.py` | `_render_absorbing_boundary` | Canonical editable profile export |
| `crates/fullmag-plan/src/material.rs` | `apply_absorbing_boundary_layer` | FDM/FEM alpha-field materialization |
| `crates/fullmag-plan/src/fem.rs` | `build_region_material_fields` | FEM material-field handoff |
| `crates/fullmag-plan/src/tests.rs` | `fdm_cuda_absorbing_boundary_plans_cellwise_damping` | Single-grid FDM CUDA planner regression |
| `apps/control-room/src/modules/inspector/panels/ObjectAbsorbingBoundaryPanel.tsx` | `ObjectAbsorbingBoundaryPanel` | UI authoring and persistence |
| `crates/fullmag-plan/src/tests/material_audit_fem.rs` | `fem_absorber_uses_the_union_of_conformal_owner_segments` | Mapa alpha nie zależy od podziału ownera na markery ani ich kolejności. |
