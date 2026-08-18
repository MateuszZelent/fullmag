---
title: Refinement
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/physics/fem-mesh-refinement.md
---

(public-docs-numerical-methods-meshing-refinement)=
# Mesh refinement

(numerical-methods-refinement-problem-statement)=
## Physical and numerical problem

Refinement controls local element size and grading: maximum/minimum element size, growth rate,
curvature factor, and narrow-region resolution. These are COMSOL-style size semantics that trade
accuracy against solve cost.

(numerical-methods-refinement-governing-equations)=
## Governing equations

Refinement does not change the physical equation; it changes the discrete subspace the equation
is projected onto.

(numerical-methods-refinement-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| $h_{\mathrm{min}},h_{\mathrm{max}}$ | element size bounds | $\mathrm{m}$ |
| $\rho_{\mathrm{growth}}$ | growth rate | $1$ |
| $c_{\mathrm{curv}}$ | curvature factor | $1$ |
| $d_{\mathrm{narrow}}$ | narrow-region resolution | $\mathrm{m}$ |

(numerical-methods-refinement-assumptions-and-validity)=
## Assumptions and validity

Size bounds must be positive and ordered; growth and curvature factors obey the mesh-policy
domain. Interface and swept refinement remain solver semantics.

(numerical-methods-refinement-python-api)=
## Python API

```python
# %% Refinement via universe and object size controls
import fullmag as fm

nm = 1.0e-9

study = fm.study("refinement_api_example")
study.engine("fem")
study.device("auto", precision="double")
study.mode("strict")

study.universe(mode="manual", size=(1200 * nm, 600 * nm, 550 * nm))
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
film.mesh.thin_film(minimum_element_size=3 * nm, maximum_element_size=3 * nm, layers=1, topology="prismatic")
study.exchange()
study.stages.add_relax(stage_id="relax", algorithm="projected_gradient_bb", max_steps=1000, tolT=1e-8)
```

(numerical-methods-refinement-problem-ir)=
## ProblemIR and provenance

Refinement targets lower into the mesh workflow and are reported in the build report with the
realized mesh summary.

(numerical-methods-refinement-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Invalid bounds and rates fail immediately; unsupported refinement combinations are reported by the
meshing backend.

(numerical-methods-refinement-discrete-realization)=
## Discrete realization

Local refinement, transition grading, and adaptive remeshing remain distinct workflows with
backend-specific realization.

(numerical-methods-refinement-implementation-mapping)=
## Implementation mapping

Anchors: `packages/fullmag-py/src/fullmag/meshing/_size_field_plan.py` and
`packages/fullmag-py/src/fullmag/meshing/mesh_controls.py`.

(numerical-methods-refinement-validation)=
## Validation

Convergence and deformed-mesh checks live in the FEM meshing validation family.

(numerical-methods-refinement-limitations)=
## Limitations

Refinement controls are authoring targets; realized conformity is validated at mesh build.

(numerical-methods-refinement-scientific-bibliography)=
## Scientific bibliography

Mesh-convergence references belong to the FEM standard-problem documentation.

(numerical-methods-refinement-source-code-index)=
## Source-code index

| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Size fields | `packages/fullmag-py/src/fullmag/meshing/_size_field_plan.py` | size-field plan | Refinement targets | Meshing tests |
