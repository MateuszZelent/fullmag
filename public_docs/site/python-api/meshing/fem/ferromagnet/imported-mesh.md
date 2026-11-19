---
title: Imported-Mesh API
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-meshing-fem-ferromagnet-imported-mesh)=
# Imported-Mesh API

(python-api-meshing-fem-ferromagnet-imported-mesh-symbols-and-si-units)=
## Symbols and SI units
All geometric lengths use $\mathrm{m}$; dimensionless selectors use $1$.

(python-api-meshing-fem-ferromagnet-imported-mesh-assumptions-and-validity)=
## Assumptions and validity
Authoring validation does not prove mesh generation or solver qualification; the realized report is authoritative.

(python-api-meshing-fem-ferromagnet-imported-mesh-problem-statement)=
## 1. What it is and when to use it

Importing a prebuilt FEM mesh instead of generating it with Gmsh. At study level:
`FEM(..., mesh="path-or-asset")`; at object level: the recipe `source` field.

When to use it:

- the mesh was produced in an external tool (COMSOL, Salome, a custom mesher),
- you want to repeat exactly the same mesh across runs,
- the geometry requires specialized meshing unavailable in Gmsh.

Impact on the simulation: import does not bypass validation — units, element
family/order, orientation, attributes, and backend compatibility are checked at
extraction; a defective mesh fails loudly instead of being silently used.

(python-api-meshing-fem-ferromagnet-imported-mesh-governing-equations)=
## 2. Physical and mathematical explanation

This page introduces no equation of its own; it supplies a ready discrete space.
Import validation checks, among others, metric consistency of element Jacobians:

$$
J_K = \det \frac{\partial \mathbf{x}}{\partial \boldsymbol{\xi}} > 0
\quad \text{for every element } K,
$$

where $\mathbf{x}$ — physical node coordinates ($\mathrm{m}$),
$\boldsymbol{\xi}$ — reference coordinates ($1$). A negative or degenerate $J_K$
disqualifies the element.

| Symbol | Meaning | SI unit |
|---|---|---|
| $J_K$ | Jacobian determinant of element $K$ | $1$ |
| $\mathbf{x}$ | physical node coordinates | $\mathrm{m}$ |
| $\boldsymbol{\xi}$ | reference coordinates | $1$ |

## 3. Example — complete Python script

```python
# %% Imported FEM mesh at study level
import fullmag as fm
from pathlib import Path

nm = 1.0e-9

study = fm.study("imported_mesh_example")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(order=1, maximum_element_size=5 * nm)

film = study.geometry(fm.Box(300 * nm, 100 * nm, 5 * nm), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.texture.uniform(1.0, 0.0, 0.0)

# Import only an existing, validated Gmsh/COMSOL domain mesh. The fallback keeps
# this public example executable when the optional artifact is not present.
mesh_path = Path("run_output/prebuilt_domain_mesh.msh")
if mesh_path.is_file():
    study.mesh.import_(mesh_path)
else:
    study.universe(mode="manual", size=(800 * nm, 400 * nm, 300 * nm))
    study.universe.mesh(maximum_element_size=100 * nm)

study.exchange()
study.demag(model="airbox", variant="robin")
if not mesh_path.is_file():
    study.build_domain_mesh()
study.stages.add_relax(stage_id="equilibrium", tolT=1.0e-6)
```

```python
# %% Object-level imported source (advanced recipe)
# film.mesh(source="assets/film_mesh.msh2")
```

(python-api-meshing-fem-ferromagnet-imported-mesh-python-api)=
## 4. Exact API

| Level | Parameter | Type | Default | Unit | Validation | Meaning |
|---|---|---|---|---|---|---|
| study | `FEM.mesh` | `str \| None` | `None` | $1$ | non-empty; revalidated at extraction | imported/prebuilt FEM mesh reference |
| object | `source` (recipe) | `str \| None` | `None` | $1$ | non-empty | import a single-object mesh |

Extraction-time validation covers: units, element family and order, orientation,
region attributes, boundaries, periodic metadata, and target-backend
compatibility.

Failure behavior: a missing/unreadable asset → extraction error; any failed check
→ validation error describing the mismatch. Import never shortcuts validation.

ProblemIR mapping: `backend_policy.discretization_hints.fem.mesh` (study level) /
the object-recipe `source` field.

(python-api-meshing-fem-ferromagnet-imported-mesh-problem-ir)=
## ProblemIR
The request lowers to the mesh-workflow or discretization subtree; requested intent remains distinct from the resolved mesh asset and provenance report.

(python-api-meshing-fem-ferromagnet-imported-mesh-round-trip-and-failure-semantics)=
## Round-trip and failure semantics
Requested intent is the Python policy; resolved execution is the realized mesh report. Validation errors identify the violated domain rule, and unsupported combinations fail explicitly without silent fallback.

(python-api-meshing-fem-ferromagnet-imported-mesh-discrete-realization)=
## Discrete realization
The backend consumes the realized Cartesian or finite-element asset, including topology, markers, quality, and provenance where available.

## 5. How to set it in Control Room

```
Model Explorer
└── Objects
    └── <object>
        └── Mesh            → selection kind: object.mesh
```

The **Object Mesh Policy** inspector: the *Element Size Parameters* group holds
the `source` field (path/asset reference). An imported mesh is read-only with
respect to generation parameters; quality and history inspection remain available
(*Quality / History tabs*). Full panel description:
{doc}`../../../../frontend/meshing/object-mesh`.

(python-api-meshing-fem-ferromagnet-imported-mesh-implementation-mapping)=
## 6. Backend support

| Solver | Device | Status | Notes |
|---|---|---|---|
| FEM | CPU | partial | import/extraction path into host/MFEM structures |
| FEM | GPU | capability-gated | identical content-addressed mesh |
| FDM | CPU/GPU | not applicable | FDM does not consume unstructured meshes |

(python-api-meshing-fem-ferromagnet-imported-mesh-validation)=
## Validation
Focused constructor, lowering, and mesh-report tests are the evidence boundary for this page.

(python-api-meshing-fem-ferromagnet-imported-mesh-limitations)=
## 7. Limitations and known pitfalls

- Import does not waive shared-domain rules: the mesh must cover the universe and
  objects according to the build policy.
- Changing geometry after importing invalidates the match; the authoring
  fingerprint detects the drift.

(python-api-meshing-fem-ferromagnet-imported-mesh-scientific-bibliography)=
## 8. Scientific bibliography

1. C. Geuzaine and J.-F. Remacle, “Gmsh,” *Int. J. Numer. Methods Eng.* **79**, 1309–1331 (2009).

(python-api-meshing-fem-ferromagnet-imported-mesh-source-code-index)=
## 9. Source-code index

| Claim | Path | Symbol | Evidence |
|---|---|---|---|
| study level (`mesh=`) | [`packages/fullmag-py/src/fullmag/model/discretization.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/discretization.py#L476) | [`class FEM`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/discretization.py#L476) | signature and IR tests |
| object level (`source`) | `packages/fullmag-py/src/fullmag/world.py` | `GeometryMeshHandle.configure` | field signature |
| mesh artifact persistence | `packages/fullmag-py/src/fullmag/world.py` | `StudyMeshHandle.save/load/save_or_load` | facade implementation |
