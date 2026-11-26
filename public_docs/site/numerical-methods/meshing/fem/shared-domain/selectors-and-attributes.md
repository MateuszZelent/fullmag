---
title: "Mesh selectors, markers and semantic attributes"
description: "Stable semantic targeting of surfaces, curves, regions, compact canonical FEM markers, and periodic/interface roles."
summary: "Mesh operations should target semantic geometry ownership and roles rather than ephemeral Gmsh tags. Fullmag resolves selectors during each build, derives facet roles, and maps canonical semantic markers to compact positive MFEM attributes."
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-11-26
reviewed_revision: 752450f8d259ab97c76c36fe666d5474b02abe9a
source_of_truth: "mesh_controls selector descriptors, Gmsh selector recovery, physical groups, facet roles, CompactMarkerMap and shared-domain manifest"
---

(public-docs-numerical-methods-meshing-fem-shared-domain-selectors-and-attributes)=
# Mesh selectors, markers and semantic attributes

Mesh operations should target semantic geometry ownership and roles rather than ephemeral Gmsh tags. Fullmag resolves selectors during each build, derives solver-facing facet roles from cell adjacency, and compacts arbitrary canonical FEM markers onto contiguous positive MFEM attributes at native ingress.

::::{admonition} Implementation status
:class: important

Nearest surface/curve selectors, geometry-scoped fields, all-boundary-curve selection, canonical semantic physical markers, derived facet roles, and native compact canonical marker mapping (`CompactMarkerMap`) are implemented.
::::

(selectors-problem-statement)=
## Problem statement

Numeric Gmsh entity tags are build-session identifiers that can change after CSG edits, transforms, or remeshing. Selectors preserve rebuildable spatial/ownership intent (`point`, `geometry`, `count`) until Gmsh entities exist, then resolve into tags and diagnostic reports. On the solver side, canonical semantic domain and boundary markers (including canonical `0` for air) are separated from raw MFEM 1-based array indices through per-mesh compact marker maps (`CompactMarkerMap`).

(selectors-governing-equations)=
## Governing equations

Each selector descriptor $S_k$ maps the realized geometry model $G$ and geometric tolerance $\tau$ to a matched entity set, and combined targeting takes the deduplicated union:

```{math}
:label: eq-selector-resolution-fem-shared-domain-selectors-and-attributes

S:(G,\tau)\mapsto\{e_1,\ldots,e_n\},
```

```{math}
:label: eq-selector-contract

T=\operatorname{unique}\!\left(\bigcup_k T_k\right).
```

(selectors-symbols-and-si-units)=
## Symbols and SI units

| Token | Meaning | SI unit |
| --- | --- | --- |
| $T$ | resolved unique entity-tag set | $1$ |
| $T_k$ | tags selected by descriptor $k$ | $1$ |
| $S$ | semantic entity selector mapping | $1$ |
| $G$ | realized geometry model at build revision | $1$ |
| $\tau$ | geometric matching tolerance | $\mathrm{m}$ |
| $e_j$ | matched geometric entity identifier | $1$ |
| $n$ | matched selector cardinality | $1$ |

(selectors-assumptions-and-validity)=
## Assumptions and validity

- Selector resolution executes only after Gmsh realizes entities; descriptor kind must match the requested topological dimension (`surface` vs `curve`).
- `nearest_surface_to_point` and `nearest_curve_to_point` minimize geometric distance to a supplied SI point, optionally scoped to one named geometry; because symmetry can make multiple entities equidistant, `count` is part of the contract.
- **Compact canonical FEM markers (`CompactMarkerMap`, `FemMarkerMaps`):** Canonical semantic marker labels (unsigned 32-bit IDs, including `0` for air and arbitrary non-contiguous user/imported markers) are never used directly as dense MFEM attribute indices. Each imported native mesh builds two bijective compact maps (`domain` and `boundary`) sorting distinct canonical markers into contiguous positive MFEM attributes `1..K`—rotating canonical `0` to the end—so MFEM attribute `0` remains exclusively the absent-attribute sentinel while canonical `0` remains valid for air.
- Facet roles (`outer`, `interface`, `periodic`, `provisional`) are derived from volume adjacency and semantic markers (`_derive_facet_roles`), never inferred from viewport color or coordinates.

### Selection guide

| Use case | Recommended choice | Reason |
| --- | --- | --- |
| Stable object-wide field | Geometry name / role selector | Survives tag renumbering across rebuilds |
| Specific face near known coordinate | `fm.mesh.nearest_surface_to_point` | Rebuildable spatial intent with explicit cardinality `count` |
| Specific edge or corner neighborhood | `fm.mesh.nearest_curve_to_point` or all-boundary-curves | Targets edge refinement or boundary layers |
| Imported physical group | Physical name / canonical marker | Preserves upstream ownership and compacts cleanly via `CompactMarkerMap` |
| Periodic pair | Semantic source/destination markers | Stable pair identity and translation certificate |

(selectors-python-api)=
## Python API

### Complete public signature and IR matrix

The following rows document the public signature and `ProblemIR` contract for selector constructors and selector-bearing boundary-layer controls.

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `point` | `Sequence[object]` | required | $\mathrm{m}$ | each component is converted with `float()`; resulting list must have length three; no finite check | nearest-query point | FEM CPU/GPU capability-gated | `mesh.selectors[].point` |
| `geometry` | `object \| None` | `None` | $1$ | when supplied, exactly `str(value).strip()`; empty result raises `ValueError` | restrict candidate component | FEM CPU/GPU capability-gated | `mesh.selectors[].geometry` |
| `count` | `object` | `1` | $1$ | exactly `int(value)`; result must be at least 1 or `ValueError` | number passed to closest-entity query | FEM CPU/GPU capability-gated | `mesh.selectors[].count` |
| `boundary_layer_count` | `int \| None` | `None` | $1$ | `int()` coercion and at least 1 | boundary-layer count receiving the selector | FEM CPU/GPU capability-gated | `mesh_workflow.per_geometry[].boundary_layer_count` |
| `boundary_layer_thickness` | `float \| None` | `None` | $\mathrm{m}$ | positive | boundary-layer thickness receiving the selector | FEM CPU/GPU capability-gated | `mesh_workflow.per_geometry[].boundary_layer_thickness` |
| `boundary_layer_stretching` | `float \| None` | `None` | $1$ | positive | boundary-layer growth receiving the selector | FEM CPU/GPU capability-gated | `mesh_workflow.per_geometry[].boundary_layer_stretching` |
| `boundary_layer_target_surface_selectors` | `Sequence[Mapping] \| None` | `None` | $1$ | normalized by `_normalize_selector_list`; resolved after mesh realization | attach semantic surface selector to the policy | FEM CPU/GPU capability-gated | `mesh_workflow.per_geometry[].boundary_layer_target_surface_selectors` |

`fm.mesh.nearest_surface_to_point` and `fm.mesh.nearest_curve_to_point` both take keyword-only `point`, `geometry=None`, `count=1` and return a descriptor dictionary.

```python
# %% Semantic surface and curve selectors
import fullmag as fm

nm = 1.0e-9
top_surface = fm.mesh.nearest_surface_to_point(point=(0.0, 0.0, 2.5 * nm), geometry=" film ", count=1)
end_edge = fm.mesh.nearest_curve_to_point(point=(50.0 * nm, 25.0 * nm, 2.5 * nm), geometry="film", count=1)

# %% Stage-first study attaching semantic selectors to boundary-layer policy
study = fm.study("selector_contract")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.universe(mode="manual", size=(240 * nm, 140 * nm, 100 * nm), center=(0.0, 0.0, 0.0))
study.universe.mesh(maximum_element_size=30 * nm, minimum_element_size=6 * nm, maximum_element_growth_rate=1.4)
film = study.geometry(fm.Box(size=(100 * nm, 50 * nm, 5 * nm), name="film"), name="film")
film.mesh(
    maximum_element_size=8 * nm,
    minimum_element_size=3 * nm,
    boundary_layer_count=2,
    boundary_layer_thickness=1 * nm,
    boundary_layer_stretching=1.2,
    boundary_layer_target_surface_selectors=[top_surface],
    boundary_layer_target_curve_selectors=[end_edge],
    order=1,
    compute_quality=True,
)
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.texture.uniform(1.0, 0.0, 0.0)
study.exchange()
study.demag(realization="poisson_robin")
study.stages.add_relax(stage_id="equilibrium", dt=5.0e-13, max_steps=1)
```

(selectors-problem-ir)=
## ProblemIR

Selector descriptors lower verbatim into `mesh.selectors[]` and `mesh_workflow.per_geometry[].boundary_layer_target_*_selectors`. Resolved entity tags, candidate counts, distances, closest points, derived facet roles, and compact native MFEM attribute indices are resolved build/runtime provenance, not durable user-authored IR.

(selectors-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

- **Requested intent:** The semantic selector descriptor (`kind`, `point`, `geometry`, `count`) and canonical physical names.
- **Resolved execution:** The deduplicated tag set $T$, selector diagnostic report, derived facet roles (`_derive_facet_roles`), and compact MFEM attributes (`CompactMarkerMap`, revision `1`).
- **Validation errors:** Non-dictionary selectors, wrong dimension kind, invalid point length or count (`< 1`), blank geometry name, zero matches, or distinct canonical marker counts exceeding the positive MFEM `int` attribute range.
- **Unsupported combinations:** Dimension/kind mismatches are rejected rather than reinterpreted as raw Gmsh tags; raw canonical markers are never indexed directly into MFEM attribute arrays without passing through `CompactMarkerMap`.

(selectors-discrete-realization)=
## Discrete realization

| Solver | Device | Status | Reason / Limit |
| --- | --- | --- | --- |
| FEM | CPU | implemented | Semantic selector recovery, derived facet roles, and native `CompactMarkerMap` attribute compaction |
| FEM | GPU | implemented (capability-gated) | Shares the same canonical-to-compact marker mapping (`FemMarkerMaps`) across MFEM and CUDA Poisson/operator assembly |
| FDM | CPU | not applicable | Structured FDM uses cellwise integer region IDs rather than Gmsh entity selectors |
| FDM | GPU | not applicable | Structured FDM uses cellwise integer region IDs rather than Gmsh entity selectors |

### Control Room workflow

Use structured selector editors in `ObjectMeshSpecPanel.tsx` (`ObjectMeshInspectorSpecPanel`); reserve **Advanced JSON** for diagnostics. After building, inspect selector-resolution cardinality, closest-point distances, and derived region/facet role tables in the mesh manifest (`MeshRegionsSpec.tsx`, `SharedDomainMeshSpec.tsx`), and reconfirm selectors after any CSG, transform, or STL edit.

(selectors-implementation-mapping)=
## Implementation mapping

`nearest_surface_to_point`, `nearest_curve_to_point`, `_point3`, `_geometry_name`, and `_selector_count` in `mesh_controls.py` own public descriptor validation; `GeometryMeshHandle` stores selectors in `mesh_workflow`; `_build_problem` and `Problem.to_ir()` lower metadata; `_build_field_stack` consumes selector-bearing refinement fields; `resolve_entity_selectors` resolves Gmsh tags post-realization; `_derive_facet_roles` assigns facet roles; `CompactMarkerMap` (`backends/fem/core/fem_marker_map.hpp`) compacts canonical markers into positive MFEM attributes across native CPU and GPU boundaries; `fullmag_plan::plan` and `run_planned_problem` consume the validated mesh.

(selectors-validation)=
## Validation

Verify selector candidate counts, matched tags, distances, and closest points after geometry rebuilds and harmless tag renumbering; verify that selected fields alter realized local mesh sizes; verify compact marker round-trips (`attribute()` / `canonical()`) including canonical `0` for air and sparse/high-numbered semantic markers across native CPU/GPU FEM contracts (`fem_mesh_contract`, `demag_poisson_contract`, `charge_transport_abi_contract`).

(selectors-limitations)=
## Limitations

- Resolved Gmsh entity tags are build-session artifacts, never durable authoring identities.
- Symmetric geometries can swap nearest entities under tiny coordinate perturbations; use stronger geometric roles or explicit `count` where symmetry is present.
- Imported air names normalize to canonical marker `0`; check for collisions with upstream custom marker numbering.

(selectors-scientific-bibliography)=
## Scientific bibliography

- C. Geuzaine and J.-F. Remacle, “Gmsh: a three-dimensional finite element mesh generator with built-in pre- and post-processing facilities,” *International Journal for Numerical Methods in Engineering* **79** (2009), 1309–1331, [doi:10.1002/nme.2579](https://doi.org/10.1002/nme.2579).
- C. Abert, “Micromagnetics and spintronics: models and numerical methods,” *European Physical Journal B* **92**, 120 (2019), [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).

## Related documentation

- [Refinement](../../refinement.md)
- [Boundary layers](../ferromagnet/boundary-layers.md)
- [Periodic airbox](../airbox/periodic-airbox.md)

(selectors-source-code-index)=
## Source-code index

| ID | Path | Symbol | Responsibility | Evidence |
| --- | --- | --- | --- | --- |
| selectors | [`packages/fullmag-py/src/fullmag/meshing/_gmsh_selectors.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/_gmsh_selectors.py#L79) | [`resolve_entity_selectors`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/_gmsh_selectors.py#L79) | post-realization semantic selection | source-inspected |
| public_study | [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L7610) | [`study`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L7610) | public study entry point | source-inspected |
| mesh_authoring | [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L1679) | [`class GeometryMeshHandle`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L1679) | selector-bearing mesh authoring | source-inspected |
| nearest_surface | [`packages/fullmag-py/src/fullmag/meshing/mesh_controls.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/mesh_controls.py#L36) | [`nearest_surface_to_point`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/mesh_controls.py#L36) | public surface-selector constructor | source-inspected |
| nearest_curve | [`packages/fullmag-py/src/fullmag/meshing/mesh_controls.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/mesh_controls.py#L52) | [`nearest_curve_to_point`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/mesh_controls.py#L52) | public curve-selector constructor | source-inspected |
| selector_point_coercion | [`packages/fullmag-py/src/fullmag/meshing/mesh_controls.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/mesh_controls.py#L28) | [`_point3`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/mesh_controls.py#L28) | point-vector float coercion | source-inspected |
| selector_geometry_coercion | [`packages/fullmag-py/src/fullmag/meshing/mesh_controls.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/mesh_controls.py#L21) | [`_geometry_name`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/mesh_controls.py#L21) | geometry-name strip/non-empty validation | source-inspected |
| selector_count_coercion | [`packages/fullmag-py/src/fullmag/meshing/mesh_controls.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/mesh_controls.py#L32) | [`_selector_count`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/mesh_controls.py#L32) | positive integer cardinality validation | source-inspected |
| compact_markers | [`backends/fem/core/fem_marker_map.hpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/core/fem_marker_map.hpp#L17) | [`class CompactMarkerMap`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/core/fem_marker_map.hpp#L17) | bijective canonical-to-MFEM compact marker mapping across native boundaries | verified |
| facet_roles | [`packages/fullmag-py/src/fullmag/meshing/_gmsh_extraction.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/_gmsh_extraction.py#L667) | [`_derive_facet_roles`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/_gmsh_extraction.py#L667) | solver-facing facet-role derivation | source-inspected |
| problem_lowering | [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L10324) | [`_build_problem`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L10324) | builder-state lowering | source-inspected |
| problem_ir | [`packages/fullmag-py/src/fullmag/model/problem.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/problem.py#L2733) | [`class Problem`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/problem.py#L2733) | ProblemIR mesh-workflow serialization | source-inspected |
| field_stack | [`packages/fullmag-py/src/fullmag/meshing/_size_field_plan.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/_size_field_plan.py#L1179) | [`_build_field_stack`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/_size_field_plan.py#L1179) | selector-bearing field composition | source-inspected |
| domain_realization | [`packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py#L4283) | [`realize_fem_domain_mesh_asset_from_components_with_report`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py#L4283) | shared-domain realization and report | source-inspected |
| planner | [`crates/fullmag-plan/src/lib.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-plan/src/lib.rs#L183) | [`plan`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-plan/src/lib.rs#L183) | ProblemIR planning and compatibility | verified |
| runtime | [`crates/fullmag-runner/src/lib.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/lib.rs#L3784) | [`run_planned_problem`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/lib.rs#L3784) | planned runtime dispatch | verified |
| object_policy_ui | [`apps/control-room/src/modules/inspector/panels/mesh-details/ObjectMeshSpecPanel.tsx`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/apps/control-room/src/modules/inspector/panels/mesh-details/ObjectMeshSpecPanel.tsx#L180) | [`function ObjectMeshInspectorSpecPanel`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/apps/control-room/src/modules/inspector/panels/mesh-details/ObjectMeshSpecPanel.tsx#L180) | Control Room object policy and selector controls | source-inspected |
