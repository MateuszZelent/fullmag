---
title: Airbox
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/physics/fem-mesh-airbox.md
---

(public-docs-numerical-methods-meshing-airbox)=
# Airbox meshing

(numerical-methods-airbox-problem-statement)=
## Physical and numerical problem

FEM demagnetization and exterior field problems require a bounded computational domain. The airbox
is the enclosing non-magnetic region whose boundary carries the chosen exterior boundary
condition. Its size and grading are numerical semantics, not viewport cosmetics.

(numerical-methods-airbox-governing-equations)=
## Governing equations

The airbox realizes the truncation of the magnetostatic exterior problem; the truncated-domain
equation and boundary treatment belong to
{doc}`../../physics/interactions/demagnetization/fem-poisson-airbox`.

(numerical-methods-airbox-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| $L_x,L_y,L_z$ | airbox extents | $\mathrm{m}$ |
| $V_{\mathrm{air}}$ | airbox volume | $\mathrm{m^3}$ |
| $h_{\mathrm{min}},h_{\mathrm{max}}$ | local element size bounds | $\mathrm{m}$ |
| $\rho_{\mathrm{growth}}$ | growth rate | $1$ |

(numerical-methods-airbox-assumptions-and-validity)=
## Assumptions and validity

Airbox grading must decay with distance from magnetic bodies. The airbox extent is always a full
interior bounds/volume overlay and must include interior-bounds semantics even when mesh edge
geometry exists; surface extent may render boundary surface edges only.

(numerical-methods-airbox-python-api)=
## Python API

```python
# %% Manual universe with an airbox
import fullmag as fm

nm = 1.0e-9

study = fm.study("airbox_api_example")
study.engine("fem")
study.device("auto", precision="double")
study.mode("strict")

study.universe(
    mode="manual",
    size=(1200 * nm, 600 * nm, 550 * nm),
    center=(0.0, 0.0, 0.0),
)
study.universe.mesh(
    minimum_element_size=10 * nm,
    maximum_element_size=110 * nm,
    maximum_element_growth_rate=1.9,
    grading="geometric",
)
film = study.geometry(fm.Box(500 * nm, 125 * nm, 3 * nm), name="film")
film.Ms = 8.0e5
film.Aex = 1.3e-11
film.alpha = 0.02
film.m = fm.init.UniformMagnetization((1.0, 0.1, 0.0))
study.demag(realization="poisson_robin")
study.exchange()
study.stages.add_relax(stage_id="relax", algorithm="projected_gradient_bb", max_steps=1000, tolT=1e-8)
```

(numerical-methods-airbox-problem-ir)=
## ProblemIR and provenance

The universe configuration lowers into the derived domain frame and mesh workflow provenance; the
realized airbox extent and grading are recorded in the mesh build report.

(numerical-methods-airbox-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Missing manual-universe size and invalid grading parameters fail immediately; backend policy
restrictions are reported by the planner.

(numerical-methods-airbox-discrete-realization)=
## Discrete realization

Native airbox meshing is realized by the meshing backend (Gmsh-based grading and extraction); the
container-backed native build is the authoritative execution route.

(numerical-methods-airbox-implementation-mapping)=
## Implementation mapping

Anchors: `packages/fullmag-py/src/fullmag/meshing/_gmsh_airbox.py` (`airbox` construction) and
`packages/fullmag-py/src/fullmag/meshing/_airbox_grading.py`.

(numerical-methods-airbox-validation)=
## Validation

Airbox grading and conformity are validated through meshing tests; deformation and convergence
checks belong to the FEM demagnetization validation family.

(numerical-methods-airbox-limitations)=
## Limitations

Airbox grading does not replace the boundary treatment; open, periodic, and Floquet exterior
policies remain separate contracts.

(numerical-methods-airbox-scientific-bibliography)=
## Scientific bibliography

Exterior truncation references belong to the FEM Poisson-airbox page.

(numerical-methods-airbox-source-code-index)=
## Source-code index

| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Airbox construction | `packages/fullmag-py/src/fullmag/meshing/_gmsh_airbox.py` | airbox construction | Airbox geometry | Meshing tests |
| Airbox grading | `packages/fullmag-py/src/fullmag/meshing/_airbox_grading.py` | grading policy | Decaying element size | Meshing tests |
