---
title: "Airbox mesh grading"
description: "Near-interface refinement, far-field coarsening and growth control in the exterior domain."
summary: "A graded airbox concentrates tetrahedra near magnetic interfaces and lets size grow toward the outer boundary. Grading reduces cost only when it preserves field accuracy and acceptable element quality."
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-24
reviewed_revision: 5db00ccf0113b9756fec2d46feb36ade762b12c2
source_of_truth: "Airbox mesh-size controls, interface/transition fields, Gmsh field plan and scoped airbox quality report"
---

(public-docs-numerical-methods-meshing-fem-airbox-grading)=
# Airbox mesh grading

**Last changes: 12:31 24.08.2026**

A graded airbox concentrates tetrahedra near magnetic interfaces and lets size grow toward the outer boundary. Grading reduces cost only when it preserves field accuracy and acceptable element quality.

::::{admonition} Implementation status
:class: important

Minimum/maximum size, growth, grading, curvature and narrow-region controls are exposed. The effective field plan and realized size distribution are authoritative because object/interface fields can dominate airbox defaults.
::::

## Scope and purpose

Use grading after the airbox geometry is fixed. The key design is a fine magnetic-interface zone,
a controlled transition and a coarser far field. Uniformly refining the entire exterior is usually
expensive; overaggressive coarsening can corrupt the scalar potential and conditioning.

## Scientific and numerical model

For open-boundary magnetostatics, Fullmag's FEM route introduces a scalar potential $u$ on a finite
computational domain $\Omega=\Omega_m\cup\Omega_a$, where $\Omega_m$ is magnetic material and
$\Omega_a$ is the exterior airbox. In current-free regions,

```{math}
:label: eq-airbox-poisson-fem-airbox-grading
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
:label: eq-airbox-geometric-grading-fem-airbox-grading
h_j=\min(h_{far},h_0 r^j).
```

The outer-boundary distance and exterior mesh size require independent convergence studies.
If the target size changes from $h_i$ at an interface to $h_f$ over distance $D$, a geometric
progression with ratio $r$ uses approximately

```{math}
:label: eq-airbox-grading-layer-count-fem-airbox-grading
n\approx\frac{\log(h_f/h_i)}{\log r}
```

growth steps. This is a planning estimate, not a guarantee that Gmsh creates concentric layers.
Size fields constrain local targets; final tetrahedra also depend on geometry, neighboring fields,
smoothing and algorithms. A large ratio can create abrupt transitions and poor conditioning.

## Selection guide

| Use case | Recommended choice | Reason |
| --- | --- | --- |
| Open demag baseline | geometric grading 1.3–1.5 | Typical controlled start, then convergence |
| Narrow gap between magnets | smaller hmin + narrow-region refinement | Resolves strong gap fields |
| Curved particle | curvature refinement near interface | Captures surface geometry/charge |
| Very distant outer boundary | larger hmax only after interface protected | Reduces far-field count |

## Parameters

| Python / IR key | Unit | Default | Validation | Numerical effect |
| --- | --- | --- | --- | --- |
| `airbox_hmax` / `maximum_element_size` | m | unset | positive | far-field maximum tetrahedron size |
| `airbox_hmin` / `minimum_element_size` | m | unset | positive and no greater than hmax | lower clamp for airbox refinement |
| `airbox_growth_rate` / `grading_ratio` | 1 | `1.3` in `AirboxOptions` | positive; typically >1 for geometric grading | rate at which element size grows away from the magnet |
| `airbox_grading` / `grading_mode` | 1 | `geometric` | `auto`, `geometric`, `linear` in the UI contract | controls the transition from interface to far field |
| `curvature_factor` | 1 | unset | positive when set | curvature-based sizing in the exterior geometry |
| `narrow_region_resolution` | 1 | unset | positive when set | resolution request for narrow exterior gaps |
| `interface_maximum_element_size` | m | object-policy dependent | positive | target on magnetic/air interface |
| `interface_thickness` | m | object-policy dependent | positive | fine interface shell width |
| `transition_growth` | 1 | object-policy dependent | positive | requested interface-to-air growth |

## Python API

**Complete Python example**

```python
import fullmag as fm

nm = 1.0e-9
study = fm.study("graded_airbox_mesh")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.universe(
    mode="manual",
    size=(800 * nm, 600 * nm, 300 * nm),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(
    minimum_element_size=8 * nm,
    maximum_element_size=100 * nm,
    maximum_element_growth_rate=1.35,
    grading="geometric",
)

film = study.geometry(
    fm.Box(size=(300 * nm, 120 * nm, 10 * nm), name="film"),
    name="film",
)
film.mesh(
    mesh_strategy="free_tetrahedral",
    minimum_element_size=3 * nm,
    maximum_element_size=7 * nm,
    interface_maximum_element_size=5 * nm,
    interface_thickness=15 * nm,
    transition_distance="airbox_boundary",
    transition_growth=1.35,
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

Configure airbox min/max size and growth in the Universe panel, then protect the magnetic
interface in each object's **Interface and Transition Refinement** group. After build, use scoped
size histograms for **air**, **magnet**, and **interface**. A single global histogram can hide a
coarse interface or an unnecessarily fine far field.

## Grading-convergence checks

Hold outer geometry fixed. Refine the interface target and growth ratio while monitoring field
and energy. Separately refine far-field hmax. Inspect quality/condition proxies and solver
iterations: a mesh that reduces cell count but greatly increases iterations may not be cheaper.

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
:label: eq-meshing-relative-change-fem-airbox-grading
\varepsilon_h=\frac{|Q_h-Q_{h/\rho}|}{\max(|Q_{h/\rho}|,Q_{\mathrm{scale}})},
\qquad \rho>1,
```

with a documented scale for observables that can cross zero. For dynamics, compare resonance
frequency, linewidth and mode profile; for relaxation, compare total energy and texture; for demag,
compare field/energy and verify that moving the outer boundary does not change the result beyond the
chosen tolerance.

## Diagnostics and failure semantics

- `hmin > hmax` is invalid.
- If a semantic interface field matches no surfaces, the airbox can remain coarse at the magnet.
- Multiple fields combine by the normalized field plan; inspect whether minimum/clamp operations
  produced the intended result.
- Excessive growth creates low-quality transition cells and potential error.
- A far-field hmax larger than the outer-domain feature scale can leave the boundary underresolved.

## Where this is implemented

| Responsibility | Repository source | Stable owner / symbol |
| --- | --- | --- |
| Airbox size contract | [`packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py) | `AirboxOptions` |
| Volume clamp fields | [`packages/fullmag-py/src/fullmag/meshing/_gmsh_generators.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/meshing/_gmsh_generators.py) | `_add_airbox_volume_clamp_fields` |
| Size-field plan | [`packages/fullmag-py/src/fullmag/meshing/_size_field_plan.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/meshing/_size_field_plan.py) | `normalized size-field plan` |
| Gmsh fields | [`packages/fullmag-py/src/fullmag/meshing/_gmsh_fields.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/meshing/_gmsh_fields.py) | `_apply_mesh_options` |
| Airbox UI | [`apps/control-room/src/modules/inspector/panels/AirboxMeshParametersPanel.tsx`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/apps/control-room/src/modules/inspector/panels/AirboxMeshParametersPanel.tsx) | `airbox sizing controls` |

Implementation map reviewed against commit `5db00ccf0113b9756fec2d46feb36ade762b12c2` on 2026-08-24.

## Related documentation

- [Airbox geometry](geometry.html)
- [Refinement](../../refinement.html)

## References

- C. Geuzaine and J.-F. Remacle, “Gmsh: a three-dimensional finite element mesh generator with built-in pre- and post-processing facilities,” *International Journal for Numerical Methods in Engineering* **79** (2009), 1309–1331, [doi:10.1002/nme.2579](https://doi.org/10.1002/nme.2579).
- C. Abert, “Micromagnetics and spintronics: models and numerical methods,” *European Physical Journal B* **92**, 120 (2019), [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).
- Gmsh reference manual, mesh algorithms, size fields, extrusion and physical groups: [gmsh.info/doc/texinfo](https://gmsh.info/doc/texinfo/).
