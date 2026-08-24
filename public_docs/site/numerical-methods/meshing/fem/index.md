---
title: "Finite-element meshing"
description: "Entry point for magnetic-object, airbox and shared-domain FEM meshing in Fullmag."
summary: "Fullmag FEM meshing combines object-owned policies, a universe-owned airbox policy and a shared-domain build that produces typed cells, facets, markers, quality and provenance."
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-24
reviewed_revision: 5db00ccf0113b9756fec2d46feb36ade762b12c2
source_of_truth: "FEM/mesh policy schemas, Gmsh generation, shared-domain resources and active-lane capability matrix"
---

(public-docs-numerical-methods-meshing-fem-index)=
# Finite-element meshing

**Last changes: 12:31 24.08.2026**

Fullmag FEM meshing combines object-owned policies, a universe-owned airbox policy and a shared-domain build that produces typed cells, facets, markers, quality and provenance.

::::{admonition} Implementation status
:class: important

Free tetrahedral and ordinary shared-domain FEM are implemented. Thin-film, swept and mixed-element paths have explicit support boundaries. Every solver/device must advertise support for the realized cell families.
::::

## Scope and purpose

The FEM tree is organized by ownership rather than by a single generic “mesh” dialog:

- **Ferromagnet** pages describe object-local magnetic topology and sizing.
- **Airbox** pages describe the universe-owned exterior geometry and mesh.
- **Shared domain** pages describe conforming assembly and the final immutable solver mesh.

This separation is essential because local previews, exterior sizing and final boolean assembly can
have different revisions and topology.

## Scientific and numerical model

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
:label: eq-meshing-exchange-length-fem-index
\ell_{\mathrm{ex}}=\sqrt{\frac{2A}{\mu_0M_s^2}}.
```

Using an element size below roughly one half of the smallest relevant magnetic length scale is a
common initial choice, not a proof of convergence. Curved boundaries, surface charges, DMI, defects,
interfaces and through-thickness modes can demand a smaller local size.

For open-boundary magnetostatics, Fullmag's FEM route introduces a scalar potential $u$ on a finite
computational domain $\Omega=\Omega_m\cup\Omega_a$, where $\Omega_m$ is magnetic material and
$\Omega_a$ is the exterior airbox. In current-free regions,

```{math}
:label: eq-airbox-poisson-fem-index
\nabla\cdot\left(-\nabla u+\mathbf M\right)=0,
\qquad \mathbf H_d=-\nabla u.
```

The infinite exterior is replaced by a finite outer boundary $\Gamma_{out}$ plus a separately
selected boundary closure. The mesh and boundary condition are distinct: making the airbox larger
does not itself impose an open boundary, and a Robin condition does not eliminate discretization
error near the magnet.

The exterior mesh should be fine enough at magnetic interfaces to represent surface-charge-driven
field variation and may grow toward $\Gamma_{out}$. If $h_0$ is the near-interface size and $r>1$ a
geometric grading ratio, a conceptual layer sequence is

```{math}
:label: eq-airbox-geometric-grading-fem-index
h_j=\min(h_{far},h_0 r^j).
```

The outer-boundary distance and exterior mesh size require independent convergence studies.

## Selection guide

| Use case | Recommended choice | Reason |
| --- | --- | --- |
| Magnetic body only | Ferromagnet mesh | Object-local topology and physical resolution |
| Exterior field domain | Airbox mesh | Nonmagnetic domain and outer marker |
| Coupled solve | Shared-domain mesh | One conforming topology with all regions/interfaces |
| Imported external asset | Imported mesh/geometry route | Explicit units, scaling, supported linear families and markers |

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

## Python API

**Complete Python example**

```python
import fullmag as fm

nm = 1.0e-9
study = fm.study("free_tetrahedral_reference")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.universe(
    mode="manual",
    size=(500 * nm, 300 * nm, 160 * nm),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(
    minimum_element_size=20 * nm,
    maximum_element_size=80 * nm,
    maximum_element_growth_rate=1.5,
    grading="geometric",
)

magnet = study.geometry(
    fm.Ellipsoid(110 * nm, 50 * nm, 20 * nm, name="ellipsoid"),
    name="ellipsoid",
)
magnet.mesh(
    mesh_strategy="free_tetrahedral",
    minimum_element_size=4 * nm,
    maximum_element_size=8 * nm,
    maximum_element_growth_rate=1.35,
    algorithm_2d=6,
    algorithm_3d=1,
    order=1,
    smoothing_steps=3,
    optimize="Netgen",
    optimize_iterations=3,
    compute_quality=True,
    per_element_quality=True,
)
magnet.Ms = 800.0e3
magnet.Aex = 13.0e-12
magnet.alpha = 0.02
magnet.m = fm.texture.uniform(1.0, 0.0, 0.0)

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

### Magnetic-object workflow

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


### Universe / airbox workflow

1. In **Explorer**, select **Universe / Airbox Mesh**.
2. Choose **Domain mode** and enter either explicit **Size X/Y/Z** and **Center X/Y/Z**, or automatic
   **Padding X/Y/Z**.
3. For FEM, set **Maximum element size**, **Minimum element size**, **Maximum element growth rate**,
   **Element grading**, **Curvature factor** and **Narrow-region resolution** as needed.
4. Select **Apply Airbox Policy** to store the universe-owned exterior-domain intent. This makes any
   older shared-domain realization stale.
5. Select **Apply & Build Shared-Domain Mesh** to dispatch `mesh.build-shared-domain`.
6. Inspect the effective configuration, shared-domain manifest, outer-boundary marker, interface
   conformity and mesh-quality scopes. The effective configuration returned by the backend is the
   source of truth.

For FDM, the panel filters FEM-only air-mesh controls and exposes structured-domain geometry only.

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
:label: eq-meshing-relative-change-fem-index
\varepsilon_h=\frac{|Q_h-Q_{h/\rho}|}{\max(|Q_{h/\rho}|,Q_{\mathrm{scale}})},
\qquad \rho>1,
```

with a documented scale for observables that can cross zero. For dynamics, compare resonance
frequency, linewidth and mode profile; for relaxation, compare total energy and texture; for demag,
compare field/energy and verify that moving the outer boundary does not change the result beyond the
chosen tolerance.

## Diagnostics and failure semantics

Do not run FEM from an object preview when the selected interaction requires the shared air domain. The solver-facing mesh revision, region map and capability certificate must be current and internally consistent.

## Where this is implemented

| Responsibility | Repository source | Stable owner / symbol |
| --- | --- | --- |
| FEM Python contract | [`packages/fullmag-py/src/fullmag/model/discretization.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/model/discretization.py) | `FEM, PerObjectMeshRecipe` |
| Gmsh bridge | [`packages/fullmag-py/src/fullmag/meshing/gmsh_bridge.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/meshing/gmsh_bridge.py) | `public meshing bridge` |
| FEM asset pipeline | [`packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py) | `mesh asset materialization` |
| Control Room object policy | [`apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanel.tsx`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanel.tsx) | `ObjectMeshPolicyPanel` |
| Control Room mesh details | [`apps/control-room/src/modules/inspector/panels/MeshDetailsPanel.tsx`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/apps/control-room/src/modules/inspector/panels/MeshDetailsPanel.tsx) | `MeshDetailsPanel` |
| API mesh handlers | [`crates/fullmag-api/src/router_v2/handlers/meshing/mesh.rs`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/crates/fullmag-api/src/router_v2/handlers/meshing/mesh.rs) | `mesh lifecycle endpoints` |

Implementation map reviewed against commit `5db00ccf0113b9756fec2d46feb36ade762b12c2` on 2026-08-24.

## References

- C. Geuzaine and J.-F. Remacle, “Gmsh: a three-dimensional finite element mesh generator with built-in pre- and post-processing facilities,” *International Journal for Numerical Methods in Engineering* **79** (2009), 1309–1331, [doi:10.1002/nme.2579](https://doi.org/10.1002/nme.2579).
- C. Abert, “Micromagnetics and spintronics: models and numerical methods,” *European Physical Journal B* **92**, 120 (2019), [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).
- Gmsh reference manual, mesh algorithms, size fields, extrusion and physical groups: [gmsh.info/doc/texinfo](https://gmsh.info/doc/texinfo/).

## Documentation tree

```{toctree}
:maxdepth: 2

shared-domain/index
ferromagnet/index
airbox/index
```
