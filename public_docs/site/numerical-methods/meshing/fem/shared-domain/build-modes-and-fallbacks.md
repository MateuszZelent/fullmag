---
title: "Shared-domain build modes and fallback semantics"
description: "How Fullmag selects generation paths and reports unsupported, degraded or fallback realizations."
summary: "Build mode is part of numerical provenance. A production report distinguishes requested strategy, normalized plan, actual generator, fallback/degradation reason and realized topology."
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-24
reviewed_revision: 5db00ccf0113b9756fec2d46feb36ade762b12c2
source_of_truth: "Asset-pipeline dispatch, meshing fallback tests, build report and execution mode"
---

(public-docs-numerical-methods-meshing-fem-shared-domain-build-modes-and-fallbacks)=
# Shared-domain build modes and fallback semantics

**Last changes: 12:31 24.08.2026**

Build mode is part of numerical provenance. A production report distinguishes requested strategy, normalized plan, actual generator, fallback/degradation reason and realized topology.

::::{admonition} Implementation status
:class: important

Ordinary tetrahedral paths and explicit fallback reporting are implemented. Exact mixed mode `single_geometry_geo_mixed` is narrow: a qualified single sweepable geometry can use it, while generic multi-object/airbox swept requests are not universally executable.
::::

## Scope and purpose

Use this page to interpret why a build used a particular generator and whether that outcome
satisfies the authored scientific intent. Fullmag intentionally treats an exact topology request
differently from a preference: strict mode rejects unmet exact intent; a permissive mode may allow
a named fallback only when the policy says so.

## Scientific and numerical model

The canonical provenance state is

```text
requested_method
normalized_method
actual_method
status = applied | ignored | degraded | fallback | rejected
reason_code + human explanation
realized_cell_families
```

`single_geometry_geo_mixed` is the source-visible exact mixed route for an eligible single
geometry such as a box with strict prism intent. A specialized `ArchWaveguide` route can realize
thickness-aware/layered tetrahedra. Ordinary shared OCC/component or imported-surface paths can
realize tetrahedra and must report that actual method. No path may label a tetrahedral result as an
exact prism success.

### Scientific invariants

A finite-element mesh is not only a visualization asset. It defines the trial/test spaces used by
exchange, anisotropy, DMI, magnetostatic and dynamic operators. The following conditions are therefore
part of the numerical contract:

1. Every magnetic volume has an unambiguous region marker and every exterior-air volume has the
   canonical air role.
2. Interfaces used by coupled operators are conforming, or an explicitly supported nonconforming
   coupling operator is selected. Fullmag's ordinary shared-domain path expects conformity.
3. Cell orientation is valid: the element mapping has a positive Jacobian at all required evaluation
   points. Inverted or collapsed cells are build failures, not warnings to ignore.
4. Requested topology, polynomial order, layer count and mesh-size controls are compared with the
   realized mesh. A topology change is legal only when the build mode permits fallback and the report
   names the actual method and reason.
5. Mesh convergence is assessed on physical observables—energy, average magnetization, switching
   field, eigenfrequency, linewidth or field error—not only on element count.

For exchange-dominated variation, a useful *starting* scale is the magnetostatic exchange length

```{math}
:label: eq-meshing-exchange-length-fem-shared-domain-build-modes-and-fallbacks
\ell_{\mathrm{ex}}=\sqrt{\frac{2A}{\mu_0M_s^2}}.
```

Using an element size below roughly one half of the smallest relevant magnetic length scale is a
common initial choice, not a proof of convergence. Curved boundaries, surface charges, DMI, defects,
interfaces and through-thickness modes can demand a smaller local size.

## Selection guide

| Use case | Recommended choice | Reason |
| --- | --- | --- |
| Exact topology is part of the model | `study.mode("strict")` | Rejects unsupported or mismatched realization |
| Topology is only a preference | explicit fallback-enabled policy | Allows a named fallback with provenance |
| General multi-object airbox | ordinary conforming tetrahedral build | Most broadly supported shared route |
| Single box exact prism and capabilities pass | `single_geometry_geo_mixed` | Narrow qualified mixed route |

## Parameters

| Python / IR key | Unit | Default | Validation | Numerical effect |
| --- | --- | --- | --- | --- |
| execution mode | 1 | `strict` recommended | supported mode | controls whether unsupported/degraded requests can proceed |
| `mesh_strategy` | 1 | `auto` | valid object strategy | requested topology/generator intent |
| `build_mode` | 1 | planner-selected | advertised mode | actual assembly/generation route |
| fallback policy | 1 | reject for exact paths | explicit policy | defines legal alternative methods |
| `actual_method` | 1 | report output | non-empty for every build | generator that produced the realized mesh |
| reason code | 1 | report output | required for ignored/degraded/fallback/rejected | machine- and human-readable explanation |

## Python API

**Complete Python example**

```python
import fullmag as fm

nm = 1.0e-9
study = fm.study("strict_mixed_build_mode")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.universe(
    mode="manual",
    size=(800 * nm, 400 * nm, 200 * nm),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(
    minimum_element_size=15 * nm,
    maximum_element_size=100 * nm,
    maximum_element_growth_rate=1.5,
    grading="geometric",
)

film = study.geometry(
    fm.Box(size=(600 * nm, 200 * nm, 6 * nm), name="film"),
    name="film",
)
film.mesh(
    mesh_strategy="swept_prism",
    topology="prismatic",
    through_thickness_elements=2,
    through_thickness_distribution="fixed",
    sweep_face_meshing="triangular",
    sweep_direction="auto",
    element_family="prism",
    transition_policy="pyramid_to_tetrahedra",
    exact_layer_count=True,
    minimum_element_size=4 * nm,
    maximum_element_size=8 * nm,
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
# In strict mode, an unsupported exact request must fail instead of returning
# an unreported tetrahedral substitute.
```

## Control Room workflow

Select **Strict** execution for topology-sensitive work. Before building, read the capability
banner. After building, open **History** and compare requested/effective/actual strategy, build
mode, fallback state and cell-family counts. A yellow/red capability or fallback badge is part of
the result and must be exported with the simulation—not dismissed after visual inspection.

## Fallback verification

Test every supported request and at least one deliberately unsupported request. Strict mode must
reject the latter before solver execution. A permitted fallback must preserve geometry/regions,
record the reason and pass its own quality/convergence checks. Regression tests should assert
exact `actual_method` and family counts, not only that a file was produced.

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

- Missing `actual_method` is a provenance failure.
- Exact prism request plus all-tet result is fallback/failure, never success.
- A retry between Gmsh algorithms is distinct from a topology fallback; both attempts/reasons
  should be recorded.
- `auto` is not reproducible unless the resolved method and capabilities are stored.
- A source-visible code path is not a production qualification; capability evidence controls UI.

## Where this is implemented

| Responsibility | Repository source | Stable owner / symbol |
| --- | --- | --- |
| Build-mode dispatch | [`packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py) | `shared-domain build-mode selection` |
| Fallback/report schema | [`packages/fullmag-py/src/fullmag/meshing/mesh_build_report.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/meshing/mesh_build_report.py) | `requested/actual/fallback fields` |
| Generator retries | [`packages/fullmag-py/src/fullmag/meshing/_gmsh_generators.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/meshing/_gmsh_generators.py) | `_stl_meshing_retry_algorithm, sanitizers` |
| Fallback tests | [`packages/fullmag-py/tests/test_meshing_fallbacks.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/tests/test_meshing_fallbacks.py) | `explicit fallback assertions` |
| Mixed mode tests | [`packages/fullmag-py/tests/test_mixed_element_meshing.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/tests/test_mixed_element_meshing.py) | `single_geometry_geo_mixed` |
| Control Room capability model | [`apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanelModel.ts`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanelModel.ts) | `mesh strategy capability states` |

Implementation map reviewed against commit `5db00ccf0113b9756fec2d46feb36ade762b12c2` on 2026-08-24.

## Related documentation

- [Swept meshes](../../swept-meshes.md)
- [Assembly and conformity](assembly-and-conformity.md)

## References

- C. Geuzaine and J.-F. Remacle, “Gmsh: a three-dimensional finite element mesh generator with built-in pre- and post-processing facilities,” *International Journal for Numerical Methods in Engineering* **79** (2009), 1309–1331, [doi:10.1002/nme.2579](https://doi.org/10.1002/nme.2579).
- C. Abert, “Micromagnetics and spintronics: models and numerical methods,” *European Physical Journal B* **92**, 120 (2019), [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).
- Gmsh reference manual, mesh algorithms, size fields, extrusion and physical groups: [gmsh.info/doc/texinfo](https://gmsh.info/doc/texinfo/).
