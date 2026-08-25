---
title: FEM Airbox Mesh API
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-meshing-fem-airbox-root)=
# FEM Airbox Mesh API

## 1. What it is and when to use it

The airbox (universe) is the surrounding air volume around the magnetic objects,
required to solve magnetostatics (stray field, demagnetization). Airbox authoring
belongs to the **universe**, not to a ferromagnet:

- exterior geometry: `study.universe(...)`,
- air sizing: `study.universe.mesh(...)`,
- magnetostatic realization (Poisson/Robin/PBC): separately via `study.demag(...)`.

When to use it: in every FEM scenario with an airbox demag model.
Impact on the simulation: a too-small airbox corrupts boundary conditions of the
stray field; a too-fine one costs unacceptably. Grading (section 2) gives
resolution near objects and cheap elements far away.

## 2. Physical and mathematical explanation

The airbox is the solution domain of the magnetostatic equation for the scalar
potential outside magnetic bodies:

$$
\nabla \cdot \left( \mu \nabla \phi \right) = 0
\quad \text{in air},
$$

where $\phi$ — scalar potential ($\mathrm{A}$), $\mu$ — permeability
($\mathrm{H\,m^{-1}}$). The air element size should grow with distance from the
bodies (geometric grading), and the airbox extent must be large enough that the
boundary condition (Dirichlet/Robin) does not distort the near field.

| Symbol | Meaning | SI unit |
|---|---|---|
| $\phi$ | scalar potential | $\mathrm{A}$ |
| $\mu$ | magnetic permeability | $\mathrm{H\,m^{-1}}$ |
| $h_{\min}$, $h_{\max}$ | air element size bounds | $\mathrm{m}$ |
| $g$ | maximum size growth rate | $1$ |

## 3. Example — complete Python script

```python
# %% Airbox geometry and grading
import fullmag as fm

nm = 1.0e-9

study = fm.study("airbox_mesh_api_example")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")

# Exterior geometry of the universe / airbox:
study.universe(mode="manual", size=(800 * nm, 400 * nm, 300 * nm))

# Air sizing with geometric grading away from magnetic bodies:
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

# Magnetostatic realization is selected separately from mesh sizing:
study.exchange()
study.demag(model="airbox", variant="robin")
study.build_domain_mesh()
study.stages.add_relax(stage_id="equilibrium", tolT=1.0e-6)
```

## 4. Exact API

`study.universe.mesh(**kwargs)` (`StudyUniverseMeshHandle`, `world.py`):

| Parameter | Type | Default | Unit | Validation | Meaning |
|---|---|---|---|---|---|
| `minimum_element_size` / `hmin` | `float \| None` | `None` | $\mathrm{m}$ | positive | minimum air element size |
| `maximum_element_size` / `hmax` | `float \| None` | `None` | $\mathrm{m}$ | positive | maximum air element size |
| `maximum_element_growth_rate` / `growth_rate` | `float \| None` | `None` | $1$ | positive | maximum size growth rate |
| `grading` | `str \| None` | `None` | $1$ | e.g. `"geometric"`, `"linear"` | grading type |

Advanced policy (universe resource advanced policy) additionally covers curvature
and narrow-region resolution.

Failure behavior: `cell_size` (FDM) cannot be combined with FEM controls and vice
versa → `ValueError`; non-positive sizes → `ValueError`. Values are **targets**,
not guaranteed realized extrema.

ProblemIR mapping: universe policy lands in mesh workflow metadata (airbox
hmin/hmax/growth/grading); realization and any fallbacks are recorded in the build
report.

## 5. How to set it in Control Room

```
Model Explorer
└── Universe / Airbox      → selection kinds: airbox.* 
```

The **Airbox Mesh Parameters** inspector edits air sizing; exterior geometry
(size/padding/center) lives in the universe geometry panels; the magnetostatic
realization choice (`study.demag`) is made in the Physics/Demag panel. Full
description: {doc}`../../../../frontend/meshing/airbox-mesh`.

## 6. Backend support

| Solver | Device | Status | Notes |
|---|---|---|---|
| FEM | CPU | implemented | Gmsh sizing + grading; report is authoritative |
| FEM | GPU | capability-gated | identical content-addressed mesh |
| FDM | CPU/GPU | not applicable | FDM uses Cartesian grids ({doc}`../../fdm/index`) |

## 7. Limitations and known pitfalls

- Airbox extent and boundary policy (`study.demag`) are two different decisions;
  changing one does not fix the other.
- Size extrema are targets — check realized values in the build report.

## 8. Scientific bibliography

1. J. D. Jackson, *Classical Electrodynamics*, 3rd ed., Wiley, 1999.
2. C. Geuzaine and J.-F. Remacle, “Gmsh,” *Int. J. Numer. Methods Eng.* **79**, 1309–1331 (2009).

## 9. Source-code index

| Claim | Path | Symbol | Evidence |
|---|---|---|---|
| air sizing | `packages/fullmag-py/src/fullmag/world.py` | `StudyUniverseMeshHandle.mesh` | validation and `_configure_study_universe` |
| universe geometry | `packages/fullmag-py/src/fullmag/world.py` | `StudyBuilder.universe` | facade signature |
| FDM/FEM mutual exclusion | `packages/fullmag-py/src/fullmag/world.py` | `StudyUniverseMeshHandle.mesh` | `cell_size` vs FEM controls branch |

```{toctree}
:maxdepth: 2

geometry
grading
build
```
