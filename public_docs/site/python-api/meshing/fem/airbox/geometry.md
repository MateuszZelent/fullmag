---
title: Airbox Geometry API
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-meshing-fem-airbox-geometry)=
# Airbox Geometry API

## 1. What it is and when to use it

`study.universe(mode="manual", size=(Lx, Ly, Lz))` defines the exterior universe
(airbox) geometry: a box enclosing all magnetic objects.

When to use it: always before building the shared FEM mesh with an airbox.
Impact on the simulation: airbox dimensions set the distance of boundary
conditions from the bodies — a too-small airbox distorts the stray field and
demagnetization; a too-large one adds unnecessary elements.

## 2. Physical and mathematical explanation

The airbox is the magnetostatics solution domain ({doc}`index`, section 2). The
boundary-approximation error decays with distance $d$ from the body; in practice,
clearances of several to a dozen largest object dimensions are used, and
correctness is verified by convergence with respect to $d$:

$$
\mathbf{H} = -\nabla \phi,
$$

where $\mathbf{H}$ — magnetic field strength ($\mathrm{A\,m^{-1}}$), $\phi$ —
scalar potential ($\mathrm{A}$).

| Symbol | Meaning | SI unit |
|---|---|---|
| $\mathbf{H}$ | magnetic field strength | $\mathrm{A\,m^{-1}}$ |
| $\phi$ | scalar potential | $\mathrm{A}$ |
| $L_x, L_y, L_z$ | universe dimensions | $\mathrm{m}$ |

## 3. Example — complete Python script

```python
# %% Manual universe geometry
import fullmag as fm

nm = 1.0e-9

study = fm.study("airbox_geometry_example")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")

study.universe(mode="manual", size=(800 * nm, 400 * nm, 300 * nm))

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

`study.universe(**kwargs)` (`StudyBuilder.universe`, `world.py`):

| Parameter | Type | Default | Unit | Validation | Meaning |
|---|---|---|---|---|---|
| `mode` | `str` | required | $1$ | e.g. `"manual"` | universe definition mode |
| `size` | `Sequence[float]` | required in manual | $\mathrm{m}$ | three positive values | dimensions $(L_x, L_y, L_z)$ |
| `padding` / `center` / shape options | advanced resource policy | resource-specific | $\mathrm{m}$ / $1$ | resource validation | additional generation options (Control Room/API) |

Failure behavior: an invalid size vector → `ValueError`. Realized clearances and
shape are recorded in the build report.

ProblemIR mapping: universe policy in mesh workflow metadata; realization in the
report/provenance.

## 5. How to set it in Control Room

```
Model Explorer
└── Universe / Airbox      → selection kinds: airbox.*
```

Exterior geometry (size, padding, center) is editable in the universe geometry
panels; air sizing lives in **Airbox Mesh Parameters**
({doc}`../../../frontend/meshing/airbox-mesh`). Full panel overview:
{doc}`../../../frontend/meshing/index`.

## 6. Backend support

| Solver | Device | Status | Notes |
|---|---|---|---|
| FEM | CPU | implemented | manual universe + airbox mesh |
| FEM | GPU | capability-gated | identical content-addressed mesh |
| FDM | CPU/GPU | not applicable | FDM defines the domain through its grid |

## 7. Limitations and known pitfalls

- Changing universe geometry invalidates a built mesh (invalidation).
- Clearances are a physical decision: verify demag convergence with respect to
  airbox size instead of assuming one "good" size.

## 8. Scientific bibliography

1. J. D. Jackson, *Classical Electrodynamics*, 3rd ed., Wiley, 1999.

## 9. Source-code index

| Claim | Path | Symbol | Evidence |
|---|---|---|---|
| universe facade | `packages/fullmag-py/src/fullmag/world.py` | `StudyBuilder.universe` | method signature |
| airbox configuration | `packages/fullmag-py/src/fullmag/world.py` | `_configure_study_universe` | implementation |
