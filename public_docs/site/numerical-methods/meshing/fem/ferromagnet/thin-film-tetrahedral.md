---
title: "Thin-film tetrahedral ferromagnet mesh"
description: "The public `object.mesh.thin_film(...)` contract for thickness-aware tetrahedral meshing and its explicit strict-prism branch."
summary: "The public `object.mesh.thin_film(...)` contract for thickness-aware tetrahedral meshing and its explicit strict-prism branch."
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-31
reviewed_revision: 969efa0941905825ac569d525f4bdaefc059e2af
source_of_truth: "current public authoring, ProblemIR lowering, mesh realization, and build report"
---

(public-docs-numerical-methods-meshing-fem-ferromagnet-thin-film-tetrahedral)=
# Thin-film tetrahedral ferromagnet mesh

(thin-film-tetrahedral-problem-statement)=
## Problem statement

The public `object.mesh.thin_film(...)` contract for thickness-aware tetrahedral meshing and its explicit strict-prism branch.

(thin-film-tetrahedral-governing-equations)=
## Governing equations

```{math}
:label: eq-thin-film-tetrahedral-contract
h_t\approx\frac{t}{N_t}.
```

(thin-film-tetrahedral-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
| --- | --- | --- |
| $t$ | film thickness | m |
| $N_t$ | requested through-thickness count | 1 |
| $h_t$ | nominal thickness spacing | m |

(thin-film-tetrahedral-assumptions-and-validity)=
## Assumptions and validity

The body needs a meaningful thin direction. `layers` is a nominal tetrahedral spacing request unless the prismatic branch produces and certifies exact layers. Thickness and in-plane refinement both require convergence checks.

(thin-film-tetrahedral-python-api)=
## Python API

The table is exhaustive for this public family entry point. Alias rows are alternatives, not extra simultaneous requirements.

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `hmax` | `float \| str \| None` | `None` | m | positive length or auto; alias | body maximum-size alias | FEM CPU source-backed; FEM GPU capability-gated | `mesh_workflow.per_geometry[].hmax` |
| `maximum_element_size` | `float \| str \| None` | `None` | m | positive length or auto | body maximum size | FEM CPU source-backed; FEM GPU capability-gated | `mesh_workflow.per_geometry[].maximum_element_size` |
| `hmin` | `float \| None` | `None` | m | positive length; alias | body minimum-size alias | FEM CPU source-backed; FEM GPU capability-gated | `mesh_workflow.per_geometry[].hmin` |
| `minimum_element_size` | `float \| None` | `None` | m | positive length | body minimum size | FEM CPU source-backed; FEM GPU capability-gated | `mesh_workflow.per_geometry[].minimum_element_size` |
| `order` | `int \| None` | `None` | 1 | integer; prismatic topology permits only 1 | FEM order | FEM CPU source-backed; FEM GPU capability-gated | `mesh_workflow.per_geometry[].order` |
| `curvature_factor` | `float \| None` | `None` | 1 | finite and > 0 | curvature refinement | FEM CPU source-backed; FEM GPU capability-gated | `mesh_workflow.per_geometry[].curvature_factor` |
| `narrow_region_resolution` | `float \| None` | `None` | 1 | finite and > 0 | narrow-region refinement | FEM CPU source-backed; FEM GPU capability-gated | `mesh_workflow.per_geometry[].narrow_region_resolution` |
| `layers` | `int` | `1` | 1 | integer >= 1 | through-thickness element count | FEM CPU source-backed; FEM GPU capability-gated | `mesh_workflow.per_geometry[].through_thickness_elements` |
| `topology` | `Literal["tetrahedral", "prismatic"] \| None` | `None` | 1 | one of the two values | tetrahedral route or strict prism request | FEM CPU source-backed; FEM GPU capability-gated | `mesh_workflow.per_geometry[].mesh_strategy` |
| `exact_layers` | `bool \| None` | `None` | 1 | requires prismatic; strict mode rejects False | exact prism-layer requirement | FEM CPU source-backed; FEM GPU capability-gated | `mesh_workflow.per_geometry[].exact_layer_count` |
| `transition` | `Literal["pyramid_to_tetrahedra", "reject"] \| None` | `None` | 1 | prismatic requires pyramid_to_tetrahedra | shared-domain transition request | FEM CPU source-backed; FEM GPU capability-gated | `mesh_workflow.per_geometry[].transition_policy` |
| `interface_maximum_element_size` | `float \| None` | `None` | m | finite and > 0 | interface size | FEM CPU source-backed; FEM GPU capability-gated | `mesh_workflow.per_geometry[].interface_hmax` |
| `surface_maximum_element_size` | `float \| None` | `None` | m | finite and > 0; overrides interface alias | surface size alias | FEM CPU source-backed; FEM GPU capability-gated | `mesh_workflow.per_geometry[].interface_hmax` |
| `interface_thickness` | `float \| None` | `None` | m | finite and > 0 | interface shell | FEM CPU source-backed; FEM GPU capability-gated | `mesh_workflow.per_geometry[].interface_thickness` |
| `surface_thickness` | `float \| None` | `None` | m | finite and > 0; overrides interface alias | surface shell alias | FEM CPU source-backed; FEM GPU capability-gated | `mesh_workflow.per_geometry[].interface_thickness` |
| `transition_distance` | `float \| str \| None` | `None` | m | zero or positive length, or supported automatic value | interface transition | FEM CPU source-backed; FEM GPU capability-gated | `mesh_workflow.per_geometry[].transition_distance` |
| `surface_transition_distance` | `float \| str \| None` | `None` | m | zero or positive length, or supported automatic value | surface transition alias | FEM CPU source-backed; FEM GPU capability-gated | `mesh_workflow.per_geometry[].transition_distance` |
| `edge_maximum_element_size` | `float \| None` | `None` | m | finite and > 0 | edge size | FEM CPU source-backed; FEM GPU capability-gated | `mesh_workflow.per_geometry[].edge_hmax` |
| `edge_thickness` | `float \| None` | `None` | m | finite and > 0 | edge shell | FEM CPU source-backed; FEM GPU capability-gated | `mesh_workflow.per_geometry[].edge_thickness` |
| `edge_transition_distance` | `float \| str \| None` | `None` | m | positive length or supported automatic value | edge transition | FEM CPU source-backed; FEM GPU capability-gated | `mesh_workflow.per_geometry[].edge_transition_distance` |
| `corner_maximum_element_size` | `float \| None` | `None` | m | finite and > 0 | corner size | FEM CPU source-backed; FEM GPU capability-gated | `mesh_workflow.per_geometry[].corner_hmax` |
| `corner_extent` | `float \| None` | `None` | m | finite and > 0 | corner extent | FEM CPU source-backed; FEM GPU capability-gated | `mesh_workflow.per_geometry[].corner_extent` |
| `corner_transition_distance` | `float \| str \| None` | `None` | m | positive length or supported automatic value | corner transition | FEM CPU source-backed; FEM GPU capability-gated | `mesh_workflow.per_geometry[].corner_transition_distance` |

```python
# %% imports
import fullmag as fm

# %% explicit tetrahedral thin-film route
study = fm.study("thin_film_tetrahedral_reference")
study.engine("fem")
film = study.geometry(fm.Box(size=(100e-9, 50e-9, 6e-9)), name="film")
film.mesh.thin_film(
    maximum_element_size=5e-9,
    minimum_element_size=2e-9,
    layers=3,
    topology="tetrahedral",
    surface_maximum_element_size=3e-9,
    surface_thickness=3e-9,
    surface_transition_distance=12e-9,
    edge_maximum_element_size=2e-9,
    edge_thickness=3e-9,
    edge_transition_distance=8e-9,
    corner_maximum_element_size=1.5e-9,
    corner_extent=2e-9,
    corner_transition_distance=6e-9,
    order=1,
)
study.stages.add_relax(stage_id="equilibrium", dt=5.0e-13, max_steps=1)
```

(thin-film-tetrahedral-problem-ir)=
## ProblemIR

For `topology=None` or `"tetrahedral"`, `thin_film` sets `mesh_strategy="thin_film_tetrahedral"`, fixed through-thickness distribution, triangular face meshing, and `through_thickness_elements=layers`; it also resolves inferred body/surface/edge/corner sizes listed below. For `topology="prismatic"`, it sets `mesh_strategy="swept_prism"`, `topology="prismatic"`, `element_family="prism"`, `sweep_direction="auto"`, `exact_layer_count=True` when `exact_layers` is omitted, and `transition_policy="pyramid_to_tetrahedra"` by default. Every serialized value is under the matching `mesh_workflow.per_geometry[]` entry.

### Resolved values generated by `thin_film(...)`

The following values are generated before `_mesh_spec_to_metadata` writes the per-object entry. "Omitted" means the internal resolved value is false/absent and is intentionally not serialized by the sparse metadata encoder.

| Resolved value | Tetrahedral branch | Prismatic branch | ProblemIR destination |
| --- | --- | --- | --- |
| body `hmax` | explicit canonical/alias value, otherwise inherited object value | same | `mesh_workflow.per_geometry[].hmax` and `.maximum_element_size` |
| body `hmin` | explicit/inherited value; if absent and thickness is classified, `thickness / layers` | explicit/inherited size; no tetrahedral thickness inference | `mesh_workflow.per_geometry[].hmin` and `.minimum_element_size` |
| through-thickness elements | `layers` | `layers` | `mesh_workflow.per_geometry[].through_thickness_elements` |
| distribution | `fixed` | `fixed` | `mesh_workflow.per_geometry[].through_thickness_distribution` |
| symmetric grading | resolved `False`, omitted | resolved `False`, omitted | `.through_thickness_symmetric` only when true |
| sweep-face meshing | `triangular` | `triangular` | `mesh_workflow.per_geometry[].sweep_face_meshing` |
| `mesh_strategy` | `thin_film_tetrahedral` | `swept_prism` | `mesh_workflow.per_geometry[].mesh_strategy` |
| `topology` | absent after tetrahedral intent is resolved to the strategy | `prismatic` | `mesh_workflow.per_geometry[].topology` |
| `element_family` | absent | `prism` | `mesh_workflow.per_geometry[].element_family` |
| `sweep_direction` | absent | `auto` | `mesh_workflow.per_geometry[].sweep_direction` |
| `exact_layer_count` | absent | `True` when `exact_layers=None`, otherwise the accepted boolean | `mesh_workflow.per_geometry[].exact_layer_count` |
| transition policy | absent | default/required `pyramid_to_tetrahedra` | `mesh_workflow.per_geometry[].transition_policy` |
| surface/interface `hmax` | `surface_maximum_element_size`, else `interface_maximum_element_size`, else body `hmax` | explicit surface/interface input passed to common configuration | `mesh_workflow.per_geometry[].interface_hmax` |
| surface/interface thickness | `surface_thickness`, else `interface_thickness`, else surface `hmax`, body `hmin`, or classified thickness | explicit surface/interface input | `mesh_workflow.per_geometry[].interface_thickness` |
| surface transition | `surface_transition_distance`, else `transition_distance`, else `8 * surface_hmax` when available | explicit transition input | `mesh_workflow.per_geometry[].transition_distance` |
| edge `hmax` | explicit edge size, else resolved body `hmin` | explicit edge input | `mesh_workflow.per_geometry[].edge_hmax` |
| edge thickness | explicit edge thickness, else resolved surface thickness | explicit edge input | `mesh_workflow.per_geometry[].edge_thickness` |
| edge transition | explicit edge transition, else one half of numeric surface transition (or the same automatic string) | explicit edge input | `mesh_workflow.per_geometry[].edge_transition_distance` |
| corner `hmax` | explicit corner size, else resolved edge `hmax` | explicit corner input | `mesh_workflow.per_geometry[].corner_hmax` |
| corner extent | explicit extent, else resolved edge thickness | explicit corner input | `mesh_workflow.per_geometry[].corner_extent` |
| corner transition | explicit corner transition, else resolved edge transition | explicit corner input | `mesh_workflow.per_geometry[].corner_transition_distance` |
(thin-film-tetrahedral-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

**Requested intent** is the exact `thin_film` call. **Resolved execution** includes the actual method, inferred thickness, realized layer count, topology certificate, and any degradation. **Validation errors** reject `layers < 1`, unknown topology, non-boolean `exact_layers`, prismatic order other than 1, `exact_layers=False` in strict mode, or a transition other than `pyramid_to_tetrahedra`. Numeric interface/surface transition distance may be zero; numeric edge/corner transition distances must be strictly positive. **Unsupported combinations** fail closed; a tetrahedral request is never reported as exact prism layers, and a failed strict-prism certificate has no silent tetrahedral fallback.

(thin-film-tetrahedral-discrete-realization)=
## Discrete realization

The tetrahedral branch explicitly lowers to `mesh_strategy="thin_film_tetrahedral"` and uses ordinary Gmsh tetrahedral extraction plus thickness-aware fields. The prismatic branch classifies sweepability and invokes the swept generator. `_build_thin_film_diagnostics` and the shared-domain report separate requested layers/topology from actual method and certificate.

(thin-film-tetrahedral-implementation-mapping)=
## Implementation mapping

The source index maps public authoring, lowering, realization, reporting, and backend consumption. Source-backed FEM CPU support does not imply that every requested topology is supported; FEM GPU remains capability-gated by the realized mesh and active runtime.

### FEM CPU/GPU plan and runtime consumption

`plan_fem` resolves the domain or per-object mesh asset, validates typed MeshIR and region ownership, and places that mesh in `FemPlanIR`; this is the planning consumer after Python realization. The production runner enters `execute_fem_with_context_in_mode`, normalizes the FEM plan, resolves CPU/GPU behavior, and calls the configuration-selected `execute_native_fem` implementation for native execution. `apply_native_fem_runtime_contract` is not a gate: after runtime observations exist, it returns `()` and only populates `ExecutionProvenance` fields such as execution mode, qualification status, data residency, CUDA-kernel use, GPU Poisson use, and hot-loop synchronization counts. A source-backed Python mesh build is therefore not itself CPU or GPU runtime proof; actual execution and its populated provenance provide that evidence.
(thin-film-tetrahedral-validation)=
## Validation

Confirm source identity, requested and actual methods, typed cell families, complete region/boundary markers, zero inverted or degenerate cells, and the relevant quality distributions. Then refine the controlling size or layer count while holding geometry, materials, solver tolerances, and outputs fixed, and require convergence of a physical observable.

(thin-film-tetrahedral-limitations)=
## Limitations

`layers` does not certify exact tetrahedral planes. Strict prismatic P1 is a distinct branch: order 1, exact layers, triangular sweep faces, prism family, and `pyramid_to_tetrahedra` transition. Use the realized certificate before claiming prism/pyramid/tet mixed topology.

(thin-film-tetrahedral-scientific-bibliography)=
## Scientific bibliography

- C. Geuzaine and J.-F. Remacle, "Gmsh: a three-dimensional finite element mesh generator with built-in pre- and post-processing facilities," *International Journal for Numerical Methods in Engineering* **79** (2009), 1309-1331, [doi:10.1002/nme.2579](https://doi.org/10.1002/nme.2579).
- C. Abert, "Micromagnetics and spintronics: models and numerical methods," *European Physical Journal B* **92**, 120 (2019), [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).

(thin-film-tetrahedral-source-code-index)=
## Source-code index

| Repository path | Stable symbol | Responsibility |
| --- | --- | --- |
| `packages/fullmag-py/src/fullmag/world.py` | `class GeometryMeshHandle` | Public thin_film signature and fail-closed validation. |
| `packages/fullmag-py/src/fullmag/world.py` | `_mesh_spec_to_metadata` | Per-object strategy and topology lowering. |
| `packages/fullmag-py/src/fullmag/world.py` | `_collect_mesh_workflow_metadata` | Generator mesh_options lowering. |
| `packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py` | `classify_sweepability` | Thin-direction and sweepability classification. |
| `packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py` | `generate_swept_mesh` | Strict prism realization. |
| `packages/fullmag-py/src/fullmag/meshing/_gmsh_fields.py` | `_apply_mesh_options` | Tetrahedral option and field application. |
| `packages/fullmag-py/src/fullmag/meshing/mesh_build_report.py` | `_build_thin_film_diagnostics` | Requested versus realized thin-film diagnostics. |
| `packages/fullmag-py/src/fullmag/meshing/mesh_build_report.py` | `_build_shared_domain_build_report` | Actual method, topology, and fallback report. |
| `packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py` | `realize_fem_domain_mesh_asset_from_components_with_report` | Typed domain mesh and report realization. |
| `crates/fullmag-plan/src/fem.rs` | `plan_fem` | Validated MeshIR consumption and FEM plan construction. |
| `crates/fullmag-runner/src/dispatch.rs` | `execute_fem_with_context_in_mode` | Production plan normalization and CPU/GPU native execution routing. |
| `crates/fullmag-runner/src/dispatch.rs` | `execute_native_fem` | Configuration-selected native CPU/GPU execution implementation. |
| `crates/fullmag-runner/src/dispatch.rs` | `apply_native_fem_runtime_contract` | Populates runtime provenance fields after observations exist; returns `()`. |

