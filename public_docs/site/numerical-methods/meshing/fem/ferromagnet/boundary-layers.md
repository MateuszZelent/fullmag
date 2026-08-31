---
title: "FEM boundary-layer mesh controls"
description: "Targeted Gmsh boundary-layer controls for a ferromagnetic FEM mesh."
summary: "Targeted Gmsh boundary-layer controls for a ferromagnetic FEM mesh."
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-31
reviewed_revision: 969efa0941905825ac569d525f4bdaefc059e2af
source_of_truth: "current public authoring, ProblemIR lowering, mesh realization, and build report"
---

(public-docs-numerical-methods-meshing-fem-ferromagnet-boundary-layers)=
# FEM boundary-layer mesh controls

(boundary-layers-problem-statement)=
## Problem statement

Targeted Gmsh boundary-layer controls for a ferromagnetic FEM mesh.

(boundary-layers-governing-equations)=
## Governing equations

```{math}
:label: eq-boundary-layers-contract
d_j=d_0q^j,\qquad j=0,\ldots,N-1.
```

(boundary-layers-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
| --- | --- | --- |
| $d_0$ | first requested layer thickness | m |
| $q$ | requested layer stretching ratio | 1 |
| $N$ | requested layer count | 1 |

(boundary-layers-assumptions-and-validity)=
## Assumptions and validity

At least one explicit surface or curve target is required for realization. Tags are Gmsh entity identifiers and can change after geometry edits; selector mappings are resolved against current geometry. Boundary layers can create high-aspect-ratio cells and require observable-level convergence.

(boundary-layers-python-api)=
## Python API

The table is exhaustive for this public family entry point. Alias rows are alternatives, not extra simultaneous requirements.

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `boundary_layer_count` | `int \| None` | `None` | 1 | coerced with int(...), then result must be >= 1; non-integral numeric values truncate toward zero | requested layer count | FEM CPU source-backed; FEM GPU capability-gated | `mesh_workflow.per_geometry[].boundary_layer_count` |
| `boundary_layer_thickness` | `float \| None` | `None` | m | finite and > 0 when supplied | first-wall spacing passed as hwall_n and thickness | FEM CPU source-backed; FEM GPU capability-gated | `mesh_workflow.per_geometry[].boundary_layer_thickness` |
| `boundary_layer_stretching` | `float \| None` | `None` | 1 | finite and > 0 when supplied | successive-layer growth ratio | FEM CPU source-backed; FEM GPU capability-gated | `mesh_workflow.per_geometry[].boundary_layer_stretching` |
| `boundary_layer_target_surface_tags` | `Sequence[int] \| None` | `None` | 1 | positive integer entity tags | explicit target surfaces; their boundary curves are derived | FEM CPU source-backed; FEM GPU capability-gated | `mesh_workflow.per_geometry[].boundary_layer_target_surface_tags` |
| `boundary_layer_target_curve_tags` | `Sequence[int] \| None` | `None` | 1 | positive integer entity tags | explicit target curves | FEM CPU source-backed; FEM GPU capability-gated | `mesh_workflow.per_geometry[].boundary_layer_target_curve_tags` |
| `boundary_layer_target_surface_selectors` | `Sequence[Mapping[str, object]] \| None` | `None` | 1 | each item must be a selector mapping | semantic surface targets resolved at build time | FEM CPU source-backed; FEM GPU capability-gated | `mesh_workflow.per_geometry[].boundary_layer_target_surface_selectors` |
| `boundary_layer_target_curve_selectors` | `Sequence[Mapping[str, object]] \| None` | `None` | 1 | each item must be a selector mapping | semantic curve targets resolved at build time | FEM CPU source-backed; FEM GPU capability-gated | `mesh_workflow.per_geometry[].boundary_layer_target_curve_selectors` |

```python
# %% imports
import fullmag as fm

# %% stage-first study and a target-bearing mesh recipe
study = fm.study("boundary_layer_reference")
study.engine("fem")
film = study.geometry(
    fm.Box(size=(80e-9, 40e-9, 8e-9), name="film"),
    name="film",
)
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.m = fm.texture.uniform(1.0, 0.0, 0.0)
film.mesh(
    maximum_element_size=6e-9,
    boundary_layer_count=3,
    boundary_layer_thickness=1e-9,
    boundary_layer_stretching=1.25,
    boundary_layer_target_surface_tags=[1],
    compute_quality=True,
)
study.stages.add_relax(stage_id="equilibrium", dt=5.0e-13, max_steps=1)
```

(boundary-layers-problem-ir)=
## ProblemIR

`GeometryMeshHandle.configure` normalizes the four target forms and `_mesh_spec_to_metadata` writes them under the matching `mesh_workflow.per_geometry[]` entry. `_collect_mesh_workflow_metadata` uses `mesh_workflow.mesh_options` only for the default mesh spec, not for this `film.mesh(...)` request. Tags and selectors are requested intent; selector-resolution records and `BoundaryLayerResult` are resolved evidence.

(boundary-layers-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

**Requested intent** contains count, first spacing, ratio, and at least one target form. **Resolved execution** contains selector matches and a boundary-layer status: `applied`, `degraded`, or `ignored`, with a reason where applicable. **Validation errors** include a boundary-layer count whose `int(...)` conversion fails or whose converted value is below one, nonpositive thickness, invalid tags, and non-mapping selectors. Because conversion precedes range validation, for example `3.9` resolves to `3` and `0.9` resolves to `0` and is rejected. **Unsupported combinations** do not acquire a hidden fallback: no targets yields `ignored`; surface-to-curve failure yields `ignored`; unavailable `setAsBoundaryLayer` yields `degraded`.

(boundary-layers-discrete-realization)=
## Discrete realization

`_add_boundary_layer_field` converts selected surfaces to boundary curves, sets `CurvesList`, `hwall_n`, `thickness`, `ratio`, and `NbLayers`, then calls `setAsBoundaryLayer`. This is a Gmsh field request; the extracted cell topology and build report remain authoritative.

(boundary-layers-implementation-mapping)=
## Implementation mapping

The source index maps public authoring, lowering, realization, reporting, and backend consumption. Source-backed FEM CPU support does not imply that every requested topology is supported; FEM GPU remains capability-gated by the realized mesh and active runtime.

### FEM CPU/GPU plan and runtime consumption

`plan_fem` resolves the domain or per-object mesh asset, validates typed MeshIR and region ownership, and places that mesh in `FemPlanIR`; this is the planning consumer after Python realization. The production runner enters `execute_fem_with_context_in_mode`, normalizes the FEM plan, resolves CPU/GPU behavior, and calls the configuration-selected `execute_native_fem` implementation for native execution. `apply_native_fem_runtime_contract` is not a gate: after runtime observations exist, it returns `()` and only populates `ExecutionProvenance` fields such as execution mode, qualification status, data residency, CUDA-kernel use, GPU Poisson use, and hot-loop synchronization counts. A source-backed Python mesh build is therefore not itself CPU or GPU runtime proof; actual execution and its populated provenance provide that evidence.
(boundary-layers-validation)=
## Validation

Confirm source identity, requested and actual methods, typed cell families, complete region/boundary markers, zero inverted or degenerate cells, and the relevant quality distributions. Then refine the controlling size or layer count while holding geometry, materials, solver tolerances, and outputs fixed, and require convergence of a physical observable.

(boundary-layers-limitations)=
## Limitations

A configured layer without targets is deliberately ignored. The implementation sets both `hwall_n` and `thickness` from `boundary_layer_thickness`; it does not document that value as total geometric-series thickness. Tag-based targeting is not stable across geometry revisions.

(boundary-layers-scientific-bibliography)=
## Scientific bibliography

- C. Geuzaine and J.-F. Remacle, "Gmsh: a three-dimensional finite element mesh generator with built-in pre- and post-processing facilities," *International Journal for Numerical Methods in Engineering* **79** (2009), 1309-1331, [doi:10.1002/nme.2579](https://doi.org/10.1002/nme.2579).
- C. Abert, "Micromagnetics and spintronics: models and numerical methods," *European Physical Journal B* **92**, 120 (2019), [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).

(boundary-layers-source-code-index)=
## Source-code index

| Repository path | Stable symbol | Responsibility |
| --- | --- | --- |
| `packages/fullmag-py/src/fullmag/world.py` | `class GeometryMeshHandle` | Public object.mesh arguments and validation. |
| `packages/fullmag-py/src/fullmag/world.py` | `_mesh_spec_to_metadata` | Per-object ProblemIR metadata lowering. |
| `packages/fullmag-py/src/fullmag/world.py` | `_collect_mesh_workflow_metadata` | Requested mesh_options lowering. |
| `packages/fullmag-py/src/fullmag/meshing/_gmsh_fields.py` | `_apply_mesh_options` | Selector resolution and field-plan application. |
| `packages/fullmag-py/src/fullmag/meshing/_gmsh_fields.py` | `_add_boundary_layer_field` | Gmsh boundary-layer status and realization. |
| `packages/fullmag-py/src/fullmag/meshing/mesh_build_report.py` | `_build_mesh_operation_statuses` | Requested/resolved operation statuses. |
| `packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py` | `realize_fem_domain_mesh_asset_from_components_with_report` | FEM domain mesh realization and report. |
| `crates/fullmag-plan/src/fem.rs` | `plan_fem` | Validated MeshIR consumption and FEM plan construction. |
| `crates/fullmag-runner/src/dispatch.rs` | `execute_fem_with_context_in_mode` | Production plan normalization and CPU/GPU native execution routing. |
| `crates/fullmag-runner/src/dispatch.rs` | `execute_native_fem` | Configuration-selected native CPU/GPU execution implementation. |
| `crates/fullmag-runner/src/dispatch.rs` | `apply_native_fem_runtime_contract` | Populates runtime provenance fields after observations exist; returns `()`. |


## Scope and purpose

This page defines the public contract for FEM ferromagnet boundary-layer controls. It is an authoring and implementation reference: the Python example, the serialized ProblemIR description, the implementation mapping, and the adjacent source map are the source-backed contract. A capability marked partial or not evaluated is not presented as a production guarantee.

## Scientific and numerical model

The mesh or grid is a discrete approximation of the continuous domain. For a Cartesian partition, each spacing satisfies `Delta_i = L_i / N_i`; for a geometry-dependent FEM mesh, the requested local target is bounded by the active bulk, interface, boundary, and topology constraints. In compact form, `h_target(x) = min(h_bulk(x), h_interface(x), h_boundary(x))`. Length quantities use SI metres (`m`); counts, orders, and topology labels are dimensionless.

The equations and assumptions in the earlier physical-problem and governing-equations sections state the model-specific specialization. This section does not introduce a conversion from FEM to FDM, a hidden topology conversion, or a silent CPU fallback.

## Parameters

The exact callable and argument names are the ones shown in the `## Python API` section above. For this page the parameter family is layer thickness, element size, growth, and FEM order. Use the documented defaults, validation rules, and ProblemIR lowering exactly as shown; do not replace a canonical argument with an unlisted alias. Numerical lengths must be supplied in metres, and invalid positive-length, count, order, periodicity, or topology constraints must fail closed rather than being silently repaired.

## Control Room workflow

In Control Room, select the engine and mesh workflow, enter the same values as the Python authoring example, inspect the planned mesh or grid report, and only then submit the run. The UI is a projection of the public contract: a missing control is not evidence that the backend accepts the option, and a visible control is not evidence that a production lane is enabled. When the page or capability register marks a field partial or not evaluated, keep the workflow explicitly bounded to the implemented path.

## Diagnostics and failure semantics

A valid request must preserve the declared geometry, units, element or cell topology, and backend lane. Reject non-finite or non-positive lengths, invalid counts and orders, incompatible periodic or shared-boundary data, and unsupported topology combinations at the owning validation layer. Reports should retain requested and resolved values, source identity, and any capability gate. No diagnostic may hide a failed mesh realization by substituting another discretization.

## Where this is implemented

The existing implementation-mapping and source-code-index sections identify the exact public authoring, ProblemIR, planner, realization, and runtime owners for this topic. The adjacent `.source-map.json` file is the machine-readable source of truth for those paths, symbols, responsibilities, backend matrix, and reviewed revision. Claims in this page must be updated together with that map when an owner moves.
