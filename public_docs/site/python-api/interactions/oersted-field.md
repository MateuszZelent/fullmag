---
title: Oersted field Python API
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-11-26
reviewed_revision: 752450f8d259ab97c76c36fe666d5474b02abe9a
---

# Oersted field

(oersted-api-problem-statement)=
## Problem statement

Fullmag exposes two Oersted field interaction contracts registered on a study via `study.oersted(term)` (or flat `fm.oersted(term)`):

1. `fm.OerstedField(source, model="from_current_solution", id=None)` — couples an upstream `CurrentTransport` solution by name (`source`) to Biot–Savart or vector-potential Oersted field evaluation; unlinked Oersted fields are rejected.
2. `fm.OerstedCylinder(current, radius, center=(0.0, 0.0, 0.0), axis=(0.0, 0.0, 1.0), time_dependence=None, id="oersted:cylinder")` — analytic Ampère-law Oersted field for an infinite cylindrical conductor (such as an STNO or MTJ pillar) modulated by a typed `TimeDependence` (`Constant`, `Sinusoidal`, `Pulse`, `PiecewiseLinear`, or `SincPulse`).

(python-api-interactions-oersted-field-governing-equations)=
## Governing equations

Solved-current Oersted magnetostatics (`fm.OerstedField`) reconstructs $\mathbf{H}_{\mathrm{oe}}(\mathbf{x})$ solving $\nabla\times\mathbf{H}_{\mathrm{oe}} = \mathbf{J}_c$ ($\nabla\cdot\mathbf{H}_{\mathrm{oe}} = 0$) via direct tetrahedral Biot–Savart quadrature (`OE-F1`) or magnetic vector potential $\mathbf{B}_{\mathrm{oe}} = \nabla\times\mathbf{A}$ (`OE-F2`) driven by a divergence-free current-transport solution `source`. Analytic cylindrical Oersted fields (`fm.OerstedCylinder`) evaluate Ampère's law for an infinite wire of radius $R$ carrying current $I(t) = I_{\mathrm{dc}}\,w(t)$ along unit axis $\hat{\mathbf{a}}$ centered at $\mathbf{x}_0$, scaling radially as $r/(2\pi R^2)$ inside ($r \le R$) and $1/(2\pi r)$ outside ($r > R$). Continuum equations and circuit-closure requirements are documented in {doc}`../../physics/interactions/oersted-field/index`.

(python-api-interactions-oersted-field-symbols-and-si-units)=
## Symbols and SI units

- `fm.OerstedField`: `source`, `model`, and `id` are dimensionless identifiers ($1$). The referenced charge current density $\mathbf{J}_c$ uses $\mathrm{A\,m^{-2}}$, and the reconstructed Oersted field $\mathbf{H}_{\mathrm{oe}}$ uses $\mathrm{A\,m^{-1}}$.
- `fm.OerstedCylinder`: `current` uses amperes ($\mathrm{A}$), `radius` and `center` coordinates use metres ($\mathrm{m}$), and `axis`, `time_dependence`, and `id` are dimensionless ($1$).
- `TimeDependence` parameters: frequencies (`frequency_hz`, `cutoff_hz`) use hertz ($\mathrm{Hz}$), times (`t_on`, `t_off`, `t0`, `points[][0]`) use seconds ($\mathrm{s}$), phase (`phase_rad`) uses radians ($\mathrm{rad}$), and scalar envelope amplitudes/offsets (`offset`, `amplitude`, `points[][1]`) are dimensionless ($1$).

(python-api-interactions-oersted-field-assumptions-and-validity)=
## Assumptions and validity

- `fm.OerstedField`: `source` must be a non-empty string identifying an upstream `CurrentTransport` module; `model` must currently be `"from_current_solution"`; and `id` defaults to `f"oersted:{source}"` when omitted.
- `fm.OerstedCylinder`: `radius` must be finite and strictly positive (`require_positive`); `current` is converted via `float`; `center` and `axis` are checked for length 3 via `as_vector3` (planner/backend enforces finiteness and non-zero unit axis); `id` must be non-empty.
- `TimeDependence` classes validate: `Sinusoidal` (`frequency_hz > 0`, finite `phase_rad`/`offset`); `Pulse` (finite `t_on`, `t_off` with `t_off > t_on`); `PiecewiseLinear` (at least 2 finite `(time, value)` points with strictly increasing times); `SincPulse` (`cutoff_hz > 0`, finite `t0 >= 0`, finite `amplitude`).
- `study.oersted(term)` accepts only `OerstedCylinder` or `OerstedField` instances and raises `TypeError` otherwise.

(python-api-interactions-oersted-field-python-api)=
## Python API

### Constructors, time dependences, and study helper

- `fm.OerstedField(source, model="from_current_solution", id=None)`
- `fm.OerstedCylinder(current, radius, center=(0.0, 0.0, 0.0), axis=(0.0, 0.0, 1.0), time_dependence=None, id="oersted:cylinder")`
- `TimeDependence = fm.Constant | fm.Sinusoidal | fm.Pulse | fm.PiecewiseLinear | fm.SincPulse`
- `study.oersted(term)` (also flat `fm.oersted(term)`)

### Parameters

| Python name | Type | Default | SI unit | Validation | Meaning | FEM/FDM CPU/GPU support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `source` | `str` | `required` | $1$ | non-empty current transport source | upstream `CurrentTransport` module identifier | FEM/FDM CPU/GPU: IR; solved transport runtime required | `source` |
| `model` | `str` | `from_current_solution` | $1$ | `"from_current_solution"` | field reconstruction model | FEM/FDM CPU/GPU: IR; solved transport runtime required | `model` |
| `id` | `str \| None` | `None` | $1$ | non-empty when supplied; otherwise derived as `oersted:<source>` | stable interaction identifier | FEM/FDM CPU/GPU: IR; resolver-specific | `id` |
| `fm.OerstedCylinder.current` | `float` | `required` | $\mathrm{A}$ | converted via `float`; sign sets chirality | DC current amplitude of cylindrical conductor | FDM/FEM CPU/GPU: analytic cylinder field precomputed and scaled per step | `current` |
| `fm.OerstedCylinder.radius` | `float` | `required` | $\mathrm{m}$ | finite and strictly positive via `require_positive` | cylinder radius | FDM/FEM CPU/GPU: analytic cylinder radius | `radius` |
| `fm.OerstedCylinder.center` | `Sequence[float]` | `(0.0, 0.0, 0.0)` | $\mathrm{m}$ | length-3 sequence via `as_vector3`; planner checks finiteness | cross-section center coordinates | FDM/FEM CPU/GPU: cylinder origin | `center` |
| `fm.OerstedCylinder.axis` | `Sequence[float]` | `(0.0, 0.0, 1.0)` | $1$ | length-3 sequence via `as_vector3`; planner checks finiteness/unit norm | current-flow axis | FDM/FEM CPU/GPU: cylinder axis | `axis` |
| `fm.OerstedCylinder.time_dependence` | `TimeDependence \| None` | `None` | $1$ | `Constant`, `Sinusoidal`, `Pulse`, `PiecewiseLinear`, or `SincPulse` | time-varying envelope multiplying `current` | FDM/FEM CPU/GPU: evaluated per RK stage/step | `time_dependence` |
| `fm.OerstedCylinder.id` | `str` | `oersted:cylinder` | $1$ | non-empty string via `require_non_empty` | stable cylindrical Oersted identifier | FDM/FEM CPU/GPU: IR identifier | `id` |

### `TimeDependence` classes

| Class and signature | Validation | SI units | `to_ir()` payload |
|---|---|---|---|
| `fm.Constant()` | no arguments | $1$ | `{"kind": "constant"}` |
| `fm.Sinusoidal(frequency_hz, phase_rad=0.0, offset=0.0)` | `frequency_hz > 0`; finite `phase_rad`, `offset` | $\mathrm{Hz}$, $\mathrm{rad}$, $1$ | `{"kind": "sinusoidal", "frequency_hz": ..., "phase_rad": ..., "offset": ...}` |
| `fm.Pulse(t_on, t_off)` | finite times; `t_off > t_on` | $\mathrm{s}$, $\mathrm{s}$ | `{"kind": "pulse", "t_on": ..., "t_off": ...}` |
| `fm.PiecewiseLinear(points)` | $\ge 2$ finite `(time, value)` pairs; strictly increasing times | $\mathrm{s}$, $1$ | `{"kind": "piecewise_linear", "points": [[t, v], ...]}` |
| `fm.SincPulse(cutoff_hz, t0=0.0, amplitude=1.0)` | `cutoff_hz > 0`; finite `t0 >= 0`, `amplitude`; supports `value_at(time_s)` | $\mathrm{Hz}$, $\mathrm{s}$, $1$ | `{"kind": "sinc_pulse", "cutoff_hz": ..., "t0": ..., "amplitude": ...}` |

### Stage-first example

```python
# %% Stage-first solved-current and cylindrical Oersted fields
import fullmag as fm

study = fm.study("oersted_pillar_excitation")
study.engine("fdm")
study.device("cpu", precision="double")
study.objects.mesh.defaults(cell_size=(4.0e-9, 4.0e-9, 5.0e-9))

pillar = study.geometry(fm.Cylinder(radius=40.0e-9, height=5.0e-9), name="free_layer")
pillar.Ms = 800.0e3
pillar.Aex = 13.0e-12
pillar.alpha = 0.02
pillar.m = fm.texture.uniform(1.0, 0.0, 0.0)

study.exchange()
study.demag()

# 1) Analytic cylindrical Oersted field with a rectangular current pulse
oersted_cyl = study.oersted(
    fm.OerstedCylinder(
        current=5.0e-3,
        radius=40.0e-9,
        center=(0.0, 0.0, 0.0),
        axis=(0.0, 0.0, 1.0),
        time_dependence=fm.Pulse(t_on=0.0, t_off=2.0e-9),
        id="pillar_pulse_oersted",
    )
)

# 2) Solved-current Oersted field linked to a CurrentTransport module
study.current_transport(
    name="ohmic_feed",
    model="prescribed_density",
    current_density=(0.0, 0.0, 1.0e10),
    solve_region="free_layer",
)
oersted_solved = study.oersted(fm.OerstedField(source="ohmic_feed", id="solved_oersted"))

study.stages.add_relax(stage_id="relax_eq", dt=5.0e-13, max_steps=50)
study.stages.add_run(stage_id="pulse_response", until=2.0e-9)

# %% Canonical IR inspection
cyl_ir = oersted_cyl.to_ir()
solved_ir = oersted_solved.to_ir()
```

(python-api-interactions-oersted-field-problem-ir)=
## ProblemIR

- `fm.OerstedField.to_ir()` emits `{"kind": "oersted_field", "id": ..., "model": "from_current_solution", "source": ...}`.
- `fm.OerstedCylinder.to_ir()` emits `{"kind": "oersted_cylinder", "id": ..., "current": ..., "radius": ..., "center": [...], "axis": [...]}` and includes `"time_dependence": {...}` when provided.

(python-api-interactions-oersted-field-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

`requested intent` preserves `source`, `model`, geometric cylinder parameters, `time_dependence`, and `id` in `ProblemIR` independently of `resolved execution`. `Validation errors` reject empty `source`/`id`, non-positive `radius`, invalid `TimeDependence` bounds, or unsupported `model` values in Python, while non-finite or zero `OerstedCylinder.axis` vectors fail closed at planner validation. `Unsupported combinations` (such as solved-current Oersted evaluation on backends lacking conservative RT0 / $H(\mathrm{curl})$ transport coupling) fail closed at planning.

(python-api-interactions-oersted-field-discrete-realization)=
## Discrete realization

The Python contract supplies transport linkage or cylindrical geometry in `ProblemIR` only; evaluating direct tetrahedral Biot–Savart quadrature (`OE-F1`), $H(\mathrm{curl})$ vector-potential solves (`OE-F2`), and opt-in 106-bit `DoubleDouble` CUDA `OE-F1` far-field kernels is owned by the solver backends. See {ref}`numerical-methods-performance-fem-spectral-multiphysics` for Wave 2 sparse/parallel multiphysics acceleration (`OE-F2` 3-tier `MUMPS`/`HYPRE`/`MFEM` solver and `OE-F1` hybrid GPU quadrature).

| Solver | Device | `OerstedCylinder` | `OerstedField` (`from_current_solution`) | Performance reference |
|---|---|---|---|---|
| `FDM` | `CPU` | Supported (analytic pillar field + `TimeDependence`) | Planner-gated prescribed-cylinder / transport subset | {ref}`numerical-methods-performance-fdm-core` |
| `FDM` | `GPU` | Supported (precomputed GPU field scaled per step) | Planner-gated transport subset | {ref}`numerical-methods-performance-fdm-core` |
| `FEM` | `CPU` | IR lowered; planner checks support | Supported via 0-ULP parallel `OE-F1` quadrature and 3-tier sparse `OE-F2` | {ref}`numerical-methods-performance-fem-spectral-multiphysics` |
| `FEM` | `GPU` | IR lowered; planner checks support | Hybrid GPU `OE-F1` quadrature (including opt-in `DoubleDouble` CUDA far-field) | {ref}`numerical-methods-performance-fem-spectral-multiphysics` |

(python-api-interactions-oersted-field-implementation-mapping)=
## Implementation mapping

- Oersted and `TimeDependence` classes: `packages/fullmag-py/src/fullmag/model/energy.py` (`class OerstedField`, `class OerstedCylinder`, `class Constant`, `class Sinusoidal`, `class Pulse`, `class PiecewiseLinear`, `class SincPulse`).
- Stage-first registration helper: `packages/fullmag-py/src/fullmag/world.py` (`class StudyBuilder` method `oersted`).

(python-api-interactions-oersted-field-validation)=
## Validation

Focused repository unit tests covering `OerstedField` and `OerstedCylinder` IR lowering and source validation include `test_oersted_field_from_current_solution_serializes_to_ir` and `test_oersted_field_requires_current_transport_source`. Live solver runtime parity and Control Room browser behavior require separate qualification.

(python-api-interactions-oersted-field-limitations)=
## Limitations and Control Room

Control Room surfaces physics modules through `apps/control-room/src/modules/inspector/inspectors/objects/physics/ObjectPhysicsSpec.tsx` and `PhysicsModuleSpec.tsx` and has no dedicated form editor for `fm.OerstedField` or `fm.OerstedCylinder`; author Oersted terms in Python scripts and verify backend support via session capability reports. See {doc}`/frontend/capability-register`.

(python-api-interactions-oersted-field-scientific-bibliography)=
## Scientific bibliography

- R. Hertel and A. Kákay, “Hybrid finite-element/boundary-element method to calculate Oersted fields,” *Journal of Magnetism and Magnetic Materials* **369**, 189–196 (2014), [doi:10.1016/j.jmmm.2014.06.047](https://doi.org/10.1016/j.jmmm.2014.06.047) | [arXiv:0804.4010](https://arxiv.org/abs/0804.4010).
- J. D. Jackson, *Classical Electrodynamics*, 3rd ed., Wiley (1998).

(python-api-interactions-oersted-field-source-code-index)=
## Source code index

| Source path | Symbol | Responsibility |
|---|---|---|
| [`packages/fullmag-py/src/fullmag/model/energy.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/energy.py#L443) | `class OerstedField` | solved-current Oersted constructor and IR lowering |
| [`packages/fullmag-py/src/fullmag/model/energy.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/energy.py#L383) | `class OerstedCylinder` | analytic cylindrical conductor Oersted constructor and IR lowering |
| [`packages/fullmag-py/src/fullmag/model/energy.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/energy.py#L254) | `class Constant` | constant `TimeDependence` envelope |
| [`packages/fullmag-py/src/fullmag/model/energy.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/energy.py#L262) | `class Sinusoidal` | harmonic `TimeDependence` envelope |
| [`packages/fullmag-py/src/fullmag/model/energy.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/energy.py#L287) | `class Pulse` | rectangular pulse `TimeDependence` envelope |
| [`packages/fullmag-py/src/fullmag/model/energy.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/energy.py#L306) | `class PiecewiseLinear` | piecewise-linear `TimeDependence` envelope |
| [`packages/fullmag-py/src/fullmag/model/energy.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/energy.py#L342) | `class SincPulse` | normalized sinc `TimeDependence` envelope |
| [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L6439) | `class StudyBuilder` | `study.oersted(...)` registration facade |
