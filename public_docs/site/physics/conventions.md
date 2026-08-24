---
title: Physical conventions and units
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/physics/units.md
---

(public-docs-physics-conventions)=
# Physical conventions and units

This compatibility entry summarizes the project-wide contract. The exhaustive quantity table and
backend discussion live in {doc}`foundations/conventions-and-units`; interaction pages may refine a
term, but may not introduce a second sign or unit convention.

(physics-conventions-problem-statement)=
## Problem statement

FullMag authoring, ProblemIR, planners, and runtimes exchange physical values in SI. Requested
intent and resolved execution must preserve the same meaning across FDM/FEM and CPU/GPU lanes.

(physics-conventions-governing-equations)=
## Governing equation

The solver state is reduced magnetization:

```{math}
:label: eq-public-conventions-reduced-m
\mathbf m=\frac{\mathbf M}{M_s},\qquad |\mathbf m|=1
```

(physics-conventions-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---:|
| $\mathbf m$ | reduced magnetization | $1$ |
| $\mathbf M$ | magnetization | $\mathrm{A\,m^{-1}}$ |
| $M_s$ | saturation magnetization | $\mathrm{A\,m^{-1}}$ |
| $A$ | exchange stiffness | $\mathrm{J\,m^{-1}}$ |
| $\alpha$ | Gilbert damping | $1$ |

(physics-conventions-assumptions-and-validity)=
## Assumptions and validity

Geometry is authored in metres, fields in $\mathrm{A\,m^{-1}}$, energies in joules, and direct
torques in $\mathrm{s^{-1}}$. No CGS conversion or backend-specific reinterpretation is implicit.

(physics-conventions-python-api)=
## Python API

```python
# %% SI-only stage-first authoring
import fullmag as fm

nm = 1.0e-9
study = fm.study("si-conventions")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 2 * nm))
body = study.geometry(fm.Box(40 * nm, 20 * nm, 4 * nm), name="film")
body.Ms = 800.0e3
body.Aex = 13.0e-12
body.alpha = 0.02
body.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
study.exchange()
study.stages.add_relax(stage_id="relax", dt=1.0e-15, max_steps=10, tolT=1.0e-6)
```

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `Material.Ms` | `float` | required | $\mathrm{A\,m^{-1}}$ | positive finite | saturation magnetization | FDM/FEM CPU/GPU subject to planner capability | `materials[].saturation_magnetisation` |
| `Material.A` | `float` | required | $\mathrm{J\,m^{-1}}$ | positive finite | exchange stiffness | FDM/FEM CPU/GPU subject to planner capability | `materials[].exchange_stiffness` |
| `Material.alpha` | `float` | required | $1$ | non-negative finite | Gilbert damping | FDM/FEM CPU/GPU subject to planner capability | `materials[].damping` |

(physics-conventions-problem-ir)=
## ProblemIR

Python names are normalized without a unit conversion to
`materials[].saturation_magnetisation`, `materials[].exchange_stiffness`, and
`materials[].damping`. Dynamics records the reduced gyromagnetic constant separately under
`study.dynamics.gyromagnetic_ratio`.

(physics-conventions-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Requested intent retains authored SI values. Resolved execution records backend, device, precision,
and any solver policy without changing units. Validation errors reject non-finite or out-of-domain
material values; unsupported combinations fail in planning rather than silently converting units or
falling back to another lane.

(physics-conventions-discrete-realization)=
## Discrete realization

| Solver | Device | Status | Contract |
|---|---|---|---|
| FDM | CPU | reference | FP64 structured-grid reference uses the shared SI/LLG convention |
| FDM | GPU | implemented | device kernels consume the same resolved values; qualification remains device-specific |
| FEM | CPU | implemented | MFEM operators and LLG RHS consume the shared SI values |
| FEM | GPU | implemented | device realization preserves units; host setup alone is not GPU qualification |

(physics-conventions-implementation-mapping)=
## Implementation mapping

`Material` owns SI validation and lowering; `LLG` owns dynamics units. FDM and native FEM RHS
implementations consume the reduced state and field convention.

(physics-conventions-validation)=
## Validation

Constructor tests cover SI validation and lowering. Solver contracts cover the LLG sign, norm,
field units, and CPU/GPU parity per qualified lane.

(physics-conventions-limitations)=
## Limitations

This overview does not qualify every interaction or device. Interaction pages and planner
capabilities remain authoritative for concrete availability.

(physics-conventions-scientific-bibliography)=
## Scientific bibliography

1. W. F. Brown Jr., *Micromagnetics*, Interscience Publishers, 1963.
2. C. Abert, "Micromagnetics and spintronics: models and numerical methods," *European Physical
   Journal B* **92**, 120 (2019). [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).

(physics-conventions-source-code-index)=
## Source-code index

| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Material SI contract | `packages/fullmag-py/src/fullmag/model/structure.py` | `class Material` | validates and lowers material values | Python API tests |
| Dynamics SI contract | `packages/fullmag-py/src/fullmag/model/dynamics.py` | `class LLG` | validates and lowers the reduced gyromagnetic constant | Python API tests |
| Native FEM LLG convention | `backends/fem/cpu/mfem/integrators/llg_rhs.cpp` | `llg_rhs_aos` | converts $\mathbf H_{\mathrm{eff}}$ to the explicit Gilbert RHS | native LLG contract tests |
