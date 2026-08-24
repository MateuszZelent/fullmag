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
    size_fields=[
        fm.mesh.surface_shell(
            "film",
            maximum_element_size=4 * nm,
            far_maximum_element_size=8 * nm,
            distance=15 * nm,
        ),
    ],
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
film.m = fm.texture.uniform(1.0, 0.0, 0.0)

study.exchange()
study.demag(realization="poisson_robin")
study.build_domain_mesh()
study.stages.add_relax(stage_id="equilibrium", max_steps=10_000, tolT=1.0e-6)
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
