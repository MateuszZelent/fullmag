---
title: Airbox Grading API
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-meshing-fem-airbox-grading)=
# Airbox Grading API

## 1. What it is and when to use it

`study.universe.mesh(...)` controls air sizing: element size bounds and how the
size grows with distance from magnetic bodies (grading).

When to use it: always with a FEM airbox. Geometric grading gives fine elements
near objects (accurate near field) and coarse ones far away (low cost).
Impact on the simulation: an overly aggressive growth rate degrades transition
element quality; an overly gentle one inflates the element count.

## 2. Physical and mathematical explanation

Grading controls discretization of the stray field, whose strength decays with
distance (dipolar $\sim r^{-3}$):

$$
\|\mathbf{H}\| \;\propto\; \frac{m}{4\pi}\, r^{-3},
$$

where $m$ — magnetic moment ($\mathrm{A\,m^{2}}$), $r$ — distance ($\mathrm{m}$).
The element size should therefore grow with $r$; for geometric grading the local
size satisfies

$$
h(\mathbf{x}) \;\le\; h_{\min} \, g^{\,d(\mathbf{x})/h_{\min}},
$$

where $h_{\min}$ — minimum size ($\mathrm{m}$), $g$ — growth rate ($1$),
$d(\mathbf{x})$ — distance to the nearest body ($\mathrm{m}$).

| Symbol | Meaning | SI unit |
|---|---|---|
| $\mathbf{H}$ | magnetic field strength | $\mathrm{A\,m^{-1}}$ |
| $m$ | magnetic moment | $\mathrm{A\,m^{2}}$ |
| $h(\mathbf{x})$ | local element size | $\mathrm{m}$ |
| $g$ | maximum size growth rate | $1$ |

## 3. Example — complete Python script

```python
# %% Geometric air grading
import fullmag as fm

nm = 1.0e-9

study = fm.study("airbox_grading_example")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")

study.universe(mode="manual", size=(800 * nm, 400 * nm, 300 * nm))
study.universe.mesh(
    minimum_element_size=8 * nm,
    maximum_element_size=100 * nm,
    maximum_element_growth_rate=1.3,
    grading="geometric",
)

film = study.geometry(fm.Box(300 * nm, 100 * nm, 5 * nm), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.texture.uniform(1.0, 0.0, 0.0)
film.mesh(minimum_element_size=2.5 * nm, maximum_element_size=5 * nm)

study.exchange()
study.demag(model="airbox", variant="robin")
study.build_domain_mesh()
study.stages.add_relax(stage_id="equilibrium", tolT=1.0e-6)
```

## 4. Exact API

`study.universe.mesh(**kwargs)`:

| Parameter | Type | Default | Unit | Validation | Meaning |
|---|---|---|---|---|---|
| `minimum_element_size` / `hmin` | `float \| None` | `None` | $\mathrm{m}$ | positive | size near bodies |
| `maximum_element_size` / `hmax` | `float \| None` | `None` | $\mathrm{m}$ | positive | size far from bodies |
| `maximum_element_growth_rate` / `growth_rate` | `float \| None` | `None` | $1$ | positive | maximum growth rate |
| `grading` | `str \| None` | `None` | $1$ | `"geometric"`, `"linear"` | grading type |

The advanced universe resource policy adds curvature and narrow-region resolution.
All values are **targets**, not guaranteed extrema.

Failure behavior: non-positive values → `ValueError`; mixing FDM controls
(`cell_size`) with FEM ones → `ValueError`.

ProblemIR mapping: airbox hmin/hmax/growth/grading in mesh workflow metadata;
realization in the build report.

## 5. How to set it in Control Room

```
Model Explorer
└── Universe / Airbox      → selection kinds: airbox.*
```

The **Airbox Mesh Parameters** inspector: hmin/hmax, growth rate, grading type.
Full description: {doc}`../../../../frontend/meshing/airbox-mesh`.

## 6. Backend support

| Solver | Device | Status | Notes |
|---|---|---|---|
| FEM | CPU | implemented | Gmsh size fields + grading |
| FEM | GPU | capability-gated | identical content-addressed mesh |
| FDM | CPU/GPU | not applicable | constant Cartesian step |

## 7. Limitations and known pitfalls

- Growth rates well above $1.5$ usually degrade transition element quality; check
  quality statistics after the build.
- Realized extrema may deviate from the request — the report is authoritative.

## 8. Scientific bibliography

1. J. D. Jackson, *Classical Electrodynamics*, 3rd ed., Wiley, 1999.
2. C. Geuzaine and J.-F. Remacle, “Gmsh,” *Int. J. Numer. Methods Eng.* **79**, 1309–1331 (2009).

## 9. Source-code index

| Claim | Path | Symbol | Evidence |
|---|---|---|---|
| air sizing and grading | `packages/fullmag-py/src/fullmag/world.py` | `StudyUniverseMeshHandle.mesh` | validation and `_configure_study_universe` |
| FDM/FEM mutual exclusion | `packages/fullmag-py/src/fullmag/world.py` | `StudyUniverseMeshHandle.mesh` | `cell_size` vs FEM controls branch |
