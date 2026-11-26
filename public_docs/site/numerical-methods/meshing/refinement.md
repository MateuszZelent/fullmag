---
title: "Mesh sizing, local refinement and convergence"
description: "Physics-guided mesh-size selection, Gmsh size fields and convergence evidence."
summary: "Refinement should be driven by physical length scales and observable error. Fullmag combines calibrated presets, explicit min/max sizes, interface/edge/corner controls and structured size fields."
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-11-26
reviewed_revision: 752450f8d259ab97c76c36fe666d5474b02abe9a
source_of_truth: "Mesh-size resolution pipeline, semantic size fields, Control Room object/airbox policies and quality resources"
---

(public-docs-numerical-methods-meshing-refinement)=
# Mesh sizing, local refinement and convergence

Refinement should be driven by physical length scales and observable error. Fullmag combines calibrated presets, explicit min/max sizes, interface/edge/corner controls, and composable Gmsh size fields into one realized field stack.

::::{admonition} Implementation status
:class: important

Named calibrations, presets, explicit size bounds, interface/edge/corner controls, manual boxes/balls, and semantic size fields are implemented for FEM. Adaptive solve–estimate–remesh loops are documented separately and must not be inferred from static authoring controls.
::::

(refinement-problem-statement)=
## Problem statement

Refinement is not synonymous with globally decreasing `maximum_element_size`: it targets regions responsible for dominant discretization error (exchange/DMI texture cores, curved surfaces, interfaces, edges, and corners) while preserving element quality and solver conditioning. In Fullmag's FEM pipeline, `_build_field_stack` composes object bulk, interface, transition, perimeter, manual-hotspot, and region-owned fields into one realized Gmsh field stack.

(refinement-governing-equations)=
## Governing equations

The realized Gmsh size-field stack is the ordered composition of active field families:

```{math}
:label: eq-refinement-stack-contract

\mathcal F=\mathcal F_{\mathrm{bulk}}\cup\mathcal F_{\mathrm{interface}}\cup\mathcal F_{\mathrm{transition}}\cup\mathcal F_{\mathrm{perimeter}}\cup\mathcal F_{\mathrm{hotspot}}\cup\mathcal F_{\mathrm{region}}.
```

When multiple upper-bound fields $h_j(\mathbf{r})$ are active, the mesher receives their pointwise minimum before global lower/upper clamps and growth controls:

```{math}
:label: eq-refinement-size-field-min-refinement

h_{\mathrm{target}}(\mathbf{r})=\min_j h_j(\mathbf{r}).
```

A useful starting scale for exchange-dominated micromagnetic textures is the magnetostatic exchange length

```{math}
:label: eq-meshing-exchange-length-refinement

\ell_{\mathrm{ex}}=\sqrt{\frac{2A}{\mu_0 M_s^2}}.
```

Mesh convergence is assessed across a controlled refinement sequence of characteristic sizes $h$ and $h/\rho$ on a physical observable $Q$:

```{math}
:label: eq-meshing-relative-change-refinement

\varepsilon_h=\frac{|Q_h-Q_{h/\rho}|}{\max(|Q_{h/\rho}|,Q_{\mathrm{scale}})},
\qquad \rho>1.
```

(refinement-symbols-and-si-units)=
## Symbols and SI units

| Token | Meaning | SI unit |
| --- | --- | --- |
| $\mathcal F$ | realized field stack | $1$ |
| $\mathcal F_{\mathrm{bulk}}$ | object bulk fields | $1$ |
| $\mathcal F_{\mathrm{interface}}$ | interface fields | $1$ |
| $\mathcal F_{\mathrm{transition}}$ | interface-to-far-field transition fields | $1$ |
| $\mathcal F_{\mathrm{perimeter}}$ | edge and corner perimeter fields | $1$ |
| $\mathcal F_{\mathrm{hotspot}}$ | user-authored manual local size fields | $1$ |
| $\mathcal F_{\mathrm{region}}$ | region-owned refinement fields | $1$ |
| $h_{\mathrm{target}}(\mathbf{r})$ | pointwise combined target element size | $\mathrm{m}$ |
| $h_j(\mathbf{r})$ | individual active size field $j$ | $\mathrm{m}$ |
| $\ell_{\mathrm{ex}}$ | magnetostatic exchange length | $\mathrm{m}$ |
| $A$ | exchange stiffness constant | $\mathrm{J\,m^{-1}}$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |
| $M_s$ | saturation magnetization | $\mathrm{A\,m^{-1}}$ |
| $\varepsilon_h$ | relative refinement change in observable $Q$ | $1$ |
| $Q_h$ | physical observable at characteristic size $h$ | $\text{observable-dependent}$ |
| $Q_{\mathrm{scale}}$ | documented scale floor for zero-crossing observables | $\text{observable-dependent}$ |
| $\rho$ | mesh refinement ratio | $1$ |

(refinement-assumptions-and-validity)=
## Assumptions and validity

- The set union in {eq}`eq-refinement-stack-contract` denotes ordered composition in `_build_field_stack`, not linear superposition; overlapping fields take the pointwise minimum {eq}`eq-refinement-size-field-min-refinement` so the finest request dominates.
- `ObjectCoreRelaxation` keeps a fine surface/edge shell while permitting a coarser interior; distance-threshold fields interpolate from `SizeMin` to `SizeMax` over a specified transition distance.
- Presets (`calibrate_for`, `size_preset`) populate baseline defaults before explicit overrides are applied. The backend-returned effective configuration resource—not the form or preset name alone—is the authoritative record of resolved values.
- Region polynomial order other than `1` is explicitly rejected in the region-refinement path.
- Using $h \lesssim \ell_{\mathrm{ex}}/2$ is an initial rule of thumb, never a proof of convergence; curved boundaries, surface charges, DMI, defects, and through-thickness modes can require finer local resolution.
- For Cartesian FDM grid sizing (where cell spacing $\Delta x, \Delta y, \Delta z$ simultaneously governs voxelization, finite-difference stencils, and FFT demagnetization), see [FDM Cartesian grids](fdm-grids.md).

### Selection guide

| Use case | Recommended choice | Reason |
| --- | --- | --- |
| Unknown problem / first mesh | `calibrate_for` + `normal` or `fine` | Provides a reproducible baseline before explicit convergence |
| Exchange/DMI texture localized in the bulk | Manual `Ball` / `Box` or physics-driven size field | Refines around the expected soliton or domain-wall core |
| Demag edge singularity / antidot | Edge and corner refinement | Targets strong surface-charge gradients |
| Large 3-D body with smooth core | `ObjectCoreRelaxation` | Fine boundary shell with coarser interior |
| Magnet/air interface | Interface shell + controlled transition | Protects field accuracy and interface conformity |

(refinement-python-api)=
## Python API

### Complete public signature and IR matrix

The following rows document the public signature and `ProblemIR` contract for `GeometryMeshHandle` and `size_field(...)`.

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `hmax` | `float \| str \| None` | `None` | $\mathrm{m}$ | compatibility alias; canonical maximum_element_size wins; numeric values must be positive and the only accepted string is exact `auto` | compatibility coarse-size spelling | FEM CPU/GPU capability-gated | `mesh_workflow.per_geometry[].maximum_element_size` |
| `hmin` | `float \| None` | `None` | $\mathrm{m}$ | compatibility alias; canonical minimum_element_size wins; positive and no greater than numeric maximum | compatibility lower-clamp spelling | FEM CPU/GPU capability-gated | `mesh_workflow.per_geometry[].minimum_element_size` |
| `maximum_element_size` | `float \| str \| None` | `None` | $\mathrm{m}$ | positive finite float or exact `auto` | coarse size target | FEM CPU/GPU capability-gated | `mesh_workflow.per_geometry[].maximum_element_size` |
| `minimum_element_size` | `float \| None` | `None` | $\mathrm{m}$ | positive and no greater than numeric maximum | lower size clamp | FEM CPU/GPU capability-gated | `mesh_workflow.per_geometry[].minimum_element_size` |
| `order` | `int \| None` | `None` | $1$ | prismatic route restricts order to `1`; other routes are backend-gated | FEM order request | FEM CPU/GPU capability-gated | `mesh_workflow.per_geometry[].order` |
| `calibrate_for` | `str \| None` | `None` | $1$ | normalized to a supported calibration name | calibration family | FEM CPU/GPU capability-gated | `mesh_workflow.per_geometry[].calibrate_for` |
| `size_preset` | `str \| None` | `None` | $1$ | normalized to `coarse`, `normal`, `fine`, `finer`, or `extra_fine` | preset family | FEM CPU/GPU capability-gated | `mesh_workflow.per_geometry[].size_preset` |
| `algorithm_2d` | `int \| None` | `None` | $1$ | stored without an authoring-time range check | Gmsh 2-D algorithm | FEM CPU/GPU capability-gated | `mesh_workflow.per_geometry[].algorithm_2d` |
| `algorithm_3d` | `int \| None` | `None` | $1$ | stored without an authoring-time range check | Gmsh 3-D algorithm | FEM CPU/GPU capability-gated | `mesh_workflow.per_geometry[].algorithm_3d` |
| `optimize` | `str \| None` | `None` | $1$ | stored without an authoring-time vocabulary check | optimizer | FEM CPU/GPU capability-gated | `mesh_workflow.per_geometry[].optimize` |
| `optimize_iterations` | `int \| None` | `None` (effective state `1`) | $1$ | stored without an authoring-time range check | optimizer passes | FEM CPU/GPU capability-gated | `mesh_workflow.per_geometry[].optimize_iterations` |
| `smoothing_steps` | `int \| None` | `None` (effective state `1`) | $1$ | stored without an authoring-time range check | smoothing passes | FEM CPU/GPU capability-gated | `mesh_workflow.per_geometry[].smoothing_steps` |
| `size_factor` | `float \| None` | `None` (effective state `1.0`) | $1$ | stored without an authoring-time positivity check | preset multiplier | FEM CPU/GPU capability-gated | `mesh_workflow.per_geometry[].size_factor` |
| `size_from_curvature` | `int \| None` | `None` (effective state `0`) | $1$ | stored without an authoring-time range check | curvature sampling (points per $2\pi$) | FEM CPU/GPU capability-gated | `mesh_workflow.per_geometry[].size_from_curvature` |
| `curvature_factor` | `float \| None` | `None` | $1$ | coerced with `float()` | curvature refinement | FEM CPU/GPU capability-gated | `mesh_workflow.per_geometry[].curvature_factor` |
| `maximum_element_growth_rate` | `float \| None` | `None` | $1$ | finite, strictly greater than `1.0`, and at most `2.5` | neighboring-zone growth | FEM CPU/GPU capability-gated | `mesh_workflow.per_geometry[].maximum_element_growth_rate` |
| `growth_rate` | `float \| None` | `None` | $1$ | compatibility alias; canonical maximum_element_growth_rate wins; finite, strictly greater than `1.0`, and at most `2.5` | compatibility growth spelling | FEM CPU/GPU capability-gated | `mesh_workflow.per_geometry[].maximum_element_growth_rate` |
| `narrow_regions` | `int \| None` | `None` (effective state `0`) | $1$ | non-Boolean integer at least `0` | narrow-gap request | FEM CPU/GPU capability-gated | `mesh_workflow.per_geometry[].narrow_regions` |
| `narrow_region_resolution` | `float \| None` | `None` | $1$ | coerced with `float()` | narrow-gap strength | FEM CPU/GPU capability-gated | `mesh_workflow.per_geometry[].narrow_region_resolution` |
| `interface_maximum_element_size` | `float \| None` | `None` | $\mathrm{m}$ | positive | interface target | FEM CPU/GPU capability-gated | `mesh_workflow.per_geometry[].interface_hmax` |
| `interface_hmax` | `float \| None` | `None` | $\mathrm{m}$ | compatibility alias; canonical interface_maximum_element_size wins; positive | compatibility interface-target spelling | FEM CPU/GPU capability-gated | `mesh_workflow.per_geometry[].interface_hmax` |
| `interface_thickness` | `float \| None` | `None` | $\mathrm{m}$ | positive | interface-band thickness | FEM CPU/GPU capability-gated | `mesh_workflow.per_geometry[].interface_thickness` |
| `transition_distance` | `float \| str \| None` | `None` | $\mathrm{m}$ | non-negative numeric value or supported boundary symbol | interface transition span | FEM CPU/GPU capability-gated | `mesh_workflow.per_geometry[].transition_distance` |
| `transition_growth` | `float \| None` | `None` | $1$ | positive | interface transition growth | FEM CPU/GPU capability-gated | `mesh_workflow.per_geometry[].transition_growth` |
| `edge_maximum_element_size` | `float \| None` | `None` | $\mathrm{m}$ | positive | edge target | FEM CPU/GPU capability-gated | `mesh_workflow.per_geometry[].edge_hmax` |
| `edge_hmax` | `float \| None` | `None` | $\mathrm{m}$ | compatibility alias; canonical edge_maximum_element_size wins; positive | compatibility edge-target spelling | FEM CPU/GPU capability-gated | `mesh_workflow.per_geometry[].edge_hmax` |
| `edge_thickness` | `float \| None` | `None` | $\mathrm{m}$ | positive; perimeter validation also applies | edge-band width | FEM CPU/GPU capability-gated | `mesh_workflow.per_geometry[].edge_thickness` |
| `edge_transition_distance` | `float \| str \| None` | `None` | $\mathrm{m}$ | positive numeric value or supported boundary symbol | edge transition span | FEM CPU/GPU capability-gated | `mesh_workflow.per_geometry[].edge_transition_distance` |
| `corner_maximum_element_size` | `float \| None` | `None` | $\mathrm{m}$ | positive | corner target | FEM CPU/GPU capability-gated | `mesh_workflow.per_geometry[].corner_hmax` |
| `corner_hmax` | `float \| None` | `None` | $\mathrm{m}$ | compatibility alias; canonical corner_maximum_element_size wins; positive | compatibility corner-target spelling | FEM CPU/GPU capability-gated | `mesh_workflow.per_geometry[].corner_hmax` |
| `corner_extent` | `float \| None` | `None` | $\mathrm{m}$ | positive; perimeter validation also applies | corner extent | FEM CPU/GPU capability-gated | `mesh_workflow.per_geometry[].corner_extent` |
| `corner_transition_distance` | `float \| str \| None` | `None` | $\mathrm{m}$ | positive numeric value or supported boundary symbol | corner transition span | FEM CPU/GPU capability-gated | `mesh_workflow.per_geometry[].corner_transition_distance` |
| `boundary_layer_count` | `int \| None` | `None` | $1$ | `int()` coercion and at least `1` | boundary-layer count | FEM CPU/GPU capability-gated | `mesh_workflow.per_geometry[].boundary_layer_count` |
| `boundary_layer_thickness` | `float \| None` | `None` | $\mathrm{m}$ | positive | boundary-layer thickness | FEM CPU/GPU capability-gated | `mesh_workflow.per_geometry[].boundary_layer_thickness` |
| `boundary_layer_stretching` | `float \| None` | `None` | $1$ | positive | boundary-layer growth | FEM CPU/GPU capability-gated | `mesh_workflow.per_geometry[].boundary_layer_stretching` |
| `boundary_layer_target_surface_tags` | `Sequence[int] \| None` | `None` | $1$ | normalized by `_normalize_int_tags` | target surfaces | FEM CPU/GPU capability-gated | `mesh_workflow.per_geometry[].boundary_layer_target_surface_tags` |
| `boundary_layer_target_curve_tags` | `Sequence[int] \| None` | `None` | $1$ | normalized by `_normalize_int_tags` | target curves | FEM CPU/GPU capability-gated | `mesh_workflow.per_geometry[].boundary_layer_target_curve_tags` |
| `boundary_layer_target_surface_selectors` | `Sequence[Mapping] \| None` | `None` | $1$ | normalized by `_normalize_selector_list` | semantic target surfaces | FEM CPU/GPU capability-gated | `mesh_workflow.per_geometry[].boundary_layer_target_surface_selectors` |
| `boundary_layer_target_curve_selectors` | `Sequence[Mapping] \| None` | `None` | $1$ | normalized by `_normalize_selector_list` | semantic target curves | FEM CPU/GPU capability-gated | `mesh_workflow.per_geometry[].boundary_layer_target_curve_selectors` |
| `compute_quality` | `bool \| None` | `None` (effective state `False`) | $1$ | no explicit Python type check | aggregate quality request | FEM CPU/GPU capability-gated | `mesh_workflow.per_geometry[].compute_quality` |
| `per_element_quality` | `bool \| None` | `None` (effective state `False`) | $1$ | no explicit Python type check | per-element quality request | FEM CPU/GPU capability-gated | `mesh_workflow.per_geometry[].per_element_quality` |
| `kind` | `str` | required | $1$ | appended without authoring-time field validation | manual Gmsh field kind | FEM CPU/GPU capability-gated | `mesh_workflow.per_geometry[].size_fields[].kind` |
| `**params` | `Mapping[str, object]` | `{}` | $1$ | appended without authoring-time field validation | manual Gmsh field parameters | FEM CPU/GPU capability-gated | `mesh_workflow.per_geometry[].size_fields[].params` |

`_build_field_stack` is an internal normalization step; public scripts author object/universe policies and manual size fields through `GeometryMeshHandle`.

```python
# %% Study, universe, and airbox grading
import fullmag as fm

nm = 1.0e-9
study = fm.study("refinement_contract")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.universe(
    mode="manual",
    size=(220.0 * nm, 170.0 * nm, 80.0 * nm),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(
    maximum_element_size=24.0 * nm,
    minimum_element_size=8.0 * nm,
    maximum_element_growth_rate=1.35,
    grading="geometric",
)

# %% Ferromagnet with interface, edge, corner, and hotspot size fields
film = study.geometry(fm.Box(size=(100 * nm, 50 * nm, 5 * nm), name="film"), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.texture.uniform(1.0, 1.0e-4, 0.0)
film.mesh(
    mesh_strategy="free_tetrahedral",
    calibrate_for="general_physics",
    size_preset="fine",
    size_factor=1.0,
    maximum_element_size=8.0 * nm,
    minimum_element_size=3.0 * nm,
    maximum_element_growth_rate=1.25,
    interface_maximum_element_size=4.0 * nm,
    interface_thickness=8.0 * nm,
    transition_distance="airbox_boundary",
    edge_maximum_element_size=3.0 * nm,
    edge_thickness=10.0 * nm,
    corner_maximum_element_size=2.0 * nm,
    corner_extent=6.0 * nm,
    order=1,
    compute_quality=True,
    per_element_quality=True,
)
film.mesh.size_field("Ball", VIn=2.0 * nm, VOut=8.0 * nm, Radius=15.0 * nm, XCenter=0.0, YCenter=0.0, ZCenter=0.0)

# %% Interactions and relaxation stage
study.exchange()
study.demag(realization="poisson_robin")
study.stages.add_relax(stage_id="equilibrium", algorithm="llg_overdamped", dt=5.0e-13, max_steps=1)
```

(refinement-problem-ir)=
## ProblemIR

Object-level controls, preset names, perimeter/interface zones, and manual `size_fields` lower to `runtime_metadata.mesh_workflow.per_geometry[]` and region-owned records. The composed Gmsh field stack produced by `_build_field_stack` is resolved execution provenance, not an authored IR literal.

(refinement-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

- **Requested intent:** Calibrations, presets, size clamps, growth rates, interface/edge/corner descriptors, and manual `size_fields` stored in `mesh_workflow.per_geometry[]`.
- **Resolved execution:** The normalized field plan, applied Gmsh options, realized local size distributions, and scoped `MeshQualityReport`.
- **Validation errors:** Non-positive sizes, `minimum_element_size > maximum_element_size`, growth rates outside $(1.0, 2.5]$, invalid calibration/preset names, unsupported region order (`!= 1`), or malformed perimeter bounds.
- **Unsupported combinations:** A semantic selector resolving zero entities, or an unsupported region/field option, is rejected or explicitly marked skipped/ignored with a diagnostic rather than silently reported as applied refinement.

(refinement-discrete-realization)=
## Discrete realization

| Solver | Device | Status | Reason / Limit |
| --- | --- | --- | --- |
| FEM | CPU | implemented | Unstructured Gmsh field-stack composition (`_build_field_stack`, `_apply_mesh_options`) |
| FEM | GPU | implemented (capability-gated) | Consumes the realized MeshIR artifact subject to solver/device topology gates |
| FDM | CPU | not applicable | Structured Cartesian FDM grid refinement is owned by [FDM Cartesian grids](fdm-grids.md) |
| FDM | GPU | not applicable | Structured Cartesian FDM grid refinement is owned by [FDM Cartesian grids](fdm-grids.md) |

### Control Room workflow

1. In **Explorer**, select the magnetic object's **Mesh** node to open `ObjectMeshSpecPanel.tsx` (`ObjectMeshInspectorSpecPanel`). Enable **Use object policy** to override defaults.
2. Configure **Mesh Size Presets**, **Element Size Parameters**, **Interface and Transition Refinement**, **Core Relaxation**, **Manual Size Field**, and **Edge and Corner Refinement**, then select **Apply Object Policy**.
3. Build via **Build Mesh** (`mesh.build-selected`) or **Apply & Build Shared-Domain Mesh** (`mesh.build-shared-domain`).
4. Inspect backend-resolved effective values, size histograms, and scoped quality distributions in the **Quality** and **History** views (`MeshQualitySpec.tsx`, `MeshSizeFieldSpec.tsx`). A populated form alone is not evidence that a field matched any geometric entity.

(refinement-implementation-mapping)=
## Implementation mapping

`GeometryMeshHandle` and semantic field constructors in `mesh_controls.py` (`surface_shell`, `object_core_relaxation`, `edge_distance_threshold`, `interface_shell`) own public descriptors; `resolve_mesh_size_controls` in `_gmsh_types.py` expands presets; `_build_problem` and `Problem.to_ir()` preserve `runtime_metadata.mesh_workflow.per_geometry`; `_build_field_stack` composes the Gmsh field stack; `_apply_mesh_options` applies it during realization; `realize_fem_domain_mesh_asset_from_components_with_report`, `fullmag_plan::plan`, and `run_planned_problem` materialize and consume the resulting mesh artifact.

(refinement-validation)=
## Validation

1. Verify that geometry and mesh revisions match, inverted/degenerate counts are zero, and `MeshQualityReport` SICN/gamma distributions meet study tolerances (`gamma_min=0.08` and `SICN p05=0.1` are implementation gates for named report paths, not universal physical acceptance criteria).
2. Run at least three discretizations refining only the controlling size parameter while holding geometry, material parameters, solver tolerances, initial state, and sampling fixed, reporting $\varepsilon_h$ via {eq}`eq-meshing-relative-change-refinement`.
3. For dynamics compare resonance frequency, linewidth, and mode profile; for relaxation compare total energy and texture; for demagnetization verify outer-boundary distance independently from local mesh size.

(refinement-limitations)=
## Limitations

- The field stack does not certify physical accuracy; convergence remains observable-specific.
- Very aggressive size jumps can degrade element quality and linear-solver conditioning despite small local elements.
- Very small `minimum_element_size` cannot repair a defective or coarse imported STL surface.
- Raw Gmsh tags are fragile across geometry rebuilds; prefer semantic selectors (see [Selectors and attributes](fem/shared-domain/selectors-and-attributes.md)).

(refinement-scientific-bibliography)=
## Scientific bibliography

- C. Geuzaine and J.-F. Remacle, “Gmsh: a three-dimensional finite element mesh generator with built-in pre- and post-processing facilities,” *International Journal for Numerical Methods in Engineering* **79** (2009), 1309–1331, [doi:10.1002/nme.2579](https://doi.org/10.1002/nme.2579).
- C. Abert, “Micromagnetics and spintronics: models and numerical methods,” *European Physical Journal B* **92**, 120 (2019), [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).

## Related documentation

- [FDM grids](fdm-grids.md)
- [FEM ferromagnet meshes](fem/ferromagnet/index.md)
- [Airbox grading](fem/airbox/grading.md)

(refinement-source-code-index)=
## Source-code index

| ID | Path | Symbol | Responsibility | Evidence |
| --- | --- | --- | --- | --- |
| field_stack | [`packages/fullmag-py/src/fullmag/meshing/_size_field_plan.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/_size_field_plan.py#L1179) | [`_build_field_stack`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/_size_field_plan.py#L1179) | ordered refinement-field normalization | source-inspected |
| public_study | [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L7610) | [`study`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L7610) | public study entry point | source-inspected |
| mesh_authoring | [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L1679) | [`class GeometryMeshHandle`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L1679) | per-body mesh authoring | source-inspected |
| surface_shell | [`packages/fullmag-py/src/fullmag/meshing/mesh_controls.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/mesh_controls.py#L107) | [`surface_shell`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/mesh_controls.py#L107) | public refinement descriptor | source-inspected |
| problem_lowering | [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L10324) | [`_build_problem`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L10324) | builder-state lowering | source-inspected |
| problem_ir | [`packages/fullmag-py/src/fullmag/model/problem.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/problem.py#L2733) | [`class Problem`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/problem.py#L2733) | ProblemIR mesh-workflow serialization | source-inspected |
| domain_realization | [`packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py#L4283) | [`realize_fem_domain_mesh_asset_from_components_with_report`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py#L4283) | field-plan mesh realization | source-inspected |
| planner | [`crates/fullmag-plan/src/lib.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-plan/src/lib.rs#L183) | [`plan`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-plan/src/lib.rs#L183) | ProblemIR planning and compatibility | source-inspected |
| runtime | [`crates/fullmag-runner/src/lib.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/lib.rs#L3784) | [`run_planned_problem`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/lib.rs#L3784) | planned runtime dispatch | source-inspected |
| object_policy_ui | [`apps/control-room/src/modules/inspector/panels/mesh-details/ObjectMeshSpecPanel.tsx`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/apps/control-room/src/modules/inspector/panels/mesh-details/ObjectMeshSpecPanel.tsx#L180) | [`function ObjectMeshInspectorSpecPanel`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/apps/control-room/src/modules/inspector/panels/mesh-details/ObjectMeshSpecPanel.tsx#L180) | Control Room object mesh policy and size-field inspector | source-inspected |
