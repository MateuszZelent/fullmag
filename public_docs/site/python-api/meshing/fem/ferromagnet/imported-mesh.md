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
Authoring validation does not prove mesh generation or solver qualification; the realized report is authoritative. Per-object imported mesh sources (`PerObjectMeshRecipe(source=...)` / `film.mesh(source=...)`) are unavailable and fail closed; only study-level shared-domain import routes are supported.

(python-api-meshing-fem-ferromagnet-imported-mesh-problem-statement)=
## 1. What it is and when to use it

Importing a prebuilt FEM mesh lets a study consume an externally constructed conforming
shared-domain mesh instead of generating one from scratch with Gmsh. Supported study-level import
routes are:

- `FEM(..., mesh="path-or-asset")` (low-level study discretization hint);
- `study.mesh.import_(path, *, region_map=None, boundary_map=None, region_entity_map=None, boundary_entity_map=None, coordinate_unit=None)` (imports and binds a Gmsh `.msh` or COMSOL `.mphtxt` shared-domain mesh);
- `study.domain_mesh(source, *, region_markers, object_region_markers=None, marker_owners=None)` / `fm.domain_mesh(...)` (attaches a precomputed shared-domain `.json` MeshIR asset);
- `study.frozen_magnetic_submesh(source, *, region_markers, air_mesh_source=None)` / `fm.frozen_magnetic_submesh(...)` (reuses a frozen magnetic submesh while building the exterior airbox).

:::{admonition} Per-object `source=...` is unavailable (fail-closed)
:class: warning

`PerObjectMeshRecipe(source=...)` raises
`ValueError("per-object mesh source is unavailable; use FEM(mesh=...) for the supported study-level imported mesh route")`
immediately during construction (`packages/fullmag-py/src/fullmag/model/discretization.py`).
Per-object `film.mesh(source=...)` is likewise not a supported single-object import route in the
shared-domain pipeline. Always import a conforming shared-domain mesh at the study level via
`FEM(mesh=...)`, `study.mesh.import_(...)`, or `study.domain_mesh(...)`.
:::

When to use study-level mesh import:

- the shared-domain mesh (ferromagnets + airbox) was produced in an external tool (COMSOL, Gmsh, Salome, or a custom mesher),
- you want to repeat the exact same content-addressed mesh across CPU and GPU runs,
- the geometry requires specialized conforming meshing external to the built-in Gmsh generator.

Impact on the simulation: import does not bypass validation — units, element
family/order, orientation, attributes, region markers, and backend compatibility are checked at
extraction; a defective mesh fails loudly instead of being silently used. For GPU solver execution
on imported meshes see {ref}`numerical-methods-performance-fem-gpu-demag`.

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
# %% Study-level shared-domain FEM mesh import (with fallback build)
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

# Import an existing, validated Gmsh (.msh) or COMSOL (.mphtxt) shared-domain mesh.
# The else branch keeps this public example executable when the optional file is absent.
mesh_path = Path("run_output/prebuilt_domain_mesh.msh")
if mesh_path.is_file():
    study.mesh.import_(
        mesh_path,
        region_map={"film": 1, "air": 2},
        coordinate_unit="m",
    )
else:
    study.universe(mode="manual", size=(800 * nm, 400 * nm, 300 * nm))
    study.universe.mesh(maximum_element_size=100 * nm)

study.exchange()
study.demag(model="airbox", variant="robin")
if not mesh_path.is_file():
    study.build_domain_mesh()
study.stages.add_relax(stage_id="equilibrium", algorithm="projected_gradient_bb", tolT=1.0e-6)
```

(python-api-meshing-fem-ferromagnet-imported-mesh-python-api)=
## 4. Exact API

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `FEM.mesh` | `str \| None` | `None` | $1$ | nonempty when present; revalidated at extraction | study-level imported/prebuilt shared-domain FEM mesh reference | FEM CPU/GPU | `backend_policy.discretization_hints.fem.mesh` |
| `fullmag.world.StudyMeshHandle.import_` | `(path: str \| Path, *, region_map=None, boundary_map=None, region_entity_map=None, boundary_entity_map=None, coordinate_unit=None) -> MeshPersistenceResult` | optional maps | $1$ | validates Gmsh `.msh` or COMSOL `.mphtxt`, units, and semantic marker maps (`region_entity_map`/`boundary_entity_map` are COMSOL-only) | imports and binds an external shared-domain mesh (`study.mesh.import_(...)`) | FEM CPU/GPU | `backend_policy.discretization_hints.fem.mesh` |
| `domain_mesh` | `(source: str \| Path, *, region_markers, object_region_markers=None, marker_owners=None) -> None` | `None` | $1$ | nonempty `.json` MeshIR path and non-colliding marker tables (`fm.domain_mesh` / `study.domain_mesh`) | attaches a precomputed shared-domain MeshIR asset | FEM CPU/GPU | `mesh_workflow.shared_domain_mesh_source` |
| `frozen_magnetic_submesh` | `(source: str \| Path, *, region_markers, air_mesh_source=None) -> None` | `air_mesh_source=None` | $1$ | nonempty path and valid magnetic region markers (`fm.frozen_magnetic_submesh` / `study.frozen_magnetic_submesh`) | freezes a magnetic submesh while building the surrounding airbox | FEM CPU/GPU | `mesh_workflow.frozen_magnetic_submesh` |
| `fullmag.model.discretization.PerObjectMeshRecipe.source` | `str \| None` | `None` | $1$ | any non-`None` value raises `ValueError` | reserved per-object source field; unavailable (use study-level `FEM(mesh=...)` or `study.mesh.import_(...)`) | Unavailable (fail-closed) | `none` |

Extraction-time validation covers: units, element family and order, orientation,
region attributes, boundaries, periodic metadata, and target-backend
compatibility.

Failure behavior: a missing/unreadable asset → extraction error; any failed check
→ validation error describing the mismatch; passing a non-`None` `source` to
`PerObjectMeshRecipe` → `ValueError("per-object mesh source is unavailable; use FEM(mesh=...) ...")`.
Import never shortcuts validation.

ProblemIR mapping: `backend_policy.discretization_hints.fem.mesh` (study level) and
`mesh_workflow.shared_domain_mesh_source` / `mesh_workflow.frozen_magnetic_submesh`.

(python-api-meshing-fem-ferromagnet-imported-mesh-problem-ir)=
## ProblemIR
The request lowers to `backend_policy.discretization_hints.fem.mesh` or the shared-domain mesh-workflow fields; requested intent remains distinct from the resolved mesh asset and provenance report.

(python-api-meshing-fem-ferromagnet-imported-mesh-round-trip-and-failure-semantics)=
## Round-trip and failure semantics
Requested intent is the Python policy; resolved execution is the realized mesh report. Validation errors identify the violated domain rule, and unsupported combinations (including per-object `source=...`) fail explicitly without silent fallback.

(python-api-meshing-fem-ferromagnet-imported-mesh-discrete-realization)=
## Discrete realization
The backend consumes the validated shared-domain finite-element asset, including topology, markers, quality, and provenance where available.

## 5. How to set it in Control Room

Study-level mesh import (`FEM(mesh=...)`, `study.mesh.import_(...)`, `study.domain_mesh(...)`) is
authored in Python or study-level advanced configuration. In Control Room,
`apps/control-room/src/modules/inspector/panels/mesh-details/ObjectMeshSpecPanel.tsx`
(`ObjectMeshInspectorSpecPanel`) and `apps/control-room/src/modules/inspector/inspectors/mesh/MeshQualitySpec.tsx`
provide read-only quality and build-history inspection for the realized shared-domain mesh. Per-object
`source` import is not supported. Full panel description:
{doc}`../../../../frontend/meshing/object-mesh`.

(python-api-meshing-fem-ferromagnet-imported-mesh-implementation-mapping)=
## 6. Backend support

| Solver | Device | Status | Notes |
|---|---|---|---|
| FEM | CPU | partial | study-level import/extraction path into host/MFEM structures; per-object `source` unavailable |
| FEM | GPU | capability-gated | identical content-addressed shared-domain mesh |
| FDM | CPU/GPU | not applicable | FDM does not consume unstructured meshes |

(python-api-meshing-fem-ferromagnet-imported-mesh-validation)=
## Validation
Focused constructor, lowering, persistence, and mesh-report tests are the evidence boundary for this page.

(python-api-meshing-fem-ferromagnet-imported-mesh-limitations)=
## 7. Limitations and known pitfalls

- Per-object `PerObjectMeshRecipe(source=...)` and `film.mesh(source=...)` are unavailable and fail closed; always use study-level `FEM(mesh=...)`, `study.mesh.import_(...)`, or `study.domain_mesh(...)`.
- Import does not waive shared-domain rules: the mesh must cover the universe and
  objects with consistent semantic markers according to the build policy.
- Changing geometry after importing invalidates the match; the authoring
  fingerprint detects the drift.

(python-api-meshing-fem-ferromagnet-imported-mesh-scientific-bibliography)=
## 8. Scientific bibliography

1. C. Geuzaine and J.-F. Remacle, “Gmsh,” *Int. J. Numer. Methods Eng.* **79**, 1309–1331 (2009).

(python-api-meshing-fem-ferromagnet-imported-mesh-source-code-index)=
## 9. Source-code index

| Claim | Path | Symbol | Evidence |
|---|---|---|---|
| study level (`mesh=`) | [`packages/fullmag-py/src/fullmag/model/discretization.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/discretization.py#L484) | [`class FEM`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/discretization.py#L484) | signature and IR tests |
| per-object `source` fail-closed guard | [`packages/fullmag-py/src/fullmag/model/discretization.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/discretization.py#L694) | [`class PerObjectMeshRecipe`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/discretization.py#L694) | `__post_init__` raises `ValueError` |
| mesh artifact import and persistence | [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L5850) | [`class StudyMeshHandle`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L5850) (`import_`, `export`, `save`, `load`, `save_or_load`) | persistence and interchange tests |
| explicit domain mesh and frozen submesh | [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L8192) | [`domain_mesh`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L8192), [`frozen_magnetic_submesh`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L8257) | domain mesh attachment tests |
