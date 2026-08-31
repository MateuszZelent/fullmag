---
title: "Mesh selectors, markers and semantic attributes"
description: "Stable semantic targeting of surfaces, curves, regions and periodic/interface roles."
summary: "Mesh operations should target semantic geometry ownership and roles rather than ephemeral Gmsh tags. Fullmag resolves selectors during each build and records matched entities and attributes in the manifest."
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-24
reviewed_revision: 5db00ccf0113b9756fec2d46feb36ade762b12c2
source_of_truth: "mesh_controls selector descriptors, Gmsh selector recovery, physical groups, facet roles and shared-domain manifest"
---

(public-docs-numerical-methods-meshing-fem-shared-domain-selectors-and-attributes)=
# Mesh selectors, markers and semantic attributes

(selectors-problem-statement)=
## Problem statement

Selectors preserve a semantic point/geometry/count request until Gmsh entities exist, then resolve it into tags and a diagnostic report.

(selectors-governing-equations)=
## Governing equations

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

(selectors-assumptions-and-validity)=
## Assumptions and validity

Resolution runs only after Gmsh realizes entities. A selector kind must match the requested dimension; the source records candidates, tags, distances and closest points rather than promising cardinality from authored intent.

(selectors-python-api)=
## Python API

### Complete public signature and IR matrix

The following rows are the exhaustive public-signature contract for this page; each row mirrors one public_api.parameters entry in the source map.

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| point | Sequence[object] | required | $m$ | each component is converted with float(); resulting list must have length three; no finite check | nearest-query point | FEM CPU/GPU capability-gated | mesh.selectors[].point |
| geometry | object \| None | None | $1$ | when supplied, exactly str(value).strip(); empty result raises ValueError | restrict candidate component | FEM CPU/GPU capability-gated | mesh.selectors[].geometry |
| count | object | 1 | $1$ | exactly int(value); result must be at least 1 or ValueError | number passed to closest-entity query | FEM CPU/GPU capability-gated | mesh.selectors[].count |
| boundary_layer_count | int \| None | None | layers | int() coercion and at least 1 | boundary-layer count receiving the selector | FEM CPU/GPU capability-gated | mesh_workflow.per_geometry[].boundary_layer_count |
| boundary_layer_thickness | float \| None | None | $m$ | positive | boundary-layer thickness receiving the selector | FEM CPU/GPU capability-gated | mesh_workflow.per_geometry[].boundary_layer_thickness |
| boundary_layer_stretching | float \| None | None | 1 | positive | boundary-layer growth receiving the selector | FEM CPU/GPU capability-gated | mesh_workflow.per_geometry[].boundary_layer_stretching |
| boundary_layer_target_surface_selectors | Sequence[Mapping] \| None | None | 1 | normalized by _normalize_selector_list; resolved after mesh realization | attach semantic surface selector to the policy | FEM CPU/GPU capability-gated | mesh_workflow.per_geometry[].boundary_layer_target_surface_selectors |



`fm.mesh.nearest_surface_to_point` and `fm.mesh.nearest_curve_to_point` both take keyword-only `point`, `geometry=None`, `count=1` and return a descriptor dictionary.

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `point` | `Sequence[int | float]` | `required` | $\mathrm{m}$ | every component is converted with `float()`; the resulting list must have length three; no finite check | nearest-query point | FEM CPU/GPU capability-gated | `mesh.selectors[].point` |
| `geometry` | `str | None` | `None` | $1$ | supplied value is coerced with `str(value).strip()` and rejected if empty | restrict candidate component | FEM CPU/GPU capability-gated | `mesh.selectors[].geometry` |
| `count` | `int` | `1` | $1$ | supplied value is coerced with `int(value)`, then rejected below `1` | number passed to closest-entity query | FEM CPU/GPU capability-gated | `mesh.selectors[].count` |

```python
# %%
import fullmag as fm

# %%
selector = fm.mesh.nearest_surface_to_point(point=(0, 0.0, 2.5e-9), geometry=" film ", count=1)
study = fm.study("selector_contract")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
film = study.geometry(fm.Box(size=(100e-9, 50e-9, 5e-9), name="film"), name="film")
film.mesh(
    maximum_element_size=8e-9,
    boundary_layer_count=2,
    boundary_layer_thickness=2e-9,
    boundary_layer_stretching=1.2,
    boundary_layer_target_surface_selectors=[selector],
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

The descriptor lowers unchanged as `mesh.selectors[]`; tags and diagnostic distances are resolved execution/provenance, not stable authored IR.

(selectors-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

**Requested intent** is the descriptor. **Resolved execution** is the unique tag set plus report. **Validation errors** include non-dictionaries, wrong dimension kind, invalid point/count and blank geometry. **Unsupported combinations** are rejected by kind/dimension checks; they are not reinterpreted as raw tags.

(selectors-discrete-realization)=
## Discrete realization

Selectors target FEM Gmsh entities for CPU/GPU-capability-gated artifact creation. FDM CPU/GPU are not applicable.

(selectors-implementation-mapping)=
## Implementation mapping

`nearest_surface_to_point` and `nearest_curve_to_point` own public descriptor validation; `GeometryMeshHandle` stores descriptors in per-geometry mesh workflow; `_build_problem` and `Problem.to_ir` lower authored metadata; `_build_field_stack` consumes selector-bearing refinement fields; `resolve_entity_selectors` resolves Gmsh tags after realization; planner/runtime remain downstream consumers, not selector-resolution owners.

(selectors-validation)=
## Validation

Inspect selector report candidate counts, tags, distances and closest points after every rebuilt geometry. No runtime GPU result is claimed.

(selectors-limitations)=
## Limitations

Resolved Gmsh tags are build-session artifacts, not durable authoring identities.

(selectors-scientific-bibliography)=
## Scientific bibliography

Geuzaine and Remacle, *IJNME* 79 (2009), [doi:10.1002/nme.2579](https://doi.org/10.1002/nme.2579).

(selectors-source-code-index)=
## Contract source-code index

| ID | Path | Symbol | Responsibility | Evidence |
| --- | --- | --- | --- | --- |
| selectors | packages/fullmag-py/src/fullmag/meshing/_gmsh_selectors.py | resolve_entity_selectors | post-realization semantic selection | source-inspected |
| public_study | packages/fullmag-py/src/fullmag/world.py | study | public study entry point | source-inspected |
| mesh_authoring | packages/fullmag-py/src/fullmag/world.py | class GeometryMeshHandle | selector-bearing mesh authoring | source-inspected |
| nearest_surface | packages/fullmag-py/src/fullmag/meshing/mesh_controls.py | nearest_surface_to_point | public surface-selector constructor | source-inspected |
| nearest_curve | packages/fullmag-py/src/fullmag/meshing/mesh_controls.py | nearest_curve_to_point | public curve-selector constructor | source-inspected |
| problem_lowering | packages/fullmag-py/src/fullmag/world.py | _build_problem | builder-state lowering | source-inspected |
| problem_ir | packages/fullmag-py/src/fullmag/model/problem.py | class Problem | ProblemIR mesh-workflow serialization | source-inspected |
| field_stack | packages/fullmag-py/src/fullmag/meshing/_size_field_plan.py | _build_field_stack | selector-bearing field composition | source-inspected |
| domain_realization | packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py | realize_fem_domain_mesh_asset_from_components_with_report | shared-domain realization and report | source-inspected |
| planner | crates/fullmag-plan/src/lib.rs | plan | ProblemIR planning and compatibility | source-inspected, runtime-unverified |
| runtime | crates/fullmag-runner/src/lib.rs | run_planned_problem | planned runtime dispatch | source-inspected, device-unverified |

**Last changes: 12:31 24.08.2026**

Mesh operations should target semantic geometry ownership and roles rather than ephemeral Gmsh tags. Fullmag resolves selectors during each build and records matched entities and attributes in the manifest.

::::{admonition} Implementation status
:class: important

Nearest surface/curve selectors, geometry-scoped fields, all-boundary-curve selection, physical markers and derived facet roles are source-backed. Selector cardinality and geometry revision must remain visible.
::::

## Scope and purpose

Use selectors for local size fields, boundary layers, periodic pairs and boundary conditions.
Numeric entity tags are generator-session identifiers and can change after CSG or remeshing;
semantic selectors are rebuildable intent.

## Scientific and numerical model

A selector is a function of the current geometry model and tolerance,

```{math}
:label: eq-selector-resolution-fem-shared-domain-selectors-and-attributes
S:(G,\tau)\mapsto\{e_1,\ldots,e_n\}.
```

Production provenance stores the descriptor $S$, geometry revision, tolerance, matched entity IDs
and cardinality $n$. `nearest_surface_to_point` and `nearest_curve_to_point` minimize geometric
distance to a supplied SI point, optionally within one named geometry. Because symmetry can make
several entities equally near, `count` is part of the contract.

After topology extraction, Fullmag derives semantic facet roles from cell adjacency, region
markers, periodic markers and declared provisional interfaces. Roles are solver-facing and should
not be inferred from color or mesh position in the viewport.

## Selection guide

| Use case | Recommended choice | Reason |
| --- | --- | --- |
| Stable object-wide field | geometry name/role selector | Survives tag renumbering |
| Specific face near known coordinate | `nearest_surface_to_point` | Rebuildable spatial intent with explicit count |
| Specific edge/corner neighborhood | `nearest_curve_to_point` or all-boundary-curves | Targets edge refinement/boundary layer |
| Imported physical group | physical name/marker | Preserves upstream semantic ownership when valid |
| Periodic pair | semantic source/destination markers | Stable pair identity and translation certificate |

## Parameters

| Python / IR key | Unit | Default | Validation | Numerical effect |
| --- | --- | --- | --- | --- |
| `kind` | 1 | required | supported selector type | resolution algorithm |
| `point` | m | required for nearest selectors | finite 3-vector | spatial target in model coordinates |
| `geometry` | 1 | unset | canonical geometry name | restricts selector scope |
| `count` | entities | `1` | integer >= 1 | required number of nearest matches |
| `Selector.mode` | 1 | route-specific | for example `all_boundary_curves` | semantic collection rule |
| raw `SurfaceTags`/`CurveTags` | Gmsh IDs | `[]` | valid current-build tags | low-level escape hatch; fragile across rebuilds |
| physical name/marker | 1 | imported/generated | unique mapping | material/boundary semantic identity |
| facet role | 1 | derived | outer/interface/periodic/provisional etc. | solver-facing topological responsibility |

## Python API

**Complete Python example**

```python
import fullmag as fm

nm = 1.0e-9
study = fm.study("semantic_mesh_selectors")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.universe(
    mode="manual",
    size=(500 * nm, 300 * nm, 200 * nm),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(
    minimum_element_size=12 * nm,
    maximum_element_size=80 * nm,
    maximum_element_growth_rate=1.5,
    grading="geometric",
)

film = study.geometry(
    fm.Box(size=(300 * nm, 120 * nm, 10 * nm), name="film"),
    name="film",
)
top_surface = fm.mesh.nearest_surface_to_point(
    point=(0.0, 0.0, 5 * nm),
    geometry="film",
    count=1,
)
end_edge = fm.mesh.nearest_curve_to_point(
    point=(150 * nm, 60 * nm, 5 * nm),
    geometry="film",
    count=1,
)
film.mesh(
    mesh_strategy="free_tetrahedral",
    minimum_element_size=3 * nm,
    maximum_element_size=8 * nm,
    boundary_layer_count=2,
    boundary_layer_thickness=1 * nm,
    boundary_layer_stretching=1.2,
    boundary_layer_target_surface_selectors=[top_surface],
    boundary_layer_target_curve_selectors=[end_edge],
    order=1,
    compute_quality=True,
)
film.mesh.size_field("Ball", VIn=3 * nm, VOut=8 * nm, Radius=20 * nm, XCenter=0.0, YCenter=0.0, ZCenter=0.0)
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.m = fm.texture.uniform(1.0, 0.0, 0.0)

study.exchange()
study.demag(realization="poisson_robin")
study.build_domain_mesh()
study.stages.add_relax(stage_id="equilibrium", dt=5.0e-13, max_steps=10_000, tolT=1.0e-6)
```

## Control Room workflow

Use structured selector editors where available; **Advanced JSON** is the escape hatch, not the
primary path. Preview selected entities on the current geometry and display matched count and
distance. After build, inspect the selector-resolution evidence and the derived region/facet role
tables. Reconfirm selectors after any CSG, transform or import edit.

## Selector verification

For each selector, record descriptor, geometry revision, matched entities and count. Test the
rebuild after a harmless tag-renumbering change and after a geometry edit. Verify that selected
fields actually change the realized local size/layers. For attributes, check complete region and
facet coverage and compare semantic names with material/physics assignments.

## Verification, quality and provenance

After every build, inspect the **realized** resource rather than assuming that the authored request
was applied. The production check is:

- geometry and mesh revisions match the current model;
- requested and realized discretization/topology/order are recorded;
- node, element and boundary-facet counts are nonzero for every required region;
- region and boundary markers cover the complete topology;
- inverted and degenerate element counts are zero;
- interface diagnostics report no orphan, coincident, nonmanifold or unmatched facets;
- local size distributions are consistent with the intended edge/interface/core grading;
- any fallback or degradation has an explicit reason and an actual method;
- a mesh-refinement sequence demonstrates convergence of the scientific observable.

`MeshQualityReport` exposes signed inverse condition number (SICN), gamma/radius quality, volume
statistics and optional per-element arrays. The source constants `gamma_min=0.08` and
`SICN p05=0.1` are implementation gates for named report paths; they are not universal physical
acceptance thresholds for every element family or study.

## Diagnostics and failure semantics

- Zero matches are an error or explicit ignored operation; never report applied success.
- More/fewer matches than `count` is ambiguous and must block or request resolution.
- Symmetric nearest entities can swap under tiny geometry changes; use stronger semantic roles
  where possible.
- Raw tags are invalidated by a new Gmsh model/session unless explicitly preserved.
- Imported air names are normalized to marker 0; inspect collisions with user marker conventions.
- Provisional interface facets may be dropped only when explicitly declared and absent from final
  volume topology.

## Where this is implemented

| Responsibility | Repository source | Stable owner / symbol |
| --- | --- | --- |
| Public selector constructors | [`packages/fullmag-py/src/fullmag/meshing/mesh_controls.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/meshing/mesh_controls.py) | `nearest_surface_to_point, nearest_curve_to_point` |
| Selector resolution | [`packages/fullmag-py/src/fullmag/meshing/_gmsh_selectors.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/meshing/_gmsh_selectors.py) | `semantic entity resolution` |
| Physical names/markers | [`packages/fullmag-py/src/fullmag/meshing/_gmsh_extraction.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/meshing/_gmsh_extraction.py) | `_meshio_physical_name_map, _semantic_marker_from_name` |
| Facet-role derivation | [`packages/fullmag-py/src/fullmag/meshing/_gmsh_extraction.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/meshing/_gmsh_extraction.py) | `_derive_facet_roles` |
| Field-plan normalization | [`packages/fullmag-py/src/fullmag/meshing/_size_field_plan.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/meshing/_size_field_plan.py) | `selector-aware size fields` |
| Control Room object policy | [`apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanel.tsx`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanel.tsx) | `selector/advanced policy controls` |

Implementation map reviewed against commit `5db00ccf0113b9756fec2d46feb36ade762b12c2` on 2026-08-24.

## Related documentation

- [Refinement](../../refinement.md)
- [Boundary layers](../ferromagnet/boundary-layers.md)
- [Periodic airbox](../airbox/periodic-airbox.md)

## References

- C. Geuzaine and J.-F. Remacle, “Gmsh: a three-dimensional finite element mesh generator with built-in pre- and post-processing facilities,” *International Journal for Numerical Methods in Engineering* **79** (2009), 1309–1331, [doi:10.1002/nme.2579](https://doi.org/10.1002/nme.2579).
- C. Abert, “Micromagnetics and spintronics: models and numerical methods,” *European Physical Journal B* **92**, 120 (2019), [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).
- Gmsh reference manual, mesh algorithms, size fields, extrusion and physical groups: [gmsh.info/doc/texinfo](https://gmsh.info/doc/texinfo/).
## Source-code index

- Python contract source: `packages/fullmag-py/src/fullmag/model/discretization.py` and `packages/fullmag-py/src/fullmag/world.py`, where applicable. Runtime realization is owned by the relevant `backends/fdm` or `backends/fem` implementation; the page must not claim a symbol not named in its implementation mapping.

