---
title: FEM Build and Quality API
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-meshing-fem-build-and-quality)=
# FEM Build and Quality API

A production script separates authoring from materialization:

```text
study.build_domain_mesh()
```

Quality requests are authored on object recipes with `compute_quality` and
`per_element_quality`. The resulting mesh report contains requested/resolved topology, operations,
fallbacks, region markers, element families, layer data, quality distributions, and mesh identity.

Do not reconstruct the realized mesh from the Python request after the run; retain the generated
asset and provenance.

(python-api-meshing-fem-build-and-quality-symbols-and-si-units)=
## Symbols and SI units
All geometric lengths use $\mathrm{m}$; dimensionless selectors use $1$.

(python-api-meshing-fem-build-and-quality-assumptions-and-validity)=
## Assumptions and validity
Authoring validation does not prove mesh generation or solver qualification; the realized report is authoritative.

(python-api-meshing-fem-build-and-quality-problem-statement)=
## 1. What it is and when to use it

`study.build_domain_mesh()` materializes the shared FEM domain mesh from the
authored universe, object, region, airbox, and quality policies. Use it before
solver execution when the mesh asset and quality/provenance report are needed.

(python-api-meshing-fem-build-and-quality-governing-equations)=
## 2. Physical and mathematical explanation

Mesh quality is a discretization property, not a new physical interaction.
The realized asset determines the finite-element space, element families,
markers, layer structure, and quality distributions consumed by the solver.

## 3. Example - complete Python script

```python
# %% Build a shared FEM mesh and request quality reports
import fullmag as fm

nm = 1.0e-9
study = fm.study("fem_build_quality")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.universe(mode="manual", size=(200 * nm, 100 * nm, 100 * nm))
study.universe.mesh(maximum_element_size=100 * nm)
body = study.geometry(fm.Box(80 * nm, 40 * nm, 4 * nm), name="film")
body.mesh(maximum_element_size=4 * nm, minimum_element_size=2 * nm,
          compute_quality=True, per_element_quality=True)
body.Ms = 800.0e3
body.Aex = 13.0e-12
body.m = fm.texture.uniform(1.0, 0.0, 0.0)
study.build_domain_mesh()
study.stages.add_relax(stage_id="relax", algorithm="llg_overdamped", dt=5.0e-13, max_steps=100)
```

(python-api-meshing-fem-build-and-quality-python-api)=
## 4. Exact API

### Shared-domain build, persistence, interchange, and low-level helpers

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `StudyBuilder.build_domain_mesh` | `() -> StudyBuilder` | n/a | $1$ | Current facade signature; invalid policy or stale fingerprints are rejected | materializes shared domain mesh | FEM CPU/GPU; FDM not applicable to this mesh policy | `mesh_workflow.build` |
| `build_domain_mesh` | `() -> None` | n/a | $1$ | Current facade signature; invalid policy or stale fingerprints are rejected | module-level shared-domain materialization (`fm.build_domain_mesh`) | FEM CPU/GPU; FDM not applicable to this mesh policy | `mesh_workflow.build` |
| `fullmag.world.StudyMeshHandle.export` | `(path: str \| Path, *, format: str = "auto") -> Path` | `format="auto"` | $1$ | `format` must be `"auto"`, `"comsol"`, or `"gmsh"` (`.mphtxt` selects COMSOL under `"auto"`) | exports realized shared-domain mesh to Gmsh or COMSOL format (`study.mesh.export(...)`) | FEM CPU/GPU | `mesh_workflow.build` |
| `fullmag.world.StudyMeshHandle.import_` | `(path: str \| Path, *, region_map=None, boundary_map=None, region_entity_map=None, boundary_entity_map=None, coordinate_unit=None) -> MeshPersistenceResult` | optional maps | $1$ | validates Gmsh/COMSOL format, coordinate units, and semantic marker maps (`region_entity_map`/`boundary_entity_map` are COMSOL `.mphtxt` only) | imports and binds an external shared-domain mesh (`study.mesh.import_(...)`) | FEM CPU/GPU | `backend_policy.discretization_hints.fem.mesh` |
| `domain_mesh` | `(source: str \| Path, *, region_markers, object_region_markers=None, marker_owners=None) -> None` | `None` | $1$ | nonempty source path and non-colliding marker tables (`fm.domain_mesh` / `study.domain_mesh`) | attaches an explicit precomputed shared-domain `.json` MeshIR asset | FEM CPU/GPU | `mesh_workflow.shared_domain_mesh_source` |
| `frozen_magnetic_submesh` | `(source: str \| Path, *, region_markers, air_mesh_source=None) -> None` | `air_mesh_source=None` | $1$ | nonempty source path and valid magnetic region markers (`fm.frozen_magnetic_submesh` / `study.frozen_magnetic_submesh`) | freezes the magnetic submesh while building the exterior airbox domain | FEM CPU/GPU | `mesh_workflow.frozen_magnetic_submesh` |
| `adaptive_mesh` | `(enabled: bool = True, *, policy="manual", indicator="geometric_only", target_quantity="auto", convergence_metric="energy_delta", theta=0.3, h_min=None, h_max=None, max_passes=5, error_tolerance=None, chunk_until_seconds=None, steps_per_pass=None) -> None` | `enabled=True` | $1$ | `policy in {"manual", "auto"}`, `0 < theta <= 1`, `max_passes >= 0`, positive `h_min` (`fm.adaptive_mesh` / `study.adaptive_mesh`) | stores declarative AFEM policy metadata for runtime orchestration | FEM metadata (declarative; AFEM loop capability-gated) | `runtime_metadata.adaptive_mesh` |
| `generate_mesh` | `(geometry, hmax=None, order=1, air_padding=0.0, airbox=None, options=None, maximum_element_size=None, object_id=None) -> MeshData` | `order=1` | $\mathrm{m}$ | positive target size and valid `MeshOptions`/`AirboxOptions` (`fm.generate_mesh`) | standalone Gmsh tetrahedral mesh generator returning `MeshData` | FEM CPU/Gmsh host helper | `none` |
| `export_stl` | `(geometry, destination: str \| Path, *, cylinder_sections: int = 48) -> Path` | `cylinder_sections=48` | $1$ | supported geometry and writable destination path (`fm.export_stl`) | exports analytic/CSG geometry to STL surface mesh | Host geometry helper | `none` |
| `resolve_mesh_size_controls` | `(opts: MeshOptions) -> dict[str, object]` | required | $1$ | accepts a `MeshOptions` instance (`fm.resolve_mesh_size_controls`) | resolves preset fallbacks into effective growth, curvature, and narrow-region parameters | FEM CPU/Gmsh host helper | `mesh_workflow` |
| `MeshOptions` | `dataclass` (`algorithm_2d=6`, `algorithm_3d=1`, `hmin=None`, `size_preset=None`, `optimize=None`, `compute_quality=True`, `per_element_quality=True`, ...) | defaults | $1$ | typed Gmsh generation options (`fm.MeshOptions`) | configures standalone `generate_mesh` and shared-domain Gmsh generation | FEM CPU/Gmsh | `mesh_workflow` |
| `MeshQualityReport` | `dataclass` (`n_elements`, `sicn_min`, `sicn_max`, `sicn_mean`, `sicn_p5`, `gamma_min`, `volume_min`, ..., `quality_by_family=None`) | required fields | $1$ | extracted from realized Gmsh/native mesh (`fm.MeshQualityReport`) | structured aggregate and optional per-element quality metrics | FEM CPU/GPU provenance | `mesh_workflow.quality_report` |
| `fullmag.model.discretization.PerObjectMeshRecipe.compute_quality` | `bool \| None` | `None` | $1$ | boolean when authored; `None` inherits | aggregate quality request | FEM CPU/GPU; FDM not applicable to this mesh policy | `mesh_workflow.per_geometry[]` |
| `fullmag.model.discretization.PerObjectMeshRecipe.per_element_quality` | `bool \| None` | `None` | $1$ | boolean when authored; `None` inherits | per-element quality request | FEM CPU/GPU; FDM not applicable to this mesh policy | `mesh_workflow.per_geometry[]` |

### `GeometryMeshHandle` object mesh facade

`body.mesh` returns a `GeometryMeshHandle` (`fm.GeometryMeshHandle`) supporting configuration,
sizing fields, swept intent, explicit build, and quality inspection:

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `GeometryMeshHandle.__call__` | `(**kwargs) -> GeometryMeshHandle` | inherited | $1$ | delegates to `configure(...)`; rejects invalid sizes, `source` mismatch, or mixing `cell_size` with FEM controls | authors object mesh policy (`body.mesh(...)`) | FEM CPU/GPU (and `cell_size` on FDM) | `mesh_workflow.per_geometry[]` |
| `GeometryMeshHandle.swept` | `(elements=6, distribution="fixed", element_ratio=1.0, symmetric=False, face_meshing="triangular", sweep_direction="auto", transition=None, exact_layers=None) -> GeometryMeshHandle` | `elements=6` | $1$ | `transition in {"pyramid_to_tetrahedra", "pure_prism", "reject"}`; `hex` rejects `"pyramid_to_tetrahedra"` and `"pure_prism"` | configures swept prismatic or hexahedral through-thickness meshing | FEM capability-gated | `mesh_workflow.per_geometry[]` |
| `GeometryMeshHandle.algorithm` | `(*, dim2: int \| None = None, dim3: int \| None = None) -> GeometryMeshHandle` | `None` | $1$ | Gmsh 2-D/3-D algorithm IDs | selects Gmsh surface and volume meshing algorithms | FEM/Gmsh | `mesh_workflow.per_geometry[].algorithm_2d/3d` |
| `GeometryMeshHandle.size_field` | `(kind: str, **params: object) -> GeometryMeshHandle` | required | $1$ | finite JSON-serializable Gmsh field parameters (e.g., `"Ball"`, `"Box"`) | appends an explicit Gmsh size field to the object recipe | FEM/Gmsh | `mesh_workflow.per_geometry[].size_fields` |
| `GeometryMeshHandle.build` | `() -> GeometryMeshHandle` | n/a | $1$ | marks `build_requested=True` and materializes shared-domain mesh assets | explicitly triggers mesh generation from the object facade | FEM CPU/GPU | `mesh_workflow.build` |
| `GeometryMeshHandle.quality` | `() -> object \| None` | `None` | $1$ | returns cached `MeshQualityReport` or `None` if `compute_quality` was disabled | retrieves the most recent quality report for this object | FEM CPU/GPU | `mesh_workflow.quality_report` |
| `GeometryMeshHandle.optimize` | `(method: str \| None = None, iterations: int = 1) -> GeometryMeshHandle` | `iterations=1` | $1$ | records an authored `optimize` mesh operation (shared-domain build currently fails closed on nonempty `operations`) | queues a post-mesh optimization operation; prefer `body.mesh(optimize=..., optimize_iterations=...)` for executable builds | Authored intent only (build fails closed on nonempty `operations`) | `mesh_workflow.per_geometry[].operations` |
| `GeometryMeshHandle.refine` | `(steps: int = 1) -> GeometryMeshHandle` | `steps=1` | $1$ | records an authored `refine` mesh operation (shared-domain build currently fails closed on nonempty `operations`) | queues a uniform h-refinement operation | Authored intent only (build fails closed on nonempty `operations`) | `mesh_workflow.per_geometry[].operations` |
| `GeometryMeshHandle.smooth` | `(iterations: int = 1) -> GeometryMeshHandle` | `iterations=1` | $1$ | records an authored `smooth` mesh operation (shared-domain build currently fails closed on nonempty `operations`) | queues a Laplacian smoothing operation; prefer `body.mesh(smoothing_steps=...)` for executable builds | Authored intent only (build fails closed on nonempty `operations`) | `mesh_workflow.per_geometry[].operations` |

Invalid mesh policy values fail during authoring. Build failure must preserve
the latest successful asset; node, element, and quality data come from the
realized report rather than the request object. For FEM GPU demagnetization and
kernel realization performance on the built mesh, see
{ref}`numerical-methods-performance-fem-gpu-demag`.

(python-api-meshing-fem-build-and-quality-problem-ir)=
## ProblemIR
The request lowers to the mesh-workflow or discretization subtree; requested intent remains distinct from the resolved mesh asset and provenance report.

(python-api-meshing-fem-build-and-quality-round-trip-and-failure-semantics)=
## Round-trip and failure semantics
Requested intent is the Python policy; resolved execution is the realized mesh report. Validation errors identify the violated domain rule, and unsupported combinations fail explicitly without silent fallback.

(python-api-meshing-fem-build-and-quality-discrete-realization)=
## Discrete realization
The backend consumes the realized finite-element asset, including topology, markers, quality, and provenance where available.

## 5. How to set it in Control Room

Route: `Model Explorer -> Objects -> <object> -> Mesh` (`apps/control-room/src/modules/inspector/panels/mesh-details/ObjectMeshSpecPanel.tsx` / Quality & History tabs) and
`Model Explorer -> Universe / Airbox -> Mesh` (`apps/control-room/src/modules/inspector/inspectors/universe/AirboxMeshSizingSpecs.tsx` / `apps/control-room/src/modules/inspector/inspectors/universe/AirboxMeshBuildSpec.tsx`).
Use **Apply Object Policy** / **Build Mesh** (`mesh.build-selected`) or **Apply & Build Shared-Domain Mesh**
(`mesh.build-shared-domain`) to materialize the shared mesh. `MeshQualityStatisticsView` (and `apps/control-room/src/modules/inspector/inspectors/mesh/MeshQualitySpec.tsx`) exposes element/boundary
counts, edge-length/size distributions, inverted/degenerate diagnostics, and latest-successful build preservation so a
failed rebuild never erases the last good mesh. See {doc}`/frontend/meshing/object-mesh`,
{doc}`/frontend/meshing/quality-and-reports`, and [Control Room capability register](/frontend/capability-register).

```{image} /_static/images/ui/inspector-fem-mesh-and-airbox.png
:alt: Semantic Inspector panel configuring FEM object mesh sizing, swept strategy, and build trigger
:width: 92%
```

```{image} /_static/images/ui/explorer-jobs-and-diagnostics-tabs.png
:alt: Explorer Jobs and Diagnostics tabs tracking mesh build status and diagnostic outputs
:width: 92%
```

(python-api-meshing-fem-build-and-quality-implementation-mapping)=
## 6. Backend and frontend support

| Lane | Status | Notes |
|---|---|---|
| FEM CPU | authoring implemented | Runtime build and solver qualification are separate gates. |
| FEM GPU | shared-asset dependent | GPU consumes the realized asset. |
| FDM CPU/GPU | not applicable | FDM uses structured grids. |
| Control Room | implemented for advertised fields | Quality and build actions are source-backed. |

(python-api-meshing-fem-build-and-quality-validation)=
## Validation
Focused constructor, lowering, and mesh-report tests are the evidence boundary for this page.

(python-api-meshing-fem-build-and-quality-limitations)=
## 7. Limitations and known pitfalls

- A green policy draft is not a green mesh build.
- Do not synthesize quality distributions from authored sizes.
- `GeometryMeshHandle.optimize()`, `.refine()`, and `.smooth()` append entries to `operations`, which currently fail closed at shared-domain realization with `mesh operation executor unavailable`; use `body.mesh(optimize=..., optimize_iterations=..., smoothing_steps=...)` instead.
- CPU/GPU comparisons require the same mesh identity/digest.

(python-api-meshing-fem-build-and-quality-scientific-bibliography)=
## 8. Scientific bibliography

1. C. Geuzaine and J.-F. Remacle, “Gmsh: a three-dimensional finite element
   mesh generator,” *International Journal for Numerical Methods in Engineering*
   **79**, 1309-1331 (2009), [doi:10.1002/nme.2579](https://doi.org/10.1002/nme.2579).
2. P. G. Ciarlet, *The Finite Element Method for Elliptic Problems*, SIAM, 2002.

(python-api-meshing-fem-build-and-quality-source-code-index)=
## 9. Source-code index

| Claim | Repository path | Stable symbol | Evidence |
|---|---|---|---|
| realized mesh data, validation, and quality channels | [`packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py#L2358) | [`class MeshData`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py#L2358) | mesh realization and API tests |
| mesh realization and provenance report | [`packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py#L1049) | [`class MeshRealizationReport`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py#L1049) | mesh report and API tests |
| Gmsh options, quality report, and preset resolver | [`packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py#L544) | [`class MeshOptions`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py#L544), [`class MeshQualityReport`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py#L389), [`resolve_mesh_size_controls`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py#L921) | meshing and API tests |
| standalone mesh generation | [`packages/fullmag-py/src/fullmag/meshing/_gmsh_generators.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/_gmsh_generators.py#L324) | [`generate_mesh`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/_gmsh_generators.py#L324) | Gmsh generator tests |
| STL surface export | [`packages/fullmag-py/src/fullmag/meshing/surface_assets.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/surface_assets.py#L344) | [`export_geometry_to_stl`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/surface_assets.py#L344) | surface asset tests |
| object mesh facade | [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L1681) | [`class GeometryMeshHandle`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L1681) | object mesh API tests |
| study mesh persistence and interchange | [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L5850) | [`class StudyMeshHandle`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L5850) (`export`, `import_`, `save`, `load`, `save_or_load`) | mesh persistence tests |
| study builder, explicit domain mesh, submesh, and AFEM metadata | [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L6439) | [`class StudyBuilder`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L6439), `domain_mesh`, `frozen_magnetic_submesh`, `adaptive_mesh`, `build_domain_mesh` | builder and metadata tests |
| quality fields | [`packages/fullmag-py/src/fullmag/model/discretization.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/discretization.py#L694) | [`class PerObjectMeshRecipe`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/discretization.py#L694) | dataclass and IR fields |
