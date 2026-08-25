---
title: "Mesh sizing, local refinement and convergence"
description: "Physics-guided mesh-size selection, Gmsh size fields and convergence evidence."
summary: "Refinement should be driven by physical length scales and observable error. Fullmag combines calibrated presets, explicit min/max sizes, interface/edge/corner controls and structured size fields."
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-24
reviewed_revision: 5db00ccf0113b9756fec2d46feb36ade762b12c2
source_of_truth: "Mesh-size resolution pipeline, semantic size fields, Control Room object/airbox policies and quality resources"
---

(public-docs-numerical-methods-meshing-refinement)=
# Mesh sizing, local refinement and convergence

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

### FDM scientific invariants

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

## Parameters

| Python / IR key | Unit | Default | Validation | Numerical effect |
| --- | --- | --- | --- | --- |
| `maximum_element_size` | m | required for direct FEM generation | positive finite | coarse upper target; local size fields may request smaller elements |
| `minimum_element_size` | m | unset | positive and not greater than the maximum | lower size clamp for local refinement and curvature sizing |
| `maximum_element_growth_rate` | 1 | preset/backend dependent | positive | limits requested growth between neighboring size zones |
| `calibrate_for` | 1 | unset | named calibration family | selects physics-aware preset calibration |
| `size_preset` | 1 | unset | extremely fine through extremely coarse | fills common size/growth/curvature controls before explicit overrides |
| `size_factor` | 1 | `1` | positive | multiplies preset-derived target sizes |
| `curvature_factor` | 1 | unset | positive when set | controls curvature-driven refinement; smaller values generally refine more |
| `narrow_region_resolution` | 1 | unset | positive when set | requests additional resolution in narrow geometric gaps/features |
| `order` | 1 | `1` | positive integer; topology/device support may be narrower | finite-element polynomial order |
| `algorithm_2d` | Gmsh ID | `6` | supported Gmsh 2-D algorithm number | surface triangulation before volume meshing |
| `algorithm_3d` | Gmsh ID | `1` | supported Gmsh 3-D algorithm number | volume tetrahedralization algorithm |
| `smoothing_steps` | passes | `1` | non-negative integer | post-generation node smoothing |
| `optimize` | 1 | unset | Gmsh optimizer name | optional quality optimization; does not replace convergence checks |
| `optimize_iterations` | passes | `1` | positive integer | number of optimizer passes |
| `compute_quality` | 1 | `True` in Control Room defaults | Boolean | requests aggregate quality metrics |
| `per_element_quality` | 1 | `True` in Control Room defaults | Boolean | requests per-element quality arrays and scoped distributions |
| `interface_maximum_element_size` | m | unset | positive | near-interface target size |
| `interface_thickness` | m | unset | positive | distance over which interface sizing remains active |
| `transition_distance` | m or symbolic | unset | positive or `airbox_boundary` when supported | ramp length from fine interface to coarse far field |
| `transition_growth` | 1 | unset | positive | requested growth across the transition |
| `edge_maximum_element_size` | m | unset | positive | target along selected/recovered object edges |
| `edge_thickness` | m | unset | positive | width of the finest edge band |
| `edge_transition_distance` | m or symbolic | unset | positive or supported symbolic value | edge-to-far-field ramp |
| `corner_maximum_element_size` | m | unset | positive and no larger than edge target | target at corners |
| `size_fields` | mixed | `[]` | validated field descriptors | composable spatial target fields |

## Python API

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
    calibrate_for="micromagnetics_relaxation",
    size_preset="fine",
    size_factor=1.0,
    minimum_element_size=3 * nm,
    maximum_element_size=10 * nm,
    maximum_element_growth_rate=1.35,
    size_fields=[
        fm.mesh.object_core_relaxation(
            "film",
            maximum_element_size=10 * nm,
            surface_maximum_element_size=6 * nm,
            surface_distance=15 * nm,
            edge_maximum_element_size=3 * nm,
            edge_distance=20 * nm,
        ),
        fm.mesh.edge_distance_threshold(
            "film",
            maximum_element_size=3 * nm,
            far_maximum_element_size=10 * nm,
            distance=30 * nm,
        ),
    ],
    order=1,
    compute_quality=True,
    per_element_quality=True,
)
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

- [FDM grids](fdm-grids.html)
- [FEM ferromagnet meshes](fem/ferromagnet/index.html)
- [Airbox grading](fem/airbox/grading.html)

## References

- C. Geuzaine and J.-F. Remacle, “Gmsh: a three-dimensional finite element mesh generator with built-in pre- and post-processing facilities,” *International Journal for Numerical Methods in Engineering* **79** (2009), 1309–1331, [doi:10.1002/nme.2579](https://doi.org/10.1002/nme.2579).
- C. Abert, “Micromagnetics and spintronics: models and numerical methods,” *European Physical Journal B* **92**, 120 (2019), [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).
- Gmsh reference manual, mesh algorithms, size fields, extrusion and physical groups: [gmsh.info/doc/texinfo](https://gmsh.info/doc/texinfo/).
