---
title: "Imported geometry and FEM mesh assets"
description: "The supported study-level imported mesh contract is `FEM(mesh=...)`, not a per-object source recipe."
summary: "The supported study-level imported mesh contract is `FEM(mesh=...)`, not a per-object source recipe."
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-31
reviewed_revision: 969efa0941905825ac569d525f4bdaefc059e2af
source_of_truth: "current public authoring, ProblemIR lowering, mesh realization, and build report"
---

(public-docs-numerical-methods-meshing-fem-ferromagnet-imported-mesh)=
# Imported ferromagnet FEM mesh

(imported-mesh-problem-statement)=
## Problem statement

The supported study-level imported mesh contract is `FEM(mesh=...)`, not a per-object source recipe.

(imported-mesh-governing-equations)=
## Governing equations

```{math}
:label: eq-imported-mesh-contract
\mathbf{m}_h|_K=\sum_i\mathbf{m}_i\phi_i.
```

(imported-mesh-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
| --- | --- | --- |
| $\mathbf{m}_h$ | discrete magnetization field | 1 |
| $\mathbf{m}_i$ | nodal magnetization coefficient | 1 |
| $\phi_i$ | finite-element basis function | 1 |

(imported-mesh-assumptions-and-validity)=
## Assumptions and validity

The mesh path is study-level and must be nonempty. The current lazy Rust planner accepts `.json` MeshIR sources and validates them for execution. Python asset realization can dispatch supported file readers, but arbitrary formats, units, region ownership, or topology are not inferred safely.

(imported-mesh-python-api)=
## Python API

The table is exhaustive for this public family entry point. Alias rows are alternatives, not extra simultaneous requirements.

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `FEM.order` | `int` | `required` | 1 | integer >= 1 | FEM solution-space order | FEM CPU source-backed; FEM GPU capability-gated | `backend_policy.discretization_hints.fem.order` |
| `FEM.maximum_element_size` | `float` | `required` | m | finite and > 0 | required FEM size hint even with a mesh source | FEM CPU source-backed; FEM GPU capability-gated | `backend_policy.discretization_hints.fem.hmax` |
| `FEM.hmax` | `float \| None` | `None` | m | alias; must equal maximum_element_size if both are supplied | maximum size alias | FEM CPU source-backed; FEM GPU capability-gated | `backend_policy.discretization_hints.fem.hmax` |
| `FEM.mesh` | `str \| None` | `None` | 1 | nonempty path when supplied | study-level pre-built mesh source | FEM CPU source-backed; FEM GPU capability-gated | `backend_policy.discretization_hints.fem.mesh` |

```python
# %% imports
import fullmag as fm

# %% stage-first study-level imported mesh hint
study = fm.study("imported_mesh_reference")
study.engine("fem")
study.objects.mesh.defaults(
    order=1,
    maximum_element_size=2e-9,
    source="meshes/ferromagnet.json",
)

# The typed FEM value is the same study-level contract in isolation.
fem = fm.FEM(order=1, maximum_element_size=2e-9, mesh="meshes/ferromagnet.json")
fem_ir = fem.to_ir()
study.stages.add_relax(stage_id="equilibrium", dt=5.0e-13, max_steps=1)
```

(imported-mesh-problem-ir)=
## ProblemIR

`FEM.to_ir()` emits `{order, hmax, mesh}` under `backend_policy.discretization_hints.fem`. The flat study resolver also constructs `FEM(mesh=shared_source)` for a shared study source. Per-object `source` is not this contract: `PerObjectMeshRecipe.__post_init__` and `GeometryMeshHandle.configure` reject it and direct users to `FEM(mesh=...)`.

(imported-mesh-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

**Requested intent** is `FEM(order, maximum_element_size or hmax, mesh)`. **Resolved execution** is the loaded and validated MeshIR consumed by the FEM plan. **Validation errors** include missing/nonpositive size, order below one, empty path, unreadable JSON, malformed MeshIR, or invalid execution topology. **Unsupported combinations** fail closed: the current lazy planner accepts only `.json` mesh assets and reports other suffixes; it does not remesh or silently reinterpret them.

(imported-mesh-discrete-realization)=
## Discrete realization

`realize_fem_mesh_asset` prefers `hints.mesh` and dispatches `generate_mesh_from_file`; the Rust planner `load_mesh_from_source` loads `.json`, deserializes MeshIR, and runs execution validation. The realized topology and markers, not the file extension or hmax hint, determine backend consumption.

(imported-mesh-implementation-mapping)=
## Implementation mapping

The source index maps public authoring, lowering, realization, reporting, and backend consumption. Source-backed FEM CPU support does not imply that every requested topology is supported; FEM GPU remains capability-gated by the realized mesh and active runtime.

### FEM CPU/GPU plan and runtime consumption

`plan_fem` resolves the domain or per-object mesh asset, validates typed MeshIR and region ownership, and places that mesh in `FemPlanIR`; this is the planning consumer after Python realization. The production runner enters `execute_fem_with_context_in_mode`, normalizes the FEM plan, resolves CPU/GPU behavior, and calls the configuration-selected `execute_native_fem` implementation for native execution. `apply_native_fem_runtime_contract` is not a gate: after runtime observations exist, it returns `()` and only populates `ExecutionProvenance` fields such as execution mode, qualification status, data residency, CUDA-kernel use, GPU Poisson use, and hot-loop synchronization counts. A source-backed Python mesh build is therefore not itself CPU or GPU runtime proof; actual execution and its populated provenance provide that evidence.
(imported-mesh-validation)=
## Validation

Confirm source identity, requested and actual methods, typed cell families, complete region/boundary markers, zero inverted or degenerate cells, and the relevant quality distributions. Then refine the controlling size or layer count while holding geometry, materials, solver tolerances, and outputs fixed, and require convergence of a physical observable.

(imported-mesh-limitations)=
## Limitations

There is no supported `fm.PerObjectMeshRecipe(source=...)` route. The `maximum_element_size` value remains a required FEM hint but does not rewrite an already loaded mesh. This page makes no automatic repair, unit conversion, marker synthesis, or topology conversion claim.

(imported-mesh-scientific-bibliography)=
## Scientific bibliography

- C. Geuzaine and J.-F. Remacle, "Gmsh: a three-dimensional finite element mesh generator with built-in pre- and post-processing facilities," *International Journal for Numerical Methods in Engineering* **79** (2009), 1309-1331, [doi:10.1002/nme.2579](https://doi.org/10.1002/nme.2579).
- C. Abert, "Micromagnetics and spintronics: models and numerical methods," *European Physical Journal B* **92**, 120 (2019), [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).

(imported-mesh-source-code-index)=
## Source-code index

| Repository path | Stable symbol | Responsibility |
| --- | --- | --- |
| `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FEM` | Supported study-level mesh path and IR. |
| `packages/fullmag-py/src/fullmag/model/discretization.py` | `class PerObjectMeshRecipe` | Fail-closed rejection of per-object source. |
| `packages/fullmag-py/src/fullmag/world.py` | `_resolve_flat_fem_hint` | Study-level FEM hint and shared source resolution. |
| `packages/fullmag-py/src/fullmag/meshing/_gmsh_generators.py` | `generate_mesh_from_file` | Python imported-file dispatch. |
| `packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py` | `realize_fem_mesh_asset` | Imported asset preference and validation. |
| `crates/fullmag-plan/src/mesh.rs` | `load_mesh_from_source` | Lazy planner JSON MeshIR loading and validation. |
| `crates/fullmag-plan/src/fem.rs` | `plan_fem` | Validated MeshIR consumption and FEM plan construction. |
| `crates/fullmag-runner/src/dispatch.rs` | `execute_fem_with_context_in_mode` | Production plan normalization and CPU/GPU native execution routing. |
| `crates/fullmag-runner/src/dispatch.rs` | `execute_native_fem` | Configuration-selected native CPU/GPU execution implementation. |
| `crates/fullmag-runner/src/dispatch.rs` | `apply_native_fem_runtime_contract` | Populates runtime provenance fields after observations exist; returns `()`. |


## Scope and purpose

This page defines the public contract for imported FEM mesh assets. It is an authoring and implementation reference: the Python example, the serialized ProblemIR description, the implementation mapping, and the adjacent source map are the source-backed contract. A capability marked partial or not evaluated is not presented as a production guarantee.

## Scientific and numerical model

The mesh or grid is a discrete approximation of the continuous domain. For a Cartesian partition, each spacing satisfies `Delta_i = L_i / N_i`; for a geometry-dependent FEM mesh, the requested local target is bounded by the active bulk, interface, boundary, and topology constraints. In compact form, `h_target(x) = min(h_bulk(x), h_interface(x), h_boundary(x))`. Length quantities use SI metres (`m`); counts, orders, and topology labels are dimensionless.

The equations and assumptions in the earlier physical-problem and governing-equations sections state the model-specific specialization. This section does not introduce a conversion from FEM to FDM, a hidden topology conversion, or a silent CPU fallback.

## Parameters

The exact callable and argument names are the ones shown in the `## Python API` section above. For this page the parameter family is mesh path, FEM order, and imported-mesh validation. Use the documented defaults, validation rules, and ProblemIR lowering exactly as shown; do not replace a canonical argument with an unlisted alias. Numerical lengths must be supplied in metres, and invalid positive-length, count, order, periodicity, or topology constraints must fail closed rather than being silently repaired.

## Control Room workflow

In Control Room, select the engine and mesh workflow, enter the same values as the Python authoring example, inspect the planned mesh or grid report, and only then submit the run. The UI is a projection of the public contract: a missing control is not evidence that the backend accepts the option, and a visible control is not evidence that a production lane is enabled. When the page or capability register marks a field partial or not evaluated, keep the workflow explicitly bounded to the implemented path.

## Diagnostics and failure semantics

A valid request must preserve the declared geometry, units, element or cell topology, and backend lane. Reject non-finite or non-positive lengths, invalid counts and orders, incompatible periodic or shared-boundary data, and unsupported topology combinations at the owning validation layer. Reports should retain requested and resolved values, source identity, and any capability gate. No diagnostic may hide a failed mesh realization by substituting another discretization.

## Where this is implemented

The existing implementation-mapping and source-code-index sections identify the exact public authoring, ProblemIR, planner, realization, and runtime owners for this topic. The adjacent `.source-map.json` file is the machine-readable source of truth for those paths, symbols, responsibilities, backend matrix, and reviewed revision. Claims in this page must be updated together with that map when an owner moves.