---
title: "Airbox outer-boundary closure"
description: "Outer-boundary markers and the separation between mesh closure and physical boundary conditions."
summary: "Meshing creates and marks the finite outer surface; the selected FEM interaction applies the physical Dirichlet, Robin or periodic/null-mode closure. These responsibilities must remain separate in configuration and provenance."
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-24
reviewed_revision: 5db00ccf0113b9756fec2d46feb36ade762b12c2
source_of_truth: "Airbox boundary marker, shared-domain facet roles, FEM demag solver policy and boundary-condition assembly"
---

(public-docs-numerical-methods-meshing-fem-airbox-boundary-closure)=
# Airbox outer-boundary closure

**Last changes: 12:31 24.08.2026**

Meshing creates and marks the finite outer surface; the selected FEM interaction applies the physical Dirichlet, Robin or periodic/null-mode closure. These responsibilities must remain separate in configuration and provenance.

::::{admonition} Implementation status
:class: important

Ordinary outer-boundary marking and Poisson/Robin demag authoring are source-backed. The mesher does not decide the physical boundary equation; changing the demag policy can reuse geometry only when all solver-facing boundary semantics remain compatible.
::::

## Scope and purpose

Use this page to verify that the finite airbox surface is correctly identified and that the
intended physical closure is applied to exactly that surface. Do not conflate a closed geometric
surface with an open-space magnetostatic boundary condition.

## Scientific and numerical model

For open-boundary magnetostatics, Fullmag's FEM route introduces a scalar potential $u$ on a finite
computational domain $\Omega=\Omega_m\cup\Omega_a$, where $\Omega_m$ is magnetic material and
$\Omega_a$ is the exterior airbox. In current-free regions,

```{math}
:label: eq-airbox-poisson-fem-airbox-boundary-closure
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
:label: eq-airbox-geometric-grading-fem-airbox-boundary-closure
h_j=\min(h_{far},h_0 r^j).
```

The outer-boundary distance and exterior mesh size require independent convergence studies.
A simple truncation can impose $u=0$ on $\Gamma_{out}$, while an approximate open condition can
use a Robin form

```{math}
:label: eq-airbox-robin-fem-airbox-boundary-closure
\partial_nu+\beta u=0\quad\text{on }\Gamma_{out},
```

with coefficient $\beta$ defined by the selected demag realization/policy. The exact coefficient
and gauge treatment belong to the physics solver. The mesh contributes the oriented outer facets,
normals, quadrature and semantic marker.

Moving $\Gamma_{out}$ changes the truncated problem even with the same closure. Boundary-distance
convergence is therefore mandatory.

## Selection guide

| Use case | Recommended choice | Reason |
| --- | --- | --- |
| Routine finite open-domain approximation | `poisson_robin` when qualified | Approximate open decay on finite boundary |
| Manufactured/benchmark condition | explicit Dirichlet/known closure | Supports controlled verification |
| Periodic unit cell | periodic reduced system | Different operator, pairing and null-mode contract |

## Parameters

| Python / IR key | Unit | Default | Validation | Numerical effect |
| --- | --- | --- | --- | --- |
| `boundary_marker` | 1 | `99` in direct options | unique integer/semantic role | identifies `Gamma_out` in mesh data |
| demag realization | 1 | `auto` | supported policy such as `poisson_robin` | selects physical scalar-potential closure |
| Robin/gauge solver policy | mixed | backend defaults | valid FEM demag policy JSON/typed contract | controls boundary coefficient, gauge and linear solve |
| outer-boundary distance | m | airbox geometry | positive enclosure | dominant truncation-error control |
| outer-facet order/type | 1 | realized | supported `tri3`/`quad4` and FE order | boundary quadrature and normal recovery |

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

In the Universe panel, build the airbox and inspect the outer marker. In the Study Inspector,
enable FEM demag and select/configure the FEM demag solver policy. Keep these two edits separate:
**Apply Airbox Policy** changes mesh intent; Study authoring changes the physical operator. The
current run must reference both revisions.

## Closure verification

Confirm that the outer marker covers one closed external surface and excludes internal magnetic
interfaces. Verify outward normal orientation, boundary-facet count and boundary-condition
assembly. Move the boundary outward and compare energy/field. For manufactured potential tests,
report the boundary residual and bulk error separately.

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
:label: eq-meshing-relative-change-fem-airbox-boundary-closure
\varepsilon_h=\frac{|Q_h-Q_{h/\rho}|}{\max(|Q_{h/\rho}|,Q_{\mathrm{scale}})},
\qquad \rho>1,
```

with a documented scale for observables that can cross zero. For dynamics, compare resonance
frequency, linewidth and mode profile; for relaxation, compare total energy and texture; for demag,
compare field/energy and verify that moving the outer boundary does not change the result beyond the
chosen tolerance.

## Diagnostics and failure semantics

- Missing, duplicate or misassigned outer marker is blocking.
- Applying a closure to magnetic interfaces instead of `Gamma_out` is a severe physics error.
- An open-airbox mesh must not be reused as a periodic mesh without a new periodic certificate.
- A Robin solve that converges algebraically can still have large truncation error.
- A gauge/null-space problem must be reported by the FEM solver; the mesher cannot fix it.

## Where this is implemented

| Responsibility | Repository source | Stable owner / symbol |
| --- | --- | --- |
| Outer marker contract | [`packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py) | `AirboxOptions.boundary_marker` |
| Airbox physical groups | [`packages/fullmag-py/src/fullmag/meshing/_gmsh_airbox.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/meshing/_gmsh_airbox.py) | `outer boundary group construction` |
| Facet roles | [`packages/fullmag-py/src/fullmag/meshing/_gmsh_extraction.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/meshing/_gmsh_extraction.py) | `_derive_facet_roles` |
| FEM demag interaction | [`backends/fem/cpu/mfem/interactions/demag_poisson.cpp`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/backends/fem/cpu/mfem/interactions/demag_poisson.cpp) | `open/Robin Poisson assembly` |
| Study demag policy UI | [`apps/control-room/src/modules/inspector/panels/StudyInspectorPanel.tsx`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/apps/control-room/src/modules/inspector/panels/StudyInspectorPanel.tsx) | `FEM demag policy` |

Implementation map reviewed against commit `5db00ccf0113b9756fec2d46feb36ade762b12c2` on 2026-08-24.

## Related documentation

- [Airbox geometry](geometry.md)
- [Periodic airbox](periodic-airbox.md)
- [Demag solvers](../../../demag-solvers/index.md)

## References

- C. Geuzaine and J.-F. Remacle, “Gmsh: a three-dimensional finite element mesh generator with built-in pre- and post-processing facilities,” *International Journal for Numerical Methods in Engineering* **79** (2009), 1309–1331, [doi:10.1002/nme.2579](https://doi.org/10.1002/nme.2579).
- C. Abert, “Micromagnetics and spintronics: models and numerical methods,” *European Physical Journal B* **92**, 120 (2019), [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).
- Gmsh reference manual, mesh algorithms, size fields, extrusion and physical groups: [gmsh.info/doc/texinfo](https://gmsh.info/doc/texinfo/).
## Source-code index

- Python contract source: `packages/fullmag-py/src/fullmag/model/discretization.py` and `packages/fullmag-py/src/fullmag/world.py`, where applicable. Runtime realization is owned by the relevant `backends/fdm` or `backends/fem` implementation; the page must not claim a symbol not named in its implementation mapping.

