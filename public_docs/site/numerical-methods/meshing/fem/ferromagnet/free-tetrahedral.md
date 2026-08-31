---
title: "Free tetrahedral ferromagnet mesh"
description: "The public `object.mesh(...)` route for general unstructured FEM volume meshing."
summary: "The public `object.mesh(...)` route for general unstructured FEM volume meshing."
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-31
reviewed_revision: 969efa0941905825ac569d525f4bdaefc059e2af
source_of_truth: "current public authoring, ProblemIR lowering, mesh realization, and build report"
---

(public-docs-numerical-methods-meshing-fem-ferromagnet-free-tetrahedral)=
# Free tetrahedral ferromagnet mesh

(free-tetrahedral-problem-statement)=
## Problem statement

The public `object.mesh(...)` route for general unstructured FEM volume meshing.

(free-tetrahedral-governing-equations)=
## Governing equations

```{math}
:label: eq-free-tetrahedral-contract
V_K=\frac{1}{6}\det[\mathbf{x}_1-\mathbf{x}_0,\mathbf{x}_2-\mathbf{x}_0,\mathbf{x}_3-\mathbf{x}_0].
```

(free-tetrahedral-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
| --- | --- | --- |
| $V_K$ | signed tetrahedron volume | m^3 |
| $\mathbf{x}_i$ | tetrahedron vertex position | m |

(free-tetrahedral-assumptions-and-validity)=
## Assumptions and validity

The geometry must define a meshable volume. Alias pairs must agree when both forms are supplied. The exported geometric connectivity is first order; `order` controls the FEM solution space. Positive volume is necessary but sliver quality and observable convergence still require checks.

(free-tetrahedral-python-api)=
## Python API

The table is exhaustive for this public family entry point. Alias rows are alternatives, not extra simultaneous requirements.

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `hmax` | `float \| str \| None` | `None` | m | positive length or auto; alias of maximum_element_size | maximum size alias | FEM CPU source-backed; FEM GPU capability-gated | `mesh_workflow.per_geometry[].hmax` |
| `maximum_element_size` | `float \| str \| None` | `None` | m | positive length or auto | maximum element-size request | FEM CPU source-backed; FEM GPU capability-gated | `mesh_workflow.per_geometry[].maximum_element_size` |
| `hmin` | `float \| None` | `None` | m | positive and <= maximum when both supplied | minimum size alias | FEM CPU source-backed; FEM GPU capability-gated | `mesh_workflow.per_geometry[].hmin` |
| `minimum_element_size` | `float \| None` | `None` | m | positive and <= maximum when both supplied | minimum element-size request | FEM CPU source-backed; FEM GPU capability-gated | `mesh_workflow.per_geometry[].minimum_element_size` |
| `order` | `int \| None` | `None` | 1 | integer order when supplied | FEM solution-space order request | FEM CPU source-backed; FEM GPU capability-gated | `mesh_workflow.per_geometry[].order` |
| `calibrate_for` | `str \| None` | `None` | 1 | supported calibration vocabulary | physics calibration family | FEM CPU source-backed; FEM GPU capability-gated | `mesh_workflow.per_geometry[].calibrate_for` |
| `size_preset` | `str \| None` | `None` | 1 | supported size-preset vocabulary | named sizing preset | FEM CPU source-backed; FEM GPU capability-gated | `mesh_workflow.per_geometry[].size_preset` |
| `algorithm_2d` | `int \| None` | `None` | 1 | integer Gmsh algorithm identifier | surface algorithm request | FEM CPU source-backed; FEM GPU capability-gated | `mesh_workflow.per_geometry[].algorithm_2d` |
| `algorithm_3d` | `int \| None` | `None` | 1 | integer Gmsh algorithm identifier | volume algorithm request | FEM CPU source-backed; FEM GPU capability-gated | `mesh_workflow.per_geometry[].algorithm_3d` |
| `optimize` | `str \| None` | `None` | 1 | supported Gmsh optimizer name | post-generation optimizer | FEM CPU source-backed; FEM GPU capability-gated | `mesh_workflow.per_geometry[].optimize` |
| `optimize_iterations` | `int \| None` | `None` | 1 | integer >= 1 | optimizer pass count | FEM CPU source-backed; FEM GPU capability-gated | `mesh_workflow.per_geometry[].optimize_iterations` |
| `smoothing_steps` | `int \| None` | `None` | 1 | integer >= 0 | Gmsh smoothing passes | FEM CPU source-backed; FEM GPU capability-gated | `mesh_workflow.per_geometry[].smoothing_steps` |
| `size_factor` | `float \| None` | `None` | 1 | finite and > 0 | global factor on requested sizes | FEM CPU source-backed; FEM GPU capability-gated | `mesh_workflow.per_geometry[].size_factor` |
| `size_from_curvature` | `int \| None` | `None` | 1 | integer >= 0 | curvature points control | FEM CPU source-backed; FEM GPU capability-gated | `mesh_workflow.per_geometry[].size_from_curvature` |
| `curvature_factor` | `float \| None` | `None` | 1 | finite and > 0 | curvature refinement factor | FEM CPU source-backed; FEM GPU capability-gated | `mesh_workflow.per_geometry[].curvature_factor` |
| `growth_rate` | `float \| None` | `None` | 1 | finite, > 0, and <= 2.5 | size-growth alias | FEM CPU source-backed; FEM GPU capability-gated | `mesh_workflow.per_geometry[].growth_rate` |
| `maximum_element_growth_rate` | `float \| None` | `None` | 1 | finite, > 0, and <= 2.5 | maximum growth request | FEM CPU source-backed; FEM GPU capability-gated | `mesh_workflow.per_geometry[].maximum_element_growth_rate` |
| `narrow_regions` | `int \| None` | `None` | 1 | integer >= 0 | narrow-region sampling count | FEM CPU source-backed; FEM GPU capability-gated | `mesh_workflow.per_geometry[].narrow_regions` |
| `narrow_region_resolution` | `float \| None` | `None` | 1 | finite and > 0 | narrow-region resolution | FEM CPU source-backed; FEM GPU capability-gated | `mesh_workflow.per_geometry[].narrow_region_resolution` |
| `interface_maximum_element_size` | `float \| None` | `None` | m | finite and > 0 | interface size request | FEM CPU source-backed; FEM GPU capability-gated | `mesh_workflow.per_geometry[].interface_hmax` |
| `interface_hmax` | `float \| None` | `None` | m | finite and > 0; alias | interface size alias | FEM CPU source-backed; FEM GPU capability-gated | `mesh_workflow.per_geometry[].interface_hmax` |
| `interface_thickness` | `float \| None` | `None` | m | finite and > 0 | interface refinement shell | FEM CPU source-backed; FEM GPU capability-gated | `mesh_workflow.per_geometry[].interface_thickness` |
| `transition_distance` | `float \| str \| None` | `None` | m | zero or positive length, or supported automatic value | interface transition distance | FEM CPU source-backed; FEM GPU capability-gated | `mesh_workflow.per_geometry[].transition_distance` |
| `transition_growth` | `float \| None` | `None` | 1 | finite and > 0 | interface transition growth | FEM CPU source-backed; FEM GPU capability-gated | `mesh_workflow.per_geometry[].transition_growth` |
| `edge_maximum_element_size` | `float \| None` | `None` | m | finite and > 0 | edge size request | FEM CPU source-backed; FEM GPU capability-gated | `mesh_workflow.per_geometry[].edge_hmax` |
| `edge_hmax` | `float \| None` | `None` | m | finite and > 0; alias | edge size alias | FEM CPU source-backed; FEM GPU capability-gated | `mesh_workflow.per_geometry[].edge_hmax` |
| `edge_thickness` | `float \| None` | `None` | m | finite and > 0 | edge refinement shell | FEM CPU source-backed; FEM GPU capability-gated | `mesh_workflow.per_geometry[].edge_thickness` |
| `edge_transition_distance` | `float \| str \| None` | `None` | m | positive length or supported automatic value | edge transition distance | FEM CPU source-backed; FEM GPU capability-gated | `mesh_workflow.per_geometry[].edge_transition_distance` |
| `corner_maximum_element_size` | `float \| None` | `None` | m | finite and > 0 | corner size request | FEM CPU source-backed; FEM GPU capability-gated | `mesh_workflow.per_geometry[].corner_hmax` |
| `corner_hmax` | `float \| None` | `None` | m | finite and > 0; alias | corner size alias | FEM CPU source-backed; FEM GPU capability-gated | `mesh_workflow.per_geometry[].corner_hmax` |
| `corner_extent` | `float \| None` | `None` | m | finite and > 0 | corner refinement extent | FEM CPU source-backed; FEM GPU capability-gated | `mesh_workflow.per_geometry[].corner_extent` |
| `corner_transition_distance` | `float \| str \| None` | `None` | m | positive length or supported automatic value | corner transition distance | FEM CPU source-backed; FEM GPU capability-gated | `mesh_workflow.per_geometry[].corner_transition_distance` |
| `compute_quality` | `bool \| None` | `None` | 1 | boolean when supplied | request aggregate quality | FEM CPU source-backed; FEM GPU capability-gated | `mesh_workflow.per_geometry[].compute_quality` |
| `per_element_quality` | `bool \| None` | `None` | 1 | boolean when supplied | request per-cell quality arrays | FEM CPU source-backed; FEM GPU capability-gated | `mesh_workflow.per_geometry[].per_element_quality` |
| `mesh_strategy` | `str \| None` | `None` | 1 | use free_tetrahedral for this family | explicit general tetrahedral strategy | FEM CPU source-backed; FEM GPU capability-gated | `mesh_workflow.per_geometry[].mesh_strategy` |

```python
# %% imports
import fullmag as fm

# %% stage-first study and complete free-tetrahedral request
study = fm.study("free_tetrahedral_reference")
study.engine("fem")
body = study.geometry(fm.Box(size=(80e-9, 40e-9, 20e-9)), name="body")
body.mesh(
    mesh_strategy="free_tetrahedral",
    maximum_element_size=8e-9,
    minimum_element_size=2e-9,
    algorithm_2d=6,
    algorithm_3d=1,
    optimize="Netgen",
    optimize_iterations=1,
    smoothing_steps=1,
    size_factor=1.0,
    size_from_curvature=0,
    curvature_factor=0.5,
    growth_rate=1.3,
    narrow_regions=0,
    interface_maximum_element_size=4e-9,
    interface_thickness=4e-9,
    transition_distance=16e-9,
    edge_maximum_element_size=3e-9,
    edge_thickness=4e-9,
    edge_transition_distance=12e-9,
    corner_maximum_element_size=2e-9,
    corner_extent=3e-9,
    corner_transition_distance=8e-9,
    order=1,
    compute_quality=True,
    per_element_quality=True,
)
study.stages.add_relax(stage_id="equilibrium", dt=5.0e-13, max_steps=1)
```

(free-tetrahedral-problem-ir)=
## ProblemIR

`GeometryMeshHandle.configure` coalesces canonical names and aliases. `_mesh_spec_to_metadata` writes every `body.mesh(...)` value under the matching `mesh_workflow.per_geometry[]` entry. `_collect_mesh_workflow_metadata` derives top-level `mesh_options` from the default spec only; it is not the authoring destination for this per-object call. The build report separately records actual method and quality.

(free-tetrahedral-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

**Requested intent** is the complete `object.mesh(...)` configuration. **Resolved execution** records normalized aliases, selected effective algorithm, actual mesh method, element counts, and quality. **Validation errors** cover conflicting aliases, nonpositive sizes, minimum greater than maximum, a growth rate above `2.5`, invalid counts, and FDM `cell_size` mixed with FEM controls. Interface `transition_distance=0` is valid; edge and corner transition distances remain strictly positive when numeric. **Unsupported combinations** must be reported; the known MMG3D-with-background-fields case resolves to HXT with an explicit reason, not silently.

(free-tetrahedral-discrete-realization)=
## Discrete realization

`_apply_mesh_options` applies sizes, first-order geometric connectivity, algorithms, smoothing, optimization, and fields. `generate_mesh` dispatches supported geometries, while domain realization and `_build_shared_domain_build_report` record actual method, requested method, and fallbacks. FEM CPU consumes the resulting MeshIR; GPU consumption remains capability-gated.

(free-tetrahedral-implementation-mapping)=
## Implementation mapping

The source index maps public authoring, lowering, realization, reporting, and backend consumption. Source-backed FEM CPU support does not imply that every requested topology is supported; FEM GPU remains capability-gated by the realized mesh and active runtime.

### FEM CPU/GPU plan and runtime consumption

`plan_fem` resolves the domain or per-object mesh asset, validates typed MeshIR and region ownership, and places that mesh in `FemPlanIR`; this is the planning consumer after Python realization. The production runner enters `execute_fem_with_context_in_mode`, normalizes the FEM plan, resolves CPU/GPU behavior, and calls the configuration-selected `execute_native_fem` implementation for native execution. `apply_native_fem_runtime_contract` is not a gate: after runtime observations exist, it returns `()` and only populates `ExecutionProvenance` fields such as execution mode, qualification status, data residency, CUDA-kernel use, GPU Poisson use, and hot-loop synchronization counts. A source-backed Python mesh build is therefore not itself CPU or GPU runtime proof; actual execution and its populated provenance provide that evidence.
(free-tetrahedral-validation)=
## Validation

Confirm source identity, requested and actual methods, typed cell families, complete region/boundary markers, zero inverted or degenerate cells, and the relevant quality distributions. Then refine the controlling size or layer count while holding geometry, materials, solver tolerances, and outputs fixed, and require convergence of a physical observable.

(free-tetrahedral-limitations)=
## Limitations

This page does not cover imported `FEM(mesh=...)`, boundary layers, or thin-film/swept topology. `mesh_strategy="free_tetrahedral"` requests the family, but only the realized typed cells prove it.

(free-tetrahedral-scientific-bibliography)=
## Scientific bibliography

- C. Geuzaine and J.-F. Remacle, "Gmsh: a three-dimensional finite element mesh generator with built-in pre- and post-processing facilities," *International Journal for Numerical Methods in Engineering* **79** (2009), 1309-1331, [doi:10.1002/nme.2579](https://doi.org/10.1002/nme.2579).
- C. Abert, "Micromagnetics and spintronics: models and numerical methods," *European Physical Journal B* **92**, 120 (2019), [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).

(free-tetrahedral-source-code-index)=
## Source-code index

| Repository path | Stable symbol | Responsibility |
| --- | --- | --- |
| `packages/fullmag-py/src/fullmag/world.py` | `class GeometryMeshHandle` | Public object.mesh authoring and validation. |
| `packages/fullmag-py/src/fullmag/world.py` | `_mesh_spec_to_metadata` | Per-object ProblemIR lowering. |
| `packages/fullmag-py/src/fullmag/world.py` | `_collect_mesh_workflow_metadata` | Generator mesh_options lowering. |
| `packages/fullmag-py/src/fullmag/meshing/_gmsh_fields.py` | `_apply_mesh_options` | Gmsh option normalization and effective algorithm. |
| `packages/fullmag-py/src/fullmag/meshing/_gmsh_generators.py` | `generate_mesh` | Geometry-specific free volume generation. |
| `packages/fullmag-py/src/fullmag/meshing/mesh_build_report.py` | `_build_shared_domain_build_report` | Requested/resolved method and fallback report. |
| `packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py` | `realize_fem_domain_mesh_asset_from_components_with_report` | FEM domain MeshIR realization. |
| `crates/fullmag-plan/src/fem.rs` | `plan_fem` | Validated MeshIR consumption and FEM plan construction. |
| `crates/fullmag-runner/src/dispatch.rs` | `execute_fem_with_context_in_mode` | Production plan normalization and CPU/GPU native execution routing. |
| `crates/fullmag-runner/src/dispatch.rs` | `execute_native_fem` | Configuration-selected native CPU/GPU execution implementation. |
| `crates/fullmag-runner/src/dispatch.rs` | `apply_native_fem_runtime_contract` | Populates runtime provenance fields after observations exist; returns `()`. |


## Scope and purpose

This page defines the public contract for free tetrahedral FEM meshes. It is an authoring and implementation reference: the Python example, the serialized ProblemIR description, the implementation mapping, and the adjacent source map are the source-backed contract. A capability marked partial or not evaluated is not presented as a production guarantee.

## Scientific and numerical model

The mesh or grid is a discrete approximation of the continuous domain. For a Cartesian partition, each spacing satisfies `Delta_i = L_i / N_i`; for a geometry-dependent FEM mesh, the requested local target is bounded by the active bulk, interface, boundary, and topology constraints. In compact form, `h_target(x) = min(h_bulk(x), h_interface(x), h_boundary(x))`. Length quantities use SI metres (`m`); counts, orders, and topology labels are dimensionless.

The equations and assumptions in the earlier physical-problem and governing-equations sections state the model-specific specialization. This section does not introduce a conversion from FEM to FDM, a hidden topology conversion, or a silent CPU fallback.

## Parameters

The exact callable and argument names are the ones shown in the `## Python API` section above. For this page the parameter family is maximum and minimum element size, order, algorithm, and optimizer. Use the documented defaults, validation rules, and ProblemIR lowering exactly as shown; do not replace a canonical argument with an unlisted alias. Numerical lengths must be supplied in metres, and invalid positive-length, count, order, periodicity, or topology constraints must fail closed rather than being silently repaired.

## Control Room workflow

In Control Room, select the engine and mesh workflow, enter the same values as the Python authoring example, inspect the planned mesh or grid report, and only then submit the run. The UI is a projection of the public contract: a missing control is not evidence that the backend accepts the option, and a visible control is not evidence that a production lane is enabled. When the page or capability register marks a field partial or not evaluated, keep the workflow explicitly bounded to the implemented path.

## Diagnostics and failure semantics

A valid request must preserve the declared geometry, units, element or cell topology, and backend lane. Reject non-finite or non-positive lengths, invalid counts and orders, incompatible periodic or shared-boundary data, and unsupported topology combinations at the owning validation layer. Reports should retain requested and resolved values, source identity, and any capability gate. No diagnostic may hide a failed mesh realization by substituting another discretization.

## Where this is implemented

The existing implementation-mapping and source-code-index sections identify the exact public authoring, ProblemIR, planner, realization, and runtime owners for this topic. The adjacent `.source-map.json` file is the machine-readable source of truth for those paths, symbols, responsibilities, backend matrix, and reviewed revision. Claims in this page must be updated together with that map when an owner moves.