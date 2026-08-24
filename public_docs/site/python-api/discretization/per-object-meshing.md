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
Per-object meshing lets each magnetic object override the study-level mesh policy through the
public `body.mesh` facade, including thin-film and swept topologies. The resulting internal lowering
carrier is `PerObjectMeshRecipe`.

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
Non-`None` facade fields override global defaults. `body.mesh(...)` validates core sizes and
layered-topology consistency, while several advanced scalar knobs are stored for later mesher
validation. The internal `PerObjectMeshRecipe` dataclass validates layered/topology fields only and
is not a top-level `fullmag` export.

(python-api-discretization-per-object-meshing-python-api)=
<!-- (python-api)= -->
## Python API
| Python | Type | Default | Validation | Meaning | ProblemIR |
|---|---|---|---|---|---|
| `body.mesh.thin_film(minimum_element_size, maximum_element_size, layers, topology, ...)` | method | per object | Positive sizes, supported topology | Thin-film prism/swept mesh | object mesh recipe |
| internal recipe `maximum_element_size` / `minimum_element_size` | `float \| None` | `None` | Public facade requires positive values and `minimum <= maximum`; internal dataclass defers checks | Local element sizes | object recipe |
| internal recipe `boundary_layer_count/thickness/stretching` | knobs | `None` | Public facade requires count >= 1 and positive thickness/stretching; no upper bound of 2 is enforced | Boundary layer | object recipe |
| internal recipe `mesh_strategy` | `str \| None` | `None` | `auto`, `free_tetrahedral`, `thin_film_tetrahedral`, `swept_prism`, or `swept_hex`; `swept_hex` is representable for authoring but unsupported by the current body-only realization | Local topology | object recipe |

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
An explicit `swept_hex` recipe survives authoring, but mesh generation rejects it with
`ValueError` before starting Gmsh; it never silently realizes the request as a prism mesh.

(python-api-discretization-per-object-meshing-discrete-realization)=
<!-- (discrete-realization)= -->
## Discrete realization
The FEM backend realizes the documented thin-film and `swept_prism` recipes; the final conforming
solver mesh consumes those object recipes without collapsing universe/object/final layers.
`swept_hex` remains authoring-only and is unsupported by the current body-only mesh generator.

(python-api-discretization-per-object-meshing-implementation-mapping)=
<!-- (implementation-mapping)= -->
## Implementation mapping
Anchor: `packages/fullmag-py/src/fullmag/model/discretization.py`
(`PerObjectMeshRecipe`, `SweptMeshControls`) and the public `body.mesh` facade in
`packages/fullmag-py/src/fullmag/world.py`. Runtime dispatch and explicit hex rejection live in
`packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py`
(`generate_swept_mesh`).

(python-api-discretization-per-object-meshing-validation)=
<!-- (validation)= -->
## Validation
Ownership and meshing tests cover object-level overrides. The mixed-element meshing test
`test_explicit_swept_hex_never_silently_realizes_prism` proves the fail-closed `swept_hex`
boundary.

(python-api-discretization-per-object-meshing-limitations)=
<!-- (limitations)= -->
## Limitations
FDM realizes object grids per magnet; FEM requires a conforming final assembly. Direct
`fm.PerObjectMeshRecipe(...)` construction is unavailable because that internal carrier is not
exported from the top-level namespace. Although `swept_hex` can be authored in the internal recipe,
the current body-only FEM generator does not implement its realization.

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
| Swept realization boundary | `packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py` | `generate_swept_mesh` | Realizes supported swept-prism paths and rejects explicit `swept_hex` before Gmsh startup | `packages/fullmag-py/tests/test_mixed_element_meshing.py::test_explicit_swept_hex_never_silently_realizes_prism` |
