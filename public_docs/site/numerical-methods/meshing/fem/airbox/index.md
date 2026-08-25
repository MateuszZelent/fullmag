---
title: "FEM airbox mesh"
description: "Entry point for exterior-domain geometry, grading, closure and periodicity."
summary: "The airbox branch documents the universe-owned exterior FEM domain from geometric enclosure through graded tetrahedralization, semantic outer markers and capability-gated periodic pairing."
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-24
reviewed_revision: 5db00ccf0113b9756fec2d46feb36ade762b12c2
source_of_truth: "Universe airbox policy, AirboxOptions, shared-domain manifest and FEM demag boundary policy"
---

(public-docs-numerical-methods-meshing-fem-airbox-index)=
# FEM airbox mesh

**Last changes: 12:31 24.08.2026**

The airbox branch documents the universe-owned exterior FEM domain from geometric enclosure through graded tetrahedralization, semantic outer markers and capability-gated periodic pairing.

::::{admonition} Implementation status
:class: important

Ordinary open-airbox geometry, grading and shared-domain assembly are implemented. Periodic airbox behavior remains a separate partial/capability-gated path.
::::

## Scope and purpose

The airbox is a physical/numerical domain, not background decoration. Use the child pages in
order: define geometry, define grading, verify the outer-boundary marker and closure, then consider
periodic pairing only when the solver lane explicitly advertises it.

## Scientific and numerical model

For open-boundary magnetostatics, Fullmag's FEM route introduces a scalar potential $u$ on a finite
computational domain $\Omega=\Omega_m\cup\Omega_a$, where $\Omega_m$ is magnetic material and
$\Omega_a$ is the exterior airbox. In current-free regions,

```{math}
:label: eq-airbox-poisson-fem-airbox-index
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
:label: eq-airbox-geometric-grading-fem-airbox-index
h_j=\min(h_{far},h_0 r^j).
```

The outer-boundary distance and exterior mesh size require independent convergence studies.

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
:label: eq-meshing-exchange-length-fem-airbox-index
\ell_{\mathrm{ex}}=\sqrt{\frac{2A}{\mu_0M_s^2}}.
```

Using an element size below roughly one half of the smallest relevant magnetic length scale is a
common initial choice, not a proof of convergence. Curved boundaries, surface charges, DMI, defects,
interfaces and through-thickness modes can demand a smaller local size.

## Selection guide

| Use case | Recommended choice | Reason |
| --- | --- | --- |
| Choose exterior bounds | Geometry | Controls truncation distance and enclosure |
| Control exterior cost/error | Grading | Fine interface, coarser far field |
| Apply open boundary model | Boundary closure | Maps outer marker to the physics operator |
| Periodic representative cell | Periodic airbox | Requires paired mesh certificate and null-mode policy |

## Parameters

| Python / IR key | Unit | Default | Validation | Numerical effect |
| --- | --- | --- | --- | --- |
| `mode` | 1 | `auto` / authored universe mode | supported universe mode | chooses automatic bounds, explicit bounds or lane-specific domain handling |
| `padding` | m | unset/zero | three non-negative components | adds directional clearance around the magnetic geometry |
| `size` | m | unset | three positive components | explicit outer-domain dimensions |
| `center` | m | geometry-derived or zero | three finite components | positions the explicit outer domain |
| `padding_factor` | 1 | `3.0` in `AirboxOptions` | positive | scales the magnetic bounding box when automatic scalar padding is used |
| `shape` | 1 | `bbox` | `bbox` or `sphere` where supported | outer-domain geometry |
| `airbox_hmax` / `maximum_element_size` | m | unset | positive | far-field maximum tetrahedron size |
| `airbox_hmin` / `minimum_element_size` | m | unset | positive and no greater than hmax | lower clamp for airbox refinement |
| `airbox_growth_rate` / `grading_ratio` | 1 | `1.3` in `AirboxOptions` | positive; typically >1 for geometric grading | rate at which element size grows away from the magnet |
| `airbox_grading` / `grading_mode` | 1 | `geometric` | `auto`, `geometric`, `linear` in the UI contract | controls the transition from interface to far field |
| `boundary_marker` | 1 | `99` in direct Python options | integer marker not colliding with region semantics | identifies the outer boundary used by the physical closure |
| `curvature_factor` | 1 | unset | positive when set | curvature-based sizing in the exterior geometry |
| `narrow_region_resolution` | 1 | unset | positive when set | resolution request for narrow exterior gaps |

## Python API

**Complete Python example**

```python
import fullmag as fm

nm = 1.0e-9
study = fm.study("fem_airbox_reference")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.universe(
    mode="manual",
    size=(600 * nm, 400 * nm, 240 * nm),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(
    minimum_element_size=12 * nm,
    maximum_element_size=80 * nm,
    maximum_element_growth_rate=1.5,
    grading="geometric",
)

magnet = study.geometry(
    fm.Box(size=(200 * nm, 100 * nm, 10 * nm), name="film"),
    name="film",
)
magnet.mesh(
    mesh_strategy="free_tetrahedral",
    minimum_element_size=3 * nm,
    maximum_element_size=7 * nm,
    interface_maximum_element_size=5 * nm,
    interface_thickness=12 * nm,
    transition_distance="airbox_boundary",
    transition_growth=1.4,
    order=1,
    compute_quality=True,
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
:label: eq-meshing-relative-change-fem-airbox-index
\varepsilon_h=\frac{|Q_h-Q_{h/\rho}|}{\max(|Q_{h/\rho}|,Q_{\mathrm{scale}})},
\qquad \rho>1,
```

with a documented scale for observables that can cross zero. For dynamics, compare resonance
frequency, linewidth and mode profile; for relaxation, compare total energy and texture; for demag,
compare field/energy and verify that moving the outer boundary does not change the result beyond the
chosen tolerance.

## Diagnostics and failure semantics

The shared-domain manifest must identify air volume, magnetic/air interfaces and exactly the intended outer boundary. Missing semantic roles are blocking even when the tetrahedralization succeeds.

## Where this is implemented

| Responsibility | Repository source | Stable owner / symbol |
| --- | --- | --- |
| Airbox options | [`packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py) | `AirboxOptions` |
| Airbox OCC construction | [`packages/fullmag-py/src/fullmag/meshing/_gmsh_airbox.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/meshing/_gmsh_airbox.py) | `airbox geometry/fragmentation` |
| Control Room airbox panel | [`apps/control-room/src/modules/inspector/panels/AirboxMeshParametersPanel.tsx`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/apps/control-room/src/modules/inspector/panels/AirboxMeshParametersPanel.tsx) | `AirboxMeshParametersPanel` |
| Shared-domain manifest | [`apps/control-room/src/kernel/resources/geometryLifecycleResources.ts`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/apps/control-room/src/kernel/resources/geometryLifecycleResources.ts) | `useMeshSharedDomainManifestResource` |

Implementation map reviewed against commit `5db00ccf0113b9756fec2d46feb36ade762b12c2` on 2026-08-24.

## References

- C. Geuzaine and J.-F. Remacle, “Gmsh: a three-dimensional finite element mesh generator with built-in pre- and post-processing facilities,” *International Journal for Numerical Methods in Engineering* **79** (2009), 1309–1331, [doi:10.1002/nme.2579](https://doi.org/10.1002/nme.2579).
- C. Abert, “Micromagnetics and spintronics: models and numerical methods,” *European Physical Journal B* **92**, 120 (2019), [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).
- Gmsh reference manual, mesh algorithms, size fields, extrusion and physical groups: [gmsh.info/doc/texinfo](https://gmsh.info/doc/texinfo/).## Documentation tree

    ```{toctree}
    :maxdepth: 2

    geometry
grading
boundary-closure
periodic-airbox
    ```
