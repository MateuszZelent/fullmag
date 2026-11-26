---
title: "Imported geometry and FEM mesh assets"
description: "The supported study-level imported mesh contract is `FEM(mesh=...)`, not a per-object source recipe."
summary: "The supported study-level imported mesh contract is `FEM(mesh=...)`, not a per-object source recipe."
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-11-26
reviewed_revision: 752450f8d259ab97c76c36fe666d5474b02abe9a
source_of_truth: "current public authoring, ProblemIR lowering, STL shell cavity and ownership preservation, mesh realization, and build report"
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
| $\mathbf{m}_h$ | discrete magnetization field | $1$ |
| $\mathbf{m}_i$ | nodal magnetization coefficient | $1$ |
| $\phi_i$ | finite-element basis function | $1$ |

(imported-mesh-assumptions-and-validity)=
## Assumptions and validity

The mesh path is study-level and must be nonempty. The current lazy Rust planner accepts `.json` MeshIR sources and validates them for execution. Python asset realization can dispatch supported file readers, but arbitrary formats, units, region ownership, or topology are not inferred safely.

(imported-mesh-python-api)=
## Python API

The table is exhaustive for this public family entry point. Alias rows are alternatives, not extra simultaneous requirements.

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `FEM.order` | `int` | `required` | $1$ | integer >= 1 | FEM solution-space order | FEM CPU source-backed; FEM GPU capability-gated | `backend_policy.discretization_hints.fem.order` |
| `FEM.maximum_element_size` | `float` | `required` | $\mathrm{m}$ | finite and > 0 | required FEM size hint even with a mesh source | FEM CPU source-backed; FEM GPU capability-gated | `backend_policy.discretization_hints.fem.hmax` |
| `FEM.hmax` | `float \| None` | `None` | $\mathrm{m}$ | alias; must equal maximum_element_size if both are supplied | maximum size alias | FEM CPU source-backed; FEM GPU capability-gated | `backend_policy.discretization_hints.fem.hmax` |
| `FEM.mesh` | `str \| None` | `None` | $1$ | nonempty path when supplied | study-level pre-built mesh source | FEM CPU source-backed; FEM GPU capability-gated | `backend_policy.discretization_hints.fem.mesh` |

```python
# %% imports
import fullmag as fm
from pathlib import Path

nm = 1.0e-9

# %% stage-first study-level imported mesh hint
study = fm.study("imported_mesh_reference")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.universe(mode="manual", size=(800 * nm, 400 * nm, 300 * nm))
study.universe.mesh(maximum_element_size=100 * nm)

body = study.geometry(fm.Box(300 * nm, 100 * nm, 5 * nm), name="film")
body.Ms = 800.0e3
body.Aex = 13.0e-12
body.m = fm.texture.uniform(1.0, 0.0, 0.0)

mesh_path = Path("meshes/ferromagnet.json")
mesh_kwargs = {
    "order": 1,
    "maximum_element_size": 2e-9,
}
if mesh_path.is_file():
    mesh_kwargs["source"] = str(mesh_path)
study.objects.mesh.defaults(
    **mesh_kwargs,
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

`realize_fem_mesh_asset` prefers `hints.mesh` and dispatches `generate_mesh_from_file`; the Rust planner `load_mesh_from_source` loads `.json`, deserializes MeshIR, and runs execution validation. For imported STL surface geometry meshed into 3D FEM volumes, `classify_closed_shells` (`_stl_shells.py`) and `recover_shell_topology` (`_gmsh_stl_shells.py`) classify closed nested shells (preserving internal cavities via winding-number nesting and bounding-volume intersection checks) and retain exact per-component source-surface ownership; `_reject_anonymous_import_fallback` (`asset_pipeline.py`) blocks fallback to anonymous concatenated STL whenever multi-component ownership would be lost. The realized topology and markers, not the file extension or `hmax` hint, determine backend consumption.

| Solver | Device | Status | Reason / Limit |
| --- | --- | --- | --- |
| FEM | CPU | implemented (scope-gated) | Study-level `.json` MeshIR import plus cavity- and component-preserving STL meshing (`classify_closed_shells`, `recover_shell_topology`) |
| FEM | GPU | capability-gated | Consumes validated MeshIR subject to realized cell families and operator support |
| FDM | CPU | not applicable | Structured Cartesian FDM grids do not consume imported FEM MeshIR assets |
| FDM | GPU | not applicable | Structured Cartesian FDM grids do not consume imported FEM MeshIR assets |

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
| [`packages/fullmag-py/src/fullmag/model/discretization.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/discretization.py#L484) | [`class FEM`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/discretization.py#L484) | Supported study-level mesh path and IR. |
| [`packages/fullmag-py/src/fullmag/model/discretization.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/discretization.py#L694) | [`class PerObjectMeshRecipe`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/discretization.py#L694) | Fail-closed rejection of per-object source. |
| [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L8546) | [`_resolve_flat_fem_hint`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L8546) | Study-level FEM hint and shared source resolution. |
| [`packages/fullmag-py/src/fullmag/meshing/_gmsh_generators.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/_gmsh_generators.py#L1084) | [`generate_mesh_from_file`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/_gmsh_generators.py#L1084) | Python imported-file dispatch. |
| [`packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py#L1436) | [`realize_fem_mesh_asset`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py#L1436) | Imported asset preference and validation. |
| [`crates/fullmag-plan/src/mesh.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-plan/src/mesh.rs#L2974) | [`load_mesh_from_source`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-plan/src/mesh.rs#L2974) | Lazy planner JSON MeshIR loading and validation. |
| [`crates/fullmag-plan/src/fem.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-plan/src/fem.rs#L4287) | [`plan_fem`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-plan/src/fem.rs#L4287) | Validated MeshIR consumption and FEM plan construction. |
| [`crates/fullmag-runner/src/dispatch.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/dispatch.rs#L2440) | [`execute_fem_with_context_in_mode`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/dispatch.rs#L2440) | Production plan normalization and CPU/GPU native execution routing. |
| [`crates/fullmag-runner/src/dispatch.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/dispatch.rs#L3509) | [`execute_native_fem`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/dispatch.rs#L3509) | Configuration-selected native CPU/GPU execution implementation. |
| [`packages/fullmag-py/src/fullmag/meshing/_stl_shells.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/_stl_shells.py#L272) | [`classify_closed_shells`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/_stl_shells.py#L272) | Winding-number nesting and cavity classification for closed STL shells. |
| [`packages/fullmag-py/src/fullmag/meshing/_gmsh_stl_shells.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/_gmsh_stl_shells.py#L54) | [`recover_shell_topology`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/_gmsh_stl_shells.py#L54) | Preserves STL shell cavities and per-component ownership in Gmsh. |
| [`packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py#L272) | [`_reject_anonymous_import_fallback`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py#L272) | Prevents multi-component STL fallback to anonymous concatenated shells. |
| [`crates/fullmag-runner/src/dispatch.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/dispatch.rs#L3363) | [`apply_native_fem_runtime_contract`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/dispatch.rs#L3363) | Populates runtime provenance fields after observations exist; returns `()`. |
