---
title: Per-Object Meshing
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-discretization-per-object-meshing)=
# Per-Object Meshing

(python-api-discretization-per-object-meshing-problem-statement)=
<!-- (problem-statement)= -->
## Contract
Per-object meshing lets each magnetic object override the study-level mesh policy with its own
recipe, including thin-film and swept topologies.

(python-api-discretization-per-object-meshing-governing-equations)=
<!-- (governing-equations)= -->
## Governing equations
No physical equation is introduced; per-object recipes are discretization policy.

(python-api-discretization-per-object-meshing-symbols-and-si-units)=
<!-- (symbols-and-si-units)= -->
## Symbols and SI units
Element sizes and boundary-layer thickness are in metres; counts and ratios are dimensionless.

(python-api-discretization-per-object-meshing-assumptions-and-validity)=
<!-- (assumptions-and-validity)= -->
## Assumptions and validity
Non-`None` fields override the global defaults; positive sizes and valid topology selectors are
validated.

(python-api-discretization-per-object-meshing-python-api)=
<!-- (python-api)= -->
## Python API
| Python | Type | Default | Validation | Meaning | ProblemIR |
|---|---|---|---|---|---|
| `body.mesh.thin_film(minimum_element_size, maximum_element_size, layers, topology, ...)` | method | per object | Positive sizes, supported topology | Thin-film prism/swept mesh | object mesh recipe |
| `PerObjectMeshRecipe.maximum_element_size` / `minimum_element_size` | `float \| None` | `None` | Positive | Local element sizes | object recipe |
| `PerObjectMeshRecipe.boundary_layer_count/thickness/stretching` | knobs | `None` | Positive counts/thickness, ratio 1–2 | Boundary layer | object recipe |
| `PerObjectMeshRecipe.mesh_strategy` | `str \| None` | `None` | `auto`, `free_tetrahedral`, `swept_prism`, `swept_hex` | Local topology | object recipe |

### Complete stage-first example

```python
# %% Per-object thin-film mesh
import fullmag as fm

nm = 1.0e-9

study = fm.study("per_object_meshing_api_example")
study.engine("fem")
study.device("auto", precision="double")
study.mode("strict")

study.universe(mode="manual", size=(1200 * nm, 600 * nm, 550 * nm))
film = study.geometry(fm.Box(500 * nm, 125 * nm, 3 * nm), name="film")
film.Ms = 8.0e5
film.Aex = 1.3e-11
film.alpha = 0.02
film.m = fm.init.UniformMagnetization((1.0, 0.1, 0.0))
film.mesh.thin_film(
    minimum_element_size=3 * nm,
    maximum_element_size=3 * nm,
    layers=1,
    topology="prismatic",
    exact_layers=True,
    order=1,
)
study.exchange()
study.stages.add_relax(stage_id="relax", algorithm="projected_gradient_bb", max_steps=1000, tolT=1e-8)
```

(python-api-discretization-per-object-meshing-problem-ir)=
<!-- (problem-ir)= -->
## ProblemIR
Per-object recipes lower into object-region mesh specs and the derived mesh workflow metadata.

(python-api-discretization-per-object-meshing-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
## Round-trip and failure semantics
Invalid topology selectors and sizes fail immediately; final conformity is validated at mesh build.

(python-api-discretization-per-object-meshing-discrete-realization)=
<!-- (discrete-realization)= -->
## Discrete realization
The FEM backend realizes thin-film and swept recipe; final conforming solver mesh consumes object
recipes without collapsing universe/object/final layers.

(python-api-discretization-per-object-meshing-implementation-mapping)=
<!-- (implementation-mapping)= -->
## Implementation mapping
Anchor: `packages/fullmag-py/src/fullmag/model/discretization.py`
(`PerObjectMeshRecipe`, `SweptMeshControls`) and the `body.mesh` facade in
`packages/fullmag-py/src/fullmag/world.py`.

(python-api-discretization-per-object-meshing-validation)=
<!-- (validation)= -->
## Validation
Ownership and meshing tests cover object-level overrides.

(python-api-discretization-per-object-meshing-limitations)=
<!-- (limitations)= -->
## Limitations
FDM realizes object grids per-magnet; FEM requires a conforming final assembly.

(python-api-discretization-per-object-meshing-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
## Scientific bibliography
No physical model is introduced.

(python-api-discretization-per-object-meshing-source-code-index)=
<!-- (source-code-index)= -->
## Source-code index
| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Object recipes | `packages/fullmag-py/src/fullmag/model/discretization.py` | `PerObjectMeshRecipe` | Object-level meshing | Ownership and meshing tests |
