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

(build-modes-problem-statement)=
## Problem statement

The asset pipeline resolves one FEM object preview/source mesh. It is distinct from shared-domain topology realization and should not be used to infer an effective fallback policy.

(build-modes-governing-equations)=
## Governing equations

```{math}
:label: eq-build-target-contract

h_{max}=h_{recipe}\succ h_{per\_geometry}\succ h_{default}\succ h_{FEM}.
```

(build-modes-symbols-and-si-units)=
## Symbols and SI units

| Token | Meaning | SI unit |
| --- | --- | --- |
| $h_{max}$ | effective preview element-size target | $\mathrm{m}$ |
| $h_{recipe}$ | per-object recipe target | $\mathrm{m}$ |
| $h_{FEM}$ | FEM hint target | $\mathrm{m}$ |

(build-modes-assumptions-and-validity)=
## Assumptions and validity

The precedence relation is stated in the function docstring. It applies to the preview target of this function, not a proof of shared-domain fallback behavior.

(build-modes-python-api)=
## Python API

### Complete public signature and IR matrix

The following rows are the exhaustive public-signature contract for this page; each row mirrors one public_api.parameters entry in the source map.

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| study.build_domain_mesh() | zero-argument method | n/a | $1$ | accepts no public arguments; capture marks the request without invoking Gmsh, ordinary execution reaches SDK-backed realization | shared-domain materialization request | FEM CPU/GPU capability-gated | runtime_metadata.mesh_workflow.default_mesh.build_requested |



`realize_fem_mesh_asset(...)` is internal. Public scripts request shared-domain materialization with zero-argument `StudyBuilder.build_domain_mesh()`, which sets `build_requested` before the SDK-backed realization boundary.

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `StudyBuilder.build_domain_mesh()` | no public arguments | n/a | $1$ | sets `build_requested`; capture stops before Gmsh and ordinary execution may require the Gmsh Python SDK | shared-domain build request | FEM CPU/GPU capability-gated | `runtime_metadata.mesh_workflow.default_mesh.build_requested` |

```python
# %%
import fullmag as fm

# %%
nm = 1.0e-9
study = fm.study("build_mode_contract")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.universe(mode="manual", size=(240 * nm, 140 * nm, 100 * nm), center=(0.0, 0.0, 0.0), padding=(0.0, 0.0, 0.0))
study.universe.mesh(maximum_element_size=30 * nm, minimum_element_size=5 * nm)
film = study.geometry(fm.Box(size=(100 * nm, 50 * nm, 5 * nm), name="film"), name="film")
film.mesh(maximum_element_size=8 * nm, minimum_element_size=4 * nm)
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.texture.uniform(1.0, 0.0, 0.0)
study.exchange()
study.demag(realization="poisson_robin")
try:
    study.build_domain_mesh()
except RuntimeError as exc:
    if "Gmsh Python SDK is required for FEM meshing" not in str(exc):
        raise
    print(f"Mesh realization unavailable in this environment: {exc}")
study.stages.add_relax(stage_id="equilibrium", dt=5.0e-13, max_steps=1)
```

(build-modes-problem-ir)=
## ProblemIR

Authoring lowers workflow metadata and policy; `target.hmax`, source choice and mesh data are resolved execution values. A loaded mesh or generated mesh is provenance that must be retained separately.

(build-modes-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

**Requested intent** is geometry plus hints/workflow. **Resolved execution** is the selected target and generated or loaded mesh. **Validation errors** include unsupported surface-only imported geometry and zero tetrahedral elements. **Unsupported combinations** reject with `ValueError`; this function does not silently create a solver-eligible mesh from a surface preview.

(build-modes-discrete-realization)=
## Discrete realization

FEM CPU/GPU can consume a valid volume artifact subject to solver capability. FDM CPU/GPU are not applicable to this FEM asset pipeline.

(build-modes-implementation-mapping)=
## Implementation mapping

`StudyBuilder.build_domain_mesh` owns the public request; `_build_problem` and `Problem.to_ir` lower requested workflow and assets; `realize_fem_mesh_asset` is object-preview realization, while `realize_fem_domain_mesh_asset_from_components_with_report` owns shared-domain build modes and `_build_shared_domain_build_report` owns requested/effective/fallback provenance. Planner/runtime are downstream and do not retroactively change authored intent.

(build-modes-validation)=
## Validation

Require nonzero tetrahedral elements and inspect `target.source`; validate any reported fallback in its responsible shared-domain route. No GPU runtime execution is claimed.

(build-modes-limitations)=
## Limitations

This function is not the universal build-mode planner and does not qualify a surface preview for solver use.

(build-modes-scientific-bibliography)=
## Scientific bibliography

Geuzaine and Remacle, *IJNME* 79 (2009), [doi:10.1002/nme.2579](https://doi.org/10.1002/nme.2579).

(build-modes-source-code-index)=
## Contract source-code index

| ID | Path | Symbol | Responsibility | Evidence |
| --- | --- | --- | --- | --- |
| fem_asset | packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py | realize_fem_mesh_asset | FEM asset realization and volume checks | source-inspected |
| public_study | packages/fullmag-py/src/fullmag/world.py | study | public study entry point | source-inspected |
| build_request | packages/fullmag-py/src/fullmag/world.py | class StudyBuilder | public `StudyBuilder.build_domain_mesh` request | source-inspected |
| problem_lowering | packages/fullmag-py/src/fullmag/world.py | _build_problem | builder-state lowering | source-inspected |
| problem_ir | packages/fullmag-py/src/fullmag/model/problem.py | class Problem | ProblemIR and geometry-asset serialization | source-inspected |
| domain_realization | packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py | realize_fem_domain_mesh_asset_from_components_with_report | shared-domain build-mode realization | source-inspected |
| build_report | packages/fullmag-py/src/fullmag/meshing/mesh_build_report.py | _build_shared_domain_build_report | requested/effective/fallback provenance | source-inspected |
| planner | crates/fullmag-plan/src/lib.rs | plan | ProblemIR planning and compatibility | source-inspected, runtime-unverified |
| runtime | crates/fullmag-runner/src/lib.rs | run_planned_problem | planned runtime dispatch | source-inspected, device-unverified |

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
)
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.m = fm.texture.uniform(1.0, 0.0, 0.0)

study.exchange()
study.demag(realization="poisson_robin")
study.build_domain_mesh()
study.stages.add_relax(stage_id="equilibrium", dt=5.0e-13, max_steps=10_000, tolT=1.0e-6)
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
## Source-code index

- Python contract source: `packages/fullmag-py/src/fullmag/model/discretization.py` and `packages/fullmag-py/src/fullmag/world.py`, where applicable. Runtime realization is owned by the relevant `backends/fdm` or `backends/fem` implementation; the page must not claim a symbol not named in its implementation mapping.

