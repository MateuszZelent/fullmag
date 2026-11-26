---
title: Airbox Build API
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-meshing-fem-airbox-build)=
# Airbox Build API

(python-api-meshing-fem-airbox-build-symbols-and-si-units)=
## Symbols and SI units
All geometric lengths use $\mathrm{m}$; dimensionless selectors use $1$.

(python-api-meshing-fem-airbox-build-assumptions-and-validity)=
## Assumptions and validity
Authoring validation does not prove mesh generation or solver qualification; the realized report is authoritative.

(python-api-meshing-fem-airbox-build-problem-statement)=
## 1. What it is and when to use it

`study.build_domain_mesh()` explicitly materializes the shared domain mesh
(universe + objects + regions) **before** the stage graph executes.

When to use it:

- you want to validate the mesh and its quality before paying for a simulation,
- the script saves/loads a mesh artifact (`study.mesh.save/load`),
- you control invalidation points after geometry/policy edits.

Impact on the simulation: building is not a scientific certificate — success means
a mesh was generated; qualification comes from inspecting the report and quality.

(python-api-meshing-fem-airbox-build-governing-equations)=
## 2. Physical and mathematical explanation

No equation of its own; the operation creates the discrete space shared by all
operators. The key invariants are mesh conformity at object/air interfaces and
correct region markers. Element quality is assessed through statistics (e.g.
SICN/Jacobian measures) recorded in the report.

| Concept | Meaning | SI unit |
|---|---|---|
| conformity | no gaps/overlaps between regions | $1$ |
| region markers | region identifiers inside the mesh | $1$ |
| quality statistics | element quality measure distributions | $1$ |

## 3. Example — complete Python script

```python
# %% Explicit mesh build before stages
import fullmag as fm

nm = 1.0e-9

study = fm.study("airbox_build_example")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")

study.universe(mode="manual", size=(800 * nm, 400 * nm, 300 * nm))
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
film.mesh(minimum_element_size=2.5 * nm, maximum_element_size=5 * nm,
          compute_quality=True)

study.exchange()
study.demag(model="airbox", variant="robin")

# Materialize the shared-domain mesh now (not lazily at first stage):
study.build_domain_mesh()

# Optional persistence of the realized mesh:
# study.mesh.save("run_output/domain_mesh.fmsh")

study.stages.add_relax(stage_id="equilibrium", algorithm="projected_gradient_bb", tolT=1.0e-6)
```

(python-api-meshing-fem-airbox-build-python-api)=
## 4. Exact API

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `StudyBuilder.build_domain_mesh` | `() -> StudyBuilder` | n/a | $1$ | validates authored policies before Gmsh generation | materializes the shared domain mesh (`study.build_domain_mesh()`) | FEM CPU/GPU; FDM not applicable to this mesh policy | `mesh_workflow.build` |
| `StudyBuilder.build_mesh` | `() -> StudyBuilder` | n/a | $1$ | delegates to `build_domain_mesh()` | legacy mesh build entry point (`study.build_mesh()`) | FEM CPU/GPU; FDM not applicable to this mesh policy | `mesh_workflow.build` |
| `fullmag.world.StudyMeshHandle.save` | `(path: str \| Path) -> Path` | required | $1$ | requires realized shared-domain FEM mesh | save the mesh artifact (`study.mesh.save(path)`) | FEM CPU/GPU; FDM not applicable to this mesh policy | `mesh_workflow.build` |
| `fullmag.world.StudyMeshHandle.load` | `(path: str \| Path, *, expected_sha256: str \| None = None, build_requested: bool \| None = None) -> MeshPersistenceResult` | `None` | $1$ | validates authoring fingerprint and optional SHA-256 digest | load a persisted mesh artifact (`study.mesh.load(path)`) | FEM CPU/GPU; FDM not applicable to this mesh policy | `mesh_workflow.build` |
| `fullmag.world.StudyMeshHandle.save_or_load` | `(path: str \| Path) -> MeshPersistenceResult` | required | $1$ | reloads when authoring matches, otherwise rebuilds and saves | cache-or-build shared-domain mesh (`study.mesh.save_or_load(path)`) | FEM CPU/GPU; FDM not applicable to this mesh policy | `mesh_workflow.build` |
| `fullmag.world.StudyMeshHandle.export` | `(path: str \| Path, *, format: str = "auto") -> Path` | `format="auto"` | $1$ | `format` must be `"auto"`, `"comsol"`, or `"gmsh"` | exports realized mesh to Gmsh `.msh` or COMSOL `.mphtxt` (`study.mesh.export(path)`) | FEM CPU/GPU; FDM not applicable to this mesh policy | `mesh_workflow.build` |
| `fullmag.world.StudyMeshHandle.import_` | `(path: str \| Path, *, region_map=None, boundary_map=None, region_entity_map=None, boundary_entity_map=None, coordinate_unit=None) -> MeshPersistenceResult` | optional maps | $1$ | validates Gmsh/COMSOL format, coordinate unit, and marker maps | imports and binds an external shared-domain mesh (`study.mesh.import_(path, ...)`) | FEM CPU/GPU; FDM not applicable to this mesh policy | `backend_policy.discretization_hints.fem.mesh` |
| `fullmag.world.StudyAirboxHandle.load` | `(path: str \| Path, *, quantity: object, format: str = "auto", dataset: str \| None = None, sample: int = -1, mode: str = "attach") -> FieldState` | `mode="attach"` | $1$ | `mode` must be `"attach"` or `"auto"`; quantity must match file payload | loads and attaches an airbox field state (`study.airbox.load(...)`) | FEM CPU/GPU airbox field I/O | `runtime_metadata.loaded_field_states` |
| `fullmag.world.StudyAirboxHandle.save` | `(path: str \| Path, *, quantity: object, format: str = "auto", dataset: str \| None = None, units: str \| None = None) -> Path` | `format="auto"` | $1$ | requires a previously loaded explicit `FieldState` for `quantity` | saves an attached airbox field state to disk (`study.airbox.save(...)`) | FEM CPU/GPU airbox field I/O | `runtime_metadata.loaded_field_states` |

Failure behavior / invalidation:

- geometry, object/region policy, or universe changes invalidate the realization,
- `study.mesh(...)` raises a migration error pointing to `study.objects.mesh.defaults(...)` or `body.mesh(...)`,
- `study.airbox(...)` raises `ValueError` pointing to `study.universe(...)` or `study.universe.mesh(...)` (only `study.airbox.visualization`, `study.airbox.load`, and `study.airbox.save` are live on `StudyAirboxHandle`),
- topology/authoring fingerprint mismatch on `load` →
  `MeshConfigurationMismatch` with a difference list.

For FEM GPU demagnetization solver performance on built airbox meshes, see
{ref}`numerical-methods-performance-fem-gpu-demag`.

ProblemIR mapping: realization and the build report land in provenance; requested
intent stays separate from resolved execution.

(python-api-meshing-fem-airbox-build-problem-ir)=
## ProblemIR
The request lowers to the mesh-workflow or discretization subtree; requested intent remains distinct from the resolved mesh asset and provenance report.

(python-api-meshing-fem-airbox-build-round-trip-and-failure-semantics)=
## Round-trip and failure semantics
Requested intent is the Python policy; resolved execution is the realized mesh report. Validation errors identify the violated domain rule, and unsupported combinations fail explicitly without silent fallback.

(python-api-meshing-fem-airbox-build-discrete-realization)=
## Discrete realization
The backend consumes the realized Cartesian or finite-element asset, including topology, markers, quality, and provenance where available.

## 5. How to set it in Control Room

```
Model Explorer
└── Universe / Airbox      → selection kinds: airbox.*
    └── Mesh Build          → selection kind: airbox.mesh.build
```

The **Airbox Mesh Build** inspector (`apps/control-room/src/modules/inspector/inspectors/universe/AirboxMeshBuildSpec.tsx`, `AirboxMeshBuildInspectorSpecPanel`) and **Airbox Mesh Parameters** (`apps/control-room/src/modules/inspector/inspectors/universe/AirboxMeshSizingSpecs.tsx`, `AirboxMeshParametersInspectorSpecPanel`, via **Apply & Build Shared-Domain Mesh** / `mesh.build-shared-domain`) run the shared-domain build; the Quality/History tabs (`MeshQualityStatisticsView`) show the realized report. In the object panel (`apps/control-room/src/modules/inspector/panels/mesh-details/ObjectMeshSpecPanel.tsx`), **Build Mesh** executes `mesh.build-selected`. Full build lifecycle description: {doc}`../../../../frontend/meshing/index`; reports and quality: {doc}`../../../../frontend/meshing/quality-and-reports`.

```{image} /_static/images/ui/viewport-3d-fem-mesh-airbox.png
:alt: 3D Viewport showing realized shared-domain FEM tetrahedral mesh and exterior airbox
:width: 92%
```

```{image} /_static/images/ui/explorer-jobs-and-diagnostics-tabs.png
:alt: Explorer Jobs and Diagnostics tabs monitoring shared-domain mesh build progress and status
:width: 92%
```

(python-api-meshing-fem-airbox-build-implementation-mapping)=
## 6. Backend support

| Solver | Device | Status | Notes |
|---|---|---|---|
| FEM | CPU | implemented | Gmsh/import → host/MFEM structures |
| FEM | GPU | capability-gated | identical content-addressed mesh |
| FDM | CPU/GPU | not applicable | the FDM grid is built without an explicit build step |

(python-api-meshing-fem-airbox-build-validation)=
## Validation
Focused constructor, lowering, and mesh-report tests are the evidence boundary for this page.

(python-api-meshing-fem-airbox-build-limitations)=
## 7. Limitations and known pitfalls

- Build success ≠ scientific qualification: always inspect the report and quality
  distributions.
- Do not reconstruct the realized mesh from the Python request after the run —
  retain the generated asset and provenance.

(python-api-meshing-fem-airbox-build-scientific-bibliography)=
## 8. Scientific bibliography

No page-specific physical claims; airbox physics: {doc}`index`.

(python-api-meshing-fem-airbox-build-source-code-index)=
## 9. Source-code index

| Claim | Path | Symbol | Evidence |
|---|---|---|---|
| airbox geometry construction and mesh extraction boundary | [`packages/fullmag-py/src/fullmag/meshing/_gmsh_airbox.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/_gmsh_airbox.py#L1545) | [`add_air_box`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/_gmsh_airbox.py#L1545) | meshing and API tests |
| explicit domain build | [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L6439) | [`class StudyBuilder`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L6439) (`build_domain_mesh`, `build_mesh`) | module function implementation |
| artifact persistence and interchange | [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L5850) | [`class StudyMeshHandle`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L5850) (`save`, `load`, `save_or_load`, `export`, `import_`) | facade implementation |
| airbox field-state persistence | [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L5623) | [`class StudyAirboxHandle`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L5623) (`load`, `save`) | facade implementation |
| quality result | [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L2575) | `GeometryMeshHandle.quality` | method signature |
