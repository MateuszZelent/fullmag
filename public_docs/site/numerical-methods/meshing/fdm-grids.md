---
title: FDM Grids
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-numerical-methods-meshing-fdm-grids)=
# FDM Cartesian grids

(numerical-methods-fdm-grids-problem-statement)=
## Physical and numerical problem

FDM represents magnetization on a Cartesian tensor grid. Cell size, origin, active-cell mask and
per-magnet grid policy determine the discrete geometry and every finite-difference interaction.
Changing a cell size is therefore a change to the numerical problem, not merely resolution metadata.

(numerical-methods-fdm-grids-governing-equations)=
## Governing equations

For cell indices $(i,j,k)$ and spacings $(h_x,h_y,h_z)$, the cell centre is

```{math}
:label: eq-numerical-fdm-grid-centre
\mathbf x_{ijk}=\mathbf x_0+((i+\tfrac12)h_x,(j+\tfrac12)h_y,(k+\tfrac12)h_z).
```

The cell volume is

```{math}
:label: eq-numerical-fdm-grid-volume
V_{\mathrm{cell}}=h_xh_yh_z,
\qquad
N=N_xN_yN_z.
```

(numerical-methods-fdm-grids-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| $\mathbf x_{ijk}$ | cell centre | $\mathrm{m}$ |
| $\mathbf x_0$ | grid origin | $\mathrm{m}$ |
| $h_x,h_y,h_z$ | cell spacings | $\mathrm{m}$ |
| $V_{\mathrm{cell}}$ | cell volume | $\mathrm{m^3}$ |
| $N_x,N_y,N_z$ | cell counts | $1$ |
| $N$ | total cell count | $1$ |

(numerical-methods-fdm-grids-assumptions-and-validity)=
## Assumptions and validity

All spacings and counts must be positive and ordered consistently with the field memory layout.
Nonuniform or masked geometry requires explicit metadata. A thin-film grid with one cell in $z$
does not represent a resolved through-thickness FEM field.

(numerical-methods-fdm-grids-python-api)=
## Python API

```python
# %% Stage-first FDM grid declaration
import fullmag as fm

nm = 1.0e-9
study = fm.study("fdm_grid")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 5 * nm))
film = study.geometry(fm.Box(size=(100 * nm, 20 * nm, 5 * nm), name="film"), name="film")
film.Ms = 8.0e5
film.Aex = 1.3e-11
film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
study.stages.add_relax(stage_id="relax", algorithm="nonlinear_cg", tolT=1.0e-6, max_steps=100)
```

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `FDM.default_cell` | `tuple[float,float,float]` | required | $\mathrm{m}$ | three finite positive values | Cartesian spacing | FDM CPU/GPU | `discretization.fdm.default_cell` |
| `FDMGrid.cell` | `tuple[float,float,float]` | required | $\mathrm{m}$ | three finite positive values | per-grid spacing | FDM CPU/GPU | `discretization.fdm.per_magnet` |

(numerical-methods-fdm-grids-problem-ir)=
## ProblemIR and provenance

Record cell spacing, origin, counts, active mask and per-magnet grid ownership. Requested FDM intent
and resolved execution preserve device and precision separately.

(numerical-methods-fdm-grids-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Validation errors include nonpositive spacing, invalid dimensions and incompatible per-magnet grids.
Unsupported combinations are explicit; no silent resampling is performed by grid declaration.
Requested intent and resolved execution are distinct.

(numerical-methods-fdm-grids-discrete-realization)=
## Discrete realization by lane

| Solver | Device | Status | Realization |
|---|---|---|---|
| FDM | CPU | source-backed | Cartesian cell-centered grid |
| FDM | GPU | source-backed | same semantic grid with device storage |
| FEM | CPU | not applicable | use FEM mesh pages |
| FEM | GPU | not applicable | use FEM mesh pages |

(numerical-methods-fdm-grids-implementation-mapping)=
## Implementation mapping

| Claim | Repository path | Stable symbol | Responsibility | Lane |
|---|---|---|---|---|
| FDM grid model | `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FDMGrid` | grid spacing and IR | Python/IR |

(numerical-methods-fdm-grids-validation)=
## Validation

Check affine coordinate reconstruction, cell volume, field layout, active-mask bounds and CPU/GPU
grid identity before comparing physics.

(numerical-methods-fdm-grids-limitations)=
## Limitations

Cartesian FDM grids stair-step geometry and cannot reproduce arbitrary curved FEM boundaries exactly.

(numerical-methods-fdm-grids-scientific-bibliography)=
## Scientific bibliography

- A. J. Newell et al., *Geophysical Journal International* 124 (1993), rectangular-cell demag.

(numerical-methods-fdm-grids-source-code-index)=
## Source-code index

| Claim | Repository path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| FDM grid contract | `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FDMGrid` | spacing and serialization | Python source |
