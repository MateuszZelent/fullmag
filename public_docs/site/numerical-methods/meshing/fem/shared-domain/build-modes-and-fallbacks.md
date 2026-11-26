---
title: "Shared-domain build modes and fallback semantics"
description: "How Fullmag selects generation paths and reports unsupported, degraded or fallback realizations."
summary: "Build mode is part of numerical provenance. A production report distinguishes requested strategy, normalized plan, actual generator, fallback/degradation reason and realized topology."
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-11-26
reviewed_revision: 752450f8d259ab97c76c36fe666d5474b02abe9a
source_of_truth: "Asset-pipeline dispatch, pure_prism and mixed build modes, meshing fallback tests, build report and execution mode"
---

(public-docs-numerical-methods-meshing-fem-shared-domain-build-modes-and-fallbacks)=
# Shared-domain build modes and fallback semantics

Build mode is part of numerical provenance. A production build report distinguishes requested strategy, normalized plan, actual generator, fallback or degradation reason, and realized cell families.

::::{admonition} Implementation status
:class: important

Conforming OCC tetrahedral builds (`conformal_occ`), strict pure-prism P2 builds (`pure_prism_extruded_shared_domain`), strict mixed P1 builds (`single_geometry_geo_mixed`), specialized ring/waveguide builds (`single_geometry_geo_ring`), and explicit fallback reporting are implemented. Silent topology substitution is rejected in strict mode.
::::

(build-modes-problem-statement)=
## Problem statement

Fullmag separates single-object preview/asset target resolution (`realize_fem_mesh_asset`) from shared-domain build-mode dispatch (`realize_fem_domain_mesh_asset_from_components_with_report`). An exact topology request (`exact_layers=True`, `transition="pure_prism"` or `transition="pyramid_to_tetrahedra"`) is a strict mathematical contract, not a soft preference: `study.mode("strict")` rejects unmet exact intent rather than returning an unreported tetrahedral substitute.

(build-modes-governing-equations)=
## Governing equations

For single-object preview/source realization in `realize_fem_mesh_asset`, the effective target size follows the precedence relation:

```{math}
:label: eq-build-target-contract

h_{\max}=h_{\mathrm{recipe}}\succ h_{\mathrm{per\text{-}geometry}}\succ h_{\mathrm{default}}\succ h_{\mathrm{FEM}}.
```

Exchange-length scaling follows

```{math}
:label: eq-meshing-exchange-length-fem-shared-domain-build-modes-and-fallbacks

\ell_{\mathrm{ex}}=\sqrt{\frac{2A}{\mu_0 M_s^2}}.
```

Every realized shared-domain build emits the canonical provenance tuple:

```text
requested_method
normalized_method
actual_method
status = applied | ignored | degraded | fallback | rejected
reason_code + human explanation
realized_cell_families
```

(build-modes-symbols-and-si-units)=
## Symbols and SI units

| Token | Meaning | SI unit |
| --- | --- | --- |
| $h_{\max}$ | effective preview element-size target | $\mathrm{m}$ |
| $h_{\mathrm{recipe}}$ | per-object recipe target | $\mathrm{m}$ |
| $h_{\mathrm{per\text{-}geometry}}$ | per-geometry workflow target | $\mathrm{m}$ |
| $h_{\mathrm{default}}$ | study default mesh target | $\mathrm{m}$ |
| $h_{\mathrm{FEM}}$ | FEM hint target | $\mathrm{m}$ |
| $\ell_{\mathrm{ex}}$ | magnetostatic exchange length | $\mathrm{m}$ |
| $A$ | exchange stiffness constant | $\mathrm{J\,m^{-1}}$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |
| $M_s$ | saturation magnetization | $\mathrm{A\,m^{-1}}$ |

(build-modes-assumptions-and-validity)=
## Assumptions and validity

- Precedence {eq}`eq-build-target-contract` applies to single-object target resolution in `realize_fem_mesh_asset` and does not by itself define a shared-domain fallback policy.
- Shared-domain build modes in `_realize_fem_domain_mesh_asset_from_components_impl` are selected deterministically from geometry, object policy, and execution mode:
  - **`pure_prism_extruded_shared_domain`:** Single axis-aligned `Box` film inside a box airbox with `topology="prismatic"`, `transition="pure_prism"`, `exact_layers=True`, `layers >= 1`, `order=1`; emits 100% `prism6` cells and `PurePrismTopologyCertificateV1IR` (`fallbacks_triggered == []`), unlocking automatic P2 `H1_WedgeElement(2)` demagnetization potential.
  - **`single_geometry_geo_mixed`:** Single axis-aligned `Box` film inside a box airbox with `topology="prismatic"`, `transition="pyramid_to_tetrahedra"`, `exact_layers=True`, `layers in (1, 2, 3)`, `order=1`; emits `prism6 + pyramid5 + tet4` repaired by the Chebyshev untangler.
  - **`conformal_occ`:** General single- and multi-body OCC boolean fragmentation into conforming tetrahedra.
  - **`single_geometry_geo_ring` / `ArchWaveguide`:** Specialized thickness-aware / layered tetrahedral route for ring/waveguide primitives.
  - **`component_aware` and `concatenated_stl_fallback`:** STL-based multi-component routes; multi-component imported STL meshes must preserve per-component source-surface ownership and cannot silently fall back to anonymous concatenated STL (`_reject_anonymous_import_fallback`).
- No build mode may label a tetrahedral result as an exact prism success.

### Selection guide

| Use case | Recommended choice | Reason |
| --- | --- | --- |
| Exact topology is part of the scientific model | `study.mode("strict")` | Rejects unsupported or mismatched realization before solving |
| Single rectangular thin film needing P2 wedge demag on GPU | `pure_prism_extruded_shared_domain` (`transition="pure_prism"`) | Pyramid-free 100% `prism6` certified route with `fallbacks_triggered == []` |
| Single rectangular thin film needing P1 mixed prism-pyramid-tet | `single_geometry_geo_mixed` (`transition="pyramid_to_tetrahedra"`) | Certified `layers=1,2,3` mixed P1 route with Chebyshev untangler |
| General curved or multi-object shared airbox | `conformal_occ` | Broadest conforming tetrahedral assembly route |
| Topology is only a preference | Explicit fallback-enabled policy | Permits a named fallback with full provenance |

(build-modes-python-api)=
## Python API

### Complete public signature and IR matrix

The following row documents the public shared-domain materialization trigger.

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `study.build_domain_mesh()` | `zero-argument method` | n/a | $1$ | accepts no public arguments; capture marks the request without invoking Gmsh, ordinary execution reaches SDK-backed realization | shared-domain materialization request | FEM CPU/GPU capability-gated | `runtime_metadata.mesh_workflow.default_mesh.build_requested` |

`realize_fem_mesh_asset(...)` and `_realize_fem_domain_mesh_asset_from_components_impl(...)` are internal. Public scripts request shared-domain materialization through zero-argument `StudyBuilder.build_domain_mesh()`.

```python
# %% Study setup in strict mode
import fullmag as fm

nm = 1.0e-9
study = fm.study("build_mode_contract")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.universe(
    mode="manual",
    size=(240 * nm, 140 * nm, 100 * nm),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(
    maximum_element_size=40 * nm,
    minimum_element_size=10 * nm,
    maximum_element_growth_rate=1.5,
    grading="geometric",
)

# %% Strict pure-prism thin-film intent and explicit shared-domain build request
film = study.geometry(fm.Box(size=(100 * nm, 50 * nm, 5 * nm), name="film"), name="film")
film.mesh.thin_film(
    maximum_element_size=20 * nm,
    minimum_element_size=10 * nm,
    layers=2,
    topology="prismatic",
    exact_layers=True,
    transition="pure_prism",
    order=1,
)
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

Authoring lowers workflow metadata (`runtime_metadata.mesh_workflow.default_mesh.build_requested` and `per_geometry[]`) and execution mode (`strict` vs `extended`). Resolved `actual_method`, `build_mode`, algorithm retry logs, `fallbacks_triggered`, and topology certificates are recorded in the build report and mesh asset provenance, distinct from user-authored intent.

(build-modes-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

- **Requested intent:** Geometry, execution mode, and per-object/universe mesh policies.
- **Resolved execution:** Selected build mode (`pure_prism_extruded_shared_domain`, `single_geometry_geo_mixed`, `conformal_occ`, etc.), actual generator, realized cell families, and explicit fallback/degradation list.
- **Validation errors:** Surface-only imported geometry without volume elements, zero tetrahedral/prismatic elements, missing `actual_method`, exact prism request realizing only `tet4`, or non-default `SharedMeshAssemblyPolicy`.
- **Unsupported combinations:** Exact `pure_prism` or `mixed_p1` requests on ineligible geometries or unsupported physics/studies fail closed (`ValueError` or planner rejection with `fallback=none`); multi-component STL imports reject anonymous `concatenated_stl_fallback` via `_reject_anonymous_import_fallback`.

(build-modes-discrete-realization)=
## Discrete realization

| Solver | Device | Status | Reason / Limit |
| --- | --- | --- | --- |
| FEM | CPU | implemented | Dispatches `conformal_occ`, `pure_prism_extruded_shared_domain`, `single_geometry_geo_mixed`, and reported retries/fallbacks |
| FEM | GPU | implemented (capability-gated) | Consumes certified volume artifacts; rejects degraded/uncertified mixed or pure-prism reports fail-closed |
| FDM | CPU | not applicable | Structured Cartesian FDM grids do not use the FEM asset pipeline |
| FDM | GPU | not applicable | Structured Cartesian FDM grids do not use the FEM asset pipeline |

### Control Room workflow

Select **Strict** execution mode for topology-sensitive studies. Before building, inspect the capability status in `ObjectMeshSpecPanel.tsx` (`ObjectMeshPolicyPanelModel.ts`). After building, open **History** (`MeshBuildHistorySpec.tsx`) and compare requested, effective, and actual build modes, fallback badges, and cell-family counts. Export yellow/red fallback or degradation badges as part of simulation provenance.

(build-modes-implementation-mapping)=
## Implementation mapping

`StudyBuilder.build_domain_mesh` owns the public build trigger; `_build_problem` and `Problem.to_ir()` lower workflow metadata; `realize_fem_mesh_asset` resolves single-object previews; `realize_fem_domain_mesh_asset_from_components_with_report` and `_realize_fem_domain_mesh_asset_from_components_impl` select shared-domain build modes (`conformal_occ`, `pure_prism_extruded_shared_domain`, `single_geometry_geo_mixed`, STL routes) and enforce `_reject_anonymous_import_fallback`; `_build_shared_domain_build_report` records requested/actual/fallback provenance; `fullmag_plan::plan` and `run_planned_problem` enforce downstream compatibility.

(build-modes-validation)=
## Validation

Regression suites (`test_meshing_fallbacks.py`, `test_mixed_element_meshing.py`, `test_pure_prism_shared_domain_meshing.py`) test both supported requests (asserting exact `actual_method`, cell-family counts, and `fallbacks_triggered == []`) and deliberately unsupported requests (asserting strict rejection before solver execution). A Gmsh algorithm retry (such as `_stl_meshing_retry_algorithm`) is distinguished from a topology fallback; both are logged explicitly.

(build-modes-limitations)=
## Limitations

- `realize_fem_mesh_asset` is an object-preview pipeline, not the shared-domain build-mode planner, and never qualifies a surface preview for solver use.
- `mesh_strategy="auto"` is reproducible only when the resolved `actual_method` and capability snapshot are archived with the run.
- Source-visible code paths do not imply production qualification across every device/physics pair; planner capability gates remain authoritative.

(build-modes-scientific-bibliography)=
## Scientific bibliography

- C. Geuzaine and J.-F. Remacle, “Gmsh: a three-dimensional finite element mesh generator with built-in pre- and post-processing facilities,” *International Journal for Numerical Methods in Engineering* **79** (2009), 1309–1331, [doi:10.1002/nme.2579](https://doi.org/10.1002/nme.2579).
- C. Abert, “Micromagnetics and spintronics: models and numerical methods,” *European Physical Journal B* **92**, 120 (2019), [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).

## Related documentation

- [Swept meshes](../../swept-meshes.md)
- [Assembly and conformity](assembly-and-conformity.md)
- [Swept-prism ferromagnet mesh](../ferromagnet/swept-prism.md)

(build-modes-source-code-index)=
## Source-code index

| ID | Path | Symbol | Responsibility | Evidence |
| --- | --- | --- | --- | --- |
| fem_asset | [`packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py#L1436) | [`realize_fem_mesh_asset`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py#L1436) | FEM object asset realization and volume checks | source-inspected |
| public_study | [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L7610) | [`study`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L7610) | public study entry point | source-inspected |
| build_request | [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L6437) | [`class StudyBuilder`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L6437) | public `StudyBuilder.build_domain_mesh` request | source-inspected |
| problem_lowering | [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L10324) | [`_build_problem`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L10324) | builder-state lowering | source-inspected |
| problem_ir | [`packages/fullmag-py/src/fullmag/model/problem.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/problem.py#L2733) | [`class Problem`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/problem.py#L2733) | ProblemIR and geometry-asset serialization | source-inspected |
| domain_realization | [`packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py#L4283) | [`realize_fem_domain_mesh_asset_from_components_with_report`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py#L4283) | shared-domain build-mode realization | verified |
| domain_dispatch | [`packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py#L2790) | [`_realize_fem_domain_mesh_asset_from_components_impl`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py#L2790) | selects `pure_prism_extruded_shared_domain`, `single_geometry_geo_mixed`, and `conformal_occ` | verified |
| stl_fallback_guard | [`packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py#L272) | [`_reject_anonymous_import_fallback`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py#L272) | blocks anonymous concatenated-STL fallback on multi-component imports | verified |
| build_report | [`packages/fullmag-py/src/fullmag/meshing/mesh_build_report.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/mesh_build_report.py#L30) | [`_build_shared_domain_build_report`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/mesh_build_report.py#L30) | requested/effective/fallback provenance | source-inspected |
| planner | [`crates/fullmag-plan/src/lib.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-plan/src/lib.rs#L183) | [`plan`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-plan/src/lib.rs#L183) | ProblemIR planning and compatibility | verified |
| runtime | [`crates/fullmag-runner/src/lib.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/lib.rs#L3784) | [`run_planned_problem`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/lib.rs#L3784) | planned runtime dispatch | verified |
