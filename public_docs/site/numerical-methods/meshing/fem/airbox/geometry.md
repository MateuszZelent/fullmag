---
title: "Airbox geometry and enclosure"
description: "Automatic and explicit exterior-domain bounds, shape, center and enclosure checks."
summary: "Airbox geometry determines the finite truncation of open space. It must enclose every required body, remain consistent with periodic/open axes and carry a reproducible outer-boundary identity."
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-24
reviewed_revision: 5db00ccf0113b9756fec2d46feb36ade762b12c2
source_of_truth: "Universe geometry policy, AirboxOptions scaling, OCC airbox construction and enclosure diagnostics"
---

(public-docs-numerical-methods-meshing-fem-airbox-geometry)=
# Airbox geometry and enclosure

**Last changes: 12:31 24.08.2026**

Airbox geometry determines the finite truncation of open space. It must enclose every required body, remain consistent with periodic/open axes and carry a reproducible outer-boundary identity.

::::{admonition} Implementation status
:class: important

Rectangular explicit/automatic airbox construction is implemented; direct `AirboxOptions` also carries a `sphere` vocabulary where supported by the generator path. The realized shape/bounds must be read from the shared-domain report.
::::

## Scope and purpose

Configure outer-domain size before mesh grading. Use explicit bounds for reproducible studies and
automatic padding for exploratory models, but always record the realized SI bounds. The airbox can
be off-center when geometry or expected fields are asymmetric; the choice then becomes part of the
truncation model.

## Scientific and numerical model

For open-boundary magnetostatics, Fullmag's FEM route introduces a scalar potential $u$ on a finite
computational domain $\Omega=\Omega_m\cup\Omega_a$, where $\Omega_m$ is magnetic material and
$\Omega_a$ is the exterior airbox. In current-free regions,

```{math}
:label: eq-airbox-poisson-fem-airbox-geometry
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
:label: eq-airbox-geometric-grading-fem-airbox-geometry
h_j=\min(h_{far},h_0 r^j).
```

The outer-boundary distance and exterior mesh size require independent convergence studies.
For magnetic bounding-box lengths $L_x,L_y,L_z$, a scalar automatic factor $p$ conceptually gives
outer lengths $pL_x,pL_y,pL_z$. Directional padding instead gives

```{math}
:label: eq-airbox-directional-padding-fem-airbox-geometry
L^{out}_a=L^{mag}_a+p^-_a+p^+_a.
```

Current Control Room exposes three padding components; inspect effective configuration to learn
the exact symmetric/directional normalization used by the backend. The enclosure test should use
transformed geometry bounds and a scale-aware tolerance.

Internally, nanoscale OCC geometry can be scaled from metres to micrometres for robustness. The
generator explicitly scales airbox size, center and h-bounds through the same transform before
boolean operations, then returns SI nodes.

## Selection guide

| Use case | Recommended choice | Reason |
| --- | --- | --- |
| Reproducible production run | explicit `size` and `center` | Stable truncation geometry and simple convergence sequence |
| Fast exploratory setup | automatic padding | Convenient, but record resolved bounds |
| Isolated nearly spherical particle | sphere when route advertises support | Can reduce shape anisotropy of the outer truncation |
| Strongly asymmetric layout | off-center explicit box | Allocates exterior resolution where field extends farther |

## Parameters

| Python / IR key | Unit | Default | Validation | Numerical effect |
| --- | --- | --- | --- | --- |
| `mode` | 1 | `auto` / authored universe mode | supported universe mode | chooses automatic bounds, explicit bounds or lane-specific domain handling |
| `padding` | m | unset/zero | three non-negative components | adds directional clearance around the magnetic geometry |
| `size` | m | unset | three positive components | explicit outer-domain dimensions |
| `center` | m | geometry-derived or zero | three finite components | positions the explicit outer domain |
| `padding_factor` | 1 | `3.0` in `AirboxOptions` | positive | scales the magnetic bounding box when automatic scalar padding is used |
| `shape` | 1 | `bbox` | `bbox` or `sphere` where supported | outer-domain geometry |
| `boundary_marker` | 1 | `99` in direct Python options | integer marker not colliding with region semantics | identifies the outer boundary used by the physical closure |

## Python API

**Complete Python example**

```python
import fullmag as fm

nm = 1.0e-9
study = fm.study("explicit_airbox_geometry")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")

# Explicit universe-owned airbox geometry in SI metres.
study.universe(
    mode="manual",
    size=(700 * nm, 500 * nm, 300 * nm),
    center=(20 * nm, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(
    minimum_element_size=12 * nm,
    maximum_element_size=90 * nm,
    maximum_element_growth_rate=1.5,
    grading="geometric",
)

magnet = study.geometry(
    fm.Ellipsoid(100 * nm, 50 * nm, 25 * nm, name="particle"),
    name="particle",
)
magnet.mesh(
    mesh_strategy="free_tetrahedral",
    minimum_element_size=4 * nm,
    maximum_element_size=8 * nm,
    order=1,
    compute_quality=True,
)
magnet.Ms = 800.0e3
magnet.Aex = 13.0e-12
magnet.alpha = 0.05
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

Prefer explicit **Size X/Y/Z** and **Center X/Y/Z** for publication-grade runs. After applying,
compare the backend effective bounds with the transformed magnetic bounding boxes. The build
should display the resulting air volume and outer-surface marker independently from rendering
camera bounds.

## Geometry-convergence checks

Generate at least three outer geometries with increasing clearance while holding all mesh sizes
and boundary closure fixed. Compare demag energy, average field and the target observable. Also
verify that every magnet remains enclosed after transforms and that the outer marker forms one
closed manifold appropriate to the closure.

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

- Nonpositive size, nonfinite center or failed enclosure is blocking.
- An airbox tangent to a magnet creates zero-width exterior regions and should be rejected.
- A geometry edit or transform invalidates the shared-domain mesh even when outer size is unchanged.
- Internal coordinate scaling must apply equally to magnet, airbox and local size controls.
- Automatic padding is not provenance unless the resolved bounds/factor are stored.

## Where this is implemented

| Responsibility | Repository source | Stable owner / symbol |
| --- | --- | --- |
| Airbox options and defaults | [`packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py) | `AirboxOptions` |
| OCC airbox geometry | [`packages/fullmag-py/src/fullmag/meshing/_gmsh_airbox.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/meshing/_gmsh_airbox.py) | `_add_airbox_and_fragment, _add_airbox_geo` |
| Scale normalization | [`packages/fullmag-py/src/fullmag/meshing/_gmsh_generators.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/meshing/_gmsh_generators.py) | `_scale_airbox_options` |
| Universe UI draft | [`apps/control-room/src/modules/inspector/panels/airboxMeshPolicyDraft.ts`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/apps/control-room/src/modules/inspector/panels/airboxMeshPolicyDraft.ts) | `airbox policy fields` |
| Airbox panel | [`apps/control-room/src/modules/inspector/panels/AirboxMeshParametersPanel.tsx`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/apps/control-room/src/modules/inspector/panels/AirboxMeshParametersPanel.tsx) | `AirboxMeshParametersPanel` |

Implementation map reviewed against commit `5db00ccf0113b9756fec2d46feb36ade762b12c2` on 2026-08-24.

## Related documentation

- [Airbox grading](grading.md)
- [Boundary closure](boundary-closure.md)

## References

- C. Geuzaine and J.-F. Remacle, “Gmsh: a three-dimensional finite element mesh generator with built-in pre- and post-processing facilities,” *International Journal for Numerical Methods in Engineering* **79** (2009), 1309–1331, [doi:10.1002/nme.2579](https://doi.org/10.1002/nme.2579).
- C. Abert, “Micromagnetics and spintronics: models and numerical methods,” *European Physical Journal B* **92**, 120 (2019), [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).
- Gmsh reference manual, mesh algorithms, size fields, extrusion and physical groups: [gmsh.info/doc/texinfo](https://gmsh.info/doc/texinfo/).
