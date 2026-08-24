---
title: Mesh Controls
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-discretization-mesh-controls)=
# Mesh Controls

(python-api-discretization-mesh-controls-problem-statement)=
<!-- (problem-statement)= -->
## Contract
Mesh controls express FDM cell sizes and FEM element size, order, and meshing policy as
authoring hints.

(python-api-discretization-mesh-controls-governing-equations)=
<!-- (governing-equations)= -->
## Governing equations
No physical equation is introduced; mesh controls are discretization semantics.

(python-api-discretization-mesh-controls-symbols-and-si-units)=
<!-- (symbols-and-si-units)= -->
## Symbols and SI units
Cell and element sizes are in metres; growth rate, curvature factor, and order are dimensionless.

(python-api-discretization-mesh-controls-assumptions-and-validity)=
<!-- (assumptions-and-validity)= -->
## Assumptions and validity
The public mesh facades validate positive sizes, `minimum <= maximum`, and positive growth rates up
to 2.5. Low-level validation is class-specific: `MeshSizeControls` itself performs no constructor
validation, and `FEM.order` currently checks only comparison with one rather than integer type.

(python-api-discretization-mesh-controls-python-api)=
<!-- (python-api)= -->
## Python API
| Python | Type | Default | Validation | Meaning | ProblemIR |
|---|---|---|---|---|---|
| `FDM.default_cell` | `tuple[float,float,float] \| None` | `None` | Three finite positive components; `cell` is its legacy alias | Uniform FDM cell | `cell` / `default_cell` |
| `FDM.per_magnet` | `dict[str, FDMGrid] \| None` | `None` | Non-empty name keys | Per-magnet grids | `per_magnet` |
| `FDM.boundary_correction` | `str \| None` | `None` | `none`, `volume`, or `full` | Boundary correction | `boundary_correction` |
| `body.mesh(order=...)` / `FEM.order` | `int \| None` / `int` | inherited / required | Facade stores the value; low-level `FEM` requires comparison `>= 1` but does not reject Boolean or fractional numerics | Element order | `order` |
| `FEM.maximum_element_size` | `float \| None` | `hmax` alias | Positive | Maximum element size | `hmax` |
| internal `MeshSizeControls.*` | size knobs | `None` | No constructor validation; not exported as `fm.MeshSizeControls` | Lowering carrier for COMSOL-style size semantics | size controls |

### Complete stage-first example

```python
# %% FDM cell and FEM element sizing
import fullmag as fm

nm = 1.0e-9

study = fm.study("mesh_controls_api_example")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")

study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 5 * nm))
film = study.geometry(fm.Box(100 * nm, 20 * nm, 5 * nm), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
study.exchange()
study.stages.add_run(stage_id="run", until=1.0e-12)
```

(python-api-discretization-mesh-controls-problem-ir)=
<!-- (problem-ir)= -->
## ProblemIR
FDM and FEM hints lower into `backend_policy.discretization_hints` and later the derived mesh
workflow/provenance.

(python-api-discretization-mesh-controls-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
## Round-trip and failure semantics
The public facades reject invalid sizes and boundary-correction names immediately. Some low-level
carriers defer type/legality checks to lowering or mesh realization as described above.

(python-api-discretization-mesh-controls-discrete-realization)=
<!-- (discrete-realization)= -->
## Discrete realization
FDM grids and FEM meshes are realized by their backend meshing paths; see
{doc}`../../numerical-methods/meshing/index`.

(python-api-discretization-mesh-controls-implementation-mapping)=
<!-- (implementation-mapping)= -->
## Implementation mapping
Anchor: `packages/fullmag-py/src/fullmag/model/discretization.py` (`FDM`, `FEM`,
`MeshSizeControls`).

(python-api-discretization-mesh-controls-validation)=
<!-- (validation)= -->
## Validation
Ownership tests compare this inventory with live signatures.

(python-api-discretization-mesh-controls-limitations)=
<!-- (limitations)= -->
## Limitations
Hints do not guarantee a realized mesh; the build report and conformity checks are authoritative.

(python-api-discretization-mesh-controls-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
## Scientific bibliography
No physical model is introduced.

(python-api-discretization-mesh-controls-source-code-index)=
<!-- (source-code-index)= -->
## Source-code index
| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Discretization hints | `packages/fullmag-py/src/fullmag/model/discretization.py` | `FDM`, `FEM`, `MeshSizeControls` | Mesh control lowering | Ownership test |
