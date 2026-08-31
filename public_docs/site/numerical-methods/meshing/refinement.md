---
title: "Mesh sizing, local refinement and convergence"
description: "Physics-guided mesh-size selection, Gmsh size fields and convergence evidence."
summary: "Refinement should be driven by physical length scales and observable error. Fullmag combines calibrated presets, explicit min/max sizes, interface/edge/corner controls and structured size fields."
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-24
reviewed_revision: a1de38b4d7dad275dccbdbfd937b757d6ca7ee99
source_of_truth: "Mesh-size resolution pipeline, semantic size fields, Control Room object/airbox policies and quality resources"
---

(public-docs-numerical-methods-meshing-refinement)=
# Mesh sizing, local refinement and convergence

(refinement-problem-statement)=
## Problem statement

Refinement composes object bulk, interface, transition, perimeter, manual-hotspot and region-owned fields into one realized Gmsh field stack.

(refinement-governing-equations)=
## Governing equations

```{math}
:label: eq-refinement-stack-contract

\mathcal F=\mathcal F_{bulk}\cup\mathcal F_{interface}\cup\mathcal F_{transition}\cup\mathcal F_{perimeter}\cup\mathcal F_{hotspot}\cup\mathcal F_{region}.
```

(refinement-symbols-and-si-units)=
## Symbols and SI units

| Token | Meaning | SI unit |
| --- | --- | --- |
| $\mathcal F$ | realized field stack | $1$ |
| $\mathcal F_{bulk}$ | object bulk fields | $1$ |
| $\mathcal F_{interface}$ | interface fields | $1$ |

(refinement-assumptions-and-validity)=
## Assumptions and validity

The union denotes ordered composition in `_build_field_stack`, not a physical superposition rule. Region order other than one is explicitly rejected in the shown source path.

(refinement-python-api)=
## Python API

### Complete public signature and IR matrix

The following rows are the exhaustive public-signature contract for this page; each row mirrors one public_api.parameters entry in the source map.

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| hmax | float \| str \| None | None | $\mathrm{m}$ | compatibility alias; canonical maximum_element_size wins; numeric values must be positive and the only accepted string is exact `auto` | compatibility coarse-size spelling | FEM CPU/GPU capability-gated | mesh_workflow.per_geometry[].maximum_element_size |
| hmin | float \| None | None | $\mathrm{m}$ | compatibility alias; canonical minimum_element_size wins; positive and no greater than numeric maximum | compatibility lower-clamp spelling | FEM CPU/GPU capability-gated | mesh_workflow.per_geometry[].minimum_element_size |
| maximum_element_size | float \| str \| None | None | $\mathrm{m}$ | positive finite float or exact `auto` | coarse size target | FEM CPU/GPU capability-gated | mesh_workflow.per_geometry[].maximum_element_size |
| minimum_element_size | float \| None | None | $\mathrm{m}$ | positive and no greater than numeric maximum | lower size clamp | FEM CPU/GPU capability-gated | mesh_workflow.per_geometry[].minimum_element_size |
| order | int \| None | None | $1$ | prismatic route restricts order to `1`; other routes are backend-gated | FEM order request | FEM CPU/GPU capability-gated | mesh_workflow.per_geometry[].order |
| calibrate_for | str \| None | None | $1$ | normalized to a supported calibration name | calibration family | FEM CPU/GPU capability-gated | mesh_workflow.per_geometry[].calibrate_for |
| size_preset | str \| None | None | $1$ | normalized to `coarse`, `normal`, `fine`, `finer`, or `extra_fine` | preset family | FEM CPU/GPU capability-gated | mesh_workflow.per_geometry[].size_preset |
| algorithm_2d | int \| None | None | $1$ | stored without an authoring-time range check | Gmsh 2-D algorithm | FEM CPU/GPU capability-gated | mesh_workflow.per_geometry[].algorithm_2d |
| algorithm_3d | int \| None | None | $1$ | stored without an authoring-time range check | Gmsh 3-D algorithm | FEM CPU/GPU capability-gated | mesh_workflow.per_geometry[].algorithm_3d |
| optimize | str \| None | None | $1$ | stored without an authoring-time vocabulary check | optimizer | FEM CPU/GPU capability-gated | mesh_workflow.per_geometry[].optimize |
| optimize_iterations | int \| None | None (effective state `1`) | passes | stored without an authoring-time range check | optimizer passes | FEM CPU/GPU capability-gated | mesh_workflow.per_geometry[].optimize_iterations |
| smoothing_steps | int \| None | None (effective state `1`) | passes | stored without an authoring-time range check | smoothing passes | FEM CPU/GPU capability-gated | mesh_workflow.per_geometry[].smoothing_steps |
| size_factor | float \| None | None (effective state `1.0`) | $1$ | stored without an authoring-time positivity check | preset multiplier | FEM CPU/GPU capability-gated | mesh_workflow.per_geometry[].size_factor |
| size_from_curvature | int \| None | None (effective state `0`) | points per $2\pi$ | stored without an authoring-time range check | curvature sampling | FEM CPU/GPU capability-gated | mesh_workflow.per_geometry[].size_from_curvature |
| curvature_factor | float \| None | None | $1$ | coerced with `float()` | curvature refinement | FEM CPU/GPU capability-gated | mesh_workflow.per_geometry[].curvature_factor |
| maximum_element_growth_rate | float \| None | None | $1$ | finite, positive and at most `2.5` | neighboring-zone growth | FEM CPU/GPU capability-gated | mesh_workflow.per_geometry[].maximum_element_growth_rate |
| growth_rate | float \| None | None | $1$ | compatibility alias; canonical maximum_element_growth_rate wins; finite, positive and at most `2.5` | compatibility growth spelling | FEM CPU/GPU capability-gated | mesh_workflow.per_geometry[].maximum_element_growth_rate |
| narrow_regions | int \| None | None (effective state `0`) | elements | non-Boolean integer at least `0` | narrow-gap request | FEM CPU/GPU capability-gated | mesh_workflow.per_geometry[].narrow_regions |
| narrow_region_resolution | float \| None | None | $1$ | coerced with `float()` | narrow-gap strength | FEM CPU/GPU capability-gated | mesh_workflow.per_geometry[].narrow_region_resolution |
| interface_maximum_element_size | float \| None | None | $\mathrm{m}$ | positive | interface target | FEM CPU/GPU capability-gated | mesh_workflow.per_geometry[].interface_hmax |
| interface_hmax | float \| None | None | $\mathrm{m}$ | compatibility alias; canonical interface_maximum_element_size wins; positive | compatibility interface-target spelling | FEM CPU/GPU capability-gated | mesh_workflow.per_geometry[].interface_hmax |
| interface_thickness | float \| None | None | $\mathrm{m}$ | positive | interface-band thickness | FEM CPU/GPU capability-gated | mesh_workflow.per_geometry[].interface_thickness |
| transition_distance | float \| str \| None | None | $\mathrm{m}$ or symbol | non-negative numeric value or supported boundary symbol | interface transition span | FEM CPU/GPU capability-gated | mesh_workflow.per_geometry[].transition_distance |
| transition_growth | float \| None | None | $1$ | positive | interface transition growth | FEM CPU/GPU capability-gated | mesh_workflow.per_geometry[].transition_growth |
| edge_maximum_element_size | float \| None | None | $\mathrm{m}$ | positive | edge target | FEM CPU/GPU capability-gated | mesh_workflow.per_geometry[].edge_hmax |
| edge_hmax | float \| None | None | $\mathrm{m}$ | compatibility alias; canonical edge_maximum_element_size wins; positive | compatibility edge-target spelling | FEM CPU/GPU capability-gated | mesh_workflow.per_geometry[].edge_hmax |
| edge_thickness | float \| None | None | $\mathrm{m}$ | positive; perimeter validation also applies | edge-band width | FEM CPU/GPU capability-gated | mesh_workflow.per_geometry[].edge_thickness |
| edge_transition_distance | float \| str \| None | None | $\mathrm{m}$ or symbol | positive numeric value or supported boundary symbol | edge transition span | FEM CPU/GPU capability-gated | mesh_workflow.per_geometry[].edge_transition_distance |
| corner_maximum_element_size | float \| None | None | $\mathrm{m}$ | positive | corner target | FEM CPU/GPU capability-gated | mesh_workflow.per_geometry[].corner_hmax |
| corner_hmax | float \| None | None | $\mathrm{m}$ | compatibility alias; canonical corner_maximum_element_size wins; positive | compatibility corner-target spelling | FEM CPU/GPU capability-gated | mesh_workflow.per_geometry[].corner_hmax |
| corner_extent | float \| None | None | $\mathrm{m}$ | positive; perimeter validation also applies | corner extent | FEM CPU/GPU capability-gated | mesh_workflow.per_geometry[].corner_extent |
| corner_transition_distance | float \| str \| None | None | $\mathrm{m}$ or symbol | positive numeric value or supported boundary symbol | corner transition span | FEM CPU/GPU capability-gated | mesh_workflow.per_geometry[].corner_transition_distance |
| boundary_layer_count | int \| None | None | layers | `int()` coercion and at least `1` | boundary-layer count | FEM CPU/GPU capability-gated | mesh_workflow.per_geometry[].boundary_layer_count |
| boundary_layer_thickness | float \| None | None | $\mathrm{m}$ | positive | boundary-layer thickness | FEM CPU/GPU capability-gated | mesh_workflow.per_geometry[].boundary_layer_thickness |
| boundary_layer_stretching | float \| None | None | $1$ | positive | boundary-layer growth | FEM CPU/GPU capability-gated | mesh_workflow.per_geometry[].boundary_layer_stretching |
| boundary_layer_target_surface_tags | Sequence[int] \| None | None | $1$ | normalized by `_normalize_int_tags` | target surfaces | FEM CPU/GPU capability-gated | mesh_workflow.per_geometry[].boundary_layer_target_surface_tags |
| boundary_layer_target_curve_tags | Sequence[int] \| None | None | $1$ | normalized by `_normalize_int_tags` | target curves | FEM CPU/GPU capability-gated | mesh_workflow.per_geometry[].boundary_layer_target_curve_tags |
| boundary_layer_target_surface_selectors | Sequence[Mapping] \| None | None | $1$ | normalized by `_normalize_selector_list` | semantic target surfaces | FEM CPU/GPU capability-gated | mesh_workflow.per_geometry[].boundary_layer_target_surface_selectors |
| boundary_layer_target_curve_selectors | Sequence[Mapping] \| None | None | $1$ | normalized by `_normalize_selector_list` | semantic target curves | FEM CPU/GPU capability-gated | mesh_workflow.per_geometry[].boundary_layer_target_curve_selectors |
| compute_quality | bool \| None | None (effective state `False`) | $1$ | no explicit Python type check | aggregate quality request | FEM CPU/GPU capability-gated | mesh_workflow.per_geometry[].compute_quality |
| per_element_quality | bool \| None | None (effective state `False`) | $1$ | no explicit Python type check | per-element quality request | FEM CPU/GPU capability-gated | mesh_workflow.per_geometry[].per_element_quality |
| kind | str | required | $1$ | appended without authoring-time field validation | manual Gmsh field kind | FEM CPU/GPU capability-gated | mesh_workflow.per_geometry[].size_fields[].kind |
| **params | Mapping[str, object] | {} | mixed | appended without authoring-time field validation | manual Gmsh field parameters | FEM CPU/GPU capability-gated | mesh_workflow.per_geometry[].size_fields[].params |



This page's public controls are normalized before `_build_field_stack`; the internal function is not a user callable. Use the documented mesh-policy/size-field API and inspect the resulting stack.

| Python | Type | Default | SI unit | Validation and coercion | Meaning | Backend support | ProblemIR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `maximum_element_size`, `hmax` | `float | str | None` | `None` | m | numeric values are positive; the only accepted string is exact `"auto"`; canonical name wins | coarse target | FEM CPU/GPU capability-gated | `per_geometry[].maximum_element_size` |
| `minimum_element_size`, `hmin` | `float | None` | `None` | m | positive and no greater than numeric `maximum_element_size`; canonical name wins | lower clamp | FEM CPU/GPU capability-gated | `per_geometry[].minimum_element_size` |
| `order` | `int | None` | `None` | 1 | prismatic intent permits only `1`; other orders are realized-backend decisions | FEM basis request | FEM CPU/GPU capability-gated | `per_geometry[].order` |
| `calibrate_for`, `size_preset` | `str | None` | `None` | 1 | calibration is normalized; preset is normalized to `coarse`, `normal`, `fine`, `finer`, or `extra_fine` | preset selection | FEM CPU/GPU capability-gated | `per_geometry[].calibrate_for`, `per_geometry[].size_preset` |
| `algorithm_2d`, `algorithm_3d`, `optimize` | `int | str | None` | `None` | 1 | stored without an authoring-time range or vocabulary check | Gmsh algorithms and optimizer | FEM CPU/GPU capability-gated | matching `per_geometry[]` field |
| `optimize_iterations`, `smoothing_steps` | `int | None` | `None` (stored defaults `1`) | passes | direct public call stores values; recipe validation requires non-negative integral smoothing | optimization/smoothing passes | FEM CPU/GPU capability-gated | matching `per_geometry[]` field |
| `size_factor`, `size_from_curvature`, `curvature_factor` | `float | int | None` | `None` (stored `1.0`, `0`, `None`) | 1 | `curvature_factor` uses `float()`; the first two are stored directly by this call | global and curvature sizing | FEM CPU/GPU capability-gated | matching `per_geometry[]` field |
| `maximum_element_growth_rate`, `growth_rate` | `float | None` | `None` | 1 | finite, positive, and at most `2.5`; canonical name wins | requested growth | FEM CPU/GPU capability-gated | `per_geometry[].maximum_element_growth_rate` |
| `narrow_regions`, `narrow_region_resolution` | `int | float | None` | `None` (stored `0`, `None`) | elements, 1 | `narrow_regions` is non-Boolean integer >= 0; resolution uses `float()` | narrow-gap refinement | FEM CPU/GPU capability-gated | matching `per_geometry[]` field |
| `interface_maximum_element_size`, `interface_hmax`, `interface_thickness`, `transition_distance`, `transition_growth` | `float | str | None` | `None` | m, 1 | positive sizes/thickness/growth; `transition_distance` is non-negative float or normalized `"airbox_boundary"`; canonical size name wins | interface band | FEM CPU/GPU capability-gated | interface fields in `per_geometry[]` |
| `edge_maximum_element_size`, `edge_hmax`, `edge_thickness`, `edge_transition_distance` | `float | str | None` | `None` | m | positive sizes/thickness; transition is positive float or normalized `"airbox_boundary"`; size and thickness must occur together | edge band | FEM CPU/GPU capability-gated | edge fields in `per_geometry[]` |
| `corner_maximum_element_size`, `corner_hmax`, `corner_extent`, `corner_transition_distance` | `float | str | None` | `None` | m | positive size/extent; transition is positive float or normalized `"airbox_boundary"`; size and extent must occur together and corner size <= edge size | corner band | FEM CPU/GPU capability-gated | corner fields in `per_geometry[]` |
| `boundary_layer_count`, `boundary_layer_thickness`, `boundary_layer_stretching` | `int | float | None` | `None` | layers, m, 1 | count uses `int()` and is >= 1; thickness and stretching use `float()` then require positive | boundary layer | FEM CPU/GPU capability-gated | matching `per_geometry[]` field |
| `boundary_layer_target_surface_tags`, `boundary_layer_target_curve_tags` | `Sequence[int] | None` | `None` | 1 | each element uses `int()` and must be > 0 | numeric targets | FEM CPU/GPU capability-gated | matching `per_geometry[]` field |
| `boundary_layer_target_surface_selectors`, `boundary_layer_target_curve_selectors` | `Sequence[Mapping] | None` | `None` | 1 | every item must be a mapping and is copied with `dict()`; semantic selector parsing belongs downstream | semantic targets | FEM CPU/GPU capability-gated | matching `per_geometry[]` field |
| `compute_quality`, `per_element_quality` | `bool | None` | `None` (stored `False`) | 1 | no explicit type check in this public call | quality-report request | FEM CPU/GPU capability-gated | matching `per_geometry[]` field |
| `size_field(kind, **params)` | `str`, `Mapping[str, object]` | required, `{}` | mixed | appends `{"kind": kind, "params": dict(params)}` without authoring-time field validation | manual Gmsh field | FEM CPU/GPU capability-gated | `per_geometry[].size_fields[]` |

```python
# %%
import fullmag as fm

# %%
study = fm.study("refinement_contract")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.universe(
    mode="manual",
    size=(220.0e-9, 170.0e-9, 80.0e-9),
    center=(0.0, 0.0, 0.0),
    padding=(20.0e-9, 20.0e-9, 20.0e-9),
)
study.universe.mesh(
    maximum_element_size=12.0e-9,
    minimum_element_size=6.0e-9,
    maximum_element_growth_rate=1.3,
    grading="geometric",
)
film = study.geometry(fm.Box(size=(100e-9, 50e-9, 5e-9), name="film"), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.texture.uniform(1.0, 0.0, 0.0)
film.mesh(
    maximum_element_size=8.0e-9,
    minimum_element_size=3.0e-9,
    maximum_element_growth_rate=1.2,
    interface_maximum_element_size=4.0e-9,
    interface_thickness=8.0e-9,
    transition_distance="airbox_boundary",
    edge_maximum_element_size=3.0e-9,
    edge_thickness=10.0e-9,
    corner_maximum_element_size=2.0e-9,
    corner_extent=6.0e-9,
)
film.mesh.size_field("Ball", VIn=2.0e-9, VOut=8.0e-9, Radius=15.0e-9)
study.exchange()
study.demag(realization="poisson_robin")
study.build_domain_mesh()
study.stages.add_relax(stage_id="equilibrium", dt=5.0e-13, max_steps=1)
```

(refinement-problem-ir)=
## Parameters

The complete parameter matrix in the Python API section is the public mesh-authoring contract.
Defaults, validation, ProblemIR lowering and capability-gated lanes are listed there and mirrored
by the adjacent source map.

## ProblemIR

Mesh-policy and size-field descriptors are normalized to per-geometry and region-owned records; the resulting field stack is resolved execution data, not a user-authored IR literal.

(refinement-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

**Requested intent** is the policy descriptor. **Resolved execution** is the assembled field list. **Validation errors** include unsupported region order and malformed region data. **Unsupported combinations** are rejected or skipped with a progress warning; neither is silently represented as applied refinement.

(refinement-discrete-realization)=
## Discrete realization

The cited owners build unstructured FEM fields. FDM CPU and GPU are `not-applicable` for this page contract; structured-grid refinement belongs to the linked FDM-grid page.

(refinement-implementation-mapping)=
## Implementation mapping

`GeometryMeshHandle` and `surface_shell` own public descriptors; `_build_problem` and `Problem.to_ir` preserve `runtime_metadata.mesh_workflow.per_geometry`; `_build_field_stack` composes realized Gmsh fields; the domain asset pipeline materializes the mesh; planner/runtime consume the artifact without proving convergence or GPU execution.

(refinement-validation)=
## Validation

Inspect realized field records and local-size distributions, then establish observable convergence. No runtime/device evidence is added by this documentation change.

(refinement-limitations)=
## Limitations

The stack itself does not certify a requested physical resolution; convergence remains observable-specific.

(refinement-scientific-bibliography)=
## Scientific bibliography

Geuzaine and Remacle, *IJNME* 79 (2009), [doi:10.1002/nme.2579](https://doi.org/10.1002/nme.2579).

(refinement-source-code-index)=
## Contract source-code index

| ID | Path | Symbol | Responsibility | Evidence |
| --- | --- | --- | --- | --- |
| field_stack | packages/fullmag-py/src/fullmag/meshing/_size_field_plan.py | _build_field_stack | ordered refinement-field normalization | source-inspected |
| public_study | packages/fullmag-py/src/fullmag/world.py | study | public study entry point | source-inspected |
| mesh_authoring | packages/fullmag-py/src/fullmag/world.py | class GeometryMeshHandle | per-body mesh authoring | source-inspected |
| surface_shell | packages/fullmag-py/src/fullmag/meshing/mesh_controls.py | surface_shell | public refinement descriptor | source-inspected |
| problem_lowering | packages/fullmag-py/src/fullmag/world.py | _build_problem | builder-state lowering | source-inspected |
| problem_ir | packages/fullmag-py/src/fullmag/model/problem.py | class Problem | ProblemIR mesh-workflow serialization | source-inspected |
| domain_realization | packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py | realize_fem_domain_mesh_asset_from_components_with_report | field-plan mesh realization | source-inspected |
| planner | crates/fullmag-plan/src/lib.rs | plan | ProblemIR planning and compatibility | source-inspected, runtime-unverified |
| runtime | crates/fullmag-runner/src/lib.rs | run_planned_problem | planned runtime dispatch | source-inspected, device-unverified |

**Last changes: 12:31 24.08.2026**

Refinement should be driven by physical length scales and observable error. Fullmag combines calibrated presets, explicit min/max sizes, interface/edge/corner controls and structured size fields.

::::{admonition} Implementation status
:class: important

Named calibrations, presets, explicit size bounds, interface/edge/corner controls, manual boxes and semantic size fields are implemented. Adaptive solve–estimate–remesh loops are documented separately and must not be inferred from static authoring controls.
::::

## Scope and purpose

Use this page to choose element/cell sizes, construct local grading zones and design a convergence
study. Refinement is not synonymous with globally decreasing `hmax`: it should target regions
responsible for the dominant discretization error while preserving acceptable element quality
and solver conditioning.

## Scientific and numerical model

### FDM scientific invariants (context only)

These criteria are contextual guidance for the separate FDM-grid page, not backend or implementation claims for this FEM refinement API.

An FDM grid stores the magnetization on a Cartesian lattice with cell dimensions
$\Delta x$, $\Delta y$ and $\Delta z$. Cell centers are

```{math}
:label: eq-meshing-fdm-cell-centres-refinement
\mathbf r_{ijk}=\mathbf r_0+
\left(i+\tfrac12,j+\tfrac12,k+\tfrac12\right)
\odot(\Delta x,\Delta y,\Delta z).
```

The cell size simultaneously controls geometry voxelization, finite-difference exchange and the
accuracy/cost of FFT demagnetization. It must therefore resolve the smallest magnetic length scale,
the smallest geometric feature and the desired boundary accuracy. The exchange-length expression

```{math}
:label: eq-meshing-fdm-exchange-length-refinement
\ell_{\mathrm{ex}}=\sqrt{\frac{2A}{\mu_0M_s^2}}
```

is a useful initial guide, but final values require a grid-refinement study. A one-cell film thickness
is a thickness-averaged discretization; it cannot represent a nonuniform mode across the thickness.


### FEM scientific invariants

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
:label: eq-meshing-exchange-length-refinement
\ell_{\mathrm{ex}}=\sqrt{\frac{2A}{\mu_0M_s^2}}.
```

Using an element size below roughly one half of the smallest relevant magnetic length scale is a
common initial choice, not a proof of convergence. Curved boundaries, surface charges, DMI, defects,
interfaces and through-thickness modes can demand a smaller local size.

A generic size field is a spatial target $h(\mathbf r)$. When several upper-bound fields are
active, the mesher normally receives their minimum,

```{math}
:label: eq-refinement-size-field-min-refinement
h_{target}(\mathbf r)=\min_j h_j(\mathbf r),
```

followed by global lower/upper clamps and growth controls. This means overlapping refinement
fields do not average; the finest request dominates. `ObjectCoreRelaxation` explicitly keeps a
fine surface/edge shell while allowing a coarser interior. Distance-threshold fields interpolate
from `SizeMin` near a selected entity to `SizeMax` over a specified distance.

Presets fill defaults. Explicit parameters and object-specific fields can override them. The
effective configuration resource is therefore the only reliable record of the resolved values.

## Selection guide

| Use case | Recommended choice | Reason |
| --- | --- | --- |
| Unknown problem / first mesh | `calibrate_for` + `normal` or `fine` | Provides a reproducible baseline before explicit convergence |
| Exchange/DMI texture localized in the bulk | local box or physics-driven field | Refine around the expected soliton/domain-wall region |
| Demag edge singularity / antidot | edge and corner refinement | Targets strong surface-charge gradients |
| Large 3-D body with smooth core | `ObjectCoreRelaxation` | Fine boundary shell, coarser interior |
| Magnet/air interface | interface shell + controlled transition | Protects field accuracy and conformity |

## Detailed refinement field guidance

| Python / IR key | Unit | Default | Validation | Numerical effect |
| --- | --- | --- | --- | --- |
| `maximum_element_size` | m | required for direct FEM generation | positive finite | coarse upper target; local size fields may request smaller elements |
| `minimum_element_size` | m | unset | positive and not greater than the maximum | lower size clamp for local refinement and curvature sizing |
| `maximum_element_growth_rate` | 1 | preset/backend dependent | positive | limits requested growth between neighboring size zones |
| `calibrate_for` | 1 | unset | named calibration family | selects physics-aware preset calibration |
| `size_preset` | 1 | unset | `coarse`, `normal`, `fine`, `finer`, or `extra_fine` after normalization | fills common size/growth/curvature controls before explicit overrides |
| `size_factor` | 1 | `1` | positive | multiplies preset-derived target sizes |
| `curvature_factor` | 1 | unset | positive when set | controls curvature-driven refinement; smaller values generally refine more |
| `narrow_region_resolution` | 1 | unset | positive when set | requests additional resolution in narrow geometric gaps/features |
| `order` | 1 | unset in `GeometryMeshHandle` | prismatic requests restrict it to `1`; other routes are backend-gated | finite-element polynomial order request |
| `algorithm_2d` | Gmsh ID | `6` | supported Gmsh 2-D algorithm number | surface triangulation before volume meshing |
| `algorithm_3d` | Gmsh ID | `1` | supported Gmsh 3-D algorithm number | volume tetrahedralization algorithm |
| `smoothing_steps` | passes | `1` | non-negative integer | post-generation node smoothing |
| `optimize` | 1 | unset | Gmsh optimizer name | optional quality optimization; does not replace convergence checks |
| `optimize_iterations` | passes | `1` | positive integer | number of optimizer passes |
| `compute_quality` | 1 | omitted retains `False` in Python; Control Room may author `True` | no explicit Python type check | requests aggregate quality metrics |
| `per_element_quality` | 1 | omitted retains `False` in Python; Control Room may author `True` | no explicit Python type check | requests per-element quality arrays and scoped distributions |
| `interface_maximum_element_size` | m | unset | positive | near-interface target size |
| `interface_thickness` | m | unset | positive | distance over which interface sizing remains active |
| `transition_distance` | m or symbolic | unset | positive or `airbox_boundary` when supported | ramp length from fine interface to coarse far field |
| `transition_growth` | 1 | unset | positive | requested growth across the transition |
| `edge_maximum_element_size` | m | unset | positive | target along selected/recovered object edges |
| `edge_thickness` | m | unset | positive | width of the finest edge band |
| `edge_transition_distance` | m or symbolic | unset | positive or supported symbolic value | edge-to-far-field ramp |
| `corner_maximum_element_size` | m | unset | positive; no edge-target ordering check is performed here | target at corners |
| `size_fields` | mixed | `[]` | validated field descriptors | composable spatial target fields |

## Complete refinement authoring example

**Complete Python example**

```python
import fullmag as fm

nm = 1.0e-9
study = fm.study("fem_local_refinement_reference")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.universe(
    mode="manual",
    size=(800 * nm, 500 * nm, 260 * nm),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(
    minimum_element_size=15 * nm,
    maximum_element_size=100 * nm,
    maximum_element_growth_rate=1.6,
    grading="geometric",
)

film = study.geometry(
    fm.Box(size=(600 * nm, 250 * nm, 10 * nm), name="film"),
    name="film",
)
film.mesh(
    mesh_strategy="free_tetrahedral",
    calibrate_for="general_physics",
    size_preset="fine",
    size_factor=1.0,
    minimum_element_size=3 * nm,
    maximum_element_size=10 * nm,
    maximum_element_growth_rate=1.35,
    order=1,
    compute_quality=True,
    per_element_quality=True,
)
film.mesh.size_field("Ball", VIn=3 * nm, VOut=10 * nm, Radius=30 * nm, XCenter=0.0, YCenter=0.0, ZCenter=0.0)
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.texture.uniform(1.0, 1.0e-4, 0.0)

study.exchange()
study.demag(realization="poisson_robin")
study.build_domain_mesh()
study.stages.add_relax(
    stage_id="equilibrium",
    algorithm="llg_overdamped",
    dt=5.0e-13,
    tolA=1.0e-4,
    max_steps=20_000,
)
```

## Control Room workflow

1. In **Explorer**, select the magnetic object's **Mesh** child (the object mesh-policy route).
2. In **Inspector → Object Mesh Policy**, enable **Use object policy** when an object-specific override
   is required.
3. Configure the relevant groups: **Mesh Size Presets**, **Element Size Parameters**,
   **Thin-Film Sweep Strategy**, **Interface and Transition Refinement**, **Backend Mesh Parameters**,
   **Core Relaxation**, **Manual Size Field**, and **Edge and Corner Refinement**.
4. Select **Apply Object Policy**. This stores authoring intent and invalidates mesh resources whose
   revision no longer matches the model.
5. Select **Build Mesh**. If the draft is dirty, the panel applies it first and dispatches the canonical
   `mesh.build-selected` command.
6. Open the **Quality** and **History** tabs. Compare requested and realized values, then inspect the
   scoped size/quality distributions and the raw build report before running a solver.

The read-only effective values come from backend resources. They must not be reconstructed from the
current form fields because presets, capability gates and backend normalization can change the
resolved configuration.

Use **Mesh Size Presets** for the reproducible baseline. Use **Element Size Parameters** for
explicit clamps and Gmsh controls. Configure **Interface and Transition Refinement**, **Core
Relaxation**, **Manual Size Field**, or **Edge and Corner Refinement** only where the physics
justifies them. The size histogram and scoped quality views should show the realized distribution;
a filled form is not evidence that a field matched any entity.

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

## Mesh-convergence protocol

A production result should include at least three discretizations. Refine only the parameter under
study while holding geometry, material parameters, solver tolerances, initial state and output
sampling fixed. Let $Q_h$ denote the observable for characteristic size $h$. Report

```{math}
:label: eq-meshing-relative-change-refinement
\varepsilon_h=\frac{|Q_h-Q_{h/\rho}|}{\max(|Q_{h/\rho}|,Q_{\mathrm{scale}})},
\qquad \rho>1,
```

with a documented scale for observables that can cross zero. For dynamics, compare resonance
frequency, linewidth and mode profile; for relaxation, compare total energy and texture; for demag,
compare field/energy and verify that moving the outer boundary does not change the result beyond the
chosen tolerance.

## Diagnostics and failure semantics

- A semantic selector resolving zero entities is an error or explicit no-op, never silent success.
- Raw Gmsh tags are fragile across geometry rebuilds; prefer semantic selectors.
- An aggressive size jump can create poor quality or solver-conditioning problems despite a
  locally fine mesh.
- A preset name without effective numeric values is insufficient provenance.
- Refine geometry and field sampling together for imported/curved boundaries; very small `hmin`
  cannot repair a defective surface asset.
- A lower element count after adding refinement can indicate that another size field was replaced
  rather than combined; inspect the normalized field plan.

## Where this is implemented

| Responsibility | Repository source | Stable owner / symbol |
| --- | --- | --- |
| Mesh-size presets and resolution | [`packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py) | `MESH_SIZE_PRESETS, resolve_mesh_size_controls` |
| Semantic field constructors | [`packages/fullmag-py/src/fullmag/meshing/mesh_controls.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/meshing/mesh_controls.py) | `object_core_relaxation, edge_distance_threshold, interface_shell` |
| Field-plan normalization | [`packages/fullmag-py/src/fullmag/meshing/_size_field_plan.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/meshing/_size_field_plan.py) | `size-field plan` |
| Gmsh field application | [`packages/fullmag-py/src/fullmag/meshing/_gmsh_fields.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/meshing/_gmsh_fields.py) | `_apply_mesh_options` |
| Object policy UI | [`apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanel.tsx`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanel.tsx) | `ObjectMeshPolicyPanel` |
| Size-field preview resource | [`apps/control-room/src/kernel/resources/geometryLifecycleResources.ts`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/apps/control-room/src/kernel/resources/geometryLifecycleResources.ts) | `object mesh size-field resource` |

Implementation map reviewed against commit `5db00ccf0113b9756fec2d46feb36ade762b12c2` on 2026-08-24.

## Related documentation

- [FDM grids](fdm-grids.md)
- [FEM ferromagnet meshes](fem/ferromagnet/index.md)
- [Airbox grading](fem/airbox/grading.md)

## References

- C. Geuzaine and J.-F. Remacle, “Gmsh: a three-dimensional finite element mesh generator with built-in pre- and post-processing facilities,” *International Journal for Numerical Methods in Engineering* **79** (2009), 1309–1331, [doi:10.1002/nme.2579](https://doi.org/10.1002/nme.2579).
- C. Abert, “Micromagnetics and spintronics: models and numerical methods,” *European Physical Journal B* **92**, 120 (2019), [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).
- Gmsh reference manual, mesh algorithms, size fields, extrusion and physical groups: [gmsh.info/doc/texinfo](https://gmsh.info/doc/texinfo/).
## Extended source notes

- Python contract source: `packages/fullmag-py/src/fullmag/model/discretization.py` and `packages/fullmag-py/src/fullmag/world.py`, where applicable. Runtime realization is owned by the relevant `backends/fdm` or `backends/fem` implementation; the page must not claim a symbol not named in its implementation mapping.

